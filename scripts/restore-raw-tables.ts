/**
 * prisma db push로 drop된 raw SQL 테이블 복구
 * - message_embeddings (pgvector)
 * - cognitive_assessments
 * - conversation_summary (계층적 요약 weekly→monthly→yearly)
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
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS message_embeddings (
        id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id       TEXT NOT NULL,
        message_id    TEXT NOT NULL,
        content_text  TEXT NOT NULL,
        embedding     vector(768) NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS message_embeddings_user_embedding_idx
        ON message_embeddings USING hnsw (embedding vector_cosine_ops)
        WHERE user_id IS NOT NULL`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS message_embeddings_user_id_idx ON message_embeddings (user_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cognitive_assessments (
        id               TEXT PRIMARY KEY,
        user_id          TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
        message_id       TEXT REFERENCES "Message"(id) ON DELETE SET NULL,
        conversation_id  TEXT REFERENCES "Conversation"(id) ON DELETE SET NULL,
        domain           TEXT NOT NULL,
        score            INTEGER NOT NULL DEFAULT 0,
        confidence       DOUBLE PRECISION DEFAULT 0.5,
        evidence         TEXT,
        note             TEXT,
        session_date     DATE NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ca_user_date ON cognitive_assessments(user_id, session_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ca_domain ON cognitive_assessments(user_id, domain)`);

    // 계층적 요약 테이블 — lib/chat/summarizer.ts의 INSERT/SELECT 컬럼과 동일해야 함
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversation_summary (
        id              TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
        conversation_id TEXT,
        period_start    TIMESTAMPTZ NOT NULL,
        period_end      TIMESTAMPTZ NOT NULL,
        summary         TEXT NOT NULL,
        key_facts       TEXT,
        message_count   INTEGER NOT NULL DEFAULT 0,
        level           TEXT NOT NULL DEFAULT 'weekly',
        parent_id       TEXT,
        is_active       BOOLEAN NOT NULL DEFAULT true,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cs_user_level ON conversation_summary(user_id, level, is_active, period_end DESC)`);

    // T3 정신건강 검진 (스키마는 scripts/ops-create-mental-tables.ts와 동일해야 함)
    await client.query(`
      CREATE TABLE IF NOT EXISTS mental_session (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        scale TEXT NOT NULL DEFAULT 'PHQ9', status TEXT NOT NULL DEFAULT 'active',
        current_item INTEGER NOT NULL DEFAULT 0, retry_used BOOLEAN NOT NULL DEFAULT false,
        total INTEGER, severity TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ms_user_status ON mental_session(user_id, status, updated_at DESC)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS mental_assessments (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES mental_session(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL, item_no INTEGER NOT NULL, score INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT mental_assessments_session_item_key UNIQUE (session_id, item_no)
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ma_user ON mental_assessments(user_id, created_at DESC)`);
    await client.query(`ALTER TABLE mental_session ADD COLUMN IF NOT EXISTS crisis BOOLEAN NOT NULL DEFAULT false`);

    // 전문가 열람 감사 로그
    await client.query(`
      CREATE TABLE IF NOT EXISTS expert_access_log (
        id TEXT PRIMARY KEY, expert_user_id TEXT NOT NULL, patient_user_id TEXT NOT NULL,
        action TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_eal_expert ON expert_access_log(expert_user_id, created_at DESC)`);

    console.log("✓ message_embeddings + cognitive_assessments + conversation_summary 복구 완료");
    const emb = await client.query(`SELECT COUNT(*) FROM message_embeddings`);
    const cog = await client.query(`SELECT COUNT(*) FROM cognitive_assessments`);
    const cs = await client.query(`SELECT COUNT(*) FROM conversation_summary`);
    console.log(`  message_embeddings rows: ${emb.rows[0].count} (이전 1438건은 재생성 필요)`);
    console.log(`  cognitive_assessments rows: ${cog.rows[0].count} (이전 117건은 복구 불가)`);
    console.log(`  conversation_summary rows: ${cs.rows[0].count} (drop됐다면 backfill-summary.ts로 재생성)`);
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
