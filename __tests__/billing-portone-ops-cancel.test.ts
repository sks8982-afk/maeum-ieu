/**
 * 전화·이메일 해지·청약철회(lib/billing/portone-ops-cancel — scripts/ops-billing-cancel.ts) — 신청 시각 기준(2026-10-22 검토).
 *
 * 지키는 것:
 *   · 6일째 메일로 받은 청약철회를 9일째 처리해도 청약철회(유료 혜택 미사용이면 전액) — 철회는 의사를 보낸 때 효력이 생긴다(제17조⑤).
 *     해지 기록의 시각(revokedAt·신청 시각)도 신청 시각이다(5년 보관 기록).
 *   · 미리보기는 아무것도 바꾸지 않는다(포트원 호출·DB 쓰기 없음).
 *   · 미래·30일보다 오래된 신청 시각, 신청 뒤 결제된 회차가 있으면 처리하지 않는다(사람이 확인).
 *   · 다음 결제부터 해지도 신청 시각으로 기록한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { db, pg, startSubscription, subRow, ledger, kst } from "./helpers/billing-portone-harness";

const load = () => import("@/lib/billing/portone-ops-cancel");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(kst("2026-11-02T14:05:00"));
});
afterEach(() => vi.useRealTimers());

describe("신청 시각 기준 — 늦게 처리해도 신청한 때의 권리대로", () => {
  it("6일째(11/8) 메일로 받은 청약철회를 9일째(11/11) 처리 → 청약철회 전액, 기록 시각은 신청 시각", async () => {
    const s = await startSubscription();
    const { paymentIdFor } = await import("@/lib/billing/portone-period");
    vi.setSystemTime(kst("2026-11-11T10:00:00"));
    const requestedAt = kst("2026-11-08T21:30:00");
    const { planOpsCancel, runOpsCancel } = await load();
    const plan = await planOpsCancel(s.subscriptionId, "now", requestedAt);
    expect(plan).toMatchObject({ ok: true, quote: { withinWithdrawal: true, immediate: { rule: "withdrawal", refundKrw: 19_900 } } });
    // 화면 API처럼 처리 시각으로 보면 이미 철회 기간 밖이다(이 차이를 막는 것이 이 도구다)
    const { quoteCancellation } = await import("@/lib/billing/portone-cancel");
    expect(await quoteCancellation(s.subscriptionId)).toMatchObject({ ok: true, quote: { withinWithdrawal: false } });
    if (!plan.ok) throw new Error(plan.reason);
    expect(await runOpsCancel(plan)).toEqual({ ok: true, endsAt: requestedAt, refundKrw: 19_900 });
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "revoked", revokedAt: requestedAt, cancelType: "withdrawal" });
    expect(ledger(paymentIdFor(s.subscriptionId, 1))).toMatchObject({ cancelType: "withdrawal", cancelRequestedAt: requestedAt, cancelledKrw: 19_900 });
  });

  it("미리보기는 아무것도 바꾸지 않는다(포트원 호출·DB 쓰기 없음)", async () => {
    const s = await startSubscription();
    pg.log.length = 0;
    const before = JSON.stringify([db.subscription.rows, db.billingPayment.rows]);
    vi.setSystemTime(kst("2026-11-11T10:00:00"));
    const { planOpsCancel } = await load();
    expect((await planOpsCancel(s.subscriptionId, "now", kst("2026-11-08T21:30:00"))).ok).toBe(true);
    expect(pg.log).toEqual([]);
    expect(JSON.stringify([db.subscription.rows, db.billingPayment.rows])).toBe(before);
  });

  it("다음 결제부터 해지도 신청 시각으로 기록한다", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-11-20T10:00:00"));
    const requestedAt = kst("2026-11-18T09:00:00");
    const { planOpsCancel, runOpsCancel } = await load();
    const plan = await planOpsCancel(s.subscriptionId, "period_end", requestedAt);
    if (!plan.ok) throw new Error(plan.reason);
    await runOpsCancel(plan);
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", canceledAt: requestedAt, cancelAtPeriodEnd: true });
  });
});

describe("처리하지 않는 경우 — 사람이 확인한다", () => {
  it("신청 시각이 지금보다 뒤 · 30일보다 오래됨 · 읽을 수 없음", async () => {
    const s = await startSubscription();
    const { planOpsCancel } = await load();
    expect(await planOpsCancel(s.subscriptionId, "now", kst("2026-11-03T10:00:00"))).toMatchObject({ ok: false, reason: expect.stringContaining("지금보다 뒤") });
    vi.setSystemTime(kst("2026-12-20T10:00:00"));
    expect(await planOpsCancel(s.subscriptionId, "now", kst("2026-11-10T10:00:00"))).toMatchObject({ ok: false, reason: expect.stringContaining("30일") });
    expect(await planOpsCancel(s.subscriptionId, "now", new Date("nope"))).toMatchObject({ ok: false });
  });

  it("신청 뒤에 결제된 회차가 있으면 처리하지 않는다(그 회차는 전액 환불 대상 — 한 회차 계산으로 처리하면 틀린다)", async () => {
    const s = await startSubscription();
    const { paymentIdFor } = await import("@/lib/billing/portone-period");
    const { runSchedule } = await import("./helpers/billing-portone-harness");
    const { syncPayment } = await import("@/lib/billing/portone-sync");
    vi.setSystemTime(kst("2026-12-02T10:05:00"));
    runSchedule(paymentIdFor(s.subscriptionId, 2), "paid");
    await syncPayment(paymentIdFor(s.subscriptionId, 2));
    vi.setSystemTime(kst("2026-12-03T10:00:00"));
    const { planOpsCancel } = await load();
    const plan = await planOpsCancel(s.subscriptionId, "period_end", kst("2026-12-01T20:00:00"));
    expect(plan).toMatchObject({ ok: false, reason: expect.stringContaining("신청 뒤") });
  });
});
