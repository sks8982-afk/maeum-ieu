/**
 * 위급 알림 — 보호자 앱 푸시(lib/chat/emergency-notify-app-push): 등록 휴대폰(실명)·토픽(가린 이름) 두 사본, 받은 곳 미확인 경보,
 *   등록 휴대폰 조회 실패·등록 휴대폰 경로 상한, push_device 테이블 없음.
 *   2026-10-07 8차에 __tests__/emergency-notify.test.ts에서 **그대로 옮겼다**(파일 나눔 — 그 파일 머리 주석).
 *   공용 목·도우미는 __tests__/helpers/emergency-notify-harness.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  db, fcmFail, pushMock, emailMock, tokenPushMock, devicesMock, deleteTokensMock, opsAlertMock, P, notify, TOK_READY, TOK_MUTED,
  device, opsCalls, noContact, type Device,
} from "./helpers/emergency-notify-harness";

/**
 * 등록 휴대폰 경로가 시간 상한에 걸렸을 때(조회 중·늦은 조회 + 발송 미완·FCM 발송 중)의 경보 앵커 줄(2026-10-08 11차) — 경로가 뒤에서
 *   이어져 실명 사본이 늦게라도 나갔을 수 있다: "빠져"가 아니라 "나갔는지 몰라"이고, 다음 턴의 재발송이 그 휴대폰엔 두 번째 알림일 수 있다.
 *   (12차) 다시 보내는 것은 같은 응급이 다시 감지될 때뿐이다(재시도 큐는 없다) — 받은 곳이 있었으면 그 경로("나갔는지 모르는" — "빠진"이
 *   아니다)의 보호자에게 직접 확인하라고 적고, 받은 곳이 없었으면 까닭을 "받은 곳이 확인되지 않아"가 아니라 빠졌거나 나갔는지 모르는 사본으로
 *   적는다(앵커를 막는 것은 그 사본이다). FCM 발송 시간 초과도 이 줄이라 "조회 실패"만 적지 않는다.
 */
const LATE_LINE_CONFIRMED =
  "이메일·메신저로는 전달됐지만 등록 휴대폰 사본이 나갔는지 몰라 중복 방지 기록을 남기지 않았습니다 — 같은 응급이 다음 대화 턴(60초 뒤부터)에 " +
  "다시 감지되면 다시 보냅니다(늦게라도 나갔다면 등록 휴대폰에는 같은 알림이 두 번 갑니다. 이미 받은 곳은 한 번 더 받습니다). " +
  "나갔는지 모르는 경로로 받는 보호자에게는 직접 확인해 주세요.";
const LATE_LINE_UNCONFIRMED =
  "받은 곳이 확인되지 않았고, 조회 실패(또는 등록 휴대폰 경로 시간 초과)로 빠졌거나 나갔는지 모르는 사본이 있어 중복 방지 기록을 남기지 " +
  "않았습니다 — 같은 응급이 다음 대화 턴(60초 뒤부터)에 다시 감지되면 다시 보냅니다(늦게라도 나갔다면 등록 휴대폰에는 같은 알림이 두 번 " +
  "갑니다). 보호자에게 직접 확인해 주세요.";

/**
 * 앱 푸시 두 사본(2026-10-07) — 등록 휴대폰(기기 토큰) + 토픽, 늘 함께(조용함보다 중복).
 *   토픽(maeum_<id>)은 구독 권한 검사가 없고 받는 기기가 있는지 모른다(구독자 0명이어도 성공). 등록 휴대폰은
 *   그 계정이 로그인해 직접 등록한 것이라 실명을 싣고, 토픽엔 가린 이름을 싣는다 — 앱은 로그인해 있는 동안 토픽
 *   구독을 유지하므로(app/RnBridge 계약) 등록 휴대폰도 두 사본을 다 받는다(같은 alertId로 하나만 남는다).
 */
describe("앱 푸시 두 사본 — 등록 휴대폰(실명) + 토픽(가린 이름)", () => {
  type Sent = { body: string; alertId: string; patientId: string; level: number };
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it("등록 휴대폰엔 실명, 토픽엔 가린 이름 — 같은 alertId(같은 tag로 알림창에 하나만)", async () => {
    db.user.findUnique.mockResolvedValue({ name: "김영자", guardianWebhookUrl: null, guardianEmail: null, guardianName: null });
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    await notify({ userName: "할머니", category: "fall_injury", createdAt: new Date("2026-10-07T06:12:00Z") });
    expect(devicesMock).toHaveBeenCalledWith(["g1"]);
    const [tokens, full] = tokenPushMock.mock.calls[0] as unknown as [string[], Sent];
    const [ids, masked] = pushMock.mock.calls[0] as unknown as [string[], Sent];
    expect(tokens).toEqual([TOK_READY]);
    expect(ids).toEqual(["g1"]);
    expect(full.body).toContain("김영자님 — 낙상·부상 (오후 3:12)");
    // 🔒 토픽은 구독 권한 검사가 없다 — 실명은 등록 휴대폰에만
    expect(masked.body).toContain("김*자님");
    expect(masked.body).not.toContain("김영자");
    expect(full.alertId).toMatch(UUID_RE);
    expect(masked.alertId).toBe(full.alertId);
    expect(full.patientId).toBe(masked.patientId);
  });

  it("등록 휴대폰마다 그 휴대폰을 등록한 계정을 함께 넘긴다 — 토큰 사본의 data.to(받는 계정 토픽 이름)의 근거(5차)", async () => {
    db.expertPatient.findMany.mockResolvedValue([{ expertUserId: "g1" }, { expertUserId: "pro-2" }]);
    devicesMock.mockResolvedValue([device("g1", TOK_READY), device("pro-2", TOK_MUTED, { permission: "denied" })]);
    await notify();
    expect(tokenPushMock).toHaveBeenCalledTimes(1);
    const targets = tokenPushMock.mock.calls[0][2] ?? [];
    // 🔒 휴대폰과 계정이 어긋나면 그 사본의 data.to가 다른 계정을 가리킨다(앱이 남의 계정 앞 사본으로 본다)
    expect(targets.map((t) => [t.token, t.userId])).toEqual([[TOK_READY, "g1"], [TOK_MUTED, "pro-2"]]);
  });

  it("alertId는 알림마다 새로 — 같은 메시지로 L2·L3가 따로 나가도 위급한 쪽이 덮이지 않게", async () => {
    await notify({ messageId: "m-same", level: 2, category: "dizziness_help" });
    await notify({ messageId: "m-same", level: 3 });
    // 두 번 다 실제로 나갔다 — 하나가 빠지면 아래 비교가 undefined끼리라 공허해진다
    expect(pushMock).toHaveBeenCalledTimes(2);
    const [a, b] = pushMock.mock.calls.map((c) => (c as unknown as [string[], Sent])[1].alertId);
    expect(a).not.toBe(b);
    expect(a).not.toContain("m-same");
    expect(b).toMatch(UUID_RE);
  });

  it("실명을 모르면 등록 휴대폰도 '어르신' — 호칭·'선생님'은 누군지 못 가린다", async () => {
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: null, guardianEmail: null, guardianName: null });
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    await notify({ userName: "선생님" });
    const [, full] = tokenPushMock.mock.calls[0] as unknown as [string[], Sent];
    expect(full.body).toContain("어르신님 —");
    expect(full.body).not.toContain("선생님님");
  });

  it("실명 미사용(C2 인지 변화 추세)이면 등록 휴대폰도 호칭", async () => {
    db.user.findUnique.mockResolvedValue({ name: "김영자", guardianWebhookUrl: null, guardianEmail: null, guardianName: null });
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    await notify({ userName: "할머니", level: 2, category: "cognitive_decline", realName: false });
    const [, full] = tokenPushMock.mock.calls[0] as unknown as [string[], Sent];
    expect(full.body).toContain("할머니님 — 인지 변화 추세");
    expect(full.body).not.toContain("김영자");
  });

  it("채널: 알림 허용 휴대폰 → fcm · 꺼짐 보고만 → fcm-muted · 토픽 → fcm-topic", async () => {
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    expect((await notify()).channels).toEqual(["fcm", "fcm-topic", "email"]);
    // 🔒 FCM은 알림을 꺼 둔 휴대폰에도 성공을 돌려준다 — "확인됨"으로 세면 받는 사람 없는 응급이 조용히 묻힌다
    devicesMock.mockResolvedValue([device("g1", TOK_MUTED, { permission: "denied" })]);
    expect((await notify()).channels).toEqual(["fcm-muted", "fcm-topic", "email"]);
    devicesMock.mockResolvedValue([device("g1", TOK_MUTED, { channelBlocked: true })]);
    expect((await notify()).channels).toEqual(["fcm-muted", "fcm-topic", "email"]);
    devicesMock.mockResolvedValue([device("g1", TOK_MUTED, { permission: "unknown" })]);
    expect((await notify()).channels).toEqual(["fcm-muted", "fcm-topic", "email"]);
  });

  it("알림 허용 휴대폰이 있어도 FCM이 받아들인 게 꺼진 휴대폰뿐이면 fcm이 아니다", async () => {
    devicesMock.mockResolvedValue([device("g1", TOK_READY), device("g2", TOK_MUTED, { permission: "denied" })]);
    tokenPushMock.mockResolvedValueOnce({ sent: 1, failed: 1, invalidTokens: [], deliveredTokens: [TOK_MUTED], failures: [fcmFail(TOK_READY, "messaging/internal-error")] });
    expect((await notify()).channels).toEqual(["fcm-muted", "fcm-topic", "email"]);
  });

  it("쓸 수 없는 토큰(앱 삭제·재설치)은 지운다 — 지우기가 실패해도 발송 결과는 그대로", async () => {
    devicesMock.mockResolvedValue([device("g1", TOK_READY), device("g2", TOK_MUTED)]);
    const half = {
      sent: 1, failed: 1, invalidTokens: [TOK_MUTED], deliveredTokens: [TOK_READY],
      failures: [fcmFail(TOK_MUTED, "messaging/registration-token-not-registered", "token")],
    };
    tokenPushMock.mockResolvedValueOnce(half);
    const r = await notify();
    expect(deleteTokensMock).toHaveBeenCalledWith([TOK_MUTED]);
    expect(r.channels).toContain("fcm");

    tokenPushMock.mockResolvedValueOnce(half);
    deleteTokensMock.mockRejectedValueOnce(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r2 = await notify();
      expect(r2.sent).toBe(true);
      expect(r2.channels).toContain("fcm");
      expect(err.mock.calls.some((c) => String(c[0]).includes("토큰 삭제 실패"))).toBe(true);
    } finally { err.mockRestore(); }
  });

  it("지울 토큰이 없으면 삭제 쿼리를 치지 않는다", async () => {
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    await notify();
    expect(deleteTokensMock).not.toHaveBeenCalled();
  });

  it("등록 휴대폰 조회가 (한 번 더 해 봐도) 실패하면 토픽은 그대로 나가고, 실패를 숨기지 않는다", async () => {
    devicesMock.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await notify();
      expect(devicesMock).toHaveBeenCalledTimes(2);   // 한 번 더 시도했다
      expect(tokenPushMock).not.toHaveBeenCalled();
      expect(pushMock).toHaveBeenCalledTimes(1);
      expect(r.channels).toEqual(["fcm-topic", "email"]);
      expect(err.mock.calls.filter((c) => String(c[0]).includes("등록 휴대폰 조회 실패"))).toHaveLength(2);
      // 🔒 조회 실패는 "0대"가 아니다 — 운영자에게 따로 알린다(아래 "등록 휴대폰 조회 실패(DB)" describe)
      const subjects = (opsAlertMock.mock.calls as unknown as [string, string[]][]).map(([s]) => s);
      expect(subjects.some((s) => s.includes("등록 휴대폰 조회 실패(DB)"))).toBe(true);
    } finally { err.mockRestore(); }
  });

  it("토픽 사본은 등록 휴대폰 조회를 기다리지 않는다 — 조회가 느려도(다시 시도해도) 먼저 나간다", async () => {
    let release!: (d: Device[]) => void;
    devicesMock.mockImplementationOnce(() => new Promise<Device[]>((resolve) => { release = resolve; }));
    const pending = notify({ userId: "slow-lookup" });
    // 🔒 조회 뒤에 토픽을 보내면 DB가 느린(타임아웃·재시도) 바로 그 순간에 모든 앱 알림이 늦어진다
    await vi.waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(tokenPushMock).not.toHaveBeenCalled();
    release([device("g1", TOK_READY)]);
    expect((await pending).channels).toEqual(["fcm", "fcm-topic", "email"]);
  });

  it("연결된 보호자가 없으면 휴대폰 조회도 발송도 하지 않는다", async () => {
    db.expertPatient.findMany.mockResolvedValue([]);
    await notify();
    expect(devicesMock).not.toHaveBeenCalled();
    expect(tokenPushMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("등록 휴대폰 발송이 전부 실패하면 fcm으로 세지 않고 남긴다", async () => {
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    tokenPushMock.mockResolvedValueOnce({ sent: 0, failed: 1, invalidTokens: [], deliveredTokens: [], failures: [fcmFail(TOK_READY, "messaging/internal-error")] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect((await notify()).channels).toEqual(["fcm-topic", "email"]);
      expect(warn.mock.calls.some((c) => String(c[0]).includes("등록 휴대폰 발송 실패"))).toBe(true);
    } finally { warn.mockRestore(); }
  });
});

/**
 * 받은 곳이 확인되지 않은 응급(2026-10-07) — 토픽은 구독자 0명이어도 성공하므로, 보호자가 앱에 로그인한 적이 없으면
 *   아무도 못 받았는데 "보냄"으로 끝났다. 전 채널 실패 경보도 울리지 않았다.
 *   이 경보는 1.2.0 프로덕션 단계적 출시가 100%가 된 뒤 켜는 스위치(NEXT_PUBLIC_APP_ON_PLAY=1 → PUSH_TOKENS_LIVE)에서만 — 아래 "스위치 꺼짐" describe.
 *   스위치는 모듈을 읽을 때 정해지므로 env를 바꾼 뒤 모듈 레지스트리를 비운다(notify()가 매번 다시 import한다).
 */
describe("받은 곳이 확인되지 않으면 운영자에게 알린다 (스위치 켜짐 — 1.2.0 단계적 출시 100% 뒤)", () => {
  beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_APP_ON_PLAY", "1"); vi.resetModules(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("토픽만 나갔으면 경보 — 발송은 성공으로 둔다(dedup·notifiedAt 유지)", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    const r = await notify({ userId: "unconfirmed-topic", level: 3 });
    expect(r).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(db.message.update).toHaveBeenCalledTimes(1);
    // 🔒 이게 0회면 구버전 앱·미로그인 보호자의 응급이 "보냄"으로 조용히 끝난다
    expect(opsAlertMock).toHaveBeenCalledTimes(1);
    const [subject, lines] = opsCalls()[0];
    // 🔒 제목에 레벨·분류·어르신 userId — sendOpsAlert는 같은 제목을 1시간 창으로 묶어, 없으면 다른 어르신·다른 응급의 경보가 삼켜진다
    expect(subject).toBe("L3 앱 알림 수신 기기 미확인 medical_acute unconfirmed-topic");
    const text = lines.join("\n");
    expect(text).toMatch(/구버전 앱\(1\.0\.3\)/);
    expect(text).toMatch(/로그인한 적이 없으면/);
    expect(lines).toContain("연결 계정의 등록 휴대폰: 0대(알림 허용 보고 0대)");
    expect(lines).toContain("대상 userId: unconfirmed-topic");
    // 운영 메일에 어르신 실명을 싣지 않는다
    expect(text).not.toContain("김영자");
  });

  it("알림이 꺼졌다고 보고한 휴대폰 + 토픽뿐이어도 경보", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    devicesMock.mockResolvedValue([device("g1", TOK_MUTED, { permission: "denied" })]);
    const r = await notify({ userId: "unconfirmed-muted", level: 2, category: "dizziness_help" });
    expect(r.channels).toEqual(["fcm-muted", "fcm-topic"]);
    const [subject, lines] = opsCalls()[0];
    expect(subject).toBe("L2 앱 알림 수신 기기 미확인 dizziness_help unconfirmed-muted");
    expect(lines).toContain("연결 계정의 등록 휴대폰: 1대(알림 허용 보고 0대)");
  });

  it("어르신마다 제목이 달라 같은 시간대의 다른 어르신 경보가 묶이지 않는다", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    await notify({ userId: "elder-a" });
    await notify({ userId: "elder-b" });
    expect(opsCalls().map(([s]) => s)).toEqual(["L3 앱 알림 수신 기기 미확인 medical_acute elder-a", "L3 앱 알림 수신 기기 미확인 medical_acute elder-b"]);
  });

  it("등록 휴대폰 조회가 실패했으면 '0대'·구버전 앱 탓 대신 '등록 휴대폰 조회 실패(DB)'라고 적는다", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    devicesMock.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await notify({ userId: "unconfirmed-lookup" });
      const unconfirmed = opsCalls().find(([s]) => s === "L3 앱 알림 수신 기기 미확인 medical_acute unconfirmed-lookup");
      expect(unconfirmed).toBeDefined();
      const [, lines] = unconfirmed!;
      expect(lines).toContain("연결 계정의 등록 휴대폰: 등록 휴대폰 조회 실패(DB)");
      // 🔒 몇 대인지 모르는데 "0대"라고 쓰면 운영자는 보호자 앱 문제로 오해하고 DB 장애를 놓친다
      const text = lines.join("\n");
      expect(text).not.toMatch(/0대/);
      expect(text).not.toMatch(/1\.0\.3|구버전/);
    } finally { err.mockRestore(); }
  });

  it("FCM 기기 발송이 8초를 넘기고 받은 곳이 없으면(토픽뿐) — 앵커 없이 다음 턴에 다시, 미확인 경보도 DB·구버전 앱 탓으로 적지 않는다(9차)", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      db.user.findUnique.mockResolvedValue(noContact);
      devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
      tokenPushMock.mockImplementationOnce(() => new Promise<never>(() => {}));
      opsAlertMock.mockRejectedValueOnce(new Error("smtp down"));   // 시간 초과 경보부터 실패 — 결과와 다음 경보는 그대로여야 한다
      const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
      const payload = { ...P, userId: "send-hang-topic", messageId: "m-sh" } as Parameters<typeof notifyGuardian>[0];
      const first = notifyGuardian(payload);
      await vi.advanceTimersByTimeAsync(8000);
      expect(await first).toEqual({ sent: true, channels: ["fcm-topic"] });
      expect(opsCalls().map(([s]) => s)).toEqual([
        "L3 등록 휴대폰 발송 시간 초과(FCM) medical_acute send-hang-topic",
        "L3 앱 알림 수신 기기 미확인 medical_acute send-hang-topic",
      ]);
      const [, unconfirmed] = opsCalls()[1];
      expect(unconfirmed).toContain("연결 계정의 등록 휴대폰: 1대(알림 허용 보고 1대) — FCM 발송이 8초 안에 끝나지 않음");
      expect(unconfirmed).toContain("등록 휴대폰 FCM 발송이 8초 안에 끝나지 않아 실명 알림(등록 휴대폰)이 나갔는지 확인하지 못했습니다.");
      // 🔒 FCM이 느렸는데 DB 탓·구버전 앱 탓으로 적으면 운영자는 엉뚱한 곳을 본다
      for (const [s, lines] of opsCalls()) expect([s, ...lines].join("\n")).not.toMatch(/DB|1\.0\.3|구버전/);
      // 🔒 받은 곳이 없는데 시간 초과를 "보냄"으로 1시간 막으면 FCM이 풀린 뒤에도 등록 휴대폰엔 끝내 안 간다
      expect(db.message.update).not.toHaveBeenCalled();
      vi.advanceTimersByTime(61 * 1000);
      expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm", "fcm-topic"] });
    } finally { err.mockRestore(); vi.useRealTimers(); }
  });

  it("등록 휴대폰을 7.9초에 읽고 FCM 발송이 멈추고 받은 곳이 없으면(토픽뿐) — 미확인 경보도 'DB 조회 7.9초 + FCM 발송 미완'(10차)", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      db.user.findUnique.mockResolvedValue(noContact);
      devicesMock.mockImplementation(() => new Promise<Device[]>((resolve) => { setTimeout(() => resolve([device("g1", TOK_READY)]), 7900); }));
      tokenPushMock.mockImplementationOnce(() => new Promise<never>(() => {}));
      const pending = notify({ userId: "slow-lookup-topic" });
      await vi.advanceTimersByTimeAsync(8000);
      expect(await pending).toEqual({ sent: true, channels: ["fcm-topic"] });
      expect(opsCalls().map(([s]) => s)).toEqual([
        "L3 등록 휴대폰 조회 실패(DB) medical_acute slow-lookup-topic",
        "L3 앱 알림 수신 기기 미확인 medical_acute slow-lookup-topic",
      ]);
      const [, unconfirmed] = opsCalls()[1];
      expect(unconfirmed).toContain("연결 계정의 등록 휴대폰: 1대(알림 허용 보고 1대) — DB 조회 7.9초 + FCM 발송 미완(8초 상한)");
      expect(unconfirmed).toContain("등록 휴대폰 조회(DB)가 늦어(DB 조회 7.9초 + FCM 발송 미완) 실명 알림(등록 휴대폰)이 나갔는지 확인하지 못했습니다.");
      // 🔒 FCM 탓 문구만 남기면 운영자는 느린 DB를 놓친다(9차 문구는 "FCM 발송이 8초 안에 끝나지 않…")
      expect(unconfirmed.join("\n")).not.toContain("FCM 발송이 8초 안에 끝나지 않");
      expect(db.message.update).not.toHaveBeenCalled();
    } finally { err.mockRestore(); vi.useRealTimers(); }
  });

  /**
   * 등록 휴대폰 조회가 8초 안에 끝나지 않았다(2026-10-08 11차) — 조회는 뒤에서 이어져 실명 사본이 늦게라도 나갈 수 있다. 예전엔 조회 실패
   *   경보는 "나갔는지 확인하지 못했습니다"인데 같은 응급의 미확인 경보는 "조회 실패(DB)로 실명 알림은 나가지 않았고"라 서로 엇갈렸다.
   */
  it("등록 휴대폰 조회가 8초 안에 끝나지 않고 받은 곳이 없으면(토픽뿐) — 두 경보 모두 '나갔는지 모른다'(나가지 않았다·빠져 없음, 11차)", async () => {
    vi.useFakeTimers();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      db.user.findUnique.mockResolvedValue(noContact);
      devicesMock.mockImplementation(() => new Promise<never>(() => {}));
      const pending = notify({ userId: "lookup-hang-topic" });
      await vi.advanceTimersByTimeAsync(8000);
      expect(await pending).toEqual({ sent: true, channels: ["fcm-topic"] });
      expect(opsCalls().map(([s]) => s)).toEqual([
        "L3 등록 휴대폰 조회 실패(DB) medical_acute lookup-hang-topic",
        "L3 앱 알림 수신 기기 미확인 medical_acute lookup-hang-topic",
      ]);
      const [[, lookup], [, unconfirmed]] = opsCalls();
      expect(lookup).toContain(LATE_LINE_UNCONFIRMED);
      expect(unconfirmed).toContain("등록 휴대폰 조회(DB)가 8초 안에 끝나지 않아 실명 알림(등록 휴대폰)이 나갔는지 확인하지 못했습니다.");
      // 🔒 (12차) 다시 보내는 것은 같은 응급이 다시 감지될 때뿐이다 — 조건 없이 "다음 대화 턴에" 다시 보낸다고 적지 않는다
      expect(unconfirmed).toContain("중복 방지 기록을 남기지 않았습니다 — 같은 응급이 다음 대화 턴(60초 뒤부터)에 다시 감지되면 다시 보냅니다.");
      // 🔒 같은 응급의 두 경보가 하나는 "나갔는지 모른다", 하나는 "나가지 않았다"면 운영자는 어느 쪽도 믿을 수 없다
      for (const [s, lines] of opsCalls()) expect([s, ...lines].join("\n"), s).not.toMatch(/나가지 않았|사본이 빠져/);
      expect(db.message.update).not.toHaveBeenCalled();
    } finally { err.mockRestore(); vi.useRealTimers(); }
  });

  it("알림 허용 휴대폰에 닿았으면 이메일이 없어도 경보하지 않는다", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    expect((await notify()).channels).toEqual(["fcm", "fcm-topic"]);
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it("이메일이 나갔으면 토픽뿐이어도 경보하지 않는다(받는 주소가 확인되는 채널)", async () => {
    expect((await notify()).channels).toEqual(["fcm-topic", "email"]);
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it("경보가 실패해도 발송 결과는 그대로", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    opsAlertMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(notify()).resolves.toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(opsAlertMock).toHaveBeenCalledTimes(1);   // 경보를 실제로 시도했다(시도조차 안 하면 이 테스트는 공허하다)
  });
});

/**
 * 스위치 꺼짐(지금 — 1.2.0 프로덕션 단계적 출시가 100%가 되기 전): 현장 앱 1.0.3은 휴대폰 등록을 몰라 모든 응급이 "받은 곳 미확인"이다.
 *   그때 경보를 내면 응급마다 운영 메일이 가고, 진짜 장애 경보가 그 속에 묻힌다.
 */
describe("받은 곳 미확인 경보 — 스위치 꺼짐(1.2.0 단계적 출시 100% 전)에는 내지 않는다", () => {
  beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_APP_ON_PLAY", undefined); vi.resetModules(); });
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it("토픽만 나가도 경보 없음 — 발송·dedup은 그대로", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    const r = await notify({ userId: "pre-play-topic" });
    expect(r).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(db.message.update).toHaveBeenCalledTimes(1);
    // 🔒 1.0.3 시대에 켜지면 응급마다 "수신 기기 미확인" 메일이 쌓인다
    expect(opsAlertMock).not.toHaveBeenCalled();
  });
});

/**
 * 등록 휴대폰 조회 실패(DB) — 그 자체가 장애다(2026-10-07 재검토).
 *   예전엔 빈 목록으로 삼켜 실명 사본이 빠진 발송이 "보냄"으로 끝났고, 1시간 dedup까지 걸려 DB가 돌아와도 다시 안 갔다.
 *   지금: 바로 한 번 더 조회 → 그래도 실패면 운영자 경보(늘) + dedup을 걸지 않는다(10차부터 받은 곳이 확인됐어도 — 실명 사본이 빠졌다).
 */
describe("등록 휴대폰 조회 실패(DB) — 운영자 경보, 앵커 없이 다음 턴에 다시(10차 — 받은 곳이 있어도)", () => {
  const lookupAlert = () => opsCalls().find(([s]) => s.includes("등록 휴대폰 조회 실패(DB)"));
  let err: { mockRestore: () => void };
  beforeEach(() => {
    err = vi.spyOn(console, "error").mockImplementation(() => {});
    devicesMock.mockRejectedValue(new Error("connection reset"));
  });
  afterEach(() => { err.mockRestore(); vi.useRealTimers(); });

  it("한 번 실패하면 곧바로 다시 읽는다 — 두 번째에 읽히면 실명 사본도 나가고 경보도 없다", async () => {
    devicesMock.mockRejectedValueOnce(new Error("connection reset")).mockResolvedValueOnce([device("g1", TOK_READY)]);
    const r = await notify({ userId: "lookup-retry-ok" });
    expect(devicesMock).toHaveBeenCalledTimes(2);
    expect(tokenPushMock).toHaveBeenCalledTimes(1);
    expect(r.channels).toEqual(["fcm", "fcm-topic", "email"]);
    expect(lookupAlert()).toBeUndefined();
  });

  it("두 번 다 실패 + 토픽뿐 → 경보(제목에 userId) + notifiedAt·dedup 없이 끝나 다음 턴에 실명 사본까지 다시 간다", async () => {
    vi.useFakeTimers();
    db.user.findUnique.mockResolvedValue(noContact);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "lookup-fail-topic", messageId: "m-lf" } as Parameters<typeof notifyGuardian>[0];
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(devicesMock).toHaveBeenCalledTimes(2);
    expect(tokenPushMock).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledTimes(1);   // 토픽 사본은 조회와 상관없이 나갔다
    const alert = lookupAlert();
    // 🔒 스위치(PUSH_TOKENS_LIVE)와 무관하게 늘 — 이 파일 기본은 스위치 꺼짐이다
    expect(alert?.[0]).toBe("L3 등록 휴대폰 조회 실패(DB) medical_acute lookup-fail-topic");
    const text = alert![1].join("\n");
    // 시도했다고만 적고 결과는 '보낸 경로'에 맡긴다 — 토픽 발송도 실패할 수 있다("그대로 보냈습니다"라고 단정하지 않는다)
    expect(text).toContain("토픽 사본(가린 이름)은 조회와 상관없이 시도했습니다 — 결과는 위 '보낸 경로'(fcm-topic이면 FCM이 받아들였다).");
    expect(text).toContain("중복 방지 기록을 남기지 않았습니다");
    expect(text).not.toContain("김영자");
    // 🔒 dedup 앵커 없음 — notifiedAt을 쓰지 않고(DB dedup), 메모리 상한도 짧은 바닥(60초)만
    expect(db.message.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(61 * 1000);
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);   // DB 복구
    const again = await notifyGuardian(payload);
    expect(again).toEqual({ sent: true, channels: ["fcm", "fcm-topic"] });
    expect(tokenPushMock).toHaveBeenCalledTimes(1);
  });

  it("두 번 다 실패하면 이메일이 나갔어도 — 경보는 보내고 앵커는 걸지 않는다: 61초 뒤 다시 감지되면 실명 사본까지(10차)", async () => {
    vi.useFakeTimers();
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "lookup-fail-email", messageId: "m-le" } as Parameters<typeof notifyGuardian>[0];
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
    const alert = lookupAlert();
    expect(alert?.[0]).toBe("L3 등록 휴대폰 조회 실패(DB) medical_acute lookup-fail-email");
    expect(alert![1].join("\n")).toContain("이메일·메신저로는 전달됐지만 등록 휴대폰 사본이 빠져 중복 방지 기록을 남기지 않았습니다");
    // 읽지 못했다(조회 오류) — 실명 사본은 나가지 않았다. "나갔는지 몰라"·두 번째 알림 안내는 시간 초과일 때만(11차)
    expect(alert![1].join("\n")).not.toMatch(/나갔는지 몰라|늦게라도/);
    // 🔒 예전(9차까지)엔 이메일이 닿았다고 1시간 창을 걸어, DB가 돌아와도 등록 휴대폰(실명 사본)엔 그 응급이 끝내 가지 않았다
    expect(db.message.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(61 * 1000);
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);   // DB 복구
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm", "fcm-topic", "email"] });
    expect(tokenPushMock).toHaveBeenCalledTimes(1);
    expect(db.message.update).toHaveBeenCalledTimes(1);   // 이제 빠진 사본이 없다 → 앵커
  });

  it("다 실패해도(토픽·이메일 없음) 조회 실패 경보는 '전 채널 실패' 경보와 따로 간다", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    pushMock.mockResolvedValue({ sent: 0, failed: 1, failures: [fcmFail("g1", "messaging/internal-error")] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await notify({ userId: "lookup-fail-all", messageId: undefined });
      expect(r.sent).toBe(false);
      // 🔒 전 채널 실패 경보 속에 DB 장애라는 사실이 묻히지 않게
      expect(opsCalls().map(([s]) => s)).toEqual(["L3 등록 휴대폰 조회 실패(DB) medical_acute lookup-fail-all", "응급 알림 실패 L3 medical_acute lookup-fail-all"]);
      const [, lines] = lookupAlert()!;
      expect(lines).toContain("보낸 경로: 없음");
      expect(lines).toContain("메시지 기록: 없음(저장 실패 또는 안전망 경로)");
    } finally { warn.mockRestore(); }
  });

  it("조회 실패 경보가 실패해도(SMTP) 발송 결과는 그대로", async () => {
    opsAlertMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(notify({ userId: "lookup-fail-smtp" })).resolves.toEqual({ sent: true, channels: ["fcm-topic", "email"] });
    expect(lookupAlert()?.[0]).toBe("L3 등록 휴대폰 조회 실패(DB) medical_acute lookup-fail-smtp");   // 시도는 했다
  });
});

/**
 * 등록 휴대폰 경로 8초 상한 + 이메일·토픽은 기다리지 않는다(2026-10-07 3차).
 *   예전엔 웹훅 → 앱 푸시(등록 휴대폰 조회·재시도·발송) → 이메일 차례로 기다려, DB·FCM이 멈춘 바로 그때 이메일까지 묶였다.
 *   지금: 웹훅·이메일은 앱 푸시와 함께 출발하고, 등록 휴대폰 경로(조회 + 발송)는 8초가 넘으면 실패로 친다
 *   (운영자 경보 + 앵커 없음 — 10차부터 받은 곳이 확인됐어도). 토픽 사본은 따로 10초 상한이다(8차 — emergency-notify-send-failures).
 *   9차: 넘긴 단계를 가른다 — DB 조회 중이면 "등록 휴대폰 조회 실패(DB)", FCM 발송 중이면 "등록 휴대폰 발송 시간 초과(FCM)"(DB 탓으로
 *   적지 않는다). 앱을 지운 휴대폰 정리(DB 삭제)는 이 상한 밖에서 2초까지만 기다린다 — 정리가 멈춰도 발송 결과는 FCM 응답 그대로다.
 *   10차(2026-10-08): FCM 탓은 발송 단계가 3초 이상을 썼을 때만 — 조회가 상한을 거의 다 썼으면 DB 쪽 경보에 "DB 조회 7.9초 + FCM 발송
 *   미완". 그리고 이 경로가 실패하면 이메일이 닿았어도 앵커를 걸지 않는다(실명 사본이 빠졌거나 나갔는지 모른다).
 */
describe("등록 휴대폰 경로가 멈춰도 — 8초 상한, 이메일·토픽은 기다리지 않는다", () => {
  const lookupAlert = () => opsCalls().find(([s]) => s.includes("등록 휴대폰 조회 실패(DB)"));
  const never = () => new Promise<never>(() => {});
  let err: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeEach(() => {
    vi.useFakeTimers();
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { err.mockRestore(); vi.useRealTimers(); });

  /** 가짜 시계로 보낸 시각을 남긴다 — 이메일·토픽이 앱 푸시를 기다렸다면 0이 아니다 */
  function stampSends() {
    const t0 = Date.now();
    const at: Record<string, number> = {};
    emailMock.mockImplementationOnce(async () => { at.email = Date.now() - t0; return "ok"; });
    pushMock.mockImplementationOnce(async () => { at.topic = Date.now() - t0; return { sent: 1, failed: 0, failures: [] }; });
    return at;
  }

  it("등록 휴대폰 조회가 끝내 답하지 않아도 이메일·토픽은 곧바로 — 8초에 조회 실패로 끝난다(경보, 이메일이 확인돼도 앵커 없음 — 10차)", async () => {
    devicesMock.mockImplementation(never);
    const at = stampSends();
    let done = false;
    const pending = notify({ userId: "device-hang" }).then((r) => { done = true; return r; });
    await vi.advanceTimersByTimeAsync(7999);
    // 🔒 이메일이 앱 푸시 뒤에 줄 서 있으면 DB가 멈춘 바로 그때 보호자 이메일까지 늦는다
    expect(at).toEqual({ email: 0, topic: 0 });
    expect(done).toBe(false);   // 아직 상한 전 — 등록 휴대폰 경로를 기다리는 중
    await vi.advanceTimersByTimeAsync(1);
    // 🔒 상한이 없으면 응급 알림 전체(경보·dedup 기록 포함)가 여기서 끝없이 멈춘다
    expect(done).toBe(true);
    expect(await pending).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
    expect(tokenPushMock).not.toHaveBeenCalled();
    expect(lookupAlert()?.[0]).toBe("L3 등록 휴대폰 조회 실패(DB) medical_acute device-hang");
    // 9차: 조회 단계에서 넘겼다 — 그 단계를 적는다(FCM 발송 단계면 아래 "FCM 기기 발송이 멈춰도"의 다른 경보)
    expect(lookupAlert()![1].join("\n")).toContain("등록 휴대폰 조회(DB)가 8초 안에 끝나지 않아 기다리지 않았습니다");
    // 🔒 (11차) 시간 초과는 "빠져"가 아니다 — 경로가 뒤에서 이어져 늦게라도 나갔을 수 있고, 60초 뒤 재발송이 그 휴대폰엔 두 번째 알림일 수 있다
    expect(lookupAlert()![1]).toContain(LATE_LINE_CONFIRMED);
    expect(lookupAlert()![1].join("\n")).not.toContain("사본이 빠져");
    expect(err.mock.calls.some((c) => String(c[0]).includes("8초 안에 끝나지 않음(DB 조회 중)"))).toBe(true);
    // 🔒 실명 사본이 나갔는지 모른다 — 이메일이 닿았어도 앵커를 걸면 그 휴대폰엔 끝내 다시 가지 않는다(10차)
    expect(db.message.update).not.toHaveBeenCalled();
  });

  it("연락처가 없으면(토픽뿐) 8초에 경보 + 앵커 없음 — 61초 뒤 다음 턴에 실명 사본까지 다시 간다", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    devicesMock.mockImplementation(never);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "device-hang-topic", messageId: "m-dh" } as Parameters<typeof notifyGuardian>[0];
    const first = notifyGuardian(payload);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await first).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(lookupAlert()?.[0]).toBe("L3 등록 휴대폰 조회 실패(DB) medical_acute device-hang-topic");
    // 🔒 시간 초과를 "보냄"으로 1시간 막으면 DB가 풀린 뒤에도 등록 휴대폰엔 끝내 안 간다
    expect(db.message.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(61 * 1000);
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);   // DB가 풀렸다
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm", "fcm-topic"] });
  });

  it("조회가 아니라 FCM 기기 발송이 멈춰도 같은 상한 — 경보는 FCM 탓으로: 제목·본문에 DB가 없고 읽은 대수를 싣는다(9차)", async () => {
    devicesMock.mockResolvedValue([device("g1", TOK_READY), device("g2", TOK_MUTED, { permission: "denied" })]);
    tokenPushMock.mockImplementationOnce(never);
    const pending = notify({ userId: "device-send-hang" });
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
    expect(tokenPushMock).toHaveBeenCalledTimes(1);
    // 🔒 DB는 멀쩡하고 FCM이 느렸는데 "등록 휴대폰 조회 실패(DB)"라고 적으면 운영자는 엉뚱한 곳(DB)을 본다
    expect(opsCalls()).toHaveLength(1);
    const [subject, lines] = opsCalls()[0];
    expect(subject).toBe("L3 등록 휴대폰 발송 시간 초과(FCM) medical_acute device-send-hang");
    expect([subject, ...lines].join("\n")).not.toMatch(/DB/);
    // 조회는 끝났다 — 몇 대인지 안다
    expect(lines).toContain("연결 계정의 등록 휴대폰: 2대(알림 허용 보고 1대) — FCM 발송이 8초 안에 끝나지 않음");
    expect(lines.join("\n")).toContain("FCM 발송이 8초 안에 끝나지 않아 기다리지 않았습니다");
    expect(lines).toContain("토픽 사본(가린 이름)은 등록 휴대폰 발송과 상관없이 따로 시도했습니다 — 결과는 위 '보낸 경로'(fcm-topic이면 FCM이 받아들였다).");
    expect(lines.join("\n")).toContain("이메일·메신저로는 전달됐지만 등록 휴대폰 사본이 나갔는지 몰라 중복 방지 기록을 남기지 않았습니다");
    expect(lines).toContain(LATE_LINE_CONFIRMED);   // 11차 — 조회 시간 초과와 같은 줄(늦게라도 나갔다면 두 번째 알림)
    expect(err.mock.calls.some((c) => String(c[0]).includes("8초 안에 끝나지 않음(FCM 발송 중)"))).toBe(true);
    expect(db.message.update).not.toHaveBeenCalled();   // 이메일이 확인됐어도 앵커 없음(10차)
  });

  /**
   * 시간 초과를 FCM 탓으로 적는 것은 발송 단계가 3초(SEND_STAGE_MIN_MS) 이상을 썼을 때뿐이다(2026-10-08 10차). 9차는 조회가 끝나기만 하면
   *   "등록 휴대폰 발송 시간 초과(FCM)"라, 조회가 7.9초 걸리고 발송엔 0.1초만 남아도 운영자는 FCM을 봤다. 이제 그런 경우는 DB 쪽 경보에
   *   "DB 조회 7.9초 + FCM 발송 미완"을 함께 적는다(읽은 대수도).
   */
  it("등록 휴대폰을 7.9초에 읽고 FCM 발송이 멈추면 — FCM만 탓하지 않는다: 조회 실패(DB) 경보에 'DB 조회 7.9초 + FCM 발송 미완'(10차)", async () => {
    devicesMock.mockImplementation(() => new Promise<Device[]>((resolve) => { setTimeout(() => resolve([device("g1", TOK_READY)]), 7900); }));
    tokenPushMock.mockImplementationOnce(never);
    const pending = notify({ userId: "slow-lookup-send" });
    await vi.advanceTimersByTimeAsync(8000);
    expect(await pending).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
    expect(tokenPushMock).toHaveBeenCalledTimes(1);   // 조회는 끝나 발송에 들어갔다
    // 🔒 발송엔 0.1초만 남았다 — "발송 시간 초과(FCM)"로 적으면 운영자는 느린 DB를 두고 FCM을 본다
    expect(opsCalls().map(([s]) => s)).toEqual(["L3 등록 휴대폰 조회 실패(DB) medical_acute slow-lookup-send"]);
    const text = opsCalls()[0][1].join("\n");
    expect(text).toContain("등록 휴대폰 조회(DB)가 8초 상한을 거의 다 써(DB 조회 7.9초 + FCM 발송 미완) 기다리지 않았습니다");
    expect(text).toContain("등록 휴대폰 1대로 가는 실명 알림이 나갔는지 확인하지 못했습니다");
    // 🔒 (11차) 늦은 조회 + 발송 미완도 시간 초과다 — 발송은 이미 시작돼 늦게라도 나갔을 수 있다("빠져"라고 적지 않는다)
    expect(opsCalls()[0][1]).toContain(LATE_LINE_CONFIRMED);
    expect(text).not.toContain("사본이 빠져");
    expect(err.mock.calls.some((c) => String(c[0]).includes("8초 안에 끝나지 않음(DB 조회 7.9초 + FCM 발송 미완)"))).toBe(true);
    expect(db.message.update).not.toHaveBeenCalled();
  });

  it.each([
    [5000, "L3 등록 휴대폰 발송 시간 초과(FCM) medical_acute stage-5000"],   // 발송에 정확히 3초 — FCM 탓
    [5001, "L3 등록 휴대폰 조회 실패(DB) medical_acute stage-5001"],         // 3초에 못 미친다 — DB 쪽 + 함께 적기
  ])("조회가 %ims에 끝나고 발송이 멈추면 → %s(경계: 발송 단계 3초)", async (lookupMs, subject) => {
    devicesMock.mockImplementation(() => new Promise<Device[]>((resolve) => { setTimeout(() => resolve([device("g1", TOK_READY)]), lookupMs); }));
    tokenPushMock.mockImplementationOnce(never);
    const pending = notify({ userId: `stage-${lookupMs}` });
    await vi.advanceTimersByTimeAsync(8000);
    await pending;
    expect(opsCalls().map(([s]) => s)).toEqual([subject]);
  });

  it("FCM 기기 발송 시간 초과에 다른 곳도 다 실패하면(보낸 곳 없음) — 시간 초과 경보가 '응급 알림 실패' 경보와 따로, 먼저 간다(9차)", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    tokenPushMock.mockImplementationOnce(never);
    pushMock.mockResolvedValue({ sent: 0, failed: 1, failures: [fcmFail("g1", "messaging/internal-error")] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pending = notify({ userId: "send-hang-all", messageId: undefined });
      await vi.advanceTimersByTimeAsync(8000);
      expect((await pending).sent).toBe(false);
      // 🔒 전 채널 실패 경보 속에 "FCM이 멈췄다"는 사실이 묻히지 않게 — 그리고 DB 탓으로 적지 않는다
      expect(opsCalls().map(([s]) => s)).toEqual([
        "L3 등록 휴대폰 발송 시간 초과(FCM) medical_acute send-hang-all", "응급 알림 실패 L3 medical_acute send-hang-all",
      ]);
      const [, lines] = opsCalls()[0];
      expect(lines).toContain("보낸 경로: 없음");
      expect(lines).toContain("메시지 기록: 없음(저장 실패 또는 안전망 경로)");
      // (12차) 받은 곳이 없을 때의 까닭은 빠졌거나 나갔는지 모르는 사본 — FCM 발송 시간 초과라 "조회 실패"만 적지 않는다
      expect(lines).toContain(LATE_LINE_UNCONFIRMED);
    } finally { warn.mockRestore(); }
  });

  /**
   * 토큰 정리는 등록 휴대폰 경로의 시간 상한 밖에서(2026-10-07 9차) — 예전엔 경로 안에서 정리(DB 삭제)를 기다려, 삭제 쿼리가 멈추면 8초에
   *   경로 전체가 "등록 휴대폰 조회 실패(DB)"가 됐다: 이미 받은 휴대폰(fcm)이 빠져 받은 곳이 확인된 응급처럼 보이지 않았고, 고칠 것(앱을
   *   지운 휴대폰 — 영구 실패)은 경보에서 사라졌다. 이제 결과는 FCM 응답 그대로이고, 정리는 그 뒤에 2초까지만 기다린다.
   */
  it("토큰 정리(DB 삭제)가 끝내 답하지 않아도 결과는 FCM 응답 그대로 — fcm·없는 기기 영구 실패 경보 한 통, '조회 실패(DB)' 없음 · 정리는 2초까지(9차)", async () => {
    const TOK_DEAD = "dead_" + "d".repeat(40);
    devicesMock.mockResolvedValue([device("g1", TOK_READY), device("g2", TOK_DEAD)]);
    tokenPushMock.mockResolvedValueOnce({
      sent: 1, failed: 1, invalidTokens: [TOK_DEAD], deliveredTokens: [TOK_READY],
      failures: [fcmFail(TOK_DEAD, "messaging/registration-token-not-registered", "token")],
    });
    deleteTokensMock.mockImplementation(never);
    let done = false;
    const pending = notify({ userId: "cleanup-hang" }).then((r) => { done = true; return r; });
    await vi.advanceTimersByTimeAsync(1999);
    // 🔒 정리를 아예 기다리지 않으면(부유 프라미스) 호출부의 after()가 먼저 끝나 정리가 잘린다 — 2초까지는 기다린다
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // 🔒 정리가 경로 안에 있으면 8초까지 멈췄다가 "조회 실패(DB)"로 끝난다
    expect(done).toBe(true);
    const r = await pending;
    expect(r.channels).toEqual(["fcm", "fcm-topic", "email"]);
    expect(deleteTokensMock).toHaveBeenCalledWith([TOK_DEAD]);
    expect(opsCalls().map(([s]) => s)).toEqual(["L3 위급 알림 일부 경로 영구 실패 medical_acute cleanup-hang"]);
    const [, lines] = opsCalls()[0];
    expect(lines).toContain("실패한 경로: fcm(영구 실패 messaging/registration-token-not-registered)");
    expect(lines).toContain("연결 계정의 등록 휴대폰: 2대(알림 허용 보고 2대)");
    expect(lines.join("\n")).not.toContain("조회 실패(DB)");
    expect(db.message.update).toHaveBeenCalledTimes(1);   // 받은 곳(fcm·이메일)이 확인됐다 → 앵커
    expect(err.mock.calls.some((c) => String(c[0]).includes("쓸 수 없는 토큰 정리가 2초 안에 끝나지 않음"))).toBe(true);
  });
});

/**
 * push_device 테이블 없음(위급 알림 경로, 2026-10-07 4차) — 운영 스크립트보다 배포가 먼저 나가면 등록 휴대폰이 0대로 처리돼
 *   실명 사본이 모든 응급에서 빠진다. 예전엔 로그 한 줄뿐이었다. 이제 고정 제목의 운영자 경보(어르신 정보 없음 —
 *   sendOpsAlert가 같은 제목을 1시간에 한 번으로 묶는다). 0대로 보내는 동작(토픽 사본·앵커)은 그대로다.
 */
describe("push_device 테이블 없음 — 고정 제목의 운영자 경보", () => {
  const TABLE = "push_device 테이블 없음 — scripts/ops-push-device.ts 실행 필요";
  const missingTable = () => new Error('Raw query failed. Code: `42P01`. Message: `relation "push_device" does not exist`');

  it("0대로 보내고(토픽 사본·앵커 그대로) 다시 읽지 않는다 — 어르신이 달라도 같은 제목, 제목·본문에 어르신 정보 없음", async () => {
    devicesMock.mockRejectedValue(missingTable());
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await notify({ userId: "table-missing-a" })).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
      // 🔒 장애가 아니라 배포 상태 — 다시 읽지 않고, "조회 실패(DB)" 경보·앵커 해제로 다루지 않는다
      expect(devicesMock).toHaveBeenCalledTimes(1);
      expect(db.message.update).toHaveBeenCalledTimes(1);
      await notify({ userId: "table-missing-b", category: "fall_injury" });
      const subjects = opsCalls().map(([s]) => s);
      // 🔒 제목이 고정이어야 sendOpsAlert가 1시간에 한 통으로 묶는다(응급마다 메일이 쌓이지 않게)
      expect(subjects).toEqual([TABLE, TABLE]);
      for (const [s, lines] of opsCalls()) expect([s, ...lines].join("\n")).not.toMatch(/table-missing|김응급|medical_acute|fall_injury/);
      expect(err.mock.calls.some((c) => String(c[0]).includes("push_device 테이블 없음"))).toBe(true);
    } finally { err.mockRestore(); }
  });

  it("다른 곳도 다 실패하면(보낸 곳 없음) 테이블 없음 경보와 '응급 알림 실패' 경보가 따로 간다 · 경보가 실패해도 결과는 그대로", async () => {
    devicesMock.mockRejectedValue(missingTable());
    db.user.findUnique.mockResolvedValue(noContact);
    pushMock.mockResolvedValue({ sent: 0, failed: 1, failures: [fcmFail("g1", "messaging/internal-error")] });
    opsAlertMock.mockRejectedValueOnce(new Error("smtp down"));   // 테이블 없음 경보부터 실패
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await notify({ userId: "table-missing-all" });
      expect(r.sent).toBe(false);
      expect(opsCalls().map(([s]) => s)).toEqual([TABLE, "응급 알림 실패 L3 medical_acute table-missing-all"]);
    } finally { err.mockRestore(); warn.mockRestore(); }
  });
});
