/**
 * 보호자 화면 "위급 알림을 받는 휴대폰"(app/expert/PushStatusBox) — 화면 조각과 삭제 흐름(2026-10-07).
 *   · 휴대폰마다 한 줄 + "삭제"(확인 창 → DELETE { handle }) — 토큰은 화면에 없다
 *   · 0대: 스위치를 켜기 전(1.2.0 프로덕션 단계적 출시가 100%가 되기 전)엔 중립 안내 — 1.0.3 사용자에게 "휴대폰 없음·업데이트"를 띄우지 않는다.
 *     (3차) 브라우저는 "앱에 로그인해 둔 휴대폰은 지금 앱으로도 받는다", 1.2.0 앱 안은 이 휴대폰의 마지막 등록 상태
 *     (확인 중 / 등록 못 함 + 사유 + 다시 시도)
 *     (10차) 1.2.0 앱 안은 스위치가 켜져도 그 등록 상태가 먼저(경고는 브라우저·구버전 앱만), "이 휴대폰"을 지우면 "지웠어요"
 *   · 1.2.0 이전 앱 안: "수신 확인 미지원"만 — 묻지도, 설정 버튼도 없다
 * 렌더링: react-dom/server로 그린다(효과는 돌지 않는다 — 효과가 부르는 RnBridge 함수는 rn-bridge.test.ts가 행위로 고정).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type Box = typeof import("@/app/expert/PushStatusBox");

/** 스위치(NEXT_PUBLIC_APP_ON_PLAY)를 정하고 모듈을 새로 읽는다 — 빌드 타임 값이라 읽을 때 정해진다 */
async function load(flag?: string): Promise<Box> {
  vi.stubEnv("NEXT_PUBLIC_APP_ON_PLAY", flag);
  vi.resetModules();
  return import("@/app/expert/PushStatusBox");
}
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");

const ROW = (handle: string, over: Partial<{ permission: string; channelBlocked: boolean; appVersion: string | null }> = {}) => ({
  handle, platform: "android", appVersion: "1.2.0", permission: "granted", channelBlocked: false,
  updatedAt: "2026-10-07T03:12:00.000Z", ...over,
});
const H1 = "0123456789abcdef";
const H2 = "fedcba9876543210";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete (globalThis as { window?: unknown }).window;
});

describe("어디서 열렸나(appKindOf)", () => {
  it.each([
    [{}, "browser"],
    [{ ReactNativeWebView: {} }, "old-app"],                              // 버전 주입 전 앱
    [{ ReactNativeWebView: {}, MAEUM_APP_VERSION: "1.0.3" }, "old-app"],
    [{ ReactNativeWebView: {}, MAEUM_APP_VERSION: "1.1.0" }, "old-app"],
    [{ ReactNativeWebView: {}, MAEUM_APP_VERSION: 120 }, "old-app"],
    [{ ReactNativeWebView: {}, MAEUM_APP_VERSION: "1.2.0" }, "app"],
    [{ ReactNativeWebView: {}, MAEUM_APP_VERSION: "1.10.0" }, "app"],
  ])("%j → %s", async (w, kind) => {
    const { appKindOf } = await load();
    expect(appKindOf(w)).toBe(kind);
  });
});

type Phone = { permission: "granted" | "denied" | "unknown"; channelBlocked: boolean; registered: boolean; reason?: string };
type Kind = "browser" | "old-app" | "app";

describe("계정 휴대폰 목록(AccountDevices)", () => {
  const props = (
    devices: ReturnType<typeof ROW>[],
    over: Partial<{ thisHandle: string | null; app: Kind; phone: Phone | null; busy: string | null; noAnswer: boolean; deletedHere: boolean }> = {},
  ) => ({
    devices, thisHandle: null, app: "browser" as Kind, phone: null as Phone | null, busy: null, onDelete: () => {}, ...over,
  });

  it("휴대폰마다 한 줄 + 삭제 버튼, 지금 들고 있는 휴대폰은 '이 휴대폰'", async () => {
    const { AccountDevices } = await load();
    const out = html(createElement(AccountDevices, props([ROW(H1), ROW(H2, { permission: "denied", appVersion: null })], { thisHandle: H2 })));
    expect(out).toContain("📱 이 계정으로 위급 알림을 받는 휴대폰: <b>1대</b>");
    expect(out.match(/<li/g)).toHaveLength(2);
    expect(out.match(/>삭제<\/button>/g)).toHaveLength(2);
    expect(out.match(/이 휴대폰 · /g)).toHaveLength(1);
    // "이 휴대폰"은 handle이 같은 줄(두 번째 — 알림 꺼짐)에만
    const [first, second] = out.split("<li").slice(1);
    expect(first).not.toContain("이 휴대폰");
    expect(second).toContain("이 휴대폰 · ");
    expect(first).toContain("안드로이드 · 앱 v1.2.0 · 알림 켜짐");
    expect(second).toContain("안드로이드 · 알림 꺼짐");
  });

  it("삭제 중이면 모든 삭제 버튼을 막고 그 줄에 '삭제 중…'", async () => {
    const { AccountDevices } = await load();
    const out = html(createElement(AccountDevices, props([ROW(H1), ROW(H2)], { busy: H1 })));
    expect(out.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(out).toContain("삭제 중…");
  });

  it("모두 꺼졌으면 켜는 방법을 안내한다", async () => {
    const { AccountDevices } = await load();
    const out = html(createElement(AccountDevices, props([ROW(H1, { channelBlocked: true })])));
    expect(out).toContain("⚠ 이 계정에 등록된 휴대폰 1대가 모두 위급 알림이 꺼져 있어요");
  });

  const BROWSER_COPY = "안드로이드 앱에 이 계정으로 로그인해 둔 휴대폰은 지금 앱으로도 위급 알림을 받습니다. 휴대폰별 수신 확인은 새 앱(1.2.0)부터 표시돼요.";
  // (10차) 앱이 답하는 최악(11차부터 약 55초)을 기다리는 동안이라 "잠시 기다려 주세요"까지
  const PENDING_COPY = "이 휴대폰 등록을 확인하는 중이에요. 잠시 기다려 주세요.";
  const WARN_COPY = "⚠ 아직 알림을 받을 휴대폰이 없어요 — 안드로이드 마음이음 앱에서 이 계정으로 로그인해 주세요.";
  const DELETED_COPY = "이 휴대폰을 목록에서 지웠어요. 앱을 다시 열면 다시 등록돼요.";

  it("스위치 꺼짐 + 브라우저: 0대는 중립 안내 — '휴대폰 없음·업데이트' 경고를 띄우지 않는다", async () => {
    const { AccountDevices } = await load(undefined);
    const out = html(createElement(AccountDevices, props([])));
    expect(out).toContain(BROWSER_COPY);
    // 🔒 스위치를 켜기 전(1.2.0 단계적 출시 100% 전)엔 1.0.3 보호자가 다 0대다 — 경고하면 받는 사람을 못 받는 사람으로 보이게 한다
    expect(out).not.toContain("아직 알림을 받을 휴대폰이 없어요");
    expect(out).not.toContain("업데이트");
    expect(out).not.toContain(PENDING_COPY);
  });

  it("스위치 꺼짐 + 1.2.0 이전 앱 안: 0대 안내는 생략(아래 '수신 확인 미지원'이 같은 말)", async () => {
    const { AccountDevices } = await load(undefined);
    expect(html(createElement(AccountDevices, props([], { app: "old-app" })))).toBe("");
  });

  it("스위치 꺼짐 + 1.2.0 앱 안 + 0대: 브라우저 안내 대신 이 휴대폰의 등록 상태 — 답이 오기 전엔 '확인하는 중'", async () => {
    const { AccountDevices } = await load(undefined);
    const out = html(createElement(AccountDevices, props([], { app: "app", phone: null })));
    // 🔒 등록을 아는 앱인데 "지금 앱으로도 받습니다"라고만 하면 이 휴대폰 등록이 빠진 걸 아무도 모른다
    expect(out).toContain(PENDING_COPY);
    expect(out).not.toContain(BROWSER_COPY);
    expect(out).not.toContain("<button");
    // 등록됐다는 답인데 목록이 아직 0대 = 목록을 다시 읽는 중 — 실패로 보이지 않게 확인 중으로 둔다
    const registered = html(createElement(AccountDevices, props([], { app: "app", phone: { permission: "granted", channelBlocked: false, registered: true } })));
    expect(registered).toContain(PENDING_COPY);
    expect(registered).not.toContain("등록하지 못했어요");
  });

  it("스위치 꺼짐 + 1.2.0 앱 안 + 0대 + 등록 실패 보고: 한국어 사유와 '다시 시도' — 코드는 보이지 않는다", async () => {
    const { AccountDevices } = await load(undefined);
    const failed: Phone = { permission: "granted", channelBlocked: false, registered: false, reason: "not-ready" };
    const out = html(createElement(AccountDevices, props([], { app: "app", phone: failed })));
    expect(out).toContain("이 휴대폰을 알림 받을 기기로 등록하지 못했어요");
    // 🔒 "(not-ready)" 같은 코드는 보호자가 읽을 수 없다(4차)
    expect(out).toContain("서버 준비 중이에요. 잠시 후 다시 시도해 주세요.");
    expect(out).not.toContain("not-ready");
    expect(out).toContain(">다시 시도</button>");
    expect(out).not.toContain(PENDING_COPY);
    expect(out).not.toContain(BROWSER_COPY);
  });

  it.each([
    ["not-ready", "서버 준비 중이에요. 잠시 후 다시 시도해 주세요."],
    ["network", "인터넷 연결을 확인해 주세요."],
    ["http-429", "요청이 많아요. 잠시 후 다시 시도해 주세요."],
    ["not-logged-in", "로그인 상태를 확인해 주세요."],
    // 10차 — 앱이 토큰을 못 받음(앱이 알려 준 까닭이 ":" 뒤에 붙어도 같은 문구 — 코드는 보이지 않는다)·계정 불일치·로그인 만료
    ["no-token", "휴대폰이 알림 토큰을 받지 못했어요 — 인터넷·Google Play 서비스를 확인해 주세요"],
    ["no-token:SERVICE_NOT_AVAILABLE", "휴대폰이 알림 토큰을 받지 못했어요 — 인터넷·Google Play 서비스를 확인해 주세요"],
    // 11차 — 이름공간이 붙은 FCM 오류 코드("/" 포함 — RnBridge NATIVE_ERROR_RE)도 같은 문구, 코드는 보이지 않는다
    ["no-token:messaging/unknown", "휴대폰이 알림 토큰을 받지 못했어요 — 인터넷·Google Play 서비스를 확인해 주세요"],
    ["account-mismatch", "다른 계정 정보로 등록하려 했어요 — 앱을 다시 열어 주세요"],
    ["http-401", "로그인이 만료됐어요 — 다시 로그인해 주세요"],
    ["http-500", "알 수 없는 오류예요 (http-500)"],
    ["weird:SERVICE_NOT_AVAILABLE", "알 수 없는 오류예요 (weird:SERVICE_NOT_AVAILABLE)"],   // 모르는 사유는 붙은 코드까지 그대로
    ["constructor", "알 수 없는 오류예요 (constructor)"],   // 객체 기본 속성 이름이어도 모르는 사유다
    [undefined, "알 수 없는 오류예요 (unknown)"],
  ])("등록 실패 사유 %j → %j", async (reason, text) => {
    const { registerFailureText } = await load(undefined);
    expect(registerFailureText(reason)).toBe(text);
  });

  it("확인 중 문구와 상한(11차) — 앱이 답하는 최악(준비 12초 + 폐기 확인 getToken 12초 + 토큰 폐기 12초 + 새 토큰 12초 = 48초)보다 길게 55초", async () => {
    const { APP_ANSWER_TIMEOUT_MS, CHECKING_TEXT, DELETED_HERE_TEXT } = await load(undefined);
    // 🔒 짧으면(예전 10초, 10차 40초 — 폐기 확인 getToken을 빼고 셌다) 계정을 바꾸는 앱이 제 할 일을 하는 동안에도 "앱이 응답하지 않아요"가 뜬다
    expect(APP_ANSWER_TIMEOUT_MS).toBe(55_000);
    expect(APP_ANSWER_TIMEOUT_MS).toBeGreaterThan(12_000 * 4);
    expect(CHECKING_TEXT).toBe(PENDING_COPY);
    expect(DELETED_HERE_TEXT).toBe(DELETED_COPY);
  });

  it("확인 중이 상한을 넘겼으면(noAnswer): '앱이 응답하지 않아요' + '다시 시도' — 등록 실패 보고가 있으면 그쪽이 먼저", async () => {
    const { AccountDevices } = await load(undefined);
    const out = html(createElement(AccountDevices, props([], { app: "app", phone: null, noAnswer: true })));
    expect(out).toContain("앱이 응답하지 않아요. 앱을 다시 열어 주세요.");
    expect(out).toContain(">다시 시도</button>");
    expect(out).not.toContain(PENDING_COPY);
    const failed: Phone = { permission: "granted", channelBlocked: false, registered: false, reason: "network" };
    const both = html(createElement(AccountDevices, props([], { app: "app", phone: failed, noAnswer: true })));
    expect(both).toContain("인터넷 연결을 확인해 주세요.");
    expect(both).not.toContain("앱이 응답하지 않아요");
  });

  it("'다시 시도'를 누르면 앱에 PUSH_TOKEN을 다시 요청하고(REQUEST_PUSH_TOKEN) 화면에 알린다(onRetry — 확인 중 시간을 새로 잰다)", async () => {
    // 11차 — 그 상자는 ThisPhoneRegistration(0대일 때 NoDevices도, 다른 휴대폰만 목록에 있을 때 AccountDevices도 이걸 그린다)
    const { ThisPhoneRegistration } = await load(undefined);
    const posted: unknown[] = [];
    (globalThis as { window?: unknown }).window = { ReactNativeWebView: { postMessage: (m: string) => posted.push(JSON.parse(m)) } };
    const onRetry = vi.fn();
    for (const el of [
      ThisPhoneRegistration({ phone: { permission: "granted", channelBlocked: false, registered: false, reason: "network" }, onRetry }),
      ThisPhoneRegistration({ phone: null, noAnswer: true, onRetry }),
    ]) {
      const button = (el as { props: { children: { type?: unknown; props: { onClick?: () => void } }[] } }).props.children
        .find((c) => c.type === "button");
      expect(button).toBeDefined();
      button!.props.onClick!();
    }
    // 🔒 버튼이 아무것도 보내지 않으면 등록 실패를 본 보호자가 할 수 있는 게 없다
    expect(posted).toEqual([{ type: "REQUEST_PUSH_TOKEN" }, { type: "REQUEST_PUSH_TOKEN" }]);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("스위치 켜짐 + 브라우저·1.2.0 이전 앱: 0대는 경고 + 업데이트 안내(등록 상태 안내 없이)", async () => {
    const { AccountDevices } = await load("1");
    for (const over of [{ app: "browser" as Kind }, { app: "old-app" as Kind }]) {
      const out = html(createElement(AccountDevices, props([], over)));
      expect(out).toContain(WARN_COPY);
      expect(out).toContain("이미 로그인해 두셨다면 앱을 최신 버전으로 업데이트해 주세요");
      expect(out).not.toContain("새 앱(1.2.0)부터");
      expect(out).not.toContain(PENDING_COPY);
      expect(out).not.toContain("등록하지 못했어요");
    }
  });

  /**
   * 1.2.0 앱 안이면 스위치가 켜져도 이 휴대폰의 등록 상태가 먼저다(2026-10-08 10차). 예전엔 켜지면 앱 안에서도 "앱에서 로그인·업데이트해
   *   주세요"만 떠 — 이미 그 앱에 로그인해 있는 보호자는 할 게 없었고, 등록이 왜 빠졌는지(실패 사유·응답 없음)가 가려졌다.
   */
  it("스위치 켜짐 + 1.2.0 앱 안 + 0대: 경고 대신 이 휴대폰의 등록 상태 — 확인 중 / 실패 사유 + 다시 시도 / 응답 없음 + 다시 시도", async () => {
    const { AccountDevices } = await load("1");
    const pending = html(createElement(AccountDevices, props([], { app: "app" })));
    expect(pending).toContain(PENDING_COPY);
    // 🔒 앱 안에서 "앱에 로그인해 주세요"는 할 수 없는 안내다 — 경고·업데이트 안내가 이 휴대폰 상태를 가리면 안 된다
    expect(pending).not.toContain(WARN_COPY);
    expect(pending).not.toContain("업데이트해 주세요");
    const failed: Phone = { permission: "granted", channelBlocked: false, registered: false, reason: "no-token:SERVICE_NOT_AVAILABLE" };
    const fail = html(createElement(AccountDevices, props([], { app: "app", phone: failed })));
    expect(fail).toContain("이 휴대폰을 알림 받을 기기로 등록하지 못했어요");
    expect(fail).toContain("휴대폰이 알림 토큰을 받지 못했어요 — 인터넷·Google Play 서비스를 확인해 주세요");
    expect(fail).not.toContain("SERVICE_NOT_AVAILABLE");
    expect(fail).toContain(">다시 시도</button>");
    expect(fail).not.toContain(WARN_COPY);
    const silent = html(createElement(AccountDevices, props([], { app: "app", noAnswer: true })));
    expect(silent).toContain("앱이 응답하지 않아요. 앱을 다시 열어 주세요.");
    expect(silent).toContain(">다시 시도</button>");
    expect(silent).not.toContain(WARN_COPY);
  });

  /**
   * 목록에서 "이 휴대폰"을 지웠다(2026-10-08 10차) — 지운 것은 보호자의 뜻이라 장애가 아니다. 예전엔 0대가 되면 확인 중 → 시간 상한 →
   *   "앱이 응답하지 않아요" + 다시 시도로 흘러 방금 지운 걸 고장처럼 보였다. 시간 상한 없음은 push-status-box-timer.test.ts가 돌려 본다.
   */
  it.each([[undefined], ["1"]])("스위치 %s + 1.2.0 앱 안 + 0대 + '이 휴대폰'을 지움: '지웠어요'만 — 확인 중·실패·응답 없음·다시 시도 없음", async (flag) => {
    const { AccountDevices } = await load(flag);
    const failed: Phone = { permission: "granted", channelBlocked: false, registered: false, reason: "network" };
    for (const over of [{}, { phone: failed }, { noAnswer: true }]) {
      const out = html(createElement(AccountDevices, props([], { app: "app", deletedHere: true, ...over })));
      expect(out).toContain(DELETED_COPY);
      expect(out).not.toContain("<button");
      expect(out).not.toContain(PENDING_COPY);
      expect(out).not.toContain("앱이 응답하지 않아요");
      expect(out).not.toContain("등록하지 못했어요");
      expect(out).not.toContain(WARN_COPY);
    }
  });

  it("'이 휴대폰'을 지우고도 다른 휴대폰이 남으면 목록 아래에 '지웠어요' — 그 줄이 (다시 등록돼) 목록에 있으면 적지 않는다", async () => {
    const { AccountDevices } = await load(undefined);
    const rest = html(createElement(AccountDevices, props([ROW(H1)], { app: "app", thisHandle: H2, deletedHere: true })));
    expect(rest).toContain("📱 이 계정으로 위급 알림을 받는 휴대폰: <b>1대</b>");
    // 🔒 남은 휴대폰 목록만 보이면 지금 들고 있는 휴대폰이 더는 실명 알림을 받지 않는다는 걸 모른다
    expect(rest).toContain(DELETED_COPY);
    const back = html(createElement(AccountDevices, props([ROW(H1), ROW(H2)], { app: "app", thisHandle: H2, deletedHere: true })));
    expect(back).toContain("이 휴대폰 · ");
    expect(back).not.toContain(DELETED_COPY);
    expect(html(createElement(AccountDevices, props([ROW(H1)], { app: "app", thisHandle: H2 })))).not.toContain(DELETED_COPY);
  });

  /**
   * 다른 휴대폰만 목록에 있고 이 휴대폰(1.2.0 앱 안)은 없다(2026-10-08 11차) — 예전엔 0대일 때만 이 휴대폰의 등록 상태를 보여 줘, 다른
   *   보호자·다른 휴대폰이 등록된 계정에선 지금 들고 있는 휴대폰의 등록이 빠져도(실패·응답 없음) 아무 표시가 없었다.
   */
  it.each([[undefined], ["1"]])("스위치 %s + 1.2.0 앱 안 + 다른 휴대폰 1대만 목록에: 목록 아래에 이 휴대폰의 확인 중 / 실패 사유 + 다시 시도 / 응답 없음 + 다시 시도(11차)", async (flag) => {
    const { AccountDevices } = await load(flag);
    const other = [ROW(H1)];
    const pending = html(createElement(AccountDevices, props(other, { app: "app", thisHandle: null })));
    expect(pending).toContain("📱 이 계정으로 위급 알림을 받는 휴대폰: <b>1대</b>");
    // 🔒 다른 휴대폰이 있다고 이 휴대폰 상태를 숨기면, 지금 들고 있는 휴대폰 등록이 빠진 걸 아무도 모른다
    expect(pending).toContain(PENDING_COPY);
    expect(pending.indexOf(PENDING_COPY)).toBeGreaterThan(pending.indexOf("</ul>"));   // 목록 아래에
    expect(pending.match(/>삭제<\/button>/g)).toHaveLength(1);
    expect(pending).not.toContain(">다시 시도</button>");
    const failed: Phone = { permission: "granted", channelBlocked: false, registered: false, reason: "network" };
    const fail = html(createElement(AccountDevices, props(other, { app: "app", thisHandle: H2, phone: failed })));
    expect(fail).toContain("이 휴대폰을 알림 받을 기기로 등록하지 못했어요");
    expect(fail).toContain("인터넷 연결을 확인해 주세요.");
    expect(fail).toContain(">다시 시도</button>");
    expect(fail).not.toContain(PENDING_COPY);
    const silent = html(createElement(AccountDevices, props(other, { app: "app", noAnswer: true })));
    expect(silent).toContain("앱이 응답하지 않아요. 앱을 다시 열어 주세요.");
    expect(silent).toContain(">다시 시도</button>");
    expect(silent).not.toContain(WARN_COPY);
  });

  it("목록에 이 휴대폰이 있거나 · 브라우저 · 1.2.0 이전 앱이면 목록 아래 상자가 없다 · 방금 지웠으면 '지웠어요'만(11차)", async () => {
    const { AccountDevices } = await load(undefined);
    const failed: Phone = { permission: "granted", channelBlocked: false, registered: false, reason: "network" };
    const NONE = [PENDING_COPY, "등록하지 못했어요", "앱이 응답하지 않아요", ">다시 시도</button>"];
    // 이 휴대폰 줄이 목록에 있다 — 등록은 돼 있다(이번 갱신의 실패는 그 줄의 '마지막 확인'으로 보인다)
    const listed = html(createElement(AccountDevices, props([ROW(H1), ROW(H2)], { app: "app", thisHandle: H2, phone: failed, noAnswer: true })));
    expect(listed).toContain("이 휴대폰 · ");
    for (const s of NONE) expect(listed, s).not.toContain(s);
    for (const app of ["browser", "old-app"] as const) {
      const out = html(createElement(AccountDevices, props([ROW(H1)], { app, phone: failed, noAnswer: true })));
      for (const s of NONE) expect(out, `${app} ${s}`).not.toContain(s);
    }
    // 방금 지운 경우는 그대로 — "지웠어요"만
    const deleted = html(createElement(AccountDevices, props([ROW(H1)], { app: "app", thisHandle: H2, deletedHere: true, phone: failed, noAnswer: true })));
    expect(deleted).toContain(DELETED_COPY);
    for (const s of NONE) expect(deleted, s).not.toContain(s);
  });
});

describe("이 휴대폰(ThisPhone)", () => {
  it("1.2.0 이전 앱: '수신 확인 미지원'만 — 설정 버튼 없음", async () => {
    const { ThisPhone } = await load();
    const out = html(createElement(ThisPhone, { app: "old-app", phone: null }));
    expect(out).toContain("이 앱 버전은 수신 확인을 지원하지 않아요 (위급 알림은 받습니다)");
    expect(out).not.toContain("<button");
  });

  it("1.2.0 앱이 꺼짐을 보고하면 '알림 설정 열기', 켜짐이면 아무것도 없다", async () => {
    const { ThisPhone } = await load();
    const off = html(createElement(ThisPhone, { app: "app", phone: { permission: "denied", channelBlocked: false, registered: true } }));
    expect(off).toContain("🔕 이 휴대폰은 위급 알림이 꺼져 있어요");
    expect(off).toContain(">알림 설정 열기</button>");
    const blocked = html(createElement(ThisPhone, { app: "app", phone: { permission: "granted", channelBlocked: true, registered: true } }));
    expect(blocked).toContain("알림 설정 열기");
    expect(html(createElement(ThisPhone, { app: "app", phone: { permission: "granted", channelBlocked: false, registered: true } }))).toBe("");
    expect(html(createElement(ThisPhone, { app: "browser", phone: null }))).toBe("");
  });
});

describe("목록의 휴대폰 삭제(deleteListedDevice)", () => {
  function setup(confirmed: boolean, respond: () => Response | Promise<Response> = () => new Response("{}", { status: 200 })) {
    const confirm = vi.fn(() => confirmed);
    (globalThis as { window?: unknown }).window = { confirm };
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => respond());
    vi.stubGlobal("fetch", fetchMock);
    return { confirm, fetchMock };
  }

  it("확인 창(정해진 문구) → DELETE { handle } — 토큰이 아니라 handle만 보낸다", async () => {
    const { deleteListedDevice, DELETE_CONFIRM } = await load();
    const { confirm, fetchMock } = setup(true);
    expect(await deleteListedDevice(H1)).toBe("deleted");
    expect(DELETE_CONFIRM).toBe("이 휴대폰으로는 더 이상 위급 알림을 보내지 않습니다. 삭제할까요?\n(그 휴대폰에서 앱을 다시 열면 다시 등록돼요)");
    expect(confirm).toHaveBeenCalledWith(DELETE_CONFIRM);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/push/device");
    expect(init?.method).toBe("DELETE");
    expect(JSON.parse(String(init?.body))).toEqual({ handle: H1 });
  });

  it("확인 창에서 취소하면 아무것도 보내지 않는다", async () => {
    const { deleteListedDevice } = await load();
    const { fetchMock } = setup(false);
    expect(await deleteListedDevice(H1)).toBe("cancelled");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["서버 오류(500)", () => new Response("{}", { status: 500 })],
    ["한도(429)", () => new Response("{}", { status: 429 })],
    // 5차 — 서버가 그 휴대폰의 토픽 구독을 끊지 못하면 행을 지우지 않고 502로 답한다(app/api/push/device DELETE { handle })
    ["토픽 해제 실패(502 topic)", () => new Response(JSON.stringify({ ok: false, reason: "topic" }), { status: 502 })],
    // 7차 — 서버가 FCM을 쓸 수 없어 끊었는지 확인할 수 없으면 행을 지우지 않고 503(같은 "다시 시도" 문구)
    ["FCM 설정 없음(503 unconfigured)", () => new Response(JSON.stringify({ ok: false, reason: "unconfigured" }), { status: 503 })],
    ["네트워크 끊김", () => { throw new TypeError("Failed to fetch"); }],
  ])("%s → failed(삭제됐다고 하지 않는다)", async (_, respond) => {
    const { deleteListedDevice } = await load();
    setup(true, respond);
    expect(await deleteListedDevice(H1)).toBe("failed");
  });
});
