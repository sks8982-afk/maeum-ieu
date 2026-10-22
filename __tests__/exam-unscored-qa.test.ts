/**
 * 검진 채점이 시스템 사유로 실패한 영역도 **문답 기록에 남는다** — 점수에는 반영하지 않는다.
 *
 * 2026-10-06 재검토: 문답 기록을 exam_item_score에서 재구성하게 바꾼 뒤(일상 대화 노출 차단), 채점 실패
 *   영역은 행이 없어 환자의 실제 답이 의사 화면에서 통째로 사라졌다. → 미채점 항목을 점수·만점 0으로 남긴다.
 *
 * 목 체제: /api/chat 대리 경로(세션·prisma·프롬프트·LLM 덫) + 채점기(scoreDomainAnswer)만 "미채점"으로 교체.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const inserts: unknown[][] = [];
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => ({ user: { id: "u-pro", name: "김의사", screeningMode: "pro" } })) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true, retryAfterSec: 0 })) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    expertPatient: { findUnique: vi.fn(async () => ({ status: "active" })) },
    user: { findUnique: vi.fn(async () => ({ screeningMode: "user", consentedAt: new Date("2026-01-01") })) },
    conversation: { findFirst: vi.fn(async () => ({ id: "c-patient" })), update: vi.fn(async () => ({})) },
    message: { findMany: vi.fn(async () => []), count: vi.fn(async () => 0), create: vi.fn(async () => ({ id: "m" })) },
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (/FROM exam_session/.test(sql)) return [{ id: "es-1", item_order: JSON.stringify(["orientation_time", "language"]), current_item: 0, reask_count: 0, answered_domains: 0 }];
      if (/SUM\(score\)/.test(sql)) return [{ t: 0, m: 0 }];
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => { if (/INSERT INTO exam_item_score/.test(sql)) inserts.push(args); return 1; }),
  },
}));
vi.mock("@/lib/chat/weather", () => ({ getWeatherContext: vi.fn(async () => ({ promptText: "맑음", description: "맑음" })) }));
vi.mock("@/lib/chat/prompt", async (o) => ({
  ...(await o<typeof import("@/lib/chat/prompt")>()),
  buildSystemPrompt: vi.fn(async () => ({ systemPrompt: "P", stablePrompt: "S", turnBlock: "", envBlock: "", probeTurn: false, prevProbeTurn: false, userName: "김환자", honorific: "할머니", companionName: "민지", companionRelation: "손녀", profile: { profile: null, family: [], facts: [] } })),
}));
vi.mock("@/lib/chat/prompt-cache", () => ({ getPrefixCache: vi.fn(async () => null) }));
vi.mock("@/lib/rag", () => ({ searchMemories: vi.fn(async () => []), saveMessageEmbedding: vi.fn(async () => {}) }));
vi.mock("@/lib/chat/emergency-llm", () => ({ detectEmergencyLLM: vi.fn(async () => null), confirmEmergencyLLM: vi.fn(async () => ({ kind: "none" })) }));
vi.mock("@/lib/chat/messages", async (o) => ({ ...(await o<typeof import("@/lib/chat/messages")>()), saveMessages: vi.fn(async () => ({ userMsgId: "m-u", assistantMsgId: "m-a" })), countRecentL1Signals: vi.fn(async () => 0) }));
let unscored = true;
vi.mock("@/lib/screening/exam-runner", async (o) => {
  const mod = await o<typeof import("@/lib/screening/exam-runner")>();
  return {
    ...mod,
    scoreDomainAnswer: vi.fn(async (domain: string, answer: string) => mod.itemsForDomain(domain).map((i) => ({
      itemId: i.id, domain, label: domain, prompt: i.prompt, answer, score: unscored ? 0 : 1, max: i.points, reason: unscored ? "채점 불가" : "정답",
      ...(unscored ? { unscored: true as const } : {}),
    }))),
  };
});

const { POST } = await import("@/app/api/chat/route");

async function answer(text: string) {
  const res = await POST(new Request("http://localhost/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ proxyPatientId: "u-patient", conversationId: "c-patient", messages: [{ role: "user", content: text }] }),
  }));
  return res.status;
}

beforeEach(() => { inserts.length = 0; unscored = true; });

describe("채점 실패 영역의 문답 보존", () => {
  it("미채점이면 점수·만점 0으로 기록한다 — 답은 남고 합계엔 안 들어간다", async () => {
    expect(await answer("2026년 가을이요")).toBe(200);
    expect(inserts.length).toBeGreaterThan(0);
    for (const args of inserts) {
      // [id, session, item, domain, prompt, answer, score, max, reason]
      expect(args[5]).toBe("2026년 가을이요");           // 🔒 환자의 실제 답이 남는다
      expect(args[6]).toBe(0);
      expect(args[7]).toBe(0);                            // 🔒 만점 0 → SUM·채점표에서 자동 제외(가짜 0점 아님)
      expect(String(args[8])).toMatch(/미채점/);
    }
  });

  it("정상 채점이면 원래대로 점수·만점이 실린다 (회귀)", async () => {
    unscored = false;
    expect(await answer("2026년 가을이요")).toBe(200);
    expect(inserts.length).toBeGreaterThan(0);
    for (const args of inserts) expect(Number(args[7])).toBeGreaterThan(0);
  });
});
