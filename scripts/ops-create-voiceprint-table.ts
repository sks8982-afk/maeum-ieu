/**
 * 화자 성문(voiceprint) 테이블 생성 (speaker_voiceprint).
 * ⚠️ prisma db push 금지 — 수동 SQL. 멱등(IF NOT EXISTS).
 * 관찰자 모드 화자식별용: 사용자(환자)별 음성 임베딩 1개(등록 시 갱신). 원음성은 저장 안 함 — 벡터만.
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
      CREATE TABLE IF NOT EXISTS speaker_voiceprint (
        user_id     TEXT PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE,
        embedding   JSONB NOT NULL,             -- 256차원 float 배열(성문). 원음성 미저장.
        dim         INTEGER NOT NULL,
        model       TEXT NOT NULL,              -- 임베딩 모델 식별자(재등록·모델교체 추적)
        sample_secs REAL,                       -- 등록에 쓴 음성 길이(초) — 품질 참고
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    console.log("✓ speaker_voiceprint 생성 완료");
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
