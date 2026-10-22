/**
 * /api/live/turn 게이트 — **행위** 테스트(실제 라우트 핸들러를 호출한다).
 *
 * 2026-10-06에 이 경로에서 두 가지 드리프트가 나왔다:
 *   ① 보호자(guardian)를 막지 않았다 — /api/chat은 2026-10-01에 403으로 막았는데 건너오지 않았다.
 *   ② 세션이 열린 뒤에는 일일 한도가 없었다 — 턴마다 유료 분석이 무제한이었다.
 * 둘 다 grep으로는 "코드가 있다"만 확인된다. 여기서는 **요청을 보내 무엇이 일어나는지** 본다.
 *
 * 목 체제: 이 라우트의 부수효과 모듈 전부(저장·분석·알림·한도). 감지(detectEmergency)는 실제 코드.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── 호출 순서 기록 — "한도를 저장 **전에** 센다"를 고정하기 위해 ──
const calls: string[] = [];
const pending: Promise<unknown>[] = [];
let convFails = false;

let session: { user: { id: string; name?: string; screeningMode?: string } } | null = null;
let usage = { used: 0, limit: 200, exceeded: false, nearLimit: false, remaining: 200 };

vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>();
  // after()는 요청 스코프 밖에서 throw한다 — 콜백을 모아 두었다가 테스트가 기다린다
  return { ...mod, after: (fn: () => unknown) => { pending.push(Promise.resolve().then(fn)); } };
});
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/feature-flags", () => ({ isLiveBetaEnabledServer: () => true }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    // convFails면 소유권 조회가 throw — 응급 판정 **전** DB 장애(최후 안전망 경로)를 흉내낸다
    conversation: { findUnique: vi.fn(async () => { if (convFails) throw new Error("db down"); return { userId: session?.user.id }; }) },
    user: { findUnique: vi.fn(async () => ({ consentedAt: new Date("2026-01-01") })) },
    message: { findMany: vi.fn(async () => []) },
  },
}));
// 타입은 제네릭으로 준다 — 미사용 매개변수로 주면 린트 경고가 부채로 쌓인다(F10)
const saveMessages = vi.fn<(a: Record<string, unknown>) => Promise<{ userMsgId: string }>>(
  async () => { calls.push("save"); return { userMsgId: "m-1" }; });
// ⚠ countRecentL1Signals도 반드시 둔다 — 응급 평가(lib/chat/emergency-evaluate)가 이 모듈에서 가져온다.
//   처음엔 saveMessages만 목으로 둬서 L1 턴이 "없는 함수 호출"로 **500**이 났는데, L1 테스트는
//   dailyLimitReached가 없는지만 봐서 오류 응답에도 통과했다(2026-10-06 실측). 상태 코드를 같이 본다.
let recentL1 = 0;
// 인자를 받아 둔다 — "어느 대화의 L1을 세는지"를 보지 않으면 엉뚱한 키를 넘겨도 녹색이다(2026-10-06 재검토)
const countRecentL1Signals = vi.fn<(conversationId: string) => Promise<number>>(async () => recentL1);
vi.mock("@/lib/chat/messages", () => ({
  saveMessages: (a: Record<string, unknown>) => saveMessages(a),
  countRecentL1Signals: (c: string) => countRecentL1Signals(c),
}));
const runCognitiveAnalysis = vi.fn(async () => { calls.push("cognitive"); });
vi.mock("@/lib/chat/cognitive-run", () => ({ runCognitiveAnalysis: () => runCognitiveAnalysis() }));
// 백스톱은 조절 가능해야 한다 — 항상 null이면 "한도 예외에 백스톱이 포함된다"를 검증할 수 없다
const backstop = vi.fn<(text: string) => Promise<{ level: 0 | 1 | 2 | 3; category: string; evidence: string } | null>>(async () => null);
// 맥락 가드가 지운 L2+의 재확인(2026-10-22) — 기본은 '아님'. 재확인 시험만 바꾸고 beforeEach가 되돌린다
type Verdict = { kind: "emergency"; result: { level: 2 | 3; category: string; evidence: string } } | { kind: "none" } | { kind: "error" };
const confirm = vi.fn<(text: string, evidence?: string) => Promise<Verdict>>(async () => ({ kind: "none" }));
vi.mock("@/lib/chat/emergency-llm", () => ({ detectEmergencyLLM: (t: string) => backstop(t), confirmEmergencyLLM: (t: string, e?: string) => confirm(t, e) }));
const notifyGuardian = vi.fn<(p: { level: number }) => Promise<{ sent: boolean; channels: string[] }>>(
  async () => ({ sent: true, channels: ["push"] }));
vi.mock("@/lib/chat/emergency-notify", () => ({ notifyGuardian: (p: { level: number }) => notifyGuardian(p) }));
const lastResortEmergency = vi.fn(async () => ({ fired: true, level: 3, category: "medical_acute", reply: "119" }));
vi.mock("@/lib/chat/emergency-last-resort", () => ({ lastResortEmergency: () => lastResortEmergency() }));
const extractAndSaveProfile = vi.fn(async () => { calls.push("profile"); });
vi.mock("@/lib/chat/profile-extractor", () => ({ extractAndSaveProfile: () => extractAndSaveProfile() }));
const maybeTriggerSummaryRollup = vi.fn(async () => { calls.push("summary"); });
vi.mock("@/lib/chat/summary-trigger", () => ({ maybeTriggerSummaryRollup: () => maybeTriggerSummaryRollup() }));
const getDailyUsage = vi.fn<(conversationId: string, userId: string) => Promise<typeof usage>>(
  async () => { calls.push("usage"); return usage; });
vi.mock("@/lib/usage/daily-limit", () => ({
  getDailyUsage: (c: string, u: string) => getDailyUsage(c, u),
  buildDailyLimitReplyForUser: vi.fn(async () => "어르신, 오늘 민지랑 이야기 많이 나눴네요. 내일 또 만나요."),
}));

const { POST } = await import("@/app/api/live/turn/route");

function req(userText = "오늘 산책 다녀왔어", aiText = "좋으셨겠어요") {
  return new Request("http://localhost/api/live/turn", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: "c-1", userText, aiText }),
  });
}

async function call(r = req()) {
  const res = await POST(r);
  await Promise.all(pending.splice(0));   // after() 콜백까지 끝난 뒤에 판정한다
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(() => {
  calls.length = 0;
  pending.length = 0;
  recentL1 = 0;
  convFails = false;
  lastResortEmergency.mockClear();
  usage = { used: 10, limit: 200, exceeded: false, nearLimit: false, remaining: 190 };
  session = { user: { id: "u-elder", name: "김어르신", screeningMode: "user" } };
  backstop.mockReset();
  backstop.mockImplementation(async () => null);
  confirm.mockReset();
  confirm.mockImplementation(async () => ({ kind: "none" }));
  for (const f of [saveMessages, runCognitiveAnalysis, notifyGuardian, extractAndSaveProfile, maybeTriggerSummaryRollup, getDailyUsage, countRecentL1Signals]) f.mockClear();
});

describe("보호자 계정 — /api/chat과 같은 403", () => {
  it("guardian은 403이고 아무것도 저장되지 않는다", async () => {
    session = { user: { id: "u-guardian", screeningMode: "guardian" } };
    const r = await call();
    // 🔒 2026-10-06 이전: 인지 분석만 빼고 보호자 발화를 그대로 저장했다
    expect(r.status).toBe(403);
    expect(saveMessages).not.toHaveBeenCalled();
    expect(runCognitiveAnalysis).not.toHaveBeenCalled();
  });
});

describe("세션 중 일일 한도 — 유료 후처리만 끊는다", () => {
  it("한도 안: 저장·인지 분석·기억 축적이 모두 돈다", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(r.body.dailyLimitReached).toBeUndefined();
    expect(saveMessages).toHaveBeenCalledTimes(1);
    expect(runCognitiveAnalysis).toHaveBeenCalledTimes(1);
    expect(extractAndSaveProfile).toHaveBeenCalledTimes(1);
  });

  it("한도 초과: **저장은 한다** · 인지 분석·프로필·요약은 건너뛴다 · 마무리 인사를 돌려준다", async () => {
    usage = { used: 200, limit: 200, exceeded: true, nearLimit: false, remaining: 0 };
    const r = await call();
    expect(r.status).toBe(200);
    // 🔒 이 턴은 이미 클라에서 일어났다 — 거부하면 대화 기록과 응급 마킹이 사라진다
    expect(saveMessages).toHaveBeenCalledTimes(1);
    // 🔒 2026-10-06 이전: 세션이 열리면 이 셋이 턴마다 무제한으로 돌았다(전부 유료 호출)
    expect(runCognitiveAnalysis).not.toHaveBeenCalled();
    expect(extractAndSaveProfile).not.toHaveBeenCalled();
    expect(maybeTriggerSummaryRollup).not.toHaveBeenCalled();
    expect(r.body.dailyLimitReached).toBe(true);
    expect(typeof r.body.message).toBe("string");
  });

  /**
   * 응급 발화는 한도와 무관하게 **통과** — /api/chat과 같은 정책(level ≥ 1, 백스톱 포함).
   * ⚠ 이 테스트의 첫 버전은 L3 초과 턴에 dailyLimitReached: true를 **기대**했다 — 틀린 동작을
   *   고정한 것이었다. 클라는 L3만 예외로 두었고, 그래서 L2 호소 중에 통화가 끊겼다(2026-10-06
   *   적대 감사 적발). 기대값이 틀리면 테스트는 결함을 지킨다. 등급별로 다시 고정한다.
   */
  it.each([
    ["L3", "갑자기 숨이 안 쉬어져", 3],
    ["L2", "허리가 너무 아파", 2],
  ] as const)("한도 초과여도 %s 응급은 통과 — 알림·저장·분석이 모두 돌고 통화를 끊는 신호를 보내지 않는다", async (_lv, text, level) => {
    // 전제를 먼저 확인한다 — 예문의 등급을 짐작으로 고르면 테스트가 엉뚱한 경로를 검증한다
    //   (처음 고른 "어지러워서 못 일어나겠어"는 L2가 아니라 L3 fall_injury였다)
    const { detectEmergency } = await import("@/lib/chat/emergency");
    expect(detectEmergency(text).level, `전제: "${text}"는 L${level}이어야 한다`).toBe(level);
    usage = { used: 250, limit: 200, exceeded: true, nearLimit: false, remaining: 0 };
    const r = await call(req(text, "괜찮으세요? 보호자분께 연락드릴게요"));
    expect(r.status).toBe(200);
    expect(r.body.emergencyLevel).toBe(level);
    // 🔒 안전 기능은 한도와 무관하다 — 알림이 나가고 저장에 응급 등급이 실린다
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
    expect(notifyGuardian.mock.calls[0][0].level).toBe(level);
    expect(saveMessages.mock.calls[0][0].emergencyLevel).toBe(level);
    // 🔒 끊는 신호가 가면 악화돼도 들어 줄 채널이 없다 — /api/chat은 이 턴을 정상 처리한다
    expect(r.body.dailyLimitReached).toBeUndefined();
    expect(runCognitiveAnalysis).toHaveBeenCalledTimes(1);
  });

  it("한도 초과 + L1 신호도 통과 (/api/chat의 기준은 level > 0)", async () => {
    usage = { used: 250, limit: 200, exceeded: true, nearLimit: false, remaining: 0 };
    const { detectEmergency } = await import("@/lib/chat/emergency");
    const l1 = "요즘 입맛이 하나도 없어";
    expect(detectEmergency(l1).level, "전제: 이 문장은 L1이어야 한다").toBe(1);
    const r = await call(req(l1, "식사를 잘 못 하셨구나"));
    expect(r.status, "오류 응답이면 아래 단언은 공허하다").toBe(200);
    expect(r.body.dailyLimitReached).toBeUndefined();
  });

  it("한도 초과 + **백스톱만** 잡는 응급도 통과 — 한도 판정이 정규식만 보면 안 된다", async () => {
    usage = { used: 250, limit: 200, exceeded: true, nearLimit: false, remaining: 0 };
    const { detectEmergency } = await import("@/lib/chat/emergency");
    const hidden = "모아둔 약 오늘 다 털어 넣을 거야";
    expect(detectEmergency(hidden).level, "전제: 정규식은 못 잡아야 이 테스트가 백스톱 경로를 본다").toBe(0);
    backstop.mockImplementation(async () => ({ level: 3, category: "suicidal", evidence: "llm" }));
    const r = await call(req(hidden, "무슨 일 있으세요?"));
    expect(r.status).toBe(200);
    // 🔒 백스톱을 건너뛰고 한도를 먼저 적용하면 이 턴이 마무리 인사로 끝나고 통화가 끊긴다
    expect(r.body.emergencyLevel).toBe(3);
    expect(r.body.dailyLimitReached).toBeUndefined();
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
  });

  it("한도 초과 + L1 누적 승격(L2)도 통과하고 알린다", async () => {
    usage = { used: 250, limit: 200, exceeded: true, nearLimit: false, remaining: 0 };
    recentL1 = 2;
    const r = await call(req("요즘 입맛이 하나도 없어", "식사를 잘 못 하셨구나"));
    expect(r.status).toBe(200);
    expect(r.body.emergencyLevel).toBe(2);
    expect(r.body.dailyLimitReached).toBeUndefined();
    expect(notifyGuardian.mock.calls[0]?.[0].level).toBe(2);
  });

  it("한도는 **이 대화·이 사용자**로 센다", async () => {
    await call();
    // 🔒 인자를 버리는 목이면 순서를 뒤바꿔도 녹색이었다(2026-10-06 재검토)
    expect(getDailyUsage).toHaveBeenCalledWith("c-1", "u-elder");
  });
});

describe("L1 24시간 누적 → L2 승격 — /api/chat과 같은 규칙", () => {
  const L1 = "요즘 입맛이 하나도 없어";

  it("최근 24시간 L1이 2건이면 이번 L1로 3건 → L2로 저장하고 보호자에게 알린다", async () => {
    recentL1 = 2;
    const r = await call(req(L1, "식사를 잘 못 하셨구나"));
    expect(r.status).toBe(200);
    // 🔒 2026-10-06 이전: Live엔 승격이 없어 L1을 하루 종일 말해도 알림 0건이었다
    expect(r.body.emergencyLevel).toBe(2);
    expect(saveMessages.mock.calls[0][0].emergencyLevel).toBe(2);
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
    expect(notifyGuardian.mock.calls[0][0].level).toBe(2);
    // 🔒 **이 대화**의 L1을 센다 — 다른 키를 넘겨도 목이 같은 수를 돌려주면 녹색이었다
    expect(countRecentL1Signals).toHaveBeenCalledWith("c-1");
  });

  it("누적이 모자라면 L1로 저장만 하고 알리지 않는다", async () => {
    recentL1 = 1;
    const r = await call(req(L1, "식사를 잘 못 하셨구나"));
    expect(r.status).toBe(200);
    expect(r.body.emergencyLevel).toBe(1);
    expect(saveMessages.mock.calls[0][0].emergencyLevel).toBe(1);
    expect(notifyGuardian).not.toHaveBeenCalled();
  });

  it("한도는 저장 **전에** 센다 — /api/chat과 같은 경계(1..limit턴 전부 정상 처리)", async () => {
    expect((await call()).status).toBe(200);
    // 🔒 저장 뒤에 세면 현재 턴이 포함돼 /api/chat보다 한 턴 일찍 끊긴다(F3)
    expect(calls.indexOf("usage")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("usage")).toBeLessThan(calls.indexOf("save"));
  });
});

describe("맥락 가드 재확인 — /api/chat과 같은 함수(evaluateEmergency)로 가른다 (2026-10-22)", () => {
  it("가드가 지운 L3 + 재확인 모름(error) → L3로 저장하고 보호자에게 알린다", async () => {
    const { detectEmergencyDetailed } = await import("@/lib/chat/emergency");
    const text = "딸이 와서 보더니 내 입이 돌아갔대";
    expect(detectEmergencyDetailed(text), "전제: 가드 켠 판정은 0, 가드가 지운 판정은 L3").toMatchObject({ result: { level: 0 }, suppressed: { level: 3 } });
    confirm.mockImplementation(async () => ({ kind: "error" }));
    const r = await call(req(text, "어머, 괜찮으세요?"));
    expect(r.status).toBe(200);
    expect(confirm).toHaveBeenCalledTimes(1);
    // 🔒 모름을 '아님'으로 읽으면 Gemini 장애 중에 가족이 알려 준 뇌졸중 신호(입이 돌아감)가 알림 없이 사라진다
    expect(r.body.emergencyLevel).toBe(3);
    expect(saveMessages.mock.calls[0][0].emergencyLevel).toBe(3);
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
    expect(notifyGuardian.mock.calls[0][0].level).toBe(3);
  });

  it("가드가 지운 L3 + 재확인 아님(none) → 응급 아님 — 알림·응급 마킹 없음", async () => {
    const { detectEmergencyDetailed } = await import("@/lib/chat/emergency");
    const text = "친구가 넘어져서 다쳤대";
    expect(detectEmergencyDetailed(text), "전제: 가드 켠 판정은 0, 가드가 지운 판정은 L3").toMatchObject({ result: { level: 0 }, suppressed: { level: 3 } });
    const r = await call(req(text, "저런, 많이 다치셨대요?"));
    expect(r.status).toBe(200);
    // 🔒 재확인 없이 가드 판정만 쓰면 이 시험은 공허하게 녹색이다 — 실제로 물었고 그 '아님'을 따랐는지 본다
    expect(confirm).toHaveBeenCalledTimes(1);
    // 🔒 백스톱이 '아님'이라고 한 남의 이야기에 L3 알림이 가면 보호자가 알림을 믿지 않게 된다
    expect(r.body.emergencyLevel).toBe(0);
    expect(saveMessages.mock.calls[0][0].emergencyLevel).toBeUndefined();
    expect(notifyGuardian).not.toHaveBeenCalled();
  });
});

describe("한도 대상 — /api/chat과 같은 범위(어르신만)", () => {
  it("일반인은 한도를 조회하지 않는다", async () => {
    session = { user: { id: "u-general", screeningMode: "general" } };
    usage = { used: 999, limit: 200, exceeded: true, nearLimit: false, remaining: 0 };
    const r = await call();
    expect(r.status).toBe(200);
    // 🔒 general은 목적·과금 주체가 다르다 — /api/chat은 mode === "user"에만 적용한다
    expect(getDailyUsage).not.toHaveBeenCalled();
    expect(r.body.dailyLimitReached).toBeUndefined();
    expect(saveMessages).toHaveBeenCalledTimes(1);
  });

  it("일반인의 발화는 어르신 인지 분석에 들어가지 않는다", async () => {
    session = { user: { id: "u-general", screeningMode: "general" } };
    // 오류로 끝나도 "분석이 안 불렸다"는 참이 된다 — 정상 처리였는지 먼저 확인한다
    expect((await call()).status).toBe(200);
    expect(runCognitiveAnalysis).not.toHaveBeenCalled();
  });
});

describe("전문가 계정 — Live엔 대리 귀속이 없다 (2026-10-06)", () => {
  it("pro는 403이고 아무것도 저장되지 않는다", async () => {
    session = { user: { id: "u-pro", screeningMode: "pro" } };
    const r = await call(req("숨이 안 쉬어져", "119"));
    // 🔒 이전: 대리 검진 중 Live로 넘어가면 기기 앞 환자의 발화·응급이 **검사자 계정**에 기록됐다
    expect(r.status).toBe(403);
    expect(saveMessages).not.toHaveBeenCalled();
    expect(notifyGuardian).not.toHaveBeenCalled();
  });
});

describe("AI 전사가 비어도 어르신 발화는 응급 판정을 받는다 (2026-10-06)", () => {
  it("aiText 없이 와도 200 — L3면 저장·알림", async () => {
    const res = await POST(new Request("http://localhost/api/live/turn", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "c-1", userText: "숨이 안 쉬어져" }),   // aiText 없음
    }));
    await Promise.all(pending.splice(0));
    const body = await res.json() as Record<string, unknown>;
    // 🔒 이전: aiText가 비면 400 → Gemini가 출력 전사를 안 낸 턴의 응급이 판정·알림 없이 사라졌다
    expect(res.status).toBe(200);
    expect(body.emergencyLevel).toBe(3);
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
    expect(saveMessages).toHaveBeenCalledTimes(1);
  });

  it("사용자 발화가 없으면 여전히 400", async () => {
    const res = await POST(new Request("http://localhost/api/live/turn", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: "c-1", userText: "", aiText: "네" }),
    }));
    expect(res.status).toBe(400);
  });
});

describe("최후 안전망 — 감지 결과를 클라에 돌려준다 (2026-10-06)", () => {
  it("응급 판정 전 DB가 죽어도 500 응답에 emergencyLevel이 실린다 (119 배너용)", async () => {
    convFails = true;
    const r = await call(req("숨이 안 쉬어져", "119"));
    expect(lastResortEmergency).toHaveBeenCalledTimes(1);
    // 🔒 이전: 판정·알림은 하고 응답엔 등급 없이 500 → 장애 중엔 어르신 화면에 119 안내가 안 떴다
    expect(r.status).toBe(500);
    expect(r.body.emergencyLevel).toBe(3);
  });

  it("안전망이 응급을 못 찾았으면 등급을 싣지 않는다", async () => {
    convFails = true;
    lastResortEmergency.mockResolvedValueOnce({ fired: false, level: 0, category: "none", reply: "" } as never);
    const r = await call(req("오늘 날씨 좋네", "네"));
    expect(r.status).toBe(500);
    expect(r.body.emergencyLevel).toBeUndefined();
  });
});
