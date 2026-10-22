/**
 * 포트원 결제 상태 동기화 — 웹훅·브라우저 복귀·예약 작업(cron)이 모두 syncPayment 하나로 수렴한다(멱등).
 *
 * 신뢰 원천은 **포트원 재조회 결과**다. 웹훅 본문·리디렉션 쿼리는 "무언가 바뀌었다"는 신호로만 쓴다(research B 0·7).
 * 원장(BillingPayment)에 없는 paymentId는 우리 결제가 아니므로 무시한다.
 *
 * 혜택을 주기 전에 대조한다 — 금액·통화(KRW)·빌링키 지문·채널(test/live). 하나라도 다르면 혜택을 주지 않고 운영 경보.
 *   실연동으로 바꾼 뒤 남은 시험 구독의 시험 결제는 취소하고 그 구독을 끝낸다(매일 같은 불일치로 붙들지 않게).
 * 받지 말아야 할 결제(같은 회차 중복·해지 뒤 결제·구독 기록 없음)는 전액 취소한다 — 이중 결제 방어(research B 9, lib/billing/portone-refund).
 *
 * 경쟁(2026-10-22 검토): 구독 행을 읽은 뒤 **조건 없이 덮어쓰지 않는다**. 결제 반영·재시도·만료·외부 취소·해지는 "읽은 그대로일 때만"
 *   바꾸는 조건부 갱신(updateMany + count)을 쓴다 — 그 사이 해지가 끼어들었으면 결제 반영을 되돌리고 그 결제를 전액 취소하고(markPaid),
 *   해지 쪽은 다시 읽어 새 상태로 계산한다(stopRenewal·lib/billing/portone-cancel cancelNow). 예전엔 해지와 갱신이 수십 ms 안에 겹치면
 *   돈은 나갔는데 혜택·환불이 없거나, active로 굳어 같은 어르신의 재가입이 영구히 막혔다.
 *
 * 상태(Subscription.status — research B 10):
 *   activating → active(첫 결제) / failed(첫 결제 실패 — 빌링키 삭제)
 *   active → grace(갱신 실패, 1일·3일 뒤 10:00 KST 재시도 — 혜택 유지) → active 또는 expired(예약 취소·빌링키 삭제·메일)
 * 포트원 정리(예약 취소·빌링키 삭제)가 실패해도 여기서 throw하지 않는다 — 웹훅이 재전송돼도 원장은 이미 바뀌어 다시 돌지 않으므로,
 *   예약 작업(lib/billing/portone-maintenance)이 "끝난 구독인데 빌링키가 남은 것"을 찾아 마저 지운다.
 */
import type { BillingPayment, Subscription } from "@/generated/prisma/client/client";
import type { Payment } from "@portone/server-sdk";
import { prisma } from "@/lib/prisma";
import {
  billingKeyFingerprint, portone, portoneErrorType, readBillingKey, revokeThenDeleteKey,
} from "@/lib/billing/portone-client";
import { expectedChannelType } from "@/lib/billing/portone-plans";
import { GRACE_MARGIN_MS, RETRY_OFFSETS_DAYS, anchorDayOf, nextChargeAt, paymentIdFor, retryAt } from "@/lib/billing/portone-period";
import {
  billingOpsAlert, safeReceiptUrl, sendCanceledMail, sendExpiredMail, sendPaymentCompleteMail, sendPaymentFailedMail, sendRefundMail,
} from "@/lib/billing/portone-mail";
import { recordCancellation, refundUnwanted } from "@/lib/billing/portone-refund";
import { scheduleLedgerRow, scheduleLedgerRowSafe } from "@/lib/billing/portone-schedule";

export { billingPaymentInput, orderNameFor, scheduleLedgerRow } from "@/lib/billing/portone-schedule";

export type SyncResult =
  | "ignored" | "not_found" | "pending" | "unchanged" | "paid" | "mismatch" | "refunded"
  | "failed" | "retry_scheduled" | "expired" | "cancelled";

/** 결제가 끝난(또는 돌려주기 시작한) 원장 상태 — 다시 '새 결제'로 반영하지 않는다(취소 요청 중인 결제가 PAID로 보여도) */
const SETTLED = ["paid", "partial_cancelled", "cancelled"];
/** 결제를 받아 혜택으로 반영할 수 있는 구독 상태 */
const PAYABLE = ["active", "grace", "activating"];
/** 다음 결제부터 해지할 수 있는 상태(이미 해지 예약이면 남은 정리만) */
const STOPPABLE = ["active", "grace", "canceled"];

/** 결제 반영 트랜잭션 안에서 구독이 읽은 뒤 바뀌었음(해지·종료) — 원장 반영까지 되돌린다 */
class StaleSubscription extends Error {}

/** 이 결제를 다시 조회해 원장·구독에 반영한다 — 몇 번을 불러도 같은 결과(멱등) */
export async function syncPayment(paymentId: string, now = new Date()): Promise<SyncResult> {
  const row = await prisma.billingPayment.findUnique({ where: { paymentId } });
  if (!row) return "ignored"; // 우리가 만든 결제가 아니다
  let p: Payment.Payment;
  try {
    p = await portone().payment.getPayment({ paymentId });
  } catch (e) {
    // getPayment는 없으면 null이 아니라 PAYMENT_NOT_FOUND를 던진다(웹훅 문서 예제의 === null 확인은 동작하지 않는다)
    if (portoneErrorType(e) === "PAYMENT_NOT_FOUND") return "not_found";
    throw e;
  }
  switch (p.status) {
    case "PAID": {
      const result = await markPaid(row, p, now);
      if (result === "paid") await ensureNextScheduleSafe(row.subscriptionId, now);
      return result;
    }
    case "FAILED":
      // PG 메시지를 앞에 — 첫 결제 실패는 이 문구를 가공 없이 보여 준다(네이버페이 조건, research B10)
      return markFailedAndRetry(row, p.failure.pgMessage ?? p.failure.reason ?? "", now);
    case "CANCELLED":
    case "PARTIAL_CANCELLED":
      return markCancelled(row, p.amount.cancelled, now);
    default:
      return "pending"; // READY·PAY_PENDING·새로 생긴 값 — 다음 웹훅(또는 예약 작업)을 기다린다
  }
}

/** 결제 확인 불일치 — 금액·통화·빌링키·채널(test/live). 하나라도 있으면 혜택을 주지 않는다 */
function paidMismatch(row: BillingPayment, p: Payment.PaidPayment): string[] {
  const problems: string[] = [];
  if (p.amount.total !== row.amountKrw) problems.push(`금액 ${p.amount.total}≠${row.amountKrw}`);
  if (p.currency !== "KRW") problems.push(`통화 ${p.currency}`);
  if (!p.billingKey || billingKeyFingerprint(p.billingKey) !== row.billingKeyHash) problems.push("빌링키");
  if (p.channel.type !== expectedChannelType()) problems.push(`채널 ${p.channel.type}`);
  return problems;
}

/** 받지 말아야 할 결제인가 — 사유(없으면 null) */
async function unwantedReason(row: BillingPayment, sub: Subscription | null): Promise<string | null> {
  if (!sub) return "구독 기록 없음(계정 삭제 등)";
  if (!PAYABLE.includes(sub.status) || sub.revokedAt || sub.cancelAtPeriodEnd) return `해지·종료 뒤 결제(${sub.status})`;
  const other = await prisma.billingPayment.findFirst({
    where: { subscriptionId: row.subscriptionId, cycleNo: row.cycleNo, status: "paid", paymentId: { not: row.paymentId } },
    select: { paymentId: true },
  });
  return other ? `같은 회차 중복 결제(먼저 결제된 ${other.paymentId})` : null;
}

/**
 * 결제 완료 반영 — 원장 paid, 구독 active·회차·만료(=다음 결제 시각), 결제 완료 메일(보냈으면 원장에 그 시각 — 못 보냈으면 예약 작업이 다시).
 *   이미 끝난 행(결제 완료·취소)이나 돌려주기 시작한 행(refundTargetKrw)은 다시 반영하지 않는다 — 결제사가 취소를 처리하는 동안 포트원은
 *   그 결제를 아직 PAID로 보여 주는데, 그걸 '해지 뒤 결제'로 보고 전액 취소하면 약관보다 많이 돌려준다(2026-10-22 검토).
 */
export async function markPaid(row: BillingPayment, p: Payment.PaidPayment, now = new Date()): Promise<SyncResult> {
  if (SETTLED.includes(row.status) || row.refundTargetKrw !== null) return "unchanged";
  const problems = paidMismatch(row, p);
  if (problems.length > 0) return isLeftoverTestPayment(p) ? endLeftoverTest(row, p, now) : withholdMismatch(row, problems);
  const sub = await prisma.subscription.findUnique({ where: { id: row.subscriptionId } });
  const unwanted = await unwantedReason(row, sub);
  if (unwanted || !sub) return refundUnwanted(row, p, unwanted ?? "구독 기록 없음", now);

  const paidAt = new Date(p.paidAt);
  const periodStart = row.periodStart ?? paidAt; // 갱신은 예정 시각부터(재시도로 늦게 결제돼도 결제일이 밀리지 않게)
  const anchorDay = sub.anchorDay ?? anchorDayOf(paidAt);
  const periodEnd = nextChargeAt(anchorDay, periodStart);
  const receiptUrl = safeReceiptUrl(p.receiptUrl);
  let applied: boolean;
  try {
    applied = await applyPaid(row, sub.id, { paidAt, periodStart, periodEnd, receiptUrl, anchorDay }, now);
  } catch (e) {
    if (!(e instanceof StaleSubscription)) throw e;
    return refundUnwanted(row, p, "결제를 반영하는 사이 해지·종료됨(해지와 겹쳐 들어온 결제)", now);
  }
  if (!applied) return "unchanged";
  const mailed = await sendPaymentCompleteMail(sub.id, { amountKrw: row.amountKrw, paidAt, periodStart, periodEnd, receiptUrl, nextCharge: true });
  if (mailed) await prisma.billingPayment.update({ where: { paymentId: row.paymentId }, data: { paidMailAt: now } });
  return "paid";
}

/**
 * 원장 paid + 구독 active를 한 트랜잭션으로 — 원장은 아직 끝나지 않은 행일 때만(동시에 온 같은 결제는 한 번만), 구독은 살아 있고
 *   해지되지 않았을 때만(읽은 뒤 해지가 끼어들었으면 StaleSubscription — 원장 반영까지 되돌린다). 반영했으면 true
 */
async function applyPaid(
  row: BillingPayment, subscriptionId: string,
  v: { paidAt: Date; periodStart: Date; periodEnd: Date; receiptUrl: string | null; anchorDay: number }, now: Date,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.billingPayment.updateMany({
      where: { paymentId: row.paymentId, status: { notIn: SETTLED }, refundTargetKrw: null },
      data: { status: "paid", paidAt: v.paidAt, periodStart: v.periodStart, periodEnd: v.periodEnd, receiptUrl: v.receiptUrl, failureReason: null },
    });
    if (claimed.count === 0) return false; // 동시에 들어온 다른 처리가 먼저 반영했다
    const updated = await tx.subscription.updateMany({
      where: { id: subscriptionId, status: { in: PAYABLE }, revokedAt: null, cancelAtPeriodEnd: false },
      data: {
        status: "active", cycleNo: row.cycleNo, anchorDay: v.anchorDay, expiresAt: v.periodEnd, failedChargeCount: 0, verifiedAt: now,
        nextChargeAt: v.periodEnd, nextScheduleId: null,
      },
    });
    if (updated.count === 0) throw new StaleSubscription();
    return true;
  });
}

/** 불일치 — 혜택 보류 + 운영 경보(원장은 그대로 두어 설정을 고치면 예약 작업이 다시 반영한다) */
async function withholdMismatch(row: BillingPayment, problems: string[]): Promise<SyncResult> {
  console.error(`[billing-pg] 결제 확인 불일치 — 혜택 보류 payment=${row.paymentId}: ${problems.join(", ")}`);
  await billingOpsAlert("[결제] 결제 확인 불일치 — 혜택 보류", [`paymentId: ${row.paymentId}`, `불일치: ${problems.join(", ")}`]);
  return "mismatch";
}

/** 실연동(live)으로 바꾼 뒤 남은 시험 구독의 결제(시험 채널) — 돈이 오가지 않는 결제로 혜택을 주지 않는다 */
function isLeftoverTestPayment(p: Payment.PaidPayment): boolean {
  return expectedChannelType() === "LIVE" && p.channel.type === "TEST";
}

/**
 * 시험 구독을 끝내고(예약 취소·빌링키 삭제) 그 시험 결제를 취소한다 — 원장을 남겨 두면 예약 작업이 매일 같은 불일치 경보를 다시 낸다
 *   (2026-10-22 검토). 구독부터 끝낸다 — 취소가 실패해도(시험 결제의 자동 취소 등) 더 결제되지 않게.
 */
async function endLeftoverTest(row: BillingPayment, p: Payment.PaidPayment, now: Date): Promise<SyncResult> {
  const sub = await prisma.subscription.findUnique({ where: { id: row.subscriptionId } });
  if (sub) {
    const r = await prisma.subscription.updateMany({
      where: { id: sub.id, status: { in: ["active", "grace", "canceled"] } },
      data: { status: "expired", expiresAt: now, nextChargeAt: null, nextScheduleId: null, canceledAt: sub.canceledAt ?? now, cancelType: "test_mode_ended" },
    });
    if (r.count > 0) await tryDropBillingKey(sub, "ADMIN", now);
  }
  return refundUnwanted(row, p, "운영 전환(live) 뒤 시험 결제", now);
}

/**
 * 결제 실패 반영 — 첫 결제면 구독 failed + 빌링키 삭제. 갱신·재시도면 다음 재시도를 예약(grace — 혜택 유지),
 *   재시도를 다 썼으면 expired + 예약 취소·빌링키 삭제 + 메일.
 */
export async function markFailedAndRetry(row: BillingPayment, reason: string, now = new Date()): Promise<SyncResult> {
  const claimed = await prisma.billingPayment.updateMany({
    where: { paymentId: row.paymentId, status: { in: ["requested", "scheduled"] } },
    data: { status: "failed", failureReason: reason.slice(0, 500) || "결제 실패" },
  });
  if (claimed.count === 0) return "unchanged"; // 이미 반영됨(웹훅 재전송)
  const sub = await prisma.subscription.findUnique({ where: { id: row.subscriptionId } });
  if (!sub) return "failed";
  if (row.kind === "first") return failFirstPayment(sub, now);
  // 해지·종료된 구독은 다시 시도하지 않는다
  if ((sub.status !== "active" && sub.status !== "grace") || sub.cancelAtPeriodEnd) return "failed";
  const next = retryAt(row.periodStart ?? now, row.attempt + 1, now);
  return next ? scheduleRetry(sub, row, next) : expireAfterFailures(sub, now);
}

async function failFirstPayment(sub: Subscription, now: Date): Promise<SyncResult> {
  const r = await prisma.subscription.updateMany({
    where: { id: sub.id, status: "activating" },
    data: { status: "failed", canceledAt: now, cancelType: "payment_failed" },
  });
  if (r.count > 0) await tryDropBillingKey(sub, "ADMIN", now);
  return "failed";
}

/** 재시도 예약 — 구독은 읽은 그대로(살아 있고 해지되지 않음)일 때만 grace로. 그 사이 해지됐으면 재시도 행을 닫고 그만둔다 */
async function scheduleRetry(sub: Subscription, row: BillingPayment, next: Date): Promise<SyncResult> {
  const attempt = row.attempt + 1;
  const paymentId = paymentIdFor(sub.id, row.cycleNo, `r${attempt}`);
  const retryRow = await prisma.billingPayment.upsert({
    where: { paymentId },
    update: {},
    create: {
      paymentId, subscriptionId: sub.id, purchaserUserId: sub.purchaserUserId, cycleNo: row.cycleNo, kind: "retry", attempt,
      amountKrw: row.amountKrw, payMethod: row.payMethod, billingKeyHash: row.billingKeyHash, status: "scheduled",
      periodStart: row.periodStart, scheduledAt: next,
    },
  });
  const graceUntil = new Date(Math.max(next.getTime() + GRACE_MARGIN_MS, sub.expiresAt?.getTime() ?? 0));
  const r = await prisma.subscription.updateMany({
    where: { id: sub.id, status: { in: ["active", "grace"] }, cancelAtPeriodEnd: false, cycleNo: sub.cycleNo },
    data: { status: "grace", failedChargeCount: attempt, nextChargeAt: next, nextScheduleId: null, expiresAt: graceUntil },
  });
  if (r.count === 0) {
    await prisma.billingPayment.updateMany({ where: { paymentId, status: "scheduled" }, data: { status: "revoked" } });
    return "failed";
  }
  await scheduleLedgerRowSafe(await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } }), retryRow);
  await sendPaymentFailedMail(sub.id, { retryAt: next });
  return "retry_scheduled";
}

/** 재시도를 다 씀 — 읽은 그대로일 때만 expired(그 사이 해지·환불이 끼어들었으면 그쪽이 정리한다) */
async function expireAfterFailures(sub: Subscription, now: Date): Promise<SyncResult> {
  const r = await prisma.subscription.updateMany({
    where: { id: sub.id, status: { in: ["active", "grace"] }, cycleNo: sub.cycleNo },
    data: {
      status: "expired", expiresAt: now, nextChargeAt: null, nextScheduleId: null, canceledAt: now, cancelType: "payment_failed",
      failedChargeCount: RETRY_OFFSETS_DAYS.length + 1,
    },
  });
  if (r.count === 0) return "failed";
  await tryDropBillingKey(sub, "ADMIN", now);
  await sendExpiredMail(sub.id, "payment_failed");
  return "expired";
}

/**
 * 취소(환불) 반영 — 원장의 취소 금액은 포트원 값 그대로. 우리가 시작하지 않은 **전액** 취소(콘솔 환불·PG 직접 취소)가
 *   지금 혜택의 근거인 회차(결제 완료로 반영했던 행)면 혜택을 끊는다. 우리가 한 환불(지금 해지·철회)은 구독이 이미 revoked라 건드리지 않는다.
 */
export async function markCancelled(row: BillingPayment, cancelledKrw: number, now = new Date()): Promise<SyncResult> {
  const status = cancelledKrw >= row.amountKrw ? "cancelled" : "partial_cancelled";
  if (row.status === status && row.cancelledKrw === cancelledKrw) return "unchanged";
  const wasPaidBasis = row.status === "paid" || row.status === "partial_cancelled";
  await prisma.billingPayment.update({ where: { paymentId: row.paymentId }, data: { status, cancelledKrw } });
  if (status !== "cancelled" || !wasPaidBasis || row.refundTargetKrw !== null) return "cancelled";
  const sub = await prisma.subscription.findUnique({ where: { id: row.subscriptionId } });
  if (!sub || sub.cycleNo !== row.cycleNo || !["active", "grace", "canceled"].includes(sub.status)) return "cancelled";
  const r = await prisma.subscription.updateMany({
    where: { id: sub.id, status: sub.status, cycleNo: sub.cycleNo },
    data: { status: "revoked", revokedAt: now, canceledAt: sub.canceledAt ?? now, cancelType: "refunded", nextChargeAt: null, nextScheduleId: null },
  });
  if (r.count === 0) return "cancelled";
  console.warn(`[billing-pg] 외부 전액 취소 — 혜택 종료 sub=${sub.id.slice(0, 8)} payment=${row.paymentId}`);
  await tryDropBillingKey(sub, "ADMIN", now);
  await sendRefundMail(sub.id, { refundKrw: cancelledKrw - row.cancelledKrw, reason: "결제 취소" });
  return "cancelled";
}

/**
 * 다음 회차 예약 — 원장 행(scheduled)을 먼저 만들고 포트원 예약을 건다. 이미 있으면(같은 paymentId) 그대로 둔다(멱등).
 *   포트원에는 반복 예약이 없어 회차마다 이어 붙인다(research B 0).
 */
export async function ensureNextSchedule(subscriptionId: string, now = new Date()): Promise<"scheduled" | "exists" | "skipped"> {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub || sub.provider !== "portone" || sub.status !== "active" || sub.cancelAtPeriodEnd
    || !sub.billingKeyEnc || !sub.expiresAt || sub.priceKrw == null) return "skipped";
  // 보호자·어르신 연결이 끊겼으면 다음 결제를 걸지 않는다(연결 해제 경로가 해지를 빠뜨려도 카드가 계속 결제되지 않게)
  if (!(await linkActive(sub))) {
    console.warn(`[billing-pg] 연결이 끊긴 구독 — 다음 결제부터 해지 sub=${sub.id.slice(0, 8)}`);
    await stopRenewal(sub, "link_gone", { requester: "ADMIN" }, now);
    return "skipped";
  }
  const billingKey = readBillingKey(sub.billingKeyEnc) as string;
  const cycleNo = sub.cycleNo + 1;
  const paymentId = paymentIdFor(sub.id, cycleNo);
  const row = await prisma.billingPayment.upsert({
    where: { paymentId },
    update: {},
    create: {
      paymentId, subscriptionId: sub.id, purchaserUserId: sub.purchaserUserId, cycleNo, kind: "renewal", attempt: 0,
      amountKrw: sub.priceKrw, payMethod: sub.payMethod, billingKeyHash: billingKeyFingerprint(billingKey), status: "scheduled",
      periodStart: sub.expiresAt, scheduledAt: sub.expiresAt,
    },
  });
  return scheduleLedgerRow(sub, row, billingKey, now);
}

/** 예약 실패는 결제 확정을 되돌리지 않는다 — 예약 작업이 nextScheduleId 없는 구독을 찾아 다시 건다 */
async function ensureNextScheduleSafe(subscriptionId: string, now: Date): Promise<void> {
  try {
    await ensureNextSchedule(subscriptionId, now);
  } catch (e) {
    console.error(`[billing-pg] 다음 회차 예약 실패(예약 작업이 다시 건다) sub=${subscriptionId.slice(0, 8)}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * 끝난 구독의 빌링키 정리 — 예약 취소 → 빌링키 삭제 → billingKeyEnc null, 남은 예약 행은 revoked.
 *   예약이 방금 실행됐으면 그 회차를 다시 조회한다 — 끝난 구독에 들어온 결제는 markPaid가 전액 취소한다.
 *   포트원이 실패하면 throw(예약 작업처럼 실패를 세야 하는 곳). 멈추지 않아도 되는 곳은 tryDropBillingKey.
 */
export async function dropBillingKey(sub: Subscription, requester: "CUSTOMER" | "ADMIN", now = new Date()): Promise<void> {
  const billingKey = readBillingKey(sub.billingKeyEnc);
  if (billingKey) await revokeThenDeleteKey(billingKey, () => syncOpenRows(sub.id, now), requester);
  await prisma.subscription.update({ where: { id: sub.id }, data: { billingKeyEnc: null } });
  await prisma.billingPayment.updateMany({ where: { subscriptionId: sub.id, status: "scheduled" }, data: { status: "revoked" } });
}

/** dropBillingKey — 실패해도 throw하지 않는다(웹훅 처리 중 등). 예약 작업이 "끝났는데 빌링키가 남은 구독"을 찾아 마저 한다 */
export async function tryDropBillingKey(sub: Subscription, requester: "CUSTOMER" | "ADMIN", now = new Date()): Promise<boolean> {
  try {
    await dropBillingKey(sub, requester, now);
    return true;
  } catch (e) {
    const kind = portoneErrorType(e) ?? (e instanceof Error ? e.message.slice(0, 80) : "알 수 없음");
    console.error(`[billing-pg] 빌링키 정리 실패(예약 작업이 다시 한다) sub=${sub.id.slice(0, 8)}: ${kind}`);
    await billingOpsAlert("[결제] 빌링키 정리 실패 — 예약 작업이 다시 시도", [`subscription: ${sub.id}`, `오류: ${kind}`]);
    return false;
  }
}

/** 결제회원과 혜택 대상의 연결이 살아 있나 — 본인 결제는 늘 참 */
export async function linkActive(sub: Pick<Subscription, "purchaserUserId" | "beneficiaryUserId">): Promise<boolean> {
  if (sub.purchaserUserId === sub.beneficiaryUserId) return true;
  const link = await prisma.expertPatient.findUnique({
    where: { expertUserId_patientUserId: { expertUserId: sub.purchaserUserId, patientUserId: sub.beneficiaryUserId } },
    select: { status: true },
  });
  return link?.status === "active";
}

/**
 * 다음 결제부터 해지 — 의사를 **먼저** 기록하고(canceled·다음 결제 없음) 예약 취소 → 빌링키 삭제. 의사를 먼저 적는 이유:
 *   포트원 호출이 실패해도 예약 작업이 다시 결제를 걸지 않고, 그 사이 실행된 예약 결제는 markPaid가 전액 취소한다.
 *   기록은 읽은 그대로일 때만(조건부) — 그 사이 갱신 결제가 반영됐으면 다시 읽어 **새 만료일로** 다시 적는다(옛 만료일로 덮어쓰면 낸 회차의
 *   혜택이 사라진다 — 2026-10-22 검토). 재시도 중(grace)이면 낸 기간이 이미 끝났으므로 혜택도 지금 끝난다.
 *   포트원 정리 실패는 throw하지 않는다(운영 경보 — 예약 작업이 마저 한다). DB 실패만 throw. 해지 기록은 원장에도 남긴다(5년 보존).
 *   돌려주는 값: 이용이 끝나는 시각(이미 끝난 구독이면 그 만료 시각).
 */
export async function stopRenewal(
  subIn: Subscription, cancelType: string, opts: { requester: "CUSTOMER" | "ADMIN" }, now = new Date(),
): Promise<Date | null> {
  let sub = subIn;
  for (let attempt = 0; ; attempt++) {
    const endsAt = sub.status === "grace" ? now : sub.expiresAt;
    const r = await prisma.subscription.updateMany({
      where: { id: sub.id, status: sub.status, cycleNo: sub.cycleNo },
      data: {
        status: "canceled", cancelAtPeriodEnd: true, canceledAt: sub.canceledAt ?? now, cancelType,
        nextChargeAt: null, nextScheduleId: null, expiresAt: endsAt,
      },
    });
    if (r.count > 0) break;
    const fresh = await prisma.subscription.findUnique({ where: { id: sub.id } });
    if (!fresh || !STOPPABLE.includes(fresh.status)) return fresh?.expiresAt ?? null; // 그 사이 끝났다(지금 해지·만료)
    if (attempt >= 2) throw new Error("다음 결제부터 해지 중 구독이 계속 바뀜 — 잠시 후 다시");
    sub = fresh;
  }
  const endsAt = sub.status === "grace" ? now : sub.expiresAt;
  await tryDropBillingKey(await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } }), opts.requester, now);
  // 남은 정리만 다시 하는 호출(이미 같은 이유로 해지됨)에는 기록·메일을 또 남기지 않는다
  if (sub.status !== "canceled" || sub.cancelType !== cancelType) {
    await recordCancellation(prisma, sub.id, cancelType, now);
    await sendCanceledMail(sub.id, { endsAt, linkGone: cancelType === "link_gone", endedNow: sub.status === "grace" });
  }
  return endsAt;
}

/** 아직 결과가 없는 원장 행(요청·예약)을 모두 다시 조회한다 */
export async function syncOpenRows(subscriptionId: string, now = new Date()): Promise<void> {
  const rows = await prisma.billingPayment.findMany({
    where: { subscriptionId, status: { in: ["requested", "scheduled"] } }, select: { paymentId: true },
  });
  for (const r of rows) await syncPayment(r.paymentId, now);
}
