/**
 * 포트원 환불(결제 취소)과 해지 기록 — 지금 해지·청약철회(lib/billing/portone-cancel)·받지 말아야 할 결제(lib/billing/portone-sync)·
 *   예약 작업(lib/billing/portone-maintenance)이 같이 쓴다. **서버 전용**.
 *
 * 환불 한 건 = 원장 행의 누적 취소액을 목표액(refundTargetKrw — 신청 시점에 고정)까지 올리는 일. 몇 번을 불러도 같은 돈을 두 번 돌려주지 않는다:
 *   ① 먼저 포트원을 다시 조회해 실제 누적 취소액으로 원장을 맞춘다(앞선 환불이 됐는데 기록 전에 끊긴 경우)
 *   ② 결제사가 처리 중인 취소 요청(REQUESTED)이 있으면 새로 요청하지 않는다 — 끝나면 웹훅(Transaction.*Cancelled)·예약 작업이 확정한다
 *   ③ 남은 몫만 currentCancellableAmount와 함께 요청한다(포트원 쪽 남은 취소 가능액과 다르면 포트원이 거절 — 이중 환불 방지)
 *   ④ 응답의 cancellation.status를 본다(2026-10-22 검토): SUCCEEDED만 원장에 적고, REQUESTED는 요청 접수로만(확정은 ①·웹훅),
 *      FAILED는 throw(예약 작업이 같은 목표액으로 다시 — 돌려주지 않은 돈을 돌려줬다고 적지 않는다).
 * 환불은 원래 결제수단의 결제 취소로만 한다(자체 포인트 환불 금지 — 카드 가맹점 표준약관·네이버페이 결제형 조건).
 */
import type { BillingPayment } from "@/generated/prisma/client/client";
import type { Payment } from "@portone/server-sdk";
import { prisma } from "@/lib/prisma";
import { portone } from "@/lib/billing/portone-client";
import { billingOpsAlert, sendRefundMail } from "@/lib/billing/portone-mail";

type Requester = "CUSTOMER" | "ADMIN";

/** 결제사가 아직 처리 중인 취소 요청이 있나(PAID·부분 취소 결제의 cancellations) */
function hasPendingCancellation(p: Payment.Payment): boolean {
  const list = (p as { cancellations?: { status?: unknown }[] }).cancellations;
  return Array.isArray(list) && list.some((c) => c.status === "REQUESTED");
}

/** 누적 취소액에 맞는 원장 상태 */
function statusFor(row: BillingPayment, cancelled: number): string {
  return cancelled >= row.amountKrw ? "cancelled" : cancelled > 0 ? "partial_cancelled" : row.status;
}

/** 포트원의 실제 누적 취소액으로 원장을 맞춘다 — 그 값과 포트원 결제 */
async function refreshCancelled(row: BillingPayment): Promise<{ cancelled: number; p: Payment.Payment }> {
  const p = await portone().payment.getPayment({ paymentId: row.paymentId });
  const cancelled = "amount" in p ? p.amount.cancelled : row.cancelledKrw;
  if (cancelled !== row.cancelledKrw) {
    await prisma.billingPayment.update({ where: { paymentId: row.paymentId }, data: { cancelledKrw: cancelled, status: statusFor(row, cancelled) } });
  }
  return { cancelled, p };
}

/**
 * 원장 행의 누적 취소액을 목표(refundTargetKrw)까지 — 이번에 돌려준(또는 결제사에 요청한) 금액. 포트원 실패·결제사 거절은 throw.
 *   REQUESTED는 요청한 금액을 돌려준 것으로 센다(화면·메일 안내 — "실제 환불까지 며칠"), 원장의 누적 취소액은 확정 뒤에 오른다.
 */
export async function settleRefund(row: BillingPayment, reason: string, requester: Requester = "CUSTOMER"): Promise<number> {
  const target = row.refundTargetKrw ?? 0;
  const { cancelled, p } = await refreshCancelled(row);
  if (cancelled >= target || hasPendingCancellation(p)) return 0;
  const total = "amount" in p ? p.amount.total : row.amountKrw;
  const amount = target - cancelled;
  const { cancellation } = await portone().payment.cancelPayment({
    paymentId: row.paymentId, amount, reason, requester, currentCancellableAmount: total - cancelled,
  });
  if (cancellation.status === "SUCCEEDED") {
    await prisma.billingPayment.update({ where: { paymentId: row.paymentId }, data: { cancelledKrw: target, status: statusFor(row, target) } });
    return amount;
  }
  if (cancellation.status === "FAILED") throw new Error(`결제사가 결제 취소를 거절 payment=${row.paymentId}`);
  console.warn(`[billing-pg] 결제 취소 요청 접수(${String(cancellation.status)}) — 확정은 웹훅·예약 작업 payment=${row.paymentId}`);
  return amount;
}

/**
 * 받지 말아야 할 결제(같은 회차 중복·해지 뒤 결제·구독 기록 없음·운영 전환 뒤 시험 결제)를 전액 취소 — 운영 경보와 결제회원 환불 메일.
 *   목표액을 먼저 원장에 고정한다(전액) — 다시 와도(웹훅 재전송·예약 작업) 같은 목표로 이어 가고, 결제 완료로 반영하지 않는다(markPaid).
 *   포트원 실패는 운영 경보 뒤 throw(웹훅은 500 — 재전송, 예약 작업도 덜 된 환불로 다시 잡는다).
 */
export async function refundUnwanted(row: BillingPayment, p: Payment.PaidPayment, reason: string, now = new Date()): Promise<"refunded"> {
  console.error(`[billing-pg] 받지 말아야 할 결제 — 전액 취소 payment=${row.paymentId}: ${reason}`);
  await prisma.billingPayment.updateMany({
    where: { paymentId: row.paymentId, refundTargetKrw: null },
    data: { refundTargetKrw: p.amount.total, paidAt: new Date(p.paidAt), failureReason: reason, cancelType: "unwanted", cancelRequestedAt: now },
  });
  const fresh = await prisma.billingPayment.findUniqueOrThrow({ where: { paymentId: row.paymentId } });
  let refunded: number;
  try {
    refunded = await settleRefund(fresh, "중복·해지 후 결제 취소", "ADMIN");
  } catch (e) {
    await billingOpsAlert("[결제] 받지 말아야 할 결제 취소 실패 — 직접 확인", [`paymentId: ${row.paymentId}`, `사유: ${reason}`]);
    throw e;
  }
  await billingOpsAlert("[결제] 받지 말아야 할 결제를 전액 취소", [`paymentId: ${row.paymentId}`, `사유: ${reason}`]);
  if (refunded > 0) await sendRefundMail(row.subscriptionId, { refundKrw: refunded, reason: "중복 또는 해지 뒤 결제된 금액 취소" });
  return "refunded";
}

/** 덜 된 환불(목표액 > 누적 취소액)이 있는 원장 행 — 예약 작업이 이어 간다(구독 상태·존재와 무관 — 계정이 지워진 결제도) */
export function findOutstandingRefunds(limit: number): Promise<BillingPayment[]> {
  return prisma.billingPayment.findMany({
    where: { refundTargetKrw: { gt: prisma.billingPayment.fields.cancelledKrw } },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
}

/** 한 구독의 덜 된 환불을 이어 간다 — 이번에 돌려준 금액. 포트원 실패는 throw */
export async function settleSubscriptionRefunds(subscriptionId: string, reason: string, requester: Requester = "CUSTOMER"): Promise<number> {
  const rows = await prisma.billingPayment.findMany({
    where: { subscriptionId, refundTargetKrw: { gt: prisma.billingPayment.fields.cancelledKrw } },
  });
  let refunded = 0;
  for (const row of rows) refunded += await settleRefund(row, reason, requester);
  return refunded;
}

/** 트랜잭션 안팎에서 원장을 쓰는 곳 */
type LedgerDb = Pick<typeof prisma, "billingPayment">;

/**
 * 계약을 끝낸 해지·청약철회를 원장에 남긴다 — 지금 혜택의 근거인(마지막으로 결제된) 회차 행에 종류와 신청 시각.
 *   왜(2026-10-22 검토): 해지 종류(cancelType)·시각은 구독 기록(Subscription)에만 있었는데 그 표는 계정 삭제에 함께 지워진다 —
 *   처리방침의 '계약·청약철회 기록 5년 보관'(시행령 제6조)이 거짓이 된다. 원장은 FK가 없어 남는다. 나중 해지가 앞의 것을 덮는다
 *   (다음 결제부터 해지 → 지금 해지면 지금 해지가 계약을 끝냈다).
 *   계약의 근거가 아닌 행은 고르지 않는다: 해지 뒤 실행돼 전액 취소한 결제(cancelType unwanted — 그 표시를 덮으면 왜 취소했는지 기록이
 *   사라진다)와 결제 시각이 없는 행(Postgres DESC는 NULL을 맨 앞에 둔다).
 */
export async function recordCancellation(db: LedgerDb, subscriptionId: string, cancelType: string, requestedAt: Date): Promise<void> {
  const row = await db.billingPayment.findFirst({
    where: {
      subscriptionId, status: { in: ["paid", "partial_cancelled", "cancelled"] }, paidAt: { not: null },
      OR: [{ cancelType: null }, { cancelType: { not: "unwanted" } }],
    },
    orderBy: { paidAt: "desc" }, select: { paymentId: true },
  });
  if (row) await db.billingPayment.update({ where: { paymentId: row.paymentId }, data: { cancelType, cancelRequestedAt: requestedAt } });
}
