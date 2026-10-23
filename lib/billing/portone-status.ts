/**
 * 구독 관리 화면용 포트원 이용권 정보 — /api/billing/status의 pg. **결제회원 본인 것만**(해지·환불은 결제회원만 한다 — 약관).
 *
 * 싣는 것(설계 '조사 반영 결정' 6 · research C 6 · D 6): 요금제·가입 당시 가격·결제수단·혜택 받는 분·다음 결제일·해지 예약 여부·
 *   '유료 혜택 사용: 있음/없음'·청약철회 기간 안인지·방식별 예상 환불액(다음 결제부터 해지 / 지금 해지 — 화면은 같은 크기로 보여 준다)·
 *   결제 내역 최근 100건(금액·일시·상태·영수증 — 화면은 5건 뒤 [더 보기]. 예전 5건뿐이면 첫 결제와 그 영수증을 볼 수 없었다 — 제8조③
 *   '언제든 열람', 2026-10-22 검토. 월 1건이라 100건이면 8년 치다).
 * 싣지 않는 것: 빌링키·결제 id·동의 원문. 실패 사유는 결제회원 본인의 결제수단 문제라 그대로 보여 준다(PG 문구 — 가공 금지).
 * 예상 환불액은 지금 시각 기준 추정이다 — 실제 해지 때 서버가 다시 계산한다(lib/billing/portone-cancel quoteCancellation).
 */
import type { BillingPayment, Subscription } from "@/generated/prisma/client/client";
import { prisma } from "@/lib/prisma";
import { PAY_METHOD_LABELS, isPayMethod, planDisplayName } from "@/lib/billing/portone-plans";
import { type CancellationQuote, quoteCancellation } from "@/lib/billing/portone-cancel";
import { safeReceiptUrl } from "@/lib/billing/portone-mail";

/** 관리 화면에 보이는 상태 — 첫 결제 확인 중(activating)·이용 중·결제 재시도 중(grace)·해지 예약(canceled) */
const SHOWN_STATUSES = ["activating", "active", "grace", "canceled"];
/** 결제 내역에 넣는 원장 상태 — 예약(scheduled)·요청 중(requested)·예약 취소(revoked)는 아직(또는 끝내) 결제가 아니다 */
const HISTORY_STATUSES = ["paid", "failed", "cancelled", "partial_cancelled"];
const HISTORY_SIZE = 100;

export interface PgSubscriptionView {
  subscriptionId: string;
  status: string;
  plan: { id: string; name: string; dailyTurnLimit: number | null; priceKrw: number | null };
  payMethod: string | null;
  payMethodLabel: string;
  beneficiary: { userId: string; name: string };
  expiresAt: Date | null;
  nextChargeAt: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  /** 결제 실패 뒤 다시 시도한 횟수(grace일 때) */
  failedChargeCount: number;
  /** 이번 이용기간에 무료 한도를 넘는 대화를 했나 — '유료 혜택 사용: 있음/없음' */
  usedPaidBenefit: boolean;
  /** 결제일부터 7일 안(청약철회 가능) */
  withinWithdrawal: boolean;
  /** 해지 두 방식의 예상(첫 결제 확인 중이면 null) */
  cancelOptions: Pick<CancellationQuote, "periodEnd" | "immediate"> | null;
}

export interface PgPaymentView {
  subscriptionId: string;
  kind: string;
  amountKrw: number;
  status: string;
  paidAt: Date | null;
  cancelledKrw: number;
  receiptUrl: string | null;
  failureReason: string | null;
  updatedAt: Date;
}

export interface PgStatus { subscriptions: PgSubscriptionView[]; payments: PgPaymentView[] }

function paymentView(p: BillingPayment): PgPaymentView {
  return {
    subscriptionId: p.subscriptionId, kind: p.kind, amountKrw: p.amountKrw, status: p.status, paidAt: p.paidAt,
    cancelledKrw: p.cancelledKrw, receiptUrl: safeReceiptUrl(p.receiptUrl),
    failureReason: p.status === "failed" ? p.failureReason : null, updatedAt: p.updatedAt,
  };
}

async function subscriptionView(s: Subscription, beneficiaryName: string, purchaserUserId: string, now: Date): Promise<PgSubscriptionView> {
  const q = s.status === "activating" ? null : await quoteCancellation(s.id, { purchaserUserId }, now);
  const quote = q?.ok ? q.quote : null;
  return {
    subscriptionId: s.id, status: s.status,
    plan: { id: s.productId, name: planDisplayName(s.dailyTurnLimit ?? 0), dailyTurnLimit: s.dailyTurnLimit, priceKrw: s.priceKrw },
    payMethod: s.payMethod, payMethodLabel: isPayMethod(s.payMethod) ? PAY_METHOD_LABELS[s.payMethod] : "등록한 결제수단",
    beneficiary: { userId: s.beneficiaryUserId, name: beneficiaryName },
    expiresAt: s.expiresAt, nextChargeAt: s.nextChargeAt, cancelAtPeriodEnd: s.cancelAtPeriodEnd, canceledAt: s.canceledAt,
    failedChargeCount: s.failedChargeCount,
    usedPaidBenefit: quote?.usedPaidBenefit ?? false,
    withinWithdrawal: quote?.withinWithdrawal ?? false,
    cancelOptions: quote ? { periodEnd: quote.periodEnd, immediate: quote.immediate } : null,
  };
}

/** 결제회원의 포트원 이용권(관리 대상)과 결제 내역. 조회 실패는 throw — 부르는 쪽이 Play 필드와 분리해 처리한다 */
export async function pgStatusFor(purchaserUserId: string, now = new Date()): Promise<PgStatus> {
  const subs = (await prisma.subscription.findMany({
    where: { purchaserUserId, provider: "portone", status: { in: SHOWN_STATUSES } },
    orderBy: { createdAt: "desc" },
    take: 10,
  })).filter((s) => s.status !== "canceled" || (s.expiresAt !== null && s.expiresAt > now)); // 해지 예약이 끝난 것은 곧 만료된다
  const ids = [...new Set(subs.map((s) => s.beneficiaryUserId))];
  const users = ids.length > 0 ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name?.trim() || "연결된 가족"]));
  const subscriptions = await Promise.all(
    subs.map((s) => subscriptionView(s, nameOf.get(s.beneficiaryUserId) ?? "연결된 가족", purchaserUserId, now)),
  );
  const rows = await prisma.billingPayment.findMany({
    where: { purchaserUserId, status: { in: HISTORY_STATUSES } }, orderBy: { updatedAt: "desc" }, take: HISTORY_SIZE,
  });
  return { subscriptions, payments: rows.map(paymentView) };
}
