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

const sendEach = vi.fn(async (msgs: unknown[]) => ({ successCount: msgs.length, failureCount: 0, responses: [] }));
vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(() => ({ name: "app" })),
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => ({ name: "app" })),
  cert: vi.fn((x: unknown) => x),
}));
vi.mock("firebase-admin/messaging", () => ({ getMessaging: vi.fn(() => ({ sendEach })) }));

const SAVED = { b64: process.env.FCM_SERVICE_ACCOUNT_B64, raw: process.env.FCM_SERVICE_ACCOUNT };

beforeEach(() => {
  vi.resetModules();   // 모듈 수준 캐시(cachedApp·warnedMissing) 초기화
  sendEach.mockClear();
  delete process.env.FCM_SERVICE_ACCOUNT_B64;
  process.env.FCM_SERVICE_ACCOUNT = JSON.stringify({ project_id: "p", client_email: "c@p", private_key: "k" });
});
afterEach(() => {
  if (SAVED.b64 === undefined) delete process.env.FCM_SERVICE_ACCOUNT_B64; else process.env.FCM_SERVICE_ACCOUNT_B64 = SAVED.b64;
  if (SAVED.raw === undefined) delete process.env.FCM_SERVICE_ACCOUNT; else process.env.FCM_SERVICE_ACCOUNT = SAVED.raw;
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
    expect(r).toEqual({ sent: 2, failed: 0 });
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
