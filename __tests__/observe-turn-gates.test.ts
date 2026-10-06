/**
 * /api/observe/turn — **행위** 테스트(실제 라우트 핸들러를 호출한다).
 *
 * 상시 감시(관찰자 모드)는 혼자 있는 중증 어르신의 혼잣말을 듣는 경로다. 대화가 없어
 * 누가 대신 알아챌 기회도 없으므로, 여기서 응급을 버리면 그대로 끝이다.
 *
 * 2026-10-06 수정(적대 감사 → 재현): STT 저신뢰 게이트가 응급 판정 **앞**에 있어서
 *   보속증(같은 말 반복)으로 외친 L3가 저장·알림 없이 버려졌다. /api/chat은 2026-10-02에 고쳤다.
 *
 * 목 체제: 세션·레이트리밋·prisma·전사(Gemini)·백스톱·알림. 감지·STT 신뢰도 판정은 **실제 코드** —
 *   두 판정이 같은 발화에 대해 엇갈리는 게 이 결함의 본질이라, 둘 다 진짜여야 의미가 있다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const pending: Promise<unknown>[] = [];
const sttCalls: number[] = [];
const sttConfigs: { abortSignal?: unknown }[] = [];
let session: { user: { id: string; name?: string; screeningMode?: string } } | null = null;
let transcript = "";

vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>();
  return { ...mod, after: (fn: () => unknown) => { pending.push(Promise.resolve().then(fn)); } };
});
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true })) }));
const messageCreate = vi.fn<(a: { data: { emergencyLevel: number | null; content: string } }) => Promise<{ id: string }>>(
  async () => ({ id: "m-obs" }));
// L1 누적 집계(countRecentL1Signals → prisma.message.count) — 승격 검증에 쓴다
let recentL1 = 0;
/** 동의 조회 결과 — Error면 DB 장애를 흉내낸다 */
let consentRow: { consentedAt: Date | null } | null | Error = { consentedAt: new Date("2026-01-01") };
/** 상시 감시 별도 동의 행(sensitive_consent) — Error면 조회 실패. 기본은 처리·제공 둘 다 유효 */
const BOTH = [{ kind: "observe", version: "1.0" }, { kind: "observe_share", version: "1.0" }];
let sensitiveRows: { kind: string; version: string }[] | Error = BOTH;
// L1 집계 조회 인자 — "어느 대화의 L1을 세는지"를 확인한다(2026-10-06 재검토: 인자를 안 보면 엉뚱한 키도 녹색)
const countArgs: { where?: { conversationId?: string } }[] = [];
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => { if (consentRow instanceof Error) throw consentRow; return consentRow; }) },
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (!sql.includes("sensitive_consent")) return [];
      if (sensitiveRows instanceof Error) throw sensitiveRows;
      return sensitiveRows;
    }),
    conversation: { findUnique: vi.fn(async () => ({ id: "c-obs" })), create: vi.fn(async () => ({ id: "c-obs" })) },
    message: {
      create: (a: { data: { emergencyLevel: number | null; content: string } }) => messageCreate(a),
      count: vi.fn(async (a: { where?: { conversationId?: string } }) => { countArgs.push(a); return recentL1; }),
    },
  },
}));
// ⚠ 원본을 펼치고 필요한 것만 덮어쓴다. 처음엔 필요한 export만 골라 목을 만들었는데, 라우트가
//   LLM_TIMEOUT_MS·timeoutSignal을 새로 가져오자 undefined가 되어 **모든 턴이 500**이 됐다.
//   부분 목은 대상 모듈의 import가 늘 때마다 조용히 깨진다.
vi.mock("@/lib/chat/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat/llm")>()),
  // 전사 호출을 기록한다 — 막혀야 할 계정이면 전사(=건강 음성 처리) 자체가 일어나면 안 된다
  getGenAI: () => ({ models: { generateContent: async (req: { config?: { abortSignal?: unknown } }) => {
    sttCalls.push(1); sttConfigs.push(req?.config ?? {}); return {};
  } } }),
  extractText: () => transcript,          // 전사 결과를 테스트가 정한다
  logUsage: () => {},
}));
// 백스톱은 조절 가능해야 한다 — 항상 null이면 "응급 판정(백스톱 포함)이 STT 게이트보다 먼저"를
//   정규식에 잡히는 발화로만 검증하게 된다(2026-10-06 재검토)
const backstop = vi.fn<(t: string) => Promise<{ level: 0 | 1 | 2 | 3; category: string; evidence: string } | null>>(async () => null);
vi.mock("@/lib/chat/emergency-llm", () => ({ detectEmergencyLLM: (t: string) => backstop(t) }));
const notifyGuardian = vi.fn<(p: { level: number; content: string }) => Promise<{ sent: boolean }>>(
  async () => ({ sent: true }));
vi.mock("@/lib/chat/emergency-notify", () => ({ notifyGuardian: (p: { level: number; content: string }) => notifyGuardian(p) }));
vi.mock("@/lib/chat/emergency-last-resort", () => ({ lastResortEmergency: vi.fn(async () => {}) }));

const { POST } = await import("@/app/api/observe/turn/route");
const { evaluateSttConfidence } = await import("@/lib/chat/stt-confidence");
const { detectEmergency } = await import("@/lib/chat/emergency");

async function call(text: string) {
  transcript = text;
  const res = await POST(new Request("http://localhost/api/observe/turn", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio: "UklGRg==", mimeType: "audio/wav" }),
  }));
  await Promise.all(pending.splice(0));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(() => {
  pending.length = 0;
  recentL1 = 0;
  consentRow = { consentedAt: new Date("2026-01-01") };
  sensitiveRows = BOTH;
  sttCalls.length = 0;
  sttConfigs.length = 0;
  session = { user: { id: "u-elder", name: "김어르신", screeningMode: "user" } };
  messageCreate.mockClear();
  notifyGuardian.mockClear();
  countArgs.length = 0;
  backstop.mockReset();
  backstop.mockImplementation(async () => null);
});

describe("백스톱만 잡는 응급 — STT 저신뢰여도 버리지 않는다", () => {
  const HIDDEN = "따라갈래 영감 따라갈래 영감 따라갈래 영감 따라갈래 영감";

  it("전제: STT 게이트 탈락 + 정규식 0 (백스톱만이 이 응급을 볼 수 있다)", () => {
    expect(evaluateSttConfidence(HIDDEN).pass).toBe(false);
    expect(detectEmergency(HIDDEN).level).toBe(0);
  });

  it("백스톱이 L3면 저장·알림 (게이트가 정규식만 보고 먼저 버리면 안 된다)", async () => {
    backstop.mockImplementation(async () => ({ level: 3, category: "suicidal", evidence: "llm" }));
    const r = await call(HIDDEN);
    expect(r.status).toBe(200);
    // 🔒 STT 게이트를 백스톱보다 먼저 두거나 정규식 결과로만 판정하면 { skipped: true }로 끝난다
    expect(r.body.skipped).toBeUndefined();
    expect(r.body.emergencyLevel).toBe(3);
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
  });

  it("백스톱도 응급이 아니면 그대로 버린다 (비용·노이즈 보호)", async () => {
    const r = await call(HIDDEN);
    expect(r.body.skipped).toBe(true);
    expect(messageCreate).not.toHaveBeenCalled();
  });
});

describe("보속증 외침 — STT 저신뢰여도 응급은 버리지 않는다", () => {
  const PERSEVERATION = "죽고 싶어 죽고 싶어 죽고 싶어 죽고 싶어";

  it("전제: 이 발화는 STT 게이트에서 탈락하면서 동시에 L3다 (두 판정이 엇갈린다)", () => {
    // 이 전제가 깨지면(예: STT 게이트가 반복을 허용하게 바뀌면) 아래 테스트는 다른 것을 검증하게 된다
    expect(evaluateSttConfidence(PERSEVERATION).pass).toBe(false);
    expect(detectEmergency(PERSEVERATION).level).toBe(3);
  });

  it("저장되고, 응급 등급이 실리고, 보호자 알림이 나간다", async () => {
    const r = await call(PERSEVERATION);
    expect(r.status).toBe(200);
    // 🔒 2026-10-06 이전: { ok: true, skipped: true, reason: "vocabulary collapse" }로 끝났다
    expect(r.body.skipped).toBeUndefined();
    expect(r.body.emergencyLevel).toBe(3);
    expect(messageCreate).toHaveBeenCalledTimes(1);
    expect(messageCreate.mock.calls[0][0].data.emergencyLevel).toBe(3);
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
    expect(notifyGuardian.mock.calls[0][0].level).toBe(3);
  });
});

describe("저신뢰 + 응급 아님 — 기존처럼 버린다 (비용·노이즈 보호)", () => {
  it("반복 잡담은 저장하지 않는다", async () => {
    const t = "그래 그래 그래 그래 그래 그래";
    expect(evaluateSttConfidence(t).pass, "전제: 저신뢰").toBe(false);
    expect(detectEmergency(t).level, "전제: 응급 아님").toBe(0);
    const r = await call(t);
    expect(r.body.skipped).toBe(true);
    expect(messageCreate).not.toHaveBeenCalled();
    expect(notifyGuardian).not.toHaveBeenCalled();
  });

  it("빈 전사는 저장하지 않고, 유료 백스톱도 부르지 않는다", async () => {
    const r = await call("");
    expect(r.body.skipped).toBe(true);
    expect(messageCreate).not.toHaveBeenCalled();
    // 🔒 상시 감시는 침묵·잡음 조각이 잦다 — 빈 전사마다 LLM을 부르면 비용이 조각 수만큼 샌다
    expect(backstop).not.toHaveBeenCalled();
  });
});

describe("정상 신뢰도 응급 — 원래 경로 회귀 확인", () => {
  it("한 번 외친 L3도 그대로 알림", async () => {
    const r = await call("숨이 안 쉬어져");
    expect(r.status).toBe(200);
    expect(r.body.emergencyLevel).toBe(3);
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
  });
});

describe("L1 혼잣말 24시간 누적 → L2 승격 — /api/chat과 같은 규칙", () => {
  const L1 = "요즘 입맛이 하나도 없어";

  it("전제: 예문은 L1이다", () => {
    expect(detectEmergency(L1).level).toBe(1);
  });

  it("최근 24시간 L1이 2건이면 이번 것으로 3건 → L2로 저장하고 보호자에게 알린다", async () => {
    recentL1 = 2;
    const r = await call(L1);
    expect(r.status).toBe(200);
    // 🔒 2026-10-06 이전: 상시 감시엔 승격이 없어, 대화가 어려운 어르신이 하루 종일 "입맛이 없다"고
    //   혼잣말해도 보호자에게 아무것도 가지 않았다(이 경로에서 L1은 죽은 규칙이었다)
    expect(r.body.emergencyLevel).toBe(2);
    expect(messageCreate.mock.calls[0][0].data.emergencyLevel).toBe(2);
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
    expect(notifyGuardian.mock.calls[0][0].level).toBe(2);
    // 🔒 **이 어르신의 대화**(c-obs) L1을 센다 — 목이 인자를 안 보면 엉뚱한 키도 녹색이었다
    expect(countArgs.some((a) => a.where?.conversationId === "c-obs")).toBe(true);
  });

  it("누적이 모자라면 L1로 저장만 한다", async () => {
    recentL1 = 0;
    const r = await call(L1);
    expect(r.status).toBe(200);
    expect(messageCreate.mock.calls[0][0].data.emergencyLevel).toBe(1);
    expect(notifyGuardian).not.toHaveBeenCalled();
  });
});

describe("서버·클라 상한의 관계", () => {
  it("클라 요청 상한 > 서버 감시 전사 상한 + 백스톱(8s)", async () => {
    const { readFile } = await import("node:fs/promises");
    const server = await readFile("app/api/observe/turn/route.ts", "utf-8");
    const client = await readFile("app/observe/page.tsx", "utf-8");
    const s = Number(server.match(/OBSERVE_STT_TIMEOUT_MS = Math\.max\(LLM_TIMEOUT_MS\.stt, ([\d_]+)\)/)![1].replace(/_/g, ""));
    const c = Number(client.match(/TURN_TIMEOUT_MS = ([\d_]+);/)![1].replace(/_/g, ""));
    // 🔒 클라가 먼저 끊으면 서버는 계속 처리해 알림은 나가지만, 어르신 화면엔 응급 안내가 뜨지 않는다
    expect(c, `클라 ${c}ms vs 서버 ${s}+8000ms`).toBeGreaterThan(s + 8_000);
  });
});

describe("전사 타임아웃 (2026-10-06)", () => {
  it("전사 호출에 중단 신호가 실린다 — Gemini가 매달려도 요청이 끝난다", async () => {
    await call("오늘 날씨 좋네");
    expect(sttConfigs.length).toBe(1);
    // 🔒 이전엔 신호가 없어, 전사가 매달리는 동안 요청이 끝나지 않았고 클라는 그 사이 조각을 버렸다
    expect(sttConfigs[0].abortSignal).toBeInstanceOf(AbortSignal);
  });
});

describe("감시 대상은 어르신 본인 계정만 (2026-10-06)", () => {
  it.each(["guardian", "pro", "general"])("%s 계정은 403이고 전사·저장·알림이 일어나지 않는다", async (role) => {
    session = { user: { id: `u-${role}`, screeningMode: role } };
    const r = await call("숨이 안 쉬어져");
    // 🔒 이전: 보호자 계정으로 켜면 어르신 발화·응급이 **보호자 계정**에 기록되고, 알림 대상도
    //   보호자 계정 기준이라 사실상 아무에게도 안 가는데 화면엔 "보냈어요"가 떴다
    expect(r.status).toBe(403);
    expect(r.body.wrongRole).toBe(true);
    expect(sttCalls).toEqual([]);
    expect(messageCreate).not.toHaveBeenCalled();
    expect(notifyGuardian).not.toHaveBeenCalled();
  });
});

describe("건강정보 수집 동의 (2026-10-06)", () => {
  it("미동의 계정은 403 needConsent — 전사(건강 음성 처리) 자체를 하지 않는다", async () => {
    consentRow = { consentedAt: null };
    const r = await call("숨이 안 쉬어져");
    expect(r.status).toBe(403);
    expect(r.body.needConsent).toBe(true);
    expect(sttCalls).toEqual([]);
    expect(messageCreate).not.toHaveBeenCalled();
  });

  it("⚠ 동의 **조회가 실패**(DB 장애)하면 감시를 멈추지 않는다 — 응급은 계속 잡는다", async () => {
    consentRow = new Error("db down");
    const r = await call("숨이 안 쉬어져");
    // 🔒 의도된 비대칭: 이 경로는 DB가 흔들려도 응급 감지가 돌도록 만들어져 있다. 동의 조회 실패로
    //   막으면 장애 중 감지가 통째로 꺼진다. DB가 정상이면 미동의는 위 테스트처럼 반드시 막힌다.
    expect(r.status).toBe(200);
    expect(r.body.emergencyLevel).toBe(3);
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
  });
});

/**
 * 상시 감시 **별도 동의**(2026-10-06) — 음성·건강정보 처리(제23조) + 보호자·의사 제공(제17조), 각각.
 *   예전엔 건강정보 동의(v1.1)만 봤다. v1.1은 주변 소리 청취·혼잣말 전사·Google 전송을 고지하지 않는다.
 */
describe("상시 감시 별도 동의 (2026-10-06)", () => {
  it.each([
    ["동의 없음", []],
    ["처리만 있고 제공 동의 없음", [{ kind: "observe", version: "1.0" }]],
    ["제공만 있고 처리 동의 없음", [{ kind: "observe_share", version: "1.0" }]],
    ["예전 문안 버전의 동의", [{ kind: "observe", version: "0.9" }, { kind: "observe_share", version: "0.9" }]],
  ])("%s → 403 needObserveConsent, 전사(=Google 전송)·저장·알림 없음", async (_label, rows) => {
    sensitiveRows = rows;
    const r = await call("숨이 안 쉬어져");
    expect(r.status).toBe(403);
    expect(r.body.needObserveConsent).toBe(true);
    // 🔒 막혀야 할 때 전사가 일어나면 동의 없이 음성이 국외(Google)로 간 것이다
    expect(sttCalls).toEqual([]);
    expect(messageCreate).not.toHaveBeenCalled();
    expect(notifyGuardian).not.toHaveBeenCalled();
  });

  it("동의 테이블이 아직 없으면(배포 순서 어긋남) 막는다 — 장애로 보고 통과시키지 않는다", async () => {
    sensitiveRows = new Error(`Raw query failed. Code: \`42P01\`. Message: \`relation "sensitive_consent" does not exist\``);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call("숨이 안 쉬어져");
    // 🔒 이걸 "조회 실패"로 보면 아래 비대칭(장애 중 계속)을 타고 동의 없이 감시가 돈다
    expect(r.status).toBe(403);
    expect(r.body.needObserveConsent).toBe(true);
    expect(sttCalls).toEqual([]);
  });

  it("⚠ DB 전체 장애(두 동의 조회 모두 실패)면 감시를 멈추지 않는다 — 건강정보 동의와 같은 비대칭", async () => {
    consentRow = new Error("connection refused");
    sensitiveRows = new Error("connection refused");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call("숨이 안 쉬어져");
    expect(r.status).toBe(200);
    expect(r.body.emergencyLevel).toBe(3);
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
  });

  it("건강정보 동의 조회는 되는데 별도 동의 조회만 실패하면 처리하지 않는다(503) — 계속되는 고장일 수 있다", async () => {
    sensitiveRows = new Error('permission denied for table sensitive_consent');
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call("숨이 안 쉬어져");
    // 🔒 이걸 장애로 보고 통과시키면 권한 오류 같은 영구 고장 동안 동의 없이 감시가 계속 돈다
    expect(r.status).toBe(503);
    expect(sttCalls).toEqual([]);
    expect(messageCreate).not.toHaveBeenCalled();
    // 클라가 감시를 끄는 신호(needObserveConsent)는 아니다 — 일시 오류로 보고 다음 조각을 계속 보낸다
    expect(r.body.needObserveConsent).toBeUndefined();
  });
});

describe("위급 신호가 없는 말은 저장하지 않는다 (2026-10-06 — 동의서·처리방침 고지)", () => {
  it("일상 혼잣말은 전사 결과만 돌려주고 기록을 남기지 않는다", async () => {
    const t = "오늘 날씨가 참 좋네 빨래나 널어야겠다";
    expect(detectEmergency(t).level, "전제: 응급 아님").toBe(0);
    expect(evaluateSttConfidence(t).pass, "전제: 신뢰도 통과").toBe(true);
    const r = await call(t);
    expect(r.status).toBe(200);
    expect(r.body.emergencyLevel).toBe(0);
    expect(r.body.text).toBe(t);
    // 🔒 예전엔 혼잣말 전부를 "[관찰]"로 탈퇴 때까지 쌓았다 — 읽는 곳도 없는 민감정보
    expect(messageCreate).not.toHaveBeenCalled();
    expect(notifyGuardian).not.toHaveBeenCalled();
  });
});
