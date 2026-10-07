// 한 STAMP의 전체 사이클 계정 집계: 빈응답/영어누출/민지누출 (읽기 전용, DB=ground truth)
// 사용: node scripts/_check-leak.mjs <stampLike>   예: 534164
import pg from "pg";
import { pgTlsOptions } from "../db-tls.mjs";
import "dotenv/config";
const STAMP = process.argv[2] || "";
// TLS는 앱과 같은 정책(scripts/db-tls.mjs → lib/db-tls, 2026-10-07 8차) — 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL);
const p = new pg.Pool({ connectionString, ...(ssl ? { ssl } : {}) });
const c = await p.connect();
const rows = await c.query(
  `SELECT u.email, u."companionName" comp, m.content
   FROM "Message" m
   JOIN "Conversation" cv ON cv.id = m."conversationId"
   JOIN "User" u ON u.id = cv."userId"
   WHERE m.role='assistant' AND u.email LIKE $1
   ORDER BY u.email, m."createdAt" ASC`,
  [`%${STAMP}%`],
);
const ENG = /print\(|google_search|tool_code|final polish|let.?s check|no time labels|no hallucination|formatting:|\b(user|ai)\s*:\s|the user (is|wants|said|asked)/i;
const byAcct = {};
for (const r of rows.rows) {
  const a = (byAcct[r.email] ||= { comp: r.comp, n: 0, empty: 0, eng: 0, minji: 0 });
  a.n++;
  if (!r.content || !r.content.trim()) a.empty++;
  if (ENG.test(r.content)) a.eng++;
  // 동반자가 민지가 아닌데 "민지" 자기지칭 등장 = 누출
  if (a.comp !== "민지" && /민지(?:이?(?:가|는|도|예요|에요|이에요|랑|와)|이|아|야)/.test(r.content)) a.minji++;
}
let tn = 0, te = 0, tg = 0, tm = 0;
console.log(`STAMP "${STAMP}" 사이클 집계 (DB ground truth):\n`);
for (const [email, a] of Object.entries(byAcct)) {
  tn += a.n; te += a.empty; tg += a.eng; tm += a.minji;
  const flag = (a.empty || a.eng || a.minji) ? "  ⚠" : "";
  console.log(`  ${email.slice(-14)} [${a.comp}] AI ${a.n}건 · 빈 ${a.empty} · 영어 ${a.eng} · 민지 ${a.minji}${flag}`);
}
console.log(`\n총 ${Object.keys(byAcct).length}계정 ${tn}턴 · 빈응답 ${te} · 영어누출 ${tg} · 민지누출 ${tm}`);
c.release();
await p.end();
