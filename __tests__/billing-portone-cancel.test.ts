/**
 * 포트원 이용권 해지·환불(lib/billing/portone-cancel) + 탈퇴·연결 해제.
 *
 * 지키는 것:
 *   · 다음 결제부터 해지 — 만료일까지 혜택, 그 뒤 결제 없음, 환불 없음. 포트원은 **예약 취소 → 빌링키 삭제** 순서.
 *   · 지금 해지 — 환불정책 계산 예시 표 그대로(7일 안 미사용 전액·사용 시 이용일수 공제·7일 뒤 10% 위약금), 원래 결제수단 취소.
 *   · 이중 환불 없음 — 환불 목표액을 원장에 먼저 고정하고 currentCancellableAmount로 보낸다(다시 시도해도 한 번만).
 *   · 해지 화면용 견적은 두 방식(다음 결제부터·지금)을 함께 돌려준다.
 *   · 탈퇴·연결 해제 — 포트원 실패면 throw(부르는 쪽이 삭제를 멈춘다). 결제 기록은 남는다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { db, pg, mail, fakeClient, startSubscription, subRow, ledger, kst, fakeId, seedFamily, issueKey, PLAN_DAY30, CONSENT } from "./helpers/billing-portone-harness";

const cancel = () => import("@/lib/billing/portone-cancel");
const pid = async (subId: string, cycle: number, suffix = "") => (await import("@/lib/billing/portone-period")).paymentIdFor(subId, cycle, suffix);
const tier = async (userId: string) => (await (await import("@/lib/billing/entitlement")).getEntitlement(userId)).tier;

let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(kst("2026-11-02T14:05:00")); // 결제일 — 이용기간 11/2 ~ 12/1(30일)
  err = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); err.mockRestore(); });

/** 어르신이 그날 무료 한도(10회)를 넘게 이야기함 */
function talkedOver(elder: string, day: string, count = 11) {
  const convId = `conv-${elder}`;
  if (!db.conversation.rows.some((c) => c.id === convId)) db.conversation.rows.push({ id: convId, userId: elder });
  for (let i = 0; i < count; i++) {
    db.message.rows.push({ id: fakeId(), conversationId: convId, role: "user", content: "안녕", createdAt: new Date(kst(`${day}T09:00:00`).getTime() + i * 60_000) });
  }
}

describe("다음 결제부터 해지 — 만료일까지 혜택, 환불 없음", () => {
  it("canceled · 다음 결제 없음 · 만료 그대로 · 예약 취소 → 빌링키 삭제(이 순서) · 해지 메일", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-11-13T09:00:00"));
    pg.log.length = 0;
    const { cancelAtPeriodEnd } = await cancel();
    expect(await cancelAtPeriodEnd(s.subscriptionId, { purchaserUserId: "guardian-1" })).toEqual({
      ok: true, endsAt: kst("2026-12-02T10:00:00"), refundKrw: 0,
    });
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", cancelAtPeriodEnd: true, cancelType: "normal", nextChargeAt: null, billingKeyEnc: null });
    expect(subRow(s.subscriptionId).expiresAt).toEqual(kst("2026-12-02T10:00:00"));
    expect(pg.log.filter((l) => !l.startsWith("get:"))).toEqual([`revoke:${s.billingKey}`, `deleteKey:${s.billingKey}`]);
    expect(pg.schedules[0].status).toBe("REVOKED");
    expect(ledger(await pid(s.subscriptionId, 2)).status).toBe("revoked");
    expect(fakeClient.payment.cancelPayment).not.toHaveBeenCalled();
    expect(mail.sent.at(-1)?.text).toContain("2026-12-01까지 그대로 이용할 수 있고");
    // 만료일까지는 혜택, 지나면 무료
    expect(await tier(s.elder)).toBe("pro");
    vi.setSystemTime(kst("2026-12-02T10:00:01"));
    expect(await tier(s.elder)).toBe("free");
  });

  it("두 번 눌러도 한 번 — 포트원·메일이 늘지 않는다", async () => {
    const s = await startSubscription();
    const { cancelAtPeriodEnd } = await cancel();
    await cancelAtPeriodEnd(s.subscriptionId);
    const calls = pg.log.length;
    const mails = mail.sent.length;
    expect((await cancelAtPeriodEnd(s.subscriptionId)).ok).toBe(true);
    expect(pg.log).toHaveLength(calls);
    expect(mail.sent).toHaveLength(mails);
  });

  it("결제회원이 아니면 forbidden, 없는 구독은 not_found, 끝난 구독은 not_cancellable", async () => {
    const s = await startSubscription();
    const { cancelAtPeriodEnd, cancelNow } = await cancel();
    expect(await cancelAtPeriodEnd(s.subscriptionId, { purchaserUserId: "elder-1" })).toEqual({ ok: false, code: "forbidden" });
    expect(await cancelNow(s.subscriptionId, { purchaserUserId: "intruder" })).toEqual({ ok: false, code: "forbidden" });
    expect(await cancelAtPeriodEnd("nope")).toEqual({ ok: false, code: "not_found" });
    db.subscription.rows[0].status = "expired";
    expect(await cancelAtPeriodEnd(s.subscriptionId)).toEqual({ ok: false, code: "not_cancellable" });
  });

  it("포트원 예약 취소가 실패해도 해지는 성립(의사 먼저 기록) — 빌링키는 남겨 예약 작업이 마저 지운다 + 운영 경보", async () => {
    const s = await startSubscription();
    pg.failRevokeWith = "FORBIDDEN";
    const { cancelAtPeriodEnd } = await cancel();
    expect((await cancelAtPeriodEnd(s.subscriptionId)).ok).toBe(true);
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", nextChargeAt: null });
    expect(subRow(s.subscriptionId).billingKeyEnc).not.toBeNull();
    expect(pg.keys.get(s.billingKey)?.status).toBe("ISSUED"); // 예약이 남은 키를 먼저 지우려 하지 않았다
    expect(mail.ops.map((o) => o.subject)).toContain("[결제] 빌링키 정리 실패 — 예약 작업이 다시 시도");
    // 다시 누르면 남은 정리만 — 해지 메일을 또 보내지 않는다
    const mails = mail.sent.length;
    expect((await cancelAtPeriodEnd(s.subscriptionId)).ok).toBe(true);
    expect(subRow(s.subscriptionId).billingKeyEnc).toBeNull();
    expect(mail.sent).toHaveLength(mails);
  });
});

describe("해지 화면 견적 — 두 방식, 환불정책 계산 예시 표 그대로", () => {
  it("3일째, 유료 혜택 안 씀 → 청약철회 전액 19,900원 / 다음 결제부터 해지는 12/2까지·0원", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-11-04T09:00:00"));
    const { quoteCancellation } = await cancel();
    const q = await quoteCancellation(s.subscriptionId, { purchaserUserId: "guardian-1" });
    expect(q).toEqual({ ok: true, quote: {
      subscriptionId: s.subscriptionId, periodEnd: { endsAt: kst("2026-12-02T10:00:00"), refundKrw: 0 },
      immediate: { refundKrw: 19_900, rule: "withdrawal", usedDays: 3, periodDays: 30, paidKrw: 19_900 },
      withinWithdrawal: true, usedPaidBenefit: false,
    } });
  });

  it("5일째, 유료 혜택 씀(11/3에 11회 대화) → 16,584원", async () => {
    const s = await startSubscription();
    talkedOver(s.elder, "2026-11-03");
    vi.setSystemTime(kst("2026-11-06T09:00:00"));
    const { quoteCancellation } = await cancel();
    const q = await quoteCancellation(s.subscriptionId);
    expect(q.ok && q.quote.usedPaidBenefit).toBe(true);
    expect(q.ok && q.quote.immediate).toMatchObject({ refundKrw: 16_584, rule: "withdrawal", usedDays: 5 });
  });

  it("12일째 → 지금 해지 10,746원(이용일수 + 남은 기간 10%) — 청약철회 기간 밖", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-11-13T09:00:00"));
    const { quoteCancellation } = await cancel();
    const q = await quoteCancellation(s.subscriptionId);
    expect(q.ok && q.quote).toMatchObject({ withinWithdrawal: false, immediate: { refundKrw: 10_746, rule: "immediate", usedDays: 12 } });
  });

  it("재시도 중(grace)이면 낸 기간이 이미 끝나 돌려줄 금액이 없다 — 0원, 지금 끝남", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-12-02T10:00:30"));
    const { runSchedule } = await import("./helpers/billing-portone-harness");
    runSchedule(await pid(s.subscriptionId, 2), "failed");
    await (await import("@/lib/billing/portone-sync")).syncPayment(await pid(s.subscriptionId, 2));
    const { quoteCancellation } = await cancel();
    const q = await quoteCancellation(s.subscriptionId);
    expect(q.ok && q.quote.immediate.refundKrw).toBe(0);
    expect(q.ok && q.quote.periodEnd.endsAt).toEqual(kst("2026-12-02T10:00:30"));
  });
});

describe("지금 해지 — 즉시 종료 + 결제 취소로 환불", () => {
  it("7일 안·미사용 → 전액 19,900원 취소, revoked(withdrawal), 예약 취소 → 결제 취소 → 빌링키 삭제, 혜택 즉시 끝", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-11-04T09:00:00"));
    pg.log.length = 0;
    const { cancelNow } = await cancel();
    expect(await cancelNow(s.subscriptionId, { purchaserUserId: "guardian-1" })).toEqual({ ok: true, endsAt: kst("2026-11-04T09:00:00"), refundKrw: 19_900 });
    const first = await pid(s.subscriptionId, 1);
    expect(fakeClient.payment.cancelPayment).toHaveBeenCalledWith(expect.objectContaining({ paymentId: first, amount: 19_900, currentCancellableAmount: 19_900 }));
    expect(pg.log.filter((l) => !l.startsWith("get:"))).toEqual([`revoke:${s.billingKey}`, `cancel:${first}:19900`, `deleteKey:${s.billingKey}`]);
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "revoked", cancelType: "withdrawal", billingKeyEnc: null, nextChargeAt: null });
    expect(ledger(first)).toMatchObject({ status: "cancelled", cancelledKrw: 19_900, refundTargetKrw: 19_900 });
    expect(await tier(s.elder)).toBe("free");
    expect(mail.sent.at(-1)?.subject).toBe("[마음이음] 이용권 환불 — 19,900원");
  });

  it("12일째 → 10,746원 부분 취소, 결제 기록은 남는다", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-11-13T09:00:00"));
    const { cancelNow } = await cancel();
    expect((await cancelNow(s.subscriptionId)).ok && pg.payments.get(await pid(s.subscriptionId, 1))?.amount.cancelled).toBe(10_746);
    expect(ledger(await pid(s.subscriptionId, 1))).toMatchObject({ status: "partial_cancelled", cancelledKrw: 10_746 });
    expect(subRow(s.subscriptionId).cancelType).toBe("immediate");
  });

  it("결제 취소가 실패하면 throw — 다시 부르면 같은 금액으로 한 번만 환불(목표액 고정)", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-11-13T09:00:00"));
    pg.failCancelWith = "PG_PROVIDER";
    const { cancelNow } = await cancel();
    await expect(cancelNow(s.subscriptionId)).rejects.toThrow();
    const first = await pid(s.subscriptionId, 1);
    expect(subRow(s.subscriptionId).status).toBe("revoked"); // 혜택은 이미 끝났다(의사 기록)
    expect(subRow(s.subscriptionId).billingKeyEnc).not.toBeNull(); // 정리가 덜 됐다는 표시 — 예약 작업이 이어 간다
    expect(ledger(first).refundTargetKrw).toBe(10_746);
    vi.setSystemTime(kst("2026-11-20T09:00:00")); // 며칠 뒤 다시 — 금액은 신청 시점 그대로
    expect(await cancelNow(s.subscriptionId)).toMatchObject({ ok: true, refundKrw: 10_746 });
    expect(pg.payments.get(first)?.amount.cancelled).toBe(10_746);
    expect(await cancelNow(s.subscriptionId)).toMatchObject({ ok: true, refundKrw: 0 }); // 세 번째는 할 일 없음
    expect(pg.payments.get(first)?.amount.cancelled).toBe(10_746);
  });

  it("환불은 됐는데 응답이 끊겨 기록을 못 함 → 다시 부르면 포트원이 거절(남은 취소 가능액 불일치) → 기록만 고친다, 두 번 돌려주지 않는다", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-11-13T09:00:00"));
    const real = fakeClient.payment.cancelPayment.getMockImplementation()!;
    fakeClient.payment.cancelPayment.mockImplementationOnce(async (o: Parameters<typeof real>[0]) => { await real(o); throw new Error("socket hang up"); });
    const { cancelNow } = await cancel();
    await expect(cancelNow(s.subscriptionId)).rejects.toThrow("socket hang up");
    const first = await pid(s.subscriptionId, 1);
    expect(ledger(first).cancelledKrw).toBe(0); // 우리 기록은 늦었다
    expect(await cancelNow(s.subscriptionId)).toMatchObject({ ok: true, refundKrw: 0 });
    expect(pg.payments.get(first)?.amount.cancelled).toBe(10_746); // 🔒 21,492원이 아니다
    expect(ledger(first).cancelledKrw).toBe(10_746);
  });
});

describe("결제 취소 응답의 상태(cancellation.status) — 성공했을 때만 환불 완료로 적는다", () => {
  /** 12일째 지금 해지(10,746원)의 결제 취소를 결제사가 바로 끝내지 않음(REQUESTED) — 포트원 결제는 아직 PAID, 취소 요청이 걸려 있다 */
  function cancellationRequested(first: string) {
    fakeClient.payment.cancelPayment.mockImplementationOnce(async (o: { paymentId: string; amount?: number }) => {
      pg.log.push(`cancel:${o.paymentId}:${o.amount ?? "all"}`);
      const p = pg.payments.get(first)! as unknown as { cancellations?: unknown[] };
      p.cancellations = [{ status: "REQUESTED", id: "c1", totalAmount: o.amount }];
      return { cancellation: { status: "REQUESTED", id: "c1", totalAmount: o.amount } } as never;
    });
  }

  it("REQUESTED — 환불 완료로 적지 않고(포트원 값으로 나중에 확정), 그 사이 웹훅 재조회가 전액 취소로 번지지 않고, 같은 환불을 두 번 요청하지 않는다", async () => {
    const s = await startSubscription();
    const first = await pid(s.subscriptionId, 1);
    vi.setSystemTime(kst("2026-11-13T09:00:00"));
    cancellationRequested(first);
    const { cancelNow } = await cancel();
    expect(await cancelNow(s.subscriptionId)).toMatchObject({ ok: true, refundKrw: 10_746 }); // 요청은 접수됐다(메일·화면 안내)
    expect(ledger(first)).toMatchObject({ status: "paid", cancelledKrw: 0, refundTargetKrw: 10_746 });
    // Transaction.CancelPending 웹훅 → 재조회(아직 PAID) — '해지 뒤 결제'로 보고 전액 취소하지 않는다
    const { syncPayment } = await import("@/lib/billing/portone-sync");
    expect(await syncPayment(first)).toBe("unchanged");
    // 예약 작업이 이어 가도 처리 중인 요청이 있으면 다시 요청하지 않는다
    const { runBillingMaintenance } = await import("@/lib/billing/portone-maintenance");
    vi.setSystemTime(kst("2026-11-14T11:00:00"));
    await runBillingMaintenance();
    expect(fakeClient.payment.cancelPayment).toHaveBeenCalledTimes(1);
    expect(mail.ops.map((o) => o.subject)).not.toContain("[결제] 받지 말아야 할 결제를 전액 취소");
    // 결제사가 끝내면(Transaction.PartialCancelled) 포트원 값으로 확정
    const p = pg.payments.get(first)!;
    p.status = "PARTIAL_CANCELLED"; p.amount.cancelled = 10_746;
    expect(await syncPayment(first)).toBe("cancelled");
    expect(ledger(first)).toMatchObject({ status: "partial_cancelled", cancelledKrw: 10_746 });
    expect(pg.payments.get(first)?.amount.cancelled).toBe(10_746); // 🔒 19,900원 전액이 아니다
  });

  it("FAILED(200 응답) — 환불 완료로 적지 않고 throw(지금 해지는 202) → 예약 작업이 같은 목표액으로 다시 요청", async () => {
    const s = await startSubscription();
    const first = await pid(s.subscriptionId, 1);
    vi.setSystemTime(kst("2026-11-13T09:00:00"));
    fakeClient.payment.cancelPayment.mockImplementationOnce(async () => ({ cancellation: { status: "FAILED", totalAmount: 10_746 } }) as never);
    const { cancelNow } = await cancel();
    await expect(cancelNow(s.subscriptionId)).rejects.toThrow();
    expect(ledger(first)).toMatchObject({ cancelledKrw: 0, refundTargetKrw: 10_746 });
    expect(mail.sent.some((m) => m.subject.includes("환불"))).toBe(false); // 돌려주지 않은 돈을 돌려줬다고 알리지 않는다
    const { runBillingMaintenance } = await import("@/lib/billing/portone-maintenance");
    vi.setSystemTime(kst("2026-11-14T11:00:00"));
    await runBillingMaintenance();
    expect(pg.payments.get(first)?.amount.cancelled).toBe(10_746);
    expect(ledger(first)).toMatchObject({ status: "partial_cancelled", cancelledKrw: 10_746 });
  });
});

describe("해지·청약철회 기록 — 구독 기록이 계정과 함께 지워져도 원장에 남는다(계약·청약철회 기록 5년)", () => {
  it("청약철회 → 그 결제 원장에 종류(withdrawal)·신청 시각 · 다음 결제부터 해지도 지금 회차 원장에(normal)", async () => {
    const s = await startSubscription();
    const first = await pid(s.subscriptionId, 1);
    vi.setSystemTime(kst("2026-11-04T09:00:00"));
    await (await cancel()).cancelNow(s.subscriptionId);
    expect(ledger(first)).toMatchObject({ cancelType: "withdrawal", cancelRequestedAt: kst("2026-11-04T09:00:00") });

    const t = await startSubscription({ guardian: "guardian-2", elder: "elder-2" });
    vi.setSystemTime(kst("2026-11-20T09:00:00"));
    await (await cancel()).cancelAtPeriodEnd(t.subscriptionId);
    expect(ledger(await pid(t.subscriptionId, 1))).toMatchObject({ cancelType: "normal", cancelRequestedAt: kst("2026-11-20T09:00:00") });
  });

  it("해지 기록은 계약의 근거인 결제에 — 원치 않은 결제의 전액 취소(unwanted) 행·결제 시각이 없는 행에는 덮어쓰지 않는다", async () => {
    const s = await startSubscription();
    const first = await pid(s.subscriptionId, 1);
    const base = ledger(first);
    // 해지 뒤 실행돼 전액 취소한 예약 결제(나중 결제 시각) · 결제 시각이 없는 취소 행(Postgres DESC는 NULL을 맨 앞에 둔다)
    db.billingPayment.rows.push(
      { ...base, id: "unw", paymentId: "pay-unwanted", cycleNo: 2, status: "cancelled", paidAt: kst("2026-12-02T10:00:00"), cancelType: "unwanted", cancelRequestedAt: kst("2026-12-02T10:01:00") },
      { ...base, id: "nul", paymentId: "pay-null", cycleNo: 2, status: "cancelled", paidAt: null, cancelType: null, cancelRequestedAt: null },
    );
    const { prisma } = await import("@/lib/prisma");
    const { recordCancellation } = await import("@/lib/billing/portone-refund");
    await recordCancellation(prisma, s.subscriptionId, "immediate", kst("2026-12-03T09:00:00"));
    expect(ledger(first)).toMatchObject({ cancelType: "immediate", cancelRequestedAt: kst("2026-12-03T09:00:00") });
    expect(ledger("pay-unwanted")).toMatchObject({ cancelType: "unwanted", cancelRequestedAt: kst("2026-12-02T10:01:00") });
    expect(ledger("pay-null")).toMatchObject({ cancelType: null });
  });
});

describe("회원 탈퇴 — 계정 삭제 전에 정리, 포트원 실패면 throw", () => {
  it("결제회원 탈퇴(12일째) → 지금 해지 기준 10,746원 환불 + 예약 취소 + 빌링키 삭제, 기록은 남는다", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-11-13T09:00:00"));
    const { cancelForPurchaserDeletion } = await cancel();
    expect(await cancelForPurchaserDeletion("guardian-1")).toEqual({ subscriptions: 1, refundedKrw: 10_746 });
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "revoked", cancelType: "purchaser_deleted", billingKeyEnc: null });
    expect(pg.keys.get(s.billingKey)?.status).toBe("DELETED");
    expect(pg.schedules[0].status).toBe("REVOKED");
    expect(db.billingPayment.rows.length).toBeGreaterThan(0);
  });

  it("포트원 환불이 실패하면 throw — 부르는 쪽이 삭제를 멈춘다", async () => {
    await startSubscription();
    vi.setSystemTime(kst("2026-11-13T09:00:00"));
    pg.failCancelWith = "PG_PROVIDER";
    const { cancelForPurchaserDeletion } = await cancel();
    await expect(cancelForPurchaserDeletion("guardian-1")).rejects.toThrow();
  });

  it("발급 준비만 한 시도는 닫는다(늦게 온 빌링키가 결제를 시작하지 못하게) — 포트원 호출 없음", async () => {
    seedFamily();
    const { createPendingSubscription, activateByBillingKey } = await import("@/lib/billing/portone-activate");
    const p = await createPendingSubscription({ purchaserUserId: "guardian-1", beneficiaryUserId: "elder-1", plan: PLAN_DAY30, method: "CARD", consent: CONSENT });
    if (!p.ok) throw new Error("준비 실패");
    const { cancelForPurchaserDeletion } = await cancel();
    expect(await cancelForPurchaserDeletion("guardian-1")).toEqual({ subscriptions: 0, refundedKrw: 0 });
    expect(subRow(p.subscriptionId).status).toBe("failed");
    issueKey("bk-late", p.issueId);
    expect((await activateByBillingKey("bk-late")).ok).toBe(false);
    expect(fakeClient.payment.payWithBillingKey).not.toHaveBeenCalled();
  });

  it("구독이 없으면 아무것도 하지 않는다", async () => {
    const { cancelForPurchaserDeletion } = await cancel();
    expect(await cancelForPurchaserDeletion("nobody")).toEqual({ subscriptions: 0, refundedKrw: 0 });
  });

  it("어르신(혜택 대상) 계정 삭제 → 위약금 없이 이용일수만 공제 11,940원(구독 행이 Cascade로 사라져 나중에 고를 수 없다)", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-11-13T09:00:00"));
    const { cancelForBeneficiaryGone } = await cancel();
    expect(await cancelForBeneficiaryGone("elder-1", { reason: "beneficiary_deleted" })).toEqual({ subscriptions: 1, refundedKrw: 11_940 });
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "revoked", cancelType: "beneficiary_deleted" });
    expect(mail.sent.at(-1)).toMatchObject({ to: "guardian-1@example.com", subject: "[마음이음] 이용권 환불 — 11,940원" });
  });
});

describe("보호자-어르신 연결 해제 — 다음 결제부터 해지, 원하면 위약금 없는 지금 해지", () => {
  it("연결 해제 → canceled(link_gone) + 예약 취소 → 빌링키 삭제 + 안내 메일, 만료일까지 혜택", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-11-13T09:00:00"));
    pg.log.length = 0;
    const { cancelForBeneficiaryGone } = await cancel();
    expect(await cancelForBeneficiaryGone("elder-1", { reason: "link_revoked", purchaserUserId: "guardian-1" })).toEqual({ subscriptions: 1, refundedKrw: 0 });
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", cancelType: "link_gone", billingKeyEnc: null, nextChargeAt: null });
    expect(pg.log.filter((l) => !l.startsWith("get:"))).toEqual([`revoke:${s.billingKey}`, `deleteKey:${s.billingKey}`]);
    expect(mail.sent.at(-1)?.text).toContain("위약금 없이 지금 해지");
    expect(await tier(s.elder)).toBe("pro");
  });

  it("그 뒤 결제회원이 지금 해지 → 위약금 없이 11,940원(12일째)", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-11-13T09:00:00"));
    const { cancelForBeneficiaryGone, cancelNow } = await cancel();
    await cancelForBeneficiaryGone("elder-1", { reason: "link_revoked" });
    expect(await cancelNow(s.subscriptionId, { purchaserUserId: "guardian-1" })).toMatchObject({ ok: true, refundKrw: 11_940 });
  });

  it("포트원 예약 취소가 실패해도 멈추지 않는다 — 연결 해제는 정보 열람 동의 철회라 결제대행사 상태에 묶이면 안 된다(10-22 검토): 의사 기록·해지 메일·운영 경보", async () => {
    const s = await startSubscription();
    pg.failRevokeWith = "FORBIDDEN";
    const { cancelForBeneficiaryGone } = await cancel();
    expect(await cancelForBeneficiaryGone("elder-1", { reason: "link_revoked" })).toEqual({ subscriptions: 1, refundedKrw: 0 });
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", cancelType: "link_gone", nextChargeAt: null });
    expect(subRow(s.subscriptionId).billingKeyEnc).not.toBeNull(); // 남은 빌링키는 예약 작업이 지운다
    expect(mail.sent.at(-1)?.subject).toBe("[마음이음] 이용권 해지 완료"); // 결제회원은 바로 안다(예전엔 만료 때 '해지하신'만 받았다)
    expect(mail.ops.map((o) => o.subject)).toContain("[결제] 빌링키 정리 실패 — 예약 작업이 다시 시도");
  });

  it("빌링키를 풀 수 없어도(ENCRYPTION_KEY 교체) 멈추지 않는다 — 의사는 기록하고 운영 경보", async () => {
    const s = await startSubscription();
    process.env.ENCRYPTION_KEY = "f".repeat(64);
    try {
      const { cancelForBeneficiaryGone } = await cancel();
      expect((await cancelForBeneficiaryGone("elder-1", { reason: "link_revoked" })).subscriptions).toBe(1);
      expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", cancelType: "link_gone" });
      expect(mail.ops.map((o) => o.subject)).toContain("[결제] 빌링키 정리 실패 — 예약 작업이 다시 시도");
    } finally {
      process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    }
  });

  it("첫 결제 중(activating)이면 건드리지 않고 넘어간다 — 결제가 끝나면 연결 확인으로 다음 회차를 걸지 않는다", async () => {
    seedFamily();
    const { createPendingSubscription } = await import("@/lib/billing/portone-activate");
    const p = await createPendingSubscription({ purchaserUserId: "guardian-1", beneficiaryUserId: "elder-1", plan: PLAN_DAY30, method: "CARD", consent: CONSENT });
    if (!p.ok) throw new Error("준비 실패");
    db.subscription.rows.find((r) => r.id === p.subscriptionId)!.status = "activating";
    const { cancelForBeneficiaryGone } = await cancel();
    expect(await cancelForBeneficiaryGone("elder-1", { reason: "link_revoked" })).toEqual({ subscriptions: 0, refundedKrw: 0 });
    expect(subRow(p.subscriptionId).status).toBe("activating");
  });

  it("다른 보호자가 결제한 것은 건드리지 않는다(purchaserUserId) · 본인 결제(일반인)는 대상이 아니다", async () => {
    const s = await startSubscription();
    db.subscription.rows.push({ id: "general-self", purchaserUserId: "elder-1", beneficiaryUserId: "elder-1", provider: "portone", status: "expired",
      purchaseToken: "portone:bkself", billingKeyEnc: "enc:v1:x" });
    const { cancelForBeneficiaryGone } = await cancel();
    expect(await cancelForBeneficiaryGone("elder-1", { reason: "link_revoked", purchaserUserId: "guardian-2" })).toEqual({ subscriptions: 0, refundedKrw: 0 });
    expect(subRow(s.subscriptionId).status).toBe("active");
    // 거르지 않으면 보호자가 결제한 것만 정리되고, 본인 결제(결제회원 탈퇴 쪽에서 처리)는 그대로
    expect((await cancelForBeneficiaryGone("elder-1", { reason: "beneficiary_deleted" })).subscriptions).toBe(1);
    expect(subRow(s.subscriptionId).status).toBe("revoked");
    expect(subRow("general-self").billingKeyEnc).toBe("enc:v1:x");
  });
});
