/**
 * 웹 ↔ 앱(WebView) 브릿지 — 보호자 휴대폰의 위급 알림을 **조용히 끊지 않는다**.
 *
 * 2026-10-07 보호자 앱 푸시 추적: 세션 상태가 "unauthenticated"로 보이기만 해도 LOGOUT을 보냈다.
 *   next-auth는 세션 조회가 한 번만 실패해도(앱 복귀 순간 네트워크 끊김·5xx) null 세션을 돌려주므로,
 *   그때마다 앱이 보호자 토픽(maeum_<id>) 구독을 끊었다 → 다시 로그인할 때까지 위급 알림이 안 왔다.
 *   이제 LOGOUT은 로그아웃 버튼에서만 보낸다(logoutAndNotifyNative).
 *
 * 같은 날 기기 토큰 등록(앱 1.2.0): 앱이 PUSH_TOKEN을 보내면 웹이 **세션 계정으로** 서버에 등록하고 결과를 앱에 알린다
 *   (표시용 — 앱은 로그인해 있는 동안 토픽 구독을 늘 유지한다, RnBridge 계약).
 *   고정하는 것: 앱이 넣은 메시지만 받는다 / 토큰은 화면 이벤트에 싣지 않는다 / 로그아웃 순서(해제 → signOut → LOGOUT)와
 *   signOut 실패 시 등록 복구 / 로그아웃 중엔 PUSH_TOKEN을 등록·답장하지 않는다 / 해제 실패에도 로그아웃은 끝까지.
 *
 * 3차(같은 날): signOut이 resolve해도 로그아웃이 아닐 수 있다(next-auth 4.24 — CSRF 토큰을 못 받으면 ".../signout?csrf=true"로
 *   resolve하고 쿠키는 그대로). 응답 주소·csrf·세션 재확인으로 확인되지 않으면 실패로 다루고, 실패하면 늘 REQUEST_PUSH_TOKEN
 *   (앱이 토픽을 다시 구독하고 다시 보고) + 버튼은 안내 창. 진행 중인 등록은 되살리기까지 **전부** 기다린 뒤 해제한다.
 *   PUSH_TOKEN의 retiredTokens(폐기 토큰)는 등록 본문에 그대로 싣는다.
 *
 * 4차(같은 날): 로그아웃은 **하나만** 돈다(연달아 눌러도 같은 프라미스 — 되살리기가 도는 중이어도) · 해제(DELETE)가 5xx·네트워크면
 *   한 번 더 해 본다(429·4xx는 한 번) · 로그아웃의 해제는 서버에서 토픽을 건드리지 않는다(확인된 LOGOUT에서 앱의 토큰 폐기가
 *   그 구독을 끝낸다 — app/api/push/device).
 *
 * 10차(2026-10-08): PUSH_TOKEN.error(토큰을 못 받은 까닭 — 모양을 좁혀 받는다)를 등록 실패 사유에 붙인다("no-token:<error>").
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type SignOutResult = { url?: string } | undefined;
type SessionResult = { user?: { id: string }; expires: string } | null;
const h = vi.hoisted(() => {
  const log: string[] = [];
  return {
    log,
    signOut: vi.fn<(opts?: unknown) => Promise<SignOutResult>>(async () => { log.push("signOut"); return { url: "/login" }; }),
    // signOut 뒤 세션 재확인 — 기본은 "사용자 없음"(로그아웃 확인)
    getSession: vi.fn<() => Promise<SessionResult>>(async () => null),
    session: { data: { user: { id: "u-guardian" } }, status: "authenticated" },
  };
});
vi.mock("next-auth/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next-auth/react")>()),
  signOut: (opts?: unknown) => h.signOut(opts),
  getSession: () => h.getSession(),
  useSession: () => h.session,
}));
// 서버 handle 규칙(lib/push/devices deviceHandle)과 맞대어 보려고 불러온다 — DB는 쓰지 않는다
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const { bridgeMessageFor, notifyNativeLogout, parseNativePushToken, isFromNativeApp } = await import("@/app/RnBridge");

/** 모듈 상태(마지막으로 받은 휴대폰 토큰)를 테스트마다 비운 새 모듈 */
async function freshBridge() {
  vi.resetModules();
  return import("@/app/RnBridge");
}

const TOKEN = "fcm-token_" + "A".repeat(60) + ":APA91b";
const RETIRED = "fcm-token_" + "R".repeat(60) + ":APA91b";
const PUSH = { type: "PUSH_TOKEN", userId: "u-guardian", token: TOKEN, permission: "granted", channelBlocked: false, appVersion: "1.2.0" };
/** 서버 등록 본문(retiredTokens 없음) — 되살리기도 같은 본문이어야 한다 */
const DEVICE_BODY = { token: TOKEN, appVersion: "1.2.0", permission: "granted", channelBlocked: false };
const SIGNED_IN = { user: { id: "u-guardian" }, expires: "2099-01-01T00:00:00.000Z" };

/** 앱 웹뷰를 흉내 낸 window — 앱으로 간 메시지·화면 이벤트·이동을 순서대로 남긴다 */
function installAppWindow() {
  const target = new EventTarget();
  const posted: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  target.addEventListener("maeum:push-status", (e) => events.push((e as CustomEvent).detail));
  const win = Object.assign(target, {
    ReactNativeWebView: {
      postMessage: (m: string) => {
        const j = JSON.parse(m) as Record<string, unknown>;
        posted.push(j);
        h.log.push(`native:${String(j.type)}`);
      },
    },
    location: { origin: "https://maeum.example", assign: (u: string) => { h.log.push(`assign:${u}`); } },
  });
  (globalThis as { window?: unknown }).window = win;
  return { posted, events, win };
}

/** fetch — 방법별로 정한 응답, 호출은 순서 기록에 남긴다 */
function stubFetch(respond: (method: string) => Response | Promise<Response> = () => new Response(JSON.stringify({ ok: true }), { status: 200 })) {
  const bodies: { method: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    h.log.push(`${method} ${url}`);
    bodies.push({ method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return respond(method);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, bodies };
}

/** 앱 웹뷰의 document — 화면이 다시 보이는지(visibilitychange)만 흉내 낸다 */
function installDocument() {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as "visible" | "hidden" });
  (globalThis as { document?: unknown }).document = doc;
  return doc;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  vi.unstubAllGlobals();
  h.log.length = 0;
  h.signOut.mockClear();
  // 한 번용 응답이 다음 테스트로 새지 않게 — 기본(사용자 없음)으로 되돌린다
  h.getSession.mockReset();
  h.getSession.mockImplementation(async () => null);
});

describe("세션 상태 → 앱 메시지", () => {
  it("세션이 끊겨 보여도(unauthenticated) 아무것도 보내지 않는다 — 구독을 끊는 LOGOUT 금지", () => {
    // 🔒 예전엔 여기서 LOGOUT을 보내 앱이 보호자 토픽 구독을 해제했다
    expect(bridgeMessageFor("unauthenticated", undefined, undefined, "u-guardian")).toBeNull();
    expect(bridgeMessageFor("unauthenticated", undefined, undefined, null)).toBeNull();
  });

  it("로딩 중에도 보내지 않는다", () => {
    expect(bridgeMessageFor("loading", "u1", "guardian", null)).toBeNull();
  });

  it("로그인되면 LOGIN_SUCCESS(userId, role)를 한 번 보낸다 — 앱이 maeum_<userId>를 구독하고 역할로 안내를 고른다", () => {
    const r = bridgeMessageFor("authenticated", "u-guardian", "guardian", null);
    expect(r).not.toBeNull();
    expect(JSON.parse(r!.message)).toEqual({ type: "LOGIN_SUCCESS", userId: "u-guardian", role: "guardian" });
    expect(r!.sent).toBe("u-guardian");
    // 같은 계정이면 다시 보내지 않는다
    expect(bridgeMessageFor("authenticated", "u-guardian", "guardian", "u-guardian")).toBeNull();
  });

  it("다른 계정으로 바뀌면 새 계정으로 보낸다 — 앱이 이전 구독을 새 계정으로 바꾼다", () => {
    const r = bridgeMessageFor("authenticated", "u-other", "user", "u-guardian");
    expect(JSON.parse(r!.message)).toEqual({ type: "LOGIN_SUCCESS", userId: "u-other", role: "user" });
  });

  it("역할을 모르면 예전 모양 그대로(구버전 앱은 userId만 읽는다)", () => {
    expect(JSON.parse(bridgeMessageFor("authenticated", "u1", undefined, null)!.message)).toEqual({ type: "LOGIN_SUCCESS", userId: "u1" });
  });
});

describe("웹 → 앱 신호", () => {
  it("LOGOUT — 계정 id를 실어 앱이 그 계정 구독을 정확히 끊게", () => {
    const { posted } = installAppWindow();
    notifyNativeLogout("u-guardian");
    expect(posted[0]).toEqual({ type: "LOGOUT", userId: "u-guardian" });
    notifyNativeLogout();
    expect(posted[1]).toEqual({ type: "LOGOUT" });
  });

  it("알림 토큰 재요청·알림 설정 열기", async () => {
    const { posted } = installAppWindow();
    const { requestNativePushToken, openNativeNotificationSettings } = await import("@/app/RnBridge");
    requestNativePushToken();
    openNativeNotificationSettings();
    expect(posted).toEqual([{ type: "REQUEST_PUSH_TOKEN" }, { type: "OPEN_NOTIFICATION_SETTINGS" }]);
  });

  it("일반 브라우저(브릿지 없음)에서는 조용히 넘어간다", async () => {
    (globalThis as { window?: unknown }).window = {};
    const { requestNativePushToken, openNativeNotificationSettings } = await import("@/app/RnBridge");
    expect(() => { notifyNativeLogout(); requestNativePushToken(); openNativeNotificationSettings(); }).not.toThrow();
  });

  it("브릿지가 throw해도 로그아웃을 막지 않는다", () => {
    (globalThis as { window?: unknown }).window = { ReactNativeWebView: { postMessage: () => { throw new Error("bridge"); } } };
    expect(() => notifyNativeLogout()).not.toThrow();
  });
});

/**
 * 보호자 화면의 "이 휴대폰" 상태 지켜보기(2026-10-07) — 처음 한 번만 물으면 설정에서 알림을 켜고 돌아와도 화면이
 *   "꺼져 있어요"에 머문다. 화면이 다시 보일 때와 알림 설정을 연 직후에도 다시 묻는다.
 */
describe("이 휴대폰 상태 다시 묻기 — 처음·화면이 다시 보일 때·알림 설정을 연 직후", () => {
  it("지금 한 번, 다시 보일 때마다 REQUEST_PUSH_TOKEN(숨을 땐 묻지 않는다) — 그만 보면 듣지도 묻지도 않는다", async () => {
    const { posted, win } = installAppWindow();
    const doc = installDocument();
    const { watchNativePushStatus } = await import("@/app/RnBridge");
    const seen: unknown[] = [];
    const stop = watchNativePushStatus((s) => seen.push(s));
    expect(posted).toEqual([{ type: "REQUEST_PUSH_TOKEN" }]);

    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(posted).toHaveLength(1);
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    // 🔒 설정에서 돌아온 순간 다시 묻지 않으면 화면이 옛 상태("꺼져 있어요")에 머문다
    expect(posted).toEqual([{ type: "REQUEST_PUSH_TOKEN" }, { type: "REQUEST_PUSH_TOKEN" }]);

    const detail = { permission: "granted", channelBlocked: false, registered: true };
    win.dispatchEvent(new CustomEvent("maeum:push-status", { detail }));
    expect(seen).toEqual([detail]);

    stop();
    doc.dispatchEvent(new Event("visibilitychange"));
    win.dispatchEvent(new CustomEvent("maeum:push-status", { detail }));
    // 🔒 화면을 떠난 뒤에도 남으면 다른 화면에서도 계속 묻고, 상태를 사라진 화면에 넣는다
    expect(posted).toHaveLength(2);
    expect(seen).toHaveLength(1);
  });

  it("알림 설정을 열면 곧바로 상태를 다시 묻는다", async () => {
    const { posted } = installAppWindow();
    const { openNotificationSettingsAndRecheck } = await import("@/app/RnBridge");
    openNotificationSettingsAndRecheck();
    expect(posted).toEqual([{ type: "OPEN_NOTIFICATION_SETTINGS" }, { type: "REQUEST_PUSH_TOKEN" }]);
  });
});

describe("PUSH_TOKEN 해석", () => {
  it("계약 모양 그대로 읽는다", () => {
    expect(parseNativePushToken(JSON.stringify(PUSH))).toEqual({
      userId: "u-guardian", token: TOKEN, permission: "granted", channelBlocked: false, appVersion: "1.2.0",
    });
  });

  it("토큰이 없을 수 있다(null·빈 문자열) — 권한 상태는 화면에 쓴다", () => {
    expect(parseNativePushToken(JSON.stringify({ ...PUSH, token: null, permission: "denied" }))).toMatchObject({ token: null, permission: "denied" });
    expect(parseNativePushToken(JSON.stringify({ ...PUSH, token: "" }))?.token).toBeNull();
  });

  it("폐기 토큰(retiredTokens) — 문자열만 그대로 넘기고, 모양이 틀려도 메시지는 버리지 않는다(검사는 서버가)", () => {
    expect(parseNativePushToken(JSON.stringify({ ...PUSH, retiredTokens: [RETIRED, 7, null, "x"] }))?.retiredTokens).toEqual([RETIRED, "x"]);
    // 🔒 정리용 덧붙임이 틀렸다고 PUSH_TOKEN을 통째로 버리면 등록이 빠져 실명 사본이 안 나간다
    for (const bad of ["abc", { a: 1 }, null, 3]) {
      const r = parseNativePushToken(JSON.stringify({ ...PUSH, retiredTokens: bad }));
      expect(r).not.toBeNull();
      expect(r && "retiredTokens" in r).toBe(false);
    }
    // 없거나 비면 필드도 없다 — 예전 모양 그대로
    expect("retiredTokens" in parseNativePushToken(JSON.stringify(PUSH))!).toBe(false);
    expect("retiredTokens" in parseNativePushToken(JSON.stringify({ ...PUSH, retiredTokens: [] }))!).toBe(false);
  });

  /**
   * reportId(2026-10-07 5차 계약) — 앱이 붙이는 이 보고의 표지. 64자 이하·영문·숫자·_·- 만 받고, 아니면 없는 것으로 본다
   *   (메시지는 버리지 않는다 — 등록이 빠지면 실명 사본이 안 나간다). 받은 값은 답(PUSH_REGISTERED·…FAILED)에 그대로 돌려준다.
   */
  it("reportId — 모양이 맞으면 그대로, 아니면 필드 없이(메시지는 버리지 않는다)", () => {
    const ok = "rep_2026-10-07_" + "a".repeat(49);   // 정확히 64자
    expect(ok).toHaveLength(64);
    expect(parseNativePushToken(JSON.stringify({ ...PUSH, reportId: ok }))?.reportId).toBe(ok);
    expect(parseNativePushToken(JSON.stringify({ ...PUSH, reportId: "A-z_9" }))?.reportId).toBe("A-z_9");
    for (const bad of [ok + "a", "has space", "slash/1", "점검", "", 42, null, { id: "x" }]) {
      const r = parseNativePushToken(JSON.stringify({ ...PUSH, reportId: bad }));
      // 🔒 앱 화면으로 되돌아가는 값이다 — 모양을 좁히지 않으면 아무 문자열이나 앱에 되던져진다
      expect(r, JSON.stringify(bad)).not.toBeNull();
      expect(r && "reportId" in r, JSON.stringify(bad)).toBe(false);
    }
    expect("reportId" in parseNativePushToken(JSON.stringify(PUSH))!).toBe(false);
  });

  /**
   * error(2026-10-08 10차 계약) — 토큰을 못 받은 까닭(앱 getToken 실패 코드·"timeout"·"empty-token"). 64자 이하·영문·숫자·_·.·:·/·- 만 받고,
   *   아니면 없는 것으로 본다(메시지는 버리지 않는다 — 권한 상태는 화면에 쓴다). 등록 실패 사유에 붙는다("no-token:<error>").
   *   (11차) "/"도 받는다 — 앱이 보내는 FCM 오류 코드는 "messaging/unknown"처럼 이름공간이 붙는다(예전엔 그 코드를 버렸다).
   */
  it("error — 모양이 맞으면 그대로(이름공간 '/' 포함 — 11차), 아니면 필드 없이(메시지는 버리지 않는다)", () => {
    const ok64 = "E".repeat(64);
    // 🔒 "messaging/…" — 앱(@react-native-firebase)의 getToken 실패 코드 모양(11차). 버리면 토큰을 못 받은 가장 흔한 까닭이 "no-token"만 남는다
    for (const good of ["SERVICE_NOT_AVAILABLE", "timeout", "empty-token", "java.io.IOException:SERVICE_NOT_AVAILABLE", ok64, "messaging/unknown", "messaging/service-not-available"]) {
      expect(parseNativePushToken(JSON.stringify({ ...PUSH, token: null, error: good }))?.error, good).toBe(good);
    }
    for (const bad of [ok64 + "E", "messaging/" + "x".repeat(55), "has space", "a/b c", "back\\slash", "점검", "<b>x</b>", "", 42, null, { code: "x" }]) {
      const r = parseNativePushToken(JSON.stringify({ ...PUSH, token: null, error: bad }));
      // 🔒 사유에 붙어 앱 답(PUSH_REGISTER_FAILED)·앱 로그로 그대로 돌아가는 값이다(보호자 화면엔 고정 문구만) — 모양을 좁히지 않으면
      //   공백·한글·꺾쇠가 섞인 앱 오류 메시지가 그대로 되던져진다(경로 모양 "/"·"."·":"는 받는다 — 그 밖의 어디로도 가지 않는다)
      expect(r, JSON.stringify(bad)).not.toBeNull();
      expect(r && "error" in r, JSON.stringify(bad)).toBe(false);
    }
    expect("error" in parseNativePushToken(JSON.stringify(PUSH))!).toBe(false);
  });

  it.each([
    ["다른 메시지", JSON.stringify({ type: "PURCHASE_TOKEN", purchaseToken: "x" })],
    ["JSON 아님", "PUSH_TOKEN{"],
    ["문자열 아님", { type: "PUSH_TOKEN" }],
    ["권한 값 오타", JSON.stringify({ ...PUSH, permission: "yes" })],
    ["채널 차단이 문자열", JSON.stringify({ ...PUSH, channelBlocked: "false" })],
    ["토큰이 숫자", JSON.stringify({ ...PUSH, token: 123 })],
    ["토큰 필드 없음", JSON.stringify({ ...PUSH, token: undefined })],
  ])("%s → null(응답하지 않는다 — 앱은 토픽을 유지)", (_, data) => {
    expect(parseNativePushToken(data)).toBeNull();
  });
});

describe("앱이 넣은 메시지만 받는다", () => {
  const self = { location: { origin: "https://maeum.example" } } as unknown as Window;
  const other = { location: { origin: "https://evil.example" } } as unknown as Window;

  it.each([
    ["앱 sendToWeb(보낸 창 없음)", { source: null, origin: "" }, true],
    ["react-native-webview 구형 경로(자기 창)", { source: self, origin: "https://maeum.example" }, true],
    // 🔒 다른 창이 PUSH_TOKEN을 흉내 내면 그 사람의 휴대폰이 이 계정에 등록돼 이 계정의 위급 알림(실명)을 가져간다
    ["다른 창의 postMessage", { source: other, origin: "https://evil.example" }, false],
    ["다른 출처", { source: null, origin: "https://evil.example" }, false],
    ["출처를 지운 다른 창", { source: other, origin: "" }, false],
  ])("%s → %s", (_, e, ok) => {
    expect(isFromNativeApp(e as Pick<MessageEvent, "origin" | "source">, self)).toBe(ok);
  });
});

describe("PUSH_TOKEN → 세션 계정으로 서버 등록 → 앱에 결과 → 화면 이벤트", () => {
  it("등록 성공 — 본문엔 계정 id가 없고(서버가 세션으로 정한다), 화면 이벤트엔 토큰이 없다", async () => {
    const { posted, events } = installAppWindow();
    const { bodies } = stubFetch();
    const bridge = await freshBridge();
    const status = await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify(PUSH))!, "u-guardian");
    expect(bodies).toEqual([{ method: "POST", body: { token: TOKEN, appVersion: "1.2.0", permission: "granted", channelBlocked: false } }]);
    expect(posted).toEqual([{ type: "PUSH_REGISTERED" }]);
    expect(status).toEqual({ permission: "granted", channelBlocked: false, appVersion: "1.2.0", registered: true });
    expect(events).toEqual([status]);
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it("reportId는 답에 그대로 돌려준다(성공·실패 둘 다) — 서버로는 보내지 않고 화면 이벤트에도 싣지 않는다", async () => {
    const { posted, events } = installAppWindow();
    let fail = false;
    const { bodies } = stubFetch(() => (fail ? new Response(JSON.stringify({ notReady: true }), { status: 503 }) : new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const bridge = await freshBridge();
    await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify({ ...PUSH, reportId: "r-1" }))!, "u-guardian");
    fail = true;
    await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify({ ...PUSH, reportId: "r-2" }))!, "u-guardian");
    await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify({ ...PUSH, token: null, reportId: "r-3" }))!, "u-guardian");
    // 🔒 앱은 이 표지로 어느 보고에 대한 답인지 안다 — 빠지면 늦게 온 답을 지금 보고의 결과로 오해한다
    expect(posted).toEqual([
      { type: "PUSH_REGISTERED", reportId: "r-1" },
      { type: "PUSH_REGISTER_FAILED", reason: "not-ready", reportId: "r-2" },
      { type: "PUSH_REGISTER_FAILED", reason: "no-token", reportId: "r-3" },
    ]);
    expect(bodies.map((b) => b.body)).toEqual([DEVICE_BODY, DEVICE_BODY]);
    expect(JSON.stringify(events)).not.toContain("r-1");
  });

  it("서버가 저장하지 않는 역할이라고 답해도({ ok:true, stored:false }) PUSH_REGISTERED — 앱이 폐기 목록을 비운다(5차)", async () => {
    const { posted } = installAppWindow();
    stubFetch(() => new Response(JSON.stringify({ ok: true, stored: false }), { status: 200 }));
    const bridge = await freshBridge();
    await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify({ ...PUSH, retiredTokens: [RETIRED] }))!, "u-guardian");
    // 🔒 실패로 알리면 앱이 같은 폐기 목록을 끝없이 다시 보낸다
    expect(posted).toEqual([{ type: "PUSH_REGISTERED" }]);
  });

  it("폐기 토큰은 등록 본문에 그대로 싣는다 — 화면 이벤트엔 싣지 않는다(서버가 그 행을 지운다)", async () => {
    const { events } = installAppWindow();
    const { bodies } = stubFetch();
    const bridge = await freshBridge();
    await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify({ ...PUSH, retiredTokens: [RETIRED] }))!, "u-guardian");
    // 🔒 빠지면 로그아웃 해제가 실패했던 이전 토큰 행이 이전 계정에 남아 "받는 휴대폰"으로 보인다
    expect(bodies).toEqual([{ method: "POST", body: { ...DEVICE_BODY, retiredTokens: [RETIRED] } }]);
    expect(JSON.stringify(events)).not.toContain(RETIRED);
  });

  it.each([
    ["준비 전(503 notReady)", () => new Response(JSON.stringify({ notReady: true }), { status: 503 }), "not-ready"],
    ["형식 오류(400)", () => new Response(JSON.stringify({ error: "x" }), { status: 400 }), "http-400"],
    ["네트워크 끊김", () => { throw new TypeError("Failed to fetch"); }, "network"],
  ])("등록 실패 %s → PUSH_REGISTER_FAILED — 앱은 토픽을 유지한다", async (_, respond, reason) => {
    const { posted, events } = installAppWindow();
    stubFetch(respond);
    const bridge = await freshBridge();
    await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify(PUSH))!, "u-guardian");
    // 🔒 실패를 PUSH_REGISTERED로 알리면 앱·화면이 "등록됨"으로 보여, 실명 사본이 안 나가는 걸 아무도 모른다
    expect(posted).toEqual([{ type: "PUSH_REGISTER_FAILED", reason }]);
    expect(events[0]).toMatchObject({ registered: false, reason });
  });

  it.each([
    ["토큰 없음", { ...PUSH, token: null, permission: "denied" }, "u-guardian", "no-token"],
    ["로그인 전", PUSH, undefined, "not-logged-in"],
    ["앱과 웹 계정이 다르다(전환 중)", { ...PUSH, userId: "u-previous" }, "u-guardian", "account-mismatch"],
  ])("%s → 서버에 보내지 않고 실패를 알린다", async (_, msg, sessionUserId, reason) => {
    const { posted, events } = installAppWindow();
    const { fetchMock } = stubFetch();
    const bridge = await freshBridge();
    await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify(msg))!, sessionUserId);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: "PUSH_REGISTER_FAILED", reason }]);
    expect(events[0]).toMatchObject({ registered: false, reason, permission: msg.permission });
  });

  it("토큰이 없고 앱이 까닭(error)을 알려 주면 사유에 붙인다 — 'no-token:<error>'(앱 답·화면 이벤트), 토큰이 있으면 쓰지 않는다(10차)", async () => {
    const { posted, events } = installAppWindow();
    const { fetchMock, bodies } = stubFetch();
    const bridge = await freshBridge();
    await bridge.relayNativePushToken(
      parseNativePushToken(JSON.stringify({ ...PUSH, token: null, error: "SERVICE_NOT_AVAILABLE", reportId: "r-9" }))!, "u-guardian",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    // 🔒 까닭이 빠지면 "토큰 없음"만 남아 — 인터넷·Play 서비스 문제인지 앱이 멈춘 것인지(timeout) 가릴 수 없다
    expect(posted).toEqual([{ type: "PUSH_REGISTER_FAILED", reason: "no-token:SERVICE_NOT_AVAILABLE", reportId: "r-9" }]);
    expect(events[0]).toMatchObject({ registered: false, reason: "no-token:SERVICE_NOT_AVAILABLE" });
    posted.length = 0;
    // (11차) 이름공간이 붙은 FCM 오류 코드도 그대로 붙는다 — 화면 문구는 앞부분("no-token")으로 고른다(PushStatusBox registerFailureText)
    await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify({ ...PUSH, token: null, error: "messaging/unknown" }))!, "u-guardian");
    expect(posted).toEqual([{ type: "PUSH_REGISTER_FAILED", reason: "no-token:messaging/unknown" }]);
    expect(events[1]).toMatchObject({ registered: false, reason: "no-token:messaging/unknown" });
    expect(fetchMock).not.toHaveBeenCalled();   // 까닭은 서버로 가지 않는다
    posted.length = 0;
    await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify({ ...PUSH, error: "timeout" }))!, "u-guardian");
    // 토큰이 있으면 등록은 그대로 — 까닭은 서버로 보내지 않는다
    expect(bodies).toEqual([{ method: "POST", body: DEVICE_BODY }]);
    expect(posted).toEqual([{ type: "PUSH_REGISTERED" }]);
  });
});

describe("로그아웃 순서 — 기기 등록 해제 → signOut → 앱에 LOGOUT → 이동", () => {
  async function registeredBridge(respond?: (method: string) => Response | Promise<Response>) {
    const app = installAppWindow();
    const net = stubFetch(respond);
    const bridge = await freshBridge();
    await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify(PUSH))!, "u-guardian");
    h.log.length = 0;
    net.bodies.length = 0;
    app.posted.length = 0;
    return { ...app, ...net, bridge };
  }

  it("이 휴대폰 등록을 먼저 지우고, 로그아웃이 된 뒤에야 앱에 LOGOUT", async () => {
    const { bridge, bodies, posted } = await registeredBridge();
    await bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" });
    // 🔒 해제는 세션이 있어야 된다(signOut 뒤엔 못 한다). LOGOUT이 signOut보다 먼저면 실패 시 로그인한 채 알림이 끊긴다
    expect(h.log).toEqual(["DELETE /api/push/device", "signOut", "native:LOGOUT", "assign:/login"]);
    expect(bodies).toEqual([{ method: "DELETE", body: { token: TOKEN } }]);
    expect(posted).toEqual([{ type: "LOGOUT", userId: "u-guardian" }]);
    expect(h.signOut).toHaveBeenCalledWith({ redirect: false });
  });

  it("로그아웃한 휴대폰은 잊는다 — 다음 로그아웃에서 남의 등록을 지우려 하지 않는다", async () => {
    const { bridge } = await registeredBridge();
    await bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" });
    h.log.length = 0;
    await bridge.logoutAndNotifyNative({ userId: "u-next", redirectTo: "/login" });
    expect(h.log).toEqual(["signOut", "native:LOGOUT", "assign:/login"]);
  });

  it("구버전 앱(PUSH_TOKEN 없음)·일반 브라우저는 해제 없이 예전 순서", async () => {
    installAppWindow();
    const { fetchMock } = stubFetch();
    const bridge = await freshBridge();
    await bridge.logoutAndNotifyNative({ userId: "u1", redirectTo: "/login" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.log).toEqual(["signOut", "native:LOGOUT", "assign:/login"]);
  });

  it("해제 요청이 (한 번 더 해 봐도) 네트워크로 실패해도 로그아웃은 진행한다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bridge } = await registeredBridge((m) => {
      if (m === "DELETE") throw new TypeError("Failed to fetch");
      return new Response("{}", { status: 200 });
    });
    await bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" });
    // 🔒 일시 끊김은 바로 한 번 더 — 해제가 실패하면 그 행은 그 휴대폰이 다시 등록하거나 다음 발송 때에야 지워진다(4차)
    expect(h.log).toEqual(["DELETE /api/push/device", "DELETE /api/push/device", "signOut", "native:LOGOUT", "assign:/login"]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("등록 해제 실패(network)"))).toHaveLength(1);
    warn.mockRestore();
  });

  it.each([
    [500, 2], [503, 2],   // 일시 장애 — 한 번 더
    [429, 1], [400, 1],   // 다시 해도 같다 — 한 번만
  ])("해제 응답이 %i면 %i번 시도하고 — 해제된 것으로 치지 않고 경고, 로그아웃은 끝까지", async (code, tries) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { bridge, posted } = await registeredBridge((m) => new Response("{}", { status: m === "DELETE" ? code : 200 }));
    await bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" });
    // 🔒 2xx가 아니면 등록은 그대로 남아 있다 — 조용히 "해제됨"으로 넘어가면 아무도 모른다(마지막 선은 앱의 LOGOUT 토큰 폐기)
    expect(warn.mock.calls.filter((c) => String(c[0]).includes(`등록 해제 실패(http-${code})`))).toHaveLength(1);
    expect(h.log).toEqual([...Array<string>(tries).fill("DELETE /api/push/device"), "signOut", "native:LOGOUT", "assign:/login"]);
    expect(posted).toEqual([{ type: "LOGOUT", userId: "u-guardian" }]);
    warn.mockRestore();
  });

  it("해제가 5xx·네트워크로 한 번 실패한 뒤 다시 해 보아 되면 — 경고 없이 로그아웃", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let deletes = 0;
    const { bridge, bodies } = await registeredBridge((m) => {
      if (m !== "DELETE") return new Response("{}", { status: 200 });
      if (++deletes === 1) throw new TypeError("Failed to fetch");
      return new Response("{}", { status: 200 });
    });
    await bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" });
    expect(bodies).toEqual([{ method: "DELETE", body: { token: TOKEN } }, { method: "DELETE", body: { token: TOKEN } }]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("등록 해제 실패"))).toBe(false);
    expect(h.log).toEqual(["DELETE /api/push/device", "DELETE /api/push/device", "signOut", "native:LOGOUT", "assign:/login"]);
    warn.mockRestore();
  });

  it("로그아웃이 시작된 뒤 온 PUSH_TOKEN — 등록(POST)도 앱 답장도 화면 이벤트도 없다", async () => {
    let releaseDelete!: () => void;
    const { bridge, bodies, posted, events } = await registeredBridge((m) => m === "DELETE"
      ? new Promise<Response>((resolve) => { releaseDelete = () => resolve(new Response("{}", { status: 200 })); })
      : new Response("{}", { status: 200 }));
    events.length = 0;
    const out = bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" });
    await vi.waitFor(() => expect(bodies.map((b) => b.method)).toEqual(["DELETE"]));   // 해제 요청이 도는 중
    const status = await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify(PUSH))!, "u-guardian");
    // 🔒 여기서 등록하면 방금 지운 등록이 되살아나 로그아웃한 휴대폰이 그 계정의 실명 알림을 계속 받는다
    expect(bodies.map((b) => b.method)).toEqual(["DELETE"]);
    expect(posted).toEqual([]);
    expect(events).toEqual([]);
    expect(status).toMatchObject({ registered: false, reason: "logging-out" });
    releaseDelete();
    await out;
    expect(h.log).toEqual(["DELETE /api/push/device", "signOut", "native:LOGOUT", "assign:/login"]);
    expect(posted).toEqual([{ type: "LOGOUT", userId: "u-guardian" }]);
  });

  it("등록 요청이 도는 중에 로그아웃 — 해제는 그 등록이 끝난 뒤에 보내고, 끝난 등록엔 답하지 않는다", async () => {
    const { posted } = installAppWindow();
    let releasePost!: () => void;
    const { bodies } = stubFetch((m) => m === "POST"
      ? new Promise<Response>((resolve) => { releasePost = () => resolve(new Response("{}", { status: 200 })); })
      : new Response("{}", { status: 200 }));
    const bridge = await freshBridge();
    const relay = bridge.relayNativePushToken(parseNativePushToken(JSON.stringify(PUSH))!, "u-guardian");
    await vi.waitFor(() => expect(bodies.map((b) => b.method)).toEqual(["POST"]));
    const out = bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" });
    await new Promise((r) => setTimeout(r, 30));
    // 🔒 해제가 먼저 도착하고 등록이 뒤에 도착하면 등록이 남는다 — 해제는 등록이 끝날 때까지 기다린다
    expect(bodies.map((b) => b.method)).toEqual(["POST"]);
    releasePost();
    await Promise.all([relay, out]);
    expect(h.log).toEqual(["POST /api/push/device", "DELETE /api/push/device", "signOut", "native:LOGOUT", "assign:/login"]);
    // 로그아웃이 시작된 뒤 끝난 등록에는 PUSH_REGISTERED를 보내지 않는다
    expect(posted).toEqual([{ type: "LOGOUT", userId: "u-guardian" }]);
  });

  it("signOut이 실패하면 로그아웃 중 표시를 푼다 — 그 뒤 PUSH_TOKEN은 평소처럼 등록·답장한다", async () => {
    const { bridge, bodies, posted } = await registeredBridge();
    h.signOut.mockImplementationOnce(async () => { throw new Error("network"); });
    await expect(bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" })).rejects.toThrow(/network/);
    bodies.length = 0;
    posted.length = 0;
    await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify(PUSH))!, "u-guardian");
    // 🔒 표시가 남으면 로그인한 채로 이 휴대폰 등록이 영영 갱신되지 않는다
    expect(bodies.map((b) => b.method)).toEqual(["POST"]);
    expect(posted).toEqual([{ type: "PUSH_REGISTERED" }]);
  });

  it("signOut이 실패하면 — 등록을 되살리고 앱에 토큰을 다시 묻는다, LOGOUT·이동은 없다(로그인 상태로 알림이 끊기면 안 된다)", async () => {
    const { bridge, bodies, posted } = await registeredBridge();
    h.signOut.mockImplementationOnce(async () => { h.log.push("signOut"); throw new Error("network"); });
    await expect(bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" })).rejects.toThrow(/network/);
    // 🔒 해제(DELETE)가 등록을 지웠다 — 되살리지 않으면 로그인한 채 실명 사본이 빠진다. REQUEST_PUSH_TOKEN은 되살리기가
    //    실패했어도 앱이 다시 보고(등록 재시도)·토픽 재구독(멱등)하게 한다
    expect(h.log).toEqual(["DELETE /api/push/device", "signOut", "POST /api/push/device", "native:REQUEST_PUSH_TOKEN"]);
    expect(bodies[1]).toEqual({ method: "POST", body: DEVICE_BODY });
    expect(posted).toEqual([{ type: "REQUEST_PUSH_TOKEN" }]);
  });

  it("signOut도 되살리기도 실패하면 앱에 등록 실패를 알리고, 그래도 토큰은 다시 묻는다(앱이 토픽을 다시 구독)", async () => {
    const { bridge, posted } = await registeredBridge((m) => {
      if (m === "POST") throw new TypeError("Failed to fetch");
      return new Response("{}", { status: 200 });
    });
    h.signOut.mockImplementationOnce(async () => { throw new Error("network"); });
    await expect(bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" })).rejects.toThrow(/network/);
    expect(posted).toEqual([{ type: "PUSH_REGISTER_FAILED", reason: "network" }, { type: "REQUEST_PUSH_TOKEN" }]);
  });

  it("등록된 휴대폰을 모르는 페이지(구버전 앱 등)도 실패하면 토큰을 다시 묻는다 — 되살릴 등록은 없다", async () => {
    const { posted } = installAppWindow();
    const { fetchMock } = stubFetch();
    const bridge = await freshBridge();
    h.signOut.mockImplementationOnce(async () => { throw new Error("network"); });
    await expect(bridge.logoutAndNotifyNative({ userId: "u1", redirectTo: "/login" })).rejects.toThrow(/network/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: "REQUEST_PUSH_TOKEN" }]);
  });

  /**
   * signOut이 resolve해도 로그아웃이 아닐 수 있다(2026-10-07 3차) — next-auth 4.24는 CSRF 토큰 요청이 실패하면(getCsrfToken
   *   null) 그대로 POST해 ".../signout?csrf=true"로 resolve하고 쿠키는 지우지 않는다. 예전엔 그걸 성공으로 보고 LOGOUT을
   *   보내, 로그인한 채로 이 휴대폰의 구독·등록이 끊겼다.
   */
  it.each([
    ["csrf=true(쿠키를 못 지움)", { url: "https://maeum.example/api/auth/signout?csrf=true" }],
    ["응답에 주소가 없음", {}],
    ["응답 자체가 없음", undefined],
  ])("signOut이 %s로 끝나면 로그아웃 실패 — 등록을 되살리고 토큰을 다시 묻고, LOGOUT·이동 없이 reject", async (_, result) => {
    const { bridge, bodies, posted } = await registeredBridge();
    h.signOut.mockImplementationOnce(async () => { h.log.push("signOut"); return result; });
    await expect(bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" })).rejects.toThrow("signout-unconfirmed");
    expect(h.log).toEqual(["DELETE /api/push/device", "signOut", "POST /api/push/device", "native:REQUEST_PUSH_TOKEN"]);
    expect(bodies[1]).toEqual({ method: "POST", body: DEVICE_BODY });
    // 🔒 LOGOUT이 가면 앱이 구독을 끊고 토큰을 폐기한다 — 웹은 여전히 로그인 상태인데 이 휴대폰 알림이 조용히 끊긴다
    expect(posted).toEqual([{ type: "REQUEST_PUSH_TOKEN" }]);
  });

  it("signOut 응답은 정상이어도 세션이 남아 있으면(사용자 있음) 로그아웃 실패 — 같은 되살리기", async () => {
    const { bridge, bodies, posted } = await registeredBridge();
    h.getSession.mockResolvedValueOnce(SIGNED_IN);
    await expect(bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" })).rejects.toThrow("signout-unconfirmed");
    expect(h.getSession).toHaveBeenCalledTimes(1);
    expect(h.log).toEqual(["DELETE /api/push/device", "signOut", "POST /api/push/device", "native:REQUEST_PUSH_TOKEN"]);
    expect(bodies[1]).toEqual({ method: "POST", body: DEVICE_BODY });
    expect(posted).toEqual([{ type: "REQUEST_PUSH_TOKEN" }]);
  });

  it("세션 재확인에서 사용자가 없으면 그때만 LOGOUT — 확인은 signOut 뒤에 한다", async () => {
    const { bridge } = await registeredBridge();
    h.getSession.mockImplementationOnce(async () => { h.log.push("getSession"); return null; });
    await bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" });
    expect(h.log).toEqual(["DELETE /api/push/device", "signOut", "getSession", "native:LOGOUT", "assign:/login"]);
  });

  it("등록 요청 둘이 도는 중에 로그아웃 — **둘 다** 끝난 뒤에야 해제한다(나중 것만 기다리면 앞 것이 해제를 덮는다)", async () => {
    installAppWindow();
    const releases: (() => void)[] = [];
    const { bodies } = stubFetch((m) => m === "POST"
      ? new Promise<Response>((resolve) => { releases.push(() => resolve(new Response("{}", { status: 200 }))); })
      : new Response("{}", { status: 200 }));
    const bridge = await freshBridge();
    const msg = parseNativePushToken(JSON.stringify(PUSH))!;
    const first = bridge.relayNativePushToken(msg, "u-guardian");
    const second = bridge.relayNativePushToken({ ...msg, permission: "denied" }, "u-guardian");
    await vi.waitFor(() => expect(bodies.map((b) => b.method)).toEqual(["POST", "POST"]));
    const out = bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" });
    releases[1]();   // 나중 요청이 먼저 끝난다 — 예전엔 이것 하나만 기다렸다
    await new Promise((r) => setTimeout(r, 30));
    // 🔒 앞 요청이 아직 도는데 해제가 나가면, 해제보다 늦게 도착한 앞 요청이 로그아웃한 휴대폰의 등록을 되살린다
    expect(bodies.map((b) => b.method)).toEqual(["POST", "POST"]);
    releases[0]();
    await Promise.all([first, second, out]);
    expect(h.log).toEqual(["POST /api/push/device", "POST /api/push/device", "DELETE /api/push/device", "signOut", "native:LOGOUT", "assign:/login"]);
  });

  it("되살리기(POST)가 도는 중에 다시 누른 로그아웃은 새로 돌지 않고 그 로그아웃을 함께 기다린다 — 해제가 되살리기를 앞지르지 않는다", async () => {
    let posts = 0;
    let releaseRestore!: () => void;
    const { bridge, bodies } = await registeredBridge((m) => {
      if (m !== "POST" || ++posts === 1) return new Response("{}", { status: 200 });   // 첫 POST = 처음 등록
      return new Promise<Response>((resolve) => { releaseRestore = () => resolve(new Response("{}", { status: 200 })); });
    });
    h.signOut.mockImplementationOnce(async () => { throw new Error("network"); });
    const failed = bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" });
    await vi.waitFor(() => expect(bodies.map((b) => b.method)).toEqual(["DELETE", "POST"]));   // 되살리기가 도는 중
    const again = bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" });
    // 🔒 같은 로그아웃이다 — 두 번째 해제가 되살리기보다 먼저 도착하면 로그인한 채 등록이 지워진다
    expect(again).toBe(failed);
    await new Promise((r) => setTimeout(r, 30));
    expect(bodies.map((b) => b.method)).toEqual(["DELETE", "POST"]);
    releaseRestore();
    await expect(failed).rejects.toThrow(/network/);
    await expect(again).rejects.toThrow(/network/);
    expect(h.signOut).toHaveBeenCalledTimes(1);
    // 끝난 뒤에 다시 누르면 새로 돈다(이번엔 로그아웃이 확인된다)
    await bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" });
    expect(bodies.map((b) => b.method)).toEqual(["DELETE", "POST", "DELETE"]);
    expect(h.signOut).toHaveBeenCalledTimes(2);
  });

  /**
   * 로그아웃은 하나만 돈다(2026-10-07 4차) — 응답이 느린 순간 버튼을 다시 누르기 쉽다. 예전엔 누를 때마다 해제·signOut·LOGOUT·
   *   이동이 따로 돌아, 앱에 LOGOUT이 두 번 가거나 한쪽이 되살린 등록을 다른 쪽 해제가 덮을 수 있었다.
   */
  it("연달아 누른 로그아웃은 같은 프라미스 — 해제·signOut·LOGOUT·이동이 한 번씩", async () => {
    let releaseDelete!: () => void;
    const { bridge, posted } = await registeredBridge((m) => m === "DELETE"
      ? new Promise<Response>((resolve) => { releaseDelete = () => resolve(new Response("{}", { status: 200 })); })
      : new Response("{}", { status: 200 }));
    const first = bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" });
    await vi.waitFor(() => expect(h.log).toEqual(["DELETE /api/push/device"]));
    const second = bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" });
    expect(second).toBe(first);
    releaseDelete();
    await Promise.all([first, second]);
    // 🔒 둘이 따로 돌면 DELETE·signOut·LOGOUT·이동이 두 번씩이다
    expect(h.log).toEqual(["DELETE /api/push/device", "signOut", "native:LOGOUT", "assign:/login"]);
    expect(posted).toEqual([{ type: "LOGOUT", userId: "u-guardian" }]);
  });
});

/**
 * "이 휴대폰" handle(2026-10-07) — 보호자 화면이 목록에서 지금 들고 있는 휴대폰을 표시하는 값.
 *   서버(lib/push/devices deviceHandle, node:crypto)와 앱 안 화면(crypto.subtle)이 같은 규칙이어야 한다.
 */
describe("이 휴대폰 handle — 서버와 같은 규칙, 토큰은 화면에 내보내지 않는다", () => {
  it("PUSH_TOKEN을 받기 전엔 null, 받은 뒤엔 서버 deviceHandle과 같다", async () => {
    installAppWindow();
    stubFetch();
    const bridge = await freshBridge();
    expect(await bridge.thisPhoneHandle()).toBeNull();
    await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify(PUSH))!, "u-guardian");
    const { deviceHandle } = await import("@/lib/push/devices");
    // 🔒 규칙이 갈리면 목록의 "이 휴대폰" 표시가 사라지거나 엉뚱한 휴대폰에 붙는다
    expect(await bridge.thisPhoneHandle()).toBe(deviceHandle(TOKEN));
  });

  it("crypto.subtle이 없으면(비보안 출처 등) 조용히 null — 표시만 빠진다", async () => {
    installAppWindow();
    stubFetch();
    const bridge = await freshBridge();
    await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify(PUSH))!, "u-guardian");
    vi.stubGlobal("crypto", {});
    await expect(bridge.thisPhoneHandle()).resolves.toBeNull();
  });

  it("로그아웃한 뒤엔 null — 이전 계정의 휴대폰 표시가 남지 않게", async () => {
    installAppWindow();
    stubFetch();
    const bridge = await freshBridge();
    await bridge.relayNativePushToken(parseNativePushToken(JSON.stringify(PUSH))!, "u-guardian");
    await bridge.logoutAndNotifyNative({ userId: "u-guardian", redirectTo: "/login" });
    expect(await bridge.thisPhoneHandle()).toBeNull();
  });
});

describe("모든 로그아웃 버튼은 한 헬퍼만 쓴다", () => {
  /** app 아래 모든 .tsx — 고정 목록이면 새 로그아웃 버튼이 생겼을 때 검사를 빠져나간다(재검토 지적) */
  const tsxFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? tsxFiles(join(dir, d.name)) : d.name.endsWith(".tsx") ? [join(dir, d.name).replace(/\\/g, "/")] : []);
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");   // 주석 제외
  const files = tsxFiles("app").map((f) => ({ f, src: code(readFileSync(f, "utf-8")) }));

  /** 로그아웃 한 번의 몸통(runLogout) — 내보낸 헬퍼(logoutAndNotifyNative)는 그것을 하나만 돌린다(4차) */
  const logoutBody = (src: string) => {
    const start = src.indexOf("async function runLogout(");
    return { start, end: src.indexOf("\nexport ", start + 1) };
  };

  it("signOut은 RnBridge의 로그아웃 몸통(runLogout) 안에서만, 한 번 부른다 — 헬퍼는 그 몸통만 부른다", () => {
    // 🔒 헬퍼를 거치지 않는 로그아웃은 기기 등록을 남겨 — 로그아웃한 휴대폰이 그 계정의 위급 알림(실명)을 계속 받는다
    expect(files.filter((x) => /\bsignOut\(/.test(x.src)).map((x) => x.f)).toEqual(["app/RnBridge.tsx"]);
    const src = files.find((x) => x.f === "app/RnBridge.tsx")!.src;
    const { start, end } = logoutBody(src);
    expect(start).toBeGreaterThan(-1);
    const calls = [...src.matchAll(/\bsignOut\(/g)].map((m) => m.index!);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThan(start);
    expect(calls[0]).toBeLessThan(end);
    expect([...src.matchAll(/\brunLogout\(/g)]).toHaveLength(2);   // 정의 + 헬퍼의 한 번
  });

  it("헬퍼 안의 순서: 해제 → signOut → LOGOUT → 이동", () => {
    const src = files.find((x) => x.f === "app/RnBridge.tsx")!.src;
    const { start, end } = logoutBody(src);
    const helper = src.slice(start, end);
    const at = (s: string) => helper.indexOf(s);
    expect(at("deleteDeviceRegistration(")).toBeGreaterThan(-1);
    expect(at("deleteDeviceRegistration(")).toBeLessThan(at("signOut("));
    expect(at("signOut(")).toBeLessThan(at("notifyNativeLogout("));
    expect(at("notifyNativeLogout(")).toBeLessThan(at("window.location.assign("));
  });

  it.each(["app/LogoutButton.tsx", "app/chat/page.tsx", "app/consent/page.tsx"])("%s — 헬퍼를 계정 id와 함께 부르고, 실패하면 안내 창", (f) => {
    expect(files.find((x) => x.f === f)!.src).toMatch(
      /logoutAndNotifyNative\(\{ userId: session\?\.user\?\.id, redirectTo: "\/login" \}\)\.catch\(\(\) => window\.alert\(LOGOUT_FAILED_ALERT\)\)/,
    );
  });

  it("헬퍼를 부르는 곳은 위 셋뿐이고, 부르는 자리마다 실패 안내가 붙어 있다", () => {
    // 🔒 안내 없이 부르면 로그아웃이 확인되지 않았을 때(reject) 버튼이 아무 반응 없이 끝나 — 사용자는 로그아웃된 줄 안다
    const callers = files.filter((x) => x.f !== "app/RnBridge.tsx" && /logoutAndNotifyNative\(/.test(x.src));
    expect(callers.map((x) => x.f).sort()).toEqual(["app/LogoutButton.tsx", "app/chat/page.tsx", "app/consent/page.tsx"]);
    for (const { f, src } of callers) {
      const calls = src.match(/logoutAndNotifyNative\(/g)!.length;
      const handled = src.match(/logoutAndNotifyNative\([^)]*\)\.catch\(\(\) => window\.alert\(LOGOUT_FAILED_ALERT\)\)/g)?.length ?? 0;
      expect(handled, f).toBe(calls);
    }
  });

  it("LOGOUT 신호(notifyNativeLogout)를 직접 부르는 화면이 없다", () => {
    expect(files.filter((x) => /notifyNativeLogout\(/.test(x.src)).map((x) => x.f)).toEqual(["app/RnBridge.tsx"]);
  });

  it("RnBridge 컴포넌트는 세션 상태로 로그아웃 신호를 만들지 않는다(어떤 따옴표·헬퍼로도)", () => {
    const src = files.find((x) => x.f === "app/RnBridge.tsx")!.src;
    const component = src.slice(src.indexOf("export function RnBridge"));
    // 🔒 "세션이 끊겨 보이면 구독도 끊자"로 되돌리면 한 번의 세션 조회 실패로 보호자 알림이 다시 조용히 끊긴다
    expect(component).not.toMatch(/notifyNativeLogout\(/);
    expect(component).not.toMatch(/LOGOUT/);
    // 끊겨 보일 땐 기억만 지운다 — 세션이 돌아오면 같은 계정이어도 LOGIN_SUCCESS를 다시 보내 앱이 재구독하게
    expect(component).toMatch(/status === "unauthenticated"\) \{ lastSentRef\.current = null; return; \}/);
  });

  it("PUSH_TOKEN 리스너는 앱이 넣은 메시지인지 먼저 확인한다", () => {
    const src = files.find((x) => x.f === "app/RnBridge.tsx")!.src;
    const component = src.slice(src.indexOf("export function RnBridge"));
    expect(component).toMatch(/if \(!isFromNativeApp\(e, window\)\) return;\s*const msg = parseNativePushToken\(e\.data\);/);
  });
});

/**
 * 공통 로그아웃 버튼(app/LogoutButton — 마이페이지·보호자 화면 등 대부분이 이걸 쓴다)을 실제로 눌러 본다(2026-10-07 3차).
 *   컴포넌트를 함수로 불러 button 요소를 받고, 그 onClick을 부른다(렌더러 없이 — useSession만 목).
 */
describe("로그아웃 버튼 — 로그아웃이 확인되지 않으면 안내 창", () => {
  async function pressLogoutButton() {
    const app = installAppWindow();
    const alert = vi.fn<(msg: string) => void>();
    Object.assign(app.win, { alert });
    stubFetch();
    const bridge = await freshBridge();
    const { LogoutButton } = await import("@/app/LogoutButton");
    const button = LogoutButton({}) as unknown as { props: { onClick: () => Promise<void> } };
    // 버튼 밖으로 새 나온 실패(reject)는 따로 받아 둔다 — 안내 창 단언이 그 이유로 실패하게(테스트가 throw로 끝나지 않게)
    let escaped: unknown;
    await button.props.onClick().catch((e: unknown) => { escaped = e; });
    return { ...app, alert, bridge, escaped };
  }

  it("csrf=true로 끝나면 정해진 문구로 window.alert — LOGOUT·이동은 없다", async () => {
    h.signOut.mockImplementationOnce(async () => ({ url: "https://maeum.example/api/auth/signout?csrf=true" }));
    const { alert, posted, bridge, escaped } = await pressLogoutButton();
    // 🔒 안내가 없으면 버튼이 아무 반응 없이 끝나 — 사용자는 로그아웃된 줄 알고 휴대폰을 넘긴다
    expect(alert).toHaveBeenCalledTimes(1);
    expect(escaped).toBeUndefined();   // 실패는 버튼이 받아 안내로 바꾼다(처리되지 않은 reject로 새지 않는다)
    expect(alert).toHaveBeenCalledWith("로그아웃하지 못했어요. 인터넷 연결을 확인한 뒤 다시 눌러 주세요.");
    expect(bridge.LOGOUT_FAILED_ALERT).toBe("로그아웃하지 못했어요. 인터넷 연결을 확인한 뒤 다시 눌러 주세요.");
    expect(posted).toEqual([{ type: "REQUEST_PUSH_TOKEN" }]);
    expect(h.log).not.toContain("assign:/login");
  });

  it("로그아웃이 확인되면 안내 창 없이 LOGOUT → 이동", async () => {
    const { alert, posted, escaped } = await pressLogoutButton();
    expect(escaped).toBeUndefined();
    expect(alert).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: "LOGOUT", userId: "u-guardian" }]);
    expect(h.log).toContain("assign:/login");
  });
});
