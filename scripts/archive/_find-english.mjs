// 최근 assistant 메시지 중 영어(연속 ASCII 3자+) 섞인 것 조회 (읽기 전용)
import pg from "pg"; import "dotenv/config";
import { pgTlsOptions } from "../db-tls.mjs";
// TLS는 앱과 같은 정책(scripts/db-tls.mjs → lib/db-tls, 2026-10-07 8차) — 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL);
const p = new pg.Pool({ connectionString, ...(ssl ? { ssl } : {}) });
const c = await p.connect();
const r = await c.query(
  `SELECT LEFT(content, 160) AS content, "createdAt"
   FROM "Message"
   WHERE role='assistant' AND content ~ '[A-Za-z]{3,}'
   ORDER BY "createdAt" DESC LIMIT 25`
);
console.log(`영어 섞인 assistant 메시지 ${r.rows.length}건 (최근순):\n`);
for (const x of r.rows) {
  const eng = (x.content.match(/[A-Za-z][A-Za-z'’]{2,}/g) || []).slice(0, 8).join(", ");
  console.log(`• ${x.content.replace(/\n/g, " ")}`);
  console.log(`   ↳ 영어토큰: ${eng}\n`);
}
const tot = await c.query(`SELECT COUNT(*)::int n FROM "Message" WHERE role='assistant'`);
const engc = await c.query(`SELECT COUNT(*)::int n FROM "Message" WHERE role='assistant' AND content ~ '[A-Za-z]{3,}'`);
console.log(`전체 assistant ${tot.rows[0].n}건 중 영어섞임 ${engc.rows[0].n}건 (${(engc.rows[0].n/tot.rows[0].n*100).toFixed(1)}%)`);
c.release(); await p.end();
