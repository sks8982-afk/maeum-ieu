import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { GoogleGenerativeAI, type Part } from "@google/generative-ai";
import { authOptions } from "@/lib/auth";
import { searchMemories } from "@/lib/rag";
import type { ChatRequestBody } from "@/lib/chat/types";
import { getTimeContext, getCurrentKstDateTimeString, isDateTimeQuestion } from "@/lib/chat/time";
import { getWeatherContext } from "@/lib/chat/weather";
import { buildSystemPrompt } from "@/lib/chat/prompt";
import { parseGeminiResponse } from "@/lib/chat/parser";
import { saveMessages, saveGreetingMessage, saveCognitiveAssessments } from "@/lib/chat/messages";
import { analyzeCognitive } from "@/lib/chat/cognitive-analyzer";

// ─── helpers ────────────────────────────────────────────────────────────────

function getGeminiApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY가 설정되지 않았습니다.");
  return apiKey;
}

/** 일반 텍스트 응답용 모델 (인사, 텍스트 채팅) */
function getTextModel(systemInstruction: string) {
  return new GoogleGenerativeAI(getGeminiApiKey()).getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 300,
    },
    // @ts-expect-error -- googleSearch 도구는 REST API에서 지원하지만 SDK 타입에 아직 미반영
    tools: [{ googleSearch: {} }],
  });
}

/** JSON 응답 강제 모델 (음성 멀티모달 — transcription + isAnomaly 파싱 필요) */
function getJsonModel(systemInstruction: string) {
  return new GoogleGenerativeAI(getGeminiApiKey()).getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 300,
      responseMimeType: "application/json",
    },
    // @ts-expect-error -- googleSearch 도구는 REST API에서 지원하지만 SDK 타입에 아직 미반영
    tools: [{ googleSearch: {} }],
  });
}

function buildHistoryText(messages: { role: string; content: string }[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "사용자" : "AI"}: ${m.content}`)
    .join("\n");
}

async function fetchMemories(userId: string, query: string): Promise<string> {
  try {
    return await searchMemories(userId, query, 5);
  } catch (e) {
    console.warn("RAG searchMemories failed:", e);
    return "";
  }
}

function toSafeErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "답변 생성 중 오류가 발생했습니다.";
  const isQuota =
    raw.includes("429") ||
    raw.includes("Too Many Requests") ||
    raw.includes("quota") ||
    raw.includes("Quota exceeded") ||
    raw.includes("rate") ||
    raw.includes("GoogleGenerativeAI");
  return isQuota ? "오늘은 사용할 수 없습니다. 잠시 후 다시 시도해 주세요." : "답변 생성 중 오류가 발생했습니다.";
}

// ─── 요청 핸들러별 분리 ─────────────────────────────────────────────────────

/** 1) 초기 인사 */
async function handleGreeting(
  systemPrompt: string,
  userName: string,
  honorific: string,
  conversationId?: string,
) {
  const model = getTextModel(systemPrompt);
  const prompt = `지금 ${userName}님이 대화를 시작하려고 합니다. AI 가족 역할은 '손녀/손자'로 하고, 이름은 '민지'로 해주세요.
위 [사용자 정보]의 호칭(${honorific})으로 부르면서, [현재 환경 정보]를 반영해 현재 시각대에 맞는 구체적인 선제적 질문을 포함한 첫 인사 한 마디만 짧게 해주세요.
예: 할아버지/할머니에게 "아침 식사는 하셨나요?", "점심 드셨나요?", "오늘 날씨가 맑은데 산책 어떠세요?" 등. (본인 소개 포함)`;

  const res = await model.generateContent(prompt);
  const text = res.response.text();

  if (conversationId) {
    await saveGreetingMessage(conversationId, text);
  }
  return NextResponse.json({ text, role: "assistant" });
}

/** 2) 날짜/시간 질문 직접 응답 (Gemini 미호출) */
async function handleDateTimeQuestion(
  userMessage: string,
  honorific: string,
  conversationId: string | undefined,
  clientTimeIso?: string,
) {
  const timeStr = getCurrentKstDateTimeString(clientTimeIso);
  const replyText = `${honorific}님, 지금은 한국 시각으로 ${timeStr}이에요.`;

  if (conversationId) {
    await saveMessages({
      conversationId,
      userId: "", // 시간 응답에는 health log 불필요
      userContent: userMessage,
      assistantContent: replyText,
      isAnomaly: false,
      analysisNote: null,
    });
  }
  return NextResponse.json({ text: replyText, role: "assistant" });
}

/** 3) 음성(멀티모달) 요청 */
async function handleAudioMessage(params: {
  systemPrompt: string;
  honorific: string;
  userName: string;
  userId: string;
  conversationId?: string;
  audioData: string;
  audioMimeType: string;
  historyText: string;
  memories: string;
}) {
  const { systemPrompt, honorific, userName, userId, conversationId, audioData, audioMimeType, historyText, memories } = params;
  const model = getJsonModel(systemPrompt);

  const parts: Part[] = [];

  if (historyText || memories) {
    parts.push({
      text: [
        memories ? `과거 맥락 (이 사용자가 예전에 말한 내용):\n${memories}\n` : "",
        historyText ? `지금까지의 대화 내역:\n${historyText}\n` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  parts.push({
    text: `아래 음성은 ${honorific} ${userName}님이 방금 하신 말씀입니다. 음성을 듣고 상황을 이해한 뒤, 손녀 '민지'로서 ${honorific}을/를 부르며 따뜻하게 대답해 주세요.
${memories ? "[지시] 위 '과거 맥락'에 사용자가 예전에 말한 내용이 있으면, '기억나니?' 등으로 물어보면 그 내용을 활용해 답하세요.\n" : ""}[지시] 위 "지금까지의 대화 내역"에서 사용자가 이미 답한 내용(식사·수면·기분 등)은 다시 묻지 말고, 아직 안 물어본 주제로만 질문하세요.

JSON 응답 형식:
{
  "transcription": "사용자의 음성을 한국어로 정확하게 받아 적은 문장",
  "text": "transcription을 기반으로 한 당신의 대답 문장",
  "isAnomaly": false,
  "analysisNote": "",
  "cognitiveChecks": []
}
cognitiveChecks 배열에는 이번 대화에서 관찰/평가한 인지 영역을 기록하세요.
각 항목: {"domain": "영역명", "score": 0~2, "confidence": 0.0~1.0, "evidence": "근거 발화", "note": "판단 사유"}
평가할 것이 없으면 빈 배열로 두세요.`,
  });

  parts.push({ inlineData: { mimeType: audioMimeType, data: audioData } });

  const res = await model.generateContent({
    contents: [{ role: "user", parts }],
  });

  const parsed = parseGeminiResponse(res.response.text().trim());

  if (conversationId) {
    await saveMessages({
      conversationId,
      userId,
      userContent: parsed.transcription || "(음성 메시지)",
      assistantContent: parsed.text,
      isAnomaly: parsed.isAnomaly,
      analysisNote: parsed.analysisNote,
      cognitiveChecks: parsed.cognitiveChecks,
    });
  }

  return NextResponse.json({
    text: parsed.text,
    transcription: parsed.transcription ?? "",
    role: "assistant",
  });
}

/** 4) 텍스트 기반 요청 — 스트리밍 응답 */
async function handleTextMessage(params: {
  systemPrompt: string;
  userId: string;
  conversationId?: string;
  userContent: string;
  historyText: string;
  memories: string;
}) {
  const { systemPrompt, userId, conversationId, userContent, historyText, memories } = params;
  const model = getTextModel(systemPrompt);

  const prompt = `${memories ? `과거 맥락 (이 사용자가 예전 대화에서 말한 내용):\n${memories}\n[지시] 사용자가 "기억나니?", "아까 말한 거" 등으로 물어보면 위 과거 맥락에서 해당 정보를 찾아 답하세요.\n` : ""}
대화 내역:
${historyText}

[지시] 위 대화 내역을 반드시 참고하세요. 사용자가 이미 답한 내용(식사·수면·기분 등)은 다시 묻지 말고, 아직 안 물어본 주제로만 질문하세요.
따뜻하고 자연스러운 한국어로 답변해 주세요.`;

  const streamResult = await model.generateContentStream(prompt);

  const encoder = new TextEncoder();
  let fullText = "";

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of streamResult.stream) {
          const text = chunk.text();
          if (text) {
            fullText += text;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text })}\n\n`));
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();

        // 스트림 종료 후 DB 저장 + 비동기 인지 분석 (응답에 영향 없음)
        if (conversationId && userContent) {
          (async () => {
            try {
              // 1) 메시지 저장
              const { assistantMsg } = await saveMessages({
                conversationId,
                userId,
                userContent,
                assistantContent: fullText,
                isAnomaly: false,
                analysisNote: null,
              });

              // 2) 인지 분석 (별도 경량 Gemini 호출)
              const checks = await analyzeCognitive({
                userMessage: userContent,
                assistantResponse: fullText,
                historyText,
                environmentInfo: systemPrompt.split("[인지 선별 프로토콜")[0].trim(),
              });

              // 3) 분석 결과가 있으면 cognitive_assessments에 직접 저장
              if (checks.length > 0) {
                await saveCognitiveAssessments(userId, assistantMsg.id, conversationId, checks);
              }
            } catch (e) {
              console.error("Post-stream processing failed:", e);
            }
          })();
        }
      } catch (e) {
        console.error("stream error:", e);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: "스트리밍 중 오류가 발생했습니다." })}\n\n`));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ─── POST handler ───────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  try {
    const body = (await req.json()) as ChatRequestBody;
    const { messages, conversationId, isInitialGreeting, audio, context: clientContext } = body;
    const userId = session.user.id;

    // 공통: 시간 + 날씨 + 시스템 프롬프트 조립
    const timeCtx = getTimeContext(clientContext?.currentTime);
    const weatherCtx = await getWeatherContext(clientContext?.latitude, clientContext?.longitude);
    const { systemPrompt, userName, honorific } = await buildSystemPrompt({
      userId,
      conversationId,
      timeCtx,
      weather: weatherCtx,
    });

    // 1) 초기 인사
    if (isInitialGreeting) {
      return handleGreeting(systemPrompt, userName, honorific, conversationId);
    }

    // 공통: RAG 검색 + 히스토리 텍스트
    const lastUserMessage = messages?.filter((m) => m.role === "user").pop()?.content ?? "";
    const [memories, historyText] = await Promise.all([
      fetchMemories(userId, lastUserMessage),
      Promise.resolve(buildHistoryText(messages ?? [])),
    ]);

    // 2) 날짜/시간 질문 → 서버에서 바로 응답
    if (!audio?.data && lastUserMessage && isDateTimeQuestion(lastUserMessage)) {
      return handleDateTimeQuestion(lastUserMessage, honorific, conversationId, clientContext?.currentTime);
    }

    // 3) 음성 입력
    if (audio?.data && audio?.mimeType) {
      return handleAudioMessage({
        systemPrompt,
        honorific,
        userName,
        userId,
        conversationId,
        audioData: audio.data,
        audioMimeType: audio.mimeType,
        historyText,
        memories,
      });
    }

    // 4) 텍스트 입력
    return handleTextMessage({
      systemPrompt,
      userId,
      conversationId,
      userContent: lastUserMessage,
      historyText,
      memories,
    });
  } catch (e) {
    console.error("chat api error", e);
    return NextResponse.json({ error: toSafeErrorMessage(e) }, { status: 500 });
  }
}
