import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { searchMemories, saveMessageEmbedding } from "@/lib/rag";

const SYSTEM_PROMPT_BASE = `당신은 '마음이음' 서비스의 AI 친구입니다.
사용자와 자연스럽게 대화하며, 식사 여부나 일상, 기분 등을 편하게 물어봅니다.
답변은 짧고 따뜻하게, 노인 사용자도 편하게 느끼도록 해주세요.
의료·진단·처방은 하지 말고, 참고 수준의 대화만 이어가세요.
인사할 때는 반드시 "안녕하세요, ○○님의 AI [역할] [이름]이에요" 형식으로 자신을 소개합니다.

[중요: 반복 질문 금지]
- 대화 내역에서 사용자가 이미 답한 내용(예: 저녁 먹었음, 잠 잘 잤음, 식사 여부, 기분 등)은 절대 다시 묻지 마세요.
- 이미 물었던 질문을 바꿔서 다시 하지 마세요. (예: "저녁 드셨나요?" → "잘 주무셨나요?" → "저녁은 드셨는지..." 순으로 같은 류만 반복 금지)
- 새로 물어볼 때는 아직 이야기하지 않은 주제(다른 끼니, 산책, 오늘 일과, 감정 등)를 고르거나, 대화를 자연스럽게 이어가세요.
- 답변 끝의 질문은 "이미 답한 것"이 아닌, "아직 안 물어본 것" 하나만 포함하세요.`;

/** 현재 시간(클라이언트 전달 또는 서버) 기준으로 아침/점심/저녁 등 레이블 생성 */
function getTimeContext(clientTimeIso?: string) {
  const now = clientTimeIso ? new Date(clientTimeIso) : new Date();
  const kr = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const hour = kr.getHours();
  const dateStr = kr.toLocaleDateString("ko-KR", { weekday: "long", month: "long", day: "numeric" });
  let timeLabel = "오후";
  if (hour >= 5 && hour < 10) timeLabel = "아침";
  else if (hour >= 10 && hour < 14) timeLabel = "오전";
  else if (hour >= 14 && hour < 17) timeLabel = "점심 시간대";
  else if (hour >= 17 && hour < 21) timeLabel = "저녁";
  return { timeLabel, hour, dateStr };
}

type WeatherContext = { description: string; promptText: string };

/** 위도/경도가 있으면 Open-Meteo(무료)로 조회, 없으면 목 데이터 */
async function getWeatherContext(lat?: number, lon?: number): Promise<WeatherContext> {
  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=weather_code&timezone=Asia%2FSeoul`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { current?: { weather_code?: number } };
        const code = data.current?.weather_code ?? 0;
        const description =
          code === 0
            ? "맑음"
            : code < 4
              ? "대체로 맑음/흐림"
              : code < 70
                ? "비/눈 없음 구름"
                : code < 90
                  ? "비 또는 눈"
                  : "천둥/폭풍";
        return {
          description,
          promptText: `현재 날씨: ${description}`,
        };
      }
    } catch {
      // fallback to mock
    }
  }
  return {
    description: "맑음",
    promptText: "현재 날씨: 맑음 (위치 미제공 시 기본값)",
  };
}

/** 환경 컨텍스트 문자열(프롬프트 삽입용) */
function buildContextBlock(
  timeCtx: { timeLabel: string; dateStr: string },
  weather: WeatherContext
): string {
  return `[현재 환경 정보]
- 현재 시각대: ${timeCtx.timeLabel} (${timeCtx.dateStr})
- ${weather.promptText}

위 정보를 활용해 "점심 드셨나요?", "오늘 날씨가 좋은데 산책 어떠세요?"처럼 구체적인 선제적 질문을 해 주세요.`;
}

/** 인지 오류 감지 지침 (SYSTEM_PROMPT에 추가) */
const COGNITIVE_DETECTION_RULE = `

[인지 모니터링 지침]
- 사용자가 말한 내용이 "현재 날씨" 또는 "현재 시간/요일"과 명백히 다를 경우(예: 맑은데 비가 온다고 함, 월요일인데 일요일이라고 함) 인지 오류로 판단하고, isAnomaly를 true로 설정한 뒤 analysisNote에 짧게 사유를 적어 주세요.
- 인지 오류가 감지되면 사용자에게 부드럽게 한 번 더 재질문하여 확인해 주세요. (예: "오늘은 날씨가 맑다고 하는데, 비 오는 것처럼 느껴지셨나요? 괜찮으시면 다시 한번 말씀해 주세요.")`;

/** 연령·성별로 호칭 추론 (할아버지, 할머니, 엄마, 아빠 등) */
function getHonorific(age: number | null, gender: string | null): string {
  if (age == null || gender == null) return "회원님";
  const a = age;
  if (a >= 60) return gender === "male" ? "할아버지" : gender === "female" ? "할머니" : "회원님";
  if (a >= 40) return gender === "male" ? "아빠" : gender === "female" ? "엄마" : "회원님";
  return "회원님";
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { name: true, age: true, gender: true },
    });
    const userName = user?.name?.trim() || "사용자";
    const honorific = getHonorific(user?.age ?? null, user?.gender ?? null);
    const userBlock = `[사용자 정보]
- 이름: ${userName}
- 호칭: ${honorific} (대화할 때 반드시 이 호칭으로 부르세요. 예: "할아버지", "할머니", "엄마", "아빠", "회원님")`;

    const body = await req.json();
    const {
      messages,
      conversationId,
      isInitialGreeting,
      audio,
      context: clientContext,
    } = body as {
      messages?: { role: string; content: string }[];
      conversationId?: string;
      isInitialGreeting?: boolean;
      audio?: { data: string; mimeType: string };
      context?: { currentTime?: string; latitude?: number; longitude?: number };
    };

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY가 설정되지 않았습니다." },
        { status: 500 }
      );
    }

    const timeCtx = getTimeContext(clientContext?.currentTime);
    const weatherCtx = await getWeatherContext(
      clientContext?.latitude,
      clientContext?.longitude
    );
    const contextBlock = buildContextBlock(timeCtx, weatherCtx);
    const systemPromptWithContext = `${SYSTEM_PROMPT_BASE}\n\n${userBlock}\n\n${contextBlock}${COGNITIVE_DETECTION_RULE}`;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    if (isInitialGreeting) {
      const greetingPrompt = `${systemPromptWithContext}

지금 ${userName}님이 대화를 시작하려고 합니다. AI 가족 역할은 '손녀/손자'로 하고, 이름은 '민지'로 해주세요.
위 [사용자 정보]의 호칭(${honorific})으로 부르면서, [현재 환경 정보]를 반영해 현재 시각대에 맞는 구체적인 선제적 질문을 포함한 첫 인사 한 마디만 짧게 해주세요.
예: 할아버지/할머니에게 "아침 식사는 하셨나요?", "점심 드셨나요?", "오늘 날씨가 맑은데 산책 어떠세요?" 등. (본인 소개 포함)`;
      const res = await model.generateContent({
        contents: [{ role: "user", parts: [{ text: greetingPrompt }] }],
      });
      const text = res.response.text();
      if (conversationId) {
        await prisma.message.createMany({
          data: [{ conversationId, role: "assistant", content: text }],
        });
      }
      return NextResponse.json({ text, role: "assistant" });
    }

    // RAG: 과거 대화 유사도 검색 (pgvector + message_embeddings 테이블 필요)
    const lastUserMessage = messages?.filter((m: { role: string }) => m.role === "user").pop()?.content ?? "";
    let memories = "";
    try {
      memories = await searchMemories(session.user.id, lastUserMessage, 5);
    } catch (e) {
      console.warn("RAG searchMemories failed (pgvector/table may be missing):", e);
    }
    const historyText = (messages ?? [])
      .map((m: { role: string; content: string }) => `${m.role === "user" ? "사용자" : "AI"}: ${m.content}`)
      .join("\n");

    // 음성 입력이 있는 멀티모달 요청
    if (audio?.data && audio?.mimeType) {
      const parts = [];
      if (historyText) {
        parts.push({
          text: `지금까지의 대화 내역 요약:\n${historyText}\n`,
        });
      }
      parts.push({
        text: `${systemPromptWithContext}

아래 음성은 ${honorific} ${userName}님이 방금 하신 말씀입니다. 음성을 듣고 상황을 이해한 뒤, 손녀 '민지'로서 ${honorific}을/를 부르며 따뜻하게 대답해 주세요.
[지시] 위 "지금까지의 대화 내역"에서 사용자가 이미 답한 내용(식사·수면·기분 등)은 다시 묻지 말고, 아직 안 물어본 주제로만 질문하세요.
위 [현재 환경 정보]와 [인지 모니터링 지침]을 참고하여, 사용자 말이 실제 날씨/시간과 다르면 isAnomaly를 true로 하고 analysisNote에 짧게 사유를 적은 뒤, 부드럽게 재질문하는 답변을 text에 넣어 주세요.

응답은 반드시 다음 JSON 형식의 문자열로만, 추가 설명 없이 반환해 주세요.
{
  "transcription": "사용자의 음성을 한국어로 정확하게 받아 적은 문장",
  "text": "transcription을 기반으로 한 당신의 대답 문장",
  "isAnomaly": false,
  "analysisNote": ""
}
(인지 오류가 없으면 isAnomaly는 false, analysisNote는 빈 문자열로 두세요. 인지 오류가 있으면 isAnomaly true, analysisNote에 한 줄 요약)
JSON 이외의 텍스트(설명, 마크다운 등)는 절대 포함하지 마세요.`,
      });
      parts.push({
        inlineData: {
          mimeType: audio.mimeType,
          data: audio.data,
        },
      });

      const res = await model.generateContent({
        contents: [{ role: "user", parts }],
      });

      const raw = res.response.text().trim();
      let transcription = "";
      let answerText = raw;
      let isAnomaly = false;
      let analysisNote: string | null = null;

      try {
        const parsed = JSON.parse(raw) as {
          transcription?: string;
          text?: string;
          isAnomaly?: boolean;
          analysisNote?: string;
        };
        if (parsed.transcription && typeof parsed.transcription === "string") {
          transcription = parsed.transcription;
        }
        if (parsed.text && typeof parsed.text === "string") {
          answerText = parsed.text;
        }
        if (parsed.isAnomaly === true && parsed.analysisNote) {
          isAnomaly = true;
          analysisNote = String(parsed.analysisNote).slice(0, 500);
        }
      } catch {
        // JSON 파싱 실패 시 전체를 답변 텍스트로 사용
      }

      if (conversationId) {
        const userMsg = await prisma.message.create({
          data: {
            conversationId,
            role: "user",
            content: transcription || "(음성 메시지)",
          },
        });
        const assistantMsg = await prisma.message.create({
          data: {
            conversationId,
            role: "assistant",
            content: answerText,
            isAnomaly,
            analysisNote,
          },
        });
        if (isAnomaly && analysisNote) {
          await prisma.healthLog.create({
            data: {
              userId: session.user.id,
              conversationId,
              type: "cognitive",
              value: "인지 오류 감지",
              note: analysisNote,
            },
          });
        }
        // RAG: 저장된 메시지 임베딩하여 검색용 테이블에 넣기 (실패 시 채팅은 유지)
        saveMessageEmbedding(session.user.id, userMsg.id, userMsg.content).catch((e) =>
          console.warn("RAG saveMessageEmbedding (user) failed:", e)
        );
        saveMessageEmbedding(session.user.id, assistantMsg.id, assistantMsg.content).catch((e) =>
          console.warn("RAG saveMessageEmbedding (assistant) failed:", e)
        );
      }

      return NextResponse.json({
        text: answerText,
        transcription,
        role: "assistant",
      });
    }

    // 텍스트 기반 요청 (입력창에서 직접 타이핑한 경우)
    const textPrompt = `${systemPromptWithContext}
${memories ? `과거 맥락:\n${memories}\n` : ""}

대화 내역:
${historyText}

[지시] 위 대화 내역을 반드시 참고하세요. 사용자가 이미 답한 내용(식사·수면·기분 등)은 다시 묻지 말고, 아직 안 물어본 주제로만 질문하세요.
위 [인지 모니터링 지침]을 참고하여 응답하세요. 응답은 반드시 다음 JSON 형식의 문자열 하나만 반환하세요. 추가 설명 없이.
{"text": "사용자에게 할 말 (한 문장으로)", "isAnomaly": false, "analysisNote": ""}
(인지 오류가 없으면 isAnomaly false, analysisNote 빈 문자열. 인지 오류가 있으면 isAnomaly true, analysisNote에 한 줄 요약)
JSON만 출력하세요.`;
    const res = await model.generateContent(textPrompt);
    const rawText = res.response.text().trim();
    let text = rawText;
    let isAnomaly = false;
    let analysisNote: string | null = null;

    try {
      const parsed = JSON.parse(rawText) as {
        text?: string;
        isAnomaly?: boolean;
        analysisNote?: string;
      };
      if (parsed.text && typeof parsed.text === "string") {
        text = parsed.text;
      }
      if (parsed.isAnomaly === true && parsed.analysisNote) {
        isAnomaly = true;
        analysisNote = String(parsed.analysisNote).slice(0, 500);
      }
    } catch {
      // JSON 아님 → 전체를 답변으로 사용
    }

    if (conversationId) {
      const lastUser = messages?.filter((m: { role: string }) => m.role === "user").pop();
      let userMsg: { id: string; content: string } | null = null;
      if (lastUser) {
        userMsg = await prisma.message.create({
          data: { conversationId, role: "user", content: lastUser.content },
        });
      }
      const assistantMsg = await prisma.message.create({
        data: {
          conversationId,
          role: "assistant",
          content: text,
          isAnomaly,
          analysisNote,
        },
      });
      if (isAnomaly && analysisNote) {
        await prisma.healthLog.create({
          data: {
            userId: session.user.id,
            conversationId,
            type: "cognitive",
            value: "인지 오류 감지",
            note: analysisNote,
          },
        });
      }
      // RAG: 저장된 메시지 임베딩 (실패 시 채팅은 유지)
      if (userMsg) {
        saveMessageEmbedding(session.user.id, userMsg.id, userMsg.content).catch((e) =>
          console.warn("RAG saveMessageEmbedding (user) failed:", e)
        );
      }
      saveMessageEmbedding(session.user.id, assistantMsg.id, assistantMsg.content).catch((e) =>
        console.warn("RAG saveMessageEmbedding (assistant) failed:", e)
      );
    }

    return NextResponse.json({ text, role: "assistant" });
  } catch (e) {
    console.error("chat api error", e);
    const message =
      e instanceof Error ? e.message : typeof e === "string" ? e : "답변 생성 중 오류가 발생했습니다.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
