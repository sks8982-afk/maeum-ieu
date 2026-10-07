/**
 * 보호자 화면 PushStatusBox를 실제로 돌려 본다(2026-10-07 4차) — "확인 중" 시간 상한과 어르신 쪽 표시 범위 안내.
 *   · 1.2.0 앱 안 · 등록 휴대폰 0대 · 실패 보고 없음이 상한(11차부터 55초 — 앱이 답하는 최악 48초보다 길게, 10차는 40초) 넘게 이어지면
 *     "앱이 응답하지 않아요. 앱을 다시 열어 주세요." + 다시 시도.
 *     예전엔 앱이 답하지 않으면 "확인하는 중"에 끝없이 머물러, 보호자가 이 휴대폰 등록이 빠진 걸 알 수 없었다.
 *   · (11차) 다른 휴대폰만 목록에 있고 이 휴대폰이 없어도 같다 — 목록 아래에 확인 중 → 상한에 "앱이 응답하지 않아요".
 *   · 앱이 답하거나 "다시 시도"를 누르면 상한을 새로 잰다. 실패 보고는 한국어 사유로 보이고 시간 상한과 상관없다.
 *   · (10차) 목록에서 "이 휴대폰"을 지우면 "지웠어요" — 시간 상한(타이머)도 "다시 시도"도 없다. 앱이 다시 보고하면 풀린다.
 *   · 목록을 불러오면 "연결된 어르신 화면에는 앱 알림을 받을 수 있는지만 표시돼요." — 서버도 상태만 보낸다(linked-experts).
 *
 * 렌더러(jsdom)가 없어 react 훅(useState·useEffect·useSyncExternalStore)을 작은 대역으로 바꿔 컴포넌트를 함수로 부르고, 효과를
 *   React처럼 실행한다(첫 렌더엔 전부, 다음엔 의존값이 바뀐 것만 — 바뀌면 앞 정리 함수부터). rn-bridge-session.test.ts와 같은
 *   방식이고 목 체제가 달라 파일을 나눈다. 자식 화면 조각(AccountDevices 등)은 훅이 없어 react-dom/server로 그대로 그린다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { createHash } from "node:crypto";

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as { fn: () => void | (() => void); deps?: unknown[] }[],
  dirty: false,
}));

vi.mock("react", async (importOriginal) => {
  const React = await importOriginal<typeof import("react")>();
  return {
    ...React,
    useState: (init: unknown) => {
      const i = hooks.cursor++;
      if (!(i in hooks.slots)) hooks.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      const set = (v: unknown) => {
        const next = typeof v === "function" ? (v as (prev: unknown) => unknown)(hooks.slots[i]) : v;
        if (!Object.is(next, hooks.slots[i])) { hooks.slots[i] = next; hooks.dirty = true; }
      };
      return [hooks.slots[i], set];
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => { hooks.effects.push({ fn, deps }); },
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
});

const { PushStatusBox, ELDER_VISIBILITY_NOTE, DELETE_FAILED_TEXT } = await import("@/app/expert/PushStatusBox");
const { PUSH_STATUS_EVENT, relayNativePushToken } = await import("@/app/RnBridge");

const PENDING = "이 휴대폰 등록을 확인하는 중이에요. 잠시 기다려 주세요.";
const NO_ANSWER = "앱이 응답하지 않아요. 앱을 다시 열어 주세요.";
const DELETED = "이 휴대폰을 목록에서 지웠어요. 앱을 다시 열면 다시 등록돼요.";

let prevDeps: (unknown[] | undefined)[] = [];
let cleanups: (void | (() => void))[] = [];
let tree: ReactElement | null = null;

/** 한 번 그린다 — 의존값이 바뀐 효과만 (앞 정리 함수를 부르고) 다시 실행한다 */
function renderOnce() {
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.dirty = false;
  tree = PushStatusBox() as ReactElement | null;
  hooks.effects.forEach((e, i) => {
    const prev = prevDeps[i];
    const changed = !prev || !e.deps || e.deps.length !== prev.length || e.deps.some((d, j) => !Object.is(d, prev[j]));
    if (!changed) return;
    cleanups[i]?.();
    cleanups[i] = e.fn();
    prevDeps[i] = e.deps;
  });
}

/** 비동기 결과(목록 응답·앱 답·타이머)가 상태를 바꿨으면, 더 바뀌지 않을 때까지 다시 그린다 */
async function settle() {
  for (let n = 0; n < 20; n++) {
    for (let k = 0; k < 10; k++) await Promise.resolve();
    if (!hooks.dirty) return;
    renderOnce();
  }
  throw new Error("상태가 안정되지 않는다");
}

const markup = () => (tree ? renderToStaticMarkup(tree).replace(/<!-- -->/g, "") : "");

/** 그려진 트리에서 이름이 같은 함수 prop을 찾는다(자식 조각은 펼치지 않은 element 그대로 — 그 props를 본다) */
function findProp(node: unknown, name: string): (() => void) | undefined {
  if (Array.isArray(node)) {
    for (const c of node) { const f = findProp(c, name); if (f) return f; }
    return undefined;
  }
  if (typeof node !== "object" || node === null || !("props" in node)) return undefined;
  const props = (node as { props: Record<string, unknown> }).props;
  if (typeof props[name] === "function") return props[name] as () => void;
  return findProp(props.children, name);
}

/** 앱(1.2.0) 웹뷰 흉내 — 앱으로 간 메시지를 남기고, 목록 응답은 rows(없으면 실패 응답) */
function installApp({ version = "1.2.0" as string | null, rows = [] as unknown[] | null } = {}) {
  const posted: Record<string, unknown>[] = [];
  const win = Object.assign(new EventTarget(), {
    ReactNativeWebView: { postMessage: (m: string) => { posted.push(JSON.parse(m) as Record<string, unknown>); } },
    location: { origin: "https://maeum.example" },
    ...(version ? { MAEUM_APP_VERSION: version } : {}),
  });
  (globalThis as { window?: unknown }).window = win;
  (globalThis as { document?: unknown }).document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  // 실제 Response 대신 단순 객체 — 가짜 시계에서도 본문 읽기가 막히지 않게
  const fetchMock = vi.fn(async () => (rows ? { ok: true, json: async () => ({ devices: rows }) } : { ok: false, json: async () => ({}) }));
  vi.stubGlobal("fetch", fetchMock);
  return { posted, win, fetchMock };
}

/** 앱이 이 휴대폰 상태를 보고했다(RnBridge relayNativePushToken이 내는 화면 이벤트) */
function phoneReport(win: EventTarget, detail: Record<string, unknown>) {
  win.dispatchEvent(new CustomEvent(PUSH_STATUS_EVENT, { detail }));
}

afterEach(() => {
  cleanups.forEach((c) => c?.());
  cleanups = [];
  prevDeps = [];
  hooks.slots = [];
  tree = null;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("1.2.0 앱 안 · 등록 휴대폰 0대 — 확인 중은 55초까지(11차 — 앱이 답하는 최악 48초보다 길게)", () => {
  it("답이 없으면 55초 전엔 '확인하는 중', 55초에 '앱이 응답하지 않아요' + 다시 시도", async () => {
    vi.useFakeTimers();
    const { posted } = installApp();
    renderOnce();
    await settle();
    expect(posted).toEqual([{ type: "REQUEST_PUSH_TOKEN" }]);   // 처음 한 번 물었다
    expect(markup()).toContain(PENDING);
    // 🔒 앱의 최악(준비 12 + 폐기 확인 getToken 12 + 토큰 폐기 12 + 새 토큰 12 = 48초) 안에서는 "응답하지 않아요"를 띄우지 않는다
    //   (예전 10초·10차 40초는 띄웠다)
    await vi.advanceTimersByTimeAsync(48_000);
    await settle();
    expect(markup()).toContain(PENDING);
    await vi.advanceTimersByTimeAsync(6_999);
    await settle();
    expect(markup()).toContain(PENDING);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    // 🔒 상한이 없으면 앱이 멈췄을 때 "확인하는 중"에 끝없이 머문다 — 보호자는 이 휴대폰 등록이 빠진 걸 모른다
    expect(markup()).toContain(NO_ANSWER);
    expect(markup()).toContain(">다시 시도</button>");
    expect(markup()).not.toContain(PENDING);
  });

  it("'다시 시도'를 누르면 다시 확인 중 — 55초를 새로 잰다", async () => {
    vi.useFakeTimers();
    installApp();
    renderOnce();
    await settle();
    await vi.advanceTimersByTimeAsync(55_000);
    await settle();
    expect(markup()).toContain(NO_ANSWER);
    findProp(tree, "onRetry")!();
    await settle();
    expect(markup()).toContain(PENDING);
    await vi.advanceTimersByTimeAsync(54_999);
    await settle();
    expect(markup()).toContain(PENDING);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(markup()).toContain(NO_ANSWER);
  });

  it("앱이 답하면(등록됨 — 목록은 아직 0대) 55초를 새로 잰다", async () => {
    vi.useFakeTimers();
    const { win, fetchMock } = installApp();
    renderOnce();
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    phoneReport(win, { permission: "granted", channelBlocked: false, registered: true });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);   // 등록됐다는 답 → 목록을 다시 읽었다(아직 0대)
    await vi.advanceTimersByTimeAsync(54_000);
    await settle();
    // 🔒 첫 질문부터 55초를 재면 답이 온 직후 "앱이 응답하지 않아요"가 뜬다
    expect(markup()).toContain(PENDING);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(markup()).toContain(NO_ANSWER);
  });

  it("등록 실패 보고는 한국어 사유로 — 55초가 지나도 '응답하지 않아요'로 바뀌지 않는다", async () => {
    vi.useFakeTimers();
    const { win } = installApp();
    renderOnce();
    await settle();
    phoneReport(win, { permission: "granted", channelBlocked: false, registered: false, reason: "not-ready" });
    await settle();
    expect(markup()).toContain("서버 준비 중이에요. 잠시 후 다시 시도해 주세요.");
    await vi.advanceTimersByTimeAsync(56_000);
    await settle();
    expect(markup()).toContain("서버 준비 중이에요. 잠시 후 다시 시도해 주세요.");
    expect(markup()).not.toContain(NO_ANSWER);
  });

  it("일반 브라우저에선 시간 상한이 없다 — 중립 안내 그대로", async () => {
    vi.useFakeTimers();
    installApp();
    delete (globalThis as { window?: { ReactNativeWebView?: unknown } }).window!.ReactNativeWebView;
    renderOnce();
    await settle();
    await vi.advanceTimersByTimeAsync(56_000);
    await settle();
    expect(markup()).toContain("지금 앱으로도 위급 알림을 받습니다");
    expect(markup()).not.toContain(NO_ANSWER);
  });
});

/**
 * 다른 휴대폰 1대만 목록에 있고 이 휴대폰(1.2.0 앱 안)은 없다(2026-10-08 11차) — 예전엔 0대일 때만 기다리고 이 휴대폰 상태를 보여 줘,
 *   다른 보호자·다른 휴대폰이 등록된 계정에선 이 휴대폰 등록이 빠져도(앱 응답 없음·등록 실패) 화면에 아무것도 없었다.
 *   (RnBridge가 기억한 휴대폰이 없는 동안이라 "이 휴대폰"은 아직 모른다 — 기억이 생기는 아래 '지웠어요' describe보다 앞에 둔다)
 */
describe("1.2.0 앱 안 · 다른 휴대폰만 목록에(이 휴대폰 없음) — 목록 아래에 확인 중 → 55초에 응답 없음 / 실패 사유(11차)", () => {
  const OTHER_ROW = {
    handle: "fedcba9876543210", platform: "android", appVersion: "1.2.0", permission: "granted", channelBlocked: false, updatedAt: "2026-10-07T03:12:00.000Z",
  };

  it("답이 없으면 55초 전엔 목록 아래 '확인하는 중', 55초에 '앱이 응답하지 않아요' + 다시 시도 — 목록은 그대로", async () => {
    vi.useFakeTimers();
    installApp({ rows: [OTHER_ROW] });
    renderOnce();
    await settle();
    expect(markup()).toContain("📱 이 계정으로 위급 알림을 받는 휴대폰: <b>1대</b>");
    // 🔒 다른 휴대폰이 있다고 이 휴대폰 상태를 숨기면 지금 들고 있는 휴대폰 등록이 빠진 걸 아무도 모른다
    expect(markup()).toContain(PENDING);
    await vi.advanceTimersByTimeAsync(54_999);
    await settle();
    expect(markup()).toContain(PENDING);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    // 🔒 0대일 때만 기다리면 여기서 "확인하는 중"에 끝없이 머문다
    expect(markup()).toContain(NO_ANSWER);
    expect(markup()).toContain(">다시 시도</button>");
    expect(markup()).toContain("📱 이 계정으로 위급 알림을 받는 휴대폰: <b>1대</b>");
  });

  it("등록 실패 보고면 목록 아래에 한국어 사유 + 다시 시도 — 55초가 지나도 그대로(타이머 없음)", async () => {
    vi.useFakeTimers();
    const { win } = installApp({ rows: [OTHER_ROW] });
    renderOnce();
    await settle();
    phoneReport(win, { permission: "granted", channelBlocked: false, registered: false, reason: "no-token:messaging/unknown" });
    await settle();
    expect(markup()).toContain("이 휴대폰을 알림 받을 기기로 등록하지 못했어요");
    expect(markup()).toContain("휴대폰이 알림 토큰을 받지 못했어요 — 인터넷·Google Play 서비스를 확인해 주세요");
    expect(markup()).not.toContain("messaging/unknown");
    expect(markup()).toContain(">다시 시도</button>");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(56_000);
    await settle();
    expect(markup()).not.toContain(NO_ANSWER);
  });
});

describe("어르신 쪽 표시 범위 안내(2026-10-07 4차)", () => {
  it("목록을 불러오면 '연결된 어르신 화면에는 앱 알림을 받을 수 있는지만 표시돼요.' — 0대여도, 휴대폰이 있어도", async () => {
    expect(ELDER_VISIBILITY_NOTE).toBe("연결된 어르신 화면에는 앱 알림을 받을 수 있는지만 표시돼요.");
    installApp({ rows: [{ handle: "0123456789abcdef", platform: "android", appVersion: "1.2.0", permission: "granted", channelBlocked: false, updatedAt: "2026-10-07T03:12:00.000Z" }] });
    renderOnce();
    await settle();
    expect(markup()).toContain("이 계정으로 위급 알림을 받는 휴대폰");
    expect(markup()).toContain(ELDER_VISIBILITY_NOTE);
    afterEachReset();
    installApp({ rows: [] });
    renderOnce();
    await settle();
    expect(markup()).toContain(ELDER_VISIBILITY_NOTE);
  });

  it("목록을 못 불러오면 상자째 없다(안내도 없다)", async () => {
    installApp({ rows: null, version: null });
    // 일반 브라우저(브릿지 없음) — 1.2.0 이전 앱이면 "수신 확인 미지원" 줄이 남아 상자가 보인다
    delete (globalThis as { window?: { ReactNativeWebView?: unknown } }).window!.ReactNativeWebView;
    renderOnce();
    await settle();
    expect(markup()).toBe("");
  });
});

/**
 * 목록 삭제가 안 됐을 때(2026-10-07 5차) — 서버는 그 휴대폰의 토픽 구독을 먼저 끊고, 끊긴 게 확인돼야 행을 지운다. 끊지 못하면
 *   502 { ok:false, reason:"topic" }(행은 그대로). 화면은 정해진 문구를 보여 주고 목록을 다시 읽어 그 줄이 남는다 — 다시 누를 수 있다.
 */
describe("목록 삭제가 안 되면(토픽 해제 실패 — 502) 안내 + 줄은 남는다", () => {
  it("'삭제하지 못했어요. 잠시 후 다시 시도해 주세요.' — 목록을 다시 읽어 그 줄이 그대로, 다시 누를 수 있다", async () => {
    expect(DELETE_FAILED_TEXT).toBe("삭제하지 못했어요. 잠시 후 다시 시도해 주세요.");
    const row = { handle: "0123456789abcdef", platform: "android", appVersion: "1.2.0", permission: "granted", channelBlocked: false, updatedAt: "2026-10-07T03:12:00.000Z" };
    const { win } = installApp();
    delete (win as { ReactNativeWebView?: unknown }).ReactNativeWebView;   // 보호자 PC 브라우저
    Object.assign(win, { confirm: () => true });
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return init?.method === "DELETE"
        ? { ok: false, status: 502, json: async () => ({ ok: false, reason: "topic" }) }
        : { ok: true, json: async () => ({ devices: [row] }) };
    }));
    renderOnce();
    await settle();
    expect(markup()).toContain(">삭제</button>");
    expect(markup()).not.toContain(DELETE_FAILED_TEXT);
    await (findProp(tree, "onDelete") as unknown as (handle: string) => Promise<void>)(row.handle);
    await settle();
    // 🔒 실패를 "삭제됨"처럼 넘기면 보호자는 그 휴대폰이 아직 토픽 사본(가린 이름)을 받는다는 걸 모른다
    expect(markup()).toContain(DELETE_FAILED_TEXT);
    // 줄이 남아 다시 누를 수 있다(목록을 다시 읽었다)
    expect(methods).toEqual(["GET", "DELETE", "GET"]);
    expect(markup()).toContain(">삭제</button>");
    expect(markup()).toContain("안드로이드 · 앱 v1.2.0 · 알림 켜짐");
  });
});

/** 같은 테스트 안에서 처음부터 다시 그리기 위해 — afterEach와 같은 정리 */
function afterEachReset() {
  cleanups.forEach((c) => c?.());
  cleanups = [];
  prevDeps = [];
  hooks.slots = [];
  tree = null;
  vi.unstubAllGlobals();
}

/**
 * 목록에서 "이 휴대폰"을 지웠다(2026-10-08 10차) — 지운 것은 보호자의 뜻이라 장애가 아니다. 예전엔 0대가 되면 확인 중 → 시간 상한 →
 *   "앱이 응답하지 않아요" + 다시 시도로 흘러 방금 지운 걸 고장처럼 보였다. 이제 "지웠어요"(타이머·다시 시도 없음), 앱이 다시 보고하면 풀린다.
 *   "이 휴대폰"은 RnBridge가 앱에게서 받은 토큰으로 정한다(thisPhoneHandle) — 그래서 먼저 앱의 PUSH_TOKEN을 한 번 흘려 넣는다.
 *   crypto.subtle은 대역으로 바꾼다 — 진짜는 이벤트 루프를 한 바퀴 돌아야 끝나 가짜 시계·마이크로태스크만으로는 기다릴 수 없다
 *   (handle 규칙 자체는 rn-bridge.test.ts가 서버 deviceHandle과 맞대어 고정한다).
 *   ⚠ 이 describe는 파일 끝에 둔다 — RnBridge가 기억한 휴대폰(모듈 상태)은 테스트 사이에 지워지지 않는다.
 */
describe("목록에서 '이 휴대폰'을 지우면 — '지웠어요', 타이머·다시 시도 없음(10차)", () => {
  const TOKEN = "fcm-token_" + "T".repeat(60);
  const THIS = createHash("sha256").update(TOKEN).digest("hex").slice(0, 16);   // 서버 deviceHandle과 같은 규칙
  const OTHER = "fedcba9876543210";
  const row = (handle: string) => ({
    handle, platform: "android", appVersion: "1.2.0", permission: "granted", channelBlocked: false, updatedAt: "2026-10-07T03:12:00.000Z",
  });

  /** 앱 웹뷰 + 서버 흉내 — GET은 지금 목록, DELETE { handle }은 그 줄을 지우고, POST(등록)는 받기만 한다 */
  async function setup(listed: string[]) {
    const { win } = installApp();
    Object.assign(win, { confirm: () => true });
    const server = { rows: listed.map(row) };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        const { handle } = JSON.parse(String(init.body)) as { handle: string };
        server.rows = server.rows.filter((r) => r.handle !== handle);
        return { ok: true, json: async () => ({ ok: true }) };
      }
      if (init?.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, json: async () => ({ devices: server.rows }) };
    }));
    vi.stubGlobal("crypto", {
      subtle: { digest: async (_alg: string, data: Uint8Array) => new Uint8Array(createHash("sha256").update(data).digest()).buffer },
    });
    // 앱이 이 휴대폰 토큰을 보냈다 — RnBridge가 기억해 "이 휴대폰"을 안다(화면이 뜨기 전이라 그 상태 이벤트는 아무도 안 듣는다)
    await relayNativePushToken({ userId: "u-guardian", token: TOKEN, permission: "granted", channelBlocked: false, appVersion: "1.2.0" }, "u-guardian");
    return { win, server };
  }

  /** 그려진 목록의 "삭제"를 누른다(확인 창은 늘 확인) */
  const del = (handle: string) => (findProp(tree, "onDelete") as unknown as (h: string) => Promise<void>)(handle);

  it("유일한 '이 휴대폰'을 지우면 0대여도 '지웠어요' — 55초가 지나도 '응답하지 않아요'·다시 시도 없음, 타이머도 없다", async () => {
    vi.useFakeTimers();
    await setup([THIS]);
    renderOnce();
    await settle();
    expect(markup()).toContain("이 휴대폰 · ");
    await del(THIS);
    await settle();
    expect(markup()).toContain(DELETED);
    expect(markup()).not.toContain(PENDING);
    // 🔒 기다릴 답이 없다 — 상한 타이머가 돌면 지운 휴대폰을 "앱이 응답하지 않아요"로 보이게 하는 길이 남는다
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(56_000);
    await settle();
    expect(markup()).toContain(DELETED);
    expect(markup()).not.toContain(NO_ANSWER);
    expect(markup()).not.toContain(">다시 시도</button>");
  });

  it("앱이 다시 보고하면 풀린다 — 등록을 못 했으면 그 사유, 다시 등록됐으면 목록에 '이 휴대폰'이 돌아온다", async () => {
    vi.useFakeTimers();
    const { win, server } = await setup([THIS]);
    renderOnce();
    await settle();
    await del(THIS);
    await settle();
    expect(markup()).toContain(DELETED);
    phoneReport(win, { permission: "granted", channelBlocked: false, registered: false, reason: "network" });
    await settle();
    // 🔒 "지웠어요"가 남으면 다시 연 앱이 등록에 실패한 사실을 가린다
    expect(markup()).not.toContain(DELETED);
    expect(markup()).toContain("인터넷 연결을 확인해 주세요.");
    server.rows = [row(THIS)];   // 앱을 다시 열어 다시 등록됐다
    phoneReport(win, { permission: "granted", channelBlocked: false, registered: true });
    await settle();
    expect(markup()).toContain("이 휴대폰 · ");
    expect(markup()).not.toContain(DELETED);
  });

  it("이 휴대폰이 (다른 휴대폰과 함께) 목록에 있으면 목록 아래 상자도 시간 상한 타이머도 없다(11차)", async () => {
    vi.useFakeTimers();
    await setup([OTHER, THIS]);
    renderOnce();
    await settle();
    expect(markup()).toContain("이 휴대폰 · ");
    expect(markup()).not.toContain(PENDING);
    // 🔒 목록에 있는데도 기다리면 기다릴 답이 없는 타이머가 돈다(넓힌 대기 조건이 '목록에 없음'을 빠뜨린 경우)
    expect(vi.getTimerCount()).toBe(0);
  });

  it("다른 휴대폰이 남으면 목록 아래에 '지웠어요'(남은 휴대폰 목록 그대로)", async () => {
    vi.useFakeTimers();
    await setup([OTHER, THIS]);
    renderOnce();
    await settle();
    await del(THIS);
    await settle();
    expect(markup()).toContain("📱 이 계정으로 위급 알림을 받는 휴대폰: <b>1대</b>");
    // 🔒 남은 휴대폰 목록만 보이면 지금 들고 있는 휴대폰이 더는 실명 알림을 받지 않는다는 걸 모른다
    expect(markup()).toContain(DELETED);
    expect(markup()).not.toContain("이 휴대폰 · ");
  });

  it("다른 휴대폰을 지운 것은 '지웠어요'가 아니다 — 이 휴대폰이 목록에 없었어도(0대가 되면 이 휴대폰의 확인 중)", async () => {
    vi.useFakeTimers();
    await setup([OTHER]);   // 이 휴대폰은 앱이 보고했지만 목록에는 없다(등록이 빠졌다)
    renderOnce();
    await settle();
    expect(markup()).toContain(PENDING);   // 11차 — 다른 휴대폰만 있어도 목록 아래에 이 휴대폰의 확인 중
    await del(OTHER);
    await settle();
    // 🔒 남의 휴대폰을 지웠는데 "이 휴대폰을 지웠어요"라고 하면 보호자는 이 휴대폰 등록이 빠진 까닭을 잘못 안다
    expect(markup()).not.toContain(DELETED);
    expect(markup()).toContain(PENDING);
  });
});
