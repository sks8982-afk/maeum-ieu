/**
 * /api/chat 음성 턴의 전사(STT) 요청 — 샘플링·thinking이 lib/ai/gemini-config를 거쳐 **실제로 실리는지** 본다.
 *
 * 왜(2026-10-07 Google 공지): 다음 세대 Gemini는 thinkingBudget·temperature를 400으로 거부한다. 음성 전용
 *   제품이라 전사가 400이 되면 어르신의 모든 말(응급 포함)이 "인식 실패"가 된다. route 파일은 내부 함수를
 *   export할 수 없어(Next 빌드 제약) 실제 POST로 음성 턴을 보내고 SDK 경계에서 요청을 받아 적는다.
 *
 * 목 체제(chat-text-gates와 같은 틀): 세션·prisma·레이트리밋·날씨·프롬프트·저장·알림·백스톱. 전사 결과는 빈
 *   문자열로 정해 "인식 실패 → 재질문"으로 끝나게 한다 — 동반자 LLM은 덫이라 불리면 이 테스트가 깨진다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Req = { model: string; config: Record<string, unknown> };
const sttCalls: Req[] = [];

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(async () => ({ user: { id: "u-1", name: "김어르신", screeningMode: "user" } })),
}));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true, retryAfterSec: 0 })) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    expertPatient: { findUnique: vi.fn(async () => null) },
    user: { findUnique: vi.fn(async () => ({ screeningMode: "user", consentedAt: new Date("2026-01-01") })) },
    conversation: {
      findFirst: vi.fn(async () => ({ id: "c-1" })),
      findUnique: vi.fn(async () => ({ id: "c-1", userId: "u-1" })),
      update: vi.fn(async () => ({})),
    },
    message: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0), create: vi.fn(async () => ({ id: "m" })) },
    $queryRawUnsafe: vi.fn(async () => []),
    $executeRawUnsafe: vi.fn(async () => 1),
  },
}));
vi.mock("@/lib/chat/weather", () => ({ getWeatherContext: vi.fn(async () => ({ promptText: "맑음", description: "맑음" })) }));
vi.mock("@/lib/chat/prompt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/prompt")>()),
  buildSystemPrompt: vi.fn(async () => ({
    systemPrompt: "P", stablePrompt: "S", turnBlock: "", envBlock: "",
    probeTurn: false, prevProbeTurn: false, userName: "김어르신", honorific: "할머니",
    companionName: "민지", companionRelation: "손녀", profile: { profile: null, family: [], facts: [] },
  })),
}));
vi.mock("@/lib/chat/prompt-cache", () => ({ getPrefixCache: vi.fn(async () => null) }));
vi.mock("@/lib/billing/entitlement", () => ({ getEntitlement: vi.fn(async () => ({ dailyTurnLimit: 100, guardianFeatures: false })) }));
vi.mock("@/lib/rag", () => ({ searchMemories: vi.fn(async () => []), saveMessageEmbedding: vi.fn(async () => {}) }));
// ⚠ 원본을 펼친다 — 부분 목은 라우트의 import가 늘 때마다 조용히 깨진다(observe-turn-gates 주석 참고)
vi.mock("@/lib/chat/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/llm")>()),
  getGenAI: () => ({ models: { generateContent: async (req: Req) => { sttCalls.push(req); return {}; } } }),
  extractText: () => "",   // 전사 = 빈 문자열 → 재질문으로 끝난다
  getTextModel: vi.fn(() => { throw new Error("LLM_CALLED:getTextModel"); }),
  generateWithFallback: vi.fn(async () => { throw new Error("LLM_CALLED:generateWithFallback"); }),
}));
vi.mock("@/lib/chat/emergency-llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/emergency-llm")>()),
  detectEmergencyLLM: vi.fn(async () => null),
}));
vi.mock("@/lib/chat/emergency-notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/emergency-notify")>()),
  notifyGuardian: vi.fn(async () => {}),
}));
vi.mock("@/lib/chat/messages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/messages")>()),
  saveMessages: vi.fn(async () => ({ userMsgId: "m-u" })),
  saveGreetingMessage: vi.fn(async () => {}),
}));

delete process.env.STT_MODEL;
const { POST } = await import("@/app/api/chat/route");

async function sendVoice() {
  const res = await POST(new Request("http://localhost/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: "c-1", messages: [], audio: { data: "UklGRg==", mimeType: "audio/webm" } }),
  }));
  return res.status;
}

beforeEach(() => {
  sttCalls.length = 0;
  delete process.env.STT_MODEL;
});

describe("/api/chat 음성 전사 요청 — 모델 세대별 (2026-10-07)", () => {
  it("오늘 모델(2.5)이면 HEAD(53eb438)와 같은 요청 — temperature 0 · thinkingBudget 64", async () => {
    // 🔒 기준 실행부터: 200이 아니면 전사 뒤 어딘가에서 터진 것이라 아래 단언이 무의미하다
    expect(await sendVoice()).toBe(200);
    expect(sttCalls.length, "전사 1회(재전사 없음)").toBe(1);
    const { model, config } = sttCalls[0];
    expect(model).toBe("gemini-2.5-flash");
    // 🔒 키 집합까지 고정 — 헬퍼 결과를 안 펼치면 temperature·thinkingConfig가 통째로 빠진다
    expect(Object.keys(config).sort()).toEqual(["abortSignal", "maxOutputTokens", "safetySettings", "temperature", "thinkingConfig"]);
    expect(config.temperature).toBe(0);
    expect(config.thinkingConfig).toStrictEqual({ thinkingBudget: 64 });
    expect(config.maxOutputTokens).toBe(1024);
    expect(config.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("STT_MODEL을 새 세대로 올리면 temperature·thinkingBudget 없이 thinkingLevel LOW (보내면 400 → 모든 음성이 인식 실패)", async () => {
    process.env.STT_MODEL = "gemini-3.9-flash";
    expect(await sendVoice()).toBe(200);
    expect(sttCalls.length).toBe(1);
    const { model, config } = sttCalls[0];
    expect(model).toBe("gemini-3.9-flash");
    expect(config).not.toHaveProperty("temperature");
    expect(config.thinkingConfig).toStrictEqual({ thinkingLevel: "LOW" });
  });
});
