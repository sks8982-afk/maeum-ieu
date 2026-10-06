/**
 * 민감정보 별도 동의(목소리 등록·상시 감시) — /api/users/sensitive-consent **행위** 테스트.
 *
 * 2026-10-06 이전: 성문(생체인식정보)·상시 감시에 대한 동의를 받거나 기록하는 수단이 없었다.
 *   (화면엔 "⚠ 사용 전 환자·가족의 동의가 필요합니다" 문구뿐, 동의서·처리방침에도 없었다)
 *
 * 고정하는 것:
 *   · 구분 동의 — 상시 감시는 처리·제공을 각각 받되 둘 다 있어야 기록된다(반쪽 동의 금지)
 *   · 동의는 어르신 본인 계정 + 건강정보 동의를 마친 경우만
 *   · 철회는 언제나 되고, 철회와 파기는 한 트랜잭션
 *   · 동의 테이블이 없으면(배포 순서 어긋남) "동의 없음" — 장애로 보지 않는다
 *
 * 목 체제: prisma의 raw 문은 실행하지 않고 **문장 기술자**로 기록한다($transaction에 들어간 순서 그대로).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Stmt = { type: "raw"; sql: string; params: unknown[] } | { type: "deleteMany"; args: unknown };

let session: { user: { id: string; screeningMode?: string } } | null = { user: { id: "u-elder", screeningMode: "user" } };
const users: Record<string, { consentedAt: Date | null; screeningMode: string }> = {};
let consentRows: Record<string, { kind: string; version: string }[]> = {};
let queryError: Error | null = null;
const txLog: Stmt[][] = [];
const txErrors: Error[] = [];

vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users[where.id] ?? null) },
    $queryRawUnsafe: vi.fn(async (sql: string, uid: string) => {
      if (queryError) throw queryError;
      if (sql.includes("sensitive_consent")) return consentRows[uid] ?? [];
      return [];
    }),
    $executeRawUnsafe: (sql: string, ...params: unknown[]): Stmt => ({ type: "raw", sql: sql.replace(/\s+/g, " ").trim(), params }),
    message: { deleteMany: (args: unknown): Stmt => ({ type: "deleteMany", args }) },
    $transaction: vi.fn(async (stmts: Stmt[]) => {
      const err = txErrors.shift();
      if (err) throw err;
      txLog.push(stmts);
      return stmts.map(() => 1);
    }),
  },
}));

const route = await import("@/app/api/users/sensitive-consent/route");
const { SENSITIVE_CONSENT_VERSION, getActiveSensitiveConsents } = await import("@/lib/sensitive-consent");
const missingTable = () => new Error(`Raw query failed. Code: \`42P01\`. Message: \`relation "sensitive_consent" does not exist\``);

async function post(body: unknown) {
  const res = await route.POST(new Request("http://localhost/api/users/sensitive-consent", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function del(kind: string) {
  const res = await route.DELETE(new Request(`http://localhost/api/users/sensitive-consent?kind=${kind}`, { method: "DELETE" }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function get() {
  const res = await route.GET();
  return await res.json() as Record<string, unknown>;
}
const active = (...kinds: ("voiceprint" | "observe" | "observe_share")[]) =>
  kinds.map((kind) => ({ kind, version: SENSITIVE_CONSENT_VERSION[kind] }));
const sqls = (tx: Stmt[]) => tx.map((s) => (s.type === "raw" ? s.sql.split(" ").slice(0, 3).join(" ") : "deleteMany"));

beforeEach(() => {
  session = { user: { id: "u-elder", screeningMode: "user" } };
  for (const k of Object.keys(users)) delete users[k];
  users["u-elder"] = { consentedAt: new Date("2026-01-01"), screeningMode: "user" };
  consentRows = {};
  queryError = null;
  txLog.length = 0;
  txErrors.length = 0;
});

describe("조회", () => {
  it("상시 감시는 처리·제공 둘 다 있어야 동의로 본다", async () => {
    consentRows["u-elder"] = active("observe");
    expect((await get()).observe).toBe(false);
    consentRows["u-elder"] = active("observe", "observe_share");
    expect((await get()).observe).toBe(true);
  });

  it("문안 버전이 바뀌기 전의 동의는 효력이 없다 — 재동의를 받는다", async () => {
    consentRows["u-elder"] = [{ kind: "voiceprint", version: "0.9" }];
    // 🔒 건강정보 동의(CONSENT_VERSION)는 버전을 비교하지 않아 올려도 재동의가 안 됐다
    expect((await get()).voiceprint).toBe(false);
    consentRows["u-elder"] = active("voiceprint");
    expect((await get()).voiceprint).toBe(true);
  });

  it("동의 테이블이 없으면(운영 스크립트 전 배포) 동의 없음 — 장애로 보지 않는다", async () => {
    queryError = missingTable();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await getActiveSensitiveConsents("u-elder")).size).toBe(0);
  });

  it("그 밖의 조회 실패는 숨기지 않는다(throw)", async () => {
    queryError = new Error("connection refused");
    await expect(getActiveSensitiveConsents("u-elder")).rejects.toThrow(/connection refused/);
  });
});

describe("동의 기록", () => {
  it("목소리 등록 첫 동의 — 그 전에 남은 성문을 같은 트랜잭션에서 지우고 기록한다", async () => {
    const r = await post({ grant: ["voiceprint"] });
    expect(r.status).toBe(200);
    expect(txLog).toHaveLength(1);
    // 🔒 동의 전에 (평문으로) 만들어진 성문이 동의 뒤 대조에 섞이면 안 된다
    expect(sqls(txLog[0])).toEqual([
      "DELETE FROM speaker_voiceprint_sample", "DELETE FROM speaker_voiceprint", "INSERT INTO sensitive_consent",
    ]);
    const ins = txLog[0][2] as Extract<Stmt, { type: "raw" }>;
    expect(ins.params).toEqual(["u-elder", "voiceprint", SENSITIVE_CONSENT_VERSION.voiceprint]);
  });

  it("이미 유효한 동의를 다시 누르면 성문을 지우지 않는다", async () => {
    consentRows["u-elder"] = active("voiceprint");
    await post({ grant: ["voiceprint"] });
    expect(sqls(txLog[0])).toEqual(["INSERT INTO sensitive_consent"]);
  });

  it("상시 감시 — 처리·제공 두 동의를 한 트랜잭션으로 기록한다", async () => {
    const r = await post({ grant: ["observe", "observe_share"] });
    expect(r.status).toBe(200);
    expect(txLog[0].map((s) => (s as Extract<Stmt, { type: "raw" }>).params[1])).toEqual(["observe", "observe_share"]);
  });

  it.each([[["observe"]], [["observe_share"]], [["voiceprint", "observe"]]])(
    "상시 감시 동의를 반쪽만 보내면 400 — %j", async (grant) => {
      const r = await post({ grant });
      // 🔒 하나만 기록되면 화면은 동의한 것처럼 보이는데 게이트는 막는 반쪽 상태가 된다
      expect(r.status).toBe(400);
      expect(txLog).toEqual([]);
    });

  it.each([[[]], [["voiceprint", "evil"]], ["voiceprint"], [[1]]])("형식이 틀리면 400 — %j", async (grant) => {
    const r = await post({ grant });
    expect(r.status).toBe(400);
    expect(txLog).toEqual([]);
  });

  it.each(["guardian", "pro", "general"])("%s 계정은 403 wrongRole — 동의할 수 없다", async (role) => {
    session = { user: { id: `u-${role}`, screeningMode: role } };
    users[`u-${role}`] = { consentedAt: new Date(), screeningMode: role };
    const r = await post({ grant: ["voiceprint"] });
    expect(r.status).toBe(403);
    expect(r.body.wrongRole).toBe(true);
    expect(txLog).toEqual([]);
  });

  it("건강정보 동의 전이면 403 needConsent", async () => {
    users["u-elder"].consentedAt = null;
    const r = await post({ grant: ["voiceprint"] });
    expect(r.status).toBe(403);
    expect(r.body.needConsent).toBe(true);
    expect(txLog).toEqual([]);
  });

  it("동의 테이블이 없으면 503 notReady — 성문 삭제도 함께 롤백된다", async () => {
    txErrors.push(missingTable());
    const r = await post({ grant: ["voiceprint"] });
    expect(r.status).toBe(503);
    expect(r.body.notReady).toBe(true);
  });

  it("로그인하지 않으면 401", async () => {
    session = null;
    expect((await post({ grant: ["voiceprint"] })).status).toBe(401);
  });
});

describe("철회 — 언제나 되고, 파기와 한 트랜잭션", () => {
  it("목소리 등록 철회 = 성문(표본·대표) 삭제 + 철회 표시", async () => {
    const r = await del("voiceprint");
    expect(r.status).toBe(200);
    expect(sqls(txLog[0])).toEqual([
      "DELETE FROM speaker_voiceprint_sample", "DELETE FROM speaker_voiceprint", "UPDATE sensitive_consent SET",
    ]);
    expect((txLog[0][0] as Extract<Stmt, { type: "raw" }>).params).toEqual(["u-elder"]);
    expect((txLog[0][2] as Extract<Stmt, { type: "raw" }>).params).toEqual(["u-elder", "voiceprint"]);
  });

  it("상시 감시 철회 = 이 어르신의 상시 감시 기록 삭제 + 처리·제공 둘 다 철회", async () => {
    const r = await del("observe");
    expect(r.status).toBe(200);
    const [purge, w1, w2] = txLog[0];
    // 🔒 표지는 단일 출처(lib/chat/observation) — 다른 사람 기록이나 일반 대화를 지우면 안 된다
    expect(purge).toEqual({ type: "deleteMany", args: { where: { conversation: { userId: "u-elder" }, content: { startsWith: "[관찰]" } } } });
    expect([w1, w2].map((s) => (s as Extract<Stmt, { type: "raw" }>).params)).toEqual([["u-elder", "observe"], ["u-elder", "observe_share"]]);
  });

  it("역할·건강정보 동의와 무관하게 철회된다 — 지울 권리는 막지 않는다", async () => {
    session = { user: { id: "u-g", screeningMode: "guardian" } };
    users["u-g"] = { consentedAt: null, screeningMode: "guardian" };
    expect((await del("voiceprint")).status).toBe(200);
  });

  it("동의 테이블이 없어도 파기는 한다", async () => {
    txErrors.push(missingTable());
    const r = await del("voiceprint");
    expect(r.status).toBe(200);
    // 첫 트랜잭션(파기+철회 표시)은 실패, 두 번째는 파기만
    expect(sqls(txLog[0])).toEqual(["DELETE FROM speaker_voiceprint_sample", "DELETE FROM speaker_voiceprint"]);
  });

  it("그 밖의 실패는 삼키지 않는다 — 철회됐다고 거짓 응답하지 않는다", async () => {
    txErrors.push(new Error("connection refused"));
    await expect(del("observe")).rejects.toThrow(/connection refused/);
  });

  it("알 수 없는 항목은 400", async () => {
    expect((await del("observe_share")).status).toBe(400);
    expect(txLog).toEqual([]);
  });
});
