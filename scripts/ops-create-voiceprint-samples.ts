/**
 * 화자 성문 개별 표본 테이블 (speaker_voiceprint_sample) — 지문 다회 등록처럼 표본을 누적.
 * ⚠️ prisma db push 금지 — 수동 SQL. 멱등.
 * speaker_voiceprint(대표 성문 = 표본 평균)은 그대로 두고, 여기에 개별 표본(임베딩)을 쌓는다.
 * 원음성 미저장 — 벡터만.
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
      CREATE TABLE IF NOT EXISTS speaker_voiceprint_sample (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        embedding   JSONB NOT NULL,             -- 256차원 float(정규화됨). 원음성 미저장.
        sample_secs REAL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_vpsample_user ON speaker_voiceprint_sample(user_id, created_at)`);
    // 대표 성문 테이블에 표본 개수 컬럼 추가(멱등)
    await client.query(`ALTER TABLE speaker_voiceprint ADD COLUMN IF NOT EXISTS sample_count INTEGER NOT NULL DEFAULT 1`);
    console.log("✓ speaker_voiceprint_sample 생성 + sample_count 컬럼 추가 완료");
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
