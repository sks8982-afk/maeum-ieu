/**
 * 포트원 결제 입력·예약 걸기 — **서버 전용**. 결제 상태 동기화(lib/billing/portone-sync)·첫 결제(portone-activate)·예약 작업
 *   (portone-maintenance)이 같이 쓴다(portone-sync에서 나눴다 — 파일 크기. 이 모듈은 구독 상태를 바꾸지 않는다).
 *
 * 포트원에는 반복 예약이 없어 회차마다 이어 붙인다(research B 0) — 원장 행(scheduled)을 먼저 만들고 포트원 예약을 건다.
 */
import type { BillingPayment, Subscription } from "@/generated/prisma/client/client";
import { prisma } from "@/lib/prisma";
import { portone, portoneErrorType, readBillingKey } from "@/lib/billing/portone-client";
import { ORDER_NAME } from "@/lib/billing/portone-plans";

/** 결제 이름 — 결제창·영수증에 같은 말로 */
export function orderNameFor(dailyTurnLimit: number | null): string {
  return dailyTurnLimit ? `${ORDER_NAME}(하루 대화 ${dailyTurnLimit}회)` : ORDER_NAME;
}

/** 포트원 결제 입력(빌링키 결제·예약 결제 공통) — 고객 식별은 내부 불투명 id만(네이버 merchantUserId에 개인정보 금지) */
export function billingPaymentInput(sub: Subscription, billingKey: string, amountKrw: number) {
  return {
    billingKey, orderName: orderNameFor(sub.dailyTurnLimit),
    amount: { total: amountKrw, taxFree: 0 }, // 카카오페이는 면세금액이 필수 — 0을 명시(research B 6)
    currency: "KRW" as const, customer: { id: sub.purchaserUserId }, productType: "DIGITAL" as const,
  };
}

/**
 * 원장의 예약 행(scheduled)을 포트원에 예약한다. 포트원이 "이미 있다"고 하면 성공으로 본다 — 그때는 예약 id를 모르므로
 *   nextScheduleId에 그 결제 id를 둔다(예약 취소는 빌링키 단위라 id가 필요 없다 — 값은 "예약이 있다"는 표시로만 쓴다).
 *   구독 표시는 살아 있는 구독에만 남긴다 — 예약을 거는 사이 해지됐으면 그 해지(빌링키 정리 — 예약 작업이 마저 한다)가 이긴다.
 */
export async function scheduleLedgerRow(
  sub: Subscription, row: BillingPayment, billingKey: string, now = new Date(),
): Promise<"scheduled" | "exists" | "skipped"> {
  if (row.status !== "scheduled" || !row.scheduledAt) return "skipped";
  // 지난 시각으로는 예약하지 않는다(예약 작업이 늦게 다시 걸 때) — 1분 뒤로
  const timeToPay = new Date(Math.max(row.scheduledAt.getTime(), now.getTime() + 60_000));
  let scheduleId = row.paymentId;
  let result: "scheduled" | "exists" = "scheduled";
  try {
    const { schedule } = await portone().payment.paymentSchedule.createPaymentSchedule({
      paymentId: row.paymentId, payment: billingPaymentInput(sub, billingKey, row.amountKrw), timeToPay: timeToPay.toISOString(),
    });
    scheduleId = schedule.id;
  } catch (e) {
    const t = portoneErrorType(e);
    if (t !== "PAYMENT_SCHEDULE_ALREADY_EXISTS" && t !== "ALREADY_PAID_OR_WAITING") throw e;
    result = "exists";
  }
  await prisma.subscription.updateMany({
    where: { id: sub.id, status: { in: ["active", "grace"] }, cancelAtPeriodEnd: false },
    data: { nextScheduleId: scheduleId, nextChargeAt: row.scheduledAt },
  });
  return result;
}

/** 예약 실패는 결제 확정을 되돌리지 않는다 — 예약 작업이 nextScheduleId 없는 구독을 찾아 다시 건다 */
export async function scheduleLedgerRowSafe(sub: Subscription, row: BillingPayment): Promise<void> {
  try {
    const billingKey = readBillingKey(sub.billingKeyEnc);
    if (billingKey) await scheduleLedgerRow(sub, row, billingKey);
  } catch (e) {
    console.error(`[billing-pg] 재시도 예약 실패(예약 작업이 다시 건다) payment=${row.paymentId}:`, e instanceof Error ? e.message : e);
  }
}
