/**
 * T3 정신건강 검진 테이블 생성 (mental_session + mental_assessments).
 * ⚠️ prisma db push 금지 — 수동 SQL. 멱등(IF NOT EXISTS). 응답 원문은 저장하지 않음(점수만).
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
      CREATE TABLE IF NOT EXISTS mental_session (
        id           TEXT PRIMARY KEY,
        user_id      TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        scale        TEXT NOT NULL DEFAULT 'PHQ9',
        status       TEXT NOT NULL DEFAULT 'active',  -- active | done | aborted
        current_item INTEGER NOT NULL DEFAULT 0,      -- 0=동의 대기, 1~9=진행 중 문항
        retry_used   BOOLEAN NOT NULL DEFAULT false,
        total        INTEGER,
        severity     TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ms_user_status ON mental_session(user_id, status, updated_at DESC)`);
    // 한 사용자당 active 세션 최대 1개 — 중단 직후 재시작 경합 시 중복 active 생성 차단(2026-06-17)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ms_user_active ON mental_session(user_id) WHERE status = 'active'`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS mental_assessments (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES mental_session(id) ON DELETE CASCADE,
        user_id    TEXT NOT NULL,
        item_no    INTEGER NOT NULL,
        score      INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT mental_assessments_session_item_key UNIQUE (session_id, item_no)
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ma_user ON mental_assessments(user_id, created_at DESC)`);
    console.log("✓ mental_session + mental_assessments 생성 완료");
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
