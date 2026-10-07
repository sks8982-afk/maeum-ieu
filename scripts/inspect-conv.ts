import "dotenv/config";
import { Pool } from "pg";
import { pgTlsOptions } from "../lib/db-tls";
async function main() {
  const convId = process.argv[2] || "cmnzeyeop000104jofjo0v49j";
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT role, content, "isAnomaly", "createdAt"
       FROM "Message"
       WHERE "conversationId" = $1
       ORDER BY "createdAt" ASC`,
      [convId]
    );
    console.log(`\n=== conv ${convId} (${r.rows.length}건) ===\n`);
    for (const row of r.rows) {
      const anom = row.isAnomaly ? "🔴" : "  ";
      const empty = !row.content?.trim() ? " ❗빈응답" : "";
      const ts = new Date(row.createdAt).toISOString().slice(11, 19);
      console.log(`${ts} ${anom} [${row.role}]${empty} ${row.content?.slice(0, 180) || "(empty)"}`);
    }
  } finally {
    c.release(); await pool.end();
  }
}
main().catch(console.error);
