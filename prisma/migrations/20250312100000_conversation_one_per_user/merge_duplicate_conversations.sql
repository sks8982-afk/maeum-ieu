-- 중복 대화 합치기: 사용자당 "가장 오래된 대화 1개"만 남기고, 나머지 대화의 메시지를 그쪽으로 옮긴 뒤 빈 대화 삭제
-- 실행 순서: 1) 이 파일 실행 → 2) migration.sql (CREATE UNIQUE INDEX) 실행

BEGIN;

-- 유지할 대화 (userId당 createdAt이 가장 빠른 것 하나)
CREATE TEMP TABLE keep AS
SELECT DISTINCT ON ("userId") id, "userId"
FROM "Conversation"
ORDER BY "userId", "createdAt" ASC;

-- 1) 삭제될 대화에 속한 메시지들을, 같은 사용자의 "유지 대화"로 이동
UPDATE "Message" m
SET "conversationId" = k.id
FROM "Conversation" c
JOIN keep k ON k."userId" = c."userId" AND k.id <> c.id
WHERE m."conversationId" = c.id;

-- 2) 유지하지 않을 대화 삭제 (메시지는 위에서 이미 옮김)
DELETE FROM "Conversation"
WHERE id NOT IN (SELECT id FROM keep);

COMMIT;
