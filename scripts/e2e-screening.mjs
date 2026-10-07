/**
 * Playwright e2e 인지 선별 검증 — 실제 앱(UI→API→백그라운드 분석→DB) 전구간 테스트.
 *
 * 흐름: 계정 N개 생성 → Playwright로 로그인·텍스트 대화 → 유도 발화 전송 →
 *       백그라운드 분석이 cognitive_assessments에 쓴 score를 DB로 검증 → 리포트.
 *
 * 사용: node scripts/e2e-screening.mjs [accounts] [round]
 *   accounts: 생성·테스트할 계정 수 (기본 3)
 *   round:    리포트 라운드 번호 (기본 1)
 *
 * 사전: dev 서버(:3000) 실행 중이어야 함.
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

// 유도 시나리오: 자가발화(AI 질문 불필요)로 안정적으로 점수가 나오는 케이스 중심.
const SCENARIOS = [
  { key: "time-2", domain: "orientation_time", expect: 2, text: "오늘이 2003년 3월이지? 곧 봄이라 좋구만" },
  { key: "place-2", domain: "orientation_place", expect: 2, text: "나 지금 뉴욕 한복판에 나와 있어 사람이 엄청 많네" },
  { key: "judg-2", domain: "judgment", expect: 2, text: "어제 이순신 장군이 우리집에 차 마시러 왔다 갔어" },
  { key: "calc-2", domain: "attention_calculation", expect: 2, text: "어제 만원짜리 책 한 권 샀는데 거스름돈을 2만원이나 받아왔어" },
  { key: "normal-1", domain: null, expect: 0, text: "오늘 아침에 동네 한 바퀴 산책 다녀왔더니 몸이 개운하구나" },
  { key: "normal-2", domain: null, expect: 0, text: "점심에 된장찌개 끓여 먹었는데 아주 맛있더라" },
];

function pgClient() {
  // TLS는 앱과 같은 정책(scripts/db-tls.mjs → lib/db-tls, 2026-10-07 8차) — 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL);
  return new pg.Pool({ connectionString, ...(ssl ? { ssl } : {}) });
}

async function signupUI(page, email) {
  await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await page.evaluate(({ email, pw }) => {
    const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set; s.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
    const inputs = [...document.querySelectorAll("input")];
    const byPh = (p) => inputs.find((i) => (i.getAttribute("placeholder") || "").includes(p));
    if (byPh("이메일")) set(byPh("이메일"), email);
    const pws = inputs.filter((i) => i.type === "password");
    set(pws[0], pw); if (pws[1]) set(pws[1], pw);
    const age = document.querySelector('input[type="number"]'); if (age) set(age, "78");
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
        const em = document.querySelector('input[type="email"]') || inp[0];
        const p = document.querySelector('input[type="password"]') || inp[1];
        set(em, email); set(p, pw);
        [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "로그인")?.click();
      }, { email, pw: PW });
      await page.waitForURL(/\/chat/, { timeout: 25000 });
      return;
    } catch (e) { if (attempt === 2) throw e; await page.waitForTimeout(1500); }
  }
}

const INPUT_SEL = 'input[placeholder="메시지를 입력하세요."]';
async function enterTextChat(page) {
  // 대화 방식 선택 버튼 대기 → 클릭 → 입력창 등장 대기
  await page.waitForSelector('button:has-text("글씨로 대화하기")', { timeout: 12000 }).catch(() => {});
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("글씨로 대화하기"));
    if (btn) btn.click();
  });
  await page.waitForSelector(INPUT_SEL, { timeout: 12000 });
  // 첫 인사(conversationId 생성)가 화면에 뜰 때까지 대기 — 안 떠도 최대 15s 후 진행
  await page.waitForFunction(() => {
    const ps = [...document.querySelectorAll("p")].map((p) => p.textContent.trim()).filter(Boolean);
    return ps.length >= 1;
  }, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function send(page, text) {
  await page.waitForSelector(INPUT_SEL, { timeout: 8000 });
  const before = await page.evaluate(() => document.querySelectorAll("p").length);
  await page.evaluate((t) => {
    const inp = document.querySelector('input[placeholder="메시지를 입력하세요."]');
    const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    s.call(inp, t); inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.closest("form").requestSubmit();
  }, text);
  // assistant 응답(문단 수 증가) 대기
  for (let i = 0; i < 22; i++) {
    await page.waitForTimeout(900);
    const now = await page.evaluate(() => document.querySelectorAll("p").length);
    if (now >= before + 2) break;
  }
  await page.waitForTimeout(800); // 백그라운드 분석 여유
}

async function main() {
  const pool = pgClient();
  const accounts = [];
  for (let i = 0; i < ACCOUNTS; i++) accounts.push({ email: `e2e_${STAMP}_${i}@example.com` });

  const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 80 : 25 });
  console.log(`[e2e] ${ACCOUNTS} accounts, ${SCENARIOS.length} utterances each`);

  for (const acc of accounts) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await signupUI(page, acc.email);
      // 가입된 user id 조회
      const c0 = await pool.connect();
      try { const r = await c0.query(`SELECT id FROM "User" WHERE email=$1`, [acc.email]); acc.id = r.rows[0]?.id; } finally { c0.release(); }
      if (!acc.id) throw new Error("signup failed (no user row)");
      await login(page, acc.email);
      await enterTextChat(page);
      for (const sc of SCENARIOS) {
        await send(page, sc.text);
        process.stdout.write(`\r[${acc.email.slice(-12)}] sent ${sc.key}        `);
      }
    } catch (e) {
      console.log(`\n  ! ${acc.email} drive error: ${e.message.split("\n")[0]}`);
    } finally {
      await ctx.close();
    }
  }
  console.log("\n[e2e] 발화 전송 완료 → 백그라운드 분석 대기(12s)");
  await new Promise((r) => setTimeout(r, 12000));

  // 검증: 계정별 user 메시지 + assessment 조회
  const rows = [];
  for (const acc of accounts) {
    const c = await pool.connect();
    try {
      const r = await c.query(
        `SELECT m.content, m."isAnomaly" AS anomaly, ca.domain, ca.score
         FROM "Message" m
         LEFT JOIN cognitive_assessments ca ON ca.message_id = m.id
         WHERE m."conversationId" IN (SELECT id FROM "Conversation" WHERE "userId"=$1)
           AND m.role='user'`,
        [acc.id],
      );
      const byContent = {};
      for (const row of r.rows) {
        const k = row.content.trim();
        byContent[k] = byContent[k] || { anomaly: row.anomaly, checks: [] };
        if (row.domain) byContent[k].checks.push({ domain: row.domain, score: row.score });
      }
      acc.byContent = byContent;
    } finally { c.release(); }
  }

  // 채점
  const lines = [];
  lines.push(`# Playwright e2e 인지 선별 검증 — Round ${ROUND}`);
  lines.push("");
  lines.push(`- 생성: ${new Date().toISOString()}`);
  lines.push(`- 계정 ${ACCOUNTS}개 × 발화 ${SCENARIOS.length}개 (실제 UI→API→분석→DB 전구간)`);
  lines.push(`- 이상(2) 케이스: 해당 영역 score≥2 ↔ 정상 케이스: score≥2 없음(false anomaly 0)`);
  lines.push("");
  lines.push("| 계정 | 시나리오 | 기대 | 실제(domain:score) | isAnomaly | 판정 |");
  lines.push("|------|----------|------|--------------------|-----------|------|");

  let hit = 0, tot = 0;
  const byScn = {};
  for (const acc of accounts) {
    for (const sc of SCENARIOS) {
      tot++;
      byScn[sc.key] = byScn[sc.key] || { hit: 0, tot: 0 };
      byScn[sc.key].tot++;
      const rec = acc.byContent?.[sc.text.trim()];
      const checks = rec?.checks || [];
      const anomaly = rec?.anomaly;
      let pass;
      if (sc.expect === 2) {
        pass = checks.some((c) => c.domain === sc.domain && c.score >= 2);
      } else {
        pass = !checks.some((c) => c.score >= 2); // 정상 대조군: score2 없어야
      }
      if (pass) { hit++; byScn[sc.key].hit++; }
      const actual = checks.length ? checks.map((c) => `${c.domain}:${c.score}`).join(" ") : (rec ? "(체크없음)" : "(메시지없음)");
      lines.push(`| ${acc.email.slice(-12)} | ${sc.key} | ${sc.expect === 2 ? sc.domain + "=2" : "정상"} | ${actual} | ${anomaly ?? "-"} | ${pass ? "O" : "X"} |`);
    }
  }
  lines.push("");
  lines.push("### 시나리오별 정확도");
  lines.push("| 시나리오 | 정확도 |");
  lines.push("|----------|--------|");
  for (const k of Object.keys(byScn)) lines.push(`| ${k} | ${byScn[k].hit}/${byScn[k].tot} (${((byScn[k].hit / byScn[k].tot) * 100).toFixed(0)}%) |`);
  lines.push("");
  lines.push(`### 종합 정확도: ${hit}/${tot} (${((hit / tot) * 100).toFixed(1)}%)`);
  lines.push("");
  lines.push("생성 계정: " + accounts.map((a) => a.email).join(", "));

  const out = lines.join("\n");
  const path = `docs/리포트_e2e_round${ROUND}.md`;
  fs.writeFileSync(path, out, "utf-8");
  // 누적 요약 1줄
  const summary = `| ${new Date().toISOString().slice(0, 19)} | e2e-anomaly | R${ROUND} | ${ACCOUNTS}계정 | ${hit}/${tot} (${((hit / tot) * 100).toFixed(1)}%) |\n`;
  const cum = "docs/리포트_누적.md";
  if (!fs.existsSync(cum)) fs.writeFileSync(cum, "# e2e 누적 검증 요약\n\n| 시각(UTC) | 테스트 | 라운드 | 규모 | 정확도 |\n|---|---|---|---|---|\n", "utf-8");
  fs.appendFileSync(cum, summary, "utf-8");
  console.log("\n" + out + `\n\n저장: ${path}`);

  await browser.close();
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
