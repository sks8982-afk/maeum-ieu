# RAG 도입 가이드 (마음이음)

RAG(Retrieval Augmented Generation)를 도입하면 **과거 대화**를 검색해서 현재 답변에 맥락으로 넣을 수 있습니다.  
아래 순서대로 적용하면 됩니다.

---

## 1. 필요한 것 요약

| 항목 | 설명 |
|------|------|
| **PostgreSQL** | 이미 사용 중. **pgvector** 확장만 추가하면 됨. |
| **pgvector** | PostgreSQL 확장. 벡터 타입·유사도 검색 지원. |
| **임베딩** | Gemini Text Embedding API로 문장을 벡터로 변환. (동일 `GEMINI_API_KEY` 사용) |
| **저장** | 대화 메시지 저장 시 해당 메시지 내용을 임베딩해서 벡터 테이블에 저장. |
| **검색** | 사용자가 말할 때, 그 말을 임베딩해서 “유사한 과거 메시지”를 검색 → `memories`로 프롬프트에 삽입. |

---

## 2. 단계별 작업

### 2-1. pgvector 확장 켜기

PostgreSQL에서 한 번만 실행:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

- 로컬: `psql` 또는 DBeaver 등에서 실행.
- AWS RDS: RDS 파라미터 그룹에서 해당 DB에 pgvector를 허용한 뒤, 위 SQL 실행.

### 2-2. 임베딩 저장용 테이블 만들기

Prisma는 `vector` 타입을 아직 공식 지원하지 않으므로, **마이그레이션 SQL로 직접** 테이블을 만듭니다.

- 테이블: `message_embeddings`
- 컬럼: `id`, `user_id`, `message_id`, `content_text`, `embedding vector(768)`, `created_at`
- 인덱스: `embedding` 컬럼에 HNSW 인덱스 (코사인 유사도 검색용)

이 프로젝트에서는 `prisma/migrations/..._add_message_embeddings.sql` 같은 **수동 마이그레이션**으로 추가합니다. (아래 구현에서 파일 생성)

### 2-3. 임베딩 생성 (Gemini API)

- **역할**: 문장(텍스트) → 숫자 벡터 배열로 변환.
- **API**: Gemini Text Embedding (`text-embedding-004` 등). 채팅과 동일한 `GEMINI_API_KEY` 사용.
- **호출 시점**
  - **저장**: 메시지를 DB에 저장할 때, 그 메시지 `content`를 임베딩해서 `message_embeddings` 테이블에 저장.
  - **검색**: 사용자가 보낸 **현재 메시지(쿼리)**를 임베딩해서, 유사한 과거 메시지를 찾을 때 사용.

구현은 `lib/embedding.ts`에서 수행합니다.

### 2-4. RAG 검색·저장 로직

- **검색** `searchMemories(userId, queryText, limit)`  
  - `queryText`를 임베딩 → 해당 사용자(`userId`)의 `message_embeddings` 중에서 **코사인 유사도**로 정렬해 상위 `limit`개 조회.  
  - 조회된 행의 `content_text`(또는 원본 메시지 요약)를 이어서 문자열로 반환 → 이게 `memories`.
- **저장** `saveMessageEmbedding(userId, messageId, contentText)`  
  - 메시지 저장 후 호출. `contentText`를 임베딩해서 `message_embeddings`에 insert.

구현은 `lib/rag.ts`에서 수행합니다.

### 2-5. 채팅 API에 연결

- **요청 시**:  
  - 사용자 메시지(마지막 한 줄 또는 마지막 턴)를 `queryText`로 해서 `searchMemories(session.user.id, queryText, 5)` 호출.  
  - 반환된 문자열을 `memories`에 넣어 기존처럼 프롬프트에 포함.
- **응답 후**:  
  - 새로 저장한 user 메시지·assistant 메시지 각각에 대해 `saveMessageEmbedding(...)` 호출.  
  - (선택) 기존 대화가 많을 경우, 최근 N개만 임베딩하거나, 배치로 돌리도록 제한할 수 있음.

---

## 3. 구현 후 동작 흐름

1. 사용자가 채팅에서 메시지 전송.
2. **RAG 검색**: 해당 메시지로 `searchMemories` → 과거 유사 대화 문자열 `memories` 생성.
3. 기존대로 `systemPrompt + memories + 대화 내역`으로 Gemini에 요청 → 답변 생성.
4. 답변 후 DB에 user/assistant 메시지 저장.
5. **RAG 저장**: 방금 저장한 메시지 내용으로 `saveMessageEmbedding` 호출 → `message_embeddings`에 벡터 저장.

이후 같은 사용자가 비슷한 말을 하면, 위 2번에서 그 과거 메시지가 검색되어 맥락으로 쓰입니다.

---

## 4. 주의사항

- **토큰/비용**: 임베딩 API 호출 횟수가 늘어나므로, 필요 시 “메시지 저장 시 임베딩”을 최근 N개로 제한하거나, 길이 제한(예: 500자)을 둘 수 있음.
- **pgvector 버전**: PostgreSQL 11+ 에서 pgvector 사용 가능. RDS면 pgvector 지원 버전인지 확인.
- **Prisma**: `message_embeddings`는 raw SQL로 조회·저장하므로, Prisma 스키마에는 넣지 않고 마이그레이션만 관리해도 됨. (나중에 Prisma가 vector를 지원하면 스키마로 옮길 수 있음.)

---

## 5. 파일 구성 (구현됨)

| 파일 | 역할 |
|------|------|
| `prisma/migrations/20250312000000_add_message_embeddings/migration.sql` | pgvector 확장 + `message_embeddings` 테이블·인덱스 |
| `lib/embedding.ts` | Gemini로 텍스트 → 벡터 (embedText) |
| `lib/rag.ts` | searchMemories, saveMessageEmbedding (raw SQL 사용) |
| `app/api/chat/route.ts` | RAG 검색 호출 + 메시지 저장 후 임베딩 저장 |

**적용:** `npx prisma migrate deploy` 또는 migration.sql을 DB에서 직접 실행. 동일 `GEMINI_API_KEY` 사용. RAG 실패 시에도 채팅은 동작하며 콘솔에 로그만 남습니다.
