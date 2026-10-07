/**
 * Playwright e2e — 동적 단어 회상 테스트 (AI 응답을 읽고 그에 맞춰 답함).
 *
 * 흐름: 계정 생성 → 로그인 → 단어 외우기 시작 → AI가 준 단어를 화면에서 읽음 →
 *       필러 대화로 시간차 → 회상 답변(정상=전부 / 경증=일부 / 중증=못함) → DB의 memory_delayed score 검증.
 *
 * 사용: node scripts/e2e-recall.mjs [accounts] [round] [headed]
 *   계정마다 정상(0)/경증(1)/중증(2) 변형을 라운드로빈 배정.
 */
import { chromium } from "playwright";
import pg from "pg";
import { pgTlsOptions } from "./db-tls.mjs";
import fs from "fs";
import "dotenv/config";

const BASE = process.env.E2E_BASE || "http://localhost:3100";
const PW = "test1234!";
const ACCOUNTS = parseInt(process.argv[2] || "3", 10);
const ROUND = process.argv[3] || "1";
const HEADED = process.argv[4] === "headed";
const STAMP = Date.now();
const INPUT_SEL = 'input[placeholder="메시지를 입력하세요."]';
const VARIANTS = [
  { key: "정상(0)", target: 0 },
  { key: "경증(1)", target: 1 },
  { key: "중증(2)", target: 2 },
];

function pgPool() {
  // TLS는 앱과 같은 정책(scripts/db-tls.mjs → lib/db-tls, 2026-10-07 8차) — 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL);
  return new pg.Pool({ connectionString, ...(ssl ? { ssl } : {}) });
}
async function signupUI(page, email) {
  await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="password"]', { timeout: 10000 }).catch(() => {});
  await page.evaluate(({ email, pw }) => {
    const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set; s.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
    const inputs = [...document.querySelectorAll("input")];
    const byPh = (p) => inputs.find((i) => (i.getAttribute("placeholder") || "").includes(p));
    if (byPh("이메일")) set(byPh("이메일"), email);
    const pws = inputs.filter((i) => i.type === "password"); set(pws[0], pw); if (pws[1]) set(pws[1], pw);
    const age = document.querySelector('input[type="number"]'); if (age) set(age, "80");
    const sels = [...document.querySelectorAll("select")];
    const setSel = (sel, label) => { if (!sel) return; const o = [...sel.options].find((o) => o.textContent.trim() === label); if (o) { sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); } };
    setSel(sels[0], "여성");
    setSel(sels.find((s) => [...s.options].some((o) => o.textContent.includes("할머니"))), "할머니");
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "회원가입")?.click();
  }, { email, pw: PW });
  await page.waitForURL(/\/login/, { timeout: 20000 }).catch(() => {});
}
async function login(page, email) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('input[type="password"]', { timeout: 10000 });
      await page.evaluate(({ email, pw }) => {
        const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; s.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
        const inp = document.querySelectorAll("input");
        set(document.querySelector('input[type="email"]') || inp[0], email);
        set(document.querySelector('input[type="password"]') || inp[1], pw);
        [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "로그인")?.click();
      }, { email, pw: PW });
      await page.waitForURL(/\/chat/, { timeout: 25000 });
      return;
    } catch (e) { if (attempt === 2) throw e; await page.waitForTimeout(1500); }
  }
}
async function enterChat(page) {
  await page.waitForSelector('button:has-text("글씨로 대화하기")', { timeout: 12000 }).catch(() => {});
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("글씨로 대화하기")); if (b) b.click(); });
  await page.waitForSelector(INPUT_SEL, { timeout: 12000 });
  await page.waitForFunction(() => [...document.querySelectorAll("p")].some((p) => p.textContent.trim().length > 3), { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
}
async function sendGetReply(page, text) {
  await page.waitForSelector(INPUT_SEL, { timeout: 8000 });
  const before = await page.evaluate(() => document.querySelectorAll("p").length);
  await page.evaluate((t) => {
    const inp = document.querySelector('input[placeholder="메시지를 입력하세요."]');
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    s.call(inp, t); inp.dispatchEvent(new Event("input", { bubbles: true })); inp.closest("form").requestSubmit();
  }, text);
  let reply = "";
  for (let i = 0; i < 22; i++) {
    await page.waitForTimeout(900);
    const now = await page.evaluate(() => document.querySelectorAll("p").length);
    if (now >= before + 2) { reply = await page.evaluate(() => [...document.querySelectorAll("p")].pop()?.textContent || ""); break; }
  }
  await page.waitForTimeout(700);
  return reply;
}
const STOP = new Set(["할머니", "할아버지", "좋아요", "네", "민지", "그래", "맞아요", "선생님", "어르신", "그럼요", "좋아", "자요", "그래요", "아유", "어머"]);
function parseWords(aiText) {
  // 인사말/호칭 콤마를 배제하고 회상 대상 단어(콤마 나열)를 추출.
  const re3 = /([가-힣]{1,4})\s*,\s*([가-힣]{1,4})\s*,\s*([가-힣]{1,4})/g;
  let m;
  while ((m = re3.exec(aiText))) { const ws = [m[1], m[2], m[3]]; if (ws.every((w) => !STOP.has(w))) return ws; }
  const re2 = /([가-힣]{1,4})\s*,\s*([가-힣]{1,4})/g;
  while ((m = re2.exec(aiText))) { const ws = [m[1], m[2]]; if (ws.every((w) => !STOP.has(w))) return ws; }
  return [];
}

async function main() {
  const pool = pgPool();
  const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 80 : 25 });
  const recs = [];
  console.log(`[recall] ${ACCOUNTS} accounts (동적 단어 회상)`);

  for (let i = 0; i < ACCOUNTS; i++) {
    const variant = VARIANTS[i % VARIANTS.length];
    const email = `recall_${STAMP}_${i}@example.com`;
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const rec = { email, variant: variant.key, target: variant.target, words: [], recallText: "", score: null, ok: false };
    try {
      await signupUI(page, email);
      const c0 = await pool.connect();
      try { const r = await c0.query(`SELECT id FROM "User" WHERE email=$1`, [email]); rec.uid = r.rows[0]?.id; } finally { c0.release(); }
      await login(page, email);
      await enterChat(page);

      // 1) 단어 외우기 시작 → AI가 준 단어 읽기
      let reply = await sendGetReply(page, "민지야 우리 단어 외우기 하자. 단어 세 개 불러줘, 내가 외울게");
      rec.words = parseWords(reply);
      for (let t = 0; t < 2 && rec.words.length < 2; t++) {
        reply = await sendGetReply(page, "그 단어 세 개만 콤마로 또박또박 다시 불러줄래?");
        rec.words = parseWords(reply);
      }
      if (rec.words.length < 2) { rec.parseFail = true; }
      // 2) 필러(시간차)
      await sendGetReply(page, "그래 외웠어, 오늘 날씨가 참 좋네");
      await sendGetReply(page, "응 점심도 든든히 먹었지");
      // 3) 회상 답변 (목표별)
      let recall;
      if (variant.target === 0) recall = `아까 외운 단어 다시 말해볼게. ${rec.words.join(", ")}`;
      else if (variant.target === 1) recall = `아까 외운 단어가… ${rec.words.slice(0, Math.max(1, rec.words.length - 1)).join(", ")}… 나머지는 도무지 생각이 안 나네`;
      else recall = "아까 외운 단어가 뭐였더라… 도무지 하나도 생각이 안 나";
      rec.recallText = recall;
      await sendGetReply(page, recall);
      process.stdout.write(`\r[${email.slice(-14)}] ${variant.key} words=${rec.words.join("/")}      `);
    } catch (e) {
      rec.err = e.message.split("\n")[0];
    } finally { await ctx.close(); }
    recs.push(rec);
  }
  console.log("\n[recall] 분석 대기(12s)");
  await new Promise((r) => setTimeout(r, 12000));

  // 검증: 회상 메시지의 memory_delayed score
  for (const rec of recs) {
    if (!rec.uid) continue;
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT ca.domain, ca.score FROM "Message" m
         JOIN cognitive_assessments ca ON ca.message_id = m.id
         WHERE m."conversationId" IN (SELECT id FROM "Conversation" WHERE "userId"=$1)
           AND m.role='user' AND m.content = $2`,
        [rec.uid, rec.recallText],
      );
      const md = r.rows.find((x) => x.domain === "memory_delayed");
      rec.score = md ? md.score : (r.rows[0] ? r.rows[0].score : null);
      rec.allDomains = r.rows.map((x) => `${x.domain}:${x.score}`).join(" ");
      if (rec.parseFail) { rec.na = true; }
      else if (rec.target === 0) rec.ok = rec.score === 0;
      else if (rec.target === 1) rec.ok = rec.score === 1;
      else rec.ok = rec.score >= 2;
    } finally { c.release(); }
  }

  const lines = [];
  lines.push(`# Playwright 동적 단어회상 검증 — Round ${ROUND}`);
  lines.push(`\n- 생성: ${new Date().toISOString()}\n- 계정 ${ACCOUNTS}개 (AI가 준 단어를 읽고 정상/경증/중증으로 답변 → memory_delayed 검증)\n`);
  lines.push("| 계정 | 변형 | AI가 준 단어 | 회상 답변 | memory_delayed | 판정 |");
  lines.push("|------|------|--------------|-----------|----------------|------|");
  let hit = 0, scored = 0, na = 0;
  for (const rec of recs) {
    const verdict = rec.na ? "N/A(파싱실패)" : rec.ok ? "O" : "X";
    lines.push(`| ${rec.email.slice(-14)} | ${rec.variant} | ${rec.words.join(", ") || "(파싱실패)"} | ${rec.recallText.slice(0, 28)}… | ${rec.allDomains || (rec.err ? "ERR:" + rec.err : "(없음)")} | ${verdict} |`);
    if (rec.na) { na++; } else { scored++; if (rec.ok) hit++; }
  }
  lines.push(`\n### 정확도(채점 가능분): ${hit}/${scored} (${scored ? ((hit / scored) * 100).toFixed(1) : 0}%)  ·  N/A(단어 파싱실패): ${na}/${recs.length}`);
  const out = lines.join("\n");
  fs.writeFileSync(`docs/리포트_recall_round${ROUND}.md`, out, "utf-8");
  const summary = `| ${new Date().toISOString().slice(0, 19)} | e2e-recall | R${ROUND} | ${recs.length}계정 | ${hit}/${scored} (${scored ? ((hit / scored) * 100).toFixed(1) : 0}%) · N/A ${na} |\n`;
  const cum = "docs/리포트_누적.md";
  if (!fs.existsSync(cum)) fs.writeFileSync(cum, "# e2e 누적 검증 요약\n\n| 시각(UTC) | 테스트 | 라운드 | 규모 | 정확도 |\n|---|---|---|---|---|\n", "utf-8");
  fs.appendFileSync(cum, summary, "utf-8");
  console.log("\n" + out);
  await browser.close(); await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
