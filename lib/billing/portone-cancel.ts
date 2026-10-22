/**
 * 포트원 이용권 해지·환불 — 다음 결제부터 해지(기본) · 지금 해지(중도해지·청약철회) · 회원 탈퇴·연결 해제.
 *
 * 환불 규칙은 환불정책 권장안 그대로(research C 3 — lib/billing/portone-period refundAmount):
 *   결제일부터 7일 안 → 유료 혜택 미사용 전액 / 사용 시 이용일수만 공제 · 7일 뒤 지금 해지 → 이용일수 + 남은 기간 요금의 10% 공제
 *   · 연결이 끊긴 뒤의 지금 해지·혜택 대상 계정 삭제 → 위약금 없이 이용일수만 공제 · 다음 결제부터 해지 → 환불 없음.
 *   '유료 혜택 사용'은 **가입 당시 무료 한도**로 판정한다(Subscription.freeTurnLimit — 나중에 무료 한도를 내려도 이미 가입한 이용권의 환불이
 *   거꾸로 줄지 않게, 올렸으면 올린 쪽으로 — 소비자에게 불리하지 않은 쪽, 2026-10-22 검토).
 * 해지 화면에는 두 방식과 방식별 예상 환불액을 같은 크기로 보여 준다 — quoteCancellation이 둘 다 돌려준다.
 *
 * 순서(지금 해지): ① 의사 기록(revoked — 혜택 즉시 종료, 환불 목표액을 원장에 고정, 해지 기록) ② 예약 취소 ③ 결제 취소(부분 취소)
 *   ④ 빌링키 삭제. 포트원이 ②·③에서 실패하면 throw — 다시 부르면(또는 예약 작업이) ②부터 이어 간다. ④만 실패하면 환불은 끝났으니
 *   성공으로 돌려주고 빌링키는 예약 작업에 맡긴다(환불이 늦어진다고 잘못 안내하지 않게).
 *   ①은 읽은 그대로일 때만 기록한다 — 견적을 낸 뒤 갱신 결제가 반영됐으면 다시 읽어 그 회차로 계산한다(2026-10-22 검토 — 예전엔 옛
 *   회차로 revoked를 덮어써, 방금 낸 회차가 환불 없이 남았다).
 *   이중 환불은 원장의 목표액(refundTargetKrw)과 currentCancellableAmount로 막는다(lib/billing/portone-refund settleRefund).
 * 환불은 원래 결제수단의 결제 취소로만 한다(자체 포인트 환불 금지 — 카드 가맹점 표준약관·네이버페이 결제형 조건).
 */
import type { BillingPayment, Subscription } from "@/generated/prisma/client/client";
import { prisma } from "@/lib/prisma";
import { DAILY_TURN_LIMIT } from "@/lib/usage/daily-limit";
import { readBillingKey, revokeAll, deleteKey } from "@/lib/billing/portone-client";
import {
  type RefundRule, periodDays, refundAmount, usedDays, withinWithdrawalWindow,
} from "@/lib/billing/portone-period";
import { usedPaidBenefit } from "@/lib/billing/paid-benefit";
import { dropBillingKey, stopRenewal, syncOpenRows } from "@/lib/billing/portone-sync";
import { billingOpsAlert, sendCanceledMail, sendRefundMail } from "@/lib/billing/portone-mail";
import { recordCancellation, settleSubscriptionRefunds } from "@/lib/billing/portone-refund";

/** 해지할 수 있는 상태 — 혜택이 남아 있는 구독(해지 예약 포함) */
const CANCELLABLE: readonly string[] = ["active", "grace", "canceled"];
/** 지금 해지가 견적을 낸 뒤 구독이 바뀌면(갱신 반영 등) 다시 읽어 계산하는 횟수 */
const CANCEL_ATTEMPTS = 3;

export interface CancellationQuote {
  subscriptionId: string;
  /** 다음 결제부터 해지 — 이 시각까지 이용, 환불 없음 */
  periodEnd: { endsAt: Date | null; refundKrw: 0 };
  /** 지금 해지 — 바로 끝나고 이 금액을 결제 취소로 돌려준다(돌려줄 결제가 없으면 0) */
  immediate: { refundKrw: number; rule: RefundRule; usedDays: number; periodDays: number; paidKrw: number };
  /** 결제일부터 7일 안(청약철회) */
  withinWithdrawal: boolean;
  /** 이번 이용기간에 유료 혜택(무료 한도를 넘는 대화)을 썼나 — 구독 관리 화면에 '있음/없음'으로 보여 준다 */
  usedPaidBenefit: boolean;
}

export type CancelResult =
  | { ok: true; endsAt: Date | null; refundKrw: number }
  | { ok: false; code: "not_found" | "forbidden" | "not_cancellable" };

type Owned = { ok: true; sub: Subscription } | { ok: false; code: "not_found" | "forbidden" };

async function loadOwned(subscriptionId: string, purchaserUserId?: string): Promise<Owned> {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub || sub.provider !== "portone") return { ok: false, code: "not_found" };
  // 해지·환불은 결제회원만(약관 '결제회원과 이용회원')
  if (purchaserUserId !== undefined && sub.purchaserUserId !== purchaserUserId) return { ok: false, code: "forbidden" };
  return { ok: true, sub };
}

/** 지금 혜택의 근거인 결제(이번 회차) */
function currentPaidRow(sub: Subscription): Promise<BillingPayment | null> {
  return prisma.billingPayment.findFirst({
    where: { subscriptionId: sub.id, cycleNo: sub.cycleNo, status: { in: ["paid", "partial_cancelled"] } },
    orderBy: { paidAt: "desc" },
  });
}

/** '유료 혜택 사용'을 가르는 무료 한도 — 가입 당시 값과 지금 값 중 큰 쪽(지금 무료 한도가 꺼져 있으면 유료 혜택이라는 것이 없다) */
function benefitFreeLimit(sub: Pick<Subscription, "freeTurnLimit">): number {
  if (DAILY_TURN_LIMIT <= 0) return 0;
  return Math.max(sub.freeTurnLimit ?? 0, DAILY_TURN_LIMIT);
}

/**
 * 두 방식의 예상과 환불할 결제 행 — noPenalty: 위약금 없는 지금 해지(혜택 대상 계정 삭제).
 *   연결이 끊긴 뒤(cancelType link_gone)의 지금 해지도 위약금이 없다(약관 '결제회원과 이용회원' ②).
 */
async function computeQuote(
  sub: Subscription, now: Date, noPenalty = false,
): Promise<{ quote: CancellationQuote; row: BillingPayment | null }> {
  const endsAt = sub.status === "grace" ? now : sub.expiresAt; // 재시도 중이면 낸 기간이 이미 끝났다
  const base = { subscriptionId: sub.id, periodEnd: { endsAt, refundKrw: 0 as const } };
  const row = await currentPaidRow(sub);
  if (!row?.paidAt || !row.periodStart || !row.periodEnd || now >= row.periodEnd) {
    const immediate = { refundKrw: 0, rule: "immediate" as RefundRule, usedDays: 0, periodDays: 0, paidKrw: 0 };
    return { quote: { ...base, immediate, withinWithdrawal: false, usedPaidBenefit: false }, row: null };
  }
  const total = periodDays(row.periodStart, row.periodEnd);
  const used = usedDays(row.periodStart, now, total);
  const withinWithdrawal = withinWithdrawalWindow(row.paidAt, now);
  const benefit = await usedPaidBenefit(sub.beneficiaryUserId, { start: row.periodStart, end: now }, benefitFreeLimit(sub));
  const rule: RefundRule = withinWithdrawal ? "withdrawal"
    : noPenalty || sub.cancelType === "link_gone" ? "no_penalty" : "immediate";
  const computed = refundAmount({ paidKrw: row.amountKrw, periodDays: total, usedDays: used, rule, usedPaidBenefit: benefit });
  const refundKrw = Math.min(computed, row.amountKrw - row.cancelledKrw); // 이미 취소된 몫은 다시 돌려주지 않는다
  return {
    quote: { ...base, withinWithdrawal, usedPaidBenefit: benefit,
      immediate: { refundKrw, rule, usedDays: used, periodDays: total, paidKrw: row.amountKrw } },
    row,
  };
}

/** 해지 화면용 — 두 방식과 방식별 예상 환불액(실제 해지 때 같은 계산을 서버가 다시 한다) */
export async function quoteCancellation(
  subscriptionId: string, opts: { purchaserUserId?: string } = {}, now = new Date(),
): Promise<{ ok: true; quote: CancellationQuote } | { ok: false; code: "not_found" | "forbidden" | "not_cancellable" }> {
  const found = await loadOwned(subscriptionId, opts.purchaserUserId);
  if (!found.ok) return found;
  if (!CANCELLABLE.includes(found.sub.status)) return { ok: false, code: "not_cancellable" };
  return { ok: true, quote: (await computeQuote(found.sub, now)).quote };
}

/**
 * 다음 결제부터 해지(일반해지) — 만료일까지 혜택 유지(status canceled), 그 뒤 결제 없음, 환불 없음.
 *   한 번 부르면 끝난다(재확인은 화면에서 1회 이하 — 다크패턴 금지). 이미 해지된 것을 다시 부르면 남은 정리만 한다.
 *   포트원 정리(예약 취소 → 빌링키 삭제)가 실패해도 해지는 성립한다 — 예약 작업이 마저 하고, 그 사이 실행된 결제는 전액 취소된다.
 */
export async function cancelAtPeriodEnd(
  subscriptionId: string, opts: { purchaserUserId?: string; cancelType?: "normal" | "link_gone" } = {}, now = new Date(),
): Promise<CancelResult> {
  const found = await loadOwned(subscriptionId, opts.purchaserUserId);
  if (!found.ok) return found;
  const sub = found.sub;
  if (!CANCELLABLE.includes(sub.status)) return { ok: false, code: "not_cancellable" };
  // 이미 해지된 것을 다시 부르면 남은 정리만(빌링키가 남았으면 지운다) — 같은 이유면 메일도 다시 보내지 않는다(stopRenewal)
  const cancelType = opts.cancelType === "link_gone" ? "link_gone" : sub.cancelType ?? "normal";
  const endsAt = await stopRenewal(sub, cancelType, { requester: "CUSTOMER" }, now);
  return { ok: true, endsAt, refundKrw: 0 };
}

/**
 * 지금 해지의 ① — 읽은 그대로일 때만 revoked + 환불 목표액 고정 + 해지 기록(한 트랜잭션). 그 사이 바뀌었으면 null(다시 읽어 계산한다).
 *   목표액은 누적 취소액 목표다 — 포트원 호출이 끊겨 다시 시도해도 같은 금액.
 */
async function revokeIfUnchanged(
  sub: Subscription, row: BillingPayment | null, refundKrw: number, cancelType: string, now: Date,
): Promise<Subscription | null> {
  const done = await prisma.$transaction(async (tx) => {
    const r = await tx.subscription.updateMany({
      where: { id: sub.id, status: sub.status, cycleNo: sub.cycleNo, revokedAt: null },
      data: {
        status: "revoked", revokedAt: now, canceledAt: sub.canceledAt ?? now, cancelType, cancelAtPeriodEnd: true,
        nextChargeAt: null, nextScheduleId: null, expiresAt: now,
      },
    });
    if (r.count === 0) return false;
    if (row && refundKrw > 0) {
      await tx.billingPayment.updateMany({
        where: { paymentId: row.paymentId, refundTargetKrw: null }, data: { refundTargetKrw: row.cancelledKrw + refundKrw },
      });
    }
    await recordCancellation(tx, sub.id, cancelType, now);
    return true;
  });
  return done ? prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } }) : null;
}

/**
 * 지금 해지 — 혜택 즉시 종료 + 환불(결제 취소). 7일 안이면 청약철회 규칙, 아니면 중도해지 규칙(quote와 같은 계산).
 *   reason: 탈퇴·계정 삭제 처리에서 부를 때 기록용. noPenalty: 위약금 없이(혜택 대상 계정 삭제).
 *   포트원 실패(예약 취소·결제 취소)는 throw — 이미 revoked라 다시 부르면 남은 환불·정리를 이어 간다.
 */
export async function cancelNow(
  subscriptionId: string,
  opts: { purchaserUserId?: string; reason?: "purchaser_deleted" | "beneficiary_deleted"; noPenalty?: boolean } = {},
  now = new Date(),
): Promise<CancelResult> {
  for (let attempt = 0; attempt < CANCEL_ATTEMPTS; attempt++) {
    const found = await loadOwned(subscriptionId, opts.purchaserUserId);
    if (!found.ok) return found;
    const sub = found.sub;
    if (sub.status === "revoked") return { ok: true, endsAt: sub.revokedAt, refundKrw: await finishRevocation(sub, now) };
    if (!CANCELLABLE.includes(sub.status)) return { ok: false, code: "not_cancellable" };
    const { quote, row } = await computeQuote(sub, now, opts.noPenalty);
    const cancelType = opts.reason ?? (quote.immediate.rule === "withdrawal" ? "withdrawal" : "immediate");
    const revoked = await revokeIfUnchanged(sub, row, quote.immediate.refundKrw, cancelType, now);
    if (!revoked) continue; // 견적을 낸 사이 구독이 바뀌었다(갱신 반영 등) — 다시 읽어 그 회차로 계산한다
    const refunded = await finishRevocation(revoked, now);
    if (refunded > 0) await sendRefundMail(sub.id, { refundKrw: refunded, reason: refundReasonLabel(cancelType) });
    else await sendCanceledMail(sub.id, { endsAt: null });
    return { ok: true, endsAt: now, refundKrw: refunded };
  }
  throw new Error("지금 해지 중 구독이 계속 바뀜 — 잠시 후 다시");
}

function refundReasonLabel(cancelType: string): string {
  return cancelType === "withdrawal" ? "청약철회" : cancelType === "immediate" ? "지금 해지(중도해지)" : "계정 정리에 따른 해지";
}

/**
 * revoked 구독의 남은 일 — 예약 취소 → 환불(목표액까지) → 빌링키 삭제. 돌려준 금액(이번 호출에서 — 결제사가 처리 중인 요청 포함).
 *   예약 취소·환불의 포트원 실패는 throw. 빌링키 삭제만 실패하면 throw하지 않는다 — 환불은 끝났다(빌링키는 남겨 예약 작업이 지운다,
 *   2026-10-22 검토: 예전엔 환불이 됐는데 "환불이 늦어진다"고 안내하고 환불 메일도 보내지 않았다).
 *   예약 작업(lib/billing/portone-maintenance)도 이 함수로 이어 간다.
 */
export async function finishRevocation(sub: Subscription, now = new Date()): Promise<number> {
  const billingKey = readBillingKey(sub.billingKeyEnc);
  if (billingKey && (await revokeAll(billingKey)) === "already_processed") {
    await syncOpenRows(sub.id, now); // 방금 실행된 예약 결제 — revoked 구독이라 markPaid가 전액 취소한다
    await revokeAll(billingKey);
  }
  await prisma.billingPayment.updateMany({ where: { subscriptionId: sub.id, status: "scheduled" }, data: { status: "revoked" } });
  const refunded = await settleSubscriptionRefunds(sub.id, refundReasonLabel(sub.cancelType ?? ""));
  if (billingKey) {
    try {
      await deleteKey(billingKey, "CUSTOMER");
    } catch (e) {
      console.error(`[billing-pg] 환불 뒤 빌링키 삭제 실패(예약 작업이 다시 한다) sub=${sub.id.slice(0, 8)}:`, e instanceof Error ? e.message.slice(0, 80) : e);
      await billingOpsAlert("[결제] 빌링키 정리 실패 — 예약 작업이 다시 시도", [`subscription: ${sub.id}`]);
      return refunded;
    }
  }
  await prisma.subscription.update({ where: { id: sub.id }, data: { billingKeyEnc: null } });
  return refunded;
}

/** 탈퇴·연결 해제 정리 결과 */
export interface SettleSummary { subscriptions: number; refundedKrw: number }

/**
 * 결제회원 탈퇴 — 계정 삭제 **전에** 부른다(Subscription은 User 삭제에 Cascade라, 먼저 정리하지 않으면 포트원 예약이 남아
 *   카드가 계속 결제된다). 살아 있는 이용권은 지금 해지 기준으로 환불하고 예약 취소·빌링키 삭제(약관 '회원 탈퇴').
 *   포트원이 실패하면 throw — 부르는 쪽은 삭제를 멈추고 오류를 돌려줘야 한다. 결제·환불 기록(BillingPayment)은 남는다(5년 보존).
 */
export async function cancelForPurchaserDeletion(userId: string, now = new Date()): Promise<SettleSummary> {
  const subs = await prisma.subscription.findMany({ where: { purchaserUserId: userId, provider: "portone" } });
  return settleAll(subs, "purchaser_deleted", now);
}

/**
 * 이용회원(어르신)이 사라질 때 — reason:
 *   · "link_revoked": 보호자-어르신 연결 해제(연결 해제 **전에**) → 다음 결제부터 해지 + 결제회원에게 메일
 *     (원하면 위약금 없는 지금 해지 — cancelNow가 cancelType link_gone을 보고 위약금을 빼지 않는다).
 *     purchaserUserId를 주면 그 보호자가 결제한 것만(다른 보호자의 이용권은 그대로).
 *     **포트원 실패로 멈추지 않는다**(2026-10-22 검토) — 연결 해제는 어르신의 정보 열람 동의 철회라 결제대행사 상태에 묶이면 안 된다.
 *     해지 의사(canceled·다음 결제 없음)를 DB에 먼저 적으면 그 뒤 실행된 예약 결제는 전액 취소되고(markPaid) 남은 빌링키는 예약 작업이
 *     지운다 — 포트원 정리 실패는 운영 경보로만 남긴다. DB 실패만 throw(부르는 쪽이 해제를 멈춘다). 첫 결제 중(activating)인 것은
 *     건드리지 않는다 — 결제가 끝나면 다음 회차를 걸지 않는다(lib/billing/portone-sync ensureNextSchedule의 연결 확인).
 *   · "beneficiary_deleted": 어르신 계정 삭제(삭제 **전에**) → 위약금 없는 지금 해지(이용일수만 공제)로 환불.
 *     ⚠ 설계와 다르게 한 점: 이 구독은 어르신 계정과 함께 Cascade로 지워져, 결제회원이 나중에 관리 화면에서 지금 해지를
 *     고를 수 없다 — 남은 기간을 쓸 수도 없으므로 위약금 없는 환불을 여기서 바로 한다. 포트원이 실패하면 throw(삭제를 멈춘다).
 *   본인 결제는 결제회원 탈퇴(cancelForPurchaserDeletion)가 처리한다 — 계정 삭제는 두 함수를 다 부른다(결제회원 → 이용회원 순).
 */
export async function cancelForBeneficiaryGone(
  beneficiaryUserId: string, opts: { reason: "link_revoked" | "beneficiary_deleted"; purchaserUserId?: string },
  now = new Date(),
): Promise<SettleSummary> {
  const subs = (await prisma.subscription.findMany({
    where: { beneficiaryUserId, provider: "portone", ...(opts.purchaserUserId ? { purchaserUserId: opts.purchaserUserId } : {}) },
  })).filter((s) => s.purchaserUserId !== s.beneficiaryUserId);
  if (opts.reason === "link_revoked") return stopAllForLinkGone(subs, now);
  return settleAll(subs, "beneficiary_deleted", now);
}

/** 연결 해제 — 다음 결제부터 해지(포트원 정리는 실패해도 멈추지 않는다 — 위 주석). 발급 준비만 한 시도는 닫는다 */
async function stopAllForLinkGone(subs: Subscription[], now: Date): Promise<SettleSummary> {
  let touched = 0;
  for (const sub of subs) {
    if (sub.status === "pending") {
      await prisma.subscription.updateMany({ where: { id: sub.id, status: "pending" }, data: { status: "failed", cancelType: "link_gone" } });
    } else if (CANCELLABLE.includes(sub.status) && !(sub.status === "canceled" && sub.cancelType === "link_gone" && !sub.billingKeyEnc)) {
      await stopRenewal(sub, "link_gone", { requester: "ADMIN" }, now);
      touched++;
    }
  }
  return { subscriptions: touched, refundedKrw: 0 };
}

async function settleAll(subs: Subscription[], reason: "purchaser_deleted" | "beneficiary_deleted", now: Date): Promise<SettleSummary> {
  let refundedKrw = 0;
  let touched = 0;
  for (const s of subs) {
    const r = await settleOne(s, reason, now);
    if (r !== null) { touched++; refundedKrw += r; }
  }
  return { subscriptions: touched, refundedKrw };
}

/** 구독 하나 정리(계정 삭제) — 손댄 경우 돌려준 금액(0 포함), 손댈 것이 없으면 null. 포트원 실패는 throw */
async function settleOne(subIn: Subscription, reason: "purchaser_deleted" | "beneficiary_deleted", now: Date): Promise<number | null> {
  let sub = subIn;
  if (sub.status === "activating") {
    await syncOpenRows(sub.id, now); // 첫 결제 결과부터 확정
    sub = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    if (sub.status === "activating") throw new Error("첫 결제 처리 중 — 잠시 후 다시 시도");
  }
  if (sub.status === "pending") {
    // 결제 전 시도 — 늦게 온 빌링키가 결제를 시작하지 못하게 닫는다
    await prisma.subscription.updateMany({ where: { id: sub.id, status: "pending" }, data: { status: "failed", cancelType: reason } });
    return null;
  }
  if (CANCELLABLE.includes(sub.status)) {
    const r = await cancelNow(sub.id, { reason, noPenalty: reason === "beneficiary_deleted" }, now);
    return r.ok ? r.refundKrw : null;
  }
  if (sub.status === "revoked") return finishRevocation(sub, now);
  if (sub.billingKeyEnc) { await dropBillingKey(sub, "ADMIN", now); return 0; }
  return null;
}

