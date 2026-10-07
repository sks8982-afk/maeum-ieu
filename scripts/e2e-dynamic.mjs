/**
 * 유동형(LLM-in-the-loop) 자동 대화 검증 — Playwright headed.
 *
 * 고정 시나리오가 아니라, AI 동반자의 직전 응답을 별도 LLM(Gemini)에 넘겨
 * "어르신의 다음 발화"를 즉석 생성 → 전송 → 다시 AI 응답을 받아 되먹이는 진짜 동적 대화.
 *   = 시스템(앱: gemini-3.5-flash)  vs  페르소나 생성기(gemini-2.5-flash, 독립 모델)
 *
 * 매 AI 응답마다 누출 자동 감지: 영어추론/도구코드 누출(핵심)·빈응답·이름누출·JSON·호칭오류.
 *
 * 사용: node scripts/e2e-dynamic.mjs [turns] [headless]
 *   turns:    어르신 발화 턴 수 (기본 16)
 *   headless: "headless"면 브라우저 숨김. 기본 headed(브라우저 표시 — 직접 관찰용).
 *
 * 사전: dev 서버(:3100) 실행 중, GEMINI_API_KEY, DATABASE_URL.
 */
import { chromium } from "playwright";
import pg from "pg";
import { pgTlsOptions } from "./db-tls.mjs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";

const BASE = process.env.E2E_BASE || "http://localhost:3100";
const PW = "test1234!";
const TURNS = parseInt(process.argv[2] || "16", 10);
const HEADED = process.argv[3] !== "headless";
const PERSONA_MODEL = process.env.PERSONA_MODEL || "gemini-2.5-flash";
const STAMP = Date.now();

// ─── 어르신 페르소나 (페르소나 생성기 LLM이 일관되게 연기) ───────────────────
const PERSONA = {
  name: "김순자", age: 78, honorific: "할머니", gender: "여성",
  companion: "지윤", relation: "손녀",
  bio: "경북 안동에서 태어나 자랐고, 남편과 사별한 뒤 경기도 동탄 아파트에서 혼자 산다. " +
       "아들이 둘(큰아들 김민호, 작은아들 김성호) 있고 손주들이 가끔 찾아온다. " +
       "텃밭에 상추·고추 키우는 재미와 저녁마다 트로트 프로 보는 낙으로 지낸다. 무릎이 좀 안 좋다.",
};

const PERSONA_SYS = `당신은 ${PERSONA.age}세 ${PERSONA.honorific} '${PERSONA.name}'입니다.
[배경] ${PERSONA.bio}
당신은 AI 동반자(${PERSONA.relation} '${PERSONA.companion}')와 매일 일상 대화를 나눕니다.

[연기 규칙 — 반드시 지킬 것]
- 당신은 '어르신' 본인입니다. 동반자의 직전 말에 자연스럽게 반응하는 "다음 한 마디"만 생성하세요.
- 1~2문장, 정겹고 편한 구어체(반말~해요체 섞임). 노인 특유의 화법: 가족·텃밭·날씨·건강·옛날 얘기 등 일상.
- 따옴표·지문·설명·괄호 없이 **발화 내용만** 출력. "어르신:" 같은 라벨 금지.
- 직전 발화를 똑같이 반복하지 말고 대화를 이어가거나 가끔 새 화제를 꺼내세요.
- 동반자가 물으면 위 배경에 맞게 진솔하게 답하세요(배경에 없으면 자연스럽게 지어내되 일관되게).`;

const personaLLM = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({
  model: PERSONA_MODEL,
  systemInstruction: PERSONA_SYS,
  // 256은 thinking 토큰이 잠식해 발화가 중간에 잘림("우리 어렸을 적엔 말이지, 밤에") → 1024
  generationConfig: { temperature: 1.0, maxOutputTokens: 1024 },
});

const FALLBACK_UTTER = [
  "그나저나 오늘 날씨가 참 좋네, 텃밭에 물 줘야겠어.",
  "요새 무릎이 좀 시큰거리는데 그러려니 하고 지내.",
  "저녁에 트로트 프로 하는 날인데 벌써 기다려지네.",
  "아들 녀석들 바빠서 통 못 보는데 보고 싶구먼.",
];

/** AI 직전 응답까지의 대화를 주고 어르신의 다음 발화를 생성. 실패 시 폴백. */
async function genElderUtterance(history, idx) {
  const convo = history.slice(-12).map((h) => `${h.who === "ai" ? "동반자" : "어르신"}: ${h.text}`).join("\n");
  const prompt = `${convo}\n\n동반자의 마지막 말에 이어 어르신이 할 다음 한 마디만 출력:`;
  try {
    const res = await personaLLM.generateContent(prompt);
    const parts = res?.response?.candidates?.[0]?.content?.parts;
    let t = Array.isArray(parts)
      ? parts.filter((p) => !p?.thought && typeof p?.text === "string").map((p) => p.text).join("")
      : "";
    t = (t || "").trim().replace(/^["'「『\s]+|["'」』\s]+$/g, "").split("\n")[0].trim();
    t = t.replace(/^어르신\s*[:：]\s*/, "").trim();
    // 직전 발화와 동일하면(잘림→재질문→동일 재생성 루프) 폴백으로 끊음
    const prevUser = [...history].reverse().find((h) => h.who === "user")?.text?.trim();
    if (t.length >= 2 && t !== prevUser) return t;
  } catch (e) {
    console.warn(`  [persona-llm] gen 실패: ${e.message.split("\n")[0]}`);
  }
  return FALLBACK_UTTER[idx % FALLBACK_UTTER.length];
}

// ─── 누출 감지 ──────────────────────────────────────────────────────────────
const ENGLISH_LEAK_RE = /print\(|google_search|tool_code|tool_outputs|final polish|let.?s check|no time labels|no hallucination|formatting\s*:|thought\s*:|\b(user|ai|assistant)\s*:\s|the user (is|wants|said|asked|means|needs)|i should|i need to/i;

function detect(ai, persona) {
  const flags = [];
  if (!ai || !ai.trim()) { flags.push("EMPTY(빈 응답)"); return flags; }
  if (ENGLISH_LEAK_RE.test(ai)) flags.push("ENGLISH_LEAK(영어누출)");
  if (ai.includes("****") || /\*\*\s*이에요|\*\*\s*예요/.test(ai)) flags.push("BLANK(**** 블랭킹)");
  if (/\{[^}]*"(text|isAnomaly|score|response|analysisNote)"/.test(ai) || /"isAnomaly"\s*:/.test(ai)) flags.push("JSON_LEAK");
  if (persona.companion !== "민지" && /민지(?:이?(?:가|는|도|예요|에요|이에요|랑|와)|이|아|야)/.test(ai)) flags.push("NAME_LEAK(민지)");
  const opp = persona.honorific === "할머니" ? "할아버지" : "할머니";
  if (new RegExp(`${opp}[,!\\s]`).test(ai) && !new RegExp(persona.honorific).test(ai)) flags.push(`HONORIFIC(${opp})`);
  if (/방금 말씀하신 내용을 좀 더 자세히|다시 한 번 여쭤볼게요/.test(ai)) flags.push("FALLBACK(회피)");
  return flags;
}

// ─── Playwright 셋업 헬퍼 (e2e-adaptive와 동일 패턴) ─────────────────────────
async function signupUI(page, email) {
  await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]', { timeout: 12000 });
  await page.locator('input[type="email"]').fill(email);
  const pws = page.locator('input[type="password"]');
  await pws.nth(0).fill(PW);
  await pws.nth(1).fill(PW);
  await page.locator('input[type="number"]').first().fill(String(PERSONA.age)).catch(() => {});
  await page.locator("select").first().selectOption({ label: PERSONA.gender }).catch(() => {});
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "회원가입" }).click();
  await page.waitForURL(/\/login/, { timeout: 20000 }).catch(() => {});
}

async function login(page, email) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.context().clearCookies();
      await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('input[type="password"]', { timeout: 10000 });
      await page.waitForTimeout(600);
      await page.locator('input[type="email"]').first().fill(email);
      await page.locator('input[type="password"]').first().fill(PW);
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: "로그인" }).click();
      await page.waitForURL(/\/chat/, { timeout: 25000 });
      return;
    } catch (e) { if (attempt === 2) throw e; await page.waitForTimeout(1500); }
  }
}

const INPUT_SEL = 'input[placeholder="메시지를 입력하세요."]';
async function enterTextChat(page) {
  await page.waitForSelector('button:has-text("글씨로 대화하기")', { timeout: 12000 }).catch(() => {});
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("글씨로 대화하기"));
    if (btn) btn.click();
  });
  await page.waitForSelector(INPUT_SEL, { timeout: 12000 });
  await page.waitForFunction(() => [...document.querySelectorAll("p")].filter((p) => p.textContent.trim()).length >= 1, { timeout: 15000 }).catch(() => {});
}

async function sendAndRead(page, text) {
  await page.waitForSelector(INPUT_SEL, { timeout: 8000 });
  const before = await page.evaluate(() => document.querySelectorAll("p").length);
  await page.locator(INPUT_SEL).fill(text);
  const sendBtn = page.getByRole("button", { name: "전송" });
  if (await sendBtn.count()) await sendBtn.first().click().catch(() => page.locator(INPUT_SEL).press("Enter"));
  else await page.locator(INPUT_SEL).press("Enter");
  for (let i = 0; i < 28; i++) {
    await page.waitForTimeout(900);
    const now = await page.evaluate(() => document.querySelectorAll("p").length);
    if (now >= before + 2) break;
  }
  await page.waitForTimeout(700);
  return await page.evaluate((sent) => {
    const ps = [...document.querySelectorAll("p")].map((p) => p.textContent);
    let idx = -1;
    for (let i = ps.length - 1; i >= 0; i--) { if (ps[i].trim() === sent.trim()) { idx = i; break; } }
    const after = idx >= 0 ? ps.slice(idx + 1) : [];
    return after.map((s) => s.trim()).filter(Boolean).join(" ").trim();
  }, text);
}

// ─── 메인 ───────────────────────────────────────────────────────────────────
(async () => {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY 미설정");
  const email = `dyn_${STAMP}@example.com`;
  console.log(`\n🎭 유동형 LLM-in-the-loop 검증 (headed=${HEADED})`);
  console.log(`   앱 모델: gemini-3.5-flash  ·  페르소나 생성기: ${PERSONA_MODEL}`);
  console.log(`   어르신: ${PERSONA.name}(${PERSONA.age}, ${PERSONA.honorific}) · 동반자: ${PERSONA.companion}(${PERSONA.relation}) · ${TURNS}턴\n`);

  // TLS는 앱과 같은 정책(scripts/db-tls.mjs → lib/db-tls, 2026-10-07 8차) — 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL);
  const pool = new pg.Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 60 : 0 });
  const ctx = await browser.newContext({ viewport: { width: 480, height: 860 } });
  const page = await ctx.newPage();

  const history = []; // {who:'elder'|'ai', text}
  const anomalies = [];
  let empties = 0, leaks = 0;

  try {
    await signupUI(page, email);
    const c0 = await pool.connect();
    try {
      const r = await c0.query(`SELECT id FROM "User" WHERE email=$1`, [email]);
      const uid = r.rows[0]?.id;
      if (!uid) throw new Error("signup 실패");
      await c0.query(`UPDATE "User" SET "companionName"=$1, "companionRelation"=$2 WHERE id=$3`, [PERSONA.companion, PERSONA.relation, uid]);
    } finally { c0.release(); }
    await login(page, email);
    await enterTextChat(page);

    const greeting = await page.evaluate(() => [...document.querySelectorAll("p")].map((p) => p.textContent.trim()).filter(Boolean).slice(-1)[0] || "");
    if (greeting) { history.push({ who: "ai", text: greeting }); console.log(`🤖 ${PERSONA.companion}: ${greeting}\n`); }

    for (let t = 0; t < TURNS; t++) {
      const utter = await genElderUtterance(history, t);
      history.push({ who: "elder", text: utter });
      console.log(`👵 ${PERSONA.name}: ${utter}`);

      const ai = await sendAndRead(page, utter);
      history.push({ who: "ai", text: ai });
      const flags = detect(ai, PERSONA);
      if (flags.some((f) => f.startsWith("EMPTY"))) empties++;
      if (flags.some((f) => f.startsWith("ENGLISH_LEAK") || f.startsWith("NAME_LEAK") || f.startsWith("JSON"))) leaks++;
      if (flags.length) {
        anomalies.push({ t: t + 1, utter, ai, flags });
        console.log(`🤖 ${PERSONA.companion}: ${ai || "(빈 응답)"}`);
        console.log(`   ⚠ [${flags.join(", ")}]\n`);
      } else {
        console.log(`🤖 ${PERSONA.companion}: ${ai}\n`);
      }
    }
  } catch (e) {
    console.error(`\n! 실행 오류: ${e.message.split("\n")[0]}`);
  } finally {
    console.log(`\n===== 완료 =====`);
    console.log(`총 ${TURNS}턴 · 빈응답 ${empties} · 누출(영어/이름/JSON) ${leaks} · 이상감지 ${anomalies.length}`);
    if (anomalies.length) {
      console.log(`\n[이상감지 상세]`);
      for (const a of anomalies) console.log(`  t${a.t} [${a.flags.join(", ")}]  어르신"${a.utter.slice(0, 30)}" → AI"${(a.ai || "(빈)").slice(0, 50)}"`);
    } else {
      console.log(`✅ 누출·빈응답·이상 0건 — 유동형 대화 전 구간 클린`);
    }
    console.log(`\n계정: ${email}  (검증: node scripts/archive/_check-leak.mjs ${STAMP})`);
    if (HEADED) { console.log(`\n(브라우저 5초 후 닫힘)`); await page.waitForTimeout(5000); }
    await browser.close();
    await pool.end();
  }
})();
