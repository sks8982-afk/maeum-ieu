import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// RAG: 나중에 pgvector로 과거 대화/메모리 검색 후 prompt에 넣기
const SYSTEM_PROMPT = `당신은 '마음이음' 서비스의 AI 친구입니다.
사용자와 자연스럽게 대화하며, 식사 여부나 일상, 기분 등을 편하게 물어봅니다.
답변은 짧고 따뜻하게, 노인 사용자도 편하게 느끼도록 해주세요.
의료·진단·처방은 하지 말고, 참고 수준의 대화만 이어가세요.
인사할 때는 반드시 "안녕하세요, ○○님의 AI [역할] [이름]이에요" 형식으로 자신을 소개합니다.
모든 답변의 끝에는 항상 어르신의 건강 상태나 최근 식사 여부를 자연스럽게 물어보는 짧은 질문을 한 문장 포함해 주세요.`;

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { messages, conversationId, isInitialGreeting, audio } = body as {
      messages?: { role: string; content: string }[];
      conversationId?: string;
      isInitialGreeting?: boolean;
      audio?: { data: string; mimeType: string };
    };

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY가 설정되지 않았습니다." },
        { status: 500 }
      );
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    if (isInitialGreeting) {
      const userName = (session.user as { name?: string | null }).name || "사용자";
      const res = await model.generateContent({
        contents: [
          {
            role: "user",
            parts: [{ text: `${SYSTEM_PROMPT}\n\n지금 ${userName}님이 대화를 시작하려고 합니다. AI 가족 역할은 '손녀/손자'로 하고, 이름은 '민지'로 해주세요. 첫 인사 한 마디만 짧게 해주세요. (본인 소개 포함)` }],
          },
        ],
      });
      const text = res.response.text();
      if (conversationId) {
        await prisma.message.createMany({
          data: [
            { conversationId, role: "assistant", content: text },
          ],
        });
      }
      return NextResponse.json({ text, role: "assistant" });
    }

    // RAG: 추후 prisma + pgvector로 유사 과거 대화 검색
    // const memories = await searchMemories(session.user.id, lastUserMessage);
    const memories = "";
    const historyText = (messages ?? [])
      .map((m: { role: string; content: string }) => `${m.role === "user" ? "사용자" : "AI"}: ${m.content}`)
      .join("\n");

    // 음성 입력이 있는 멀티모달 요청
    if (audio?.data && audio?.mimeType) {
      const userName = (session.user as { name?: string | null }).name || "사용자";
      const parts = [];
      if (historyText) {
        parts.push({
          text: `지금까지의 대화 내역 요약:\n${historyText}\n`,
        });
      }
      parts.push({
        text: `${SYSTEM_PROMPT}\n\n아래 음성은 ${userName}님이 방금 하신 말씀입니다. 음성을 듣고 상황을 이해한 뒤, 손녀 '민지'로서 따뜻하게 대답해 주세요.\n\n응답은 반드시 다음 JSON 형식의 문자열로만, 추가 설명 없이 반환해 주세요.\n{\n  "transcription": "사용자의 음성을 한국어로 정확하게 받아 적은 문장",\n  "text": "transcription을 기반으로 한 당신의 대답 문장"\n}\nJSON 이외의 텍스트(설명, 마크다운 등)는 절대 포함하지 마세요.`,
      });
      parts.push({
        inlineData: {
          mimeType: audio.mimeType,
          data: audio.data,
        },
      });

      const res = await model.generateContent({
        contents: [
          {
            role: "user",
            parts,
          },
        ],
      });

      const raw = res.response.text().trim();
      let transcription = "";
      let answerText = raw;

      try {
        const parsed = JSON.parse(raw) as {
          transcription?: string;
          text?: string;
        };
        if (parsed.transcription && typeof parsed.transcription === "string") {
          transcription = parsed.transcription;
        }
        if (parsed.text && typeof parsed.text === "string") {
          answerText = parsed.text;
        }
      } catch {
        // JSON 파싱 실패 시 전체를 답변 텍스트로 사용하고, transcription은 비워 둡니다.
      }

      if (conversationId) {
        await prisma.message.create({
          data: {
            conversationId,
            role: "user",
            content: transcription || "(음성 메시지)",
          },
        });
        await prisma.message.create({
          data: { conversationId, role: "assistant", content: answerText },
        });
      }

      return NextResponse.json({
        text: answerText,
        transcription,
        role: "assistant",
      });
    }

    // 텍스트 기반 요청 (입력창에서 직접 타이핑한 경우)
    const prompt = `${SYSTEM_PROMPT}\n${memories ? `과거 맥락:\n${memories}\n` : ""}\n\n대화 내역:\n${historyText}\n\nAI:`;
    const res = await model.generateContent(prompt);

    const text = res.response.text();

    if (conversationId) {
      const lastUser = messages?.filter((m: { role: string }) => m.role === "user").pop();
      if (lastUser) {
        await prisma.message.create({
          data: { conversationId, role: "user", content: lastUser.content },
        });
      }
      await prisma.message.create({
        data: { conversationId, role: "assistant", content: text },
      });
    }

    return NextResponse.json({ text, role: "assistant" });
  } catch (e) {
    console.error("chat api error", e);
    return NextResponse.json(
      { error: "답변 생성 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
