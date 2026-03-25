# DB 현황 분석 (2026-03-25 기준)

## 테이블 요약

| 테이블 | 레코드 수 | 상태 |
|--------|-----------|------|
| User | 3 | 정상 |
| Account | 0 | OAuth 미사용 (Credentials 방식) |
| Session | 0 | JWT 방식이라 DB 세션 불필요 |
| VerificationToken | 0 | 이메일 인증 미사용 |
| Conversation | 2 | 사용자당 1개씩 |
| Message | 17 | 대화 기록 |
| HealthLog | 0 | 인지 오류 감지된 적 없음 |
| message_embeddings | 12 | RAG 임베딩 저장됨 |

---

## User (3명)

| id | name | email | age | gender |
|----|------|-------|-----|--------|
| cmmbcfgj1... | sks8982 | rudtjrch@naver.com | null | null |
| cmmbkkov5... | 김대래 | test@test.com | 60 | male |
| cmmcom8ci... | 김종우 | jongwoo@firstcorea.com | null | male |

**참고사항:**
- `sks8982` 사용자는 age/gender가 null → 호칭이 "회원님"으로 표시됨
- `김대래`만 age=60, gender=male → "할아버지" 호칭 적용
- `김종우`는 age=null → gender만 있어도 호칭 판단 불가

---

## Conversation (2개)

| 사용자 | conversation_id | 마지막 활동 |
|--------|----------------|------------|
| 김대래 (test@test.com) | cmmolsxhe... | 2026-03-24 05:36:41 |
| sks8982 (rudtjrch@naver.com) | cmmn2n4pl... | 2026-03-24 05:50:06 |

---

## Message (17건)

대부분 `sks8982` 사용자의 대화. 주요 내용:
- 자기소개 ("내이름은 김대래야")
- 일상 대화 ("오후에는 운동을 할 계획이야", "산책", "안녕하세요")
- AI 응답은 식사/산책 위주 질문

**isAnomaly**: 모든 메시지가 `false` → 인지 오류가 한 번도 감지되지 않음

---

## HealthLog (0건)

비어있음. isAnomaly가 한 번도 true가 된 적이 없으므로 정상.

---

## message_embeddings (12건)

`sks8982` 사용자의 메시지 12개가 768차원 벡터로 임베딩되어 저장됨.
RAG 검색/저장이 정상 작동하고 있음을 확인.

---

## 신규 테이블: cognitive_assessments

### 기존 테이블과 충돌 여부: **없음**

`cognitive_assessments`는 완전히 새로운 테이블이며, 기존 테이블과 이름이 겹치지 않음.

### 외래키 참조 관계

```
cognitive_assessments.user_id → User.id (CASCADE)
cognitive_assessments.message_id → Message.id (SET NULL)
cognitive_assessments.conversation_id → Conversation.id (SET NULL)
```

기존 User, Message, Conversation 테이블의 id 형식(cuid)과 호환됨.

### SQL 실행 완료 (2026-03-25)

테이블 및 인덱스 생성 완료.

```sql
-- 실행 완료
CREATE TABLE cognitive_assessments (...);
CREATE INDEX idx_ca_user_date ON cognitive_assessments(user_id, session_date);
CREATE INDEX idx_ca_domain ON cognitive_assessments(user_id, domain);
```

### 전체 테이블 구조 (최종)

```
User ──┬── Account
       ├── Session
       ├── Conversation ──── Message ──── message_embeddings (RAG)
       ├── HealthLog                  └── cognitive_assessments (인지 평가)
       └── cognitive_assessments
```
