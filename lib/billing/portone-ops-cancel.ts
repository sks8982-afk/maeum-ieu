/**
 * 전화·이메일로 받은 해지·청약철회 처리 — 운영자 전용(scripts/ops-billing-cancel.ts가 부른다, 2026-10-22 검토).
 *
 * 왜: 약관 제7조④·제8조①은 "고객센터 전화나 이메일로도 신청할 수 있습니다"라고 하는데, 화면 API(/api/billing/portone/refund)는
 *   **처리하는 시각**으로 7일을 판정한다 — 6일째 메일을 9일째 처리하면 철회가 거절됐다. 청약철회는 의사를 보낸 때 효력이 생기므로
 *   (전자상거래법 제17조⑤) 여기서는 **신청 시각**을 기준으로 계산하고 기록한다(revokedAt·해지 기록의 신청 시각 = 신청 시각).
 * 지키는 것:
 *   · 신청 시각은 지금보다 뒤일 수 없고, 30일보다 오래되면 받지 않는다(입력 실수로 엉뚱한 기간을 환불하지 않게 — 운영자가 확인 후 다시).
 *   · 신청 뒤에 결제된 회차가 있으면 처리하지 않는다 — 그 회차는 전액 돌려줘야 하고(약관 제12조) 이 계산은 한 회차만 다룬다.
 *     사람이 확인해 처리한다(개발에 넘긴다).
 *   · 본인 확인(결제회원 본인인지)은 운영자가 먼저 한다 — 해지·환불은 결제회원만 신청한다(약관 제13조).
 */
import { prisma } from "@/lib/prisma";
import {
  type CancelResult, type CancellationQuote, cancelAtPeriodEnd, cancelNow, quoteCancellation,
} from "@/lib/billing/portone-cancel";

/** 이보다 오래된 신청 시각은 받지 않는다 */
const MAX_REQUEST_AGE_MS = 30 * 24 * 3_600_000;

export type OpsCancelMode = "now" | "period_end";

export type OpsCancelPlan =
  | { ok: true; subscriptionId: string; mode: OpsCancelMode; requestedAt: Date; quote: CancellationQuote }
  | { ok: false; reason: string };

/** 신청 시각 기준 미리보기 — 아무것도 바꾸지 않는다 */
export async function planOpsCancel(
  subscriptionId: string, mode: OpsCancelMode, requestedAt: Date, now = new Date(),
): Promise<OpsCancelPlan> {
  if (Number.isNaN(requestedAt.getTime())) return { ok: false, reason: "신청 시각을 읽지 못했습니다(예: 2026-11-08T21:30:00+09:00)" };
  if (requestedAt > now) return { ok: false, reason: "신청 시각이 지금보다 뒤입니다" };
  if (now.getTime() - requestedAt.getTime() > MAX_REQUEST_AGE_MS) return { ok: false, reason: "신청 시각이 30일보다 오래되었습니다 — 확인한 뒤 개발에 넘기세요" };
  const later = await prisma.billingPayment.findFirst({
    where: { subscriptionId, status: { in: ["paid", "partial_cancelled"] }, paidAt: { gt: requestedAt } },
    select: { paidAt: true, amountKrw: true },
  });
  if (later) {
    return { ok: false, reason: `신청 뒤(${later.paidAt?.toISOString()})에 결제된 회차(${later.amountKrw}원)가 있습니다 — 그 회차는 전액 환불 대상이라 이 스크립트로 처리하지 않습니다. 개발에 넘기세요` };
  }
  const q = await quoteCancellation(subscriptionId, {}, requestedAt);
  if (!q.ok) return { ok: false, reason: q.code === "not_cancellable" ? "이미 끝났거나 해지할 수 없는 이용권입니다" : "이용권을 찾지 못했습니다" };
  return { ok: true, subscriptionId, mode, requestedAt, quote: q.quote };
}

/** 미리보기 그대로 처리 — 지금 해지(청약철회 기간 안이면 청약철회)는 결제 취소로 환불, 다음 결제부터는 예약 취소·빌링키 삭제 */
export function runOpsCancel(plan: Extract<OpsCancelPlan, { ok: true }>): Promise<CancelResult> {
  return plan.mode === "now"
    ? cancelNow(plan.subscriptionId, {}, plan.requestedAt)
    : cancelAtPeriodEnd(plan.subscriptionId, {}, plan.requestedAt);
}
