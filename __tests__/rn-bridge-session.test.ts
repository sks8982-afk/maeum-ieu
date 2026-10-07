/**
 * RnBridge 컴포넌트의 세션 효과 — LOGIN_SUCCESS 바로 뒤에 REQUEST_PUSH_TOKEN을 보낸다(2026-10-07).
 *   왜: 페이지를 새로 불러오면 웹은 이 휴대폰 토큰을 잊는다(lastPushDevice — 로그아웃 때 지울 대상). 앱(1.2.0)도
 *   LOGIN_SUCCESS마다 PUSH_TOKEN을 보내지만, 그 답을 놓쳐도 등록이 빠지지 않게 웹이 한 번 더 요청한다(멱등 —
 *   같은 토큰이면 같은 행을 갱신할 뿐, 구버전 앱은 모르는 메시지라 무시한다).
 *
 * 렌더러(jsdom)가 없어 컴포넌트를 함수로 부르고, react 훅(useRef·useEffect·useCallback)을 작은 대역으로 바꿔 효과를
 *   React처럼 실행한다 — 첫 렌더엔 전부, 다음 렌더엔 의존값이 바뀐 것만(바뀌면 앞 정리 함수부터).
 *   react 대역이라는 목 체제가 rn-bridge.test.ts와 달라 파일을 나눈다(목 체제 하나당 파일 하나 — emergency-notify-decrypt 주석).
 */
import { describe, it, expect, vi, afterEach } from "vitest";

type Session = {
  data: { user: { id: string; screeningMode?: string } } | null;
  status: "authenticated" | "unauthenticated" | "loading";
};

const hooks = vi.hoisted(() => ({
  session: { data: null, status: "loading" } as unknown,
  refs: [] as { current: unknown }[],
  cursor: 0,
  effects: [] as { fn: () => void | (() => void); deps?: unknown[] }[],
}));

vi.mock("react", async (importOriginal) => {
  const React = await importOriginal<typeof import("react")>();
  return {
    ...React,
    useRef: (init: unknown) => (hooks.refs[hooks.cursor++] ??= { current: init }),
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => { hooks.effects.push({ fn, deps }); },
    useCallback: (fn: unknown) => fn,
  };
});
vi.mock("next-auth/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next-auth/react")>()),
  useSession: () => hooks.session,
}));

const { RnBridge } = await import("@/app/RnBridge");

let prevDeps: (unknown[] | undefined)[] = [];
let cleanups: (void | (() => void))[] = [];

/** 한 번 그린다 — 의존값이 바뀐 효과만 (앞 정리 함수를 부르고) 다시 실행한다 */
function render(session: Session) {
  hooks.session = session;
  hooks.cursor = 0;
  hooks.effects = [];
  RnBridge();
  hooks.effects.forEach((e, i) => {
    const prev = prevDeps[i];
    const changed = !prev || !e.deps || e.deps.length !== prev.length || e.deps.some((d, j) => !Object.is(d, prev[j]));
    if (!changed) return;
    cleanups[i]?.();
    cleanups[i] = e.fn();
    prevDeps[i] = e.deps;
  });
}

/** 앱 웹뷰 흉내 — 앱으로 간 메시지를 남긴다 */
function installApp() {
  const posted: Record<string, unknown>[] = [];
  const win = Object.assign(new EventTarget(), {
    ReactNativeWebView: { postMessage: (m: string) => { posted.push(JSON.parse(m) as Record<string, unknown>); } },
    location: { origin: "https://maeum.example", assign: () => {} },
  });
  (globalThis as { window?: unknown }).window = win;
  (globalThis as { document?: unknown }).document = new EventTarget();
  return { posted };
}

const authed = (id: string, role = "guardian"): Session => ({ data: { user: { id, screeningMode: role } }, status: "authenticated" });
const LOGIN = (userId: string, role = "guardian") => ({ type: "LOGIN_SUCCESS", userId, role });
const REQUEST = { type: "REQUEST_PUSH_TOKEN" };

afterEach(() => {
  cleanups.forEach((c) => c?.());
  cleanups = [];
  prevDeps = [];
  hooks.refs = [];
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  vi.unstubAllGlobals();
});

describe("세션 효과 — LOGIN_SUCCESS 바로 뒤에 REQUEST_PUSH_TOKEN", () => {
  it("로그인되면 LOGIN_SUCCESS, 이어서 REQUEST_PUSH_TOKEN", () => {
    const { posted } = installApp();
    render(authed("u-guardian"));
    // 🔒 요청이 빠지면 앱의 LOGIN_SUCCESS 답(PUSH_TOKEN)을 놓친 페이지는 로그아웃 때 이 휴대폰 등록을 못 지운다
    expect(posted).toEqual([LOGIN("u-guardian"), REQUEST]);
  });

  it("같은 계정으로 다시 그려도 다시 보내지 않는다 — 계정이 바뀌면 둘 다 다시", () => {
    const { posted } = installApp();
    const s = authed("u-guardian");
    render(s);
    render(s);
    expect(posted).toEqual([LOGIN("u-guardian"), REQUEST]);
    render(authed("u-other", "user"));
    expect(posted.slice(2)).toEqual([LOGIN("u-other", "user"), REQUEST]);
  });

  it("세션이 끊겨 보이면 아무것도(LOGOUT도 요청도) 보내지 않는다 — 다시 로그인되면 같은 계정이어도 둘 다 다시", () => {
    const { posted } = installApp();
    render(authed("u-guardian"));
    render({ data: null, status: "unauthenticated" });
    expect(posted).toEqual([LOGIN("u-guardian"), REQUEST]);
    render(authed("u-guardian"));
    expect(posted.slice(2)).toEqual([LOGIN("u-guardian"), REQUEST]);
  });

  it("로딩 중엔 보내지 않는다", () => {
    const { posted } = installApp();
    render({ data: null, status: "loading" });
    expect(posted).toEqual([]);
  });

  it("앱이 답한 PUSH_TOKEN은 지금 세션 계정으로 등록되고 결과를 앱에 알린다(컴포넌트 리스너)", async () => {
    const { posted } = installApp();
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(authed("u-guardian"));
    const token = "fcm-token_" + "B".repeat(60);
    const data = JSON.stringify({ type: "PUSH_TOKEN", userId: "u-guardian", token, permission: "granted", channelBlocked: false, appVersion: "1.2.0" });
    (globalThis as unknown as { document: EventTarget }).document.dispatchEvent(new MessageEvent("message", { data }));   // 앱 sendToWeb: 보낸 창 없음
    await vi.waitFor(() => expect(posted.at(-1)).toEqual({ type: "PUSH_REGISTERED" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/push/device");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ token, appVersion: "1.2.0", permission: "granted", channelBlocked: false });
  });
});
