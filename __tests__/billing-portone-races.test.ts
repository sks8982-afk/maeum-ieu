/**
 * 해지 ↔ 결제 반영 경쟁(2026-10-22 적대 검토) — 구독 행을 읽은 뒤 조건 없이 덮어쓰면 돈은 나갔는데 혜택·환불이 없거나, 상태가 굳어
 *   같은 어르신의 재가입이 영구히 막혔다. 메모리 DB의 호출 하나에 다른 처리를 끝까지 끼워 넣어 순서를 정해 재현한다(결정적).
 *
 * 지키는 것 — 어느 순서로 겹쳐도 낸 회차는 혜택이나 환불로 돌아온다:
 *   · 지금 해지가 1회차를 읽은 뒤 2회차가 반영되면 → 해지는 다시 읽어 2회차 기준으로 계산·환불한다.
 *   · 갱신 반영이 구독을 읽은 뒤 지금 해지·다음 결제부터 해지가 먼저 끝나면 → 그 갱신 결제는 전액 취소, 구독은 해지 상태로 남는다.
 *   · 다음 결제부터 해지가 구독을 읽은 뒤 갱신이 먼저 반영되면 → 옛 만료일로 덮어쓰지 않는다(낸 기간 끝까지 이용).
 *   · 결제 실패 재시도 예약 중에 해지가 끝나면 → grace로 덮어쓰지 않는다(해지 상태로 남아 만료된다).
 *   · 그래도 굳은 상태(만료가 지났는데 active·grace + 해지 예약·빌링키 없음)는 예약 작업과 재가입이 만료로 정리한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { db, pg, mail, runSchedule, startSubscription, subRow, ledger, kst } from "./helpers/billing-portone-harness";

const pid = async (subId: string, cycle: number, suffix = "") => (await import("@/lib/billing/portone-period")).paymentIdFor(subId, cycle, suffix);
const tier = async (userId: string) => (await (await import("@/lib/billing/entitlement")).getEntitlement(userId)).tier;
const cancelLib = () => import("@/lib/billing/portone-cancel");
const syncLib = () => import("@/lib/billing/portone-sync");

let err: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(kst("2026-11-02T14:05:00"));
  err = vi.spyOn(console, "error").mockImplementation(() => {});
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); err.mockRestore(); warn.mockRestore(); });

/** 첫 결제 뒤 첫 갱신 시각(12/2 10:00 KST) 직후 — 포트원은 2회차를 이미 결제했다(웹훅이 막 도착) */
async function renewedAtPortone() {
  const s = await startSubscription();
  const c2 = await pid(s.subscriptionId, 2);
  vi.setSystemTime(kst("2026-12-02T10:00:20"));
  runSchedule(c2, "paid");
  return { ...s, c2 };
}

/** markPaid가 구독을 읽고 '같은 회차 중복' 조회를 하는 순간에 fn을 끝까지 돌린다(그 뒤 markPaid가 이어 간다) */
function interleaveAtDuplicateCheck(fn: () => Promise<unknown>) {
  const original = db.billingPayment.findFirst.getMockImplementation()!;
  let done = false;
  db.billingPayment.findFirst.mockImplementation(async (args?: { where?: { paymentId?: { not?: string } } }) => {
    if (!done && args?.where?.paymentId?.not !== undefined) { done = true; await fn(); }
    return original(args);
  });
}

describe("지금 해지 ↔ 갱신 반영", () => {
  it("해지가 1회차를 읽은 뒤 2회차가 반영되면 — 다시 읽어 2회차를 돌려준다(낸 19,900원이 환불 없이 남지 않는다)", async () => {
    const s = await renewedAtPortone();
    const { syncPayment } = await syncLib();
    const original = db.billingPayment.findFirst.getMockImplementation()!;
    let done = false;
    // 지금 해지의 '이번 회차 결제' 조회가 1회차를 읽은 직후, 웹훅 처리가 2회차를 반영한다
    db.billingPayment.findFirst.mockImplementation(async (args) => {
      const stale = await original(args);
      if (!done) { done = true; await syncPayment(s.c2); }
      return stale;
    });
    const r = await (await cancelLib()).cancelNow(s.subscriptionId, { purchaserUserId: s.guardian });
    expect(r).toMatchObject({ ok: true, refundKrw: 19_900 }); // 12/2 결제, 당일 철회, 유료 혜택 안 씀 → 전액
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "revoked", cycleNo: 2 });
    expect(pg.payments.get(s.c2)).toMatchObject({ status: "CANCELLED", amount: expect.objectContaining({ cancelled: 19_900 }) });
  });

  it("갱신 반영이 구독을 읽은 뒤 지금 해지가 먼저 끝나면 — 그 갱신은 전액 취소, 구독은 revoked로 남는다(active로 되살리지 않는다)", async () => {
    const s = await renewedAtPortone();
    interleaveAtDuplicateCheck(async () => (await cancelLib()).cancelNow(s.subscriptionId, { purchaserUserId: s.guardian }));
    expect(await (await syncLib()).syncPayment(s.c2)).toBe("refunded");
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "revoked", cycleNo: 1 });
    expect(pg.payments.get(s.c2)?.status).toBe("CANCELLED");
    expect(ledger(s.c2)).toMatchObject({ status: "cancelled", cancelledKrw: 19_900 });
    expect(await tier(s.elder)).toBe("free");
    // 해지 완료 다음에 '결제 완료'가 가지 않는다
    expect(mail.sent.filter((m) => m.subject.includes("결제 완료"))).toHaveLength(1); // 첫 결제 한 통뿐
  });
});

describe("다음 결제부터 해지 ↔ 갱신 반영", () => {
  it("갱신 반영이 구독을 읽은 뒤 해지가 먼저 끝나면 — 그 갱신은 전액 취소, 구독은 해지 상태로 남아 만료되고 재가입이 막히지 않는다", async () => {
    const s = await renewedAtPortone();
    interleaveAtDuplicateCheck(async () => (await cancelLib()).cancelAtPeriodEnd(s.subscriptionId, { purchaserUserId: s.guardian }));
    expect(await (await syncLib()).syncPayment(s.c2)).toBe("refunded");
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", cancelAtPeriodEnd: true, cycleNo: 1 });
    expect(pg.payments.get(s.c2)?.status).toBe("CANCELLED");
    vi.setSystemTime(kst("2027-01-03T11:00:00"));
    await (await import("@/lib/billing/portone-maintenance")).runBillingMaintenance();
    expect(subRow(s.subscriptionId).status).toBe("expired");
    const again = await startSubscription({ seed: false, billingKey: "billing-key-again" });
    expect(again.result).toMatchObject({ ok: true, status: "active" });
  });

  it("해지가 구독을 읽은 뒤 갱신이 먼저 반영되면 — 옛 만료일(12/2)로 덮어쓰지 않는다: 낸 2회차는 1/2까지 이용, 다음 예약은 취소", async () => {
    const s = await renewedAtPortone();
    const { syncPayment } = await syncLib();
    const original = db.subscription.updateMany.getMockImplementation()!;
    let done = false;
    // 해지가 자기 쓰기(canceled)를 하기 직전에 웹훅 처리가 2회차를 먼저 반영한다
    db.subscription.updateMany.mockImplementation(async (args: { data: Record<string, unknown> }) => {
      if (!done && args.data.status === "canceled") { done = true; await syncPayment(s.c2); }
      return original(args);
    });
    const r = await (await cancelLib()).cancelAtPeriodEnd(s.subscriptionId, { purchaserUserId: s.guardian });
    expect(r).toMatchObject({ ok: true, endsAt: kst("2027-01-02T10:00:00") });
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", cycleNo: 2, expiresAt: kst("2027-01-02T10:00:00") });
    expect(await tier(s.elder)).toBe("pro");
    const c3 = await pid(s.subscriptionId, 3);
    expect(pg.schedules.find((x) => x.paymentId === c3)?.status).toBe("REVOKED");
  });
});

describe("결제 실패 재시도 ↔ 다음 결제부터 해지", () => {
  it("재시도를 예약하는 중에 해지가 끝나면 — grace로 덮어쓰지 않는다: 해지 상태로 남아 만료되고 재가입이 막히지 않는다", async () => {
    const s = await startSubscription();
    const c2 = await pid(s.subscriptionId, 2);
    vi.setSystemTime(kst("2026-12-02T10:00:05"));
    runSchedule(c2, "failed");
    const original = db.billingPayment.upsert.getMockImplementation()!;
    let done = false;
    db.billingPayment.upsert.mockImplementation(async (args: Parameters<typeof original>[0]) => {
      if (!done && args.create.kind === "retry") { done = true; await (await cancelLib()).cancelAtPeriodEnd(s.subscriptionId, { purchaserUserId: s.guardian }); }
      return original(args);
    });
    await (await syncLib()).syncPayment(c2);
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", cancelAtPeriodEnd: true });
    expect(ledger(await pid(s.subscriptionId, 2, "r1")).status).toBe("revoked");
    expect(pg.schedules.some((x) => x.paymentId.endsWith("r1") && x.status === "SCHEDULED")).toBe(false);
    // 해지 완료 뒤에 '결제가 되지 않았어요'가 가지 않는다
    expect(mail.sent.at(-1)?.subject).toBe("[마음이음] 이용권 해지 완료");
    vi.setSystemTime(kst("2026-12-10T11:00:00"));
    await (await import("@/lib/billing/portone-maintenance")).runBillingMaintenance();
    expect(subRow(s.subscriptionId).status).toBe("expired");
    expect((await startSubscription({ seed: false, billingKey: "bk-again" })).result).toMatchObject({ ok: true });
  });
});

describe("굳은 상태의 출구 — 만료가 지났는데 active·grace로 남은 구독", () => {
  function stuck(over: Record<string, unknown>) {
    db.subscription.rows.push({
      id: "stuck-1", purchaserUserId: "guardian-1", beneficiaryUserId: "elder-1", productId: "day30", purchaseToken: "portone:bkstuck",
      provider: "portone", status: "active", cancelAtPeriodEnd: true, billingKeyEnc: null, nextChargeAt: null, nextScheduleId: null,
      expiresAt: kst("2026-10-01T10:00:00"), cycleNo: 1, priceKrw: 19_900, dailyTurnLimit: 30, revokedAt: null, updatedAt: new Date(0), ...over,
    });
  }

  it.each([
    ["active + 해지 예약", { status: "active", cancelAtPeriodEnd: true }],
    ["grace + 빌링키 없음", { status: "grace", cancelAtPeriodEnd: false, billingKeyEnc: null }],
  ])("%s → 예약 작업이 expired로", async (_n, over) => {
    stuck(over);
    const { runBillingMaintenance } = await import("@/lib/billing/portone-maintenance");
    await runBillingMaintenance();
    expect(subRow("stuck-1").status).toBe("expired");
  });

  it("예약 작업을 기다리지 않고 — 같은 어르신 재가입(첫 결제 직전)이 굳은 구독을 만료로 바꾸고 결제한다", async () => {
    const { seedFamily } = await import("./helpers/billing-portone-harness");
    seedFamily();
    stuck({ status: "active", cancelAtPeriodEnd: true });
    const again = await startSubscription({ seed: false });
    expect(again.result).toMatchObject({ ok: true, status: "active" });
    expect(subRow("stuck-1").status).toBe("expired");
  });
});
