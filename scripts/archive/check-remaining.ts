import "dotenv/config";
const { Pool } = require("pg");
import { pgTlsOptions } from "../../lib/db-tls";

async function main() {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const client = await pool.connect();
  const r = await client.query(`
    SELECT content, "analysisNote"
    FROM "Message"
    WHERE role='user' AND "isAnomaly"=true
      AND (content ILIKE '%이발소%' OR content ILIKE '%커피%' OR content ILIKE '%텃밭%'
           OR content ILIKE '%이불 빨래%' OR content ILIKE '%병원 예약%'
           OR content ILIKE '%안경%' OR content ILIKE '%허리가 좀 결려%'
           OR content ILIKE '%안녕 민지야%' OR content ILIKE '%오늘 하루 잘 보냈니%')
    ORDER BY "createdAt" DESC
  `);
  for (const row of r.rows) {
    console.log(`"${row.content}"\n  note: ${row.analysisNote}\n`);
  }
  client.release();
  await pool.end();
}
main().catch(console.error);
