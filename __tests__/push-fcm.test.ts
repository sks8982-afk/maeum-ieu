/**
 * FCM 발송 메시지 **모양** — 보호자 휴대폰에 알림이 실제로 뜨는 조건을 고정한다.
 *
 * 2026-10-07 보호자 앱 푸시 추적에서 확인한 것:
 *   · 앱이 백그라운드·종료 상태일 때 배너는 **OS가 notification 필드로** 그린다. 앱의 백그라운드 핸들러는
 *     소리만 낸다(MaeumApp/index.js). 파일 주석이 "data-only"라고 잘못 적혀 있어, 누가 주석대로 "고치면"
 *     앱이 꺼져 있을 때 배너가 사라질 수 있었다 — notification·channelId·priority를 여기서 고정한다.
 *   · 서버 토픽 규칙(maeum_<id>)은 앱(App.jsx topicOf)과 같아야 한다.
 *   · 자격증명이 없으면 예전엔 아무 로그 없이 건너뛰었다.
 * 지금까지 push-fcm을 직접 부르는 테스트가 없었다(모든 테스트가 목으로 대체).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EXPECTED_FCM_PROJECT_ID } from "@/lib/notify/fcm-project";

const sendEach = vi.fn(async (msgs: unknown[]) => ({ successCount: msgs.length, failureCount: 0, responses: [] as unknown[] }));
type TopicMgmt = { successCount: number; failureCount: number; errors: { index: number; error: { code: string } }[] };
const unsubscribeFromTopic = vi.fn<(tokens: string[], topic: string) => Promise<TopicMgmt>>(
  async (tokens) => ({ successCount: tokens.length, failureCount: 0, errors: [] }),
);
const subscribeToTopic = vi.fn<(tokens: string[], topic: string) => Promise<TopicMgmt>>(
  async (tokens) => ({ successCount: tokens.length, failureCount: 0, errors: [] }),
);
vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(() => ({ name: "app" })),
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => ({ name: "app" })),
  cert: vi.fn((x: unknown) => x),
}));
vi.mock("firebase-admin/messaging", () => ({ getMessaging: vi.fn(() => ({ sendEach, unsubscribeFromTopic, subscribeToTopic })) }));

const SAVED = { b64: process.env.FCM_SERVICE_ACCOUNT_B64, raw: process.env.FCM_SERVICE_ACCOUNT, project: process.env.FCM_PROJECT_ID };
/** 서비스 계정 env 값 — 기본은 앱의 Firebase 프로젝트(7차 — 다른 프로젝트면 서버가 FCM을 끈다, lib/notify/fcm-project) */
const account = (projectId: string = EXPECTED_FCM_PROJECT_ID) =>
  JSON.stringify({ project_id: projectId, client_email: "c@p", private_key: "k" });

beforeEach(() => {
  vi.resetModules();   // 모듈 수준 캐시(cachedApp·warnedMissing) 초기화
  sendEach.mockClear();
  unsubscribeFromTopic.mockClear();
  subscribeToTopic.mockClear();
  delete process.env.FCM_SERVICE_ACCOUNT_B64;
  delete process.env.FCM_PROJECT_ID;
  process.env.FCM_SERVICE_ACCOUNT = account();
});
afterEach(() => {
  if (SAVED.b64 === undefined) delete process.env.FCM_SERVICE_ACCOUNT_B64; else process.env.FCM_SERVICE_ACCOUNT_B64 = SAVED.b64;
  if (SAVED.raw === undefined) delete process.env.FCM_SERVICE_ACCOUNT; else process.env.FCM_SERVICE_ACCOUNT = SAVED.raw;
  if (SAVED.project === undefined) delete process.env.FCM_PROJECT_ID; else process.env.FCM_PROJECT_ID = SAVED.project;
});

const PAYLOAD = {
  title: "🚨 즉시 응급 신호", body: "김영자님 — 낙상·부상 (오후 3:12). 지금 바로…", level: 3 as const,
  category: "fall_injury", createdAt: new Date("2026-10-07T06:12:00Z"), patientId: "elder-1",
};

type Msg = {
  topic: string;
  notification?: { title: string; body: string };
  data: Record<string, string>;
  android: { priority: string; notification: { channelId: string; priority: string; eventTimestamp?: Date } };
};

describe("메시지 모양 — 앱이 꺼져 있어도 배너가 뜨는 조건", () => {
  it("연결된 계정마다 maeum_<id> 토픽으로 하나씩 보낸다 — 앱의 구독 규칙과 같다", async () => {
    const { sendEmergencyPush } = await import("@/lib/notify/push-fcm");
    const r = await sendEmergencyPush(["g1", "pro-2"], PAYLOAD);
    expect(r).toEqual({ sent: 2, failed: 0, failures: [] });
    const msgs = sendEach.mock.calls[0][0] as Msg[];
    // 🔒 앱(App.jsx topicOf)은 'maeum_' + id. 서버가 다르면 구독한 휴대폰에도 아무것도 안 온다
    expect(msgs.map((m) => m.topic)).toEqual(["maeum_g1", "maeum_pro-2"]);
  });

  it("notification 필드가 있다 — 빼면(data-only) 앱이 꺼져 있을 때 배너가 안 뜬다", async () => {
    const { sendEmergencyPush } = await import("@/lib/notify/push-fcm");
    await sendEmergencyPush(["g1"], PAYLOAD);
    const [m] = sendEach.mock.calls[0][0] as Msg[];
    expect(m.notification).toEqual({ title: PAYLOAD.title, body: PAYLOAD.body });
  });

  it("높은 우선순위 + 앱이 만든 위급 채널(maeum-emergency)", async () => {
    const { sendEmergencyPush } = await import("@/lib/notify/push-fcm");
    await sendEmergencyPush(["g1"], PAYLOAD);
    const [m] = sendEach.mock.calls[0][0] as Msg[];
    // 🔒 채널이 없거나 다르면 소리·헤드업 없는 기본 채널로 떨어진다
    expect(m.android.priority).toBe("high");
    expect(m.android.notification.channelId).toBe("maeum-emergency");
    expect(m.android.notification.priority).toBe("max");
  });

  it("감지 시각이 실린다 — 늦게 받아도 방금 일처럼 보이지 않게", async () => {
    const { sendEmergencyPush } = await import("@/lib/notify/push-fcm");
    await sendEmergencyPush(["g1"], PAYLOAD);
    const [m] = sendEach.mock.calls[0][0] as Msg[];
    expect(m.android.notification.eventTimestamp).toEqual(PAYLOAD.createdAt);
    expect(m.data.patientId).toBe("elder-1");
    expect(m.data.level).toBe("3");
  });
});

/**
 * 기기 토큰 경로(2026-10-07) — 앱 1.2.0이 로그인한 계정으로 등록한 휴대폰마다 보낸다.
 *   토픽과 **같은 모양**이어야 같은 tag로 대체될 때 소리·채널이 같고, 지울 토큰은 "없는 기기" 오류만이어야 한다.
 */
type TokenMsg = Omit<Msg, "topic" | "android"> & {
  token?: string;
  topic?: string;
  android: Msg["android"] & { notification: Msg["android"]["notification"] & { tag?: string } };
};
const T = (n: number) => `tok${n}_` + "x".repeat(30);
/** 등록 휴대폰 한 대(토큰 + 그 휴대폰을 등록한 계정) — 5차부터 토큰 사본은 휴대폰마다 받는 계정(data.to)을 싣는다 */
const D = (n: number, userId = "g1") => ({ token: T(n), userId });
const OK = { success: true, messageId: "projects/p/messages/1" };
const FAIL = (code: string, message = "error", httpResponse?: unknown) => ({ success: false, error: { code, message, httpResponse } });
/** 실패 한 건의 기대값(6차 — push-fcm FcmFailure) */
const F = (target: string, code: string, kind: "token" | "config" | "transient") => ({ target, code, kind });
/** 서비스 계정 IAM 권한 거부 — firebase-admin은 이것도 mismatched-credential로 바꾼다(문구에 sender id가 없다) */
const DENIED = "Permission 'cloudmessaging.messages.create' denied on resource '//cloudresourcemanager.googleapis.com/projects/maeum' (or it may not exist).";
/** 원 응답의 FCM v1 오류 상세 — SENDER_ID_MISMATCH 증거가 문구가 아니라 여기에만 있는 경우 */
const senderIdDetail = { status: 403, headers: {}, data: { error: { status: "PERMISSION_DENIED", details: [
  { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "x" },
  { "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "SENDER_ID_MISMATCH" },
] } } };
const batch = (responses: { success: boolean }[]) => async () => ({
  successCount: responses.filter((r) => r.success).length,
  failureCount: responses.filter((r) => !r.success).length,
  responses,
});

describe("기기 토큰 발송", () => {
  it("token으로 보내고(토픽 아님), 나머지 모양은 토픽 메시지와 같다 — data.to만 다르다", async () => {
    const { sendEmergencyPush, sendEmergencyPushToTokens } = await import("@/lib/notify/push-fcm");
    sendEach.mockImplementationOnce(batch([OK, OK]));
    const r = await sendEmergencyPushToTokens([D(1), D(2)], { ...PAYLOAD, alertId: "alert-1" });
    expect(r).toEqual({ sent: 2, failed: 0, failures: [], invalidTokens: [], deliveredTokens: [T(1), T(2)] });
    const msgs = sendEach.mock.calls[0][0] as TokenMsg[];
    expect(msgs.map((m) => m.token)).toEqual([T(1), T(2)]);
    expect(msgs.every((m) => m.topic === undefined)).toBe(true);

    await sendEmergencyPush(["g1"], { ...PAYLOAD, alertId: "alert-1" });
    const [topicMsg] = sendEach.mock.calls[1][0] as TokenMsg[];
    // data.to는 토큰 사본에만 있다(아래 테스트) — 그것만 빼고 비교한다
    const shape = (m: TokenMsg) => ({ notification: m.notification, data: { ...m.data, notificationId: "-", to: "-" }, android: m.android });
    // 🔒 모양이 갈리면 같은 tag로 대체될 때 소리·채널·배너가 달라진다
    expect(shape(msgs[0])).toEqual(shape(topicMsg));
    expect(msgs[0].notification).toEqual({ title: PAYLOAD.title, body: PAYLOAD.body });
    expect(msgs[0].android.notification.channelId).toBe("maeum-emergency");
  });

  /**
   * data.to(2026-10-07 5차 계약) — 토큰 사본마다 그 휴대폰을 등록한 계정의 토픽 이름(userTopic — 앱이 구독하는 이름과 같은 문자열).
   *   한 번의 발송에 여러 보호자·의사의 휴대폰이 섞이므로 메시지를 휴대폰마다 만든다. 토픽 사본에는 싣지 않는다.
   */
  it("토큰 사본마다 data.to = userTopic(그 휴대폰의 계정) — 토픽 사본에는 없다", async () => {
    const { sendEmergencyPush, sendEmergencyPushToTokens, userTopic } = await import("@/lib/notify/push-fcm");
    sendEach.mockImplementationOnce(batch([OK, OK, OK]));
    await sendEmergencyPushToTokens([D(1, "g1"), D(2, "pro 2/x"), D(3, "g1")], { ...PAYLOAD, alertId: "alert-to" });
    const msgs = sendEach.mock.calls[0][0] as TokenMsg[];
    // 🔒 휴대폰과 계정이 어긋나면 앱이 남의 계정 앞 사본으로 보거나(버린다) 이전 계정 사본을 지금 계정 것으로 본다
    expect(msgs.map((m) => [m.token, m.data.to])).toEqual([[T(1), "maeum_g1"], [T(2), "maeum_pro_2_x"], [T(3), "maeum_g1"]]);
    expect(msgs[1].data.to).toBe(userTopic("pro 2/x"));
    await sendEmergencyPush(["g1", "pro 2/x"], { ...PAYLOAD, alertId: "alert-to" });
    const topicMsgs = sendEach.mock.calls[1][0] as TokenMsg[];
    expect(topicMsgs.map((m) => m.topic)).toEqual(["maeum_g1", "maeum_pro_2_x"]);
    for (const m of topicMsgs) expect("to" in m.data).toBe(false);
  });

  it("alertId → data.alertId·data.notificationId + android tag — 토큰·토픽 둘 다(같은 tag는 알림창에서 대체돼 하나만 남는다)", async () => {
    const { sendEmergencyPush, sendEmergencyPushToTokens } = await import("@/lib/notify/push-fcm");
    sendEach.mockImplementationOnce(batch([OK]));
    await sendEmergencyPushToTokens([D(1)], { ...PAYLOAD, alertId: "alert-9" });
    await sendEmergencyPush(["g1"], { ...PAYLOAD, alertId: "alert-9" });
    // 두 경로가 정확히 한 번씩 — 아래 반복이 한 경로만 보고 끝나면(다른 경로가 빠지면) 공허해진다
    expect(sendEach).toHaveBeenCalledTimes(2);
    const sent = sendEach.mock.calls.map((c) => (c[0] as TokenMsg[])[0]);
    expect(sent.map((m) => (m.token ? "token" : m.topic ? "topic" : "?"))).toEqual(["token", "topic"]);
    for (const m of sent) {
      expect(m.data.alertId).toBe("alert-9");
      // 🔒 앱은 data.notificationId로도 중복을 거른다 — 사본마다 다르면 한 위급 알림이 두 번 울린다
      expect(m.data.notificationId).toBe("alert-9");
      expect(m.android.notification.tag).toBe("alert-9");
    }
  });

  it("alertId가 없으면 tag를 달지 않고 notificationId는 메시지마다 새로(알림마다 쌓이는 예전 동작)", async () => {
    const { sendEmergencyPush, sendEmergencyPushToTokens } = await import("@/lib/notify/push-fcm");
    sendEach.mockImplementationOnce(batch([OK, OK]));
    await sendEmergencyPushToTokens([D(1), D(2)], PAYLOAD);
    await sendEmergencyPush(["g1"], PAYLOAD);
    expect(sendEach).toHaveBeenCalledTimes(2);
    const [byToken, byTopic] = sendEach.mock.calls.map((c) => c[0] as TokenMsg[]);
    for (const m of [...byToken, ...byTopic]) {
      expect("tag" in m.android.notification).toBe(false);
      expect("alertId" in m.data).toBe(false);
      expect(m.data.notificationId).toMatch(/^\d+_/);
    }
    // 휴대폰마다 다르다 — 같으면 앱이 둘째 휴대폰 알림을 중복으로 버린다
    expect(byToken[0].data.notificationId).not.toBe(byToken[1].data.notificationId);
    expect(byTopic[0].data.notificationId).toMatch(/^\d+_g1$/);
  });

  /**
   * 실패 분류(2026-10-07 6차 — push-fcm classifyFcmError). **배치 크기·구성과 상관없이** 오류 하나만 보고 정한다:
   *   토큰 탓(지운다) · 설정 탓(지우지 않는다 — 서비스 계정 권한·APNs·메시지 모양) · 일시(다시 보낸다).
   *   5차는 "같은 배치에 성공이 있으면 토큰 탓"·"모두 같은 오류면 아무것도 안 지움"으로 짐작해, 권한 거부가 섞인 배치에선 멀쩡한
   *   휴대폰을 지우고(성공이 섞였으니 토큰 탓), 한 대짜리 보호자의 죽은 토큰은 영영 남겼다(모두 같은 오류).
   */
  it("섞인 배치 — 실패마다 코드와 분류를 돌려주고, 토큰 탓만 지운다(설정 탓·일시는 남긴다)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendEmergencyPushToTokens } = await import("@/lib/notify/push-fcm");
    sendEach.mockImplementationOnce(batch([
      OK,
      FAIL("messaging/registration-token-not-registered"),
      FAIL("messaging/invalid-registration-token"),
      FAIL("messaging/invalid-argument", "The registration token is not a valid FCM registration token"),
      FAIL("messaging/internal-error"),
      FAIL("messaging/server-unavailable"),
      FAIL("messaging/mismatched-credential", "SenderId mismatch"),
      FAIL("messaging/mismatched-credential", DENIED),
      FAIL("messaging/third-party-auth-error", "Auth error from APNS or Web Push Service"),
      FAIL("messaging/invalid-argument", "Invalid value at 'message.android.notification.event_time'"),
      FAIL("messaging/message-rate-exceeded"),
    ]));
    const r = await sendEmergencyPushToTokens([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((n) => D(n)), PAYLOAD);
    expect(r.sent).toBe(1);
    expect(r.failed).toBe(10);
    expect(r.deliveredTokens).toEqual([T(1)]);
    expect(r.failures).toEqual([
      F(T(2), "messaging/registration-token-not-registered", "token"),
      F(T(3), "messaging/invalid-registration-token", "token"),
      F(T(4), "messaging/invalid-argument", "token"),
      F(T(5), "messaging/internal-error", "transient"),
      F(T(6), "messaging/server-unavailable", "transient"),
      F(T(7), "messaging/mismatched-credential", "token"),
      F(T(8), "messaging/mismatched-credential", "config"),
      F(T(9), "messaging/third-party-auth-error", "config"),
      F(T(10), "messaging/invalid-argument", "config"),
      F(T(11), "messaging/message-rate-exceeded", "transient"),
    ]);
    // 🔒 설정 탓(권한·APNs·메시지 모양)을 지우면 서버 문제 하나로 보호자 등록이 사라진다 — 다시 등록할 때까지 실명 사본이 끊긴다
    expect(r.invalidTokens).toEqual([T(2), T(3), T(4), T(7)]);
    warn.mockRestore();
  });

  it.each([
    ["없는 기기(UNREGISTERED)", "token", FAIL("messaging/registration-token-not-registered")],
    ["토큰 모양 오류", "token", FAIL("messaging/invalid-registration-token")],
    ["invalid-argument — 문구가 등록 토큰을 가리킨다", "token", FAIL("messaging/invalid-argument", "The registration token is not a valid FCM registration token")],
    ["mismatched-credential — 문구 SenderId mismatch", "token", FAIL("messaging/mismatched-credential", "SenderId mismatch")],
    ["mismatched-credential — 원 응답 FcmError SENDER_ID_MISMATCH", "token", FAIL("messaging/mismatched-credential", "Requested entity was not found.", senderIdDetail)],
    ["mismatched-credential — 권한 거부(PERMISSION_DENIED)", "config", FAIL("messaging/mismatched-credential", DENIED)],
    ["APNs 인증(third-party-auth-error)", "config", FAIL("messaging/third-party-auth-error", "Auth error from APNS or Web Push Service")],
    ["invalid-argument — 메시지 모양", "config", FAIL("messaging/invalid-argument", "Request contains an invalid argument.")],
    ["FCM 내부 오류", "transient", FAIL("messaging/internal-error")],
    ["FCM 일시 중단", "transient", FAIL("messaging/server-unavailable")],
    ["한도(QUOTA_EXCEEDED)", "transient", FAIL("messaging/message-rate-exceeded")],
    ["모르는 오류", "transient", FAIL("messaging/unknown-error")],
    ["목록에 없는 코드", "transient", FAIL("messaging/some-future-error")],
    // 8차 — 서버 자격증명 오류는 거절 증거(문구)가 있을 때만 설정 탓. 자세한 모양은 아래 "서버 자격증명 오류" describe(실제 SDK로 만든다)
    ["authentication-error — 거절 증거 없음", "transient", FAIL("messaging/authentication-error")],
    ["authentication-error — 거절된 OAuth 클라이언트(invalid_client)", "config", FAIL("messaging/authentication-error", "invalid_client: The OAuth client was disabled.")],
  ] as const)("휴대폰 한 대 — %s → %s(그 오류 하나로 정한다)", async (_, kind, resp) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendEmergencyPushToTokens } = await import("@/lib/notify/push-fcm");
    sendEach.mockImplementationOnce(batch([resp]));
    const r = await sendEmergencyPushToTokens([D(1)], PAYLOAD);
    expect(r.failures).toEqual([F(T(1), resp.error.code, kind)]);
    // 🔒 혼자 보내도 죽은 토큰은 지운다 — 5차의 "모두 같은 오류면 안 지움"은 휴대폰이 한 대뿐인 보호자의 죽은 토큰을 영영 남겼다
    expect(r.invalidTokens).toEqual(kind === "token" ? [T(1)] : []);
    warn.mockRestore();
  });

  it("권한 거부(PERMISSION_DENIED)는 다른 휴대폰이 받았어도·모두가 거절돼도 설정 탓 — 아무것도 지우지 않는다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendEmergencyPushToTokens } = await import("@/lib/notify/push-fcm");
    sendEach.mockImplementationOnce(batch([OK, FAIL("messaging/mismatched-credential", DENIED)]));
    const partial = await sendEmergencyPushToTokens([D(1), D(2)], PAYLOAD);
    // 🔒 5차는 "같은 배치에 성공이 있으면 토큰 탓"이라 이 휴대폰을 지웠다 — 서비스 계정 권한이 일부 요청에서만 흔들려도 등록이 사라졌다
    expect(partial.invalidTokens).toEqual([]);
    expect(partial.failures).toEqual([F(T(2), "messaging/mismatched-credential", "config")]);
    sendEach.mockImplementationOnce(batch([FAIL("messaging/mismatched-credential", DENIED), FAIL("messaging/mismatched-credential", DENIED)]));
    const all = await sendEmergencyPushToTokens([D(1), D(2)], PAYLOAD);
    expect(all.invalidTokens).toEqual([]);
    expect(all.failures.map((f) => f.kind)).toEqual(["config", "config"]);
    warn.mockRestore();
  });

  it("메시지 탓 invalid-argument는 다른 휴대폰이 받았어도 지우지 않는다 · 등록 토큰 문구면 배치 전체여도 지운다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendEmergencyPushToTokens } = await import("@/lib/notify/push-fcm");
    sendEach.mockImplementationOnce(batch([OK, FAIL("messaging/invalid-argument", "Request contains an invalid argument.")]));
    // 🔒 5차는 성공이 섞였다는 이유로 이 휴대폰을 지웠다 — 알림 모양 하나가 틀려도 휴대폰들이 지워진다
    expect((await sendEmergencyPushToTokens([D(1), D(2)], PAYLOAD)).invalidTokens).toEqual([]);
    const badToken = "The registration token is not a valid FCM registration token";
    sendEach.mockImplementationOnce(batch([FAIL("messaging/invalid-argument", badToken), FAIL("messaging/invalid-argument", badToken)]));
    expect((await sendEmergencyPushToTokens([D(1), D(2)], PAYLOAD)).invalidTokens).toEqual([T(1), T(2)]);
    warn.mockRestore();
  });

  it("SENDER_ID_MISMATCH 증거(문구·원 응답 상세)가 있으면 배치 전체가 그 오류여도 지운다 · 모두 '없는 기기'면 다 지운다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendEmergencyPushToTokens } = await import("@/lib/notify/push-fcm");
    sendEach.mockImplementationOnce(batch([
      FAIL("messaging/mismatched-credential", "SenderId mismatch"),
      FAIL("messaging/mismatched-credential", "Sender ID mismatch for this token"),
      FAIL("messaging/mismatched-credential", "Requested entity was not found.", senderIdDetail),
    ]));
    // 🔒 다른 Firebase 프로젝트의 토큰은 다시 보내도 같다 — 남기면 응급마다 그 휴대폰 때문에 경보가 쌓이고 "받는 휴대폰"으로 보인다
    expect((await sendEmergencyPushToTokens([D(1), D(2), D(3)], PAYLOAD)).invalidTokens).toEqual([T(1), T(2), T(3)]);
    sendEach.mockImplementationOnce(batch([FAIL("messaging/registration-token-not-registered"), FAIL("messaging/registration-token-not-registered")]));
    expect((await sendEmergencyPushToTokens([D(1), D(2)], PAYLOAD)).invalidTokens).toEqual([T(1), T(2)]);
    warn.mockRestore();
  });

  it("대상이 없으면 보내지 않는다 / 발송 자체가 터지면 그 오류 하나로 전부 실패(코드·분류) — 지울 토큰은 없다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendEmergencyPushToTokens } = await import("@/lib/notify/push-fcm");
    expect(await sendEmergencyPushToTokens([], PAYLOAD)).toMatchObject({ sent: 0, skipped: "no targets", failures: [], invalidTokens: [] });
    expect(sendEach).not.toHaveBeenCalled();
    sendEach.mockImplementationOnce(async () => { throw new Error("network down"); });
    // 🔒 throw는 휴대폰 탓이 아니다(네트워크) — 호출부가 알림 허용 여부와 상관없이 일시 "발송 실패"로 센다
    expect(await sendEmergencyPushToTokens([D(1), D(2)], PAYLOAD)).toEqual({
      sent: 0, failed: 2, failures: [F(T(1), "send-error", "transient"), F(T(2), "send-error", "transient")],
      invalidTokens: [], deliveredTokens: [],
    });
    // firebase-admin 오류는 코드를 단다 — 그 코드를 싣는다. 거절 증거(문구)가 없는 자격증명 오류는 일시다(8차 — 아래 describe)
    sendEach.mockImplementationOnce(async () => { throw Object.assign(new Error("denied"), { code: "app/invalid-credential" }); });
    expect((await sendEmergencyPushToTokens([D(1)], PAYLOAD)).failures).toEqual([F(T(1), "app/invalid-credential", "transient")]);
    warn.mockRestore();
  });

  it("자격증명이 없으면 보내지 않는다", async () => {
    delete process.env.FCM_SERVICE_ACCOUNT;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sendEmergencyPushToTokens } = await import("@/lib/notify/push-fcm");
    expect(await sendEmergencyPushToTokens([D(1)], PAYLOAD)).toMatchObject({ sent: 0, skipped: "FCM not configured" });
    expect(sendEach).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

/**
 * 서버 자격증명 오류의 분류(2026-10-07 8차 — push-fcm credentialFailureKind). 서버가 FCM 접근 토큰을 받지 못하면 firebase-admin 14는 그
 *   실패를 app/invalid-credential로 싸서 **메시지마다** 돌려준다(원래 오류 문구는 따옴표 안에). 그 모양을 **실제 SDK로** 만든다 —
 *   거절하는 가짜 자격증명을 단 앱에서 토큰을 요청한다(네트워크는 쓰지 않는다). SDK를 올려 모양이 바뀌면 여기서 드러난다.
 *   · 거절된 자격증명(invalid_grant 등) → 설정 탓 영구("config"): 예전엔 일시로 세 60초마다 다시 보냈고, 이메일이 닿으면 경보도 없었다
 *   · 네트워크(토큰 서버에 닿지 못함) → 일시. 먼저 본다(닿지 못했으면 거절됐는지 모른다)
 *   발송 자체가 throw한 경우도 같은 분류다(thrownFailures — 예전엔 늘 일시).
 */
describe("서버 자격증명 오류의 분류 — firebase-admin 14가 실제로 싼 모양으로", () => {
  let wrapSeq = 0;
  /** 실제 SDK(FirebaseAppInternals.refreshToken)가 접근 토큰 실패를 싼 오류 */
  async function sdkTokenError(inner: Error): Promise<Error & { code?: unknown; cause?: unknown }> {
    const sdk = await vi.importActual<typeof import("firebase-admin/app")>("firebase-admin/app");
    const app = sdk.initializeApp(
      { credential: { getAccessToken: () => Promise.reject(inner) }, projectId: EXPECTED_FCM_PROJECT_ID }, `token-error-${++wrapSeq}`,
    );
    try {
      await (app as unknown as { INTERNAL: { getToken(): Promise<unknown> } }).INTERNAL.getToken();
    } catch (e) {
      return e as Error & { code?: unknown; cause?: unknown };
    } finally {
      await sdk.deleteApp(app);
    }
    throw new Error("거절하는 자격증명인데 토큰을 받았다");
  }
  /** 토큰 서버의 거절 — google-auth-library가 만드는 문구("<error>: <error_description>" — gtoken getToken) */
  const rejected = (text: string) => new Error(text);
  /** 토큰 서버에 닿지 못함 — gaxios(node-fetch)가 만드는 문구와 시스템 오류 코드 */
  const network = (reason: string, code?: string) =>
    Object.assign(new Error(`request to https://oauth2.googleapis.com/token failed, reason: ${reason}`), code ? { code } : {});

  it("SDK가 싼 모양 — code app/invalid-credential, 원래 문구를 메시지에 싣고 원래 오류는 cause(분류가 기대는 것)", async () => {
    const inner = rejected("invalid_grant: Invalid JWT Signature.");
    const e = await sdkTokenError(inner);
    // 🔒 SDK가 이 모양을 바꾸면(코드·문구 위치) 거절된 자격증명이 다시 일시로 세진다 — 그때 이 단언이 먼저 깨진다
    expect(e.code).toBe("app/invalid-credential");
    expect(e.message).toContain('failed to fetch a valid Google OAuth2 access token with the following error: "invalid_grant: Invalid JWT Signature."');
    expect(e.cause).toBe(inner);
  });

  it.each([
    ["서비스 계정 키 폐기(invalid_grant: Invalid JWT Signature)", rejected("invalid_grant: Invalid JWT Signature."), "config"],
    ["서비스 계정 삭제(invalid_grant: account not found)", rejected("invalid_grant: Invalid grant: account not found"), "config"],
    ["서버 시계 어긋남(Invalid JWT)", rejected("invalid_grant: Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe."), "config"],
    ["OAuth 클라이언트 없음(invalid_client)", rejected("invalid_client: The OAuth client was not found."), "config"],
    ["OAuth 클라이언트 비활성(disabled_client)", rejected("disabled_client: The OAuth client was disabled."), "config"],
    ["OAuth 클라이언트 삭제(deleted_client)", rejected("deleted_client: The OAuth client was deleted."), "config"],
    ["unauthorized_client", rejected("unauthorized_client: Client is unauthorized to retrieve access tokens using this method."), "config"],
    ["토큰 서버 DNS 실패(ENOTFOUND)", network("getaddrinfo ENOTFOUND oauth2.googleapis.com", "ENOTFOUND"), "transient"],
    ["토큰 서버 DNS 일시 실패(EAI_AGAIN)", network("getaddrinfo EAI_AGAIN oauth2.googleapis.com", "EAI_AGAIN"), "transient"],
    ["연결 시간 초과(ETIMEDOUT)", network("connect ETIMEDOUT 142.250.0.95:443", "ETIMEDOUT"), "transient"],
    ["연결 끊김(ECONNRESET)", network("read ECONNRESET", "ECONNRESET"), "transient"],
    ["연결 거부(ECONNREFUSED)", network("connect ECONNREFUSED 10.0.0.1:443", "ECONNREFUSED"), "transient"],
    ["socket hang up", network("socket hang up", "ECONNRESET"), "transient"],
    ["fetch failed(undici)", rejected("fetch failed"), "transient"],
    // 네트워크 증거가 먼저다 — 닿지 못했으면 거절됐는지 모른다(프록시 이름에 "disabled"가 섞여도 일시)
    ["네트워크 + 거절처럼 읽히는 말", network("getaddrinfo EAI_AGAIN disabled-egress-proxy.internal", "EAI_AGAIN"), "transient"],
    ["그 밖(토큰 서버 503)", rejected("Request failed with status code 503"), "transient"],
  ] as const)("메시지마다 — %s → %s", async (_, inner, kind) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const e = await sdkTokenError(inner);
      const { sendEmergencyPushToTokens } = await import("@/lib/notify/push-fcm");
      sendEach.mockImplementationOnce(batch([{ success: false, error: e } as never, { success: false, error: e } as never]));
      const r = await sendEmergencyPushToTokens([D(1), D(2)], PAYLOAD);
      // 🔒 거절된 자격증명을 일시로 세면 고칠 때까지 모든 응급이 60초마다 다시 나가고, 이메일이 닿으면 경보도 없다
      expect(r.failures).toEqual([F(T(1), "app/invalid-credential", kind), F(T(2), "app/invalid-credential", kind)]);
      // 🔒 서버 문제다 — 보호자 휴대폰 등록은 지우지 않는다
      expect(r.invalidTokens).toEqual([]);
    } finally { warn.mockRestore(); }
  });

  it("발송 자체가 SDK 자격증명 오류로 throw해도 같은 분류 — 등록 휴대폰·토픽 모두(거절 → 영구, 네트워크 → 일시), 지우지 않는다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const grant = await sdkTokenError(rejected("invalid_grant: Invalid JWT Signature."));
      const offline = await sdkTokenError(network("getaddrinfo ENOTFOUND oauth2.googleapis.com", "ENOTFOUND"));
      const { sendEmergencyPush, sendEmergencyPushToTokens } = await import("@/lib/notify/push-fcm");
      sendEach.mockImplementationOnce(async () => { throw grant; });
      // 🔒 예전엔 throw는 늘 일시였다 — 키가 폐기돼 통째로 실패해도 60초마다 다시 보냈다
      expect(await sendEmergencyPushToTokens([D(1), D(2)], PAYLOAD)).toEqual({
        sent: 0, failed: 2, failures: [F(T(1), "app/invalid-credential", "config"), F(T(2), "app/invalid-credential", "config")],
        invalidTokens: [], deliveredTokens: [],
      });
      sendEach.mockImplementationOnce(async () => { throw grant; });
      expect((await sendEmergencyPush(["g1"], PAYLOAD)).failures).toEqual([F("g1", "app/invalid-credential", "config")]);
      sendEach.mockImplementationOnce(async () => { throw offline; });
      expect((await sendEmergencyPush(["g1"], PAYLOAD)).failures).toEqual([F("g1", "app/invalid-credential", "transient")]);
    } finally { warn.mockRestore(); }
  });
});

describe("자격증명 없음", () => {
  it("보내지 않고, 크게 한 번 로그를 남긴다 — 예전엔 아무 흔적이 없었다", async () => {
    delete process.env.FCM_SERVICE_ACCOUNT;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sendEmergencyPush } = await import("@/lib/notify/push-fcm");
    const r1 = await sendEmergencyPush(["g1"], PAYLOAD);
    const r2 = await sendEmergencyPush(["g1"], PAYLOAD);
    expect(r1.skipped).toMatch(/not configured/);
    expect(r2.skipped).toMatch(/not configured/);
    expect(sendEach).not.toHaveBeenCalled();
    // 🔒 운영에서 푸시가 통째로 꺼져 있어도 알 길이 없던 구멍 — 인스턴스당 한 번은 반드시 남긴다
    expect(err.mock.calls.filter((c) => String(c[0]).includes("FCM 자격증명 없음"))).toHaveLength(1);
    err.mockRestore();
  });
});

/**
 * 앱의 Firebase 프로젝트로 고정(2026-10-07 7차, lib/notify/fcm-project) — 다른 프로젝트의 서비스 계정이면 FCM을 끈다.
 *   그 자격증명으로 보내면 모든 등록 토큰이 SENDER_ID_MISMATCH(= "다른 프로젝트의 토큰" — 지운다)로 돌아와 보호자 휴대폰 등록이 모두
 *   지워졌다. 끄면 자격증명 없음과 같다: 보내지 않고(skipped = FCM_NOT_CONFIGURED — 위급 알림은 설정 탓 영구 실패로 경보), 토픽 해제는
 *   "unconfigured"(호출부가 행을 지우지 않는다), console.error는 인스턴스당 한 번(두 프로젝트 id만 — 키·이메일은 찍지 않는다).
 */
describe("Firebase 프로젝트 고정 — 서비스 계정이 앱의 프로젝트가 아니면 FCM을 끈다", () => {
  it("기대 프로젝트는 앱(google-services.json)의 프로젝트 id다", () => {
    // 🔒 바뀌면 서버가 운영 자격증명을 "다른 프로젝트"로 보고 위급 푸시를 통째로 끈다 — 앱을 다른 프로젝트로 다시 빌드할 때만 바꾼다
    expect(EXPECTED_FCM_PROJECT_ID).toBe("maeum-ieu-b6693");
  });

  it("다른 프로젝트의 서비스 계정 — 보내지 않고(FCM_NOT_CONFIGURED), 해제는 unconfigured, 큰 로그는 한 번(두 id만, 키·이메일 없음)", async () => {
    process.env.FCM_SERVICE_ACCOUNT = JSON.stringify({ project_id: "someone-else-123", client_email: "svc@someone-else.iam", private_key: "SECRET-KEY" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { sendEmergencyPush, sendEmergencyPushToTokens, unsubscribeFromUserTopic, findGoneTokens, FCM_NOT_CONFIGURED } = await import("@/lib/notify/push-fcm");
      expect(await sendEmergencyPush(["g1"], PAYLOAD)).toEqual({ sent: 0, failed: 0, skipped: FCM_NOT_CONFIGURED, failures: [] });
      expect(await sendEmergencyPushToTokens([D(1)], PAYLOAD)).toMatchObject({ sent: 0, skipped: FCM_NOT_CONFIGURED, invalidTokens: [] });
      expect(await unsubscribeFromUserTopic([T(1)], "g1")).toBe("unconfigured");
      expect(await findGoneTokens([T(1)])).toEqual([]);
      // 🔒 그 자격증명으로 보내면 SENDER_ID_MISMATCH가 모든 보호자 휴대폰 등록을 지운다
      expect(sendEach).not.toHaveBeenCalled();
      expect(unsubscribeFromTopic).not.toHaveBeenCalled();
      const logged = err.mock.calls.filter((c) => String(c[0]).includes("Firebase 프로젝트"));
      expect(logged).toHaveLength(1);
      expect(String(logged[0][0])).toContain("서비스 계정의 Firebase 프로젝트(someone-else-123)가 앱의 프로젝트(maeum-ieu-b6693)와 다르다");
      expect(JSON.stringify(err.mock.calls)).not.toMatch(/SECRET-KEY|svc@someone-else/);
    } finally { err.mockRestore(); }
  });

  it("project_id가 없어도 끈다 · FCM_PROJECT_ID로 기대 프로젝트를 바꾸면(다른 빌드) 그 프로젝트의 서비스 계정을 쓴다", async () => {
    process.env.FCM_SERVICE_ACCOUNT = JSON.stringify({ client_email: "c@p", private_key: "k" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const first = await import("@/lib/notify/push-fcm");
      expect((await first.sendEmergencyPush(["g1"], PAYLOAD)).skipped).toBe(first.FCM_NOT_CONFIGURED);
      vi.resetModules();
      process.env.FCM_SERVICE_ACCOUNT = account("staging-777");
      process.env.FCM_PROJECT_ID = " staging-777 ";
      const staging = await import("@/lib/notify/push-fcm");
      expect(await staging.sendEmergencyPush(["g1"], PAYLOAD)).toEqual({ sent: 1, failed: 0, failures: [] });
      expect(sendEach).toHaveBeenCalledTimes(1);
    } finally { err.mockRestore(); }
  });

  /**
   * 보내는 주소(FCM 엔드포인트 projects/<id>/messages:send)도 고정(2026-10-07 8차) — firebase-admin은 initializeApp 옵션의 projectId를
   *   자격증명의 프로젝트보다 먼저 쓴다. 검사를 통과한 자격증명이라도 주소가 자격증명에서 다시 정해지지 않게 같은 id를 넘긴다.
   */
  it("initializeApp에 기대 프로젝트 id를 projectId로 넘긴다 — FCM_PROJECT_ID로 바꾸면 그 id(8차)", async () => {
    const { sendEmergencyPush } = await import("@/lib/notify/push-fcm");
    await sendEmergencyPush(["g1"], PAYLOAD);
    const { initializeApp } = await import("firebase-admin/app");
    // 🔒 projectId가 빠지면 엔드포인트가 자격증명의 projectId(camelCase 먼저)로 정해진다
    expect(initializeApp).toHaveBeenCalledWith(expect.objectContaining({ projectId: EXPECTED_FCM_PROJECT_ID }));
    vi.resetModules();
    process.env.FCM_SERVICE_ACCOUNT = account("staging-777");
    process.env.FCM_PROJECT_ID = "staging-777";
    const staging = await import("@/lib/notify/push-fcm");
    await staging.sendEmergencyPush(["g1"], PAYLOAD);
    const { initializeApp: stagingInit } = await import("firebase-admin/app");
    expect(stagingInit).toHaveBeenCalledWith(expect.objectContaining({ projectId: "staging-777" }));
  });

  it("projectId(camelCase)가 다른 서비스 계정은 project_id가 맞아도 끈다 — firebase-admin은 projectId를 먼저 읽는다(8차)", async () => {
    process.env.FCM_SERVICE_ACCOUNT = JSON.stringify({ project_id: EXPECTED_FCM_PROJECT_ID, projectId: "someone-else-123", client_email: "c@p", private_key: "k" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { sendEmergencyPush, FCM_NOT_CONFIGURED } = await import("@/lib/notify/push-fcm");
      expect((await sendEmergencyPush(["g1"], PAYLOAD)).skipped).toBe(FCM_NOT_CONFIGURED);
      // 🔒 project_id만 보면 이 자격증명은 통과하고, firebase-admin은 다른 프로젝트 것으로 돈다
      expect(sendEach).not.toHaveBeenCalled();
      expect(err.mock.calls.some((c) => String(c[0]).includes("서비스 계정의 Firebase 프로젝트(someone-else-123)"))).toBe(true);
    } finally { err.mockRestore(); }
  });

  /**
   * 이미 초기화된 기본 앱(2026-10-07 9차) — 같은 프로세스의 다른 코드가 먼저 기본 앱을 만들었거나 개발 서버가 push-fcm만 다시 읽으면
   *   getFcmApp은 새로 초기화하지 않고 그 앱을 쓴다. 예전엔 그 앱의 프로젝트를 보지 않아, 서비스 계정 검사를 통과해도 그 앱의 프로젝트로
   *   나갔다. 이제 그 앱의 옵션 projectId·자격증명 projectId(firebase-admin이 엔드포인트를 정하는 두 값)를 같은 규칙으로 보고, 다르면
   *   서비스 계정 불일치와 같은 길(FCM_NOT_CONFIGURED·로그 한 번)로 끈다.
   *   ⚠ firebase-admin/app 목은 vi.resetModules로 새로 만들어지지 않는다 — 이 describe가 바꾼 getApps·getApp은 afterEach에서 되돌린다.
   */
  describe("이미 초기화된 기본 앱 — 그 앱의 프로젝트도 본다(9차)", () => {
    const E = EXPECTED_FCM_PROJECT_ID;
    /** 기본 앱이 이미 있는 상태 — getFcmApp은 getApps()가 비어 있지 않으면 getApp()을 다시 쓴다 */
    async function withExistingApp(options: Record<string, unknown>) {
      const sdk = await import("firebase-admin/app");
      const app = { name: "[DEFAULT]", options };
      vi.mocked(sdk.getApps).mockReturnValue([app] as never);
      vi.mocked(sdk.getApp).mockReturnValue(app as never);
      vi.mocked(sdk.initializeApp).mockClear();
      return { sdk, app };
    }
    afterEach(async () => {
      const sdk = await import("firebase-admin/app");
      vi.mocked(sdk.getApps).mockReset().mockImplementation(() => []);
      vi.mocked(sdk.getApp).mockReset().mockImplementation(() => ({ name: "app" }) as never);
    });

    it("다른 프로젝트의 기본 앱이면 서비스 계정이 맞아도 그 앱을 쓰지 않는다 — 보내지 않고, 해제는 unconfigured, 같은 큰 로그 한 번", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { sdk } = await withExistingApp({ projectId: "someone-else-123", credential: { projectId: "someone-else-123" } });
        const { sendEmergencyPush, sendEmergencyPushToTokens, unsubscribeFromUserTopic, FCM_NOT_CONFIGURED } = await import("@/lib/notify/push-fcm");
        expect(await sendEmergencyPush(["g1"], PAYLOAD)).toEqual({ sent: 0, failed: 0, skipped: FCM_NOT_CONFIGURED, failures: [] });
        expect(await sendEmergencyPushToTokens([D(1)], PAYLOAD)).toMatchObject({ sent: 0, skipped: FCM_NOT_CONFIGURED, invalidTokens: [] });
        expect(await unsubscribeFromUserTopic([T(1)], "g1")).toBe("unconfigured");
        // 🔒 그 앱으로 보내면 엔드포인트가 다른 프로젝트라 SENDER_ID_MISMATCH가 모든 보호자 휴대폰 등록을 지운다
        expect(sendEach).not.toHaveBeenCalled();
        expect(unsubscribeFromTopic).not.toHaveBeenCalled();
        expect(sdk.initializeApp).not.toHaveBeenCalled();
        const logged = err.mock.calls.filter((c) => String(c[0]).includes("Firebase"));
        expect(logged).toHaveLength(1);
        expect(String(logged[0][0])).toContain(`[push-fcm] 🔴 이미 초기화된 Firebase 기본 앱의 프로젝트(someone-else-123)가 앱의 프로젝트(${E})와 다르다 — FCM을 끈다`);
      } finally { err.mockRestore(); }
    });

    it.each([
      ["옵션은 맞고 자격증명이 다르다", { projectId: E, credential: { projectId: "other-cred" } }, "other-cred"],
      ["자격증명은 맞고 옵션이 다르다", { projectId: "other-opt", credential: { projectId: E } }, "other-opt"],
      ["둘 다 없다(어느 프로젝트인지 모른다)", { credential: {} }, "없음"],
    ])("%s → 끈다(그 값을 적는다)", async (_, options, shown) => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await withExistingApp(options);
        const { sendEmergencyPush, FCM_NOT_CONFIGURED } = await import("@/lib/notify/push-fcm");
        expect((await sendEmergencyPush(["g1"], PAYLOAD)).skipped).toBe(FCM_NOT_CONFIGURED);
        expect(sendEach).not.toHaveBeenCalled();
        expect(err.mock.calls.some((c) => String(c[0]).includes(`이미 초기화된 Firebase 기본 앱의 프로젝트(${shown})`))).toBe(true);
      } finally { err.mockRestore(); }
    });

    it.each([
      ["옵션·자격증명 둘 다", { projectId: E, credential: { projectId: E } }],
      ["옵션만(자격증명에 프로젝트 없음)", { projectId: E, credential: {} }],
      ["자격증명만", { credential: { projectId: E } }],
    ])("%s 기대 프로젝트면 그 앱을 그대로 쓴다 — 새로 초기화하지 않는다", async (_, options) => {
      const { sdk, app } = await withExistingApp(options);
      const { sendEmergencyPush } = await import("@/lib/notify/push-fcm");
      expect(await sendEmergencyPush(["g1"], PAYLOAD)).toEqual({ sent: 1, failed: 0, failures: [] });
      expect(sdk.initializeApp).not.toHaveBeenCalled();
      const { getMessaging } = await import("firebase-admin/messaging");
      expect(getMessaging).toHaveBeenLastCalledWith(app);
    });
  });
});

/**
 * 토픽 발송 실패(2026-10-07 4·6차) — 호출부(emergency-notify)가 "토픽 사본 발송 실패"를 운영자 경보에 코드와 함께 싣는다.
 *   6차: 보호자(계정)마다 코드와 분류(일시·설정 탓)를 돌려준다 — 일시만 dedup 앵커를 막고, 설정 탓(권한·APNs)은 경보에만 싣는다.
 */
describe("토픽 발송 실패 — 보호자마다 코드와 분류를 돌려준다", () => {
  it("일부·전부 실패면 실패한 보호자마다 코드·분류, 성공뿐이면 []", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendEmergencyPush } = await import("@/lib/notify/push-fcm");
    sendEach.mockImplementationOnce(batch([OK, FAIL("messaging/server-unavailable"), FAIL("messaging/mismatched-credential", DENIED)]));
    expect(await sendEmergencyPush(["g1", "g2", "g3"], PAYLOAD)).toEqual({
      sent: 1, failed: 2,
      // 🔒 권한 거부를 일시로 세면 서버 설정이 고쳐질 때까지 모든 응급이 60초마다 다시 나가고, 일시 중단을 영구로 세면 1시간 막힌다
      failures: [F("g2", "messaging/server-unavailable", "transient"), F("g3", "messaging/mismatched-credential", "config")],
    });
    sendEach.mockImplementationOnce(batch([FAIL("messaging/third-party-auth-error", "Auth error from APNS or Web Push Service")]));
    expect((await sendEmergencyPush(["g1"], PAYLOAD)).failures).toEqual([F("g1", "messaging/third-party-auth-error", "config")]);
    expect(await sendEmergencyPush(["g1"], PAYLOAD)).toEqual({ sent: 1, failed: 0, failures: [] });
    warn.mockRestore();
  });

  it("발송 자체가 터지면 전부 일시 실패 + 그 오류의 코드", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sendEmergencyPush } = await import("@/lib/notify/push-fcm");
    sendEach.mockImplementationOnce(async () => { throw Object.assign(new Error("quota"), { code: "messaging/quota-exceeded" }); });
    expect(await sendEmergencyPush(["g1", "g2"], PAYLOAD)).toEqual({
      sent: 0, failed: 2, failures: [F("g1", "messaging/quota-exceeded", "transient"), F("g2", "messaging/quota-exceeded", "transient")],
    });
    warn.mockRestore();
  });
});

/**
 * 서버 쪽 토픽 구독·해제(2026-10-07) — 등록 요청(POST — 응답 뒤, 3·4차)·보호자 화면의 휴대폰 삭제(DELETE { handle })의 짝.
 *   해제: 앱은 로그인해 있는 동안 토픽 구독을 유지하므로, 목록에서 지운 휴대폰은 서버가 끊어 줘야 토픽 사본까지 멈춘다.
 *     "삭제됨"을 보여 줄 때 해제도 끝나 있게 넉넉히(15초) 기다린다(4차). 로그아웃(DELETE { token })은 해제하지 않는다.
 *   구독: 로그인한 앱 휴대폰은 모두 계정 토픽을 유지한다 — 등록 요청마다 서버도 붙인다(5초).
 *   둘 다 최선 노력 — 상한, 실패는 로그만(등록·삭제 응답을 막지 않는다).
 *   결과(6차): 구독은 true/false, 해제는 "ok"·"failed"·"unconfigured"(FCM을 쓸 수 없음 — 7차부터 호출부는 해제를 확인할 수 없어 행을
 *   지우지 않는다, 503).
 */
describe.each([
  { fn: "subscribeToUserTopic", fcm: subscribeToTopic, other: unsubscribeFromTopic, what: "구독", capMs: 5000, ok: true, fail: false, noTokens: false, noCreds: false },
  { fn: "unsubscribeFromUserTopic", fcm: unsubscribeFromTopic, other: subscribeToTopic, what: "해제", capMs: 15_000, ok: "ok", fail: "failed", noTokens: "ok", noCreds: "unconfigured" },
] as const)("토픽 $what($fn)", ({ fn, fcm, other, what, capMs, ok, fail, noTokens, noCreds }) => {
  it("발송과 같은 토픽 이름 규칙(userTopic)으로, 그 FCM 호출만 한다", async () => {
    const mod = await import("@/lib/notify/push-fcm");
    expect(await mod[fn]([T(1), T(2)], "pro 2/x")).toBe(ok);
    // 🔒 이름 규칙이 다르면 엉뚱한 토픽을 다루고 성공으로 끝난다 — 지운 휴대폰이 토픽 사본을 계속 받거나, 되살린 휴대폰이 못 받는다
    expect(fcm).toHaveBeenCalledTimes(1);
    expect(fcm).toHaveBeenCalledWith([T(1), T(2)], "maeum_pro_2_x");
    // 🔒 구독·해제가 뒤바뀌면 로그아웃한 휴대폰이 다시 붙거나 등록한 휴대폰이 떨어진다
    expect(other).not.toHaveBeenCalled();
  });

  it("일부 실패·거절은 실패 + 로그 — throw하지 않는다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("@/lib/notify/push-fcm");
    fcm.mockResolvedValueOnce({ successCount: 0, failureCount: 1, errors: [{ index: 0, error: { code: "messaging/invalid-registration-token" } }] });
    expect(await mod[fn]([T(1)], "g1")).toBe(fail);
    fcm.mockRejectedValueOnce(new Error("network down"));
    await expect(mod[fn]([T(1)], "g1")).resolves.toBe(fail);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes(`토픽 ${what}`))).toHaveLength(2);
    warn.mockRestore();
  });

  it(`${capMs / 1000}초 안에 답이 없으면 더 기다리지 않는다(실패) — 그 전엔 기다린다`, async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fcm.mockImplementationOnce(() => new Promise<never>(() => {}));   // 끝내 답이 없다
      const mod = await import("@/lib/notify/push-fcm");
      let settled: unknown = "pending";
      const p = mod[fn]([T(1)], "g1").then((v) => { settled = v; });
      await vi.advanceTimersByTimeAsync(capMs - 1);
      // 🔒 삭제의 해제를 일찍 자르면 FCM이 잠깐 느릴 때 해제가 끝나지 않은 채 "삭제됨"이 된다(그 휴대폰은 토픽 사본을 계속 받는다)
      expect(settled).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      // 🔒 상한이 없으면 FCM이 멈췄을 때 등록·삭제 응답(after 작업)이 끝나지 않는다(await p 전에 본다 — 시간 초과가 아니라 이 단언으로 실패하게)
      expect(settled).toBe(fail);
      await p;
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("토큰이 없거나 자격증명이 없으면 FCM을 부르지 않는다", async () => {
    const mod = await import("@/lib/notify/push-fcm");
    expect(await mod[fn]([], "g1")).toBe(noTokens);
    vi.resetModules();
    delete process.env.FCM_SERVICE_ACCOUNT;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fresh = await import("@/lib/notify/push-fcm");
    // 🔒 해제는 자격증명 없음을 실패와 가른다 — 호출부가 "FCM을 쓸 수 없음"(503 unconfigured)으로 답한다(7차 — 행은 지우지 않는다)
    expect(await fresh[fn]([T(1)], "g1")).toBe(noCreds);
    expect(fcm).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

/**
 * 해제의 "없는 기기"(2026-10-07 6차) — FCM(IID)이 토큰별로 NOT_FOUND(registration-token-not-registered)라고 답하면 그 휴대폰은
 *   이미 토픽 사본을 받을 수 없다(앱을 지웠다). 예전엔 이것도 해제 실패라 보호자 화면에서 그 휴대폰을 끝내 지울 수 없었다(502).
 *   구독에서는 여전히 실패다 — 죽은 토큰은 구독되지 않았다.
 */
describe("토픽 해제 — 토큰별 '없는 기기'는 이미 해제된 것", () => {
  const GONE = { index: 0, error: { code: "messaging/registration-token-not-registered" } };

  it("해제: 모두 '없는 기기'면 ok(로그 없음) · 다른 실패가 섞이면 failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { unsubscribeFromUserTopic } = await import("@/lib/notify/push-fcm");
    unsubscribeFromTopic.mockResolvedValueOnce({ successCount: 1, failureCount: 1, errors: [{ ...GONE, index: 1 }] });
    expect(await unsubscribeFromUserTopic([T(1), T(2)], "g1")).toBe("ok");
    expect(warn).not.toHaveBeenCalled();
    unsubscribeFromTopic.mockResolvedValueOnce({ successCount: 0, failureCount: 2, errors: [GONE, { index: 1, error: { code: "messaging/internal-error" } }] });
    // 🔒 "없는 기기"가 섞였다고 다른 실패까지 해제로 치면, 아직 토픽 사본을 받는 휴대폰이 "삭제됨"이 된다
    expect(await unsubscribeFromUserTopic([T(1), T(2)], "g1")).toBe("failed");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("토픽 해제 일부 실패 1/2") && c[1] === "messaging/internal-error")).toBe(true);
    warn.mockRestore();
  });

  it("구독: '없는 기기'는 여전히 실패(false)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { subscribeToUserTopic } = await import("@/lib/notify/push-fcm");
    subscribeToTopic.mockResolvedValueOnce({ successCount: 0, failureCount: 1, errors: [GONE] });
    expect(await subscribeToUserTopic([T(1)], "g1")).toBe(false);
    warn.mockRestore();
  });
});

/**
 * 등록 토큰 점검(2026-10-07 4차) — 보호자 본인 목록(app/api/push/device GET)이 앱을 지운 휴대폰을 미리 걸러 낸다.
 *   FCM 시험 발송(dry run — 보내지 않는다)이어야 하고, 지울 토큰 판정은 실제 발송과 같은 규칙이며, 5초 상한·실패는 [](지우지 않는다).
 */
describe("등록 토큰 점검(findGoneTokens) — 보내지 않는 시험 발송", () => {
  it("dry run(sendEach의 둘째 인자 true)으로, 토큰마다 알림 없는 최소 메시지 — '없는 기기'만 돌려준다", async () => {
    const { findGoneTokens } = await import("@/lib/notify/push-fcm");
    sendEach.mockImplementationOnce(batch([OK, FAIL("messaging/registration-token-not-registered"), FAIL("messaging/internal-error")]));
    expect(await findGoneTokens([T(1), T(2), T(3)])).toEqual([T(2)]);
    expect(sendEach).toHaveBeenCalledTimes(1);
    const [msgs, dryRun] = sendEach.mock.calls[0] as unknown as [{ token: string; notification?: unknown }[], boolean];
    // 🔒 dry run이 아니면 목록을 열 때마다 보호자 휴대폰에 진짜 위급 알림이 울린다
    expect(dryRun).toBe(true);
    expect(msgs.map((m) => m.token)).toEqual([T(1), T(2), T(3)]);
    expect(msgs.every((m) => m.notification === undefined)).toBe(true);
  });

  it("invalid-argument가 배치 전체에 났으면(메시지 탓) 지우지 않는다 — 실제 발송과 같은 규칙", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { findGoneTokens } = await import("@/lib/notify/push-fcm");
    sendEach.mockImplementationOnce(batch([FAIL("messaging/invalid-argument", "bad field"), FAIL("messaging/invalid-argument", "bad field")]));
    expect(await findGoneTokens([T(1), T(2)])).toEqual([]);
    warn.mockRestore();
  });

  it("자격증명 안전 정리도 같은 규칙(6차) — 권한 거부는 전부든 일부든 지우지 않고, SENDER_ID 증거가 있으면 한 대여도 지운다", async () => {
    const { findGoneTokens } = await import("@/lib/notify/push-fcm");
    sendEach.mockImplementationOnce(batch([FAIL("messaging/mismatched-credential", DENIED), FAIL("messaging/mismatched-credential", DENIED)]));
    // 🔒 목록을 열 때마다(계정당 10분) 도는 점검이 서버 권한 문제로 보호자 휴대폰을 지우면 안 된다
    expect(await findGoneTokens([T(1), T(2)])).toEqual([]);
    sendEach.mockImplementationOnce(batch([OK, FAIL("messaging/mismatched-credential", DENIED)]));
    // 🔒 5차는 성공이 섞이면 지웠다 — 권한 거부는 몇 대가 섞여 있어도 서버 탓이다
    expect(await findGoneTokens([T(1), T(2)])).toEqual([]);
    sendEach.mockImplementationOnce(batch([FAIL("messaging/mismatched-credential", "Requested entity was not found.", senderIdDetail)]));
    expect(await findGoneTokens([T(1)])).toEqual([T(1)]);
  });

  it("5초 안에 답이 없으면 [] — 그 전엔 기다린다(목록 응답을 붙잡지 않는다)", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      sendEach.mockImplementationOnce(() => new Promise<never>(() => {}));
      const { findGoneTokens } = await import("@/lib/notify/push-fcm");
      let settled: unknown = "pending";
      const p = findGoneTokens([T(1)]).then((v) => { settled = v; });
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      // 🔒 상한이 없으면 FCM이 멈췄을 때 보호자 목록이 끝내 뜨지 않는다
      expect(settled).toEqual([]);
      await p;
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("점검이 터지면 [] — throw하지 않는다(아무것도 지우지 않는다)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { findGoneTokens } = await import("@/lib/notify/push-fcm");
    sendEach.mockImplementationOnce(async () => { throw new Error("network down"); });
    await expect(findGoneTokens([T(1)])).resolves.toEqual([]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("등록 토큰 점검 실패"))).toBe(true);
    warn.mockRestore();
  });

  it("토큰이 없거나 자격증명이 없으면 FCM을 부르지 않는다", async () => {
    const { findGoneTokens } = await import("@/lib/notify/push-fcm");
    expect(await findGoneTokens([])).toEqual([]);
    vi.resetModules();
    delete process.env.FCM_SERVICE_ACCOUNT;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fresh = await import("@/lib/notify/push-fcm");
    expect(await fresh.findGoneTokens([T(1)])).toEqual([]);
    expect(sendEach).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
