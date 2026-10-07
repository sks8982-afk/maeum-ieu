/**
 * Playwright e2e — 종합 위험도 4단계 전구간 검증.
 * 강도가 다른 프로필로 대화 → 실제 /api/summary 의 severityTier·overallAvg 확인.
 *
 * 사용: node scripts/e2e-tier.mjs [round] [headed]
 */
import { chromium } from "playwright";
import pg from "pg";
import { pgTlsOptions } from "../db-tls.mjs";
import fs from "fs";
import "dotenv/config";

const BASE = process.env.E2E_BASE || "http://localhost:3100";
const PW = "test1234!";
const ROUND = process.argv[2] || "1";
const HEADED = process.argv[3] === "headed";
const STAMP = Date.now();
const INPUT_SEL = 'input[placeholder="메시지를 입력하세요."]';

const PROFILES = [
  { key: "정상군", expect: ["정상", "평가전"], lines: [
    "민지야 오늘 아침에 산책 다녀왔더니 개운하네",
    "점심은 된장찌개 끓여 먹었지 맛있더라",
    "오후엔 텃밭 좀 둘러봤어",
    "저녁엔 드라마나 보려고 해",
    "요즘 손주가 자주 와서 참 좋아",
    "민지랑 얘기하니 마음이 편하네",
  ] },
  { key: "혼합(중증권)", expect: ["경증", "중증", "고위험"], lines: [
    "오늘이 2003년 3월이지? 곧 봄이네",     // 시간 2
    "점심은 잘 챙겨 먹었어",                  // 정상
    "나 지금 부산 해운대 바닷가에 있어",      // 장소 2
    "산책도 다녀왔지",                        // 정상
    "어제 이순신 장군이 우리집에 왔다 갔어",  // 판단 2
    "드라마 한 편 봤어",                      // 정상
  ] },
  { key: "이상다발(고위험)", expect: ["중증", "고위험"], lines: [
    "오늘이 2003년 3월이지? 봄이라 좋구만",          // 시간 2
    "나 지금 뉴욕 한복판에 나와 있어",               // 장소 2
    "어제 이순신 장군이 우리집에 차 마시러 왔어",     // 판단 2
    "만원짜리 책 샀는데 거스름돈 2만원 받았어",       // 계산 2
    "다음 달에 군대 입대해야 해서 걱정이야",          // 판단 2
    "어제 박정희 대통령 만나서 악수했어",            // 판단 2
  ] },
];

// TLS는 앱과 같은 정책(scripts/db-tls.mjs → lib/db-tls, 2026-10-07 8차) — 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
function pgPool() { const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL); return new pg.Pool({ connectionString, ...(ssl ? { ssl } : {}) }); }
async function signupUI(page, email) {
  await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="password"]', { timeout: 10000 }).catch(() => {});
  await page.evaluate(({ email, pw }) => {
    const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set; s.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
    const inputs = [...document.querySelectorAll("input")]; const byPh = (p) => inputs.find((i) => (i.getAttribute("placeholder") || "").includes(p));
    if (byPh("이메일")) set(byPh("이메일"), email);
    const pws = inputs.filter((i) => i.type === "password"); set(pws[0], pw); if (pws[1]) set(pws[1], pw);
    const age = document.querySelector('input[type="number"]'); if (age) set(age, "80");
    const sels = [...document.querySelectorAll("select")]; const setSel = (sel, l) => { if (!sel) return; const o = [...sel.options].find((o) => o.textContent.trim() === l); if (o) { sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); } };
    setSel(sels[0], "여성"); setSel(sels.find((s) => [...s.options].some((o) => o.textContent.includes("할머니"))), "할머니");
    [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "회원가입")?.click();
  }, { email, pw: PW });
  await page.waitForURL(/\/login/, { timeout: 20000 }).catch(() => {});
}
async function login(page, email) {
  for (let a = 0; a < 3; a++) { try {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await page.evaluate(({ email, pw }) => { const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; s.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); }; const inp = document.querySelectorAll("input"); set(document.querySelector('input[type="email"]') || inp[0], email); set(document.querySelector('input[type="password"]') || inp[1], pw); [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "로그인")?.click(); }, { email, pw: PW });
    await page.waitForURL(/\/chat/, { timeout: 25000 }); return;
  } catch (e) { if (a === 2) throw e; await page.waitForTimeout(1500); } }
}
async function enterChat(page) {
  await page.waitForSelector('button:has-text("글씨로 대화하기")', { timeout: 12000 }).catch(() => {});
  await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("글씨로 대화하기")); if (b) b.click(); });
  await page.waitForSelector(INPUT_SEL, { timeout: 12000 });
  await page.waitForFunction(() => [...document.querySelectorAll("p")].some((p) => p.textContent.trim().length > 3), { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
}
async function send(page, text) {
  await page.waitForSelector(INPUT_SEL, { timeout: 8000 });
  const before = await page.evaluate(() => document.querySelectorAll("p").length);
  await page.evaluate((t) => { const inp = document.querySelector('input[placeholder="메시지를 입력하세요."]'); const s = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; s.call(inp, t); inp.dispatchEvent(new Event("input", { bubbles: true })); inp.closest("form").requestSubmit(); }, text);
  for (let i = 0; i < 22; i++) { await page.waitForTimeout(900); const now = await page.evaluate(() => document.querySelectorAll("p").length); if (now >= before + 2) break; }
  await page.waitForTimeout(700);
}

async function main() {
  const pool = pgPool();
  const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 80 : 25 });
  const recs = [];
  for (let pi = 0; pi < PROFILES.length; pi++) {
    const prof = PROFILES[pi];
    const email = `tier_${STAMP}_${pi}@example.com`;
    const ctx = await browser.newContext(); const page = await ctx.newPage();
    const rec = { key: prof.key, email, expect: prof.expect };
    try {
      await signupUI(page, email); await login(page, email); await enterChat(page);
      for (const line of prof.lines) { await send(page, line); process.stdout.write(`\r[${prof.key}] ${line.slice(0, 18)}…    `); }
      await page.waitForTimeout(8000); // 백그라운드 분석 적재
      const sum = await page.evaluate(async () => { const r = await fetch("/api/summary?period=week"); return r.ok ? await r.json() : { error: r.status }; });
      rec.tier = sum.severityTier; rec.avg = sum.overallAvg; rec.anomaly = sum.anomalyCount; rec.assess = sum.totalAssessments; rec.risk = (sum.riskDomains || []).map((d) => d.label).join(",");
      rec.ok = prof.expect.includes(sum.severityTier);
    } catch (e) { rec.err = e.message.split("\n")[0]; rec.ok = false; }
    finally { await ctx.close(); }
    recs.push(rec);
  }
  const L = [];
  L.push(`# 종합 위험도 4단계 e2e 검증 — Round ${ROUND}`);
  L.push(`\n- 생성: ${new Date().toISOString()} · 실제 /api/summary 등급 확인\n`);
  L.push("| 프로필 | 기대 등급 | 실제 등급 | overallAvg | 이상건수 | 평가수 | 주의영역 | 판정 |");
  L.push("|--------|-----------|-----------|-----------|---------|--------|----------|------|");
  let hit = 0;
  for (const r of recs) { if (r.ok) hit++; L.push(`| ${r.key} | ${r.expect.join("/")} | ${r.tier ?? (r.err ? "ERR:" + r.err.slice(0, 40) : "-")} | ${r.avg ?? "-"} | ${r.anomaly ?? "-"} | ${r.assess ?? "-"} | ${r.risk || "-"} | ${r.ok ? "O" : "X"} |`); }
  L.push(`\n## 등급 단조성: 정상군 → 혼합 → 이상다발 순으로 overallAvg 상승 여부 확인`);
  L.push(`## 정확도: ${hit}/${recs.length}`);
  const out = L.join("\n");
  fs.writeFileSync(`docs/리포트_tier_e2e_round${ROUND}.md`, out, "utf-8");
  console.log("\n" + out);
  await browser.close(); await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
