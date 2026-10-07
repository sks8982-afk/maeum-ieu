/**
 * 복약 준수 기록 테이블 생성 (medication_log).
 * ⚠️ prisma db push 금지 — 수동 SQL. 멱등(IF NOT EXISTS). 복용 확인/건너뜀만 저장.
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
    await client.query(`
      CREATE TABLE IF NOT EXISTS medication_log (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        schedule_id TEXT NOT NULL,              -- MedicationSchedule.id (FK 생략: 스케줄 삭제돼도 이력 보존)
        dose_time   TEXT NOT NULL,              -- 'HH:MM'
        taken_date  DATE NOT NULL,              -- KST 기준 복용 일자
        status      TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed | skipped
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT medication_log_unique UNIQUE (user_id, schedule_id, taken_date, dose_time)
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_medlog_user_date ON medication_log(user_id, taken_date DESC)`);
    console.log("✓ medication_log 생성 완료");
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
