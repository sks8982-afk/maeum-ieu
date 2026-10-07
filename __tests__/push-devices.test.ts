/**
 * 위급 알림 휴대폰 등록부(lib/push/devices) — raw 문장과 검사 규칙을 고정한다.
 *
 * 2026-10-07: FCM 토픽(maeum_<id>)은 구독 권한 검사가 없고, 서버는 받는 기기가 있는지 몰랐다(구독자 0명이어도 성공).
 *   기기 토큰 등록부로 바꾸면서 지켜야 할 것:
 *   · 토큰은 **세션 계정**에 붙고, 같은 토큰을 다른 계정이 등록하면 그 계정으로 옮긴다(넘겨받은 휴대폰)
 *   · 해제는 **그 계정의 그 토큰만** — 남의 계정에 옮겨 간 같은 토큰은 건드리지 않는다
 *   · 테이블이 없으면(운영 스크립트보다 배포가 먼저) 조회는 "등록 없음", 그 밖의 실패는 숨기지 않는다
 *   · 형식이 틀린 토큰·알림 상태는 받지 않는다(꺼진 휴대폰이 "받는 중"으로 보이지 않게)
 *
 * 목 체제: prisma raw 문은 실행하지 않고 **문장 기술자**로 기록한다($executeRawUnsafe는 1로 끝나는 프라미스 + sql/params).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Stmt = { sql: string; params: unknown[] };
const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

let queryRows: Record<string, unknown>[] = [];
let queryError: Error | null = null;
let execError: Error | null = null;
const queryCalls: Stmt[] = [];
const execCalls: Stmt[] = [];
const txLog: Stmt[][] = [];

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
      return Object.assign(execError ? Promise.reject(execError) : Promise.resolve(1), stmt);
    }),
    $transaction: vi.fn(async (stmts: Stmt[]) => {
      txLog.push(stmts.map((s) => ({ sql: s.sql, params: s.params })));
      return stmts.map(() => 1);
    }),
  },
}));

const devices = await import("@/lib/push/devices");
const missingTable = () => new Error(`Raw query failed. Code: \`42P01\`. Message: \`relation "push_device" does not exist\``);
const TOKEN = "fcmTok_" + "a".repeat(40) + ":APA91b-x_y";

beforeEach(() => {
  queryRows = [];
  queryError = null;
  execError = null;
  queryCalls.length = 0;
  execCalls.length = 0;
  txLog.length = 0;
});

describe("토큰 모양 검사", () => {
  it.each([
    ["a".repeat(19), false], ["a".repeat(20), true], ["a".repeat(4096), true], ["a".repeat(4097), false],
    [TOKEN, true], ["a".repeat(20) + " ", false], ["a".repeat(20) + "/", false], ["a".repeat(20) + ".", false],
    ["a".repeat(20) + "\n", false], [12345678901234567890, false], [null, false], [undefined, false], [{ token: TOKEN }, false],
  ])("isValidPushToken(%j) → %s", (v, ok) => {
    expect(devices.isValidPushToken(v)).toBe(ok);
  });
});

describe("등록 본문 검사", () => {
  const base = { token: TOKEN, appVersion: "1.2.0", permission: "granted", channelBlocked: false };

  it("정상 본문 — 계정(userId)은 본문에서 받지 않는다", () => {
    const r = devices.parseDeviceRegistration({ ...base, userId: "attacker" });
    // 🔒 본문의 userId를 쓰면 남의 계정에 내 휴대폰을 붙여 그 계정의 위급 알림(실명)을 받는다
    expect(r).toEqual({ token: TOKEN, appVersion: "1.2.0", permission: "granted", channelBlocked: false });
  });

  it.each([
    ["permission 오타", { ...base, permission: "allowed" }],
    ["permission 없음", { ...base, permission: undefined }],
    ["channelBlocked 문자열", { ...base, channelBlocked: "true" }],
    ["channelBlocked 없음", { ...base, channelBlocked: undefined }],
    ["토큰 형식 오류", { ...base, token: "short" }],
  ])("%s → null(400) — 꺼진 휴대폰이 받는 중으로 보이지 않게", (_, body) => {
    expect(devices.parseDeviceRegistration(body)).toBeNull();
  });

  it.each([null, "x", 1, []])("객체가 아니면 null — %j", (body) => {
    expect(devices.parseDeviceRegistration(body)).toBeNull();
  });

  it("이상한 앱 버전은 비우고 등록은 받는다(표시용일 뿐)", () => {
    expect(devices.parseDeviceRegistration({ ...base, appVersion: "<b>1</b>" })?.appVersion).toBeNull();
    expect(devices.parseDeviceRegistration({ ...base, appVersion: "x".repeat(33) })?.appVersion).toBeNull();
    expect(devices.parseDeviceRegistration({ ...base, appVersion: undefined })?.appVersion).toBeNull();
  });
});

/**
 * 폐기 토큰(retiredTokens, 2026-10-07 3차) — 이 휴대폰이 지난 등록 뒤 deleteToken()으로 버린 토큰. 등록하면서 그 행을 지운다.
 *   검사: 토큰 모양인 것만, 지금 토큰은 빼고, 앞에서부터 MAX_RETIRED_TOKENS(5)개까지. 틀린 값이 섞여도 등록은 받는다.
 */
describe("등록 본문의 폐기 토큰 검사", () => {
  const base = { token: TOKEN, appVersion: "1.2.0", permission: "granted", channelBlocked: false };
  const R = (n: number) => `retiredTok${n}_` + "q".repeat(30);

  it("형식이 틀린 값·너무 긴 값은 버리고 지금 토큰은 빼며, 앞에서부터 5개까지", () => {
    expect(devices.MAX_RETIRED_TOKENS).toBe(5);
    const r = devices.parseDeviceRegistration({
      ...base,
      retiredTokens: ["short", R(1), 42, null, "z".repeat(4097), TOKEN, R(2), R(3), R(4), R(5), R(6), R(7)],
    });
    // 🔒 지금 토큰을 지우면 방금 한 등록이 사라진다 / 상한이 없으면 본문 하나로 DELETE 범위가 끝없이 커진다
    expect(r?.retiredTokens).toEqual([R(1), R(2), R(3), R(4), R(5)]);
    // 나머지 필드는 그대로 — 폐기 토큰이 등록을 바꾸지 않는다
    expect(r).toMatchObject(base);
  });

  it.each([["문자열", "abc"], ["객체", { a: R(1) }], ["null", null], ["빈 배열", []], ["모두 틀림", ["x", 1, TOKEN]]])(
    "%s → 필드 없음, 등록은 받는다(지우기는 정리일 뿐 — 등록이 막히면 실명 사본이 빠진다)", (_, v) => {
      let r = null as ReturnType<typeof devices.parseDeviceRegistration>;
      expect(() => { r = devices.parseDeviceRegistration({ ...base, retiredTokens: v }); }).not.toThrow();
      expect(r).not.toBeNull();
      expect(r && "retiredTokens" in r).toBe(false);
    },
  );

  it("필드가 없으면 예전 모양 그대로", () => {
    const r = devices.parseDeviceRegistration(base);
    expect(r).toEqual(base);
    expect(r && "retiredTokens" in r).toBe(false);
  });
});

describe("등록 — 세션 계정으로, 같은 토큰은 이 계정으로 옮긴다", () => {
  it("upsert + 계정당 상한 정리를 한 트랜잭션으로", async () => {
    await devices.registerDevice("u-guardian", { token: TOKEN, appVersion: "1.2.0", permission: "denied", channelBlocked: true });
    expect(txLog).toHaveLength(1);
    const [upsert, prune] = txLog[0];
    expect(upsert.sql).toMatch(/^INSERT INTO push_device \(token, user_id, app_version, permission, channel_blocked/);
    // 🔒 ON CONFLICT에서 user_id를 바꾸지 않으면 넘겨받은 휴대폰이 이전 계정의 위급 알림을 계속 받는다
    expect(upsert.sql).toMatch(/ON CONFLICT \(token\) DO UPDATE SET user_id = EXCLUDED\.user_id/);
    expect(upsert.sql).toMatch(/permission = EXCLUDED\.permission, channel_blocked = EXCLUDED\.channel_blocked, updated_at = now\(\)/);
    expect(upsert.params).toEqual([TOKEN, "u-guardian", "1.2.0", "denied", true]);
    // 🔒 상한이 없으면 한 계정이 가짜 토큰을 쌓아 같은 어르신의 다른 보호자 알림까지 막는다(sendEach 500건 상한)
    expect(prune.sql).toBe(
      `DELETE FROM push_device WHERE user_id = $1 AND token NOT IN ( SELECT token FROM push_device WHERE user_id = $1 ORDER BY updated_at DESC LIMIT ${devices.MAX_DEVICES_PER_USER})`,
    );
    expect(prune.params).toEqual(["u-guardian"]);
    // 폐기 토큰이 없으면 예전 그대로 두 문장
    expect(txLog[0]).toHaveLength(2);
  });

  it("폐기 토큰이 있으면 그 행을 **계정과 무관하게** 맨 먼저 지운다(같은 트랜잭션) — 다른 계정에 남은 행도", async () => {
    const OLD = "oldTokenOfThisPhone_" + "o".repeat(40);   // 로그아웃 해제가 실패해 이전 계정에 남은 이 휴대폰의 옛 토큰
    await devices.registerDevice("u-guardian", {
      token: TOKEN, appVersion: "1.2.0", permission: "granted", channelBlocked: false, retiredTokens: [OLD],
    });
    expect(txLog).toHaveLength(1);
    const [retire, upsert, prune] = txLog[0];
    // 🔒 user_id 조건이 붙으면 이전 계정의 그 행은 남는다 — 그 토큰을 들고 있다는 게 이 휴대폰 것이었다는 증거다
    expect(retire).toEqual({ sql: "DELETE FROM push_device WHERE token = ANY($1::text[])", params: [[OLD]] });
    expect(retire.sql).not.toMatch(/user_id/);
    // 🔒 정리(상한 10대)보다 먼저 — 죽은 토큰이 자리를 차지해 살아 있는 휴대폰이 밀려나지 않게
    expect(upsert.sql).toMatch(/^INSERT INTO push_device/);
    expect(prune.sql).toMatch(/^DELETE FROM push_device WHERE user_id = \$1 AND token NOT IN/);
    expect(txLog[0]).toHaveLength(3);
  });
});

/**
 * 다른 계정의 이 휴대폰 행 풀어 내기(2026-10-07 6차) — 등록 요청이 **역할과 상관없이** 부른다(app/api/push/device POST). 휴대폰은
 *   지금 로그인한 계정의 알림만 받아야 한다 — 어르신이 이전 보호자 휴대폰에 로그인해도 그 보호자 행이 남아 실명 사본이 이 휴대폰에
 *   가던 구멍. 지운 행의 계정은 호출부가 그 계정 토픽에서 이 토큰을 해제하는 데 쓴다.
 */
describe("다른 계정의 이 휴대폰 행 풀어 내기", () => {
  const OLD = "oldTokenOfThisPhone_" + "o".repeat(40);

  it("지금 토큰·폐기 토큰 중 **다른 계정** 행만 한 문장으로 지우고(DELETE … RETURNING) 그 행의 계정을 돌려준다", async () => {
    queryRows = [{ token: TOKEN, user_id: "u-guardian-A" }, { token: OLD, user_id: "u-pro-C" }];
    expect(await devices.releaseFromOtherAccounts("u-elder", [TOKEN, OLD])).toEqual([
      { token: TOKEN, userId: "u-guardian-A" }, { token: OLD, userId: "u-pro-C" },
    ]);
    // 🔒 "user_id <> 세션 계정"이 빠지면 보호자가 자기 휴대폰을 다시 등록할 때마다 자기 행을 지우고 자기 토픽에서 해제한다
    // 🔒 지우기와 계정 읽기가 한 문장이어야 읽은 뒤 행이 옮겨 가 엉뚱한 계정 토픽을 해제하는 일이 없다
    expect(queryCalls).toEqual([{
      sql: "DELETE FROM push_device WHERE token = ANY($1::text[]) AND user_id <> $2 RETURNING token, user_id",
      params: [[TOKEN, OLD], "u-elder"],
    }]);
    expect(execCalls).toEqual([]);
  });

  it("토큰이 없으면 DB를 치지 않는다 · 테이블이 없으면 [](지울 행도 없다) · 그 밖의 실패는 throw", async () => {
    expect(await devices.releaseFromOtherAccounts("u-elder", [])).toEqual([]);
    expect(queryCalls).toEqual([]);
    queryError = missingTable();
    // resolves로 본다 — 테이블 없음이 새면 "throw하지 않는다"는 단언으로 실패한다(던져진 오류로 흐려지지 않게)
    await expect(devices.releaseFromOtherAccounts("u-elder", [TOKEN])).resolves.toEqual([]);
    queryError = new Error("connection refused");
    await expect(devices.releaseFromOtherAccounts("u-elder", [TOKEN])).rejects.toThrow(/connection refused/);
  });
});

describe("조회", () => {
  it("요청 계정이 없으면 DB를 치지 않는다", async () => {
    expect(await devices.getDevices([])).toEqual([]);
    expect(queryCalls).toEqual([]);
  });

  it("계정 목록으로 찾고 최근 확인 순 — 행을 앱 모양으로 바꾼다", async () => {
    const at = new Date("2026-10-07T01:00:00Z");
    queryRows = [{ token: TOKEN, user_id: "g1", platform: "android", app_version: "1.2.0", permission: "granted", channel_blocked: false, updated_at: at }];
    const r = await devices.getDevices(["g1", "g2"]);
    expect(queryCalls[0].sql).toMatch(/FROM push_device WHERE user_id = ANY\(\$1::text\[\]\) ORDER BY updated_at DESC$/);
    expect(queryCalls[0].params).toEqual([["g1", "g2"]]);
    expect(r).toEqual([{ token: TOKEN, userId: "g1", platform: "android", appVersion: "1.2.0", permission: "granted", channelBlocked: false, updatedAt: at }]);
  });

  it("테이블이 없으면 빈 목록 — 장애가 아니라 등록 없음", async () => {
    queryError = missingTable();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await devices.getDevices(["g1"])).toEqual([]);
    expect(err.mock.calls.some((c) => String(c[0]).includes("ops-push-device"))).toBe(true);
    err.mockRestore();
  });

  it("그 밖의 실패는 숨기지 않는다(throw)", async () => {
    queryError = new Error("connection refused");
    await expect(devices.getDevices(["g1"])).rejects.toThrow(/connection refused/);
  });

  /**
   * 위급 알림 경로용(queryDevices, 2026-10-07 4차) — 테이블이 없다는 사실을 **숨기지 않는다**. 위급 알림은 그걸 알아야
   *   0대로 보내면서 운영자에게 알릴 수 있다(lib/chat/emergency-notify). 화면 경로(getDevices)는 계속 빈 목록이다.
   */
  it("queryDevices — 테이블이 없어도 throw(삼키지 않는다), 같은 문장·같은 모양", async () => {
    queryError = missingTable();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(devices.queryDevices(["g1"])).rejects.toThrow(/42P01/);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
    queryError = null;
    const at = new Date("2026-10-07T01:00:00Z");
    queryRows = [{ token: TOKEN, user_id: "g1", platform: "android", app_version: null, permission: "denied", channel_blocked: true, updated_at: at }];
    expect(await devices.queryDevices(["g1"])).toEqual([{ token: TOKEN, userId: "g1", platform: "android", appVersion: null, permission: "denied", channelBlocked: true, updatedAt: at }]);
    expect(queryCalls.at(-1)?.sql).toMatch(/FROM push_device WHERE user_id = ANY\(\$1::text\[\]\) ORDER BY updated_at DESC$/);
    queryCalls.length = 0;
    expect(await devices.queryDevices([])).toEqual([]);
    expect(queryCalls).toEqual([]);
  });
});

describe("해제·삭제", () => {
  it("해제는 그 계정의 그 토큰만", async () => {
    expect(await devices.unregisterDevice("u-guardian", TOKEN)).toBe(1);
    // 🔒 user_id 조건이 빠지면 남의 계정으로 옮겨 간 같은 토큰까지 지워 그 사람 알림이 끊긴다
    expect(execCalls).toEqual([{ sql: "DELETE FROM push_device WHERE token = $1 AND user_id = $2", params: [TOKEN, "u-guardian"] }]);
  });

  it("테이블이 없으면 해제할 것도 없다(0) — 그 밖의 실패는 throw", async () => {
    execError = missingTable();
    expect(await devices.unregisterDevice("u", TOKEN)).toBe(0);
    execError = new Error("connection refused");
    await expect(devices.unregisterDevice("u", TOKEN)).rejects.toThrow(/connection refused/);
  });

  it("죽은 토큰 삭제 — 빈 목록이면 DB를 치지 않는다", async () => {
    expect(await devices.deleteTokens([])).toBe(0);
    expect(execCalls).toEqual([]);
    await devices.deleteTokens([TOKEN, "b".repeat(30)]);
    expect(execCalls).toEqual([{ sql: "DELETE FROM push_device WHERE token = ANY($1::text[])", params: [[TOKEN, "b".repeat(30)]] }]);
  });
});

/**
 * handle(2026-10-07) — 보호자 화면이 목록의 휴대폰을 가리키는 값. 토큰은 화면에 내보내지 않는다(그 휴대폰으로 알림을
 *   보낼 수 있는 값이다). 앱 안 화면은 같은 규칙(crypto.subtle)으로 "이 휴대폰"을 찾으므로 규칙이 바뀌면 둘 다 바꿔야 한다.
 */
describe("handle — 토큰 대신 화면에 내보내는 휴대폰 식별자", () => {
  it("토큰 sha256의 앞 16자(소문자 hex) — 같은 토큰은 늘 같은 값, 토큰마다 다르다", async () => {
    const { createHash } = await import("node:crypto");
    const h = devices.deviceHandle(TOKEN);
    expect(h).toBe(createHash("sha256").update(TOKEN).digest("hex").slice(0, 16));
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(devices.deviceHandle(TOKEN)).toBe(h);
    expect(devices.deviceHandle(TOKEN + "x")).not.toBe(h);
    expect(h).not.toContain(TOKEN.slice(0, 8));
  });

  it.each([
    ["a".repeat(16), true], ["0123456789abcdef", true], ["A".repeat(16), false], ["a".repeat(15), false], ["a".repeat(17), false],
    ["g".repeat(16), false], [12, false], [null, false], [TOKEN, false],
  ])("isValidDeviceHandle(%j) → %s", (v, ok) => {
    expect(devices.isValidDeviceHandle(v)).toBe(ok);
  });

  /**
   * handle로 찾기와 지우기는 따로다(2026-10-07 5차) — 호출부(app/api/push/device DELETE { handle })가 그 휴대폰을 계정 토픽에서
   *   먼저 해제하고, 확인돼야 지운다. 찾기는 아무것도 지우지 않는다.
   */
  it("handle로 찾기 — 세션 계정 휴대폰 안에서만, 찾기만 하고 지우지 않는다", async () => {
    const other = "otherTok_" + "o".repeat(40);
    queryRows = [
      { token: TOKEN, user_id: "u-guardian", platform: "android", app_version: "1.2.0", permission: "granted", channel_blocked: false, updated_at: new Date() },
      // 조회가 (잘못해서라도) 남의 행을 돌려줘도 그 휴대폰은 찾지 않는다
      { token: other, user_id: "u-other", platform: "android", app_version: "1.2.0", permission: "granted", channel_blocked: false, updated_at: new Date() },
    ];
    expect(await devices.tokensForHandle("u-guardian", devices.deviceHandle(TOKEN))).toEqual([TOKEN]);
    expect(queryCalls[0].params).toEqual([["u-guardian"]]);
    // 🔒 찾기가 지우기까지 하면 토픽 해제가 실패해도 행이 사라진다(목록에선 없는데 그 휴대폰은 토픽 사본을 계속 받는다)
    expect(execCalls).toEqual([]);
    // 🔒 user_id 조건이 빠지면 handle만 알면 남의 계정 휴대폰을 가리킬 수 있다
    expect(await devices.tokensForHandle("u-guardian", devices.deviceHandle(other))).toEqual([]);
  });

  it("맞는 휴대폰이 없거나 테이블이 없으면 빈 목록", async () => {
    expect(await devices.tokensForHandle("u-guardian", "0".repeat(16))).toEqual([]);
    queryError = missingTable();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await devices.tokensForHandle("u-guardian", "0".repeat(16))).toEqual([]);
    expect(execCalls).toEqual([]);
    err.mockRestore();
  });

  it("그 토큰들만 해제 — 지울 때도 user_id로 묶는다, 빈 목록이면 DB를 치지 않는다", async () => {
    expect(await devices.unregisterDeviceTokens("u-guardian", [])).toBe(0);
    expect(execCalls).toEqual([]);
    expect(await devices.unregisterDeviceTokens("u-guardian", [TOKEN])).toBe(1);
    // 🔒 user_id 조건이 빠지면 남의 계정으로 옮겨 간 같은 토큰까지 지워 그 사람 알림이 끊긴다
    expect(execCalls).toEqual([{ sql: "DELETE FROM push_device WHERE user_id = $1 AND token = ANY($2::text[])", params: ["u-guardian", [TOKEN]] }]);
  });
});

describe("계정별 집계 — 토큰 없이 개수만", () => {
  it("대수·알림 허용 대수·마지막 확인 — 요청한 계정은 0대여도 들어 있다", async () => {
    const old = new Date("2026-10-01T00:00:00Z");
    const recent = new Date("2026-10-07T00:00:00Z");
    queryRows = [
      { token: "t1".repeat(10), user_id: "g1", platform: "android", app_version: null, permission: "granted", channel_blocked: false, updated_at: old },
      { token: "t2".repeat(10), user_id: "g1", platform: "android", app_version: null, permission: "granted", channel_blocked: true, updated_at: recent },
      { token: "t3".repeat(10), user_id: "g2", platform: "android", app_version: null, permission: "unknown", channel_blocked: false, updated_at: old },
      { token: "t4".repeat(10), user_id: "stranger", platform: "android", app_version: null, permission: "granted", channel_blocked: false, updated_at: old },
    ];
    const s = await devices.summarizeDevices(["g1", "g2", "g3"]);
    // 🔒 채널을 막은 휴대폰·권한 모름은 "받는 중"으로 세지 않는다
    expect(s.get("g1")).toEqual({ count: 2, granted: 1, lastSeenAt: recent });
    expect(s.get("g2")).toEqual({ count: 1, granted: 0, lastSeenAt: old });
    expect(s.get("g3")).toEqual({ count: 0, granted: 0, lastSeenAt: null });
    expect(s.has("stranger")).toBe(false);
    expect(JSON.stringify([...s.values()])).not.toMatch(/t1t1|token/);
  });

  it.each([
    [{ permission: "granted", channelBlocked: false }, true],
    [{ permission: "granted", channelBlocked: true }, false],
    [{ permission: "denied", channelBlocked: false }, false],
    [{ permission: "unknown", channelBlocked: false }, false],
  ])("isReadyDevice(%j) → %s", (d, ok) => {
    expect(devices.isReadyDevice(d)).toBe(ok);
  });
});
