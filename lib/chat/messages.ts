/** DB 메시지 저장 및 이상징후/인지 평가 기록 */

import { prisma } from "@/lib/prisma";
import { saveMessageEmbedding } from "@/lib/rag";
import { getNowKst, toKstDateString } from "./time";
import type { CognitiveCheck } from "./types";

interface SavedMessage {
  id: string;
  content: string;
}

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
    const id = `ca_${messageId}_${check.domain}_${Date.now()}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO cognitive_assessments (id, user_id, message_id, conversation_id, domain, score, confidence, evidence, note, session_date, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, NOW())`,
      id,
      userId,
      messageId,
      conversationId,
      check.domain,
      check.score,
      check.confidence,
      check.evidence,
      check.note,
      sessionDate,
    );
  }
}

/** 사용자 + AI 메시지를 DB에 저장하고 RAG 임베딩 + 인지 평가도 처리 */
export async function saveMessages(params: {
  conversationId: string;
  userId: string;
  userContent: string;
  assistantContent: string;
  isAnomaly: boolean;
  analysisNote: string | null;
  cognitiveChecks?: CognitiveCheck[];
}): Promise<{ userMsg: SavedMessage; assistantMsg: SavedMessage }> {
  const { conversationId, userId, userContent, assistantContent, isAnomaly, analysisNote, cognitiveChecks = [] } = params;
  const nowKst = getNowKst();

  const userMsg = await prisma.message.create({
    data: { conversationId, role: "user", content: userContent, createdAt: nowKst },
  });

  const assistantMsg = await prisma.message.create({
    data: {
      conversationId,
      role: "assistant",
      content: assistantContent,
      isAnomaly,
      analysisNote,
      createdAt: nowKst,
    },
  });

  // 기존 HealthLog (isAnomaly 기반)
  if (isAnomaly && analysisNote) {
    await prisma.healthLog.create({
      data: {
        userId,
        conversationId,
        type: "cognitive",
        value: "인지 오류 감지",
        note: analysisNote,
      },
    });
  }

  // 새로운 인지 평가 저장
  if (cognitiveChecks.length > 0) {
    saveCognitiveAssessments(userId, assistantMsg.id, conversationId, cognitiveChecks).catch((e) =>
      console.warn("Cognitive assessment save failed:", e),
    );
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: nowKst },
  });

  // RAG 임베딩 비동기 저장 (실패해도 채팅에 영향 없음)
  saveMessageEmbedding(userId, userMsg.id, userMsg.content).catch((e) =>
    console.warn("RAG embed (user) failed:", e),
  );
  saveMessageEmbedding(userId, assistantMsg.id, assistantMsg.content).catch((e) =>
    console.warn("RAG embed (assistant) failed:", e),
  );

  return { userMsg, assistantMsg };
}

/** AI 인사 메시지만 저장 (초기 인사용) */
export async function saveGreetingMessage(conversationId: string, text: string): Promise<void> {
  const nowKst = getNowKst();
  await prisma.message.createMany({
    data: [{ conversationId, role: "assistant", content: text, createdAt: nowKst }],
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { updatedAt: nowKst },
  });
}
