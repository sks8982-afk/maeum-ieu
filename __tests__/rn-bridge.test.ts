/**
 * 웹 ↔ 앱(WebView) 브릿지 — 보호자 휴대폰의 위급 알림 구독을 **조용히 끊지 않는다**.
 *
 * 2026-10-07 보호자 앱 푸시 추적: 세션 상태가 "unauthenticated"로 보이기만 해도 LOGOUT을 보냈다.
 *   next-auth는 세션 조회가 한 번만 실패해도(앱 복귀 순간 네트워크 끊김·5xx) null 세션을 돌려주므로,
 *   그때마다 앱이 보호자 토픽(maeum_<id>) 구독을 끊었다 → 다시 로그인할 때까지 위급 알림이 안 왔다.
 *   이제 LOGOUT은 로그아웃 버튼에서만 보낸다(notifyNativeLogout).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const { bridgeMessageFor, notifyNativeLogout } = await import("@/app/RnBridge");

describe("세션 상태 → 앱 메시지", () => {
  it("세션이 끊겨 보여도(unauthenticated) 아무것도 보내지 않는다 — 구독을 끊는 LOGOUT 금지", () => {
    // 🔒 예전엔 여기서 LOGOUT을 보내 앱이 보호자 토픽 구독을 해제했다
    expect(bridgeMessageFor("unauthenticated", undefined, "u-guardian")).toBeNull();
    expect(bridgeMessageFor("unauthenticated", undefined, null)).toBeNull();
  });

  it("로딩 중에도 보내지 않는다", () => {
    expect(bridgeMessageFor("loading", "u1", null)).toBeNull();
  });

  it("로그인되면 LOGIN_SUCCESS(userId)를 한 번 보낸다 — 앱이 maeum_<userId>를 구독", () => {
    const r = bridgeMessageFor("authenticated", "u-guardian", null);
    expect(r).not.toBeNull();
    expect(JSON.parse(r!.message)).toEqual({ type: "LOGIN_SUCCESS", userId: "u-guardian" });
    expect(r!.sent).toBe("u-guardian");
    // 같은 계정이면 다시 보내지 않는다
    expect(bridgeMessageFor("authenticated", "u-guardian", "u-guardian")).toBeNull();
  });

  it("다른 계정으로 바뀌면 새 계정으로 보낸다 — 앱이 이전 구독을 새 계정으로 바꾼다", () => {
    const r = bridgeMessageFor("authenticated", "u-other", "u-guardian");
    expect(JSON.parse(r!.message)).toEqual({ type: "LOGIN_SUCCESS", userId: "u-other" });
  });
});

describe("로그아웃 버튼만 LOGOUT을 보낸다", () => {
  afterEach(() => { delete (globalThis as { window?: unknown }).window; });

  it("앱 웹뷰 안에서는 LOGOUT을 보낸다 — 계정 id를 실어 앱이 그 계정 구독을 정확히 끊게", () => {
    const postMessage = vi.fn();
    (globalThis as { window?: unknown }).window = { ReactNativeWebView: { postMessage } };
    notifyNativeLogout("u-guardian");
    expect(postMessage).toHaveBeenCalledWith(JSON.stringify({ type: "LOGOUT", userId: "u-guardian" }));
    notifyNativeLogout();
    expect(postMessage).toHaveBeenLastCalledWith(JSON.stringify({ type: "LOGOUT" }));
  });

  it("일반 브라우저(브릿지 없음)에서는 조용히 넘어간다", () => {
    (globalThis as { window?: unknown }).window = {};
    expect(() => notifyNativeLogout()).not.toThrow();
  });

  it("브릿지가 throw해도 로그아웃을 막지 않는다", () => {
    (globalThis as { window?: unknown }).window = { ReactNativeWebView: { postMessage: () => { throw new Error("bridge"); } } };
    expect(() => notifyNativeLogout()).not.toThrow();
  });

  /** app 아래 모든 .tsx — 고정 목록이면 새 로그아웃 버튼이 생겼을 때 검사를 빠져나간다(재검토 지적) */
  const tsxFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? tsxFiles(join(dir, d.name)) : d.name.endsWith(".tsx") ? [join(dir, d.name)] : []);
  const signOutSites = tsxFiles("app").filter((f) => /\bsignOut\(/.test(readFileSync(f, "utf-8")));

  it("signOut을 부르는 화면이 실제로 있다(검사 대상이 비지 않게)", () => {
    expect(signOutSites.length).toBeGreaterThanOrEqual(3);
  });

  it.each(signOutSites)("%s — signOut이 **성공한 뒤** notifyNativeLogout(계정 id)를 부른다", (file) => {
    const src = readFileSync(file, "utf-8");
    for (const m of src.matchAll(/signOut\(/g)) {
      const after = src.slice(m.index!, m.index! + 200);
      // 🔒 빠지면 로그아웃해도 그 휴대폰이 이전 계정의 위급 알림을 계속 받는다(공용 기기에서 남의 알림)
      // 🔒 signOut **전에** 보내면, 로그아웃 요청이 실패했을 때 웹은 로그인 상태인데 앱 구독만 끊긴다
      // (callbackUrl 형은 signOut이 요청 성공 뒤 이동을 시작하고 돌아온다 — 이동 전에 같은 틱에서 신호가 나간다)
      expect(after).toMatch(/^signOut\(\{ (?:redirect: false|callbackUrl: "\/login") \}\);\s*notifyNativeLogout\(uid\);/);
      const before = src.slice(Math.max(0, m.index! - 120), m.index!);
      expect(before).toMatch(/const uid = session\?\.user\?\.id; await $/);
    }
  });

  it("RnBridge 컴포넌트는 세션 상태로 로그아웃 신호를 만들지 않는다(어떤 따옴표·헬퍼로도)", () => {
    const src = readFileSync("app/RnBridge.tsx", "utf-8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");   // 주석 제외
    const component = code.slice(code.indexOf("export function RnBridge"));
    // 🔒 "세션이 끊겨 보이면 구독도 끊자"로 되돌리면 한 번의 세션 조회 실패로 보호자 알림이 다시 조용히 끊긴다
    expect(component).not.toMatch(/notifyNativeLogout\(/);
    expect(component).not.toMatch(/LOGOUT/);
    // 끊겨 보일 땐 기억만 지운다 — 세션이 돌아오면 같은 계정이어도 LOGIN_SUCCESS를 다시 보내 앱이 재구독하게
    expect(component).toMatch(/status === "unauthenticated"\) \{ lastSentRef\.current = null; return; \}/);
  });
});
