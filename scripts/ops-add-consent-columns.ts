/**
 * User에 건강정보 동의 컬럼 추가 (consentedAt, consentVersion).
 * ⚠️ prisma db push 금지 — 수동 ALTER(멱등 IF NOT EXISTS). 실행 후 schema.prisma 갱신 + prisma generate.
 */
import "dotenv/config";
import { Pool } from "pg";
import { pgTlsOptions } from "../lib/db-tls";
async function main() {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const client = await pool.connect();
  try {
    await client.query(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "consentedAt" TIMESTAMPTZ`);
    await client.query(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "consentVersion" TEXT`);
    console.log("✓ User.consentedAt + consentVersion 추가 완료");
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
