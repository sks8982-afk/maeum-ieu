/**
 * 위급 알림 — 채널 동시 출발과 발송 실패: 받은 곳이 확인되지 않았는데 무언가 실패하면 일시 실패는 앵커 없이 60초 바닥, 영구 실패뿐이면
 *   앵커를 걸고, 어느 쪽이든 운영자 경보("위급 알림 발송 실패" — 스위치 켜짐에서도 한 통).
 *   (2026-10-08 10차) 받은 곳이 확인돼도 일시 실패가 있으면 앵커 없이 60초 바닥 + "일부 경로 일시 실패" 경보.
 *   2026-10-07 8차에 __tests__/emergency-notify.test.ts에서 **그대로 옮겼다**(파일 나눔 — 그 파일 머리 주석).
 *   공용 목·도우미는 __tests__/helpers/emergency-notify-harness.ts.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import {
  db, fcmFail, pushMock, emailMock, defaultTokenPush, tokenPushMock, devicesMock, deleteTokensMock, opsAlertMock, P, notify,
  TOK_READY, TOK_MUTED, device, opsCalls, noContact, INVALID_GRANT,
} from "./helpers/emergency-notify-harness";

/** 세 채널은 함께 출발하고, 집계 순서는 예전 그대로(webhook → 앱 푸시 → email) — 2026-10-07 3차 */
describe("채널 동시 출발 — 순서는 그대로, 한 채널의 throw가 다른 채널 결과를 버리지 않는다", () => {
  // 대상 모듈을 미리 읽어 둔다(2026-10-08) — 이 파일의 첫 테스트가 첫 import(변환 포함)까지 vi.waitFor 기본 1초 안에서 치르면, 전체 실행
  //   (커버리지·병렬)에서 import가 1초를 넘겨 이메일이 나가기 전에 waitFor가 끝났다(게이트 실행 3번 중 1번 — 동작이 아니라 시험 시간 문제)
  beforeAll(async () => { await import("@/lib/chat/emergency-notify"); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const withHook = (url: string) => ({ name: null, guardianWebhookUrl: url, guardianEmail: "g@example.com", guardianName: null });

  it("웹훅이 가장 늦게 끝나도 이메일·앱 푸시는 기다리지 않고, 채널 순서는 예전 그대로", async () => {
    db.user.findUnique.mockResolvedValue(withHook("https://hook.example.com/x"));
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    let releaseHook!: () => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { releaseHook = () => resolve(new Response("{}", { status: 200 })); })));
    const pending = notify({ userId: "hook-slow" });
    // 🔒 예전엔 웹훅 응답(최대 8초)을 다 기다린 뒤에야 앱 푸시·이메일이 출발했다
    await vi.waitFor(() => {
      expect(emailMock).toHaveBeenCalledTimes(1);
      expect(tokenPushMock).toHaveBeenCalledTimes(1);
      expect(pushMock).toHaveBeenCalledTimes(1);
    });
    releaseHook();
    expect((await pending).channels).toEqual(["webhook", "fcm", "fcm-topic", "email"]);
  });

  it("사설 주소로 향하는 웹훅은 막히고 채널로 세지 않는다 — 다른 채널은 그대로", async () => {
    db.user.findUnique.mockResolvedValue(withHook("https://private.example/x"));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await notify({ userId: "hook-private" })).channels).toEqual(["fcm-topic", "email"]);
      expect(fetchSpy).not.toHaveBeenCalled();
      // 막은 사실은 남긴다(SSRF 방어 로그) — 일시 발송 실패("webhook failed")가 아니다(다시 보내도 막힌다 — 6차부터 영구 실패, 아래
      //   "연락처 채널 결과" describe. 이메일이 확인돼도 7차부터 "일부 경로 영구 실패" 경보가 간다 — 아래 "영구 실패" describe)
      expect(warn.mock.calls.some((c) => String(c[0]).includes("안전하지 않은 웹훅 URL 차단"))).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("webhook failed"))).toBe(false);
    } finally { warn.mockRestore(); }
  });

  it("웹훅 본문을 만들다 throw해도(잘못된 시각) 그 채널만 실패 — 함께 출발한 이메일·앱 푸시 결과는 그대로", async () => {
    db.user.findUnique.mockResolvedValue(withHook("https://hook.example.com/x"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 🔒 셋을 함께 기다리므로, 한 채널의 throw가 새면 이미 나간 이메일·앱 푸시 결과까지 버려진다(reject)
      await expect(notify({ userId: "hook-throws", createdAt: new Date(Number.NaN) })).resolves.toEqual({ sent: true, channels: ["fcm-topic", "email"] });
      expect(err.mock.calls.some((c) => String(c[0]).includes("webhook 발송 중 예외"))).toBe(true);
    } finally { err.mockRestore(); }
  });

  it("이메일 발송이 throw해도 그 채널만 실패 — 함께 출발한 앱 푸시 결과는 그대로", async () => {
    emailMock.mockRejectedValueOnce(new Error("smtp boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(notify({ userId: "email-throws" })).resolves.toEqual({ sent: true, channels: ["fcm-topic"] });
      expect(err.mock.calls.some((c) => String(c[0]).includes("email 발송 중 예외"))).toBe(true);
    } finally { err.mockRestore(); }
  });
});

/**
 * 발송 실패 집계(2026-10-07 4차) — 받은 곳이 하나도 확인되지 않았는데(토픽 사본·알림 꺼진 휴대폰뿐) 무언가 **실패**했으면
 *   dedup 앵커를 걸지 않고(60초 바닥만) notifiedAt도 쓰지 않으며, 운영자에게 "위급 알림 발송 실패"를 알린다
 *   (PUSH_TOKENS_LIVE와 무관 — 이 파일 기본은 스위치 꺼짐). 예전엔 받는 기기를 모르는 사본만 받아들여져도 "보냄"으로
 *   1시간을 막아, 실패한 사본(이메일·실명 알림)은 그 응급에 다시 가지 않았고 아무도 몰랐다.
 *   앵커를 막는 건 **일시** 실패뿐이다(5·6차): 메신저·이메일 "failed" · 등록 휴대폰(알림 허용 휴대폰에 하나도 안 닿았고 그 실패가
 *   일시 오류, 또는 발송이 throw) · 토픽(한 보호자의 사본이라도 일시 오류로 거절). 영구 실패(웹훅 4xx·차단된 주소·없는 도메인,
 *   이메일 형식·SMTP 인증·5xx, FCM 없는 기기·서버 자격증명·권한)는 경보에만 싣고 앵커는 건다. "none"(주소 없음)은 실패가 아니다.
 */
describe("발송 실패 — 받은 곳이 없으면 앵커 없이 60초 바닥 + 운영자 경보", () => {
  const sendFailAlert = (uid: string) => opsCalls().find(([s]) => s === `L3 위급 알림 발송 실패 medical_acute ${uid}`);
  /** 그 응급의 "위급 알림 발송 실패" 경보 본문 — 경보가 없으면 **단언으로** 실패한다(구조 분해 TypeError로 실패 까닭이 흐려지지 않게, 6차) */
  const sendFailLines = (uid: string): string[] => {
    const alert = sendFailAlert(uid);
    expect(alert, `위급 알림 발송 실패 경보(${uid})`).toBeDefined();
    return alert![1];
  };
  const hook = (url: string, email: string | null = null) => ({ name: "김영자", guardianWebhookUrl: url, guardianEmail: email, guardianName: null });
  let warn: { mockRestore: () => void };
  let err: { mockRestore: () => void };
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); err.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  type Payload = Parameters<typeof import("@/lib/chat/emergency-notify").notifyGuardian>[0];
  /** 같은 응급을 다시 보내 본다 — 30초 뒤엔 60초 바닥에 걸리고, 61초 뒤엔 다시 나간다(1시간 창이 아니다) */
  async function expectRetryFloorOnly(payload: Payload) {
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    vi.advanceTimersByTime(30 * 1000);
    expect((await notifyGuardian(payload)).sent).toBe(false);
    vi.advanceTimersByTime(31 * 1000);
    return notifyGuardian(payload);
  }

  it("이메일 실패(SMTP 거절) + 토픽뿐 → 앵커·notifiedAt 없음, 60초 바닥, 경보(실패한 경로: email — 주소·이름 없이)", async () => {
    vi.useFakeTimers();
    emailMock.mockResolvedValue("transient");
    db.user.findUnique.mockResolvedValue({ name: "김영자", guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: null });
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "fail-email-topic", messageId: "m-fe" } as Payload;
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-topic"] });
    // 🔒 예전엔 토픽 사본(받는 기기 모름)만으로 notifiedAt·1시간 앵커를 걸어 이메일이 그 응급에 다시 가지 않았다
    expect(db.message.update).not.toHaveBeenCalled();
    const alert = sendFailAlert("fail-email-topic");
    expect(alert).toBeDefined();
    const [, lines] = alert!;
    expect(lines).toContain("실패한 경로: email");
    expect(lines).toContain("보낸 경로: fcm-topic");
    expect(lines).toContain("연결 계정의 등록 휴대폰: 0대(알림 허용 보고 0대)");
    expect(lines.join("\n")).toContain("중복 방지 기록을 남기지 않았습니다");
    // 운영 메일엔 이름·주소를 싣지 않는다
    expect(lines.join("\n")).not.toMatch(/김영자|김응급|g@example\.com/);
    emailMock.mockResolvedValue("ok");   // SMTP가 돌아왔다
    expect(await expectRetryFloorOnly(payload)).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
    expect(db.message.update).toHaveBeenCalledTimes(1);   // 이제 받은 곳(이메일)이 확인돼 앵커를 건다
  });

  it("등록 휴대폰 일시 실패 + 토픽 성공 → 같은 규칙(경보에 FCM 오류 코드)", async () => {
    vi.useFakeTimers();
    db.user.findUnique.mockResolvedValue(noContact);
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    tokenPushMock.mockResolvedValue({
      sent: 0, failed: 1, invalidTokens: [], deliveredTokens: [], failures: [fcmFail(TOK_READY, "messaging/internal-error")],
    });
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "fail-token-topic", messageId: "m-ft" } as Payload;
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(db.message.update).not.toHaveBeenCalled();
    expect(sendFailAlert("fail-token-topic")![1]).toContain("실패한 경로: fcm(messaging/internal-error)");
    expect(sendFailAlert("fail-token-topic")![1]).toContain("연결 계정의 등록 휴대폰: 1대(알림 허용 보고 1대)");
    tokenPushMock.mockImplementation(defaultTokenPush);   // FCM이 돌아왔다
    expect(await expectRetryFloorOnly(payload)).toEqual({ sent: true, channels: ["fcm", "fcm-topic"] });
    expect(db.message.update).toHaveBeenCalledTimes(1);
  });

  it("토픽 실패 + 알림 꺼진 휴대폰만 받아들여짐(예전엔 이걸로 1시간 막혔다) → 같은 규칙", async () => {
    vi.useFakeTimers();
    db.user.findUnique.mockResolvedValue(noContact);
    devicesMock.mockResolvedValue([device("g1", TOK_MUTED, { permission: "denied" })]);
    pushMock.mockResolvedValue({ sent: 0, failed: 1, failures: [fcmFail("g1", "messaging/server-unavailable")] });
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "fail-topic-muted", messageId: "m-tm" } as Payload;
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-muted"] });
    // 🔒 회귀 사례: 꺼진 휴대폰 하나가 받아들여졌다고 1시간 앵커 — 토픽 사본이 실패한 그 응급은 다시 가지 않았다
    expect(db.message.update).not.toHaveBeenCalled();
    expect(sendFailAlert("fail-topic-muted")![1]).toContain("실패한 경로: fcm-topic(1/1 messaging/server-unavailable)");
    pushMock.mockResolvedValue({ sent: 1, failed: 0, failures: [] });
    expect((await expectRetryFloorOnly(payload)).channels).toEqual(["fcm-muted", "fcm-topic"]);
  });

  it("모두 정상 → 1시간 앵커(notifiedAt) · 경보 없음 — 61초 뒤에도 다시 보내지 않는다", async () => {
    vi.useFakeTimers();
    db.user.findUnique.mockResolvedValue(hook("https://hook.example.com/x", "g@example.com"));
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "all-ok", messageId: "m-ok" } as Payload;
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["webhook", "fcm", "fcm-topic", "email"] });
    expect(db.message.update).toHaveBeenCalledTimes(1);
    expect(opsAlertMock).not.toHaveBeenCalled();
    vi.advanceTimersByTime(61 * 1000);
    expect((await notifyGuardian(payload)).sent).toBe(false);
  });

  /**
   * 알림을 받겠다던 휴대폰이 "없는 기기"로 돌아왔다(2026-10-07 5·6차) — 보호자는 이 응급을 못 봤을 수 있다. 6차부터 **영구** 실패다:
   *   다시 보내도 같은 결과라(그 토큰은 이미 지웠다) 앵커는 걸고, 받은 곳이 없으니 경보로 알린다("fcm(영구 실패 …)").
   *   5차는 일시처럼 세 앵커 없이 60초 뒤 한 번 더 돌았다.
   */
  it("알림 허용 휴대폰이 '없는 기기'로 돌아오고 닿은 곳이 없으면 영구 실패 — 지우고, 앵커를 걸고(1시간), 경보", async () => {
    vi.useFakeTimers();
    db.user.findUnique.mockResolvedValue(noContact);
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    tokenPushMock.mockResolvedValue({
      sent: 0, failed: 1, invalidTokens: [TOK_READY], deliveredTokens: [],
      failures: [fcmFail(TOK_READY, "messaging/registration-token-not-registered", "token")],
    });
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "gone-only", messageId: "m-go" } as Payload;
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(deleteTokensMock).toHaveBeenCalledWith([TOK_READY]);
    // 🔒 다시 보내도 같은 결과(그 휴대폰은 앱을 지웠다)인데 앵커를 막으면 60초마다 재발송·경보만 쌓인다
    expect(db.message.update).toHaveBeenCalledTimes(1);
    const lines = sendFailLines("gone-only");
    // 🔒 보호자가 못 봤을 수 있다 — 받은 곳이 없으니 경보는 간다(영구 실패 표시 + 설명 줄)
    expect(lines).toContain("실패한 경로: fcm(영구 실패 messaging/registration-token-not-registered)");
    expect(lines.join("\n")).toContain("실패가 모두 영구 실패라(다시 보내도 같다) 중복 방지 기록은 남겼습니다");
    expect(lines.some((l) => l.startsWith("'영구 실패'는"))).toBe(true);
    vi.advanceTimersByTime(61 * 1000);
    expect((await notifyGuardian(payload)).sent).toBe(false);   // 1시간 창
  });

  /**
   * 등록 휴대폰 **모두**의 실패를 센다(2026-10-07 8차) — 예전엔 알림 허용 휴대폰이 하나도 닿지 않았을 때 그 휴대폰들의 실패만 셌다.
   *   알림이 꺼진 휴대폰도 앱이 FCM 핸들러에서 직접 경보음·화면을 띄우고(MaeumApp index.js), 한 휴대폰이 닿았다고 다른 휴대폰의 죽은
   *   토큰이 묻히면 그 휴대폰의 등록이 끊긴 걸 아무도 모른다. 받은 곳 확인("fcm")은 그대로 알림 허용 휴대폰뿐이다.
   */
  it("알림 꺼진 휴대폰이 '없는 기기'로 돌아와도 영구 실패(앵커·경보) · 다른 알림 허용 휴대폰에 닿았어도 영구 실패 경보는 간다(8차)", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    devicesMock.mockResolvedValue([device("g1", TOK_MUTED, { permission: "denied" })]);
    tokenPushMock.mockResolvedValue({
      sent: 0, failed: 1, invalidTokens: [TOK_MUTED], deliveredTokens: [],
      failures: [fcmFail(TOK_MUTED, "messaging/registration-token-not-registered", "token")],
    });
    expect(await notify({ userId: "gone-muted" })).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(db.message.update).toHaveBeenCalledTimes(1);   // 영구 실패뿐 — 다시 보내도 같아 앵커는 그대로
    // 🔒 예전엔 "꺼진 휴대폰의 실패"라 경보가 없었다 — 그 휴대폰도 앱이 경보음을 울리는 휴대폰이다
    expect(opsCalls().map(([s]) => s)).toEqual(["L3 위급 알림 발송 실패 medical_acute gone-muted"]);
    expect(sendFailLines("gone-muted")).toContain("실패한 경로: fcm(영구 실패 messaging/registration-token-not-registered)");

    db.message.update.mockClear();
    opsAlertMock.mockClear();
    const other = "other_" + "o".repeat(40);
    devicesMock.mockResolvedValue([device("g1", TOK_READY), device("g2", other)]);
    tokenPushMock.mockResolvedValue({
      sent: 1, failed: 1, invalidTokens: [TOK_READY], deliveredTokens: [other],
      failures: [fcmFail(TOK_READY, "messaging/registration-token-not-registered", "token")],
    });
    expect(await notify({ userId: "gone-one-of-two" })).toEqual({ sent: true, channels: ["fcm", "fcm-topic"] });
    expect(db.message.update).toHaveBeenCalledTimes(1);
    // 🔒 다른 휴대폰이 받았다고 묻히지 않는다 — 받은 곳이 확인됐으니 "일부 경로 영구 실패" 한 통
    expect(opsCalls().map(([s]) => s)).toEqual(["L3 위급 알림 일부 경로 영구 실패 medical_acute gone-one-of-two"]);
    expect(opsCalls()[0][1]).toContain("실패한 경로: fcm(영구 실패 messaging/registration-token-not-registered)");
  });

  it("등록 휴대폰 발송 자체가 throw해 일시로 분류되면(push-fcm thrownFailures) 알림 꺼진 휴대폰뿐이어도 (일시) 발송 실패", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    devicesMock.mockResolvedValue([device("g1", TOK_MUTED, { permission: "denied" })]);
    tokenPushMock.mockResolvedValue({
      sent: 0, failed: 1, invalidTokens: [], deliveredTokens: [], failures: [fcmFail(TOK_MUTED, "send-error")],
    });
    expect(await notify({ userId: "token-threw" })).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(db.message.update).not.toHaveBeenCalled();
    expect(sendFailAlert("token-threw")![1]).toContain("실패한 경로: fcm(send-error)");
  });

  it("알림 꺼진 휴대폰의 일시 실패도 발송 실패 — 토픽뿐이면 앵커 없이 60초 바닥 + 경보(앱이 직접 울리는 휴대폰이다, 8차)", async () => {
    vi.useFakeTimers();
    db.user.findUnique.mockResolvedValue(noContact);
    devicesMock.mockResolvedValue([device("g1", TOK_MUTED, { permission: "denied" })]);
    tokenPushMock.mockResolvedValue({ sent: 0, failed: 1, invalidTokens: [], deliveredTokens: [], failures: [fcmFail(TOK_MUTED, "messaging/internal-error")] });
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "muted-transient", messageId: "m-mt" } as Payload;
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-topic"] });
    // 🔒 예전엔 "받아도 표시되지 않는 휴대폰"이라 실패로 세지 않고 1시간 앵커를 걸었다 — 그 휴대폰은 다음 턴에도 다시 받지 못했다
    expect(db.message.update).not.toHaveBeenCalled();
    expect(sendFailLines("muted-transient")).toContain("실패한 경로: fcm(messaging/internal-error)");
    tokenPushMock.mockImplementation(defaultTokenPush);   // FCM이 돌아왔다
    expect(await expectRetryFloorOnly(payload)).toEqual({ sent: true, channels: ["fcm-muted", "fcm-topic"] });
    expect(db.message.update).toHaveBeenCalledTimes(1);
  });

  it("토픽 발송이 throw해도 그 사본만 실패 — 등록 휴대폰 결과는 그대로(받은 곳 확인) · 일시 실패라 앵커 없이 '일부 경로 일시 실패' 경보(10차)", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    pushMock.mockRejectedValueOnce(new Error("topic boom"));
    expect(await notify({ userId: "topic-throws" })).toEqual({ sent: true, channels: ["fcm"] });
    // 🔒 예전(9차까지)엔 받은 곳(fcm)이 있다고 1시간 앵커 + 경보 없음 — 토픽 사본만 받는 다른 휴대폰엔 그 응급이 끝내 다시 가지 않았다
    expect(db.message.update).not.toHaveBeenCalled();
    expect(opsCalls().map(([s]) => s)).toEqual(["L3 위급 알림 일부 경로 일시 실패 medical_acute topic-throws"]);
    expect(opsCalls()[0][1]).toContain("실패한 경로: fcm-topic(1/1 send-error)");
  });

  /**
   * 받은 곳이 확인돼도 일시 실패가 있으면 앵커를 걸지 않는다(2026-10-08 10차 — 예전 이름 "받은 곳이 확인되면(이메일) 다른 경로가 실패해도
   *   예전처럼 앵커 · 발송 실패 경보 없음"이 고정하던 동작을 뒤집었다). 누가 받았다고 못 받은 사람의 재시도를 막으면 안 된다 — 60초 바닥만
   *   남기고 notifiedAt도 쓰지 않아 다음 감지에 다시 보내고, 운영자에게 "일부 경로 일시 실패"를 알린다(이미 받은 곳은 한 번 더 받는다).
   */
  it("받은 곳이 확인돼도(이메일) 다른 경로가 일시 실패하면 앵커·notifiedAt 없이 60초 바닥 + '일부 경로 일시 실패' 경보 — 61초 뒤 다시 감지되면 모든 경로로", async () => {
    vi.useFakeTimers();
    db.user.findUnique.mockResolvedValue({ name: "김영자", guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: null });
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    tokenPushMock.mockResolvedValue({ sent: 0, failed: 1, invalidTokens: [], deliveredTokens: [], failures: [fcmFail(TOK_READY, "messaging/internal-error")] });
    pushMock.mockResolvedValue({ sent: 0, failed: 1, failures: [fcmFail("g1", "messaging/internal-error")] });
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "fail-but-email", messageId: "m-fbe" } as Payload;
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["email"] });
    expect(db.message.update).not.toHaveBeenCalled();
    expect(opsCalls().map(([s]) => s)).toEqual(["L3 위급 알림 일부 경로 일시 실패 medical_acute fail-but-email"]);
    const lines = opsCalls()[0][1];
    expect(lines).toContain("보낸 경로: email");
    expect(lines).toContain("실패한 경로: fcm(messaging/internal-error), fcm-topic(1/1 messaging/internal-error)");
    expect(lines).toContain("연결 계정의 등록 휴대폰: 1대(알림 허용 보고 1대)");
    expect(lines.join("\n")).toContain("중복 방지 기록을 남기지 않았습니다");
    expect(lines.join("\n")).toContain("이미 받은 곳은 한 번 더 받습니다");
    // 운영 메일엔 이름·주소를 싣지 않는다
    expect(lines.join("\n")).not.toMatch(/김영자|김응급|g@example\.com/);
    tokenPushMock.mockImplementation(defaultTokenPush);   // FCM이 돌아왔다
    pushMock.mockResolvedValue({ sent: 1, failed: 0, failures: [] });
    expect(await expectRetryFloorOnly(payload)).toEqual({ sent: true, channels: ["fcm", "fcm-topic", "email"] });
    expect(db.message.update).toHaveBeenCalledTimes(1);   // 이제 빠진 사본이 없다 → 앵커
  });

  it("메신저(webhook) 응답 오류 + 토픽뿐 → 일시 발송 실패(webhook) / 막힌 웹훅(사설 주소)은 영구 실패 — 앵커는 걸고 경보", async () => {
    db.user.findUnique.mockResolvedValue(hook("https://hook.example.com/x"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    expect(await notify({ userId: "hook-503" })).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(db.message.update).not.toHaveBeenCalled();
    expect(sendFailAlert("hook-503")![1]).toContain("실패한 경로: webhook");

    db.message.update.mockClear();
    opsAlertMock.mockClear();
    db.user.findUnique.mockResolvedValue(hook("https://private.example/x"));
    // 🔒 막은 주소는 다시 보내도 막힌다 — 앵커를 막으면 60초마다 재발송·경보만 쌓인다(6차: 영구 실패)
    expect(await notify({ userId: "hook-blocked" })).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(db.message.update).toHaveBeenCalledTimes(1);
    // 🔒 예전엔 "보낼 곳 없음"이라 경보가 없었다 — 보호자가 등록한 메신저 사본이 영영 빠지는데 아무도 몰랐다(6차)
    const lines = sendFailLines("hook-blocked");
    expect(lines).toContain("실패한 경로: webhook(영구 실패 — 차단된 주소)");
    expect(lines.join("\n")).toContain("실패가 모두 영구 실패라(다시 보내도 같다) 중복 방지 기록은 남겼습니다");
  });

  it("발송 실패 경보가 실패해도(SMTP) 발송 결과는 그대로 · 메시지 기록이 없는 턴(저장 실패)은 그렇게 적는다", async () => {
    emailMock.mockResolvedValue("transient");
    opsAlertMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(notify({ userId: "fail-alert-smtp", messageId: undefined })).resolves.toEqual({ sent: true, channels: ["fcm-topic"] });
    const alert = sendFailAlert("fail-alert-smtp");   // 시도는 했다
    expect(alert![1]).toContain("메시지 기록: 없음(저장 실패 또는 안전망 경로)");
    expect(db.message.update).not.toHaveBeenCalled();
  });

  it("보호자 이메일 복호화 실패는 영구 실패다(키가 바뀌지 않는 한 다시 해도 같다) — 경보에 싣고, 앵커는 막지 않는다(5차)", async () => {
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: null, guardianEmail: "enc:v1:broken", guardianName: null });
    expect(await notify({ userId: "decrypt-topic" })).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(emailMock).not.toHaveBeenCalled();
    // 🔒 다시 보내도 같은 결과인데 앵커를 막으면 60초마다 재발송·경보만 쌓인다
    expect(db.message.update).toHaveBeenCalledTimes(1);
    const [, lines] = sendFailAlert("decrypt-topic")!;
    expect(lines).toContain("실패한 경로: email(영구 실패)");
    expect(lines.join("\n")).toContain("실패가 모두 영구 실패라(다시 보내도 같다) 중복 방지 기록은 남겼습니다");
    expect(lines.join("\n")).toContain("'영구 실패'는 다시 보내도 같은 결과입니다");
  });

  it("보낸 곳이 아예 없으면 '응급 알림 실패' **한 통**에 실패 경로를 싣는다 — '위급 알림 발송 실패'는 따로 없다", async () => {
    emailMock.mockResolvedValue("transient");
    pushMock.mockResolvedValue({ sent: 0, failed: 1, failures: [fcmFail("g1", "messaging/internal-error")] });
    const r = await notify({ userId: "fail-everything" });
    expect(r.sent).toBe(false);
    // 🔒 같은 응급에 거의 같은 경보 두 통 금지
    expect(opsCalls().map(([s]) => s)).toEqual(["응급 알림 실패 L3 medical_acute fail-everything"]);
    expect(opsCalls()[0][1]).toContain("실패한 경로: fcm-topic(1/1 messaging/internal-error), email");
  });

  it("토픽 발송이 throw하고 다른 곳도 없으면 — 그 실패도 '응급 알림 실패'에 실린다(코드 send-error)", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    pushMock.mockRejectedValueOnce(new Error("topic boom"));
    expect((await notify({ userId: "topic-throws-only" })).sent).toBe(false);
    expect(opsCalls()[0][1]).toContain("실패한 경로: fcm-topic(1/1 send-error)");
  });

  it("토픽 발송이 거절된 서버 자격증명으로 throw하면 그 분류(영구)대로 — 'fcm-topic(영구 실패 app/invalid-credential)', 앵커는 막지 않는다(8차)", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    devicesMock.mockResolvedValue([device("g1", TOK_MUTED, { permission: "denied" })]);
    pushMock.mockRejectedValueOnce(INVALID_GRANT);
    expect(await notify({ userId: "topic-throws-invalid-grant" })).toEqual({ sent: true, channels: ["fcm-muted"] });
    // 🔒 예전엔 throw는 늘 일시("send-error")라 앵커 없이 60초마다 다시 보냈다 — 자격증명을 고칠 때까지 결과가 같은데
    expect(db.message.update).toHaveBeenCalledTimes(1);
    expect(sendFailLines("topic-throws-invalid-grant")).toContain("실패한 경로: fcm-topic(영구 실패 app/invalid-credential)");
  });

  /**
   * FCM을 쓸 수 없어(서버 자격증명 없음·형식 오류·다른 Firebase 프로젝트) 연결된 보호자에게 앱 알림을 아예 못 보냈다(2026-10-07 7차) —
   *   설정 탓 영구 실패로 "응급 알림 실패"에 싣는다. 6차엔 실패가 아니라 실패 경로 줄도 없었다 — 앱 알림이 통째로 꺼진 사실이 사유 줄
   *   ("모든 채널 발송 실패")에 묻혔다. 실패가 그것뿐이면 영구 실패뿐이라 1시간 창(notifiedAt은 쓰지 않는다 — 하루 점검이 잡는다).
   */
  it("보낸 곳 없이 FCM이 꺼져 있으면(연결 보호자 있음) 설정 탓 영구 실패 — '응급 알림 실패'에 실패 경로로 싣고, 1시간 창(notifiedAt 없음)", async () => {
    vi.useFakeTimers();
    db.user.findUnique.mockResolvedValue(noContact);
    pushMock.mockResolvedValue({ sent: 0, failed: 0, skipped: "FCM not configured", failures: [] });
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "fcm-off", messageId: "m-off" } as Payload;
    expect((await notifyGuardian(payload)).sent).toBe(false);
    expect(opsCalls().map(([s]) => s)).toEqual(["응급 알림 실패 L3 medical_acute fcm-off"]);
    const lines = opsCalls()[0][1];
    // 🔒 실패 경로 줄이 없으면 운영자는 앱 알림이 통째로 꺼진 서버라는 걸 사유 줄만 보고 알 수 없다
    expect(lines).toContain("실패한 경로: fcm(영구 실패 — 서버 FCM 설정 없음·사용 불가)");
    expect(lines.some((l) => l.startsWith("'영구 실패'는"))).toBe(true);
    expect(lines.some((l) => l.startsWith("실패가 모두 영구 실패라(다시 보내도 같다) 같은 응급을 1시간 동안 다시 보내지 않습니다"))).toBe(true);
    expect(db.message.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(61 * 1000);
    // 🔒 고칠 때까지 같은 결과 — 60초마다 다시 돌며 경보·로그만 쌓이지 않게 1시간 창
    expect(await notifyGuardian(payload)).toMatchObject({ sent: false, reason: expect.stringContaining("메모리 상한") });
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  /**
   * 토픽 사본이 보호자 둘 중 한 명 것만 거절됐다(2026-10-07 5차) — 받아들여진 사본은 다른 보호자 것뿐이라, 거절된 보호자는 이
   *   응급을 못 받았다. 예전엔 "하나라도 받아들여지면 실패 아님"이라 1시간 앵커를 걸어 그 보호자에겐 끝내 다시 가지 않았다.
   */
  it("토픽 사본이 한 보호자 것이라도 거절되면 발송 실패 — 앵커·notifiedAt 없이 60초 바닥, 경보에 '거절 수/보낸 수 코드'", async () => {
    vi.useFakeTimers();
    db.user.findUnique.mockResolvedValue(noContact);
    db.expertPatient.findMany.mockResolvedValue([{ expertUserId: "g1" }, { expertUserId: "g2" }]);
    pushMock.mockResolvedValue({ sent: 1, failed: 1, failures: [fcmFail("g2", "messaging/internal-error")] });
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "topic-partial", messageId: "m-tp" } as Payload;
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-topic"] });
    // 🔒 1시간 앵커를 걸면 거절된 보호자(g2)에겐 이 응급이 끝내 다시 가지 않는다
    expect(db.message.update).not.toHaveBeenCalled();
    const [, lines] = sendFailAlert("topic-partial")!;
    expect(lines).toContain("실패한 경로: fcm-topic(1/2 messaging/internal-error)");
    expect(lines.join("\n")).toContain("중복 방지 기록을 남기지 않았습니다");
    pushMock.mockResolvedValue({ sent: 2, failed: 0, failures: [] });   // FCM이 돌아왔다
    expect(await expectRetryFloorOnly(payload)).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(db.message.update).toHaveBeenCalledTimes(1);
  });

  /**
   * FCM 영구 실패(2026-10-07 6차 — push-fcm FcmFailureKind) — 토큰·토픽 사본 모두 일시 실패만 앵커를 막는다. 서버 자격증명·권한·APNs
   *   설정 탓("config")과 죽은 토큰("token")은 다시 보내도 같아 앵커는 걸고, 받은 곳이 없으면 "fcm(영구 실패 …)"·"fcm-topic(영구 실패 …)"로
   *   경보에 싣는다. 설정 탓 토큰은 지우지 않는다(서버 문제 하나로 보호자 등록이 사라지지 않게).
   */
  it("알림 허용 휴대폰이 권한 거부(설정 탓)로만 실패 → 지우지 않고, 앵커를 걸고, 경보(fcm(영구 실패 …))", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    tokenPushMock.mockResolvedValue({
      sent: 0, failed: 1, invalidTokens: [], deliveredTokens: [], failures: [fcmFail(TOK_READY, "messaging/mismatched-credential", "config")],
    });
    expect(await notify({ userId: "token-config" })).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(deleteTokensMock).not.toHaveBeenCalled();
    // 🔒 일시로 세면 서버 권한이 고쳐질 때까지 모든 응급이 60초마다 다시 나간다
    expect(db.message.update).toHaveBeenCalledTimes(1);
    const lines = sendFailLines("token-config");
    expect(lines).toContain("실패한 경로: fcm(영구 실패 messaging/mismatched-credential)");
    expect(lines).toContain("연결 계정의 등록 휴대폰: 1대(알림 허용 보고 1대)");
    expect(lines.some((l) => l.startsWith("'영구 실패'는"))).toBe(true);
  });

  it("토픽 사본이 설정 탓(APNs 인증)으로만 거절 + 받은 곳 없음 → 앵커를 걸고, 경보(fcm-topic(영구 실패 …)) · 이메일 실패가 섞이면 앵커 없음", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    db.expertPatient.findMany.mockResolvedValue([{ expertUserId: "g1" }, { expertUserId: "g2" }]);
    pushMock.mockResolvedValue({ sent: 1, failed: 1, failures: [fcmFail("g2", "messaging/third-party-auth-error", "config")] });
    expect(await notify({ userId: "topic-config" })).toEqual({ sent: true, channels: ["fcm-topic"] });
    // 🔒 영구 실패를 "거절 수/보낸 수"의 일시 실패로 세면 60초마다 재발송·경보만 쌓인다
    expect(db.message.update).toHaveBeenCalledTimes(1);
    expect(sendFailLines("topic-config")).toContain("실패한 경로: fcm-topic(영구 실패 messaging/third-party-auth-error)");

    db.message.update.mockClear();
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: null });
    emailMock.mockResolvedValue("transient");
    expect(await notify({ userId: "topic-config-email" })).toEqual({ sent: true, channels: ["fcm-topic"] });
    // 🔒 영구 실패가 섞였다고 일시 실패(이메일)를 덮으면 그 이메일은 1시간 동안 다시 안 간다
    expect(db.message.update).not.toHaveBeenCalled();
    expect(sendFailLines("topic-config-email")).toContain("실패한 경로: fcm-topic(영구 실패 messaging/third-party-auth-error), email");
  });

  it("같은 오류 코드는 경보에 한 번만 — 토픽 사본 둘이 같은 일시 오류로 거절되면 'fcm-topic(2/2 코드)'", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    db.expertPatient.findMany.mockResolvedValue([{ expertUserId: "g1" }, { expertUserId: "g2" }]);
    devicesMock.mockResolvedValue([device("g1", TOK_MUTED, { permission: "denied" })]);
    pushMock.mockResolvedValue({
      sent: 0, failed: 2, failures: [fcmFail("g1", "messaging/internal-error"), fcmFail("g2", "messaging/internal-error")],
    });
    expect(await notify({ userId: "dup-codes" })).toEqual({ sent: true, channels: ["fcm-muted"] });
    // 🔒 보호자가 많을수록 같은 코드가 줄줄이 붙어 경보가 읽히지 않는다(4차의 push-fcm 오류 코드 목록도 중복이 없었다)
    expect(sendFailLines("dup-codes")).toContain("실패한 경로: fcm-topic(2/2 messaging/internal-error)");
  });

  it("등록 휴대폰 일시 실패 + 토픽 영구 실패 → 앵커 없음(일시 실패가 있다), 경보에 둘 다 — 토픽은 일시·영구가 섞이면 따로 적는다", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    db.expertPatient.findMany.mockResolvedValue([{ expertUserId: "g1" }, { expertUserId: "g2" }, { expertUserId: "g3" }]);
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    tokenPushMock.mockResolvedValue({ sent: 0, failed: 1, invalidTokens: [], deliveredTokens: [], failures: [fcmFail(TOK_READY, "messaging/internal-error")] });
    pushMock.mockResolvedValue({
      sent: 1, failed: 2,
      failures: [fcmFail("g2", "messaging/server-unavailable"), fcmFail("g3", "messaging/mismatched-credential", "config")],
    });
    expect(await notify({ userId: "mixed-fcm" })).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(db.message.update).not.toHaveBeenCalled();
    const lines = sendFailLines("mixed-fcm");
    // 🔒 거절 수는 일시 실패만 센다(1/3) — 영구 실패는 다시 보내도 같아 따로 적는다
    expect(lines).toContain(
      "실패한 경로: fcm(messaging/internal-error), fcm-topic(1/3 messaging/server-unavailable), fcm-topic(영구 실패 messaging/mismatched-credential)",
    );
    expect(lines.join("\n")).toContain("중복 방지 기록을 남기지 않았습니다");
  });
});

/**
 * 받은 곳이 확인돼도 일시 실패가 있으면(2026-10-08 10차) — 앵커·notifiedAt 없이 60초 바닥 + "일부 경로 일시 실패" 경보(실패한 경로·FCM 오류
 *   코드만 — 이름·주소 없음). 일시 실패는 경로마다(등록 휴대폰·토픽·이메일·메신저) 같은 규칙이다. 영구 실패가 함께 섞이면 그 경보 한 통에
 *   함께 싣는다("일부 경로 영구 실패"를 따로 보내지 않는다 — 같은 응급에 비슷한 경보 두 통 금지).
 */
describe("받은 곳이 확인돼도 일시 실패가 있으면 — 앵커 없이 60초 바닥 + '일부 경로 일시 실패' 경보(10차)", () => {
  type Payload = Parameters<typeof import("@/lib/chat/emergency-notify").notifyGuardian>[0];
  const subject = (uid: string) => `L3 위급 알림 일부 경로 일시 실패 medical_acute ${uid}`;
  let warn: { mockRestore: () => void };
  let err: { mockRestore: () => void };
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); err.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([
    ["등록 휴대폰(토큰) 일시 실패 + 이메일 성공", () => {
      devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
      tokenPushMock.mockResolvedValue({ sent: 0, failed: 1, invalidTokens: [], deliveredTokens: [], failures: [fcmFail(TOK_READY, "messaging/internal-error")] });
    }, ["fcm-topic", "email"], "fcm(messaging/internal-error)"],
    ["토픽 일시 실패 + 이메일 성공", () => {
      pushMock.mockResolvedValue({ sent: 0, failed: 1, failures: [fcmFail("g1", "messaging/server-unavailable")] });
    }, ["email"], "fcm-topic(1/1 messaging/server-unavailable)"],
    ["이메일 일시 실패 + 알림 허용 휴대폰 성공", () => {
      devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
      emailMock.mockResolvedValue("transient");
    }, ["fcm", "fcm-topic"], "email"],
    ["메신저(웹훅 503) 일시 실패 + 이메일 성공", () => {
      db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: "https://hook.example.com/x", guardianEmail: "g@example.com", guardianName: null });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    }, ["fcm-topic", "email"], "webhook"],
  ] as const)("%s → 앵커·notifiedAt 없음 + 경보 한 통(실패한 경로 %j)", async (_, arrange, channels, failed) => {
    arrange();
    const uid = `transient-confirmed-${failed}`;
    expect(await notify({ userId: uid })).toEqual({ sent: true, channels: [...channels] });
    // 🔒 받은 곳이 있다고 1시간을 막으면 실패한 경로로 받을 사람에겐 그 응급이 끝내 다시 가지 않는다
    expect(db.message.update).not.toHaveBeenCalled();
    expect(opsCalls().map(([s]) => s)).toEqual([subject(uid)]);
    expect(opsCalls()[0][1]).toContain(`실패한 경로: ${failed}`);
  });

  it("토픽 일시 실패 + 이메일 성공 — 60초 안의 같은 응급은 억제, 61초 뒤 다시 감지되면 다시 보낸다(이메일도 한 번 더)", async () => {
    vi.useFakeTimers();
    pushMock.mockResolvedValue({ sent: 0, failed: 1, failures: [fcmFail("g1", "messaging/server-unavailable")] });
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "topic-transient-email", messageId: "m-tte" } as Payload;
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["email"] });
    expect(db.message.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30 * 1000);
    expect((await notifyGuardian(payload)).sent).toBe(false);   // 60초 바닥
    vi.advanceTimersByTime(31 * 1000);
    pushMock.mockResolvedValue({ sent: 1, failed: 0, failures: [] });   // FCM이 돌아왔다
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
    // 🔒 이메일로 받은 보호자도 한 번 더 받는다 — 조용함보다 중복
    expect(emailMock).toHaveBeenCalledTimes(2);
    expect(db.message.update).toHaveBeenCalledTimes(1);
  });

  /**
   * FCM 전체 일시 장애 — 접근 토큰 서버에 닿지 못했다(app/invalid-credential + 네트워크 문구 → 일시, push-fcm credentialFailureKind). 등록 휴대폰·
   *   토픽 사본이 모두 실패하고 이메일만 닿았다. 거절된 자격증명(invalid_grant — 영구, contact-results "일부 경로 영구 실패")과 달리 다시 보내면
   *   닿을 수 있다 → 앵커 없이 다음 감지에 다시.
   */
  it("FCM 전체 일시 장애(토큰 서버에 닿지 못함) + 이메일 성공 → 앵커 없음 + '일부 경로 일시 실패' 한 통(두 사본 모두 일시)", async () => {
    const { thrownFailures } = await import("@/lib/notify/push-fcm");
    const tokenServerDown = Object.assign(
      new Error(
        'Credential implementation provided to initializeApp() via the "credential" property failed to fetch a valid Google OAuth2 access ' +
        'token with the following error: "request to https://oauth2.googleapis.com/token failed, reason: getaddrinfo EAI_AGAIN oauth2.googleapis.com".',
      ),
      { code: "app/invalid-credential" },
    );
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    tokenPushMock.mockResolvedValue({ sent: 0, failed: 1, invalidTokens: [], deliveredTokens: [], failures: thrownFailures([TOK_READY], tokenServerDown) });
    pushMock.mockRejectedValue(tokenServerDown);
    const uid = "fcm-wide-transient";
    expect(await notify({ userId: uid })).toEqual({ sent: true, channels: ["email"] });
    expect(db.message.update).not.toHaveBeenCalled();
    // 🔒 영구로 세면(자격증명 거절처럼) 1시간을 막아, 토큰 서버가 돌아와도 앱 알림은 그 응급에 다시 가지 않는다
    expect(opsCalls().map(([s]) => s)).toEqual([subject(uid)]);
    const lines = opsCalls()[0][1];
    expect(lines).toContain("실패한 경로: fcm(app/invalid-credential), fcm-topic(1/1 app/invalid-credential)");
    expect(lines.some((l) => l.startsWith("'영구 실패'는"))).toBe(false);
  });

  it("일시·영구가 섞여도 받은 곳이 확인됐으면 '일부 경로 일시 실패' 한 통에 둘 다(설명 줄 포함) — '일부 경로 영구 실패'는 따로 없다, 앵커 없음", async () => {
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: "https://hook.example.com/x", guardianEmail: "g@example.com", guardianName: null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));   // 메신저 영구 실패
    pushMock.mockResolvedValue({ sent: 0, failed: 1, failures: [fcmFail("g1", "messaging/internal-error")] });   // 토픽 일시 실패
    const uid = "mixed-confirmed";
    expect(await notify({ userId: uid })).toEqual({ sent: true, channels: ["email"] });
    expect(db.message.update).not.toHaveBeenCalled();
    // 🔒 같은 응급에 비슷한 경보 두 통 금지 — 영구 실패는 이 경보에 함께 실린다
    expect(opsCalls().map(([s]) => s)).toEqual([subject(uid)]);
    const lines = opsCalls()[0][1];
    expect(lines).toContain("실패한 경로: webhook(영구 실패), fcm-topic(1/1 messaging/internal-error)");
    expect(lines.some((l) => l.startsWith("'영구 실패'는"))).toBe(true);
  });

  it("경보가 실패해도(SMTP) 발송 결과는 그대로 · 메시지 기록이 없는 턴(저장 실패)은 그렇게 적는다", async () => {
    pushMock.mockResolvedValue({ sent: 0, failed: 1, failures: [fcmFail("g1", "messaging/internal-error")] });
    opsAlertMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(notify({ userId: "transient-alert-smtp", messageId: undefined })).resolves.toEqual({ sent: true, channels: ["email"] });
    expect(opsCalls().map(([s]) => s)).toEqual([subject("transient-alert-smtp")]);   // 시도는 했다
    expect(opsCalls()[0][1]).toContain("메시지 기록: 없음(저장 실패 또는 안전망 경로)");
  });
});

/** 스위치 켜짐(1.2.0 프로덕션 단계적 출시 100% 뒤)에도 같은 응급에 비슷한 경보 두 통을 보내지 않는다 — 발송 실패가 섞이면 그 경보 하나 */
describe("발송 실패 + 받은 곳 미확인 경보 — 스위치 켜짐에서도 한 통", () => {
  beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_APP_ON_PLAY", "1"); vi.resetModules(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("이메일 실패 + 토픽뿐 → '위급 알림 발송 실패' 한 통(등록 휴대폰 줄 포함), '수신 기기 미확인'은 따로 없다", async () => {
    emailMock.mockResolvedValue("transient");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await notify({ userId: "live-fail-email" })).toEqual({ sent: true, channels: ["fcm-topic"] });
      expect(opsCalls().map(([s]) => s)).toEqual(["L3 위급 알림 발송 실패 medical_acute live-fail-email"]);
      expect(opsCalls()[0][1]).toContain("연결 계정의 등록 휴대폰: 0대(알림 허용 보고 0대)");
    } finally { err.mockRestore(); }
  });
});
