/**
 * 역할별 유동형(LLM-in-the-loop) 검증 — 사용자/전문가/일반인 3역할.
 * e2e-dynamic.mjs 기반: AI 동반자의 직전 응답을 페르소나 LLM에 넘겨 "다음 발화"를
 * 실시간 생성(고정 답변 아님) → 전송 → 되먹임.
 *
 * 역할별 추가 검증(모드 혼입 감지 — 2026-06-12 계정 유형 분리 원칙):
 *   - general: AI가 인지 선별 질문(요일·계산·단어암기·속담)을 하면 MODE_MIX
 *   - user/pro: AI가 정신건강 자가점검(마음 건강 체크/우울·불안·성격 검사)을 언급하면 MODE_MIX
 *
 * 사용: node scripts/e2e-roles.mjs [turns] [role] [headless]
 *   role: user(기본) | general | pro
 */
import { chromium } from "playwright";
import pg from "pg";
import { pgTlsOptions } from "./db-tls.mjs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";

const BASE = process.env.E2E_BASE || "http://localhost:3100";
const PW = "test1234!";
const TURNS = parseInt(process.argv[2] || "30", 10);
const ROLE = (process.argv[3] || "user").toLowerCase();
const HEADED = process.argv[4] !== "headless" && process.argv[3] !== "headless";
const PERSONA_MODEL = process.env.PERSONA_MODEL || "gemini-2.5-flash";
const STAMP = Date.now();

// ─── 역할별 페르소나 ─────────────────────────────────────────────────────────
const PERSONAS = {
  user: {
    name: "김순자", age: 78, honorific: "할머니", gender: "여성", roleBtn: "사용자",
    companion: "지윤", relation: "손녀",
    bio: "경북 안동에서 태어나 자랐고, 남편과 사별한 뒤 경기도 동탄 아파트에서 혼자 산다. " +
         "아들이 둘(큰아들 김민호, 작은아들 김성호) 있고 손주들이 가끔 찾아온다. " +
         "텃밭에 상추·고추 키우는 재미와 저녁마다 트로트 프로 보는 낙으로 지낸다. 무릎이 좀 안 좋다.",
    style: "1~2문장, 정겹고 편한 구어체(반말~해요체). 노인 화법: 가족·텃밭·날씨·건강·옛날 얘기.",
    speakerLabel: "어르신",
    fallback: ["그나저나 오늘 날씨가 참 좋네, 텃밭에 물 줘야겠어.", "요새 무릎이 좀 시큰거리는데 그러려니 하고 지내.", "저녁에 트로트 프로 하는 날인데 벌써 기다려지네.", "아들 녀석들 바빠서 통 못 보는데 보고 싶구먼."],
    extraRule: "동반자가 인지 확인 질문(요일·날짜·계산·단어 외우기 등)을 하면 노인답게 답하세요 — 대부분 맞히되 가끔 헷갈려도 자연스럽습니다.",
    // 과거 기억 검증: 초반에 고유 사실을 심고, 컨텍스트 윈도우 밖(60·90턴)에서 회상 질문 → AI 응답에 키워드 검증
    inject: {
      5: "참, 우리 강아지 이름이 복실이야. 작년부터 키우는데 어찌나 귀여운지 몰라.",
      20: "내가 제일 좋아하는 꽃은 채송화야. 어릴 때 마당에 가득 폈었거든.",
    },
    memProbes: { 60: { utter: "아까 내가 우리 강아지 이름이 뭐라고 했는지 기억하니?", expect: "복실" }, 90: { utter: "내가 제일 좋아한다고 했던 꽃이 뭐였지?", expect: "채송화" } },
  },
  general: {
    name: "박지훈", age: 35, honorific: "선생님", gender: "남성", roleBtn: "일반인",
    companion: "민지", relation: "친구",
    bio: "서울에 사는 35세 직장인. IT 회사 과장이고 미혼. 야근이 잦아 수면이 불규칙하고 " +
         "업무 스트레스가 많다. 주말엔 주로 집에서 쉰다. 예전 취미는 등산·자전거였는데 요즘은 뜸하다.",
    style: "1~2문장, 평범한 30대 직장인 말투(해요체 위주). 주제: 회사 일·스트레스·수면·주말·운동·연애/가족 고민.",
    speakerLabel: "사용자",
    fallback: ["요즘 야근이 많아서 좀 지치네요.", "주말엔 그냥 집에서 쉬기만 했어요.", "잠을 깊게 못 자는 것 같아요.", "운동을 다시 시작해야 하는데 의욕이 안 나네요."],
    extraRule: "AI가 자가점검(검사) 문항을 물으면 솔직한 빈도/동의로 답하세요(예: '며칠 그랬어요', '가끔요', '그런 편이에요'). 검사 중에도 가끔 짧은 부연을 붙여도 좋습니다.",
    // 일반인 시나리오: 중반·후반에 본인이 검사를 요청 (사용자 주도 — 답변은 전부 동적) + 기억 검증 시드
    inject: {
      5: "참고로 제 고향은 춘천이에요. 호수가 많아서 좋았죠.",
      12: "마음 건강 체크 해볼래요",
      32: "성격 검사도 해볼게요",
      45: "요즘 고양이를 키우기 시작했어요. 이름은 두부예요.",
    },
    memProbes: { 70: { utter: "아까 제 고향이 어디라고 했는지 기억하세요?", expect: "춘천" }, 95: { utter: "제 고양이 이름이 뭐라고 했죠?", expect: "두부" } },
  },
  pro: {
    name: "박영감", age: 81, honorific: "할아버지", gender: "남성", roleBtn: "전문가",
    companion: "민지", relation: "검사자",
    bio: "전문가(간호사)가 옆에서 진행하는 표준 인지검사를 받는 81세 어르신. 서울 출신, 부인과 둘이 산다. " +
         "귀가 약간 어둡지만 협조적이다. 기억력이 예전 같지 않다고 느낀다.",
    style: "1~2문장, 검사에 협조하는 어르신 말투. 검사자의 문항에 답하는 것이 주된 역할.",
    speakerLabel: "수검자",
    fallback: ["네, 다음 질문 주세요.", "아 그건 잘 기억이 안 나네요.", "다시 한 번 말씀해 주시겠어요?", "네 알겠습니다."],
    extraRule: "검사자가 표준 문항(날짜·계산·단어 외우기·따라 말하기 등)을 내면 어르신답게 답하세요. " +
      "대체로 맞히되 5~6문항에 하나 정도는 틀리거나 '가물가물하다'고 하세요(현실적인 수검 패턴). 검사 진행을 잡담으로 끌지 마세요.",
    inject: { 1: "검사 시작하겠습니다. 잘 부탁드려요." },
  },
};

const P = PERSONAS[ROLE];
if (!P) { console.error(`알 수 없는 role: ${ROLE} (user|general|pro)`); process.exit(1); }

const PERSONA_SYS = `당신은 ${P.age}세 '${P.name}'(${P.honorific})입니다.
[배경] ${P.bio}
당신은 AI(${P.relation} '${P.companion}')와 대화합니다.

[연기 규칙 — 반드시 지킬 것]
- 당신은 본인입니다. 상대의 직전 말에 자연스럽게 반응하는 "다음 한 마디"만 생성하세요.
- ${P.style}
- 따옴표·지문·설명·괄호 없이 **발화 내용만** 출력. "${P.speakerLabel}:" 같은 라벨 금지.
- 직전 발화를 똑같이 반복하지 말고 대화를 이어가거나 가끔 새 화제를 꺼내세요.
- ${P.extraRule}`;

const personaLLM = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({
  model: PERSONA_MODEL,
  systemInstruction: PERSONA_SYS,
  generationConfig: { temperature: 1.0, maxOutputTokens: 1024 },
});

async function genUtterance(history, idx) {
  if (P.memProbes && P.memProbes[idx + 1]) return P.memProbes[idx + 1].utter;
  if (P.inject && P.inject[idx + 1]) return P.inject[idx + 1];
  const convo = history.slice(-12).map((h) => `${h.who === "ai" ? "AI" : P.speakerLabel}: ${h.text}`).join("\n");
  const prompt = `${convo}\n\nAI의 마지막 말에 이어 ${P.speakerLabel}이(가) 할 다음 한 마디만 출력:`;
  try {
    const res = await personaLLM.generateContent(prompt);
    const parts = res?.response?.candidates?.[0]?.content?.parts;
    let t = Array.isArray(parts)
      ? parts.filter((p) => !p?.thought && typeof p?.text === "string").map((p) => p.text).join("")
      : "";
    t = (t || "").trim().replace(/^["'「『\s]+|["'」』\s]+$/g, "").split("\n")[0].trim();
    t = t.replace(new RegExp(`^${P.speakerLabel}\\s*[:：]\\s*`), "").trim();
    const prevUser = [...history].reverse().find((h) => h.who === "user")?.text?.trim();
    if (t.length >= 2 && t !== prevUser) return t;
  } catch (e) {
    console.warn(`  [persona-llm] gen 실패: ${e.message.split("\n")[0]}`);
  }
  return P.fallback[idx % P.fallback.length];
}

// ─── 누출·모드혼입 감지 ──────────────────────────────────────────────────────
const ENGLISH_LEAK_RE = /print\(|google_search|tool_code|tool_outputs|final polish|let.?s check|no time labels|no hallucination|formatting\s*:|thought\s*:|\b(user|ai|assistant)\s*:\s|the user (is|wants|said|asked|means|needs)|i should|i need to/i;
// general 계정에 나오면 안 되는 인지 선별 질문 표지
const COGNITIVE_PROBE_RE = /무슨\s*요일|몇\s*월\s*며칠|오늘.*날짜.*(?:아세요|기억|말씀)|에서\s*7을\s*빼|빼면\s*얼마|거꾸로\s*(?:말|세어)|단어.*(?:외워|기억나세요)|속담.*(?:뜻|의미)|삼천리|따라\s*해\s*보세요|동물\s*이름.*(?:대|말씀)해/;
// user/pro 계정에 나오면 안 되는 정신건강 검사 표지
const MENTAL_RE = /마음\s*건강\s*체크|우울\s*(?:검사|점검|체크)|불안\s*체크|외로움\s*체크|성격\s*검사|PHQ|GAD|자가\s*점검을\s*시작/;

function detect(ai, mineUtter) {
  const flags = [];
  if (!ai || !ai.trim()) { flags.push("EMPTY(빈 응답)"); return flags; }
  if (ENGLISH_LEAK_RE.test(ai)) flags.push("ENGLISH_LEAK(영어누출)");
  if (ai.includes("****") || /\*\*\s*이에요|\*\*\s*예요/.test(ai)) flags.push("BLANK(**** 블랭킹)");
  if (/\{[^}]*"(text|isAnomaly|score|response|analysisNote)"/.test(ai) || /"isAnomaly"\s*:/.test(ai)) flags.push("JSON_LEAK");
  if (/방금 말씀하신 내용을 좀 더 자세히|다시 한 번 여쭤볼게요/.test(ai)) flags.push("FALLBACK(회피)");
  // 모드 혼입
  if (ROLE === "general" && COGNITIVE_PROBE_RE.test(ai)) flags.push("MODE_MIX(인지질문→일반인)");
  if ((ROLE === "user" || ROLE === "pro") && MENTAL_RE.test(ai) && !MENTAL_RE.test(mineUtter || "")) flags.push("MODE_MIX(정신건강→" + ROLE + ")");
  // 호칭 (노인 페르소나만 — 반대 성별 호칭 오류)
  // 예외: 반대 호칭이 '배우자(남편/아내) 지칭' 맥락이면 오호칭 아님 — 어르신이 배우자를 "할아버지/할머니"로
  //       부르는 정상 용법(돌아가신 남편 회상 등). 이 맥락 단어가 응답에 있으면 오탐으로 보지 않음.
  if (P.honorific === "할머니" || P.honorific === "할아버지") {
    const opp = P.honorific === "할머니" ? "할아버지" : "할머니";
    const SPOUSE_CTX = /영감|남편|아내|안사람|바깥양반|돌아가신|사별|살아\s*계|먼저\s*(?:가|떠)|그리|보고\s*싶|생각|추억|함께|같이|곁에|계실\s*때/;
    if (new RegExp(`${opp}[,!\\s]`).test(ai) && !new RegExp(P.honorific).test(ai) && !SPOUSE_CTX.test(ai)) flags.push(`HONORIFIC(${opp})`);
  }
  return flags;
}

// ─── Playwright 헬퍼 ─────────────────────────────────────────────────────────
async function signupUI(page, email) {
  await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]', { timeout: 12000 });
  // 계정 유형 버튼 클릭 (사용자/전문가/일반인)
  await page.evaluate((label) => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes(label));
    if (btn) btn.click();
  }, P.roleBtn);
  await page.waitForTimeout(300);
  await page.locator('input[type="email"]').fill(email);
  const pws = page.locator('input[type="password"]');
  await pws.nth(0).fill(PW);
  await pws.nth(1).fill(PW);
  await page.locator('input[type="number"]').first().fill(String(P.age)).catch(() => {});
  await page.locator("select").first().selectOption({ label: P.gender === "여성" ? "여성" : "남성" }).catch(() => {});
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
      /**
       * ⚠ 2026-10-02 수정 — 로그인 후 동선이 바뀌어 있었는데 스크립트가 낡아 있었다.
       *   예전: 로그인 → /chat
       *   현재: 로그인 → `/`(역할별 랜딩을 서버가 결정) → 미동의면 /consent, 동의했으면
       *         어르신 홈(큰 버튼) 또는 /expert·/mental.
       *   그래서 `waitForURL(/\/(chat|consent)/)`가 25초 타임아웃으로 죽었고, 그 실패가
       *   "✅ 전 구간 클린 · exit 0"으로 보고되어 **라이브 검증이 통째로 멈춘 줄도 몰랐다**.
       */
      await page.waitForURL(/\/(consent|chat|mental|expert)|3100\/$/, { timeout: 25000 });
      if (page.url().includes("/consent")) {
        await page.getByRole("checkbox").first().check().catch(() => {});
        await page.getByRole("button", { name: "동의하고 시작하기" }).click();
        await page.waitForTimeout(2500);
      }
      /**
       * 역할별 랜딩이 제각각이라(어르신=홈 큰버튼 / 일반인=/mental / 전문가=/expert)
       * 홈 링크를 따라가는 방식은 역할마다 깨진다. 대화 화면으로 **직접** 간다 — 결정적이다.
       *   (2026-10-02: 이 차이 때문에 general·pro가 30턴 중 0턴 실행으로 죽고 있었다)
       */
      if (!/\/chat/.test(page.url())) {
        /**
         * ⚠ pro(전문가)는 **본인 계정 대화가 제품에서 막혀 있다** — app/chat/page.tsx:683이
         *   proxyPatientId 없는 pro를 /expert로 되돌린다. 전문가의 유일한 대화 경로는
         *   `/chat?patient=<환자ID>` 대리 검진이고, 그건 표준 문항 상태머신(handleExamTurn)이라
         *   이 유동형 수다 스크립트와 성격이 다르다.
         *   즉 지금까지 pro 역할은 **제품에 존재하지 않는 경로**를 두드리고 있었다.
         *   억지로 통과시키면 또 거짓 녹색이 되므로, 사유를 명시하고 명확히 중단한다.
         *   (대리 검진 전용 시나리오는 scripts/e2e-screening.mjs가 담당한다)
         */
        if (ROLE === "pro") {
          throw new Error("pro 역할은 본인 대화가 제품에서 차단됨(/expert 리다이렉트) — 대리 검진은 e2e-screening.mjs 사용");
        }
        await page.goto(`${BASE}/chat`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);
      }
      return;
    } catch (e) { if (attempt === 2) throw e; await page.waitForTimeout(1500); }
  }
}

const INPUT_SEL = 'input[placeholder="메시지를 입력하세요."]';
async function enterTextChat(page) {
  /**
   * ⚠ 2026-10-02 수정 — 모드 선택 화면의 구조가 바뀌어 있었다.
   *   어르신(user) 모드에서는 '글씨로 대화하기'가 평소 숨겨져 있고(음성이 기본 동선),
   *   마이크 거부 상태에서만 드러난다. headless에는 마이크가 없으므로
   *   '음성으로 대화하기'를 먼저 눌러 micDenied를 유발해야 텍스트 버튼이 나타난다.
   *   예전 스크립트는 곧장 '글씨로 대화하기'를 찾다 못 찾고 입력창 대기에서 12초 타임아웃으로 죽었다.
   */
  const clickByText = (needle) => page.evaluate((n) => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes(n));
    if (b) { b.click(); return true; }
    return false;
  }, needle);

  for (let attempt = 0; attempt < 3; attempt++) {
    if (await clickByText("글씨로 대화")) break;        // 전문가·일반인: 바로 보인다
    if (await page.locator(INPUT_SEL).count()) break;   // 이미 텍스트 모드
    // 어르신: 음성 시도 → 마이크 없음(headless) → micDenied → 텍스트 버튼 노출
    if (!(await clickByText("음성으로 대화하기"))) await clickByText("대화 시작");
    await page.waitForTimeout(2500);
  }
  await page.waitForSelector(INPUT_SEL, { timeout: 15000 });
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
  const email = `role_${ROLE}_${STAMP}@example.com`;
  console.log(`\n🎭 역할별 유동형 검증 — role=${ROLE} (${P.roleBtn})`);
  console.log(`   페르소나: ${P.name}(${P.age}) · ${TURNS}턴 · 페르소나 모델: ${PERSONA_MODEL}\n`);

  // TLS는 앱과 같은 정책(scripts/db-tls.mjs → lib/db-tls, 2026-10-07 8차) — 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL);
  const pool = new pg.Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 60 : 0 });
  const ctx = await browser.newContext({ viewport: { width: 480, height: 860 } });
  const page = await ctx.newPage();

  // 네트워크·콘솔 관측 — 실시간 환경 문제(요청 실패·서버 오류) 포착
  const net = { failed: 0, http4xx: 0, http5xx: 0, consoleErrors: 0 };
  page.on("requestfailed", (req) => { if (req.url().includes("/api/")) { net.failed++; console.log(`  ⚠ [NET] 요청 실패: ${req.url().split("/api/")[1]} — ${req.failure()?.errorText}`); } });
  page.on("response", (res) => {
    if (!res.url().includes("/api/")) return;
    if (res.status() >= 500) { net.http5xx++; console.log(`  ⚠ [NET] HTTP ${res.status()}: ${res.url().split("/api/")[1]}`); }
    else if (res.status() >= 400 && res.status() !== 401) { net.http4xx++; console.log(`  ⚠ [NET] HTTP ${res.status()}: ${res.url().split("/api/")[1]}`); }
  });
  page.on("console", (msg) => { if (msg.type() === "error") net.consoleErrors++; });

  const history = [];
  const anomalies = [];
  const latencies = [];
  let empties = 0, leaks = 0, mixes = 0, memFails = 0;
  let turnsRun = 0;      // 실제로 완료한 턴 — '설정 턴수'와 혼동하면 거짓 녹색이 난다
  let runError = null;   // 실행 중단 사유

  try {
    await signupUI(page, email);
    const c0 = await pool.connect();
    try {
      const r = await c0.query(`SELECT id, "screeningMode" FROM "User" WHERE email=$1`, [email]);
      const uid = r.rows[0]?.id;
      if (!uid) throw new Error("signup 실패");
      const dbRole = r.rows[0].screeningMode;
      const expect = ROLE === "pro" ? "pro" : ROLE === "general" ? "general" : "user";
      if (dbRole !== expect) throw new Error(`계정 역할 불일치: DB=${dbRole}, 기대=${expect} (가입 버튼 클릭 실패?)`);
      if (ROLE === "user") await c0.query(`UPDATE "User" SET "companionName"=$1, "companionRelation"=$2 WHERE id=$3`, [P.companion, P.relation, uid]);
      console.log(`   계정 생성 OK: ${email} (role=${dbRole})\n`);
    } finally { c0.release(); }
    await login(page, email);
    await enterTextChat(page);

    const greeting = await page.evaluate(() => [...document.querySelectorAll("p")].map((p) => p.textContent.trim()).filter(Boolean).slice(-1)[0] || "");
    if (greeting) { history.push({ who: "ai", text: greeting }); console.log(`🤖 AI: ${greeting}\n`); }

    for (let t = 0; t < TURNS; t++) {
      const utter = await genUtterance(history, t);
      history.push({ who: "user", text: utter });
      console.log(`🧑 ${P.name}: ${utter}`);

      const t0 = Date.now();
      const ai = await sendAndRead(page, utter);
      const ms = Date.now() - t0;
      latencies.push(ms);
      turnsRun++;
      history.push({ who: "ai", text: ai });
      const flags = detect(ai, utter);
      // 과거 기억 검증 — 회상 질문 턴이면 AI 응답에 기대 키워드 포함 여부 확인
      const probe = P.memProbes && P.memProbes[t + 1];
      if (probe && !(ai || "").includes(probe.expect)) { flags.push(`MEMORY_FAIL(기대:${probe.expect})`); memFails++; }
      if (probe && (ai || "").includes(probe.expect)) console.log(`  ✓ [기억 검증] "${probe.expect}" 회상 성공 (${t + 1}턴째 질문)`);
      if (ms > 25000) flags.push(`SLOW(${(ms / 1000).toFixed(1)}s)`);
      if (flags.some((f) => f.startsWith("EMPTY"))) empties++;
      if (flags.some((f) => f.startsWith("ENGLISH_LEAK") || f.startsWith("JSON"))) leaks++;
      if (flags.some((f) => f.startsWith("MODE_MIX"))) mixes++;
      if (flags.length) {
        anomalies.push({ t: t + 1, utter, ai, flags });
        console.log(`🤖 AI: ${ai || "(빈 응답)"}`);
        console.log(`   ⚠ [${flags.join(", ")}]\n`);
      } else {
        console.log(`🤖 AI: ${ai}\n`);
      }
    }
  } catch (e) {
    runError = e.message.split("\n")[0];
    console.error(`\n! 실행 오류: ${runError}`);
  } finally {
    console.log(`\n===== 완료 (role=${ROLE}) =====`);
    // ⚠ 2026-10-02 결함 수정: 이전엔 `총 ${TURNS}턴`(= 설정값)을 찍었다. 그래서 턴이 **0개**
    //   실행돼도 "총 30턴 · 전부 0 · ✅ 전 구간 클린 · exit 0"이 나왔고, 로그인 타임아웃으로
    //   한 턴도 못 돌린 실행이 사람 눈에 '통과'로 보였다. 실제로 이 날 user·general 두 역할이
    //   모두 그렇게 거짓 통과했다. 검증 도구의 거짓 녹색은 검증을 안 하는 것보다 나쁘다 —
    //   안 했다는 사실조차 가리기 때문이다.
    console.log(`실행 ${turnsRun}/${TURNS}턴 · 빈응답 ${empties} · 누출 ${leaks} · 모드혼입 ${mixes} · 기억실패 ${memFails} · 이상감지 ${anomalies.length}`);
    if (latencies.length) {
      const sorted = [...latencies].sort((a, b) => a - b);
      const avg = Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length);
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      console.log(`응답 지연: 평균 ${(avg / 1000).toFixed(1)}s · p95 ${(p95 / 1000).toFixed(1)}s · 최대 ${(sorted[sorted.length - 1] / 1000).toFixed(1)}s`);
    }
    console.log(`네트워크: 요청실패 ${net.failed} · 5xx ${net.http5xx} · 4xx ${net.http4xx} · 콘솔에러 ${net.consoleErrors}`);
    if (anomalies.length) {
      console.log(`\n[이상감지 상세]`);
      for (const a of anomalies) console.log(`  t${a.t} [${a.flags.join(", ")}]  발화"${a.utter.slice(0, 30)}" → AI"${(a.ai || "(빈)").slice(0, 60)}"`);
    }
    /**
     * 합격 조건: 중단 없음 + 설정 턴수 전수 실행 + 이상 0 + **서버 5xx 0**.
     *
     * ⚠ 2026-10-02 2차 수정: 5xx를 합격 조건에서 빼 두었더니, 30턴 중 서버 오류 2건이
     *   난 실행이 "✅ 전 구간 클린"으로 보고됐다. 숫자는 출력되는데 판정에 안 쓰이면
     *   사람은 ✅만 보고 넘어간다 — 거짓 녹색의 변종이다.
     *   요청 실패·콘솔 에러는 헤드리스 환경(마이크 없음 등) 잡음이 섞이므로 경고로만 남긴다.
     */
    const incomplete = turnsRun < TURNS;
    if (runError || incomplete || anomalies.length || net.http5xx > 0) {
      const why = [
        runError ? `중단: ${runError}` : null,
        incomplete ? `미완료: ${turnsRun}/${TURNS}턴만 실행` : null,
        anomalies.length ? `이상 ${anomalies.length}건` : null,
        net.http5xx > 0 ? `서버 오류 5xx ${net.http5xx}건` : null,
      ].filter(Boolean).join(" · ");
      console.log(`\n❌ 실패 — ${why}`);
      process.exitCode = 1;
    } else {
      const warn = [net.failed ? `요청실패 ${net.failed}` : null, net.consoleErrors ? `콘솔에러 ${net.consoleErrors}` : null].filter(Boolean).join(" · ");
      console.log(`✅ 전 구간 클린 (${turnsRun}턴 전수)${warn ? ` — 참고: ${warn}` : ""}`);
    }
    console.log(`\n계정: ${email}`);
    await browser.close();
    await pool.end();
  }
})();
