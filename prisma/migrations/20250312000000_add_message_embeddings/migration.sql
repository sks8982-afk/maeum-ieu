-- Enable pgvector extension (required for vector type)
CREATE EXTENSION IF NOT EXISTS vector;

-- Table for storing message embeddings (RAG). Prisma does not manage this table.
-- Use raw SQL in lib/rag.ts for insert/select.
CREATE TABLE IF NOT EXISTS message_embeddings (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id        TEXT NOT NULL,
  message_id     TEXT NOT NULL,
  content_text   TEXT NOT NULL,
  embedding      vector(768) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast similarity search by user + embedding (cosine distance)
CREATE INDEX IF NOT EXISTS message_embeddings_user_embedding_idx
  ON message_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WHERE user_id IS NOT NULL;

-- Index to filter by user_id first (optional, for very large tables)
CREATE INDEX IF NOT EXISTS message_embeddings_user_id_idx ON message_embeddings (user_id);
