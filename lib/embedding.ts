/**
 * Gemini Text Embedding API로 텍스트를 벡터(임베딩)로 변환합니다.
 * RAG 검색·저장 시 사용. GEMINI_API_KEY 사용.
 */

const EMBEDDING_MODEL = "text-embedding-004";
const EMBEDDING_DIMENSION = 768;
const EMBED_API = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`;

export type TaskType = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";

interface EmbedResponse {
  embedding?: { values?: number[] };
}

/**
 * 단일 텍스트를 임베딩 벡터로 변환합니다.
 * @param text - 임베딩할 문장 (너무 길면 잘라서 사용 권장)
 * @param taskType - RETRIEVAL_QUERY(검색 쿼리용), RETRIEVAL_DOCUMENT(저장할 문서용)
 */
export async function embedText(
  text: string,
  taskType: TaskType = "RETRIEVAL_DOCUMENT",
  apiKey?: string
): Promise<number[]> {
  const key = apiKey ?? process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY가 설정되지 않았습니다.");

  const trimmed = text.trim().slice(0, 8000); // 임베딩 모델 토큰 제한 고려
  if (!trimmed) return new Array(EMBEDDING_DIMENSION).fill(0);

  const res = await fetch(`${EMBED_API}?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text: trimmed }] },
      taskType,
      outputDimensionality: EMBEDDING_DIMENSION,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding API error: ${res.status} ${err}`);
  }

  const data = (await res.json()) as EmbedResponse;
  const values = data.embedding?.values;
  if (!Array.isArray(values) || values.length < EMBEDDING_DIMENSION) {
    throw new Error("Invalid embedding response");
  }
  // 벡터 테이블이 vector(768)이므로 768개만 사용 (초과 시 잘라냄)
  return values.slice(0, EMBEDDING_DIMENSION);
}
