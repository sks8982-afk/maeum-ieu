/**
 * /api/chat 텍스트 경로의 '날짜·시간 즉답' 단락 — **행위** 테스트(실제 라우트 핸들러를 호출한다).
 *
 * 결함(2026-10-06 재검토, 재현 확인): 이 단락 게이트가 응급을 **정규식만으로** 판정했다.
 *   음성 경로(1.55단계)는 백스톱이 포함된 effectiveLevel을 보는데, 텍스트 게이트만 복사본이라
 *   "지금 몇 시야? 모아둔 약 오늘 다 털어 넣을 거야"처럼 정규식이 놓치고 백스톱만 잡는 L3가
 *   "지금은 한국 시각으로 …이에요" 한 줄로 끝났다 — 119 안내·보호자 알림·응급 마킹 전부 없이.
 *   백스톱이 존재하는 이유가 정확히 그 과소감지 꼬리다.
 *
 * 목 체제: 세션·prisma·레이트리밋·날씨·프롬프트·저장·알림, 그리고 **백스톱만 목**(정규식은 실물).
 *   동반자 LLM은 불리면 실패하도록 심어 둔다 — 두 경로(즉답·L3) 모두 LLM 없이 응답해야 한다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EmergencyResult } from "@/lib/chat/emergency";

const llmCalls: string[] = [];
/** 오늘 사용자 발화 수(일일 한도 집계) — 한도 테스트가 올린다 */
let msgCount = 0;
const convLookups: unknown[] = [];
const llmTrap = (name: string) => vi.fn(async () => { llmCalls.push(name); throw new Error(`LLM_CALLED:${name}`); });

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
      findUnique: vi.fn(async (a: unknown) => { convLookups.push(a); return { id: "c-1", userId: "u-1" }; }),
      update: vi.fn(async () => ({})),
    },
    message: { findMany: vi.fn(async () => []), count: vi.fn(async () => msgCount), create: vi.fn(async () => ({ id: "m" })) },
    $queryRawUnsafe: vi.fn(async () => []),
    $executeRawUnsafe: vi.fn(async () => 1),
  },
}));
vi.mock("@/lib/chat/weather", () => ({ getWeatherContext: vi.fn(async () => ({ promptText: "맑음", description: "맑음" })) }));
vi.mock("@/lib/chat/prompt", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/chat/prompt")>();
  return {
    ...mod,
    buildSystemPrompt: vi.fn(async () => ({
      systemPrompt: "P", stablePrompt: "S", turnBlock: "", envBlock: "",
      probeTurn: false, prevProbeTurn: false, userName: "김어르신", honorific: "할머니",
      companionName: "민지", companionRelation: "손녀", profile: { profile: null, family: [], facts: [] },
    })),
  };
});
vi.mock("@/lib/chat/prompt-cache", () => ({ getPrefixCache: vi.fn(async () => null) }));
// 무료 상한 근처에서 구독 상한을 조회한다 — 목이 없으면 조회 실패로 '통과' 처리돼 한도 테스트가 공허해진다
vi.mock("@/lib/billing/entitlement", () => ({ getEntitlement: vi.fn(async () => ({ dailyTurnLimit: 100, guardianFeatures: false })) }));
vi.mock("@/lib/rag", () => ({ searchMemories: vi.fn(async () => []), saveMessageEmbedding: vi.fn(async () => {}) }));
vi.mock("@/lib/chat/llm", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/chat/llm")>();
  return {
    ...mod,
    generateWithFallback: llmTrap("generateWithFallback"),
    getTextModel: vi.fn(() => {
      llmCalls.push("getTextModel");
      return { generateContent: llmTrap("model.generateContent"), generateContentStream: llmTrap("model.generateContentStream") };
    }),
    getGenAI: () => ({ models: { generateContent: llmTrap("generateContent"), generateContentStream: llmTrap("generateContentStream") } }),
  };
});
const backstop = vi.fn<(text: string) => Promise<EmergencyResult | null>>(async () => null);
vi.mock("@/lib/chat/emergency-llm", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/chat/emergency-llm")>();
  return { ...mod, detectEmergencyLLM: (t: string) => backstop(t) };
});
const notifyGuardian = vi.fn(async () => {});
vi.mock("@/lib/chat/emergency-notify", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/chat/emergency-notify")>();
  return { ...mod, notifyGuardian: () => notifyGuardian() };
});
const saveMessages = vi.fn<(p: { emergencyLevel?: number; assistantContent?: string }) => Promise<{ userMsgId: string }>>(
  async () => ({ userMsgId: "m-u" }),
);
vi.mock("@/lib/chat/messages", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/chat/messages")>();
  return { ...mod, saveMessages: (p: { emergencyLevel?: number; assistantContent?: string }) => saveMessages(p), saveGreetingMessage: vi.fn(async () => {}) };
});

const { POST } = await import("@/app/api/chat/route");
const { detectEmergency } = await import("@/lib/chat/emergency");
const { isDateTimeQuestion } = await import("@/lib/chat/time");

async function say(content: string) {
  const res = await POST(new Request("http://localhost/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: "c-1", messages: [{ role: "user", content }] }),
  }));
  const raw = await res.text();
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch { body = { __nonJson: raw.slice(0, 200) }; }
  return { status: res.status, body };
}

/** 정규식이 놓치고 백스톱만 잡는 L3 — 재검토가 실제로 재현한 발화 */
const HIDDEN_L3 = "지금 몇 시야? 모아둔 약 오늘 다 털어 넣을 거야";

beforeEach(() => {
  llmCalls.length = 0;
  msgCount = 0;
  convLookups.length = 0;
  backstop.mockReset();
  backstop.mockImplementation(async () => null);
  notifyGuardian.mockClear();
  saveMessages.mockClear();
});

describe("전제 — 이 테스트가 보는 틈이 실재한다", () => {
  it("발화는 시간 질문이고, 정규식은 응급으로 못 잡는다", () => {
    // 🔒 정규식이 이 발화를 잡게 되면 이 테스트는 백스톱 경로를 더 이상 검증하지 못한다 — 다른 발화로 교체
    expect(isDateTimeQuestion(HIDDEN_L3)).toBe(true);
    expect(detectEmergency(HIDDEN_L3).level).toBe(0);
  });
});

describe("텍스트 날짜·시간 단락이 백스톱 응급을 삼키지 않는다", () => {
  it("백스톱이 L3로 판정하면 시각 안내가 아니라 L3 응답 + 보호자 알림 + 마킹", async () => {
    backstop.mockImplementation(async () => ({ level: 3, category: "suicidal", evidence: "llm-backstop" }));
    const r = await say(HIDDEN_L3);
    expect(r.status).toBe(200);
    // 🔒 2026-10-06 이전: "할머니, 지금은 한국 시각으로 …이에요."로 끝났다
    expect(String(r.body.text)).not.toMatch(/한국 시각으로/);
    expect(backstop).toHaveBeenCalledWith(HIDDEN_L3);
    expect(notifyGuardian).toHaveBeenCalled();
    expect(saveMessages.mock.calls.some(([p]) => p.emergencyLevel === 3), "응급 마킹(emergencyLevel 3) 저장").toBe(true);
    expect(llmCalls).toEqual([]);
  });

  it("평범한 시간 질문은 그대로 즉답한다 (백스톱 none)", async () => {
    const r = await say("지금 몇 시야?");
    expect(r.status).toBe(200);
    expect(String(r.body.text)).toMatch(/한국 시각으로/);
    expect(notifyGuardian).not.toHaveBeenCalled();
    expect(llmCalls).toEqual([]);
  });
});

describe("conversationId 없이 보내도 일일 한도를 센다 (2026-10-06 재검토)", () => {
  it("대화 ID를 빼면 계정의 대화를 찾아 한도를 적용한다 — 동반자 LLM 미호출", async () => {
    msgCount = 500;
    const res = await POST(new Request("http://localhost/api/chat", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "오늘 산책 다녀왔어" }] }),   // conversationId 없음
    }));
    const body = await res.json() as Record<string, unknown>;
    // 🔒 이전: 한도 판정이 `conversationId &&` 조건이라 통째로 빠지고 LLM이 무제한으로 불렸다
    expect(res.status).toBe(200);
    expect(body.dailyLimitReached).toBe(true);
    expect(llmCalls).toEqual([]);
    expect(convLookups).toContainEqual(expect.objectContaining({ where: { userId: "u-1" } }));
  });

  it("한도 안이면 그대로 진행한다 (조회가 대화를 막지 않는다)", async () => {
    msgCount = 3;
    const r = await say("지금 몇 시야?");
    expect(r.status).toBe(200);
    expect(String(r.body.text)).toMatch(/한국 시각으로/);
  });
});

describe("과거 해소 자살 생각 — 말만 부드럽게, 기록·알림은 그대로 (B9, 2026-10-06 사용자 결정)", () => {
  const PAST = "영감 먼저 보내고 한동안은 예전엔 죽고 싶었는데, 지금은 이렇게 친구들이 있어서 괜찮아.";

  it("전제: 감지기는 과거 보존 규칙으로 L2, 모더레이션은 자해로 잡는다", async () => {
    const { detectInappropriate } = await import("@/lib/chat/moderation");
    expect(detectEmergency(PAST).level).toBe(2);
    expect(detectInappropriate(PAST).category).toBe("self_harm");
  });

  it("응답은 공감·후속 확인·상담 번호, L2 마킹 저장 + 보호자 알림은 유지", async () => {
    const r = await say(PAST);
    expect(r.status).toBe(200);
    // 🔒 2026-10-06 이전: "…자살예방상담전화 109번이나 … 바로 전화하실 수 있어요" 위기 안내
    expect(String(r.body.text)).toMatch(/다시 그런 마음이 드시면/);
    expect(String(r.body.text)).not.toMatch(/바로 전화/);
    expect(saveMessages.mock.calls.some(([p]) => p.emergencyLevel === 2)).toBe(true);
    expect(notifyGuardian).toHaveBeenCalled();
    expect(llmCalls).toEqual([]);
  });

  it("현재형 자살 표현은 기존 위기 안내 그대로", async () => {
    const r = await say("요즘 자꾸 죽고 싶어");
    expect(String(r.body.text)).not.toMatch(/다시 그런 마음이 드시면/);
  });
});
