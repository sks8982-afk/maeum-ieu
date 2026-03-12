# 마음이음

AI와 대화하며 일상·상태를 함께 살펴보는 서비스입니다.  
(식사 여부, 일상 질문 등을 통해 참고 수준으로 상태를 살펴봅니다. 의료 진단·처방이 아닙니다.)

## 기술 스택

- **프론트/백엔드**: Next.js 16 (App Router)
- **DB**: PostgreSQL (로컬 또는 AWS RDS + pgvector 예정)
- **인증**: NextAuth (Credentials + Prisma)
- **AI**: Google Gemini (채팅). 같은 대화 내 맥락은 메시지로 전달, RAG(pgvector)는 예정.
- **스토리지**: AWS S3 예정 (가족 목소리 파일 등)

상세 기술 현황·RAG·목소리 학습 설계는 [docs/PLAN.md](docs/PLAN.md) 참고.

## 로컬 실행

### 1. 환경 변수

`.env.example`을 복사해 `.env`를 만들고 값을 채웁니다.

```bash
cp .env.example .env
```

필수:

- `DATABASE_URL`: PostgreSQL 연결 문자열
- `NEXTAUTH_URL`: `http://localhost:3000`
- `NEXTAUTH_SECRET`: 랜덤 시크릿 (예: `openssl rand -base64 32`)
- `GEMINI_API_KEY`: Google AI Studio에서 발급

### 2. DB 마이그레이션

```bash
npm install
npx prisma generate
npx prisma db push
```

### 3. 개발 서버

```bash
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000) 접속 후 회원가입 → 로그인 → **채팅** 페이지에서 AI와 대화할 수 있습니다.

## 주요 기능 (현재)

- 회원가입 / 로그인 (이메일·비밀번호)
- 채팅 페이지: AI가 먼저 인사 (예: "안녕하세요, ○○님의 AI 손녀 민지예요")
- 대화 시작하기 버튼 → 마이크 허용 → 음성 파형 시각화
- AI 답변 시 출렁이는 파형 애니메이션
- 사용자별 대화 저장 (Conversation / Message)

## 다음 단계 예정

- RAG: pgvector로 과거 대화 검색 후 맥락 반영 (현재는 같은 대화 내 메시지만 사용, 반복 질문 방지 지시 적용됨)
- 사용자 목소리 등록: 회원가입 시 본인 목소리 학습 → 대화 시 “사용자 vs 타인” 구분 (잘못된 진단 방지)
- 음성 출력 (TTS): 가족 목소리 대체 시, 회원가입/설정에서 가족 목소리 등록
- AWS RDS, S3 연동
