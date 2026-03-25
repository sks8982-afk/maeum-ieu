import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { GoogleGenerativeAI, type Part } from "@google/generative-ai";
import { authOptions } from "@/lib/auth";
import { searchMemories } from "@/lib/rag";
import type { ChatRequestBody } from "@/lib/chat/types";
import { getTimeContext, getCurrentKstDateTimeString, isDateTimeQuestion } from "@/lib/chat/time";
import { getWeatherContext } from "@/lib/chat/weather";
import { buildSystemPrompt } from "@/lib/chat/prompt";
import { saveMessages, saveGreetingMessage, saveCognitiveAssessments, markAnomaly } from "@/lib/chat/messages";
import { analyzeCognitive } from "@/lib/chat/cognitive-analyzer";

// ─── Gemini 모델 ────────────────────────────────────────────────────────────

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY가 설정되지 않았습니다.");
  return key;
}

/** 텍스트 응답용 (googleSearch O, JSON 강제 X) */
function getTextModel(systemInstruction: string) {
  return new GoogleGenerativeAI(getApiKey()).getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction,
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
    // @ts-expect-error -- googleSearch SDK 타입 미반영
    tools: [{ googleSearch: {} }],
  });
}

/** 음성 JSON용 (googleSearch X, JSON 강제 O) */
function getJsonModel(systemInstruction: string) {
  return new GoogleGenerativeAI(getApiKey()).getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction,
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048, responseMimeType: "application/json" },
  });
}

// ─── 공통 유틸 ──────────────────────────────────────────────────────────────

function buildHistoryText(messages: { role: string; content: string }[]): string {
  return messages.map((m) => `${m.role === "user" ? "사용자" : "AI"}: ${m.content}`).join("\n");
}

async function fetchMemories(userId: string, query: string): Promise<string> {
  try { return await searchMemories(userId, query, 5); }
  catch { return ""; }
}

function toSafeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : "";
  const isQuota = /429|Too Many|quota|Quota exceeded|rate|GoogleGenerativeAI/.test(raw);
  return isQuota ? "오늘은 사용할 수 없습니다. 잠시 후 다시 시도해 주세요." : "답변 생성 중 오류가 발생했습니다.";
}

/** 인지 분석 실행 후 DB에 저장 (실패해도 대화에 영향 없음) */
async function runCognitiveAnalysis(params: {
  userId: string;
  conversationId: string;
  assistantMsgId: string;
  userMessage: string;
  assistantResponse: string;
  historyText: string;
  envBlock: string;
}): Promise<void> {
  const { userId, conversationId, assistantMsgId, userMessage, assistantResponse, historyText, envBlock } = params;
  try {
    const analysis = await analyzeCognitive({ userMessage, assistantResponse, historyText, envBlock });

    if (analysis.cognitiveChecks.length > 0) {
      await saveCognitiveAssessments(userId, assistantMsgId, conversationId, analysis.cognitiveChecks);
    }
    if (analysis.isAnomaly && analysis.analysisNote) {
      await markAnomaly(assistantMsgId, analysis.analysisNote);
    }
  } catch (e) {
    console.warn("Cognitive analysis failed:", e);
  }
}

// ─── 핸들러 ─────────────────────────────────────────────────────────────────

/** 1) 최초 인사 */
async function handleFirstGreeting(systemPrompt: string, userName: string, honorific: string, conversationId?: string) {
  const model = getTextModel(systemPrompt);
  const res = await model.generateContent(
    `지금 ${userName}님이 대화를 시작합니다. 손녀 '민지'로서 ${honorific}을 부르며 시간대에 맞는 인사 한 마디만 짧게 해주세요. (본인 소개 포함)`,
  );
  const text = res.response.text();
  if (conversationId) await saveGreetingMessage(conversationId, text);
  return NextResponse.json({ text, role: "assistant" });
}

/** 2) 재접속 인사 */
async function handleReturningGreeting(systemPrompt: string, userName: string, honorific: string, conversationId?: string) {
  const model = getTextModel(systemPrompt);
  const res = await model.generateContent(
    `${userName}(${honorific})님이 다시 돌아왔습니다. 자기소개 반복하지 말고, "다시 와주셨네요" 스타일로 따뜻하게 반겨주세요. 시간대에 맞는 질문 하나 포함. 2~3문장.`,
  );
  const text = res.response.text();
  if (conversationId) await saveGreetingMessage(conversationId, text);
  return NextResponse.json({ text, role: "assistant" });
}

/** 3) 날짜/시간 질문 직접 응답 */
async function handleDateTimeQuestion(userMessage: string, honorific: string, conversationId: string | undefined, userId: string, clientTimeIso?: string) {
  const timeStr = getCurrentKstDateTimeString(clientTimeIso);
  const replyText = `${honorific}님, 지금은 한국 시각으로 ${timeStr}이에요.`;
  if (conversationId) {
    await saveMessages({ conversationId, userId, userContent: userMessage, assistantContent: replyText });
  }
  return NextResponse.json({ text: replyText, role: "assistant" });
}

/** 4) 음성 요청 (JSON 모델) */
async function handleAudioMessage(params: {
  systemPrompt: string; envBlock: string; honorific: string; userName: string;
  userId: string; conversationId?: string;
  audioData: string; audioMimeType: string; historyText: string; memories: string;
}) {
  const { systemPrompt, envBlock, honorific, userName, userId, conversationId, audioData, audioMimeType, historyText, memories } = params;
  const model = getJsonModel(systemPrompt);

  const parts: Part[] = [];
  if (historyText || memories) {
    parts.push({ text: [memories ? `과거 맥락:\n${memories}\n` : "", historyText ? `대화 내역:\n${historyText}\n` : ""].filter(Boolean).join("\n") });
  }
  parts.push({
    text: `음성은 ${honorific} ${userName}님의 말씀입니다. 손녀 '민지'로서 따뜻하게 대답하세요.
JSON: {"transcription": "받아쓰기", "text": "대답 2~3문장"}`,
  });
  parts.push({ inlineData: { mimeType: audioMimeType, data: audioData } });

  const res = await model.generateContent({ contents: [{ role: "user", parts }] });
  const raw = res.response.text().trim();

  let transcription = "";
  let answerText = raw;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.transcription === "string") transcription = parsed.transcription;
    if (typeof parsed.text === "string") answerText = parsed.text;
  } catch { /* raw text fallback */ }

  if (conversationId) {
    const { assistantMsgId } = await saveMessages({
      conversationId, userId,
      userContent: transcription || "(음성 메시지)",
      assistantContent: answerText,
    });
    // 인지 분석 (await — 완료 후 응답)
    await runCognitiveAnalysis({ userId, conversationId, assistantMsgId, userMessage: transcription, assistantResponse: answerText, historyText, envBlock });
  }

  return NextResponse.json({ text: answerText, transcription, role: "assistant" });
}

/** 5) 텍스트 요청 (텍스트 모델 — 순수 텍스트 응답) */
async function handleTextMessage(params: {
  systemPrompt: string; envBlock: string;
  userId: string; conversationId?: string;
  userContent: string; historyText: string; memories: string;
}) {
  const { systemPrompt, envBlock, userId, conversationId, userContent, historyText, memories } = params;
  const model = getTextModel(systemPrompt);

  const prompt = `${memories ? `과거 맥락:\n${memories}\n` : ""}
대화 내역:
${historyText}

사용자가 이미 답한 내용은 다시 묻지 말고 아직 안 물어본 주제로 질문하세요.`;

  const res = await model.generateContent(prompt);
  const text = res.response.text().trim();

  if (conversationId && userContent) {
    const { assistantMsgId } = await saveMessages({ conversationId, userId, userContent, assistantContent: text });
    // 인지 분석 (await — 완료 후 응답)
    await runCognitiveAnalysis({ userId, conversationId, assistantMsgId, userMessage: userContent, assistantResponse: text, historyText, envBlock });
  }

  return NextResponse.json({ text, role: "assistant" });
}

// ─── POST ───────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  try {
    const body = (await req.json()) as ChatRequestBody;
    const { messages, conversationId, isInitialGreeting, isReturningGreeting, audio, context: ctx } = body;
    const userId = session.user.id;

    const timeCtx = getTimeContext(ctx?.currentTime);
    const weatherCtx = await getWeatherContext(ctx?.latitude, ctx?.longitude);
    const { systemPrompt, envBlock, userName, honorific } = await buildSystemPrompt({
      userId, conversationId, timeCtx, weather: weatherCtx,
    });

    if (isInitialGreeting) return handleFirstGreeting(systemPrompt, userName, honorific, conversationId);
    if (isReturningGreeting) return handleReturningGreeting(systemPrompt, userName, honorific, conversationId);

    const lastUserMessage = messages?.filter((m) => m.role === "user").pop()?.content ?? "";
    const [memories, historyText] = await Promise.all([
      fetchMemories(userId, lastUserMessage),
      Promise.resolve(buildHistoryText(messages ?? [])),
    ]);

    if (!audio?.data && lastUserMessage && isDateTimeQuestion(lastUserMessage)) {
      return handleDateTimeQuestion(lastUserMessage, honorific, conversationId, userId, ctx?.currentTime);
    }

    if (audio?.data && audio?.mimeType) {
      return handleAudioMessage({
        systemPrompt, envBlock, honorific, userName, userId, conversationId,
        audioData: audio.data, audioMimeType: audio.mimeType, historyText, memories,
      });
    }

    return handleTextMessage({ systemPrompt, envBlock, userId, conversationId, userContent: lastUserMessage, historyText, memories });
  } catch (e) {
    console.error("chat api error", e);
    return NextResponse.json({ error: toSafeError(e) }, { status: 500 });
  }
}
