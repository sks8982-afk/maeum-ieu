/**
 * /api/push/device — 위급 알림 휴대폰 등록·해제·조회 **행위** 테스트.
 *
 * 고정하는 것(2026-10-07):
 *   · 로그인한 세션만, **세션 계정에만** 등록한다 — 본문의 userId는 읽지 않는다(토픽은 이름만 알면 누구든 받았다)
 *   · 형식이 틀리면 400, 테이블이 없으면 503 notReady(등록됐다고 거짓 응답하면 앱·화면이 "등록됨"으로 보여
 *     실명 사본이 안 나가는 걸 아무도 모른다)
 *   · 해제는 세션 계정의 것만 — { token }(로그아웃) 또는 { handle }(보호자 화면 "삭제"), 멱등({ ok, removed })
 *   · 해제는 등록과 다른 레이트리밋 버킷(등록이 몰려도 로그아웃이 막히지 않게)
 *   · 조회 응답에 토큰은 절대 없다 — handle만
 *   · (3차) 폐기 토큰(retiredTokens) 행은 어느 계정에 있든 지운다 — 지금 토큰·형식이 틀린 값은 빼고
 *   · (4차) 토픽: 등록 요청은 **응답 뒤에**(after) 세션 계정 토픽에 구독시킨다 — 등록 행과 상관없이(503·DB 실패여도).
 *     로그아웃({ token })은 토픽을 건드리지 않는다(앱이 확인된 LOGOUT에서 토큰을 폐기해 끝낸다). 목록 "삭제"({ handle })는
 *     토픽에서 해제하고 끝날 때까지 기다린다(최대 15초).
 *   · (4차) 목록(GET)은 FCM 시험 발송(dry run)으로 앱을 지운 휴대폰을 걸러 지운다 — 계정당 10분에 한 번, 5초 상한, 실패는 무시.
 *   · (7차) 목록 "삭제"는 서버가 FCM을 쓸 수 없으면(자격증명 없음·다른 Firebase 프로젝트) 503 unconfigured — 행을 지우지 않는다.
 *
 * 목 체제: prisma raw 문은 실행하지 않고 문장 기술자로 기록한다(push-devices.test.ts와 같은 방식).
 *   FCM은 firebase-admin 바닥에서 목으로 바꿔, 토픽 이름·지울 토큰 판정은 실제 push-fcm이 한다.
 *   next/server의 after는 콜백을 모아 두었다가 테스트가 돌린다(요청 스코프 밖에선 throw — live-turn-gates와 같은 방식).
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { EXPECTED_FCM_PROJECT_ID } from "@/lib/notify/fcm-project";

type Stmt = { sql: string; params: unknown[] };
const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

let session: { user: { id: string; screeningMode?: string } } | null = null;
let rateOk = true;
/** 한도가 찬 레이트리밋 키 — 버킷이 나뉘었는지 보려고 */
const limitedKeys = new Set<string>();
const rateCalls: [string, number, number][] = [];
let queryRows: Record<string, unknown>[] = [];
let queryError: Error | null = null;
let txError: Error | null = null;
let execError: Error | null = null;
const queryCalls: Stmt[] = [];
const execCalls: Stmt[] = [];
const txLog: Stmt[][] = [];
/** after()로 맡긴 일 — 응답이 나간 뒤에 돈다(runAfter) */
const afterTasks: (() => unknown)[] = [];
/** 토픽 해제와 DB 쓰기의 순서(5차 — 목록 삭제는 해제가 먼저, 확인돼야 행을 지운다) */
const order: string[] = [];
type TopicMgmt = { successCount: number; failureCount: number; errors: unknown[] };
const unsubscribeFromTopic = vi.fn<(tokens: string[], topic: string) => Promise<TopicMgmt>>(
  async (tokens) => { order.push("unsubscribe"); return { successCount: tokens.length, failureCount: 0, errors: [] }; },
);
const subscribeToTopic = vi.fn<(tokens: string[], topic: string) => Promise<TopicMgmt>>(
  async (tokens) => ({ successCount: tokens.length, failureCount: 0, errors: [] }),
);
type Resp = { success: boolean; error?: { code: string; message: string } };
type Batch = { successCount: number; failureCount: number; responses: Resp[] };
const allOk = async (msgs: unknown[]): Promise<Batch> => ({ successCount: msgs.length, failureCount: 0, responses: msgs.map(() => ({ success: true })) });
const sendEach = vi.fn<(msgs: unknown[], dryRun?: boolean) => Promise<Batch>>(allOk);

vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>();
  return { ...mod, after: (fn: () => unknown) => { afterTasks.push(fn); } };
});
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async (key: string, limit: number, windowMs: number) => {
    rateCalls.push([key, limit, windowMs]);
    const ok = rateOk && !limitedKeys.has(key);
    return { ok, retryAfterSec: ok ? 0 : 30 };
  }),
}));
vi.mock("firebase-admin/app", () => ({
  initializeApp: vi.fn(() => ({ name: "app" })),
  getApps: vi.fn(() => []),
  getApp: vi.fn(() => ({ name: "app" })),
  cert: vi.fn((x: unknown) => x),
}));
vi.mock("firebase-admin/messaging", () => ({ getMessaging: vi.fn(() => ({ unsubscribeFromTopic, subscribeToTopic, sendEach })) }));
/** 서비스 계정 env 값 — 기본은 앱의 Firebase 프로젝트(7차 — 다른 프로젝트면 서버가 FCM을 끈다, lib/notify/fcm-project) */
const ACCOUNT = (projectId: string = EXPECTED_FCM_PROJECT_ID) =>
  JSON.stringify({ project_id: projectId, client_email: "c@p", private_key: "k" });
vi.stubEnv("FCM_SERVICE_ACCOUNT", ACCOUNT());
vi.stubEnv("FCM_PROJECT_ID", "");
afterAll(() => { vi.unstubAllEnvs(); });
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      queryCalls.push({ sql: norm(sql), params });
      if (queryError) throw queryError;
      return queryRows;
    }),
    $executeRawUnsafe: vi.fn((sql: string, ...params: unknown[]) => {
      const stmt = { sql: norm(sql), params };
      execCalls.push(stmt);
      order.push("exec");
      return Object.assign(execError ? Promise.reject(execError) : Promise.resolve(1), stmt);
    }),
    $transaction: vi.fn(async (stmts: Stmt[]) => {
      if (txError) throw txError;
      txLog.push(stmts.map((s) => ({ sql: s.sql, params: s.params })));
      return stmts.map(() => 1);
    }),
  },
}));

const route = await import("@/app/api/push/device/route");
const { deviceHandle } = await import("@/lib/push/devices");
const missingTable = () => new Error('Raw query failed. Code: `42P01`. Message: `relation "push_device" does not exist`');
const TOKEN = "dGVzdC1mY20tdG9rZW4:APA91b" + "Q".repeat(120);
const GONE = "goneDeviceToken_" + "G".repeat(60);   // 앱을 지운 휴대폰의 토큰
const BODY = { token: TOKEN, appVersion: "1.2.0", permission: "granted", channelBlocked: false };
const deviceRow = (token: string, user_id: string) => ({
  token, user_id, platform: "android", app_version: "1.2.0", permission: "granted", channel_blocked: false,
  updated_at: new Date("2026-10-07T01:00:00Z"),
});

async function call(method: "POST" | "DELETE", body: unknown) {
  const handler = method === "POST" ? route.POST : route.DELETE;
  const res = await handler(new Request("http://localhost/api/push/device", {
    method, headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function get() {
  const res = await route.GET();
  return { status: res.status, text: await res.text() };
}
/** 응답이 나간 뒤의 일(after)을 돌린다 */
async function runAfter() {
  for (const task of afterTasks.splice(0)) await task();
}

beforeEach(() => {
  session = { user: { id: "u-guardian", screeningMode: "guardian" } };
  rateOk = true;
  limitedKeys.clear();
  rateCalls.length = 0;
  unsubscribeFromTopic.mockClear();
  subscribeToTopic.mockClear();
  sendEach.mockReset();
  sendEach.mockImplementation(allOk);
  afterTasks.length = 0;
  queryRows = [];
  queryError = null;
  txError = null;
  execError = null;
  queryCalls.length = 0;
  execCalls.length = 0;
  txLog.length = 0;
  order.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe("POST — 세션 계정에 이 휴대폰 등록", () => {
  it("세션 계정으로 등록한다 — 본문의 userId는 무시", async () => {
    const r = await call("POST", { ...BODY, userId: "u-victim" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(txLog).toHaveLength(1);
    // 🔒 계정이 본문에서 오면 아무 계정에나 내 휴대폰을 붙여 그 계정의 위급 알림(실명)을 받는다
    expect(txLog[0][0].params).toEqual([TOKEN, "u-guardian", "1.2.0", "granted", false]);
    expect(JSON.stringify(txLog)).not.toContain("u-victim");
  });

  it("로그인하지 않으면 401 — DB도 토픽 구독도 없다", async () => {
    session = null;
    expect((await call("POST", BODY)).status).toBe(401);
    await runAfter();
    expect(txLog).toEqual([]);
    expect(subscribeToTopic).not.toHaveBeenCalled();
  });

  it("요청이 몰리면 429 — DB도 토픽 구독도 없다", async () => {
    rateOk = false;
    expect((await call("POST", BODY)).status).toBe(429);
    await runAfter();
    expect(txLog).toEqual([]);
    expect(subscribeToTopic).not.toHaveBeenCalled();
  });

  it.each([
    ["토큰이 짧다", { ...BODY, token: "abc" }],
    ["토큰에 허용 밖 문자", { ...BODY, token: TOKEN + "/" }],
    ["권한 값 오타", { ...BODY, permission: "yes" }],
    ["채널 차단 여부가 문자열", { ...BODY, channelBlocked: "false" }],
    ["JSON이 아니다", "not json"],
  ])("%s → 400, 등록하지 않는다(토픽 구독도 없다)", async (_, body) => {
    const r = await call("POST", body);
    expect(r.status).toBe(400);
    await runAfter();
    expect(txLog).toEqual([]);
    // 🔒 형식이 틀린 본문의 토큰을 토픽에 붙이면, 검사를 비켜 간 값이 그 계정 토픽 사본을 받는다
    expect(subscribeToTopic).not.toHaveBeenCalled();
  });

  it("테이블이 없으면 503 notReady — 등록됐다고 거짓 응답하지 않는다, 토픽 구독은 한다(행과 상관없다)", async () => {
    txError = missingTable();
    const r = await call("POST", BODY);
    expect(r.status).toBe(503);
    expect(r.body.notReady).toBe(true);
    await runAfter();
    // 🔒 로그인한 앱 휴대폰은 모두 계정 토픽을 유지한다(조용함보다 중복) — 운영 스크립트보다 배포가 먼저여도 토픽 사본은 받아야 한다
    expect(subscribeToTopic).toHaveBeenCalledWith([TOKEN], "maeum_u-guardian");
  });

  it("그 밖의 DB 실패는 삼키지 않는다 — 그래도 토픽 구독은 한다", async () => {
    txError = new Error("connection refused");
    await expect(call("POST", BODY)).rejects.toThrow(/connection refused/);
    await runAfter();
    expect(subscribeToTopic).toHaveBeenCalledWith([TOKEN], "maeum_u-guardian");
  });
});

/**
 * 저장은 보호자·의사(pro) 계정만(2026-10-07 5차) — 위급 알림을 받는 쪽이 그들뿐이다(개인정보처리방침 1·7항).
 *   역할은 세션의 screeningMode(lib/auth — DB User.screeningMode, 가입 때 정해지고 바꿀 수 없다). 다른 역할은 폐기 토큰 행만
 *   지우고(그 휴대폰이 전에 보호자로 등록했던 행일 수 있다) 등록 행·서버 쪽 토픽 구독은 만들지 않으며, { ok:true, stored:false }로
 *   답한다 — 앱이 PUSH_REGISTERED를 받아 폐기 목록을 비운다.
 */
describe("POST — 역할: 보호자·의사만 저장한다", () => {
  const RETIRED = "retiredByThisPhone_" + "K".repeat(60);

  it.each([["guardian"], ["pro"]])("%s — 저장(등록 + 정리) + 응답 뒤 토픽 구독", async (role) => {
    session = { user: { id: `u-${role}`, screeningMode: role } };
    expect(await call("POST", BODY)).toEqual({ status: 200, body: { ok: true } });
    expect(txLog).toHaveLength(1);
    expect(txLog[0][0].params).toEqual([TOKEN, `u-${role}`, "1.2.0", "granted", false]);
    await runAfter();
    expect(subscribeToTopic).toHaveBeenCalledWith([TOKEN], `maeum_u-${role}`);
  });

  it.each([["user"], ["general"], [undefined]])("%s — 등록 행도 서버 쪽 토픽 구독도 없다, 폐기 토큰 행만 지우고 { ok:true, stored:false }", async (role) => {
    session = { user: { id: "u-elder", ...(role ? { screeningMode: role } : {}) } };
    const r = await call("POST", { ...BODY, retiredTokens: [RETIRED, TOKEN, "short"] });
    // 🔒 앱이 PUSH_REGISTERED를 받아야 폐기 목록을 비운다 — 실패로 답하면 같은 목록을 끝없이 다시 보낸다
    expect(r).toEqual({ status: 200, body: { ok: true, stored: false } });
    // 🔒 어르신·일반 계정 휴대폰 토큰은 저장하지 않는다(개인정보처리방침 1·7항) — 위급 알림을 받는 계정이 아니다
    expect(txLog).toEqual([]);
    expect(execCalls).toEqual([{ sql: "DELETE FROM push_device WHERE token = ANY($1::text[])", params: [[RETIRED]] }]);
    await runAfter();
    expect(subscribeToTopic).not.toHaveBeenCalled();
  });

  it("다른 역할 — 폐기 토큰이 없으면 폐기 행 삭제도 없다(다른 계정 행 정리 한 문장뿐) · 테이블이 없어도 { ok:true, stored:false } · 그 밖의 DB 실패는 삼키지 않는다", async () => {
    session = { user: { id: "u-elder", screeningMode: "user" } };
    expect(await call("POST", BODY)).toEqual({ status: 200, body: { ok: true, stored: false } });
    expect(execCalls).toEqual([]);
    // 6차: 역할과 상관없이 이 토큰을 들고 있던 다른 계정 행은 지운다(아래 "다른 계정 행" describe)
    expect(queryCalls.map((q) => q.params)).toEqual([[[TOKEN], "u-elder"]]);
    execError = missingTable();
    expect(await call("POST", { ...BODY, retiredTokens: [RETIRED] })).toEqual({ status: 200, body: { ok: true, stored: false } });
    execError = new Error("connection refused");
    // 🔒 지우지 못했는데 성공으로 답하면 앱이 폐기 목록을 비워, 남은 행은 다음 발송 때까지 "받는 휴대폰"으로 보인다
    await expect(call("POST", { ...BODY, retiredTokens: [RETIRED] })).rejects.toThrow(/connection refused/);
    expect(txLog).toEqual([]);
  });
});

/**
 * 등록 요청 → 서버 쪽 토픽 구독(2026-10-07 3·4차) — **응답 뒤에**(after). 로그인한 앱 휴대폰은 모두 계정 토픽을 유지해야 하고
 *   (조용함보다 중복), FCM이 느려도 등록 응답(로그아웃이 기다리는 등록 포함)을 붙잡지 않는다.
 */
describe("POST → 응답 뒤에 세션 계정 토픽 구독(최선 노력)", () => {
  it("응답이 나간 뒤에 이 토큰을 세션 계정 토픽(maeum_<세션 id>)에 구독시킨다 — 본문의 userId가 아니다", async () => {
    const r = await call("POST", { ...BODY, userId: "u-victim" });
    expect(r).toEqual({ status: 200, body: { ok: true } });
    // 🔒 응답 전에 기다리면 FCM이 느릴 때 등록 응답이 늦고, 로그아웃이 그 등록을 기다리다(3초) 해제와 엇갈린다
    expect(subscribeToTopic).not.toHaveBeenCalled();
    await runAfter();
    // 🔒 이름 규칙이 발송과 다르거나 본문 계정을 쓰면 엉뚱한 토픽에 붙어, 이 휴대폰이 토픽 사본을 못 받는다
    expect(subscribeToTopic).toHaveBeenCalledTimes(1);
    expect(subscribeToTopic).toHaveBeenCalledWith([TOKEN], "maeum_u-guardian");
    expect(unsubscribeFromTopic).not.toHaveBeenCalled();
  });

  it("구독이 거절돼도(FCM 오류) 등록 응답은 200 그대로 — 응답 뒤의 일도 throw하지 않는다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    subscribeToTopic.mockRejectedValueOnce(new Error("fcm down"));
    await expect(call("POST", BODY)).resolves.toEqual({ status: 200, body: { ok: true } });
    await expect(runAfter()).resolves.toBeUndefined();
    expect(subscribeToTopic).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("토픽 구독 실패"))).toBe(true);
    warn.mockRestore();
  });

  it("구독이 끝내 답하지 않아도 등록 응답은 곧바로 — 응답 뒤의 일은 5초 상한에서 끝난다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      subscribeToTopic.mockImplementationOnce(() => new Promise<never>(() => {}));
      expect(await call("POST", BODY)).toEqual({ status: 200, body: { ok: true } });
      let settled = false;
      const p = runAfter().then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await p;
    } finally {
      warn.mockRestore();
    }
  });
});

/**
 * 폐기 토큰(retiredTokens, 2026-10-07 3차) — 휴대폰이 로그아웃·계정 전환 때 deleteToken()으로 버린 토큰. 로그아웃 해제가
 *   연결 문제로 실패하면 그 행이 이전 계정에 남아 "받는 휴대폰"으로 보였다. 그 휴대폰의 다음 등록에서 지운다.
 */
describe("POST — 폐기 토큰 행은 어느 계정에 있든 지운다", () => {
  const OTHERS = "retiredByThisPhone_" + "K".repeat(60);   // 다른 계정(u-other)에 남아 있던 이 휴대폰의 옛 토큰

  it("다른 계정에 남은 폐기 토큰 행을 지운다 — 계정 조건 없이, 등록·정리보다 먼저(같은 트랜잭션)", async () => {
    const r = await call("POST", { ...BODY, retiredTokens: [OTHERS] });
    expect(r.status).toBe(200);
    expect(txLog).toHaveLength(1);
    const [retire, upsert, prune] = txLog[0];
    // 🔒 user_id 조건이 붙으면 이전 계정(u-other)에 남은 행이 그대로다 — 그 계정의 실명 알림이 죽은 토큰으로 계속 "보냄"이 된다
    expect(retire).toEqual({ sql: "DELETE FROM push_device WHERE token = ANY($1::text[])", params: [[OTHERS]] });
    expect(upsert.params).toEqual([TOKEN, "u-guardian", "1.2.0", "granted", false]);
    expect(prune.sql).toMatch(/^DELETE FROM push_device WHERE user_id = \$1 AND token NOT IN/);
  });

  it("지금 등록하는 토큰·형식이 틀린 값은 지우지 않고, 등록은 그대로 받는다", async () => {
    const r = await call("POST", { ...BODY, retiredTokens: [TOKEN, "short", 42, null, OTHERS + "/"] });
    expect(r.status).toBe(200);
    // 🔒 지금 토큰을 지우면 방금 한 등록이 사라진다 / 틀린 값 때문에 등록을 거절하면 실명 사본이 빠진다
    expect(txLog).toEqual([[
      expect.objectContaining({ sql: expect.stringMatching(/^INSERT INTO push_device/) }),
      expect.objectContaining({ sql: expect.stringMatching(/^DELETE FROM push_device WHERE user_id = \$1 AND token NOT IN/) }),
    ]]);
  });

  it("필드가 없으면 예전 그대로(등록 + 정리 두 문장)", async () => {
    await call("POST", BODY);
    expect(txLog[0]).toHaveLength(2);
    expect(txLog[0][0].sql).toMatch(/^INSERT INTO push_device/);
  });
});

/**
 * 다른 계정이 들고 있던 이 휴대폰 행(2026-10-07 6차) — **역할과 상관없이** 지금 토큰·폐기 토큰을 다른 계정이 들고 있던 행은 지우고,
 *   응답 뒤(after) 그 토큰을 **그 계정** 토픽에서 해제한다(최선 노력). 휴대폰은 지금 로그인한 계정의 알림만 받아야 한다 — 예전엔
 *   어르신·일반 계정이 이전 보호자 휴대폰에 로그인해도 그 보호자 행이 남아 그 보호자 앞 실명 사본이 이 휴대폰으로 갔고, 행이 옮겨 간
 *   보호자 휴대폰도 이전 계정의 토픽 사본을 계속 받았다. 목의 $queryRawUnsafe가 DELETE … RETURNING의 결과(queryRows)를 돌려준다.
 */
describe("POST — 다른 계정이 들고 있던 이 휴대폰 행은 역할과 상관없이 지우고, 그 계정 토픽에서도 뺀다", () => {
  const RELEASE_SQL = "DELETE FROM push_device WHERE token = ANY($1::text[]) AND user_id <> $2 RETURNING token, user_id";

  it("어르신이 보호자 A가 등록했던 휴대폰에 로그인 → A의 행은 지우고, 응답 뒤 그 토큰을 maeum_A에서 해제한다(저장·구독은 없다)", async () => {
    session = { user: { id: "u-elder", screeningMode: "user" } };
    queryRows = [{ token: TOKEN, user_id: "u-guardian-A" }];
    expect(await call("POST", BODY)).toEqual({ status: 200, body: { ok: true, stored: false } });
    // 🔒 남기면 A의 어르신 응급 때 A 앞 실명 사본이 지금 어르신이 쓰는 이 휴대폰으로 간다
    expect(queryCalls).toEqual([{ sql: RELEASE_SQL, params: [[TOKEN], "u-elder"] }]);
    expect(txLog).toEqual([]);
    // 🔒 해제는 응답 뒤에 — FCM이 느려도 등록 응답(로그아웃이 기다리는 등록 포함)을 붙잡지 않는다
    expect(unsubscribeFromTopic).not.toHaveBeenCalled();
    await runAfter();
    // 🔒 행만 지우면 이 휴대폰은 A 계정의 토픽 사본(가린 이름)을 계속 받는다
    expect(unsubscribeFromTopic).toHaveBeenCalledTimes(1);
    expect(unsubscribeFromTopic).toHaveBeenCalledWith([TOKEN], "maeum_u-guardian-A");
    expect(subscribeToTopic).not.toHaveBeenCalled();
  });

  it("보호자 B가 A의 휴대폰에 로그인 → 행이 B로 옮겨 가고(A 행 삭제 + B 등록), 응답 뒤 B 토픽 구독 + A 토픽 해제", async () => {
    session = { user: { id: "u-guardian-B", screeningMode: "guardian" } };
    queryRows = [{ token: TOKEN, user_id: "u-guardian-A" }];
    expect(await call("POST", BODY)).toEqual({ status: 200, body: { ok: true } });
    expect(queryCalls).toEqual([{ sql: RELEASE_SQL, params: [[TOKEN], "u-guardian-B"] }]);
    expect(txLog).toHaveLength(1);
    expect(txLog[0][0].params).toEqual([TOKEN, "u-guardian-B", "1.2.0", "granted", false]);
    await runAfter();
    expect(subscribeToTopic).toHaveBeenCalledWith([TOKEN], "maeum_u-guardian-B");
    // 🔒 옮겨 간 휴대폰이 이전 계정(A)의 토픽 사본까지 받으면 A 어르신의 응급이 B에게 간다
    expect(unsubscribeFromTopic).toHaveBeenCalledTimes(1);
    expect(unsubscribeFromTopic).toHaveBeenCalledWith([TOKEN], "maeum_u-guardian-A");
  });

  it("폐기 토큰까지 함께 — 다른 계정마다 한 번씩 해제한다 · 다른 계정 행이 없으면 해제도 없다", async () => {
    const OLD1 = "retiredOne_" + "A".repeat(40);
    const OLD2 = "retiredTwo_" + "B".repeat(40);
    session = { user: { id: "u-guardian-B", screeningMode: "guardian" } };
    queryRows = [{ token: TOKEN, user_id: "u-guardian-A" }, { token: OLD1, user_id: "u-guardian-A" }, { token: OLD2, user_id: "u-pro-C" }];
    expect((await call("POST", { ...BODY, retiredTokens: [OLD1, OLD2] })).status).toBe(200);
    expect(queryCalls[0].params).toEqual([[TOKEN, OLD1, OLD2], "u-guardian-B"]);
    await runAfter();
    expect(unsubscribeFromTopic.mock.calls).toEqual([[[TOKEN, OLD1], "maeum_u-guardian-A"], [[OLD2], "maeum_u-pro-C"]]);

    unsubscribeFromTopic.mockClear();
    queryRows = [];
    expect((await call("POST", BODY)).status).toBe(200);
    await runAfter();
    expect(unsubscribeFromTopic).not.toHaveBeenCalled();
  });

  it("해제가 실패해도(FCM 오류) 등록 응답은 그대로 — 응답 뒤의 일도 throw하지 않는다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    session = { user: { id: "u-elder", screeningMode: "user" } };
    queryRows = [{ token: TOKEN, user_id: "u-guardian-A" }];
    unsubscribeFromTopic.mockRejectedValueOnce(new Error("fcm down"));
    expect(await call("POST", BODY)).toEqual({ status: 200, body: { ok: true, stored: false } });
    await expect(runAfter()).resolves.toBeUndefined();
    expect(unsubscribeFromTopic).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("테이블이 없으면 지울 행도 없다(그대로 진행) · 그 밖의 DB 실패는 삼키지 않는다(보호자는 그래도 토픽 구독은 한다)", async () => {
    session = { user: { id: "u-elder", screeningMode: "user" } };
    queryError = missingTable();
    // resolves로 본다 — 테이블 없음이 새면(500) 응답 단언으로 실패한다
    await expect(call("POST", BODY)).resolves.toEqual({ status: 200, body: { ok: true, stored: false } });
    queryError = new Error("connection refused");
    // 🔒 지우지 못했는데 성공으로 답하면 다른 계정 행이 남아 그 계정 앞 실명 사본이 이 휴대폰으로 간다 — 앱은 실패를 받고 다시 보고한다
    await expect(call("POST", BODY)).rejects.toThrow(/connection refused/);
    session = { user: { id: "u-guardian", screeningMode: "guardian" } };
    await expect(call("POST", BODY)).rejects.toThrow(/connection refused/);
    expect(txLog).toEqual([]);
    await runAfter();
    expect(subscribeToTopic).toHaveBeenCalledWith([TOKEN], "maeum_u-guardian");
  });
});

describe("DELETE — 세션 계정의 그 휴대폰만 해제", () => {
  it("{ token }(로그아웃) — 세션 계정 + 그 토큰으로만 지우고, **토픽은 건드리지 않는다**", async () => {
    const r = await call("DELETE", { token: TOKEN, userId: "u-victim" });
    expect(r).toEqual({ status: 200, body: { ok: true, removed: 1 } });
    expect(execCalls).toEqual([{ sql: "DELETE FROM push_device WHERE token = $1 AND user_id = $2", params: [TOKEN, "u-guardian"] }]);
    await runAfter();
    // 🔒 서버가 여기서 토픽을 해제하면, 로그아웃이 확인되지 않아 되살린 구독(POST)과 FCM에서 엇갈려 로그인한 채 토픽 사본이
    //    빠진다(4차). 로그아웃한 휴대폰의 구독은 확인된 LOGOUT에서 앱이 토큰을 폐기해 끝낸다(app/RnBridge 계약)
    expect(unsubscribeFromTopic).not.toHaveBeenCalled();
    expect(subscribeToTopic).not.toHaveBeenCalled();
  });

  it("{ handle }(보호자 화면 '삭제') — 세션 계정 휴대폰 중 그것만, 그 계정 토픽에서 **먼저** 해제하고 행을 지운다 · 남의 휴대폰은 handle을 알아도 못 지운다", async () => {
    const other = "otherDeviceToken_" + "Z".repeat(60);
    queryRows = [deviceRow(TOKEN, "u-guardian"), deviceRow(other, "u-other")];
    expect(await call("DELETE", { handle: deviceHandle(TOKEN) })).toEqual({ status: 200, body: { ok: true, removed: 1 } });
    expect(queryCalls[0].params).toEqual([["u-guardian"]]);
    // 🔒 user_id = 세션 계정으로 묶는다 — 빠지면 handle만 알면 남의 계정 휴대폰 등록을 지운다
    expect(execCalls).toEqual([{ sql: "DELETE FROM push_device WHERE user_id = $1 AND token = ANY($2::text[])", params: ["u-guardian", [TOKEN]] }]);
    // 🔒 목록에서 지운 휴대폰은 그 앱이 해제를 모른다 — 서버가 끊지 않으면 토픽 사본(가린 이름)을 계속 받는다
    expect(unsubscribeFromTopic).toHaveBeenCalledWith([TOKEN], "maeum_u-guardian");
    // 🔒 행을 먼저 지우면 해제가 실패했을 때 목록에선 사라졌는데 그 휴대폰은 토픽 사본을 계속 받는다(5차)
    expect(order).toEqual(["unsubscribe", "exec"]);

    execCalls.length = 0;
    unsubscribeFromTopic.mockClear();
    // 멱등 — 이 계정 휴대폰이 아니면(또는 이미 지웠으면) 0, 토픽 해제도 하지 않는다
    expect(await call("DELETE", { handle: deviceHandle(other) })).toEqual({ status: 200, body: { ok: true, removed: 0 } });
    expect(execCalls).toEqual([]);
    expect(unsubscribeFromTopic).not.toHaveBeenCalled();
  });

  it("{ handle } 삭제 응답은 토픽 해제가 끝난 뒤에 — 10초 걸려도 기다렸다가, 해제가 확인되면 행을 지운다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    queryRows = [deviceRow(TOKEN, "u-guardian")];
    unsubscribeFromTopic.mockImplementationOnce((tokens) => new Promise<TopicMgmt>((resolve) => {
      setTimeout(() => resolve({ successCount: tokens.length, failureCount: 0, errors: [] }), 10_000);
    }));
    let settled: unknown = "pending";
    const p = call("DELETE", { handle: deviceHandle(TOKEN) }).then((r) => { settled = r; });
    await vi.advanceTimersByTimeAsync(9_999);
    // 🔒 해제를 기다리지 않으면 "삭제됨"을 본 보호자의 그 휴대폰이 토픽 사본을 계속 받을 수 있다
    expect(settled).toBe("pending");
    expect(execCalls).toEqual([]);   // 해제가 확인되기 전엔 행을 건드리지 않는다
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(settled).toEqual({ status: 200, body: { ok: true, removed: 1 } });
    expect(execCalls).toHaveLength(1);
  });

  it("{ handle } 토픽 해제가 15초 안에 끝나지 않으면 502 topic — 행은 그대로(다시 시도할 수 있다)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      queryRows = [deviceRow(TOKEN, "u-guardian")];
      unsubscribeFromTopic.mockImplementationOnce(() => new Promise<never>(() => {}));
      let settled: unknown = "pending";
      const p = call("DELETE", { handle: deviceHandle(TOKEN) }).then((r) => { settled = r; });
      await vi.advanceTimersByTimeAsync(14_999);
      // 🔒 일찍 자르면 FCM이 잠깐 느릴 때 멀쩡한 삭제가 실패로 끝난다
      expect(unsubscribeFromTopic).toHaveBeenCalledTimes(1);
      expect(settled).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toEqual({ status: 502, body: { ok: false, reason: "topic" } });
      expect(execCalls).toEqual([]);
      await p;
    } finally {
      warn.mockRestore();
    }
  });

  it("해제는 등록과 다른 레이트리밋 버킷 — 등록 한도가 차도 로그아웃·삭제는 된다", async () => {
    limitedKeys.add("push-device:u-guardian");
    expect((await call("POST", BODY)).status).toBe(429);
    // 🔒 같은 버킷이면 앱이 PUSH_TOKEN을 몰아 보낸 직후 로그아웃이 429로 실패해 등록이 남는다
    expect((await call("DELETE", { token: TOKEN })).status).toBe(200);
    expect(rateCalls.map(([k]) => k)).toEqual(["push-device:u-guardian", "push-device-del:u-guardian"]);
    expect(rateCalls[1]).toEqual(["push-device-del:u-guardian", 30, 60_000]);
  });

  it.each([
    ["FCM 오류(throw)", () => unsubscribeFromTopic.mockRejectedValueOnce(new Error("fcm down"))],
    ["토큰 해제 거절(failureCount)", () => unsubscribeFromTopic.mockResolvedValueOnce({ successCount: 0, failureCount: 1, errors: [{ index: 0, error: { code: "messaging/internal-error" } }] })],
  ])("목록 삭제의 토픽 해제가 실패하면(%s) 502 { ok:false, reason:'topic' } — 행은 지우지 않는다(5차)", async (_, fail) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    queryRows = [deviceRow(TOKEN, "u-guardian")];
    fail();
    // 🔒 예전엔 행부터 지우고 200 — 목록에선 사라졌는데 그 휴대폰은 토픽 사본을 계속 받았고, 보호자는 다시 지울 방법도 없었다
    expect(await call("DELETE", { handle: deviceHandle(TOKEN) })).toEqual({ status: 502, body: { ok: false, reason: "topic" } });
    expect(unsubscribeFromTopic).toHaveBeenCalledTimes(1);
    expect(execCalls).toEqual([]);
    warn.mockRestore();
  });

  it("해제가 실패해 남은 줄은 다시 누르면 지워진다 — 두 번째에 해제가 되면 200 removed 1", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    queryRows = [deviceRow(TOKEN, "u-guardian")];
    unsubscribeFromTopic.mockRejectedValueOnce(new Error("fcm down"));
    expect((await call("DELETE", { handle: deviceHandle(TOKEN) })).status).toBe(502);
    expect(await call("DELETE", { handle: deviceHandle(TOKEN) })).toEqual({ status: 200, body: { ok: true, removed: 1 } });
    expect(unsubscribeFromTopic).toHaveBeenCalledTimes(2);
    expect(execCalls).toHaveLength(1);
    warn.mockRestore();
  });

  /**
   * 앱을 지운 휴대폰(2026-10-07 6차) — FCM(IID)이 그 토큰을 "없는 기기"(NOT_FOUND → registration-token-not-registered)라고 답하면
   *   그 휴대폰은 토픽 사본을 받을 수 없다 — 이미 해제된 것이다. 예전엔 해제 실패(502)라 그 줄은 보호자 화면에서 끝내 지울 수 없었다.
   */
  it("{ handle } 해제가 '없는 기기'(IID NOT_FOUND)로 돌아오면 이미 해제된 것 — 행을 지우고 200", async () => {
    queryRows = [deviceRow(TOKEN, "u-guardian")];
    unsubscribeFromTopic.mockResolvedValueOnce({
      successCount: 0, failureCount: 1, errors: [{ index: 0, error: { code: "messaging/registration-token-not-registered" } }],
    });
    expect(await call("DELETE", { handle: deviceHandle(TOKEN) })).toEqual({ status: 200, body: { ok: true, removed: 1 } });
    expect(execCalls).toEqual([{ sql: "DELETE FROM push_device WHERE user_id = $1 AND token = ANY($2::text[])", params: ["u-guardian", [TOKEN]] }]);
  });

  /**
   * FCM을 쓸 수 없으면(2026-10-07 7차 — 자격증명 없음·다른 Firebase 프로젝트의 서비스 계정) 토픽 해제를 **확인할 수 없다** — 행은 그대로,
   *   503 { ok:false, reason:"unconfigured" }. 6차는 "이 서버는 토픽 사본을 안 보내니 해제할 것도 없다"며 행을 지우고 200을 줬지만, 그
   *   휴대폰의 FCM 구독은 그대로라 자격증명이 고쳐지는 순간 토픽 사본을 다시 받는다 — "삭제됨"이 거짓이었다. 보호자 화면은 다른 실패와
   *   같은 "다시 시도" 문구(app/expert/PushStatusBox). 안내 로그는 인스턴스당 한 번. 자격증명은 모듈을 처음 읽을 때 정해지므로 새로 읽는다.
   */
  it.each([
    ["자격증명 없음", ""],
    ["다른 Firebase 프로젝트의 서비스 계정", ACCOUNT("some-other-project")],
  ])("{ handle } FCM을 쓸 수 없으면(%s) 503 unconfigured — 행은 그대로, 해제도 없다, 안내 로그는 이 인스턴스에서 한 번", async (_, account) => {
    vi.resetModules();
    vi.stubEnv("FCM_SERVICE_ACCOUNT", account);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fresh = await import("@/app/api/push/device/route");
      const del = async () => {
        const res = await fresh.DELETE(new Request("http://localhost/api/push/device", {
          method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: deviceHandle(TOKEN) }),
        }));
        return { status: res.status, body: await res.json() as Record<string, unknown> };
      };
      queryRows = [deviceRow(TOKEN, "u-guardian")];
      // 🔒 지우고 200을 주면 보호자는 "삭제됨"을 보는데, 그 휴대폰은 자격증명이 고쳐지는 순간 토픽 사본(가린 이름)을 다시 받는다
      expect(await del()).toEqual({ status: 503, body: { ok: false, reason: "unconfigured" } });
      expect(await del()).toEqual({ status: 503, body: { ok: false, reason: "unconfigured" } });
      expect(unsubscribeFromTopic).not.toHaveBeenCalled();
      expect(execCalls).toEqual([]);
      // 🔒 삭제 시도마다 찍으면 로그가 쌓인다 — 인스턴스당 한 번
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("FCM을 쓸 수 없음 — 휴대폰 삭제를 미룬다"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      err.mockRestore();
      vi.stubEnv("FCM_SERVICE_ACCOUNT", ACCOUNT());
    }
  });

  it("로그인하지 않으면 401", async () => {
    session = null;
    expect((await call("DELETE", { token: TOKEN })).status).toBe(401);
    expect(execCalls).toEqual([]);
  });

  it("요청이 몰리면 429", async () => {
    rateOk = false;
    expect((await call("DELETE", { token: TOKEN })).status).toBe(429);
    expect(execCalls).toEqual([]);
  });

  it.each([
    [{}], [{ token: 1 }], [{ token: "short" }], ["not json"],
    [{ handle: "XYZ" }], [{ handle: "A".repeat(16) }], [{ handle: "a".repeat(15) }], [{ handle: 1234567890123456 }],
  ])("토큰·handle 형식이 틀리면 400 — %j", async (body) => {
    expect((await call("DELETE", body)).status).toBe(400);
    expect(execCalls).toEqual([]);
    expect(queryCalls).toEqual([]);
    expect(unsubscribeFromTopic).not.toHaveBeenCalled();
  });

  it("테이블이 없어도 200 — 해제할 등록이 없을 뿐(토픽은 건드리지 않는다)", async () => {
    execError = missingTable();
    expect(await call("DELETE", { token: TOKEN })).toEqual({ status: 200, body: { ok: true, removed: 0 } });
    expect(unsubscribeFromTopic).not.toHaveBeenCalled();
  });
});

describe("GET — 내 휴대폰 목록(토큰 없이)", () => {
  it("세션 계정의 휴대폰만, 토큰·계정 id는 빼고 handle을 준다", async () => {
    queryRows = [deviceRow(TOKEN, "u-guardian")];
    const r = await get();
    expect(r.status).toBe(200);
    expect(queryCalls[0].params).toEqual([["u-guardian"]]);
    expect(JSON.parse(r.text)).toEqual({
      devices: [{
        handle: deviceHandle(TOKEN),
        platform: "android", appVersion: "1.2.0", permission: "granted", channelBlocked: false, updatedAt: "2026-10-07T01:00:00.000Z",
      }],
    });
    // 🔒 토큰이 화면으로 나가면 그 휴대폰으로 알림을 보낼 수 있는 값이 새어 나간다
    expect(r.text).not.toContain(TOKEN.slice(0, 20));
    expect(r.text).not.toMatch(/"token"|u-guardian/);
  });

  it("로그인하지 않으면 401", async () => {
    session = null;
    expect((await get()).status).toBe(401);
    expect(queryCalls).toEqual([]);
  });

  it("테이블이 없으면 빈 목록", async () => {
    queryError = missingTable();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(JSON.parse((await get()).text)).toEqual({ devices: [] });
    expect(sendEach).not.toHaveBeenCalled();
    err.mockRestore();
  });
});

/**
 * 목록의 등록 토큰 점검(2026-10-07 4차) — FCM 시험 발송(dry run)으로 앱을 지운 휴대폰을 미리 걸러 지운다. 예전엔 다음 위급
 *   알림 때에야 알아내, 그때까지 보호자 화면이 앱을 지운 휴대폰을 "받는 휴대폰"으로 보여 줬다.
 *   계정마다 다른 세션 id를 쓴다 — 10분 점검 기록이 이 파일의 테스트 사이에 남는다(라우트 모듈 메모리).
 */
describe("GET — 앱을 지운 휴대폰은 시험 발송(dry run)으로 걸러 지운다(계정당 10분에 한 번)", () => {
  const gone = () => sendEach.mockImplementation(async (msgs) => ({
    successCount: msgs.length - 1, failureCount: 1,
    responses: (msgs as { token: string }[]).map((m) => (m.token === GONE
      ? { success: false, error: { code: "messaging/registration-token-not-registered", message: "gone" } }
      : { success: true })),
  }));
  const handles = (text: string) => (JSON.parse(text) as { devices: { handle: string }[] }).devices.map((d) => d.handle);

  it("시험 발송(dry run)에서 '없는 기기'인 휴대폰은 지우고 목록에서도 뺀다", async () => {
    session = { user: { id: "u-check-gone" } };
    queryRows = [deviceRow(TOKEN, "u-check-gone"), deviceRow(GONE, "u-check-gone")];
    gone();
    const r = await get();
    expect(r.status).toBe(200);
    // 🔒 dry run이 아니면 목록을 열 때마다 보호자 휴대폰에 진짜 위급 알림이 울린다
    expect(sendEach).toHaveBeenCalledTimes(1);
    expect(sendEach.mock.calls[0][1]).toBe(true);
    expect(handles(r.text)).toEqual([deviceHandle(TOKEN)]);
    expect(execCalls).toEqual([{ sql: "DELETE FROM push_device WHERE token = ANY($1::text[])", params: [[GONE]] }]);
  });

  it("계정당 10분에 한 번만 — 그 안의 목록 요청은 점검하지 않는다(다른 계정은 따로)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-07T03:00:00Z"));
    session = { user: { id: "u-check-cache" } };
    queryRows = [deviceRow(TOKEN, "u-check-cache")];
    await get();
    vi.setSystemTime(new Date("2026-10-07T03:09:59Z"));
    await get();
    // 🔒 목록을 열 때마다 FCM을 부르면 화면 하나가 FCM 한도를 갉아먹는다
    expect(sendEach).toHaveBeenCalledTimes(1);
    session = { user: { id: "u-check-cache-2" } };
    await get();
    expect(sendEach).toHaveBeenCalledTimes(2);
    session = { user: { id: "u-check-cache" } };
    vi.setSystemTime(new Date("2026-10-07T03:10:00Z"));
    await get();
    expect(sendEach).toHaveBeenCalledTimes(3);
  });

  it("휴대폰이 0대면 FCM을 부르지 않고 점검 기록도 남기지 않는다", async () => {
    session = { user: { id: "u-check-empty" } };
    await get();
    expect(sendEach).not.toHaveBeenCalled();
    queryRows = [deviceRow(TOKEN, "u-check-empty")];
    await get();
    expect(sendEach).toHaveBeenCalledTimes(1);
  });

  it("점검이 실패하면(FCM 오류) 무시하고 목록 그대로 — 아무것도 지우지 않는다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    session = { user: { id: "u-check-fail" } };
    queryRows = [deviceRow(TOKEN, "u-check-fail"), deviceRow(GONE, "u-check-fail")];
    sendEach.mockRejectedValueOnce(new Error("fcm down"));
    const r = await get();
    expect(r.status).toBe(200);
    expect(handles(r.text)).toEqual([deviceHandle(TOKEN), deviceHandle(GONE)]);
    expect(execCalls).toEqual([]);
    warn.mockRestore();
  });

  it("지우기가 실패해도 목록은 그대로(200)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    session = { user: { id: "u-check-delfail" } };
    queryRows = [deviceRow(TOKEN, "u-check-delfail"), deviceRow(GONE, "u-check-delfail")];
    gone();
    execError = new Error("db down");
    const r = await get();
    expect(r.status).toBe(200);
    expect(handles(r.text)).toEqual([deviceHandle(TOKEN), deviceHandle(GONE)]);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("앱을 지운 휴대폰 삭제 실패"))).toBe(true);
    warn.mockRestore();
  });

  it("점검이 5초 넘게 걸리면 기다리지 않고 목록 그대로", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      session = { user: { id: "u-check-slow" } };
      queryRows = [deviceRow(TOKEN, "u-check-slow")];
      sendEach.mockImplementationOnce(() => new Promise<never>(() => {}));
      let settled: unknown = "pending";
      const p = get().then((r) => { settled = r; });
      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toMatchObject({ status: 200 });
      await p;
    } finally {
      warn.mockRestore();
    }
  });
});
