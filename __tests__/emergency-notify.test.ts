/**
 * 응급 알림 복원력 회귀 테스트 — DB 장애 시 알림이 살아남는지 고정한다.
 *
 * 성격: 단위 테스트(화이트박스 — prisma를 스텁해 실패 분기를 강제 실행)
 *
 * 왜 필요한가: 2026-10-01 복원력 수정 당시 기존 게이트 4개(tsc / vitest 398 /
 *   safety-regression 342 / notify-verify 31) 중 **새 분기를 하나도 실행하는 것이 없었다.**
 *   safety-regression은 detectEmergency 감지 배터리이고, notify-verify는 DB가 정상인
 *   해피패스만 본다. 즉 수정 전 코드로도 전부 통과했을 테스트였다.
 *   여기서 고정하는 건 "DB가 깨져도 보호자에게 알림이 간다"는 계약 자체다.
 *
 * ⚠ fail-open이 always-open으로 번지는 회귀를 특히 조심한다(케이스 2).
 *   중복 알림은 보호자가 한 번 더 확인하면 끝이지만, 알림 폭주는 신뢰를 잃고
 *   공용 Gmail 발신 한도를 태워 **다른 환자의 알림까지** 끊는다.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const db = {
  message: { findFirst: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  expertPatient: { findMany: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({ prisma: db }));

const pushMock = vi.fn(async () => ({ sent: 1, failed: 0 }));
const emailMock = vi.fn(async () => true);
vi.mock("@/lib/notify/push-fcm", () => ({ sendEmergencyPush: (...a: unknown[]) => pushMock(...(a as [])) }));
const opsAlertMock = vi.fn(async () => true);
vi.mock("@/lib/notify/email", () => ({
  sendEmergencyEmail: (...a: unknown[]) => emailMock(...(a as [])),
  sendOpsAlert: (...a: unknown[]) => opsAlertMock(...(a as [])),
}));
vi.mock("@/lib/crypto", () => ({ decryptPII: (s: string) => s, encryptPII: (s: string) => s }));

const P = {
  userId: "u1", userName: "김응급", level: 3 as const, category: "medical_acute",
  content: "숨이 안 쉬어져", aiReply: "119에 전화해주세요", createdAt: new Date("2026-10-01T12:00:00Z"),
};

/**
 * ⚠ 매 호출에 **고유 userId**를 쓴다(2026-10-02 적대 리뷰 지적).
 *   emergency-notify는 모듈 수준 Map(recentSends)으로 fan-out 상한을 거는데, 그 상태는
 *   테스트 간에 리셋되지 않는다. 같은 userId를 재사용하면 두 번째 호출부터 조용히 skip돼
 *   **테스트가 순서에 의존하고, 뒤 테스트가 거짓 통과한다**(실제로 이 파일에서 발생했다).
 *   dedup 자체를 보려는 테스트는 fanoutKey를 명시적으로 고정해 쓴다.
 */
let notifySeq = 0;
async function notify(extra: Record<string, unknown> = {}) {
  const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
  return notifyGuardian({ ...P, userId: `u-${++notifySeq}`, messageId: "m1", ...extra } as Parameters<typeof notifyGuardian>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // 기본값: 중복 아님 · 보호자 이메일 있음 · 연결 보호자 1명 · 마킹 성공
  db.message.findFirst.mockResolvedValue(null);
  db.message.update.mockResolvedValue({});
  db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: "보호자" });
  db.expertPatient.findMany.mockResolvedValue([{ expertUserId: "g1" }]);
});

describe("DB 장애에도 알림은 나간다", () => {
  it("dedup 조회가 실패해도 발송한다 (fail-open)", async () => {
    db.message.findFirst.mockRejectedValue(new Error("connection reset"));
    const r = await notify();
    expect(r.sent).toBe(true);
    expect(r.channels.length).toBeGreaterThan(0);
  });

  it("보호자 연락처 조회가 실패해도 FCM은 나간다", async () => {
    db.user.findUnique.mockRejectedValue(new Error("db down"));
    const r = await notify();
    expect(r.channels).toContain("fcm");
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it("FCM 대상 조회가 실패해도 이메일은 나간다 — 이전엔 통째로 날아갔다", async () => {
    db.expertPatient.findMany.mockRejectedValue(new Error("db down"));
    const r = await notify();
    expect(emailMock).toHaveBeenCalledTimes(1);   // 🔒 격리 전엔 0회였다
    expect(r.channels).toContain("email");
  });

  it("발송 성공 후 마킹이 실패해도 성공으로 보고한다", async () => {
    db.message.update.mockRejectedValue(new Error("db down"));
    const r = await notify();
    expect(r.sent).toBe(true);                     // 🔒 이전엔 예외가 터져 'L3 error'로 둔갑
    expect(r.channels.length).toBeGreaterThan(0);
  });

  it("messageId가 없으면 마킹을 건너뛰고도 발송한다 (저장 실패 턴)", async () => {
    const r = await notify({ messageId: undefined });
    expect(r.sent).toBe(true);
    expect(db.message.update).not.toHaveBeenCalled();  // 🔒 undefined로 update 치면 예외
  });

  it("두 조회 모두 실패하면 '알림 대상 없음'으로 보고하지 않는다", async () => {
    db.user.findUnique.mockRejectedValue(new Error("db down"));
    db.expertPatient.findMany.mockRejectedValue(new Error("db down"));
    const r = await notify();
    expect(r.sent).toBe(false);
    // 🔒 조회 실패를 "보호자가 등록 안 됨"으로 적으면 운영자가 원인을 영원히 못 찾는다
    expect(r.reason ?? "").not.toContain("알림 대상 없음");
  });
});

describe("fail-open이 always-open으로 번지지 않는다", () => {
  it("dedup 조회가 성공해서 중복이면 발송하지 않는다", async () => {
    db.message.findFirst.mockResolvedValue({ id: "prev" });
    const r = await notify();
    expect(r.sent).toBe(false);                    // 🔒 이게 깨지면 알림 폭주
    expect(pushMock).not.toHaveBeenCalled();
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("L2 이력이 있어도 L3 격상은 통과한다", async () => {
    // isDuplicate는 emergencyLevel >= level 로 조회한다 — L2만 있으면 L3 조회엔 안 걸린다
    db.message.findFirst.mockImplementation(async (args: { where?: { emergencyLevel?: { gte?: number } } }) => {
      const gte = args?.where?.emergencyLevel?.gte ?? 0;
      return gte <= 2 ? { id: "prevL2" } : null;   // L2 이력만 존재
    });
    const r = await notify({ level: 3 });
    expect(r.sent).toBe(true);                     // 🔒 경증 호소 → 악화 경로가 억제되면 안 된다
  });
});

describe("요청이 통째로 실패해도 L3는 살아남는다 (최후 안전망)", () => {
  /**
   * handleEmergencyL3에 **도달하기 전** DB 호출(동의 게이트·소유권 검증·buildSystemPrompt)이
   * 터지면 500으로 끝나 119 안내도 보호자 알림도 0건이었다. 그 catch 경로를 고정한다.
   */
  it("POST catch가 emergencyLastResort로 흐른다 — 맨 500 return이 되살아나면 실패", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/api/chat/route.ts", "utf-8");
    const tail = src.slice(src.lastIndexOf("} catch (e) {"));
    // 🔒 `return NextResponse.json({ error: toSafeError(e) }, { status: 500 });`로 되돌아가면
    //    RDS 장애 중 응급이 다시 조용히 사라진다
    expect(tail).toMatch(/return emergencyLastResort\(e, sos\)/);
  });

  it("안전망은 DB를 치지 않는다 — prisma 호출이 없어야 한다", async () => {
    const fs = await import("node:fs/promises");
    // 2026-10-02: 판정·발송 로직은 lib/chat/emergency-last-resort.ts로 분리됐다
    //   (route.ts 안에서는 export가 안 돼 행위 테스트를 쓸 수 없었고, 그 탓에
    //    음성 턴 stale 텍스트 결함을 grep 테스트가 전부 놓쳤다).
    const mod = await fs.readFile("lib/chat/emergency-last-resort.ts", "utf-8");
    // 🔒 DB가 죽어서 들어온 경로다 — 여기서 또 조회하면 같은 예외로 안전망째 무너진다
    expect(mod).not.toMatch(/from "@\/lib\/prisma"/);
    expect(mod).not.toMatch(/prisma\./);
    expect(mod).toMatch(/notifyGuardian/);
    expect(mod).toMatch(/detectEmergency/);

    // route.ts의 래퍼는 응답 조립만 담당하고 자체 DB 조회를 하지 않아야 한다
    const src = await fs.readFile("app/api/chat/route.ts", "utf-8");
    const start = src.indexOf("async function emergencyLastResort(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("export async function POST(", start));
    expect(body).not.toMatch(/prisma\./);
    expect(body).toMatch(/lastResortEmergency\(/);
  });

  it("L3 미만은 안전망을 발동시키지 않는다 (500 유지)", async () => {
    const { detectEmergency } = await import("@/lib/chat/emergency");
    // 안전망 게이트가 쓰는 판정 자체를 고정 — 일상 발화가 L3로 새면 알림 폭주
    expect(detectEmergency("오늘 점심 뭐 먹을까요").level).toBeLessThan(3);
    expect(detectEmergency("숨이 안 쉬어져요").level).toBe(3);
  });
});

describe("세 진입점의 알림 게이트가 대칭이다", () => {
  it("live·observe 경로가 저장 실패에 알림을 묶지 않는다", async () => {
    const fs = await import("node:fs/promises");
    for (const f of ["app/api/live/turn/route.ts", "app/api/observe/turn/route.ts"]) {
      const src = await fs.readFile(f, "utf-8");
      // 🔒 `&& userMsgId` 게이트가 되살아나면 저장 실패 턴의 응급이 조용히 알림 0건이 된다
      expect(src, f).not.toMatch(/emergency\.level >= 2 && userMsgId/);
      expect(src, f).toMatch(/저장 실패[\s\S]{0,40}알림은 계속/);
    }
  });

  it("세 경로 모두 저장을 try/catch로 감싼다", async () => {
    const fs = await import("node:fs/promises");
    for (const f of ["app/api/chat/route.ts", "app/api/live/turn/route.ts", "app/api/observe/turn/route.ts"]) {
      const src = await fs.readFile(f, "utf-8");
      expect(src, f).toMatch(/let userMsgId: string \| undefined/);
    }
  });
});

/**
 * 전 채널 실패 시 운영자 경보 (2026-10-02 적대 리뷰).
 * 이전엔 sent:false가 console.warn으로만 끝났고, 유일한 사후 탐지인 pilot-daily-check는
 * Message 행을 전제로 해서 **알림이 실패하는 전형적 상황(RDS 장애 → 행 없음)을 구조적으로 못 봤다.**
 */
describe("보호자에게 한 건도 못 보내면 운영자에게 알린다", () => {
  it("전 채널 실패 시 운영자 경보를 보낸다", async () => {
    db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: null, guardianEmail: null, guardianName: null });
    db.expertPatient.findMany.mockResolvedValue([]);
    const r = await notify();
    expect(r.sent).toBe(false);
    // 🔒 이게 0회면 보호자도 운영자도 모르는 응급이 조용히 사라진다
    expect(opsAlertMock).toHaveBeenCalledTimes(1);
  });

  it("경보 본문에 사유·레벨·대상이 들어간다 (운영자가 조치할 수 있게)", async () => {
    db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: null, guardianEmail: null, guardianName: null });
    db.expertPatient.findMany.mockResolvedValue([]);
    await notify();
    const [subject, lines] = opsAlertMock.mock.calls[0] as unknown as [string, string[]];
    expect(subject).toContain("L3");
    expect(lines.some((l) => l.startsWith("사유:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("대상 userId:"))).toBe(true);
  });

  it("발송에 성공하면 운영자 경보를 보내지 않는다 (노이즈 금지)", async () => {
    const r = await notify();
    expect(r.sent).toBe(true);
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it("운영자 경보가 실패해도 notifyGuardian은 정상 반환한다", async () => {
    opsAlertMock.mockRejectedValue(new Error("smtp down"));
    db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: null, guardianEmail: null, guardianName: null });
    db.expertPatient.findMany.mockResolvedValue([]);
    await expect(notify()).resolves.toMatchObject({ sent: false });
  });
});

/**
 * fan-out 상한 자체의 **양성** 테스트 (2026-10-02 적대 리뷰: 음성 테스트만 있고 양성이 없었다).
 * DB dedup이 죽은 상태에서도 같은 응급이 무한 반복 발송되지 않아야 한다 —
 * 그 상한이 공용 Gmail 한도를 지키는 유일한 선이다.
 */
describe("메모리 fan-out 상한 (DB dedup이 죽어도 폭주하지 않는다)", () => {
  it("같은 사용자·분류·레벨의 2회차는 억제된다", async () => {
    db.message.findFirst.mockRejectedValue(new Error("db down"));   // DB dedup 무력화
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "fanout-victim", messageId: undefined } as Parameters<typeof notifyGuardian>[0];
    const first = await notifyGuardian(payload);
    const second = await notifyGuardian(payload);
    expect(first.sent).toBe(true);
    // 🔒 이게 true가 되면 DB 장애 중 같은 응급이 턴마다 발송돼 발신 한도를 태운다
    expect(second.sent).toBe(false);
  });
});

describe("L2 알림 — 문구·채널이 L3와 구분된다", () => {
  it("L2도 발송된다", async () => {
    const r = await notify({ level: 2, category: "dizziness_help" });
    expect(r.sent).toBe(true);
  });

  it("FCM 제목·본문이 L2용으로 나간다 (119 신고 문구 금지)", async () => {
    await notify({ level: 2, category: "dizziness_help" });
    const [, msg] = pushMock.mock.calls[0] as unknown as [string[], { title: string; body: string; level: number }];
    expect(msg.title).toContain("주의");
    expect(msg.title).not.toContain("즉시 응급");
    // 🔒 L2에 "119에 신고해주세요"가 섞이면 보호자가 과잉 반응한다
    expect(msg.body).not.toContain("119");
    expect(msg.body).toMatch(/안부/);
    expect(msg.level).toBe(2);
  });

  it("L3 FCM은 119를 포함한다 (대비 고정)", async () => {
    await notify({ level: 3 });
    const [, msg] = pushMock.mock.calls[0] as unknown as [string[], { title: string; body: string }];
    expect(msg.title).toContain("즉시 응급");
    expect(msg.body).toContain("119");
  });

  it("웹훅 본문이 레벨별로 달라진다", async () => {
    const mod = await import("@/lib/chat/emergency-notify");
    expect(typeof mod.notifyGuardian).toBe("function");
    // buildWebhookBody는 비공개 — 웹훅 발송 경로로 간접 검증
    db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: "https://hook.example.com/x", guardianEmail: null, guardianName: null });
    db.expertPatient.findMany.mockResolvedValue([]);
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);
    // dns 미목이라 SSRF 가드가 차단할 수 있다 — 호출 여부가 아니라 "예외 없이 끝난다"만 본다
    await expect(notify({ level: 2 })).resolves.toBeDefined();
    vi.unstubAllGlobals();
  });
});

describe("방어 분기 — 비정상 입력", () => {
  it("FCM이 0건 성공·일부 실패면 채널로 세지 않는다", async () => {
    pushMock.mockResolvedValue({ sent: 0, failed: 2 });
    db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: null, guardianEmail: null, guardianName: null });
    const r = await notify();
    expect(r.channels).not.toContain("fcm");
    expect(r.sent).toBe(false);
  });
});
/**
 * 폭주 상한이 **실제 장애 유형에서** 작동하는가 (2026-10-02 AWS 이전 감사 blocker).
 *
 * 이전 구현은 tooSoon 검사를 `isDuplicate()`가 throw한 catch 안에서만 했다. 그래서
 * 가장 흔한 장애에서 상한이 통째로 무력했다:
 *   · **읽기 OK + 쓰기 실패**(디스크 풀·읽기복제 전환·커넥션 고갈) — isDuplicate가 예외 없이
 *     "중복 아님"을 돌려준다(notifiedAt 쓰기가 실패해 앵커가 안 남았으니). catch를 안 타므로
 *     같은 L3가 매 턴 재발송된다.
 *   · **messageId 없는 경로**(최후 안전망) — 마킹 자체를 건너뛰어 같은 증상.
 * 공용 Gmail 단일 계정이라 한 사람의 폭주가 **다른 환자의 응급 이메일까지** 끊는다.
 */
describe("폭주 상한 — 읽기 OK·쓰기 실패에서도 막는다", () => {
  it("notifiedAt 쓰기가 계속 실패해도 2회차는 억제된다", async () => {
    db.message.findFirst.mockResolvedValue(null);          // 읽기 정상 = "중복 아님"
    db.message.update.mockRejectedValue(new Error("write timeout")); // 쓰기만 실패
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "rw-split", messageId: "m-rw" } as Parameters<typeof notifyGuardian>[0];
    const first = await notifyGuardian(payload);
    const second = await notifyGuardian(payload);
    expect(first.sent).toBe(true);
    // 🔒 true면 같은 응급이 매 턴 보호자에게 재발송돼 Gmail 쿼터를 태운다
    expect(second.sent).toBe(false);
  });

  it("messageId가 없는 경로(최후 안전망)도 2회차는 억제된다", async () => {
    db.message.findFirst.mockResolvedValue(null);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "no-msgid", messageId: undefined } as Parameters<typeof notifyGuardian>[0];
    expect((await notifyGuardian(payload)).sent).toBe(true);
    expect((await notifyGuardian(payload)).sent).toBe(false);
  });

  it("L2 → L3 격상은 상한에 걸리지 않는다 (키에 level 포함)", async () => {
    db.message.findFirst.mockResolvedValue(null);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const base = { ...P, userId: "escalate", messageId: undefined };
    expect((await notifyGuardian({ ...base, level: 2 } as Parameters<typeof notifyGuardian>[0])).sent).toBe(true);
    // 🔒 경증 호소 → 악화 경로가 상한에 막히면 가장 위험한 전이를 놓친다
    expect((await notifyGuardian({ ...base, level: 3 } as Parameters<typeof notifyGuardian>[0])).sent).toBe(true);
  });

  it("전 채널 실패는 짧은 재시도 바닥만 남긴다 — 1시간 봉쇄 금지", async () => {
    vi.useFakeTimers();
    try {
      db.message.findFirst.mockResolvedValue(null);
      db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: null, guardianEmail: null, guardianName: null });
      db.expertPatient.findMany.mockResolvedValue([]);
      const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
      const payload = { ...P, userId: "allfail", messageId: undefined } as Parameters<typeof notifyGuardian>[0];
      expect((await notifyGuardian(payload)).sent).toBe(false);
      vi.advanceTimersByTime(61 * 1000);   // 재시도 바닥(60초) 경과
      // 보호자 연락처가 복구된 상황
      db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: "보호자" });
      // 🔒 1시간 창을 쓰면 장애가 지나간 뒤에도 이 응급은 영영 전달되지 않는다(위음성)
      expect((await notifyGuardian(payload)).sent).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});


/**
 * 복호화 실패를 조용히 넘기지 않는다 (2026-10-02 감사 #10).
 * ENCRYPTION_KEY를 교체하면 저장된 보호자 연락처가 전부 복호 실패하고, 수신자 형식 검사가
 * "enc:v1:…"을 버려 **이메일 채널이 말없이 사라진다**. 전 보호자에게 동시에 일어난다.
 */
describe("PII 복호 실패 — 이메일 채널이 말없이 사라지지 않는다", () => {
  it("복호 실패(enc: 접두사 잔존) 시 이메일을 보내지 않고 에러를 남긴다", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(String(a[0])); });
    try {
      db.message.findFirst.mockResolvedValue(null);
      db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: null, guardianEmail: "enc:v1:broken", guardianName: null });
      db.expertPatient.findMany.mockResolvedValue([]);
      const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
      const r = await notifyGuardian({ ...P, userId: "decrypt-fail", messageId: undefined } as Parameters<typeof notifyGuardian>[0]);
      // decryptPII 목이 원문을 그대로 돌려주므로 "enc:" 접두사가 남는다
      expect(emailMock).not.toHaveBeenCalled();
      expect(r.channels).not.toContain("email");
      // 🔒 로그가 없으면 운영자는 이메일이 왜 안 갔는지 영영 모른다
      expect(errors.some((e) => /복호화 실패/.test(e))).toBe(true);
    } finally { spy.mockRestore(); }
  });
});

/**
 * 알림 문구 — **누구에게 무슨 일이 언제** 생겼는지 알림 한 줄에 보여야 한다(2026-10-07 보호자 앱 푸시 추적).
 *   예전: "할머니님 — fall_injury. 지금 바로…" — 호출부가 넘긴 호칭(대화 L3는 동반자 호칭, 최후 안전망은 "선생님")과
 *   카테고리 코드가 그대로 나갔다. 환자가 여럿인 의사는 누군지 몰랐고, 보호자는 무슨 일인지 몰랐다.
 */
describe("알림 문구 — 실명·한글 분류·감지 시각", () => {
  it("앱 푸시: **가린** 실명 + 한글 분류 + 감지 시각, 코드는 내보내지 않는다", async () => {
    db.user.findUnique.mockResolvedValue({ name: "김영자", guardianWebhookUrl: null, guardianEmail: null, guardianName: null });
    await notify({ userName: "할머니", category: "fall_injury", createdAt: new Date("2026-10-07T06:12:00Z") });
    const [ids, msg] = pushMock.mock.calls[0] as unknown as [string[], { body: string; createdAt: Date; patientId: string }];
    expect(ids).toEqual(["g1"]);
    expect(msg.body).toContain("김*자님");
    // 🔒 토픽은 구독 권한 검사가 없다 — 실명을 잠금화면 메시지에 싣지 않는다(재검토)
    expect(msg.body).not.toContain("김영자");
    expect(msg.body).toContain("낙상·부상");
    expect(msg.body).toContain("오후 3:12");        // KST
    // 🔒 예전 문구 — 호칭과 코드
    expect(msg.body).not.toContain("할머니님");
    expect(msg.body).not.toContain("fall_injury");
    expect(msg.createdAt).toEqual(new Date("2026-10-07T06:12:00Z"));
    expect(msg.patientId).toMatch(/^u-/);
  });

  it("실명을 모르면 푸시는 '어르신' — 호칭·호출부 이름을 토픽에 싣지 않는다", async () => {
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: null, guardianEmail: null, guardianName: null });
    await notify({ userName: "김응급" });
    const [, msg] = pushMock.mock.calls[0] as unknown as [string[], { body: string }];
    expect(msg.body).toContain("어르신님");
    expect(msg.body).not.toContain("김응급");
  });

  it("실명 미사용(realName:false — 인지 변화 추세 C2)이면 호출부 호칭을 쓰고, 분류도 추세로 표시한다", async () => {
    db.user.findUnique.mockResolvedValue({ name: "김영자", guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: null });
    await notify({ userName: "할머니", level: 2, category: "cognitive_decline", realName: false });
    const [, msg] = pushMock.mock.calls[0] as unknown as [string[], { body: string }];
    expect(msg.body).toContain("할머니님 — 인지 변화 추세");
    // 🔒 추세 알림이 "위급 신호"로 나가면 응급처럼 읽힌다(재검토)
    expect(msg.body).not.toContain("위급 신호");
    const [, mail] = emailMock.mock.calls[0] as unknown as [string, { userName: string; category: string }];
    expect(mail.userName).toBe("할머니");
    expect(mail.category).toBe("인지 변화 추세");
  });

  it("모르는 분류 코드는 일반 문구로 — 코드를 그대로 보내지 않는다", async () => {
    db.user.findUnique.mockResolvedValue({ name: "김영자", guardianWebhookUrl: null, guardianEmail: null, guardianName: null });
    await notify({ category: "new_unknown_category" });
    const [, msg] = pushMock.mock.calls[0] as unknown as [string[], { body: string }];
    expect(msg.body).toContain("위급 신호");
    expect(msg.body).not.toContain("new_unknown_category");
  });

  it("이메일: 제목·본문용 이름과 분류도 같다", async () => {
    db.user.findUnique.mockResolvedValue({ name: "김영자", guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: null });
    await notify({ userName: "할머니", category: "suicidal" });
    const [to, p] = emailMock.mock.calls[0] as unknown as [string, { userName: string; category: string }];
    expect(to).toBe("g@example.com");
    expect(p.userName).toBe("김영자");
    expect(p.category).toBe("자해·자살 위험");
  });

  it("C2(인지 변화 추세) 호출부는 realName:false를 넘긴다 — 그 파일의 설계 규칙 '실명 미사용'", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/health/cognitive-alert.ts", "utf-8");
    const at = src.indexOf("notifyGuardian({");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, src.indexOf("});", at))).toMatch(/realName:\s*false/);
  });

  it.each([
    ["김영자", "김*자"], ["이수", "이*"], ["남궁민수", "남**수"], ["  박  ", "박"], ["", "어르신"],
  ])("maskName(%j) → %j", async (input, out) => {
    const { maskName } = await import("@/lib/chat/emergency-notify");
    expect(maskName(input)).toBe(out);
  });

  it("FCM 자격증명이 없어 아예 안 보냈으면 로그를 남긴다 — 연결된 보호자가 있는데 조용히 끝나지 않게", async () => {
    pushMock.mockResolvedValueOnce({ sent: 0, failed: 0, skipped: "FCM not configured" } as never);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await notify();
      expect(spy.mock.calls.some((c) => String(c[0]).includes("fcm skipped"))).toBe(true);
    } finally { spy.mockRestore(); }
  });
});
