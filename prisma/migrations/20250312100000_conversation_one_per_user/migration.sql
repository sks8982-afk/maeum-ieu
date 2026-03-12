-- 사용자당 대화 1개만 허용 (userId unique)
-- 참고: 이미 같은 userId로 여러 대화가 있으면 unique 추가 전에 수동으로 하나만 남기고 나머지 정리한 뒤 실행하세요.
CREATE UNIQUE INDEX IF NOT EXISTS "Conversation_userId_key" ON "Conversation"("userId");
