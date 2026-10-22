/**
 * Play 결제 흐름(verify·rtdn)이 웹 결제 컬럼이 아직 없는 DB에서도 돈다 — DDL(scripts/ops-billing-pg.ts)보다 배포가 먼저 나간 경우(2026-10-22 검토).
 *
 * 지키는 것:
 *   · verify의 upsert·rtdn의 update는 돌려받을 칸을 { id }로만 고른다 — 기본(모든 칸)으로 돌려받으면 새 클라이언트가 없는 컬럼을
 *     읽으려다 500이 나고, verify는 그 뒤의 승인(acknowledge)을 못 해 3일 뒤 Google이 자동 환불한다.
 *   · DB 흉내: select 없이 쓰면 Prisma처럼 P2022(없는 컬럼)로 실패한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const p2022 = () => Object.assign(new Error("The column `subscriptions.provider` does not exist in the current database."), { code: "P2022" });
const db = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  update: vi.fn(),
}));
const play = vi.hoisted(() => ({ acknowledge: vi.fn(async () => true) }));

vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => ({ user: { id: "user-1" } })) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/prisma", () => ({ prisma: { subscription: { findUnique: db.findUnique, upsert: db.upsert, update: db.update } } }));
vi.mock("@/lib/billing/play-api", () => ({
  isPlayConfigured: () => true,
  mapState: () => "active",
  getSubscription: vi.fn(async () => ({
    productId: "maeum_pro_monthly", state: "SUBSCRIPTION_STATE_ACTIVE", autoRenewing: true,
    expiresAt: new Date(Date.now() + 30 * 86_400_000), needsAcknowledge: true,
  })),
  acknowledgeSubscription: play.acknowledge,
}));
vi.mock("@/lib/billing/entitlement", () => ({
  resolveBeneficiary: vi.fn(async () => "elder-1"),
  getEntitlement: vi.fn(async () => ({ tier: "pro" })),
}));
vi.mock("@/lib/billing/plans", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/plans")>()),
  isProProduct: (id: string) => id === "maeum_pro_monthly",
}));

/** 새 컬럼이 없는 DB — 돌려받을 칸을 고르지 않으면 P2022 */
function writeWithoutNewColumns(args: { select?: Record<string, boolean> }) {
  if (!args.select || Object.keys(args.select).some((k) => k !== "id")) throw p2022();
  return { id: "sub-1" };
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db.upsert.mockImplementation(async (a) => writeWithoutNewColumns(a));
  db.update.mockImplementation(async (a) => writeWithoutNewColumns(a));
  process.env.BILLING_RTDN_SECRET = "rtdn-secret-test";
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.BILLING_RTDN_SECRET;
});

describe("웹 결제 컬럼이 없는 DB에서도 Play 흐름이 돈다", () => {
  it("verify — 기록하고 승인(acknowledge)까지 한다(500으로 멈추지 않는다)", async () => {
    db.findUnique.mockResolvedValue(null);
    const { POST } = await import("@/app/api/billing/verify/route");
    const res = await POST(new Request("https://maeum.example.com/api/billing/verify", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ purchaseToken: "tok-1234567890", productId: "maeum_pro_monthly" }),
    }));
    expect(res.status).toBe(200);
    expect(db.upsert).toHaveBeenCalledWith(expect.objectContaining({ select: { id: true } }));
    expect(play.acknowledge).toHaveBeenCalledWith("maeum_pro_monthly", "tok-1234567890");
  });

  it("rtdn — 상태를 갱신하고 200(Pub/Sub이 같은 통지를 끝없이 다시 보내지 않게)", async () => {
    db.findUnique.mockResolvedValue({ id: "sub-1" });
    const { POST } = await import("@/app/api/billing/rtdn/route");
    const data = Buffer.from(JSON.stringify({ subscriptionNotification: { notificationType: 2, purchaseToken: "tok-1234567890" } })).toString("base64");
    const res = await POST(new Request("https://maeum.example.com/api/billing/rtdn", {
      method: "POST", headers: { "content-type": "application/json", "x-rtdn-secret": "rtdn-secret-test" }, body: JSON.stringify({ message: { data } }),
    }));
    expect(res.status).toBe(200);
    expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ select: { id: true } }));
  });
});
