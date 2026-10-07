/** abc/rudtjrch 계정 존재 + 해시 형식 확인용 일회성 헬퍼 */
import "dotenv/config";
const { Pool } = require("pg");
import { pgTlsOptions } from "../../lib/db-tls";

async function main() {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();
  try {
    const r = await c.query(`SELECT email, LEFT(password, 4) AS pw_prefix, LENGTH(password) AS pw_len, name, age, gender FROM "User" WHERE email IN ('abc@abc.com','rudtjrch@naver.com')`);
    console.log(r.rows);
  } finally { c.release(); await pool.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
