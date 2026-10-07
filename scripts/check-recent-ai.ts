import "dotenv/config";
import { Pool } from "pg";
import { pgTlsOptions } from "../lib/db-tls";
async function main() {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();
  try {
    const r = await c.query(`
      SELECT role, content, "createdAt"
      FROM "Message"
      ORDER BY "createdAt" DESC
      LIMIT 40
    `);
    for (const row of r.rows.reverse()) {
      const flag = /[a-zA-Z]{10,}/.test(row.content) ? "⚠️" : "  ";
      console.log(`${flag} [${row.role}] ${row.content.slice(0, 200).replace(/\n/g, "\\n")}`);
    }
  } finally {
    c.release(); await pool.end();
  }
}
main().catch(console.error);
