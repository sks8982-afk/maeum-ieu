/**
 * 위급 알림 — 조회와 기다림: 보호자 연락처(users)·연결(ExpertPatient) 조회 실패의 경보와 앵커 규칙, 진행 중 표시(같은 응급의 두 번째
 *   호출), DB 기다림 상한(중복 확인·연락처·연결 조회·notifiedAt 기록).
 *   2026-10-07 8차에 __tests__/emergency-notify.test.ts에서 **그대로 옮겼다**(파일 나눔 — 그 파일 머리 주석).
 *   공용 목·도우미는 __tests__/helpers/emergency-notify-harness.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  db, fcmFail, pushMock, emailMock, tokenPushMock, devicesMock, opsAlertMock, dnsLookup, P, notify, TOK_READY, TOK_MUTED, device,
  opsCalls, noContact,
} from "./helpers/emergency-notify-harness";

/**
 * 보호자 연락처 조회 실패(DB)(2026-10-07 3차) — 연락처(이메일·메신저 주소)를 못 읽으면 그 두 채널이 통째로 빠진다.
 *   예전엔 로그 한 줄로 끝났고, 토픽 사본만 나간 발송이 1시간 dedup까지 걸어 DB가 돌아와도 이메일이 끝내 안 갔다.
 *   지금: 운영자 경보(늘) + dedup 앵커 없음(다음 턴에 이메일까지 다시 — 10차부터 받은 곳이 확인됐어도).
 *   lookupFailed(연결 조회 실패에도 켜진다)와는 다른 플래그다 — 연결 조회만 실패하면 이 경보는 없다.
 */
describe("보호자 연락처 조회 실패(DB) — 운영자 경보, 앵커 없이 다음 턴에 이메일까지 다시", () => {
  const contactAlert = () => opsCalls().find(([s]) => s.includes("보호자 연락처 조회 실패(DB)"));
  let err: { mockRestore: () => void };
  beforeEach(() => { err = vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { err.mockRestore(); vi.useRealTimers(); });

  it("연락처 조회 실패 + 등록 휴대폰 0대(토픽뿐) → 경보 + notifiedAt·1시간 앵커 없음 → 61초 뒤 연락처가 돌아오면 이메일이 간다", async () => {
    vi.useFakeTimers();
    db.user.findUnique.mockRejectedValue(new Error("db down"));
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "contact-fail-topic", messageId: "m-cf" } as Parameters<typeof notifyGuardian>[0];
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(emailMock).not.toHaveBeenCalled();
    const alert = contactAlert();
    // 🔒 스위치(PUSH_TOKENS_LIVE)와 무관하게 늘(이 파일 기본은 꺼짐), 제목에 userId — 다른 어르신 경보에 삼켜지지 않게
    expect(alert?.[0]).toBe("L3 보호자 연락처 조회 실패(DB) medical_acute contact-fail-topic");
    const text = alert![1].join("\n");
    expect(text).toContain("이메일·메신저(webhook) 발송은 건너뛰었습니다");
    expect(text).toContain("앱 알림 토픽 사본(가린 이름)과 등록 휴대폰 알림은 연락처와 상관없이 시도했습니다 — 결과는 위 '보낸 경로'");
    expect(text).toContain("보낸 경로: fcm-topic");
    expect(text).toContain("중복 방지 기록을 남기지 않았습니다");
    expect(text).not.toContain(P.userName);   // 운영 메일에 이름을 싣지 않는다
    // 🔒 dedup 앵커 없음 — notifiedAt을 쓰지 않고, 메모리 상한도 짧은 바닥(60초)만
    expect(db.message.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(61 * 1000);
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: null });   // DB 복구
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(db.message.update).toHaveBeenCalledTimes(1);   // 이제 받은 곳(이메일)이 확인돼 앵커를 건다
  });

  it("연락처를 못 읽으면 알림을 허용한 등록 휴대폰에 닿았어도 앵커 없음 — 경보, 61초 뒤 다시 감지되면 이메일까지(10차)", async () => {
    vi.useFakeTimers();
    db.user.findUnique.mockRejectedValue(new Error("db down"));
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "contact-fail-fcm", messageId: "m-cff" } as Parameters<typeof notifyGuardian>[0];
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm", "fcm-topic"] });
    // 🔒 예전(9차까지)엔 휴대폰이 받았다고 1시간 앵커 — DB가 돌아와도 이메일·메신저는 그 응급에 끝내 가지 않았다
    expect(db.message.update).not.toHaveBeenCalled();
    // 🔒 (12차) 다시 보내는 것은 같은 응급이 다시 감지될 때뿐이다(재시도 큐는 없다) — 그래서 빠진 경로의 보호자에게 직접 확인하라고 적는다
    expect(contactAlert()![1]).toContain(
      "알림을 허용한 등록 휴대폰으로는 전달됐지만 이메일·메신저가 빠져 중복 방지 기록을 남기지 않았습니다 — 같은 응급이 다음 대화 턴(60초 뒤부터)에 " +
      "다시 감지되면 다시 보냅니다(연락처를 읽으면 이메일·메신저도 갑니다. 이미 받은 곳은 한 번 더 받습니다). 빠진 경로로 받는 보호자에게는 직접 확인해 주세요.",
    );
    vi.advanceTimersByTime(61 * 1000);
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: null });   // DB 복구
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm", "fcm-topic", "email"] });
    expect(db.message.update).toHaveBeenCalledTimes(1);
  });

  it("연결 조회만 실패하면(연락처는 읽음) 이 경보는 없다 — 연락처 조회 실패와 연결 조회 실패는 다른 장애다", async () => {
    db.expertPatient.findMany.mockRejectedValue(new Error("db down"));
    expect((await notify({ userId: "link-fail-only" })).channels).toEqual(["email"]);
    // 🔒 연결 조회 실패에 "연락처 조회 실패"를 울리면 운영자는 멀쩡한 users 조회를 찾아 헤맨다
    expect(contactAlert()).toBeUndefined();
  });

  it("연락처 조회 실패 경보가 실패해도(SMTP) 발송 결과는 그대로", async () => {
    db.user.findUnique.mockRejectedValue(new Error("db down"));
    opsAlertMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(notify({ userId: "contact-fail-smtp" })).resolves.toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(contactAlert()?.[0]).toBe("L3 보호자 연락처 조회 실패(DB) medical_acute contact-fail-smtp");   // 시도는 했다
  });
});

/**
 * 보호자 연결 조회 실패(DB)(2026-10-07 6차) — 연결(ExpertPatient)을 못 읽으면 앱 알림(등록 휴대폰 실명 사본·토픽 사본)이 통째로
 *   빠진다(보낼 계정을 모른다). 예전엔 로그 한 줄로 끝나, 이메일만 나간 발송이 그냥 "보냄"이었다. 지금: 운영자 경보(늘 — 받은 곳이
 *   확인돼도, PUSH_TOKENS_LIVE와 무관) + 앵커 규칙은 다른 조회와 같다(60초 바닥만 — 10차부터 받은 곳이 확인됐어도). 전 채널 실패 경보 본문에도 적는다.
 */
describe("보호자 연결 조회 실패(DB) — 운영자 경보(늘), 앵커 없이 다음 턴에 다시", () => {
  const linkAlert = () => opsCalls().find(([s]) => s.includes("보호자 연결 조회 실패(DB)"));
  let err: { mockRestore: () => void };
  beforeEach(() => {
    err = vi.spyOn(console, "error").mockImplementation(() => {});
    db.expertPatient.findMany.mockRejectedValue(new Error("db down"));
  });
  afterEach(() => { err.mockRestore(); vi.useRealTimers(); });

  it("연결 조회 실패 + 이메일 성공 → 경보(제목에 userId, 이름·주소 없음) + 앵커 없음(10차 — 61초 뒤 다시 감지되면 앱 알림까지)", async () => {
    vi.useFakeTimers();
    db.user.findUnique.mockResolvedValue({ name: "김영자", guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: null });
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "link-fail-email", messageId: "m-lk" } as Parameters<typeof notifyGuardian>[0];
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["email"] });
    expect(pushMock).not.toHaveBeenCalled();
    expect(devicesMock).not.toHaveBeenCalled();
    const alert = linkAlert();
    // 🔒 받은 곳(이메일)이 확인돼도 늘 — 예전엔 앱 알림이 통째로 빠진 걸 아무도 몰랐다
    expect(alert?.[0]).toBe("L3 보호자 연결 조회 실패(DB) medical_acute link-fail-email");
    const text = alert![1].join("\n");
    expect(text).toContain("앱 알림(등록 휴대폰 실명 사본·토픽 사본)은 보내지 못했습니다");
    expect(text).toContain("보낸 경로: email");
    expect(text).toContain("이메일·메신저로는 전달됐지만 앱 알림이 빠져 중복 방지 기록을 남기지 않았습니다");
    // 연락처는 읽었다 — 이메일·메신저는 시도했다고만 적고 결과는 '보낸 경로'에 맡긴다("그대로 보냈습니다"라고 단정하지 않는다)
    expect(text).toContain("이메일·메신저(webhook)는 연결과 상관없이 시도했습니다 — 결과는 위 '보낸 경로'.");
    expect(text).not.toMatch(/김영자|김응급|g@example\.com/);
    // 🔒 예전(9차까지)엔 이메일이 닿았다고 앵커(1시간) — DB가 돌아와도 보호자 앱 알림은 그 응급에 끝내 가지 않았다
    expect(db.message.update).not.toHaveBeenCalled();
    // 🔒 연결 조회 실패에 연락처 조회 실패 경보를 울리면 운영자는 멀쩡한 users 조회를 찾아 헤맨다
    expect(opsCalls().some(([s]) => s.includes("보호자 연락처 조회 실패"))).toBe(false);
    vi.advanceTimersByTime(61 * 1000);
    db.expertPatient.findMany.mockResolvedValue([{ expertUserId: "g1" }]);   // DB 복구
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(db.message.update).toHaveBeenCalledTimes(1);
  });

  it("연결 조회 실패 + 이메일 일시 실패(보낸 곳 없음) → 앵커 없음(60초 바닥) + 연결 조회 실패 경보 + '응급 알림 실패' 본문에도 적는다", async () => {
    vi.useFakeTimers();
    emailMock.mockResolvedValue("transient");
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "link-fail-transient", messageId: "m-lt" } as Parameters<typeof notifyGuardian>[0];
    expect((await notifyGuardian(payload)).sent).toBe(false);
    // 🔒 조회 실패 경보는 전 채널 실패 경보와 따로, 먼저 — DB 장애라는 사실이 묻히지 않게
    expect(opsCalls().map(([s]) => s)).toEqual([
      "L3 보호자 연결 조회 실패(DB) medical_acute link-fail-transient",
      "응급 알림 실패 L3 medical_acute link-fail-transient",
    ]);
    // 🔒 (12차) 앵커를 막은 까닭은 받은 곳이 없어서가 아니라 빠진 사본이다 — 다시 보내는 것도 같은 응급이 다시 감지될 때뿐이다
    expect(linkAlert()![1]).toContain(
      "받은 곳이 확인되지 않았고, 조회 실패(또는 등록 휴대폰 경로 시간 초과)로 빠졌거나 나갔는지 모르는 사본이 있어 중복 방지 기록을 남기지 " +
      "않았습니다 — 같은 응급이 다음 대화 턴(60초 뒤부터)에 다시 감지되면 다시 보냅니다(연결을 읽으면 앱 알림도 갑니다). 보호자에게 직접 확인해 주세요.",
    );
    const [, allFail] = opsCalls()[1];
    expect(allFail).toContain("실패한 경로: email");
    // 🔒 사유가 "모든 채널 발송 실패"뿐이면 앱 알림이 대상을 몰라 아예 안 나갔다는 사실이 이 경보에서 빠진다
    expect(allFail).toContain("보호자 연결 조회 실패(DB) — 연결 보호자 앱 알림(등록 휴대폰·토픽 사본)은 보낼 계정을 몰라 보내지 못했습니다.");
    expect(db.message.update).not.toHaveBeenCalled();
    // 60초 바닥만 — 61초 뒤 DB·SMTP가 돌아오면 앱 알림까지 간다
    vi.advanceTimersByTime(61 * 1000);
    db.expertPatient.findMany.mockResolvedValue([{ expertUserId: "g1" }]);
    emailMock.mockResolvedValue("ok");
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
  });

  it("연결 조회 실패 + 연락처 없음 → '알림 대상 없음'(설정 문제)으로 적지 않는다 — 제목 '응급 알림 실패', 사유 '보호자 조회 실패'", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    const r = await notify({ userId: "link-fail-nocontact" });
    expect(r.sent).toBe(false);
    // 🔒 대상을 못 읽은 것(장애)을 "보호자 미연결"(설정)로 적으면 운영자가 원인을 영영 못 찾는다
    expect(r.reason).toBe("보호자 조회 실패 — 발송 대상 확인 불가(DB 장애 의심)");
    expect(opsCalls().map(([s]) => s)).toEqual([
      "L3 보호자 연결 조회 실패(DB) medical_acute link-fail-nocontact",
      "응급 알림 실패 L3 medical_acute link-fail-nocontact",
    ]);
  });

  /**
   * 두 조회가 한 응급에서 함께 실패(2026-10-08) — 예전엔 연락처 조회 실패 경보가 앱 알림을, 연결 조회 실패 경보가 이메일·메신저를 "그대로
   *   보냈습니다"라고 적어, 같은 응급에 함께 간 두 경보가 서로 엇갈렸다(앱 알림은 연결을 못 읽어, 이메일·메신저는 연락처를 못 읽어 아무것도
   *   나가지 않았다). 지금: 두 경보가 같은 사실을 적는다 — 둘 다 보내지 못했다.
   */
  it("연락처·연결 조회가 함께 실패하면 두 경보가 서로의 경로를 '보냈다'고 적지 않는다 — 둘 다 보내지 못했다고(엇갈림 없음)", async () => {
    db.user.findUnique.mockRejectedValue(new Error("db down"));
    const r = await notify({ userId: "both-lookups-fail" });
    expect(r).toMatchObject({ sent: false, channels: [], reason: "보호자 조회 실패 — 발송 대상 확인 불가(DB 장애 의심)" });
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(opsCalls().map(([s]) => s)).toEqual([
      "L3 보호자 연락처 조회 실패(DB) medical_acute both-lookups-fail",
      "L3 보호자 연결 조회 실패(DB) medical_acute both-lookups-fail",
      "응급 알림 실패 L3 medical_acute both-lookups-fail",
    ]);
    const [contact, link] = [opsCalls()[0][1].join("\n"), opsCalls()[1][1].join("\n")];
    for (const text of [contact, link]) {
      expect(text).toContain("보낸 경로: 없음");
      // 🔒 한쪽 경보가 다른 쪽 경로를 "그대로 보냈다"(또는 "시도했다")고 적으면, 함께 간 다른 쪽 경보("보내지 못했습니다")와 엇갈린다
      expect(text).not.toContain("그대로 보냈");
      expect(text).not.toContain("상관없이 시도했습니다");
    }
    // 🔒 두 경보가 같은 사실을 적는다 — 이메일·메신저는 연락처를 못 읽어, 앱 알림은 연결을 못 읽어 보내지 못했다
    expect(contact).toContain("이메일·메신저(webhook) 발송은 건너뛰었습니다");
    expect(link).toContain("이메일·메신저(webhook)도 보내지 못했습니다 — 보호자 연락처 조회도 실패해 주소를 모릅니다");
    expect(link).toContain("앱 알림(등록 휴대폰 실명 사본·토픽 사본)은 보내지 못했습니다");
    expect(contact).toContain("앱 알림(토픽 사본·등록 휴대폰)도 보내지 못했습니다 — 보호자 연결 조회도 실패해 보낼 계정을 모릅니다");
  });

  it("연결 조회 실패 경보가 실패해도(SMTP) 발송 결과는 그대로 · 메시지 기록이 없는 턴(저장 실패)은 그렇게 적는다", async () => {
    opsAlertMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(notify({ userId: "link-fail-smtp", messageId: undefined })).resolves.toEqual({ sent: true, channels: ["email"] });
    expect(linkAlert()?.[0]).toBe("L3 보호자 연결 조회 실패(DB) medical_acute link-fail-smtp");   // 시도는 했다
    expect(linkAlert()![1]).toContain("메시지 기록: 없음(저장 실패 또는 안전망 경로)");
  });
});

/**
 * 진행 중 표시·경보 순서(2026-10-07 4차).
 *   · 앵커(markSent)는 발송이 끝난 뒤에야 남는다 — 그 사이(등록 휴대폰 경로 최대 8초·이메일 최대 35초 등) 같은 응급이 다시 들어오면
 *     이메일·메신저·앱 푸시가 한 번 더 나갔다. 시작할 때 진행 중 표시(50초 — 8차, 7차까지 45초)를 남겨 막는다.
 *   · 앵커·notifiedAt은 운영자 경보를 기다리기 **전에** 남긴다 — 경보 메일이 멈추거나 실패해도 기록은 이미 있다.
 */
describe("진행 중 표시 · 경보보다 먼저 남기는 앵커", () => {
  const never = () => new Promise<never>(() => {});
  let err: { mockRestore: () => void };
  beforeEach(() => { err = vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => { err.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  type Payload = Parameters<typeof import("@/lib/chat/emergency-notify").notifyGuardian>[0];

  it("같은 응급이 첫 발송의 등록 휴대폰 대기(최대 8초) 중에 다시 들어와도 이메일·메신저·앱 푸시를 다시 보내지 않는다", async () => {
    vi.useFakeTimers();
    devicesMock.mockImplementation(never);
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: "https://hook.example.com/x", guardianEmail: "g@example.com", guardianName: null });
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "in-flight", messageId: "m-if" } as Payload;
    const first = notifyGuardian(payload);
    await vi.advanceTimersByTimeAsync(1000);
    expect([emailMock.mock.calls.length, pushMock.mock.calls.length, fetchSpy.mock.calls.length]).toEqual([1, 1, 1]);
    // 🔒 진행 중 표시가 없으면 이 두 번째 호출이 이메일·메신저·토픽을 한 번 더 보낸다(첫 발송은 아직 등록 휴대폰을 기다리는 중)
    expect(await notifyGuardian(payload)).toMatchObject({ sent: false, channels: [] });
    expect([emailMock.mock.calls.length, pushMock.mock.calls.length, fetchSpy.mock.calls.length]).toEqual([1, 1, 1]);
    expect(devicesMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7000);
    expect(await first).toEqual({ sent: true, channels: ["webhook", "fcm-topic", "email"] });
  });

  it("진행 중 표시는 SMTP가 느려도(30초) 이어진다 — 수명(50초)이 앵커 전 기다림의 상한 합보다 길다", async () => {
    vi.useFakeTimers();
    emailMock.mockImplementationOnce(() => new Promise<"ok">((resolve) => { setTimeout(() => resolve("ok"), 30_000); }));
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "slow-smtp", messageId: "m-ss" } as Payload;
    const first = notifyGuardian(payload);
    await vi.advanceTimersByTimeAsync(29_000);
    expect((await notifyGuardian(payload)).sent).toBe(false);
    expect(emailMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await first).channels).toEqual(["fcm-topic", "email"]);
  });

  it("DB dedup으로 건너뛰면 진행 중 표시를 거둔다 — 다음 호출을 막지 않는다", async () => {
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "dedup-clears", messageId: "m-dc" } as Payload;
    db.message.findFirst.mockResolvedValueOnce({ id: "prev" });
    expect((await notifyGuardian(payload)).sent).toBe(false);
    // 🔒 표시가 남으면 DB 이력이 없어진 뒤(창 밖)에도 50초 동안 이 응급을 보내지 못한다
    expect((await notifyGuardian(payload)).sent).toBe(true);
  });

  it("앵커·notifiedAt은 운영자 경보를 기다리기 전에 — 경보 메일이 멈춰도 기록은 이미 있다(1시간 창)", async () => {
    vi.useFakeTimers();
    // 중복 확인 조회 실패 경보가 나간다 — 빠진 사본이 없어 앵커는 건다(10차부터 등록 휴대폰 조회 실패는 앵커를 막아 이 시험에 쓸 수 없다)
    db.message.findFirst.mockRejectedValue(new Error("connection reset"));
    opsAlertMock.mockImplementation(() => new Promise<boolean>(() => {}));   // 경보 메일이 끝내 답하지 않는다
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "alert-hangs", messageId: "m-ah" } as Payload;
    void notifyGuardian(payload);   // 경보에서 멈춘다 — 끝나지 않는다
    await vi.waitFor(() => expect(opsAlertMock).toHaveBeenCalledTimes(1));
    // 🔒 예전엔 조회 실패 경보를 먼저 기다려, 메일이 멈추면 notifiedAt도 앵커도 남지 않았다
    expect(db.message.update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(51 * 1000);   // 진행 중 표시(50초)는 지났다 — 막는 건 1시간 앵커다
    expect((await notifyGuardian(payload)).sent).toBe(false);
  });
});

/**
 * 위급 알림 경로의 DB 기다림 상한(2026-10-07 7차) — DB가 멈추면(커넥션 고갈·잠금) 예전엔 그 자리에서 끝없이 기다려 같은 응급의 이메일·
 *   앱 푸시·운영자 경보까지 멈췄다. 중복 확인 3초(넘기면 중복 아님 — fail-open) · 연락처·연결 조회 각 5초(넘기면 조회 실패 — 경보 +
 *   앵커 없음, 10차부터 받은 곳이 확인됐어도) · notifiedAt 기록 5초(로그만 — 운영자 경보는 이 기록을 기다리지 않는다).
 *   (8차) DB 밖의 기다림에도 상한 — 토픽 사본 10초 · 웹훅 DNS 3초 · 보호자 이메일 35초 · 운영자 경보 한 통 35초. 상한을 넘긴 발송은
 *   일시 실패라 앵커 없이(10차부터 받은 곳이 확인됐어도) 경보가 간다. 진행 중 표시(50초)는 앵커 전 가장 긴 길(3 + 5 + 35초)보다 길다.
 *   끝나지 않는 프라미스는 await하지 않는다 — 끝났는지를 단언으로 본다(시간 초과가 아니라 의도한 단언으로 실패하게).
 */
describe("기다림 상한 — DB(중복 확인 3초 · 연락처·연결 조회 5초 · notifiedAt 5초) · 토픽 10초 · 웹훅 DNS 3초 · 이메일·경보 35초", () => {
  const never = () => new Promise<never>(() => {});
  type Payload = Parameters<typeof import("@/lib/chat/emergency-notify").notifyGuardian>[0];
  type Result = Awaited<ReturnType<typeof import("@/lib/chat/emergency-notify").notifyGuardian>>;
  let warn: { mock: { calls: unknown[][] }; mockRestore: () => void };
  let err: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); err.mockRestore(); vi.useRealTimers(); });

  /** 끝났는지·결과를 지켜본다 */
  function track(p: Promise<Result>) {
    const s: { done: boolean; value?: Result } = { done: false };
    void p.then((v) => { s.done = true; s.value = v; });
    return s;
  }

  /**
   * (8차) 중복 확인 조회 실패도 운영자 경보를 낸다 — 받은 곳(이메일)이 확인돼도. 예전엔 경고 로그뿐이라 DB 장애 동안 중복 방지가 메모리
   *   상한(인스턴스마다 따로)에만 기대고 있다는 걸 몰랐다. 앵커는 그대로다 — 발송은 이미 나갔고 다시 보내도 결과가 같다(retryMayHelp 주석).
   */
  it("중복 확인이 끝내 답하지 않으면 3초에 '중복 아님'으로 보고 보낸다 — 이메일이 닿아 앵커(1시간), 중복 확인 조회 실패 경보 한 통(8차)", async () => {
    db.message.findFirst.mockImplementation(never);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "dedup-hang", messageId: "m-dedup-hang" } as Payload;
    const run = track(notifyGuardian(payload));
    await vi.advanceTimersByTimeAsync(2999);
    // 상한 안에서는 기다린다 — 이미 나간 응급인지 모르는 채로 서두르지 않는다
    expect(emailMock).not.toHaveBeenCalled();
    expect(run.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // 🔒 상한이 없으면 DB 하나가 멈춘 순간 그 응급의 모든 채널이 끝없이 기다린다
    expect(run.done).toBe(true);
    expect(run.value).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
    // 🔒 받은 곳(이메일)이 확인돼도 늘 — 예전엔 로그 한 줄뿐이었다. 제목에 레벨·분류·userId, 본문엔 이름·주소 없음
    expect(opsCalls().map(([s]) => s)).toEqual(["L3 중복 확인 조회 실패(DB) medical_acute dedup-hang"]);
    const text = opsCalls()[0][1].join("\n");
    expect(text).toContain("DB에서 확인하지 못해(오류 또는 3초 안에 답 없음) 중복 위험을 감수하고 보냈습니다");
    expect(text).toContain("보낸 경로: fcm-topic, email");
    expect(text).not.toMatch(/김응급|g@example\.com/);
    // 🔒 앵커는 그대로 — 중복 확인 실패는 다시 보내도 전달이 달라지지 않는다(앵커를 막으면 60초마다 한 번 더 갈 뿐)
    expect(db.message.update).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("dedup 조회 실패") && String(c[1]).includes("3초 안에 응답 없음"))).toBe(true);
    vi.advanceTimersByTime(61 * 1000);
    expect(await notifyGuardian(payload)).toMatchObject({ sent: false, reason: expect.stringContaining("메모리 상한") });
  });

  it("연락처 조회가 끝내 답하지 않으면 5초에 조회 실패 — 앱 알림은 그때 나가고 연락처 조회 실패 경보, 토픽뿐이라 앵커 없음(61초 뒤 다시)", async () => {
    db.user.findUnique.mockImplementation(never);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "contact-hang", messageId: "m-contact-hang" } as Payload;
    const run = track(notifyGuardian(payload));
    await vi.advanceTimersByTimeAsync(4999);
    expect(run.done).toBe(false);
    expect(pushMock).not.toHaveBeenCalled();   // 알림 문구의 이름(연락처 행)을 기다리는 중 — 상한 안
    await vi.advanceTimersByTimeAsync(1);
    // 🔒 상한이 없으면 연락처 조회 하나가 멈춘 순간 앱 알림·경보까지 끝없이 멈춘다
    expect(run.done).toBe(true);
    expect(run.value).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(emailMock).not.toHaveBeenCalled();
    const alert = opsCalls().find(([s]) => s === "L3 보호자 연락처 조회 실패(DB) medical_acute contact-hang");
    expect(alert).toBeDefined();
    expect(alert![1].join("\n")).toContain("DB에서 읽지 못해(오류 또는 5초 안에 답 없음)");
    // 🔒 받은 곳 미확인 + 조회 실패 → 앵커 없음(60초 바닥) — DB가 돌아오면 이메일까지 간다
    expect(db.message.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(61 * 1000);
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: null });
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
  });

  it("연결 조회가 끝내 답하지 않아도 이메일은 곧바로 — 5초에 연결 조회 실패 경보, 이메일이 닿아도 앵커 없음(10차)", async () => {
    db.expertPatient.findMany.mockImplementation(never);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "link-hang", messageId: "m-link-hang" } as Payload;
    const run = track(notifyGuardian(payload));
    await vi.advanceTimersByTimeAsync(100);
    // 🔒 이메일은 연결 조회를 기다리지 않는다(함께 출발 — 3차)
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(run.done).toBe(false);
    await vi.advanceTimersByTimeAsync(4900);
    // 🔒 상한이 없으면 이메일은 나갔는데 경보·앵커가 끝없이 남지 않는다
    expect(run.done).toBe(true);
    expect(run.value).toEqual({ sent: true, channels: ["email"] });
    expect(pushMock).not.toHaveBeenCalled();
    expect(opsCalls().map(([s]) => s)).toEqual(["L3 보호자 연결 조회 실패(DB) medical_acute link-hang"]);
    expect(opsCalls()[0][1].join("\n")).toContain("DB에서 읽지 못해(오류 또는 5초 안에 답 없음)");
    // 🔒 앱 알림이 통째로 빠졌다 — 이메일이 닿았다고 앵커를 걸면 그 응급은 앱으로 끝내 가지 않는다
    expect(db.message.update).not.toHaveBeenCalled();
  });

  it("notifiedAt 기록이 끝내 답하지 않아도 운영자 경보는 기다리지 않는다 — 기록은 5초 상한(로그만), 메모리 앵커는 이미 1시간", async () => {
    db.message.update.mockImplementation(never);
    // 중복 확인 조회 실패 경보 — 빠진 사본이 없어 앵커는 건다(notifiedAt 기록). 10차부터 등록 휴대폰 조회 실패는 앵커를 막는다
    db.message.findFirst.mockRejectedValue(new Error("connection reset"));
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "mark-hang", messageId: "m-mark-hang" } as Payload;
    const run = track(notifyGuardian(payload));
    await vi.advanceTimersByTimeAsync(100);
    expect(db.message.update).toHaveBeenCalledTimes(1);   // 기록은 시작했다
    // 🔒 예전엔 이 쓰기를 기다린 뒤에 경보를 보내, DB가 멈추면 그 응급의 경보까지 멈췄다
    expect(opsCalls().map(([s]) => s)).toEqual(["L3 중복 확인 조회 실패(DB) medical_acute mark-hang"]);
    expect(run.done).toBe(false);
    await vi.advanceTimersByTimeAsync(4900);
    // 🔒 상한이 없으면 after() 안의 알림 작업이 끝나지 않는다
    expect(run.done).toBe(true);
    expect(run.value).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
    expect(err.mock.calls.some((c) => String(c[0]).includes("notifiedAt 마킹 실패") && String(c[1]).includes("5초 안에 응답 없음"))).toBe(true);
    vi.advanceTimersByTime(61 * 1000);
    // 메모리 앵커(1시간)는 DB 기록과 별개로 남았다
    expect((await notifyGuardian(payload)).sent).toBe(false);
  });

  it("중복 확인 조회가 실패해도 앵커 규칙은 그대로 — 토픽뿐(받은 곳 미확인)이어도 1시간 창·notifiedAt, 경보는 간다(8차)", async () => {
    db.message.findFirst.mockRejectedValue(new Error("connection reset"));
    db.user.findUnique.mockResolvedValue(noContact);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "dedup-fail-topic", messageId: "m-dft" } as Payload;
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(opsCalls().map(([s]) => s)).toEqual(["L3 중복 확인 조회 실패(DB) medical_acute dedup-fail-topic"]);
    // 🔒 빠진 사본이 없다(발송은 이미 모든 경로로 나갔다) — 다시 보낼 이유로 세면 같은 토픽 사본이 60초마다 한 번 더 간다
    expect(db.message.update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61 * 1000);
    expect(await notifyGuardian(payload)).toMatchObject({ sent: false, reason: expect.stringContaining("메모리 상한") });
  });

  it("보낸 곳이 없어도 중복 확인 조회 실패 경보는 '응급 알림 실패'와 따로, 먼저 — 그 경보 메일이 실패해도 결과는 그대로(8차)", async () => {
    db.message.findFirst.mockRejectedValue(new Error("connection reset"));
    db.user.findUnique.mockResolvedValue(noContact);
    pushMock.mockResolvedValue({ sent: 0, failed: 1, failures: [fcmFail("g1", "messaging/internal-error")] });
    opsAlertMock.mockRejectedValueOnce(new Error("smtp down"));   // 중복 확인 조회 실패 경보부터 실패
    const r = await notify({ userId: "dedup-fail-all", messageId: undefined });
    expect(r.sent).toBe(false);
    // 🔒 전 채널 실패 경보 속에 "중복 확인도 못 했다"는 사실이 묻히지 않게 — 시도는 했다
    expect(opsCalls().map(([s]) => s)).toEqual([
      "L3 중복 확인 조회 실패(DB) medical_acute dedup-fail-all", "응급 알림 실패 L3 medical_acute dedup-fail-all",
    ]);
    expect(opsCalls()[0][1]).toContain("보낸 경로: 없음");
    expect(opsCalls()[0][1]).toContain("메시지 기록: 없음(저장 실패 또는 안전망 경로)");
  });

  it("토픽 발송이 끝내 답하지 않으면 10초에 그 사본만 일시 실패('timeout') — 등록 휴대폰은 기다리지 않고, 받은 곳이 없으면 앵커 없이 경보(8차)", async () => {
    db.user.findUnique.mockResolvedValue(noContact);
    devicesMock.mockResolvedValue([device("g1", TOK_MUTED, { permission: "denied" })]);
    pushMock.mockImplementation(never);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "topic-hang", messageId: "m-topic-hang" } as Payload;
    const run = track(notifyGuardian(payload));
    await vi.advanceTimersByTimeAsync(9999);
    expect(tokenPushMock).toHaveBeenCalledTimes(1);   // 등록 휴대폰 사본은 토픽을 기다리지 않고 나갔다
    expect(run.done).toBe(false);   // 상한 안에서는 기다린다
    await vi.advanceTimersByTimeAsync(1);
    // 🔒 상한이 없으면 FCM이 멈춘 순간 응급 알림 전체(경보·dedup 기록)가 끝없이 기다린다
    expect(run.done).toBe(true);
    expect(run.value).toEqual({ sent: true, channels: ["fcm-muted"] });
    // 🔒 시간 초과는 일시 실패 — 받은 곳이 확인되지 않았으니 앵커 없이(60초 바닥) 경보
    expect(db.message.update).not.toHaveBeenCalled();
    const alert = opsCalls().find(([s]) => s === "L3 위급 알림 발송 실패 medical_acute topic-hang");
    expect(alert?.[1]).toContain("실패한 경로: fcm-topic(1/1 timeout)");
    expect(err.mock.calls.some((c) => String(c[0]).includes("토픽 발송이 10초 안에 끝나지 않음"))).toBe(true);
    vi.advanceTimersByTime(61 * 1000);
    pushMock.mockResolvedValue({ sent: 1, failed: 0, failures: [] });   // FCM이 돌아왔다
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-muted", "fcm-topic"] });
  });

  it("웹훅 주소의 DNS 조회가 끝내 답하지 않으면 3초에 '주소 확인 못 함'(일시 실패) — 보내지 않고, 받은 곳이 없으면 앵커 없이 경보(8차)", async () => {
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: "https://hook.example.com/x", guardianEmail: null, guardianName: null });
    dnsLookup.mockImplementation(never);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
      const payload = { ...P, userId: "dns-hang", messageId: "m-dns-hang" } as Payload;
      const run = track(notifyGuardian(payload));
      await vi.advanceTimersByTimeAsync(2999);
      expect(pushMock).toHaveBeenCalledTimes(1);   // 앱 알림은 메신저를 기다리지 않는다
      expect(run.done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      // 🔒 상한이 없으면 리졸버 하나가 멈춘 순간 응급 알림 전체가 끝없이 기다린다
      expect(run.done).toBe(true);
      expect(run.value).toEqual({ sent: true, channels: ["fcm-topic"] });
      expect(fetchSpy).not.toHaveBeenCalled();   // SSRF 가드는 fail-closed — 확인 못 한 주소로는 보내지 않는다
      expect(db.message.update).not.toHaveBeenCalled();
      expect(opsCalls().find(([s]) => s === "L3 위급 알림 발송 실패 medical_acute dns-hang")?.[1]).toContain("실패한 경로: webhook");
      expect(warn.mock.calls.some((c) => String(c[0]).includes("주소(DNS)를 확인하지 못해"))).toBe(true);
    } finally { vi.unstubAllGlobals(); }
  });

  it("보호자 이메일이 끝내 답하지 않으면 35초에 일시 실패 — 앱 알림은 기다리지 않고, 받은 곳이 없으면 앵커 없이 경보(SMTP 앞의 DNS까지, 8차)", async () => {
    emailMock.mockImplementation(never);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "email-hang", messageId: "m-email-hang" } as Payload;
    const run = track(notifyGuardian(payload));
    await vi.advanceTimersByTimeAsync(34_999);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(run.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // 🔒 nodemailer의 연결 시계는 DNS 조회 뒤에야 돈다 — 상한이 없으면 리졸버가 멈춘 동안 응급 알림 전체가 몇 분씩 기다린다
    expect(run.done).toBe(true);
    expect(run.value).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(db.message.update).not.toHaveBeenCalled();
    expect(opsCalls().find(([s]) => s === "L3 위급 알림 발송 실패 medical_acute email-hang")?.[1]).toContain("실패한 경로: email");
    expect(err.mock.calls.some((c) => String(c[0]).includes("email 발송 중 예외") && String(c[1]).includes("35초 안에 응답 없음"))).toBe(true);
  });

  it("운영자 경보 메일이 끝내 답하지 않아도 35초에 그 경보를 실패로 치고 끝낸다 — 앵커·기록은 이미 남았다(8차)", async () => {
    // 중복 확인 조회 실패 경보 하나 — 빠진 사본이 없어 앵커는 건다(10차부터 등록 휴대폰 조회 실패는 앵커를 막는다)
    db.message.findFirst.mockRejectedValue(new Error("connection reset"));
    opsAlertMock.mockImplementation(never);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "ops-hang", messageId: "m-ops-hang" } as Payload;
    const run = track(notifyGuardian(payload));
    await vi.advanceTimersByTimeAsync(100);
    expect(opsAlertMock).toHaveBeenCalledTimes(1);
    expect(db.message.update).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(34_800);
    expect(run.done).toBe(false);   // 상한 안에서는 기다린다
    await vi.advanceTimersByTimeAsync(200);
    // 🔒 상한이 없으면 경보 메일 하나가 응급 알림 작업(after())을 끝없이 붙잡는다
    expect(run.done).toBe(true);
    expect(run.value).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
  });

  it("진행 중 표시는 앵커 전 가장 긴 길(중복 확인 3초 + 연락처 조회 5초 + 이메일 35초)보다 길다 — 그 끝에 다시 들어와도 막는다(8차)", async () => {
    db.message.findFirst.mockImplementation(never);   // 3초 상한까지 기다린다
    db.user.findUnique.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ name: null, guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: null }), 4900);   // 5초 상한 직전에 답한다
    }));
    emailMock.mockImplementation(never);   // 35초 상한까지 기다린다
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "longest-path", messageId: "m-longest" } as Payload;
    const first = track(notifyGuardian(payload));
    await vi.advanceTimersByTimeAsync(42_800);
    expect(first.done).toBe(false);   // 아직 이메일 상한을 기다리는 중(앵커 전)
    // 🔒 진행 중 표시가 이보다 짧으면 이 두 번째 호출이 토픽·이메일을 한 번 더 보낸다
    expect(await notifyGuardian(payload)).toMatchObject({ sent: false, reason: expect.stringContaining("메모리 상한") });
    expect(emailMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(first.done).toBe(true);
  });
});

/**
 * 중복 확인 조회 실패 경보의 본문 — 실제로 한 일과 앵커 결과를 한 줄씩(2026-10-08 12차). 예전엔 보낸 곳이 없어도 "보냈습니다 — 이미 보낸
 *   응급이었다면 보호자는 한 번 더 받았습니다"였고, 앵커를 걸었는지는 적지 않았다. 앵커 값은 notifyGuardian이 정한 그대로다(보낸 곳이
 *   있으면 anchor, 없으면 onlyPermanent) — 함께 가는 "응급 알림 실패"·"위급 알림 발송 실패"와 엇갈리지 않게. 발송·앵커 동작은 그대로다
 *   (notifiedAt 호출 수로 함께 본다).
 */
describe("중복 확인 조회 실패 경보 — 한 일과 앵커 결과(12차)", () => {
  const HEAD = "같은 응급을 이미 보냈는지 DB에서 확인하지 못해(오류 또는 3초 안에 답 없음) 중복 위험을 감수하고";
  // 받았다고 단정하지 않는다 — 토픽 사본·알림 꺼진 휴대폰은 누가 받았는지 모른다
  const SENT = `${HEAD} 보냈습니다 — 이미 보낸 응급이었다면 같은 알림이 한 번 더 나갔을 수 있습니다.`;
  const ALL_FAILED = `${HEAD} 보내려 했지만 모든 경로가 실패했습니다(따로 보낸 '응급 알림 실패' 참고).`;
  const NO_TARGETS = `${HEAD} 보내려 했지만 보낼 곳이 없었습니다(따로 보낸 '응급 알림 대상 없음' 참고).`;
  const ANCHORED = "중복 방지 기록은 남겼습니다 — 같은 응급을 1시간 동안 다시 보내지 않습니다.";
  const ALL_PERMANENT = "실패가 모두 영구 실패라(다시 보내도 같다) 같은 응급을 1시간 동안 다시 보내지 않습니다.";
  const NOT_ANCHORED = "중복 방지 기록을 남기지 않았습니다 — 같은 응급이 다음 대화 턴(60초 뒤부터)에 다시 감지되면 다시 보냅니다.";
  const dedupSubject = (uid: string) => `L3 중복 확인 조회 실패(DB) medical_acute ${uid}`;
  /** 그 응급의 중복 확인 조회 실패 경보 중 결과 줄 — 빈 줄 다음부터 "DB 장애가 이어지는 동안" 앞까지 */
  const outcomeLines = (uid: string): string[] => {
    const alert = opsCalls().find(([s]) => s === dedupSubject(uid));
    expect(alert, `중복 확인 조회 실패 경보(${uid})`).toBeDefined();
    const lines = alert![1];
    return lines.slice(lines.indexOf("") + 1, lines.findIndex((l) => l.startsWith("DB 장애가 이어지는 동안")));
  };
  let warn: { mockRestore: () => void };
  let err: { mockRestore: () => void };
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
    db.message.findFirst.mockRejectedValue(new Error("connection reset"));
  });
  afterEach(() => { warn.mockRestore(); err.mockRestore(); vi.unstubAllGlobals(); });

  it.each([
    ["보낸 곳 있음 · 빠진 사본 없음(토픽·이메일) → 1시간 창", "dedup-out-anchored", () => {}, [SENT, ANCHORED], [], 1],
    ["보낸 곳 있음 · 이메일 일시 실패(토픽뿐) → 60초 바닥", "dedup-out-transient", () => {
      emailMock.mockResolvedValue("transient");
    }, [SENT, NOT_ANCHORED], ["L3 위급 알림 발송 실패 medical_acute dedup-out-transient"], 0],
    ["보낸 곳 없음 · 토픽 일시 실패 → 모든 경로 실패 + 60초 바닥", "dedup-out-allfail", () => {
      db.user.findUnique.mockResolvedValue(noContact);
      pushMock.mockResolvedValue({ sent: 0, failed: 1, failures: [fcmFail("g1", "messaging/internal-error")] });
    }, [ALL_FAILED, NOT_ANCHORED], ["응급 알림 실패 L3 medical_acute dedup-out-allfail"], 0],
    ["보낸 곳 없음 · 영구 실패뿐(웹훅 404) → 모든 경로 실패 + 1시간 창", "dedup-out-allperm", () => {
      db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: "https://hook.example.com/x", guardianEmail: null, guardianName: null });
      db.expertPatient.findMany.mockResolvedValue([]);
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    }, [ALL_FAILED, ALL_PERMANENT], ["응급 알림 실패 L3 medical_acute dedup-out-allperm"], 0],
    ["보낼 곳 없음(보호자 미연결·연락처 미등록) → '응급 알림 대상 없음' 참고, 앵커 줄 없음", "dedup-out-notargets", () => {
      db.user.findUnique.mockResolvedValue(noContact);
      db.expertPatient.findMany.mockResolvedValue([]);
    }, [NO_TARGETS], ["응급 알림 대상 없음 L3 medical_acute dedup-out-notargets"], 0],
  ] as const)("%s", async (_, uid, arrange, expected, others, marked) => {
    arrange();
    await notify({ userId: uid });
    // 경보 순서 — 중복 확인 조회 실패가 먼저, 따로(8차). 그 뒤 이 응급의 다른 경보
    expect(opsCalls().map(([s]) => s)).toEqual([dedupSubject(uid), ...others]);
    // 🔒 보낸 곳이 없는데 "보냈습니다 — 한 번 더 받았습니다"라고 적거나 앵커 결과를 빼면, 운영자는 이 경보만 보고 그 응급이 갔다고 믿는다
    expect(outcomeLines(uid)).toEqual([...expected]);
    // 경보가 적은 대로다 — 발송·앵커 동작은 그대로(notifiedAt은 받은 곳 쪽 앵커를 걸었을 때만)
    expect(db.message.update).toHaveBeenCalledTimes(marked);
  });
});

/**
 * 운영자 경보의 "다시 보냅니다"는 늘 조건부다(2026-10-08 12차) — 재시도 큐는 없다: notifyGuardian은 같은 응급이 다시 감지될 때만 다시
 *   보낸다. 조건 없이 "다음 대화 턴에 다시" 보낸다고 적으면 운영자는 그 응급이 저절로 다시 간다고 믿고 보호자 확인을 미룬다.
 *   문구 모듈(경보)과 진입점("응급 알림 실패")의 "다시 보냅니다"가 모두 "다시 감지되면" 바로 뒤에만 오는지 본다.
 */
describe("운영자 경보의 '다시 보냅니다'는 늘 '같은 응급이 다시 감지되면'(12차)", () => {
  it("경보 문구 모듈·진입점의 '다시 보냅니다'는 모두 '다시 감지되면' 바로 뒤에 온다", () => {
    const found: string[] = [];
    for (const f of ["lib/chat/emergency-notify-alerts.ts", "lib/chat/emergency-notify.ts"]) {
      const src = readFileSync(f, "utf-8");
      for (const m of src.matchAll(/다시 보냅니다/g)) found.push(`${f}: …${src.slice(Math.max(0, m.index - 30), m.index)}다시 보냅니다`);
    }
    // 공허하지 않게 — 적어도 공용 문구(RESEND_IF_DETECTED_AGAIN)·일시 실패·영구 실패 경보의 세 곳은 있다
    expect(found.length).toBeGreaterThanOrEqual(3);
    for (const at of found) expect(at, at).toMatch(/다시 감지되면 (모든 경로로 )?다시 보냅니다$/);
  });
});
