/**
 * /api/live/token 게이트 — **행위** 테스트(실제 라우트 핸들러를 호출한다).
 *
 * 2026-10-06 정정:
 *   ① 보호자·전문가 차단 — 보호자는 어르신 페르소나를 받았고, 전문가는 대리 귀속이 없어 환자 발화가
 *      검사자 계정에 기록됐다.
 *   ② 동의 게이트 — 미동의 계정이 세션을 받으면 매 턴이 응급 판정 **전에** 403으로 버려졌다.
 *   ③ 일일 한도 대상(어르신만) + conversationId를 빼도 한도 판정이 빠지지 않게.
 *   ④ 역할별 지시문 — 일반인이 인지 확인 지시를 받았다.
 *      ⚠ 이 파일의 첫 버전은 buildSystemPrompt에 넘긴 **mode 인자만** 확인했다. 실제 지시문은
 *      mode와 무관했는데도 통과했다(적대 감사 지적, F5). 이제 **토큰에 실린 systemInstruction**을 본다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let session: { user: { id: string; screeningMode?: string } } | null = null;
let usage = { used: 0, limit: 200, exceeded: false, nearLimit: false, remaining: 200 };
let consented = true;

vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/feature-flags", () => ({ isLiveBetaEnabledServer: () => true }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => ({ consentedAt: consented ? new Date("2026-01-01") : null })) },
    conversation: { findUnique: vi.fn(async (a: { where: { id?: string; userId?: string } }) =>
      (a.where.userId ? { id: "c-own" } : { userId: session?.user.id })) },
  },
}));
const getDailyUsage = vi.fn<(convId: string) => Promise<typeof usage>>(async () => usage);
vi.mock("@/lib/usage/daily-limit", () => ({
  getDailyUsage: (convId: string) => getDailyUsage(convId),
  buildDailyLimitReplyForUser: vi.fn(async () => "어르신, 오늘 이야기 많이 나눴네요. 내일 또 만나요."),
}));
// 타입은 제네릭으로 준다 — 미사용 매개변수로 주면 린트 경고가 부채로 쌓인다(F10)
const buildSystemPrompt = vi.fn<(a: { mode: string }) => Promise<{ stablePrompt: string }>>(
  async () => ({ stablePrompt: "STABLE" }));
vi.mock("@/lib/chat/prompt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/prompt")>()),   // GENERAL_NO_COGNITIVE_RULE는 실제 값
  buildSystemPrompt: (a: { mode: string }) => buildSystemPrompt(a),
}));
vi.mock("@/lib/chat/weather", () => ({ getWeatherContext: vi.fn(async () => ({ promptText: "맑음", description: "맑음" })) }));
const createToken = vi.fn<(a: { config: { liveConnectConstraints: { config: { systemInstruction: string } } } }) => Promise<{ name: string }>>(
  async () => ({ name: "tok-1" }));
// 원본을 펼친다 — 실제 prompt.ts의 하위 의존성이 HarmCategory 등 다른 export를 쓴다(부분 목은 깨진다)
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class { authTokens = { create: createToken }; },
}));

process.env.GEMINI_API_KEY = "test-key";
const { POST } = await import("@/app/api/live/token/route");
const { GENERAL_NO_COGNITIVE_RULE } = await import("@/lib/chat/prompt");

async function call(body: Record<string, unknown> = { conversationId: "c-1" }) {
  const res = await POST(new Request("http://localhost/api/live/token", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
/** 마지막으로 발급된 토큰의 세션 지시문 */
const issuedInstruction = () => createToken.mock.calls.at(-1)![0].config.liveConnectConstraints.config.systemInstruction;

beforeEach(() => {
  usage = { used: 10, limit: 200, exceeded: false, nearLimit: false, remaining: 190 };
  consented = true;
  session = { user: { id: "u-elder", screeningMode: "user" } };
  for (const f of [getDailyUsage, buildSystemPrompt, createToken]) f.mockClear();
});

describe("역할 차단", () => {
  it.each(["guardian", "pro"])("%s 는 403 — 토큰도 프롬프트도 만들지 않는다", async (role) => {
    session = { user: { id: `u-${role}`, screeningMode: role } };
    const r = await call();
    // 🔒 guardian: 어르신 페르소나를 받았다 / pro: 대리 귀속이 없어 환자 발화가 검사자 계정에 기록됐다
    expect(r.status).toBe(403);
    expect(buildSystemPrompt).not.toHaveBeenCalled();
    expect(createToken).not.toHaveBeenCalled();
  });
});

describe("동의 게이트", () => {
  it("미동의면 403 needConsent — 세션을 열지 않는다", async () => {
    consented = false;
    const r = await call();
    // 🔒 이전: 세션은 열렸는데 매 턴이 /api/live/turn의 동의 게이트에서 **응급 판정 전에** 버려졌다
    expect(r.status).toBe(403);
    expect(r.body.needConsent).toBe(true);
    expect(createToken).not.toHaveBeenCalled();
  });
});

describe("일일 한도 — 대상은 어르신만", () => {
  it("어르신이 한도를 넘으면 403 + 마무리 인사(오류 문구가 아니다)", async () => {
    usage = { used: 200, limit: 200, exceeded: true, nearLimit: false, remaining: 0 };
    const r = await call();
    expect(r.status).toBe(403);
    expect(r.body.dailyLimitReached).toBe(true);
    expect(typeof r.body.message).toBe("string");
    expect(createToken).not.toHaveBeenCalled();
  });

  it("어르신이 한도 안이면 토큰이 발급된다", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body.token).toBe("tok-1");
  });

  it("conversationId를 빼도 한도 판정이 빠지지 않는다 (계정의 대화로 센다)", async () => {
    usage = { used: 200, limit: 200, exceeded: true, nearLimit: false, remaining: 0 };
    const r = await call({});
    // 🔒 이전: conversationId가 없으면 한도 블록 자체를 건너뛰었다
    expect(getDailyUsage).toHaveBeenCalledWith("c-own");
    expect(r.status).toBe(403);
  });

  it("일반인은 한도를 조회하지 않는다", async () => {
    session = { user: { id: "u-general", screeningMode: "general" } };
    usage = { used: 999, limit: 200, exceeded: true, nearLimit: false, remaining: 0 };
    const r = await call();
    expect(getDailyUsage).not.toHaveBeenCalled();
    expect(r.status).toBe(200);
  });
});

describe("역할별 세션 지시문 — **발급되는 지시문 자체**를 본다", () => {
  const PROBE = "대여섯 턴에 한 번쯤";

  it("어르신은 인지 확인 지시를 받는다", async () => {
    expect((await call()).status).toBe(200);
    expect(issuedInstruction()).toContain(PROBE);
  });

  it("일반인은 인지 확인 지시를 받지 않고, 금지 규칙을 받는다", async () => {
    session = { user: { id: "u-general", screeningMode: "general" } };
    expect((await call()).status).toBe(200);
    // 🔒 이전: mode를 넘기기만 하고 지시문은 어르신과 똑같았다 — 일반인이 대여섯 턴마다 날짜·기억 질문을 받았다
    expect(issuedInstruction()).not.toContain(PROBE);
    expect(issuedInstruction()).toContain(GENERAL_NO_COGNITIVE_RULE);
  });

  it("두 역할 모두 위급 신호 안내는 유지된다", async () => {
    await call();
    expect(issuedInstruction()).toContain("119");
    session = { user: { id: "u-general", screeningMode: "general" } };
    await call();
    expect(issuedInstruction()).toContain("119");
  });
});

/**
 * 세션 thinking은 lib/ai/gemini-config를 거친다(2026-10-07 Google 공지 — 다음 세대는 thinkingBudget을 400으로 거부).
 *   오늘 모델(3.1 Live)엔 HEAD(53eb438)와 같은 제약이 실려야 한다 — 첫 오디오 지연을 위해 thinking 0.
 */
describe("Live 세션 thinking — 모델 세대별 (2026-10-07)", () => {
  it("오늘 모델이면 thinkingBudget 0 그대로, temperature 같은 키는 생기지 않는다", async () => {
    expect((await call()).status).toBe(200);
    const constraints = createToken.mock.calls.at(-1)![0].config.liveConnectConstraints as unknown as {
      model: string; config: Record<string, unknown>;
    };
    expect(constraints.model).toBe("gemini-3.1-flash-live-preview");
    // 🔒 키 집합까지 고정 — 헬퍼 결과를 안 펼치면 thinkingConfig가 빠져 첫 오디오가 느려진다(PoC +2.6s)
    expect(Object.keys(constraints.config).sort()).toEqual(
      ["inputAudioTranscription", "outputAudioTranscription", "responseModalities", "systemInstruction", "thinkingConfig"]);
    expect(constraints.config.thinkingConfig).toStrictEqual({ thinkingBudget: 0 });
  });
});
