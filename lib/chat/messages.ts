/** DB 메시지 저장 */

import { prisma } from "@/lib/prisma";
import { saveMessageEmbedding } from "@/lib/rag";
import { getNowKst, toKstDateString } from "./time";
import type { CognitiveCheck } from "./types";

/** 인지 평가 결과를 cognitive_assessments 테이블에 저장 */
export async function saveCognitiveAssessments(
  userId: string,
  messageId: string,
  conversationId: string,
  checks: CognitiveCheck[],
): Promise<void> {
  if (checks.length === 0) return;
  const sessionDate = toKstDateString(new Date());
  for (const check of checks) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO cognitive_assessments (id, user_id, message_id, conversation_id, domain, score, confidence, evidence, note, session_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, NOW())`,
      `ca_${messageId}_${check.domain}_${Date.now()}`,
      userId, messageId, conversationId,
      check.domain, check.score, check.confidence, check.evidence, check.note, sessionDate,
    );
  }
}

/** 사용자 + AI 메시지 저장 */
export async function saveMessages(params: {
  conversationId: string;
  userId: string;
  userContent: string;
  assistantContent: string;
}): Promise<{ userMsgId: string; assistantMsgId: string }> {
  const { conversationId, userId, userContent, assistantContent } = params;
  const nowKst = getNowKst();

  const userMsg = await prisma.message.create({
    data: { conversationId, role: "user", content: userContent, createdAt: nowKst },
  });
  const assistantMsg = await prisma.message.create({
    data: { conversationId, role: "assistant", content: assistantContent, createdAt: nowKst },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: nowKst },
  });

  // RAG 임베딩 (실패해도 무관)
  saveMessageEmbedding(userId, userMsg.id, userMsg.content).catch(() => {});
  saveMessageEmbedding(userId, assistantMsg.id, assistantMsg.content).catch(() => {});

  return { userMsgId: userMsg.id, assistantMsgId: assistantMsg.id };
}

/** 이상징후 발견 시 Message에 마킹 */
export async function markAnomaly(messageId: string, analysisNote: string): Promise<void> {
  await prisma.message.update({
    where: { id: messageId },
    data: { isAnomaly: true, analysisNote },
  });
}

/** AI 인사 메시지만 저장 */
export async function saveGreetingMessage(conversationId: string, text: string): Promise<void> {
  const nowKst = getNowKst();
  await prisma.message.create({
    data: { conversationId, role: "assistant", content: text, createdAt: nowKst },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: nowKst },
  });
}
