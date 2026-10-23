/**
 * 이용권 판정(lib/billing/entitlement getEntitlement) — 웹 PG(포트원) 구독의 상한.
 *
 * 지키는 것:
 *   · 포트원 구독은 **그 구독에 적어 둔 요금제 상한**(dailyTurnLimit — 가입 당시 값). Play는 기존 그대로(PRO_DAILY_TURN_LIMIT).
 *   · 여러 개가 겹치면 가장 큰 상한.
 *   · 포트원은 만료 시각이 반드시 있어야 혜택(Play의 '만료 정보 아직 없음 = 유효' 예외를 쓰지 않는다).
 *   · pending·activating·failed는 혜택 없음(결제가 끝나지 않았다).
 *   · 요금제 설정(BILLING_PLANS)이 깨져도 이미 낸 돈만큼의 혜택은 그대로.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface Row {
  productId: string; expiresAt: Date | null; beneficiaryUserId: string; purchaserUserId: string;
  status?: string; provider?: string; dailyTurnLimit?: number | null;
}
let rows: Row[] = [];
let lastWhere: { status?: { in?: string[] } } | null = null;
let todayCount = 0;
/** 웹 결제 컬럼이 아직 없는 DB(DDL보다 배포가 먼저 나간 경우) — 그 컬럼을 고르면 Prisma처럼 P2022 */
let missingPgColumns = false;

// 운영 DB처럼 상태 조건(where.status.in)은 걸러서 돌려준다 — 판정이 그 조건에 기대는지까지 본다
vi.mock("@/lib/prisma", () => ({
  prisma: {
    subscription: {
      findMany: vi.fn(async ({ where, select }: { where: { status?: { in?: string[] } }; select?: Record<string, boolean> }) => {
        lastWhere = where;
        if (missingPgColumns && (select?.provider || select?.dailyTurnLimit)) {
          throw Object.assign(new Error("The column `subscriptions.provider` does not exist in the current database."), { code: "P2022" });
        }
        return rows.filter((r) => !where.status?.in || where.status.in.includes(r.status ?? "active"));
      }),
    },
    message: { count: vi.fn(async () => todayCount) },
  },
}));

const ENV = ["DAILY_TURN_LIMIT", "PRO_DAILY_TURN_LIMIT", "BILLING_PRO_PRODUCT_IDS", "BILLING_PLANS"] as const;
const saved: Record<string, string | undefined> = {};

async function load(env: Partial<Record<(typeof ENV)[number], string>> = {}) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { DAILY_TURN_LIMIT: "10", ...env });
  vi.resetModules();
  return { ent: await import("@/lib/billing/entitlement"), usage: await import("@/lib/usage/daily-limit") };
}

const future = () => new Date(Date.now() + 10 * 86_400_000);
const past = () => new Date(Date.now() - 60_000);
const pgSub = (over: Partial<Row> = {}): Row => ({
  productId: "day30", expiresAt: future(), beneficiaryUserId: "elder-1", purchaserUserId: "guardian-1",
  status: "active", provider: "portone", dailyTurnLimit: 30, ...over,
});

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  rows = []; lastWhere = null; todayCount = 0; missingPgColumns = false;
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
});

describe("포트원 구독의 상한 — 가입 당시 요금제 상한", () => {
  it("하루 30회 요금제면 30 — PRO_DAILY_TURN_LIMIT(Play용)을 쓰지 않는다", async () => {
    rows = [pgSub()];
    const { ent } = await load({ PRO_DAILY_TURN_LIMIT: "300" });
    const e = await ent.getEntitlement("elder-1");
    expect(e.tier).toBe("pro");
    expect(e.dailyTurnLimit).toBe(30);
    expect(e.source).toBe("beneficiary");
  });

  it("결제한 보호자도 같은 구독으로 보호자 기능이 열린다", async () => {
    rows = [pgSub()];
    const { ent } = await load();
    const e = await ent.getEntitlement("guardian-1");
    expect(e.guardianFeatures).toBe(true);
    expect(e.source).toBe("purchaser");
  });

  it("여러 개면 가장 큰 상한 — 포트원 30 + 60 → 60", async () => {
    rows = [pgSub({ beneficiaryUserId: "elder-1" }), pgSub({ beneficiaryUserId: "elder-2", productId: "day60", dailyTurnLimit: 60 })];
    const { ent } = await load();
    expect((await ent.getEntitlement("guardian-1")).dailyTurnLimit).toBe(60);
  });

  it("Play와 함께 — 큰 쪽(Play 300 vs 포트원 30 → 300, Play 20 vs 포트원 60 → 60)", async () => {
    const play: Row = { productId: "maeum_pro_monthly", expiresAt: future(), beneficiaryUserId: "elder-1", purchaserUserId: "guardian-2" };
    rows = [play, pgSub()];
    expect((await (await load({ PRO_DAILY_TURN_LIMIT: "300" })).ent.getEntitlement("elder-1")).dailyTurnLimit).toBe(300);
    rows = [play, pgSub({ productId: "day60", dailyTurnLimit: 60 })];
    expect((await (await load({ PRO_DAILY_TURN_LIMIT: "20" })).ent.getEntitlement("elder-1")).dailyTurnLimit).toBe(60);
  });

  it("요금제 설정이 깨져도(BILLING_PLANS 형식 오류·요금제 삭제) 이미 낸 구독의 상한은 그대로", async () => {
    rows = [pgSub({ productId: "day30" })];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ent } = await load({ BILLING_PLANS: "broken", BILLING_PRO_PRODUCT_IDS: "maeum_pro_monthly" });
      const e = await ent.getEntitlement("elder-1");
      expect(e.tier).toBe("pro");
      expect(e.dailyTurnLimit).toBe(30);
    } finally { warn.mockRestore(); }
  });
});

describe("포트원 구독이 혜택이 아닌 경우", () => {
  it("만료 시각이 없으면 혜택 없음 — Play의 '만료 정보 아직 없음' 예외를 쓰지 않는다", async () => {
    rows = [pgSub({ expiresAt: null })];
    const { ent } = await load();
    expect((await ent.getEntitlement("elder-1")).tier).toBe("free");
  });

  it("만료 시각이 지났으면 혜택 없음(상태가 아직 active여도)", async () => {
    rows = [pgSub({ expiresAt: past() })];
    const { ent } = await load();
    expect((await ent.getEntitlement("elder-1")).tier).toBe("free");
  });

  it("상한 기록이 없거나 0이면 혜택 없음(무엇을 주는지 모르면 주지 않는다)", async () => {
    for (const dailyTurnLimit of [null, 0]) {
      rows = [pgSub({ dailyTurnLimit })];
      const { ent } = await load();
      expect((await ent.getEntitlement("elder-1")).tier, String(dailyTurnLimit)).toBe("free");
    }
  });

  it.each(["pending", "activating", "failed", "expired", "revoked"])("%s 상태는 혜택 없음 — 조회 조건에서 빠진다", async (status) => {
    rows = [pgSub({ status })];
    const { ent } = await load();
    expect((await ent.getEntitlement("elder-1")).tier).toBe("free");
    expect(lastWhere?.status?.in).not.toContain(status);
  });

  it("해지 예약(canceled)·재시도 중(grace)은 만료 시각까지 혜택 유지", async () => {
    for (const status of ["canceled", "grace"]) {
      rows = [pgSub({ status })];
      const { ent } = await load();
      expect((await ent.getEntitlement("elder-1")).dailyTurnLimit, status).toBe(30);
    }
  });
});

describe("일일 상한과의 연동 — 무료 한도 근처에서 포트원 요금제 상한으로 올라간다", () => {
  it("무료 10회 중 8회 쓴 어르신 + 하루 30회 이용권 → 상한 30, 막히지 않는다", async () => {
    todayCount = 8;
    rows = [pgSub()];
    const { usage } = await load();
    const u = await usage.getDailyUsage("conv-1", "elder-1");
    expect(u.limit).toBe(30);
    expect(u.exceeded).toBe(false);
  });

  it("이용권이 첫 결제 중(activating)이면 무료 한도 그대로 — 10회째에 막힌다", async () => {
    todayCount = 10;
    rows = [pgSub({ status: "activating" })];
    const { usage } = await load();
    const u = await usage.getDailyUsage("conv-1", "elder-1");
    expect(u.limit).toBe(10);
    expect(u.exceeded).toBe(true);
  });
});

describe("DB에 웹 결제 컬럼이 아직 없을 때(DDL보다 배포가 먼저 나간 경우 — 2026-10-22 검토)", () => {
  it("없는 컬럼 오류(P2022)면 예전 조회로 한 번 더 — Play 구독자가 조용히 무료로 떨어지지 않는다", async () => {
    missingPgColumns = true;
    rows = [{ productId: "maeum_pro_monthly", expiresAt: future(), beneficiaryUserId: "elder-1", purchaserUserId: "guardian-2" }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ent } = await load({ PRO_DAILY_TURN_LIMIT: "300", BILLING_PRO_PRODUCT_IDS: "maeum_pro_monthly" });
      const e = await ent.getEntitlement("elder-1");
      expect(e).toMatchObject({ tier: "pro", dailyTurnLimit: 300, source: "beneficiary" });
      expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("P2022");
    } finally { warn.mockRestore(); }
  });

  it("다른 조회 실패는 예전처럼 무료(실패 시 유료 취급 금지)", async () => {
    rows = [pgSub()];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { ent } = await load();
      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.subscription.findMany).mockRejectedValueOnce(new Error("timeout"));
      expect((await ent.getEntitlement("elder-1")).tier).toBe("free");
    } finally { warn.mockRestore(); }
  });
});
