import "dotenv/config";
const { Pool } = require("pg");
import { pgTlsOptions } from "../../lib/db-tls";

async function main() {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const client = await pool.connect();

  const r = await client.query(`
    SELECT content, "isAnomaly", "analysisNote", "createdAt"
    FROM "Message"
    WHERE role = 'user'
      AND "conversationId" = 'cmni80oop000704lk3m8ayf3b'
      AND "analysisNote" IS NOT NULL
      AND "analysisNote" != ''
    ORDER BY "createdAt" DESC
    LIMIT 80
  `);

  console.log("=== 최근 80건 analysisNote ===\n");
  for (const row of r.rows) {
    const flag = row.isAnomaly ? "🔴" : "  ";
    console.log(`${flag} "${row.content.slice(0, 70)}"`);
    console.log(`     → ${row.analysisNote.slice(0, 200)}`);
    console.log();
  }

  const rep = await client.query(`
    SELECT "isAnomaly", content, "analysisNote"
    FROM "Message"
    WHERE role = 'user'
      AND "conversationId" = 'cmni80oop000704lk3m8ayf3b'
      AND ("analysisNote" ILIKE '%반복%' OR "analysisNote" ILIKE '%직전%' OR "analysisNote" ILIKE '%같은%')
    ORDER BY "createdAt" DESC
    LIMIT 40
  `);

  console.log(`\n=== '반복/직전/같은' 포함: ${rep.rows.length}건 ===\n`);
  for (const row of rep.rows) {
    const flag = row.isAnomaly ? "🔴 FLAGGED" : "✓ OK";
    console.log(`${flag}`);
    console.log(`  user: "${row.content.slice(0, 100)}"`);
    console.log(`  note: ${row.analysisNote.slice(0, 280)}`);
    console.log();
  }

  client.release();
  await pool.end();
}
main().catch(console.error);
