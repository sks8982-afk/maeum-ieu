/**
 * ExpertPatient 테이블 + User.expertCode 컬럼 수동 생성 (T1 다환자 관리, 2026-06-11).
 * ⚠️ prisma db push 금지(raw 테이블 drop 사고 이력) — 이 스크립트로 적용 후 `npx prisma generate`.
 * 멱등(IF NOT EXISTS) — 재실행 안전.
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
    await client.query(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "expertCode" TEXT`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS "User_expertCode_key" ON "User"("expertCode")`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "ExpertPatient" (
        "id"            TEXT PRIMARY KEY,
        "expertUserId"  TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        "patientUserId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        "status"        TEXT NOT NULL DEFAULT 'active',
        "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ExpertPatient_expertUserId_patientUserId_key" UNIQUE ("expertUserId", "patientUserId")
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS "ExpertPatient_expertUserId_idx" ON "ExpertPatient"("expertUserId")`);
    await client.query(`CREATE INDEX IF NOT EXISTS "ExpertPatient_patientUserId_idx" ON "ExpertPatient"("patientUserId")`);
    console.log("✓ User.expertCode + ExpertPatient 생성 완료");
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
