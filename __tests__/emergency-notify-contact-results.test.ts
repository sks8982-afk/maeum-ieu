/**
 * 위급 알림 — 연락처 채널 결과(메신저·이메일의 일시 실패·영구 실패·보낼 곳 없음), 받은 곳이 확인돼도 가는 영구 실패 경보,
 *   전 채널이 영구 실패뿐일 때의 1시간 창.
 *   2026-10-07 8차에 __tests__/emergency-notify.test.ts에서 **그대로 옮겼다**(파일 나눔 — 그 파일 머리 주석).
 *   공용 목·도우미는 __tests__/helpers/emergency-notify-harness.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  db, fcmFail, pushMock, emailMock, tokenPushMock, devicesMock, deleteTokensMock, opsAlertMock, emailConfiguredMock, defaultLookup,
  dnsLookup, P, notify, TOK_READY, device, opsCalls, INVALID_GRANT,
} from "./helpers/emergency-notify-harness";

/**
 * 연락처 채널 결과 분류(2026-10-07 5·6차) — "failed"(일시: 다시 보내면 될 수 있다)만 dedup 앵커를 막고, "failed-permanent"(영구: 다시
 *   보내도 같다 — 웹훅 4xx(408·429 제외)·리다이렉트·없는 도메인(DNS ENOTFOUND), 저장된 이메일 주소 형식 오류, SMTP 인증 거절·5xx)와
 *   막힌 웹훅 주소(SSRF 방어 — 6차부터 영구 실패, "차단된 주소")는 경보에만 싣는다. "none"(보낼 곳 없음 — 보내는 Gmail 자격증명
 *   미설정)은 실패가 아니다. 웹훅 DNS 일시 실패(EAI_AGAIN·빈 응답)는 보내지 않되 일시 실패다(fail-closed).
 */
describe("연락처 채널 결과 — 일시 실패·영구 실패·보낼 곳 없음", () => {
  const hookOnly = (url: string) => ({ name: null, guardianWebhookUrl: url, guardianEmail: null, guardianName: null });
  const sendFailAlert = (uid: string) => opsCalls().find(([s]) => s === `L3 위급 알림 발송 실패 medical_acute ${uid}`);
  /** 그 응급의 "위급 알림 발송 실패" 경보 본문 — 경보가 없으면 **단언으로** 실패한다(구조 분해 TypeError로 실패 까닭이 흐려지지 않게, 6차) */
  const sendFailLines = (uid: string): string[] => {
    const alert = sendFailAlert(uid);
    expect(alert, `위급 알림 발송 실패 경보(${uid})`).toBeDefined();
    return alert![1];
  };
  let warn: { mock: { calls: unknown[][] }; mockRestore: () => void };
  let err: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); err.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([
    [400, "webhook(영구 실패)", true], [401, "webhook(영구 실패)", true], [404, "webhook(영구 실패)", true], [410, "webhook(영구 실패)", true],
    [302, "webhook(영구 실패)", true],   // 리다이렉트는 따라가지 않는다(SSRF) — 다시 보내도 같은 곳으로 돌려보낸다
    [408, "webhook", false], [429, "webhook", false], [500, "webhook", false], [503, "webhook", false],
  ])("웹훅 응답 %i + 토픽뿐 → 실패한 경로 %j, 앵커 %s", async (status, label, anchored) => {
    db.user.findUnique.mockResolvedValue(hookOnly("https://hook.example.com/x"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
    const uid = `hook-status-${status}`;
    expect(await notify({ userId: uid })).toEqual({ sent: true, channels: ["fcm-topic"] });
    // 🔒 4xx를 일시 실패로 세면 다시 보내도 같은 결과인데 60초마다 재발송·경보만 쌓이고, 408·429·5xx를 영구로 세면 1시간 동안 다시 안 간다
    expect(db.message.update).toHaveBeenCalledTimes(anchored ? 1 : 0);
    const [, lines] = sendFailAlert(uid)!;
    expect(lines).toContain(`실패한 경로: ${label}`);
    expect(lines.some((l) => l.startsWith("'영구 실패'는"))).toBe(anchored);
  });

  it.each([
    ["네트워크 오류", () => Promise.reject(new TypeError("fetch failed"))],
    ["8초 시간 초과", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
  ])("웹훅 %s → 일시 실패(webhook) — 앵커 없음", async (_, respond) => {
    db.user.findUnique.mockResolvedValue(hookOnly("https://hook.example.com/x"));
    vi.stubGlobal("fetch", vi.fn(respond));
    expect(await notify({ userId: `hook-net-${_}` })).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(db.message.update).not.toHaveBeenCalled();
    expect(sendFailAlert(`hook-net-${_}`)![1]).toContain("실패한 경로: webhook");
  });

  /**
   * 웹훅 전송이 throw하면 로그엔 오류 이름과 원인 코드만(2026-10-07 8차) — 웹훅 주소 자체가 비밀이고(Discord·Slack은 경로에 토큰을
   *   싣는다), fetch(undici) 오류의 메시지·원인 메시지에는 호스트·주소가 섞인다. 예전엔 e.message를 그대로 찍었다.
   */
  it("웹훅 전송이 throw하면 로그엔 오류 이름·원인 코드만 — 메시지·주소(경로의 토큰)는 싣지 않는다(8차)", async () => {
    const url = "https://hook.example.com/api/webhooks/123/SECRET-TOKEN";
    db.user.findUnique.mockResolvedValue(hookOnly(url));
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND hook.example.com"), { code: "ENOTFOUND" });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError(`fetch failed for ${url}`, { cause }))));
    expect(await notify({ userId: "hook-throw-log" })).toEqual({ sent: true, channels: ["fcm-topic"] });
    const logged = warn.mock.calls.find((c) => String(c[0]).includes("webhook failed"));
    expect(logged?.[1]).toEqual({ error: "TypeError", cause: "ENOTFOUND", result: "failed" });
    // 🔒 서버 로그(호스팅 로그 보관·전달)에 웹훅 토큰·호스트가 남으면 안 된다
    expect(JSON.stringify([...warn.mock.calls, ...err.mock.calls])).not.toMatch(/SECRET-TOKEN|hook\.example\.com|fetch failed/);
  });

  it("웹훅 주소의 DNS 조회가 EAI_AGAIN으로 실패하면 보내지 않고 일시 실패 — 토픽이 받아들여져도 앵커 없음, 경보에 webhook → DNS가 돌아오면 다음 턴에 간다", async () => {
    vi.useFakeTimers();
    db.user.findUnique.mockResolvedValue(hookOnly("https://hook.example.com/x"));
    dnsLookup.mockRejectedValue(Object.assign(new Error("getaddrinfo EAI_AGAIN hook.example.com"), { code: "EAI_AGAIN" }));
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "hook-dns-again", messageId: "m-dns" } as Parameters<typeof notifyGuardian>[0];
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["fcm-topic"] });
    // 🔒 SSRF 가드는 fail-closed — 확인 못 한 주소로는 보내지 않는다
    expect(fetchSpy).not.toHaveBeenCalled();
    // 🔒 예전엔 "막힌 주소"와 같이 다뤄 메신저 사본이 조용히 빠지고 1시간 dedup까지 걸렸다
    expect(db.message.update).not.toHaveBeenCalled();
    expect(sendFailAlert("hook-dns-again")![1]).toContain("실패한 경로: webhook");
    expect(warn.mock.calls.some((c) => String(c[0]).includes("주소(DNS)를 확인하지 못해"))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("안전하지 않은 웹훅 URL 차단"))).toBe(false);
    vi.advanceTimersByTime(61 * 1000);
    dnsLookup.mockImplementation(defaultLookup);   // DNS가 돌아왔다
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: ["webhook", "fcm-topic"] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(db.message.update).toHaveBeenCalledTimes(1);
  });

  it("DNS가 빈 응답을 주면(주소 없음) 같은 일시 실패 — 보내지 않는다", async () => {
    db.user.findUnique.mockResolvedValue(hookOnly("https://hook.example.com/x"));
    dnsLookup.mockResolvedValue([]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await notify({ userId: "hook-dns-empty" })).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.message.update).not.toHaveBeenCalled();
    expect(sendFailAlert("hook-dns-empty")![1]).toContain("실패한 경로: webhook");
  });

  it.each([
    ["EAI_AGAIN(시간 초과·SERVFAIL)", "EAI_AGAIN"], ["c-ares SERVFAIL", "ESERVFAIL"], ["c-ares 시간 초과", "ETIMEOUT"], ["코드 없음", undefined],
  ])("웹훅 주소의 DNS 조회가 %s로 실패하면 일시 실패(webhook) — 앵커 없음", async (name, code) => {
    db.user.findUnique.mockResolvedValue(hookOnly("https://hook.example.com/x"));
    dnsLookup.mockRejectedValue(Object.assign(new Error(`getaddrinfo ${code ?? "?"} hook.example.com`), code ? { code } : {}));
    vi.stubGlobal("fetch", vi.fn());
    const uid = `hook-dns-${name}`;
    expect(await notify({ userId: uid })).toEqual({ sent: true, channels: ["fcm-topic"] });
    // 🔒 잠시 뒤면 풀릴 DNS 장애를 영구로 세면 1시간 동안 메신저 사본이 다시 안 간다
    expect(db.message.update).not.toHaveBeenCalled();
    expect(sendFailLines(uid)).toContain("실패한 경로: webhook");
  });

  it("웹훅 주소의 도메인이 없으면(DNS ENOTFOUND — NXDOMAIN) 영구 실패 — 보내지 않고, 앵커는 걸고, 경보(webhook(영구 실패))", async () => {
    db.user.findUnique.mockResolvedValue(hookOnly("https://no-such-host.example/x"));
    dnsLookup.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND no-such-host.example"), { code: "ENOTFOUND" }));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await notify({ userId: "hook-nxdomain" })).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(fetchSpy).not.toHaveBeenCalled();
    // 🔒 없는 도메인은 60초 뒤에도 없다 — 앵커를 막으면 매 턴 재발송·경보만 쌓인다(고칠 사람은 운영자·보호자다)
    expect(db.message.update).toHaveBeenCalledTimes(1);
    const lines = sendFailLines("hook-nxdomain");
    expect(lines).toContain("실패한 경로: webhook(영구 실패)");
    expect(lines.some((l) => l.startsWith("'영구 실패'는"))).toBe(true);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("도메인이 없다(DNS ENOTFOUND)"))).toBe(true);
  });

  it.each([
    ["http(평문)", "http://hook.example.com/x"], ["내부 호스트명", "https://svc.internal/x"], ["URL 형식 오류", "not a url"], ["사설 주소", "https://private.example/x"],
    // 8차 — 주소에 아이디·비밀번호(fetch가 Authorization으로 바꿔 보낸다 — 비밀이 주소와 함께 다닌다)
    ["아이디·비밀번호", "https://user:pass@hook.example.com/x"], ["아이디만", "https://user@hook.example.com/x"], ["비밀번호만", "https://:pass@hook.example.com/x"],
  ])("안전하지 않은 웹훅 주소(%s)는 영구 실패(차단된 주소) — 보내지 않고, 앵커는 걸고, 경보", async (_, url) => {
    db.user.findUnique.mockResolvedValue(hookOnly(url));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const uid = `hook-unsafe-${_}`;
    expect(await notify({ userId: uid })).toEqual({ sent: true, channels: ["fcm-topic"] });
    // 🔒 SSRF 방어 — 막은 주소로는 보내지 않는다
    expect(fetchSpy).not.toHaveBeenCalled();
    // 🔒 다시 보내도 막힌다 — 앵커를 막으면 60초마다 재발송·경보만 쌓인다
    expect(db.message.update).toHaveBeenCalledTimes(1);
    // 🔒 6차: 예전엔 "보낼 곳 없음"이라 경보가 없었다 — 보호자가 등록한 메신저 사본이 영영 빠지는데 아무도 몰랐다
    const lines = sendFailLines(uid);
    expect(lines).toContain("실패한 경로: webhook(영구 실패 — 차단된 주소)");
    expect(lines.join("\n")).toContain("실패가 모두 영구 실패라(다시 보내도 같다) 중복 방지 기록은 남겼습니다");
    expect(lines.some((l) => l.startsWith("'영구 실패'는"))).toBe(true);
  });

  it("보내는 Gmail 자격증명이 없으면 이메일은 '보낼 곳 없음' — 보내지 않고, 발송 실패도 아니다(앵커, 경보 없음)", async () => {
    emailConfiguredMock.mockReturnValue(false);
    expect(await notify({ userId: "smtp-unset" })).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(emailMock).not.toHaveBeenCalled();
    // 🔒 설정 문제를 일시 실패로 세면 모든 응급이 60초마다 다시 나가고 경보가 쌓인다(로그는 이메일 모듈이 인스턴스당 한 번)
    expect(db.message.update).toHaveBeenCalledTimes(1);
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it("저장된 이메일 주소가 형식 검사에 걸리면 영구 실패 — 보내지 않고 경보(email(영구 실패)), 앵커는 건다", async () => {
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: null, guardianEmail: "not-an-email", guardianName: null });
    expect(await notify({ userId: "email-invalid" })).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(emailMock).not.toHaveBeenCalled();
    expect(db.message.update).toHaveBeenCalledTimes(1);
    const [, lines] = sendFailAlert("email-invalid")!;
    expect(lines).toContain("실패한 경로: email(영구 실패)");
    expect(lines.join("\n")).not.toContain("not-an-email");   // 주소는 싣지 않는다
    expect(err.mock.calls.some((c) => String(c[0]).includes("주소 형식 오류"))).toBe(true);
  });

  /**
   * SMTP 실패의 분류(2026-10-07 6차 — lib/notify/email EmailSendResult): 인증 거절(EAUTH)·5xx는 영구("failed-permanent" — 앵커는 걸고
   *   경보에 email(영구 실패)), 연결·시간 초과·4xx·모르는 오류는 일시("failed" — 앵커 없음, 10차부터 받은 곳이 확인됐어도).
   */
  it.each([
    ["permanent", "email(영구 실패)", true],
    ["transient", "email", false],
  ] as const)("SMTP 결과 %s + 토픽뿐 → 실패한 경로 %j, 앵커 %s", async (result, label, anchored) => {
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: null });
    emailMock.mockResolvedValue(result);
    const uid = `smtp-${result}`;
    expect(await notify({ userId: uid })).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(emailMock).toHaveBeenCalledTimes(1);
    // 🔒 앱 비밀번호 거절(영구)을 일시로 세면 고칠 때까지 모든 응급이 60초마다 다시 나간다 / 일시를 영구로 세면 1시간 동안 다시 안 간다
    expect(db.message.update).toHaveBeenCalledTimes(anchored ? 1 : 0);
    const lines = sendFailLines(uid);
    expect(lines).toContain(`실패한 경로: ${label}`);
  });

  it("영구·일시 실패가 섞이면 앵커 없음(일시 실패가 있다) — 경보에 둘 다", async () => {
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: "https://hook.example.com/x", guardianEmail: "g@example.com", guardianName: null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    emailMock.mockResolvedValue("transient");
    expect(await notify({ userId: "mixed-fail" })).toEqual({ sent: true, channels: ["fcm-topic"] });
    expect(db.message.update).not.toHaveBeenCalled();
    const [, lines] = sendFailAlert("mixed-fail")!;
    expect(lines).toContain("실패한 경로: webhook(영구 실패), email");
    expect(lines.join("\n")).toContain("중복 방지 기록을 남기지 않았습니다");
  });

  it("보낸 곳이 없고 영구 실패뿐이어도 '응급 알림 실패' 경보에 싣는다(설명 줄 포함)", async () => {
    db.user.findUnique.mockResolvedValue(hookOnly("https://hook.example.com/x"));
    db.expertPatient.findMany.mockResolvedValue([]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    expect((await notify({ userId: "perm-only" })).sent).toBe(false);
    const [subject, lines] = opsCalls()[0];
    expect(subject).toBe("응급 알림 실패 L3 medical_acute perm-only");
    expect(lines).toContain("실패한 경로: webhook(영구 실패)");
    expect(lines.some((l) => l.startsWith("'영구 실패'는"))).toBe(true);
  });
});

/**
 * 영구 실패는 받은 곳이 확인돼도 운영자에게 알린다(2026-10-07 7차). 예전엔 이메일 등이 닿으면 경보가 없어 — 메신저 주소 404·차단된 주소,
 *   FCM 서버 자격증명·권한(설정 탓), 앱을 지운 휴대폰, FCM 자체가 꺼진 서버(앱 알림 통째로 없음) — 다시 보내도 같은 고장이 응급마다 조용히
 *   되풀이됐다. 앵커는 그대로(받은 곳 확인 → notifiedAt·1시간 창). 제목에 레벨·분류·userId — sendOpsAlert의 1시간 묶음이 같은 고장을 한
 *   통으로 줄인다. 일시 실패가 섞였으면(2026-10-08 10차) 이 경보 대신 "일부 경로 일시 실패" 한 통에 영구 실패까지 싣고 앵커도 걸지 않는다
 *   (emergency-notify-send-failures "받은 곳이 확인돼도 일시 실패가 있으면" describe).
 */
describe("영구 실패 — 받은 곳이 확인돼도 운영자에게 알린다(앵커는 그대로)", () => {
  const permSubject = (uid: string) => `L3 위급 알림 일부 경로 영구 실패 medical_acute ${uid}`;
  let warn: { mockRestore: () => void };
  let err: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); err.mockRestore(); vi.unstubAllGlobals(); });

  it.each([
    ["웹훅 404", "https://hook.example.com/x", 404, "webhook(영구 실패)"],
    ["막힌 웹훅(사설 주소)", "https://private.example/x", 200, "webhook(영구 실패 — 차단된 주소)"],
  ])("이메일은 닿고 %s → 경보 정확히 한 통(제목에 userId, 이름·주소 없음) + 앵커(notifiedAt)", async (_, url, status, label) => {
    db.user.findUnique.mockResolvedValue({ name: "김영자", guardianWebhookUrl: url, guardianEmail: "g@example.com", guardianName: null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
    const uid = `perm-hook-${status}`;
    expect(await notify({ userId: uid })).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
    // 🔒 받은 곳(이메일)이 확인됐다고 경보가 없으면 보호자가 등록한 메신저 사본이 응급마다 조용히 빠진다
    expect(opsCalls().map(([s]) => s)).toEqual([permSubject(uid)]);
    const lines = opsCalls()[0][1];
    expect(lines).toContain(`실패한 경로: ${label}`);
    expect(lines).toContain("보낸 경로: fcm-topic, email");
    expect(lines.some((l) => l.startsWith("'영구 실패'는"))).toBe(true);
    expect(lines.join("\n")).toContain("중복 방지 기록은 남겼습니다");
    expect(lines.join("\n")).not.toMatch(/김영자|김응급|g@example\.com|hook\.example|private\.example/);
    // 🔒 앵커는 그대로 — 받은 곳이 확인됐다
    expect(db.message.update).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["설정 탓(권한 거부)", "messaging/mismatched-credential", "config" as const, [] as string[]],
    ["없는 기기(앱을 지움)", "messaging/registration-token-not-registered", "token" as const, [TOK_READY]],
  ])("이메일은 닿고 알림 허용 휴대폰이 %s로만 실패 → 경보 한 통(fcm(영구 실패 코드)) + 앵커", async (_, code, kind, invalid) => {
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    tokenPushMock.mockResolvedValue({ sent: 0, failed: 1, invalidTokens: invalid, deliveredTokens: [], failures: [fcmFail(TOK_READY, code, kind)] });
    const uid = `perm-fcm-${kind}`;
    expect(await notify({ userId: uid })).toEqual({ sent: true, channels: ["fcm-topic", "email"] });
    // 🔒 서버 권한·앱 삭제는 다시 보내도 같다 — 이메일이 닿았다고 묻히면 보호자 휴대폰 알림이 끊긴 걸 아무도 모른다
    expect(opsCalls().map(([s]) => s)).toEqual([permSubject(uid)]);
    expect(opsCalls()[0][1]).toContain(`실패한 경로: fcm(영구 실패 ${code})`);
    expect(opsCalls()[0][1]).toContain("연결 계정의 등록 휴대폰: 1대(알림 허용 보고 1대)");
    expect(db.message.update).toHaveBeenCalledTimes(1);
  });

  it("연결 보호자가 있는데 서버 FCM이 꺼져 있으면(이메일은 닿음) 설정 탓 영구 실패 — 경보 한 통 · 연결 보호자가 없으면 실패가 아니다", async () => {
    pushMock.mockResolvedValue({ sent: 0, failed: 0, skipped: "FCM not configured", failures: [] });
    expect(await notify({ userId: "perm-fcm-off" })).toEqual({ sent: true, channels: ["email"] });
    // 🔒 예전엔 로그 한 줄("fcm skipped")뿐 — 이메일이 닿으면 모든 보호자의 앱 알림이 꺼져 있어도 운영자는 몰랐다
    expect(opsCalls().map(([s]) => s)).toEqual([permSubject("perm-fcm-off")]);
    expect(opsCalls()[0][1]).toContain("실패한 경로: fcm(영구 실패 — 서버 FCM 설정 없음·사용 불가)");
    expect(err.mock.calls.some((c) => String(c[0]).includes("fcm skipped"))).toBe(true);
    expect(db.message.update).toHaveBeenCalledTimes(1);

    opsAlertMock.mockClear();
    db.expertPatient.findMany.mockResolvedValue([]);
    // 앱 알림을 보낼 계정이 없으면 FCM이 꺼져 있어도 빠진 사본이 없다
    expect(await notify({ userId: "perm-fcm-off-nolink" })).toEqual({ sent: true, channels: ["email"] });
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it("어르신마다 제목이 따로(1시간 묶음이 다른 어르신 경보를 삼키지 않는다) · 받은 곳이 없으면 '위급 알림 발송 실패' 한 통뿐", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: "https://hook.example.com/x", guardianEmail: "g@example.com", guardianName: null });
    await notify({ userId: "perm-elder-a" });
    await notify({ userId: "perm-elder-b" });
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: "https://hook.example.com/x", guardianEmail: null, guardianName: null });
    await notify({ userId: "perm-elder-c" });
    // 🔒 같은 응급에 비슷한 경보 두 통 금지 — 받은 곳이 없으면(토픽뿐) 발송 실패 경보 하나가 영구 실패까지 싣는다
    expect(opsCalls().map(([s]) => s)).toEqual([
      permSubject("perm-elder-a"), permSubject("perm-elder-b"), "L3 위급 알림 발송 실패 medical_acute perm-elder-c",
    ]);
  });

  it("영구 실패 경보가 실패해도(SMTP) 발송 결과는 그대로", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: "https://hook.example.com/x", guardianEmail: "g@example.com", guardianName: null });
    opsAlertMock.mockRejectedValueOnce(new Error("smtp down"));
    // 🔒 경보 실패가 새면 이미 나간 이메일·토픽 결과까지 버려지고 호출부(after())가 무너진다
    await expect(notify({ userId: "perm-alert-smtp" })).resolves.toEqual({ sent: true, channels: ["fcm-topic", "email"] });
    expect(opsCalls().map(([s]) => s)).toEqual([permSubject("perm-alert-smtp")]);   // 시도는 했다
  });

  /**
   * 서버 자격증명이 거절됐다(invalid_grant — 키 폐기·서비스 계정 삭제, 2026-10-07 8차) — FCM 사본(등록 휴대폰·토픽)이 **모두** 그 오류로
   *   실패한다. 분류는 push-fcm의 실제 함수(thrownFailures — 메시지별 실패와 같은 classifyFcmError)로 붙인다. 예전엔 app/invalid-credential을
   *   늘 일시로 세, 이메일이 닿으면 경보도 없이 모든 앱 알림이 끊긴 채였다.
   */
  it("이메일은 닿고 FCM 사본이 모두 거절된 서버 자격증명(invalid_grant)으로 실패 → '일부 경로 영구 실패' 한 통(fcm(영구 실패 app/invalid-credential)) + 앵커(8차)", async () => {
    const { thrownFailures } = await import("@/lib/notify/push-fcm");
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    tokenPushMock.mockResolvedValue({ sent: 0, failed: 1, invalidTokens: [], deliveredTokens: [], failures: thrownFailures([TOK_READY], INVALID_GRANT) });
    pushMock.mockResolvedValue({ sent: 0, failed: 1, failures: thrownFailures(["g1"], INVALID_GRANT) });
    const uid = "perm-invalid-grant";
    expect(await notify({ userId: uid })).toEqual({ sent: true, channels: ["email"] });
    // 🔒 일시로 세면(예전) 받은 곳(이메일)이 확인돼 경보가 없다 — 모든 보호자의 앱 알림이 끊긴 걸 아무도 모른다
    expect(opsCalls().map(([s]) => s)).toEqual([permSubject(uid)]);
    expect(opsCalls()[0][1]).toContain("실패한 경로: fcm(영구 실패 app/invalid-credential), fcm-topic(영구 실패 app/invalid-credential)");
    expect(db.message.update).toHaveBeenCalledTimes(1);
  });

  /**
   * 등록 휴대폰 **모두**의 실패를 센다(2026-10-07 8차) — 보호자 A의 알림 허용 휴대폰에 닿았다고 보호자 B의 죽은 토큰을 세지 않으면,
   *   B의 등록이 끊긴 것(B는 토픽 사본만 받는다 — 가린 이름)을 아무도 모른다. 받은 곳은 A로 확인됐으니 앵커는 그대로다.
   */
  it("보호자 A의 알림 허용 휴대폰엔 닿고 보호자 B의 휴대폰은 '없는 기기' → 영구 실패 경보 한 통 + 앵커(8차)", async () => {
    db.user.findUnique.mockResolvedValue({ name: "김영자", guardianWebhookUrl: null, guardianEmail: null, guardianName: null });
    db.expertPatient.findMany.mockResolvedValue([{ expertUserId: "gA" }, { expertUserId: "gB" }]);
    const TOK_B = "tokb_" + "b".repeat(40);
    devicesMock.mockResolvedValue([device("gA", TOK_READY), device("gB", TOK_B)]);
    tokenPushMock.mockResolvedValue({
      sent: 1, failed: 1, invalidTokens: [TOK_B], deliveredTokens: [TOK_READY],
      failures: [fcmFail(TOK_B, "messaging/registration-token-not-registered", "token")],
    });
    pushMock.mockResolvedValue({ sent: 2, failed: 0, failures: [] });
    const uid = "perm-guardian-b-gone";
    expect(await notify({ userId: uid })).toEqual({ sent: true, channels: ["fcm", "fcm-topic"] });
    expect(deleteTokensMock).toHaveBeenCalledWith([TOK_B]);
    // 🔒 예전엔 A의 휴대폰이 닿으면 B의 실패를 세지 않았다
    expect(opsCalls().map(([s]) => s)).toEqual([permSubject(uid)]);
    expect(opsCalls()[0][1]).toContain("실패한 경로: fcm(영구 실패 messaging/registration-token-not-registered)");
    expect(opsCalls()[0][1]).toContain("연결 계정의 등록 휴대폰: 2대(알림 허용 보고 2대)");
    expect(opsCalls()[0][1].join("\n")).not.toContain("김영자");
    expect(db.message.update).toHaveBeenCalledTimes(1);
  });
});

/**
 * 받은 곳 확인 + 조회 실패 + 영구 실패가 한 응급에 겹치면(2026-10-08 11차) — 조회 실패는 앵커를 막고(60초 바닥 — notifyGuardian 6), 영구
 *   실패는 경보를 부른다(앵커는 막지 않는다). 예전엔 "일부 경로 영구 실패" 경보가 늘 "중복 방지 기록은 남겼습니다"라고 적어, 같은 응급의
 *   조회 실패 경보("남기지 않았습니다")와 엇갈렸다 — 실제로는 앵커가 없어 60초 뒤 다시 갔다. 이제 그 경보도 실제 결과를 적는다.
 *   경보는 정확히 둘(조회 실패 → 영구 실패)이고, 어느 경보에도 "남겼습니다"가 없다.
 */
describe("받은 곳 확인 + 조회 실패 + 영구 실패 — 경보는 정확히 둘, 영구 실패 경보도 '기록을 남기지 않았다'(11차)", () => {
  type Payload = Parameters<typeof import("@/lib/chat/emergency-notify").notifyGuardian>[0];
  const NOT_ANCHORED =
    "받은 곳이 확인되는 경로(알림을 허용한 등록 휴대폰·이메일·메신저)로는 전달됐지만, 조회 실패(또는 등록 휴대폰 경로 시간 초과 — " +
    "따로 보낸 경보)로 빠졌거나 나갔는지 모르는 사본이 있어 중복 방지 기록을 남기지 않았습니다 — 같은 응급이 다음 대화 턴(60초 뒤부터)에 " +
    "다시 감지되면 다시 보냅니다(이미 받은 곳은 한 번 더 받습니다).";
  const TOK_DEAD = "dead_" + "d".repeat(40);
  /** 메신저 주소는 404(영구 실패), 이메일은 닿는다 */
  const hook404AndEmail = () => {
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: "https://hook.example.com/x", guardianEmail: "g@example.com", guardianName: null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
  };
  let warn: { mockRestore: () => void };
  let err: { mockRestore: () => void };
  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); err.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each([
    ["등록 휴대폰 조회 실패(DB)", "device", ["fcm-topic", "email"], "webhook(영구 실패)", () => {
      devicesMock.mockRejectedValue(new Error("connection reset"));
      hook404AndEmail();
    }],
    ["보호자 연결 조회 실패(DB)", "link", ["email"], "webhook(영구 실패)", () => {
      db.expertPatient.findMany.mockRejectedValue(new Error("db down"));
      hook404AndEmail();
    }],
    ["보호자 연락처 조회 실패(DB)", "contact", ["fcm", "fcm-topic"], "fcm(영구 실패 messaging/registration-token-not-registered)", () => {
      db.user.findUnique.mockRejectedValue(new Error("db down"));
      devicesMock.mockResolvedValue([device("g1", TOK_READY), device("g1", TOK_DEAD)]);
      tokenPushMock.mockResolvedValue({
        sent: 1, failed: 1, invalidTokens: [TOK_DEAD], deliveredTokens: [TOK_READY],
        failures: [fcmFail(TOK_DEAD, "messaging/registration-token-not-registered", "token")],
      });
    }],
  ] as const)("%s + 받은 곳 확인 + 영구 실패 → 조회 실패 경보 → 영구 실패 경보('남기지 않았다') 둘뿐, 실제로 60초 바닥", async (lookupTitle, key, channels, permLabel, arrange) => {
    arrange();
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const uid = `confirmed-lookup-perm-${key}`;
    const payload = { ...P, userId: uid, messageId: `m-clp-${key}` } as Payload;
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: [...channels] });
    // 정확히 둘 — 조회 실패(늘)와 영구 실패(받은 곳이 확인돼도 늘). 일시 실패·미확인 경보는 없다
    expect(opsCalls().map(([s]) => s)).toEqual([`L3 ${lookupTitle} medical_acute ${uid}`, `L3 위급 알림 일부 경로 영구 실패 medical_acute ${uid}`]);
    const [lookupLines, permLines] = opsCalls().map(([, lines]) => lines.join("\n"));
    // 🔒 (12차) 다시 보내는 것은 같은 응급이 다시 감지될 때뿐이다 — 그래서 빠진 경로의 보호자에게 직접 확인하라고 적는다
    expect(lookupLines).toContain("중복 방지 기록을 남기지 않았습니다 — 같은 응급이 다음 대화 턴(60초 뒤부터)에 다시 감지되면 다시 보냅니다");
    expect(lookupLines).toContain("빠진 경로로 받는 보호자에게는 직접 확인해 주세요.");
    expect(permLines).toContain(`실패한 경로: ${permLabel}`);
    // 🔒 예전엔 이 경보가 "중복 방지 기록은 남겼습니다" — 같은 응급의 조회 실패 경보("남기지 않았습니다")와 엇갈렸다
    expect(permLines).toContain(NOT_ANCHORED);
    for (const [s, lines] of opsCalls()) expect([s, ...lines].join("\n"), s).not.toContain("남겼습니다");
    // 경보가 적은 대로다 — notifiedAt 없음, 메모리 앵커는 60초 바닥뿐(59초엔 막히고 61초엔 다시 보낸다)
    expect(db.message.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(59 * 1000);
    expect(await notifyGuardian(payload)).toMatchObject({ sent: false, reason: expect.stringContaining("메모리 상한") });
    vi.advanceTimersByTime(2 * 1000);
    expect(await notifyGuardian(payload)).toEqual({ sent: true, channels: [...channels] });
  });
});

/**
 * 전 채널 실패의 앵커(2026-10-07 7차) — 실패가 **모두 영구 실패**면(일시 실패·조회 실패 없음) 1시간 창: 다시 보내도 같은 고장으로 60초마다
 *   다시 돌며 경보·로그만 쌓이지 않게. notifiedAt은 쓰지 않는다(보호자에게 아무것도 닿지 않았다 — 하루 점검이 notifiedAt IS NULL로 잡는다).
 *   보낼 곳이 없거나(위 "전 채널 실패는 짧은 재시도 바닥만 남긴다") 일시·조회 실패가 섞이면 예전대로 60초 바닥.
 */
describe("전 채널 실패 — 영구 실패뿐이면 1시간 창(notifiedAt 없음), 일시·조회 실패가 섞이면 60초 바닥", () => {
  type Payload = Parameters<typeof import("@/lib/chat/emergency-notify").notifyGuardian>[0];
  const hook = (email: string | null = null) => ({ name: null, guardianWebhookUrl: "https://hook.example.com/x", guardianEmail: email, guardianName: null });
  let warn: { mockRestore: () => void };
  let err: { mockRestore: () => void };
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchSpy = vi.fn(async () => new Response("{}", { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
    db.expertPatient.findMany.mockResolvedValue([]);
  });
  afterEach(() => { warn.mockRestore(); err.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("웹훅 404뿐 → '응급 알림 실패' 경보(1시간 창이라고 적는다) · 61초 뒤 같은 응급은 억제 · notifiedAt은 쓰지 않는다", async () => {
    db.user.findUnique.mockResolvedValue(hook());
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "allperm-hook", messageId: "m-allperm" } as Payload;
    expect((await notifyGuardian(payload)).sent).toBe(false);
    expect(opsCalls().map(([s]) => s)).toEqual(["응급 알림 실패 L3 medical_acute allperm-hook"]);
    expect(opsCalls()[0][1]).toContain("실패한 경로: webhook(영구 실패)");
    expect(opsCalls()[0][1].some((l) => l.startsWith("실패가 모두 영구 실패라(다시 보내도 같다) 같은 응급을 1시간 동안"))).toBe(true);
    // 보호자에게 아무것도 닿지 않았다 — 하루 점검(notifiedAt IS NULL)이 그대로 잡아야 한다
    expect(db.message.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(61 * 1000);
    // 🔒 60초 바닥이면 같은 404로 매 턴 다시 돌며 웹훅·경보 시도만 쌓인다
    expect(await notifyGuardian(payload)).toMatchObject({ sent: false, reason: expect.stringContaining("메모리 상한") });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["일시 실패(이메일 SMTP 일시)가 섞이면", () => {
      db.user.findUnique.mockResolvedValue(hook("g@example.com"));
      emailMock.mockResolvedValue("transient");
    }],
    ["조회 실패(보호자 연결)가 섞이면", () => {
      db.user.findUnique.mockResolvedValue(hook());
      db.expertPatient.findMany.mockRejectedValue(new Error("db down"));
    }],
  ])("웹훅 404 + %s → 60초 바닥 — 61초 뒤 다시 보낸다(경보에 1시간 문구 없음)", async (_, arrange) => {
    arrange();
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: `allperm-mixed-${_}`, messageId: "m-mixed" } as Payload;
    expect((await notifyGuardian(payload)).sent).toBe(false);
    const allFail = opsCalls().find(([s]) => s.startsWith("응급 알림 실패"));
    expect(allFail).toBeDefined();
    expect(allFail![1].some((l) => l.startsWith("실패가 모두 영구 실패라"))).toBe(false);
    vi.advanceTimersByTime(61 * 1000);
    // 🔒 잠시 뒤면 될 수 있는 실패가 섞였는데 1시간을 막으면 그 응급은 그 채널로 끝내 가지 않는다
    expect((await notifyGuardian(payload)).reason ?? "").not.toContain("메모리 상한");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  /**
   * "응급 알림 실패"의 앵커 결과 줄(2026-10-08 12차) — 예전엔 영구 실패뿐일 때(1시간 창)만 적고, 60초 바닥일 때는 아무 말이 없어 운영자가
   *   다시 가는지·언제 가는지 몰랐다. 다시 가는 것은 같은 응급이 다시 감지될 때뿐이다(재시도 큐는 없다). 보낼 곳이 없는 "응급 알림 대상
   *   없음"은 그 줄이 없다 — 다시 감지돼도 보낼 곳이 없다.
   */
  it("(12차) '응급 알림 실패'에 앵커 결과 — 일시·조회 실패면 '다시 감지되면 다시 보냅니다', 영구 실패뿐이면 1시간, '응급 알림 대상 없음'엔 없음", async () => {
    const NOT_ANCHORED = "중복 방지 기록을 남기지 않았습니다 — 같은 응급이 다음 대화 턴(60초 뒤부터)에 다시 감지되면 다시 보냅니다.";
    const linesOf = (subject: string): string[] => {
      const alert = opsCalls().find(([s]) => s === subject);
      expect(alert, subject).toBeDefined();
      return alert![1];
    };
    // 일시 실패뿐(이메일 SMTP 일시 — 연결 보호자 없음)
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: null });
    emailMock.mockResolvedValue("transient");
    expect((await notify({ userId: "allfail-line-transient" })).sent).toBe(false);
    // 조회 실패(보호자 연결) + 웹훅 404
    db.user.findUnique.mockResolvedValue(hook());
    db.expertPatient.findMany.mockRejectedValueOnce(new Error("db down"));
    expect((await notify({ userId: "allfail-line-lookup" })).sent).toBe(false);
    // 영구 실패뿐(웹훅 404)
    expect((await notify({ userId: "allfail-line-perm" })).sent).toBe(false);
    // 보낼 곳 없음(보호자 미연결·연락처 미등록 — 설정 문제)
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: null, guardianEmail: null, guardianName: null });
    expect((await notify({ userId: "allfail-line-none" })).sent).toBe(false);

    // 🔒 60초 바닥인데 아무 말이 없으면 운영자는 그 응급이 다시 가는지·언제 가는지 모른다
    expect(linesOf("응급 알림 실패 L3 medical_acute allfail-line-transient")).toContain(NOT_ANCHORED);
    expect(linesOf("응급 알림 실패 L3 medical_acute allfail-line-lookup")).toContain(NOT_ANCHORED);
    const perm = linesOf("응급 알림 실패 L3 medical_acute allfail-line-perm");
    expect(perm.some((l) => l.startsWith("실패가 모두 영구 실패라(다시 보내도 같다) 같은 응급을 1시간 동안"))).toBe(true);
    expect(perm).not.toContain(NOT_ANCHORED);
    // 🔒 보낼 곳이 없는데 다시 보낸다고 적으면 운영자는 연결·연락처 설정 대신 다음 턴을 기다린다
    expect(linesOf("응급 알림 대상 없음 L3 medical_acute allfail-line-none").join("\n")).not.toMatch(/중복 방지 기록|다시 감지되면|1시간/);
  });

  it("보낸 곳 없이 FCM 사본이 모두 거절된 서버 자격증명(invalid_grant)뿐 → 영구 실패뿐이라 1시간 창(notifiedAt 없음) + '응급 알림 실패' 경보(8차)", async () => {
    const { thrownFailures } = await import("@/lib/notify/push-fcm");
    db.user.findUnique.mockResolvedValue({ name: null, guardianWebhookUrl: null, guardianEmail: null, guardianName: null });
    db.expertPatient.findMany.mockResolvedValue([{ expertUserId: "g1" }]);
    devicesMock.mockResolvedValue([device("g1", TOK_READY)]);
    tokenPushMock.mockResolvedValue({ sent: 0, failed: 1, invalidTokens: [], deliveredTokens: [], failures: thrownFailures([TOK_READY], INVALID_GRANT) });
    pushMock.mockResolvedValue({ sent: 0, failed: 1, failures: thrownFailures(["g1"], INVALID_GRANT) });
    const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
    const payload = { ...P, userId: "allperm-invalid-grant", messageId: "m-aig" } as Payload;
    expect((await notifyGuardian(payload)).sent).toBe(false);
    expect(opsCalls().map(([s]) => s)).toEqual(["응급 알림 실패 L3 medical_acute allperm-invalid-grant"]);
    const lines = opsCalls()[0][1];
    expect(lines).toContain("실패한 경로: fcm(영구 실패 app/invalid-credential), fcm-topic(영구 실패 app/invalid-credential)");
    expect(lines.some((l) => l.startsWith("실패가 모두 영구 실패라(다시 보내도 같다) 같은 응급을 1시간 동안"))).toBe(true);
    // 보호자에게 아무것도 닿지 않았다 — 하루 점검(notifiedAt IS NULL)이 그대로 잡아야 한다
    expect(db.message.update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(61 * 1000);
    // 🔒 일시로 세면(예전) 자격증명을 고칠 때까지 60초마다 다시 돌며 경보·로그만 쌓인다
    expect(await notifyGuardian(payload)).toMatchObject({ sent: false, reason: expect.stringContaining("메모리 상한") });
    expect(pushMock).toHaveBeenCalledTimes(1);
  });
});
