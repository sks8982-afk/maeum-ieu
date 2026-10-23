/**
 * 포트원 정기결제 예약 작업 — 하루 1회(/api/cron/billing, CRON_SECRET)가 runBillingMaintenance를 부른다.
 *
 * 왜 필요한가: 결제 결과는 웹훅으로 오지만 웹훅은 최대 5회 재전송 뒤 끊긴다(research B 7). 서버가 그동안 멈췄거나,
 *   예약 생성·빌링키 삭제가 일시 오류로 실패했으면 아무도 다시 하지 않는다. 그래서 하루 한 번 상태가 어긋난 구독을 찾아
 *   포트원을 다시 조회하고 남은 일을 마친다(대사). 모든 단계는 멱등이다 — 두 번 돌아도 같은 결과.
 *   · 결제 예정 시각이 지났는데 결과가 없음 → 다시 조회. 결제가 없으면 **포트원 예약 상태를 본다**(2026-10-22 검토):
 *       예약이 남아 있음(늦게 실행 중) → 기다린다 · 콘솔·결제사에서 취소됨(REVOKED) → 결제하지 않고 다음 결제부터 해지 + 운영 경보 ·
 *       예약이 아예 없음(생성 유실) → 같은 paymentId로 지금 결제(이중 결제 불가). 예전엔 취소된 예약도 지금 결제로 되살렸다.
 *     지금 결제가 설정 오류(권한·채널 등)로 거절되면 카드 실패로 보지 않는다 — 재시도·만료로 보내지 않고 예약 작업 실패로 센다.
 *   · 다음 회차·재시도 예약이 없음 → 다시 건다
 *   · 해지 예약 기간이 끝남 → expired + 메일 · 만료가 지났는데 active·grace에 굳은 구독(해지 예약·빌링키 없음) → expired
 *   · 끝난 구독에 빌링키가 남음 → 예약 취소 → 빌링키 삭제 · 덜 된 환불(목표액 > 누적 취소액) → 이어서 환불(계정이 지워진 결제도)
 *   · 첫 결제가 멈춤 → 결과 확인, 포트원에 없으면 실패 처리 · 끝나지 않은 발급 준비(pending, 1시간 지남) → 닫는다
 *   · 결제 3일 전 안내 메일(회차마다 한 번) · 못 보낸 결제 완료 안내(최근 7일) 다시 보내기
 * 순서: 시간에 민감한 안내 메일 먼저, 그다음 대사(시간 예산 안에서 — 남은 것은 다음 실행에). 실패한 구독은 뒤로 돌려 앞을 막지 않게 한다.
 */
import type { BillingPayment, Subscription } from "@/generated/prisma/client/client";
import { prisma } from "@/lib/prisma";
import { portone, portoneErrorType, readBillingKey, scheduleStatusFor } from "@/lib/billing/portone-client";
import {
  billingPaymentInput, dropBillingKey, ensureNextSchedule, markFailedAndRetry, scheduleLedgerRow, stopRenewal, syncPayment, tryDropBillingKey,
} from "@/lib/billing/portone-sync";
import { finishRevocation } from "@/lib/billing/portone-cancel";
import { PENDING_TTL_MS, STUCK_ACTIVATION_MS, settleStuckActivation } from "@/lib/billing/portone-activate";
import { findOutstandingRefunds, settleSubscriptionRefunds } from "@/lib/billing/portone-refund";
import { billingOpsAlert, sendExpiredMail, sendPaymentCompleteMail, sendRenewalNoticeMail } from "@/lib/billing/portone-mail";

/** 결제 예정 시각에서 이만큼 지나도 결과가 없으면 다시 본다(웹훅 지연 여유) */
const OVERDUE_MS = 30 * 60_000;
/** 하루 넘게 결과가 없으면 사람에게 알린다 */
const ALERT_OVERDUE_MS = 24 * 3_600_000;
/** 결제 며칠 전에 안내하나 */
const NOTICE_LEAD_MS = 3 * 86_400_000;
/** 결제 완료 안내를 다시 보내는 기간 — 이보다 오래된 결제는 사람이 본다 */
const MAIL_RETRY_WINDOW_MS = 7 * 86_400_000;
/** 한 번에 처리할 구독 수 — 함수 시간 제한(maxDuration 60초) 안에서 끝나게. 남은 것은 다음 실행에 */
const BATCH = 100;
/** 대사에 쓰는 시간 — 넘으면 남은 구독은 다음 실행에(안내 메일은 이미 보냈다) */
const RECONCILE_BUDGET_MS = 40_000;
/** 예약이 아직 남아 포트원이 실행할 상태 */
const SCHEDULE_PENDING = ["SCHEDULED", "STARTED", "PENDING"];
/** 지금 결제가 이 오류면 결제수단을 쓸 수 없는 것(결제 실패로 재시도 흐름에) — 그 밖의 오류는 설정 문제로 보고 throw */
const KEY_GONE_ERRORS = ["BILLING_KEY_NOT_FOUND", "BILLING_KEY_ALREADY_DELETED", "BILLING_KEY_NOT_ISSUED"];
const KEY_GONE_REASON = "등록된 결제수단을 쓸 수 없어요(결제사 앱에서 자동결제를 끊었거나 결제수단이 삭제되었어요).";

/** 상태가 어긋났을 수 있는 포트원 구독 id(덜 된 환불이 남은 결제의 구독 id 포함 — 그 구독 행이 지워졌어도) */
export async function findSubscriptionsToReconcile(now = new Date(), limit = BATCH): Promise<string[]> {
  const overdue = new Date(now.getTime() - OVERDUE_MS);
  const rows = await prisma.subscription.findMany({
    where: {
      provider: "portone",
      OR: [
        { status: { in: ["active", "grace"] }, nextChargeAt: { lte: overdue } },
        { status: "active", cancelAtPeriodEnd: false, nextScheduleId: null },
        { status: "grace", nextScheduleId: null },
        { status: { in: ["active", "grace"] }, expiresAt: { lte: now }, OR: [{ cancelAtPeriodEnd: true }, { billingKeyEnc: null }] },
        { status: "canceled", expiresAt: { lte: now } },
        { status: { in: ["canceled", "expired", "revoked", "failed"] }, billingKeyEnc: { not: null } },
        { status: "activating", updatedAt: { lte: new Date(now.getTime() - STUCK_ACTIVATION_MS) } },
      ],
    },
    select: { id: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  // 덜 된 환불 — 빌링키를 먼저 지운 구독(다음 결제부터 해지 → 지금 해지)·받지 말아야 할 결제·계정이 지워진 결제는 위 조건에 안 걸린다
  const refunds = await findOutstandingRefunds(limit);
  return [...new Set([...rows.map((r) => r.id), ...refunds.map((r) => r.subscriptionId)])].slice(0, limit);
}

/** 구독 하나를 맞춘다 — 무엇을 했는지(로그용). 포트원 실패는 throw(다음 실행에 다시) */
export async function reconcileSubscription(subscriptionId: string, now = new Date()): Promise<string> {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub || sub.provider !== "portone") {
    // 구독 기록이 지워진 결제(계정 삭제 뒤 들어온 결제)의 환불만 남았을 수 있다
    return (await settleSubscriptionRefunds(subscriptionId, "중복·해지 후 결제 취소", "ADMIN")) > 0 ? "refunds_settled" : "skipped";
  }
  if (sub.status === "revoked") {
    await finishRevocation(sub, now);
    return "revocation_finished";
  }
  await settleSubscriptionRefunds(sub.id, "중복·해지 후 결제 취소", "ADMIN"); // 받지 말아야 할 결제의 덜 된 환불
  switch (sub.status) {
    case "activating":
      return settleStuckActivation(sub, now);
    case "active":
    case "grace":
      return reconcileLive(sub, now);
    case "canceled":
      return reconcileCanceled(sub, now);
    default:
      if (!sub.billingKeyEnc) return "noop";
      await dropBillingKey(sub, "ADMIN", now);
      return "key_dropped";
  }
}

/** 살아 있는 구독 — 굳은 상태 정리, 늦은 결제 결과 확인, 빠진 예약 다시 걸기 */
async function reconcileLive(sub: Subscription, now: Date): Promise<string> {
  if ((sub.cancelAtPeriodEnd || !sub.billingKeyEnc) && sub.expiresAt && sub.expiresAt <= now) return expireStuck(sub, now);
  if (sub.nextChargeAt && sub.nextChargeAt.getTime() <= now.getTime() - OVERDUE_MS) {
    const outcome = await settleOverdue(sub, now);
    if (outcome) return outcome;
  }
  const fresh = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
  if (fresh.nextScheduleId || fresh.cancelAtPeriodEnd) return "ok";
  if (fresh.status === "active") return `schedule_${await ensureNextSchedule(fresh.id, now)}`;
  if (fresh.status !== "grace") return "ok";
  const retry = await prisma.billingPayment.findFirst({
    where: { subscriptionId: fresh.id, status: "scheduled" }, orderBy: { createdAt: "desc" },
  });
  const billingKey = readBillingKey(fresh.billingKeyEnc);
  return retry && billingKey ? `retry_${await scheduleLedgerRow(fresh, retry, billingKey, now)}` : "ok";
}

/** 만료가 지났는데 더 결제될 수 없는 살아 있는 구독 — 읽은 그대로일 때만 expired(남은 빌링키는 지운다) */
async function expireStuck(sub: Subscription, now: Date): Promise<string> {
  const r = await prisma.subscription.updateMany({
    where: { id: sub.id, status: sub.status, cycleNo: sub.cycleNo },
    data: { status: "expired", nextChargeAt: null, nextScheduleId: null },
  });
  if (r.count === 0) return "ok";
  if (sub.billingKeyEnc) await tryDropBillingKey(sub, "ADMIN", now);
  await sendExpiredMail(sub.id, sub.cancelAtPeriodEnd ? "period_end" : "payment_failed");
  return "stuck_expired";
}

/**
 * 결제 예정 시각이 지났는데 결과가 없는 결제 — 다시 조회하고, 포트원에 결제가 없으면 예약 상태로 가른다(맨 위 주석).
 *   null: 볼 결제가 없다(다음 단계로).
 */
async function settleOverdue(sub: Subscription, now: Date): Promise<string | null> {
  const row = await prisma.billingPayment.findFirst({
    where: { subscriptionId: sub.id, status: { in: ["requested", "scheduled"] }, scheduledAt: { lte: new Date(now.getTime() - OVERDUE_MS) } },
    orderBy: { scheduledAt: "asc" },
  });
  if (!row) return null;
  const first = await syncPayment(row.paymentId, now);
  const late = !!row.scheduledAt && now.getTime() - row.scheduledAt.getTime() > ALERT_OVERDUE_MS;
  if (first !== "not_found") {
    if (first === "pending" && late) await billingOpsAlert("[결제] 예정 결제가 하루 넘게 결과 없음", [`paymentId: ${row.paymentId}`]);
    return `overdue_${first}`;
  }
  const billingKey = readBillingKey(sub.billingKeyEnc);
  if (!billingKey) return "overdue_no_key";
  const schedule = await scheduleStatusFor(billingKey, row.paymentId, row.scheduledAt ?? now, now);
  if (schedule === "REVOKED") {
    await stopRenewal(sub, "revoked_external", { requester: "ADMIN" }, now);
    await billingOpsAlert("[결제] 포트원에서 취소된 예약 — 결제하지 않고 해지로 처리", [`subscription: ${sub.id}`, `paymentId: ${row.paymentId}`]);
    return "overdue_revoked_external";
  }
  if (schedule !== null) {
    if (!SCHEDULE_PENDING.includes(schedule) || late) {
      await billingOpsAlert("[결제] 예정 결제가 하루 넘게 결과 없음", [`paymentId: ${row.paymentId}`, `예약 상태: ${schedule}`]);
    }
    return SCHEDULE_PENDING.includes(schedule) ? "overdue_still_scheduled" : `overdue_schedule_${schedule.toLowerCase()}`;
  }
  return chargeNow(sub, row, billingKey, now);
}

/** 포트원에 예약이 아예 없다(생성 유실) — 같은 paymentId로 지금 결제(이미 결제됐으면 ALREADY_PAID — 이중 결제가 되지 않는다) */
async function chargeNow(sub: Subscription, row: BillingPayment, billingKey: string, now: Date): Promise<string> {
  const paymentId = row.paymentId;
  try {
    await portone().payment.payWithBillingKey({ paymentId, ...billingPaymentInput(sub, billingKey, row.amountKrw) });
  } catch (e) {
    const t = portoneErrorType(e);
    if (t === null) throw e; // 시간 초과 등 — 다음 실행에 다시
    if (t === "PAYMENT_SCHEDULE_ALREADY_EXISTS") return "overdue_still_scheduled"; // 포트원 예약이 아직 남았다 — 포트원이 실행한다
    if (t !== "ALREADY_PAID" && t !== "PG_PROVIDER") {
      if (!KEY_GONE_ERRORS.includes(t)) throw e; // 설정 오류(권한·채널 등) — 카드 실패가 아니다(예약 작업 실패로 센다 → 운영 경보)
      if ((await syncPayment(paymentId, now)) === "not_found") return `overdue_${await markFailedAndRetry(row, KEY_GONE_REASON, now)}`;
    }
  }
  return `overdue_charged_${await syncPayment(paymentId, now)}`; // PG 거절이면 포트원의 실패 결제를 그대로 반영(재시도)
}

/** 해지 예약 — 빌링키가 남았으면 정리, 이용 기간이 끝났으면 expired + 메일 */
async function reconcileCanceled(sub: Subscription, now: Date): Promise<string> {
  if (sub.billingKeyEnc) await dropBillingKey(sub, "CUSTOMER", now);
  if (!sub.expiresAt || sub.expiresAt > now) return sub.billingKeyEnc ? "key_dropped" : "ok";
  const r = await prisma.subscription.updateMany({ where: { id: sub.id, status: "canceled" }, data: { status: "expired", nextChargeAt: null } });
  if (r.count > 0) await sendExpiredMail(sub.id, "period_end");
  return "expired";
}

/** 결제 3일 전 안내 — 회차마다 한 번(renewalNoticeFor = 안내한 결제 예정 시각). 보낸 수 */
export async function sendRenewalNotices(now = new Date(), limit = BATCH): Promise<number> {
  const subs = await prisma.subscription.findMany({
    where: {
      provider: "portone", status: "active", cancelAtPeriodEnd: false,
      nextChargeAt: { gt: now, lte: new Date(now.getTime() + NOTICE_LEAD_MS) },
    },
    orderBy: { nextChargeAt: "asc" },
    take: limit,
  });
  let sent = 0;
  for (const s of subs) {
    const chargeAt = s.nextChargeAt as Date;
    if (s.renewalNoticeFor?.getTime() === chargeAt.getTime()) continue; // 이 회차는 이미 안내했다
    // 보낸 뒤에 표시한다 — 메일이 실패하면 다음 실행(결제 전까지)에 다시 보낸다
    if (!(await sendRenewalNoticeMail(s.id, chargeAt))) continue;
    await prisma.subscription.update({ where: { id: s.id }, data: { renewalNoticeFor: chargeAt } });
    sent++;
  }
  return sent;
}

/**
 * 못 보낸 결제 완료 안내를 다시 보낸다(최근 7일 결제) — 자동결제마다 결제 내역을 알려야 한다(전자상거래법 제8조③ · 알리지 않은 자동결제는
 *   분쟁해결기준상 청구 금액 환급). 예전엔 한 번 실패하면 다시 보내지 않았다(2026-10-22 검토). 보낸 수
 */
export async function resendPaymentMails(now = new Date(), limit = BATCH): Promise<number> {
  const rows = await prisma.billingPayment.findMany({
    where: { status: "paid", paidMailAt: null, paidAt: { gte: new Date(now.getTime() - MAIL_RETRY_WINDOW_MS) } },
    orderBy: { paidAt: "asc" }, take: limit,
  });
  let sent = 0;
  for (const r of rows) {
    const sub = await prisma.subscription.findUnique({ where: { id: r.subscriptionId }, select: { cancelAtPeriodEnd: true } });
    if (!sub || !r.paidAt || !r.periodStart || !r.periodEnd) continue;
    const ok = await sendPaymentCompleteMail(r.subscriptionId, {
      amountKrw: r.amountKrw, paidAt: r.paidAt, periodStart: r.periodStart, periodEnd: r.periodEnd, receiptUrl: r.receiptUrl,
      nextCharge: !sub.cancelAtPeriodEnd,
    });
    if (!ok) continue;
    await prisma.billingPayment.update({ where: { paymentId: r.paymentId }, data: { paidMailAt: now } });
    sent++;
  }
  return sent;
}

/** 결제를 시작하지 않은 채 남은 발급 준비(1시간 지남)를 닫는다 — 늦게 온 빌링키가 결제를 시작하지 못하게(그 빌링키는 확정 때 지운다) */
async function closeExpiredPending(now: Date): Promise<void> {
  await prisma.subscription.updateMany({
    where: { provider: "portone", status: "pending", createdAt: { lte: new Date(now.getTime() - PENDING_TTL_MS) } },
    data: { status: "failed", cancelType: "expired" },
  });
}

/** 예약 작업 본체 — 안내 메일 → 발급 준비 정리 → 대사(시간 예산). 실패한 구독이 있으면 운영 경보 */
export async function runBillingMaintenance(now = new Date()): Promise<{ checked: number; failed: number; notices: number }> {
  const notices = await sendRenewalNotices(now);
  await resendPaymentMails(now);
  await closeExpiredPending(now);
  const ids = await findSubscriptionsToReconcile(now);
  const deadline = Date.now() + RECONCILE_BUDGET_MS;
  let failed = 0;
  let checked = 0;
  for (const id of ids) {
    if (Date.now() > deadline) break; // 남은 것은 다음 실행에
    checked++;
    try {
      await reconcileSubscription(id, now);
    } catch (e) {
      failed++;
      const kind = portoneErrorType(e) ?? (e instanceof Error ? e.message.slice(0, 80) : "알 수 없음");
      console.error(`[billing-cron] 대사 실패 sub=${id.slice(0, 8)}: ${kind}`);
      // 뒤로 돌린다 — 매번 실패하는 구독이 맨 앞(updatedAt 오래된 순)을 막아 다른 구독이 밀리지 않게
      await prisma.subscription.updateMany({ where: { id }, data: { updatedAt: now } }).catch(() => undefined);
    }
  }
  if (failed > 0) await billingOpsAlert("[결제] 예약 작업 대사 실패", [`실패 ${failed}건 / 점검 ${checked}건 — 다음 실행에 다시 시도`]);
  return { checked, failed, notices };
}
