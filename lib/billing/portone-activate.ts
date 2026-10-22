/**
 * 포트원 정기결제 시작 — 발급 준비(pending 구독) → 빌링키 확정 → 첫 결제 → 다음 회차 예약.
 *
 * 흐름(research B 5·6):
 *   1. createPendingSubscription — 요금제·결제수단·혜택 대상·동의 기록을 서버가 정하고 issueId를 만든다(purchaseToken = "portone:{issueId}").
 *   2. 브라우저가 requestIssueBillingKey(issueId) → 빌링키를 /api/billing/portone/activate로 보낸다(또는 BillingKey.Issued 웹훅).
 *   3. activateByBillingKey — 빌링키를 포트원에서 **다시 조회**해 대조(발급 완료·issueId·상점·채널 test/live)한 뒤
 *      pending → activating을 조건부로 바꾼다(동시에 온 브라우저 복귀·웹훅 중 한 건만 결제). 첫 결제 → syncPayment로 확정.
 *
 * 이중 결제 방어 — 어르신 1명당 살아 있는 이용권 하나:
 *   · 발급 준비에서 막고(hasLiveSubscription — Play 구독도 센다), 결제 직전에 한 번 더 본다.
 *   · 그래도 동시에 둘이 통과하면 DB 부분 유일 인덱스(scripts/ops-billing-pg.ts)가 activating 전환을 막는다(P2002).
 *   · 막힌 쪽은 결제하지 않고 failed + 빌링키 삭제.
 * 빌링키는 암호화해서만 둔다(encryptPII) — 키가 없어 평문이 되면 결제를 시작하지 않는다.
 */
import { randomBytes } from "node:crypto";
import type { Subscription } from "@/generated/prisma/client/client";
import { prisma } from "@/lib/prisma";
import { encryptPII, isEncryptedPII } from "@/lib/crypto";
import { DAILY_TURN_LIMIT } from "@/lib/usage/daily-limit";
import { ENTITLED_STATUSES } from "@/lib/billing/plans";
import { type PayMethod, type PgPlan, expectedChannelType } from "@/lib/billing/portone-plans";
import {
  billingKeyFingerprint, deleteKey, pgMessageOf, portone, portoneErrorType, readBillingKey,
} from "@/lib/billing/portone-client";
import {
  billingPaymentInput, linkActive, markFailedAndRetry, stopRenewal, syncPayment, tryDropBillingKey,
} from "@/lib/billing/portone-sync";
import { paymentIdFor } from "@/lib/billing/portone-period";

/** 발급 준비 뒤 이 시간이 지나면 빌링키가 와도 결제하지 않는다 — 창을 닫고 떠난 지 오래된 시도에 갑자기 결제되지 않게 */
export const PENDING_TTL_MS = 60 * 60_000;
/** DB 부분 유일 인덱스와 같은 목록(scripts/ops-billing-pg.ts) — 첫 결제 중(activating)도 하나로 센다 */
export const LIVE_PORTONE_STATUSES: readonly string[] = ["activating", "active", "grace", "canceled"];

/** issueId — 영숫자 34자: 이니시스(ASCII)·나이스(영숫자 40자)·네이버(재사용 불가) 조건을 모두 만족. 시도마다 새로 만든다 */
export function newIssueId(): string {
  return `bk${randomBytes(16).toString("hex")}`;
}
/** newIssueId가 만든 꼴 — 바깥(쿼리·요청 본문)에서 온 issueId를 DB에 묻기 전에 본다 */
export const ISSUE_ID_RE = /^bk[0-9a-f]{32}$/;

/** 이 어르신에게 이미 살아 있는 이용권이 있나(Play 포함, 결제 중인 것 포함) — excludeId는 지금 확정하려는 구독 */
export async function hasLiveSubscription(beneficiaryUserId: string, now = new Date(), excludeId?: string): Promise<boolean> {
  const live = await prisma.subscription.findFirst({
    where: {
      beneficiaryUserId, revokedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: [
        { status: { in: [...ENTITLED_STATUSES] }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        { status: "activating" },
      ],
    },
    select: { id: true },
  });
  return live !== null;
}

/**
 * 이용권 혜택을 받을 수 있는 계정 역할 — 하루 대화 한도가 걸리는 어르신(user)만. 한도는 어르신 계정에만 걸린다
 *   (app/api/chat·live 라우트의 mode === "user" 관문, lib/usage/daily-limit). 일반·의사·보호자 계정은 원래 한도가 없어
 *   "하루 대화 한도를 늘려 주는" 이용권이 아무것도 주지 못한다 — 효과 없는 상품을 팔지 않는다(전자상거래법 제21조①1호 기만 위험).
 */
export const BENEFICIARY_ROLE = "user";

/**
 * 혜택 대상 확정(PG 전용 — 기본값으로 떨어지지 않는다).
 *   결제는 보호자(guardian)만, 혜택은 연결된(active) 어르신(user)만. 어르신 본인(치매 어르신 본인 결제는 의사무능력으로 무효가 될 수
 *   있다 — 설계 0-1)·의사(업무용)·일반 회원(하루 한도가 없어 얻는 것이 없다 — BENEFICIARY_ROLE)은 결제 주체가 아니다.
 *   ⚠ 설계와 다르게 한 점: 설계 0-1·13은 일반 회원 본인 결제를 허용했다 — 검토(10-22)가 효과 없는 상품 판매로 확인해 막았다.
 *   일반 회원에게 팔려면 일반 회원의 하루 한도 정책을 먼저 정해야 한다(사용자 결정 — 설정 가이드 결정 3).
 *   Play 쪽 resolveBeneficiary처럼 조용히 다른 사람으로 바꾸지 않는다 — 고른 사람과 다르면 거절한다(화면에서 이름을 보고 고른다).
 */
export async function resolvePgBeneficiary(
  purchaserUserId: string, screeningMode: string | null | undefined, requested: string | null | undefined,
): Promise<{ ok: true; beneficiaryUserId: string } | { ok: false; code: "role_not_allowed" | "not_linked" | "not_eligible" }> {
  if (screeningMode !== "guardian") return { ok: false, code: "role_not_allowed" };
  if (!requested || requested === purchaserUserId) return { ok: false, code: "not_linked" };
  const link = await prisma.expertPatient.findUnique({
    where: { expertUserId_patientUserId: { expertUserId: purchaserUserId, patientUserId: requested } }, select: { status: true },
  });
  if (link?.status !== "active") return { ok: false, code: "not_linked" };
  const target = await prisma.user.findUnique({ where: { id: requested }, select: { screeningMode: true } });
  return target?.screeningMode === BENEFICIARY_ROLE ? { ok: true, beneficiaryUserId: requested } : { ok: false, code: "not_eligible" };
}

export interface PendingInput {
  purchaserUserId: string;
  beneficiaryUserId: string;
  plan: PgPlan;
  method: PayMethod;
  consent: { termsVersion: string; items: readonly string[] };
}

/**
 * 결제회원 한 명이 하루(24시간)에 시작할 수 있는 발급 준비 수 — 넘으면 too_many_attempts.
 *   왜(2026-10-22 검토): 가입 때 이메일 소유를 확인하지 않아, 남의 주소로 만든 계정이 결제 → 7일 안 철회(전액 환불)를 되풀이하면 그 주소로
 *   공식 발신 계정의 결제 메일이 무한히 나가고, 끝나지 않은 시도(pending)·동의 기록(5년 보존)이 쌓인다. 정상 사용은 하루 한두 번이다
 *   (카드 거절·창 닫음 뒤 다시 시도를 넉넉히 센다). DB로 센다 — 요청 빈도 제한(분당)은 인스턴스마다 따로라 하루 상한이 되지 못한다.
 */
export const MAX_PENDING_PER_DAY = 5;
const DAY_MS = 86_400_000;

type PendingResult = { ok: true; subscriptionId: string; issueId: string } | { ok: false; code: "duplicate" | "consent_required" | "too_many_attempts" };

/**
 * 발급 준비 — pending 구독(가입 당시 금액·한도·무료 한도 고정) + 동의 기록(안내한 조건 포함)을 한 트랜잭션으로.
 *   어떤 동의가 필수인지는 화면·약관이 정한다(부르는 쪽이 전부 true인지 본다) — 여기서는 기록 없이 시작하지 않게만 막는다.
 *   동의 기록의 offer: 동의할 때 화면에 보인 요금제·금액·한도·무료 한도·결제수단·혜택 받는 분 — 구독 기록은 계정 삭제에 함께 지워지지만
 *   동의 기록은 남는다(계약 기록 5년 — 시행령 제6조).
 */
export async function createPendingSubscription(input: PendingInput, now = new Date()): Promise<PendingResult> {
  if (!input.consent.termsVersion.trim() || input.consent.items.length === 0) return { ok: false, code: "consent_required" };
  const recent = await prisma.subscription.count({
    where: { purchaserUserId: input.purchaserUserId, provider: "portone", createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
  });
  if (recent >= MAX_PENDING_PER_DAY) return { ok: false, code: "too_many_attempts" };
  await settleStuckActivations(input.beneficiaryUserId, now);
  if (await hasLiveSubscription(input.beneficiaryUserId, now)) return { ok: false, code: "duplicate" };
  const issueId = newIssueId();
  const freeTurnLimit = DAILY_TURN_LIMIT;
  const offer = {
    planId: input.plan.id, priceKrw: input.plan.priceKrw, dailyTurnLimit: input.plan.dailyTurnLimit, freeDailyTurnLimit: freeTurnLimit,
    payMethod: input.method, beneficiaryUserId: input.beneficiaryUserId,
  };
  const subscriptionId = await prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.create({
      data: {
        purchaserUserId: input.purchaserUserId, beneficiaryUserId: input.beneficiaryUserId, productId: input.plan.id,
        purchaseToken: `portone:${issueId}`, status: "pending", provider: "portone", payMethod: input.method,
        priceKrw: input.plan.priceKrw, dailyTurnLimit: input.plan.dailyTurnLimit, freeTurnLimit, expiresAt: null,
      },
      select: { id: true },
    });
    await tx.billingConsent.create({
      data: {
        userId: input.purchaserUserId, subscriptionId: sub.id, termsVersion: input.consent.termsVersion, items: [...input.consent.items], offer,
      },
    });
    return sub.id;
  });
  return { ok: true, subscriptionId, issueId };
}

export type ActivateResult =
  | { ok: true; subscriptionId: string; status: "active" | "processing" }
  | {
      ok: false;
      code: "invalid_billing_key" | "not_found" | "forbidden" | "expired" | "duplicate" | "not_linked" | "config"
        | "payment_failed" | "verification_failed";
      /** PG가 준 실패 메시지 — 가공하지 말고 그대로 보여 준다(네이버페이 조건) */
      message?: string;
    };

const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";

/**
 * 빌링키 확정과 첫 결제 — 브라우저 복귀(/activate)와 BillingKey.Issued 웹훅이 같이 부른다(먼저 온 쪽만 결제한다).
 *   opts.issueId: 브라우저가 보낸 issueId(포트원 조회값과 같아야 한다) · opts.purchaserUserId: 로그인한 사람(결제회원과 같아야 한다).
 */
export async function activateByBillingKey(
  billingKey: string, opts: { issueId?: string; purchaserUserId?: string } = {}, now = new Date(),
): Promise<ActivateResult> {
  const checked = await verifiedIssueId(billingKey, opts.issueId);
  if (!checked) return { ok: false, code: "invalid_billing_key" };
  const sub = await prisma.subscription.findUnique({ where: { purchaseToken: `portone:${checked}` } });
  if (!sub || sub.provider !== "portone") {
    // 우리 상점에서 발급됐는데 시도 기록이 없다(계정 삭제로 함께 지워짐 등) — 쓸 곳 없는 자동결제 등록이 결제사에 남지 않게 지운다
    if (!sub) await discardKey(billingKey, checked);
    return { ok: false, code: "not_found" };
  }
  if (opts.purchaserUserId && sub.purchaserUserId !== opts.purchaserUserId) return { ok: false, code: "forbidden" };
  if (sub.status !== "pending") {
    // 이미 닫힌 시도(시간 초과·탈퇴 정리·결제 전 거절)에 늦게 온 빌링키 — 그 시도는 결제하지 않으니 이 빌링키도 지운다
    if (sub.status === "failed" && !sub.billingKeyEnc) await discardKey(billingKey, sub.id);
    return currentState(sub);
  }
  if (now.getTime() - sub.createdAt.getTime() > PENDING_TTL_MS) return refuse(sub, billingKey, "expired");
  const enc = encryptPII(billingKey);
  if (!enc || !isEncryptedPII(enc)) {
    console.error("[billing-pg] ENCRYPTION_KEY 없음 — 빌링키를 평문으로 둘 수 없어 결제를 시작하지 않는다");
    return refuse(sub, billingKey, "config");
  }
  // 발급 준비와 결제 사이에 보호자·어르신 연결이 끊겼으면 결제하지 않는다
  if (!(await linkActive(sub))) return refuse(sub, billingKey, "not_linked");
  await expireLapsed(sub.beneficiaryUserId, now);
  if (await hasLiveSubscription(sub.beneficiaryUserId, now, sub.id)) return refuse(sub, billingKey, "duplicate");
  try {
    const claimed = await prisma.subscription.updateMany({
      where: { id: sub.id, status: "pending" }, data: { status: "activating", billingKeyEnc: enc, verifiedAt: now },
    });
    if (claimed.count === 0) return currentState(await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } }));
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    return refuse(sub, billingKey, "duplicate"); // 같은 어르신의 다른 결제가 동시에 확정됐다(부분 유일 인덱스)
  }
  return chargeFirst({ ...sub, status: "activating", billingKeyEnc: enc }, billingKey, now);
}

/** 포트원에서 빌링키를 다시 조회해 대조 — 통과하면 issueId, 아니면 null */
async function verifiedIssueId(billingKey: string, expectedIssueId?: string): Promise<string | null> {
  let info;
  try {
    info = await portone().payment.billingKey.getBillingKeyInfo({ billingKey });
  } catch (e) {
    if (portoneErrorType(e) === "BILLING_KEY_NOT_FOUND") return null;
    throw e;
  }
  if (info.status !== "ISSUED" || !info.issueId) return null;
  if (expectedIssueId !== undefined && info.issueId !== expectedIssueId) return null;
  const storeId = process.env.PORTONE_STORE_ID?.trim();
  if (storeId && info.storeId !== storeId) return null;
  // 테스트 채널로 발급한 빌링키로 실서비스 혜택을 받지 못하게(PORTONE_MODE)
  if (info.channels.length === 0 || !info.channels.every((c) => c.type === expectedChannelType())) return null;
  return info.issueId;
}

/** 결제를 시작하지 않고 닫은 이유(cancelType에 남는다) */
type RefuseCode = "expired" | "duplicate" | "config" | "not_linked";
const REFUSE_CODES: readonly string[] = ["expired", "duplicate", "config", "not_linked"];

/** 이미 처리 중이거나 끝난 시도 — 두 번째 호출(웹훅·새로고침)은 지금 상태만 알려 준다 */
function currentState(sub: Subscription): ActivateResult {
  if (sub.status === "active" || sub.status === "grace" || sub.status === "canceled") return { ok: true, subscriptionId: sub.id, status: "active" };
  if (sub.status === "activating" || sub.status === "pending") return { ok: true, subscriptionId: sub.id, status: "processing" };
  // 결제를 시작하지도 않고 닫았으면 그 이유를 그대로(처음 응답과 같은 안내가 나가게)
  if (sub.cancelType && REFUSE_CODES.includes(sub.cancelType)) return { ok: false, code: sub.cancelType as RefuseCode };
  return { ok: false, code: "payment_failed" };
}

/** 쓰지 않을 빌링키를 지운다 — 실패해도 결제 처리를 막지 않는다(로그만). label은 로그용(시도 id 앞부분) */
async function discardKey(billingKey: string, label: string): Promise<void> {
  try {
    await deleteKey(billingKey, "ADMIN");
  } catch (e) {
    console.error(`[billing-pg] 쓰지 않는 빌링키 삭제 실패 ${label.slice(0, 8)}:`, e instanceof Error ? e.message : e);
  }
}

/** 결제하지 않고 끝낸다 — 시도는 failed, 받은 빌링키는 지운다(남겨 두면 쓸 곳 없는 결제수단 등록이 남는다) */
async function refuse(sub: Subscription, billingKey: string, code: RefuseCode): Promise<ActivateResult> {
  await prisma.subscription.updateMany({ where: { id: sub.id, status: "pending" }, data: { status: "failed", cancelType: code } });
  await discardKey(billingKey, sub.id);
  return { ok: false, code };
}

/**
 * 판매 스위치가 꺼진 동안 온 BillingKey.Issued — 결제하지 않고 그 발급 준비를 닫고 빌링키를 지운다(결제사 앱에 쓸 곳 없는 자동결제
 *   등록이 남지 않게, 2026-10-22 검토). 이미 처리 중이거나 끝난 시도는 건드리지 않는다.
 */
export async function discardIssuedKey(billingKey: string): Promise<"discarded" | "ignored"> {
  const issueId = await verifiedIssueId(billingKey);
  if (!issueId) return "ignored";
  const sub = await prisma.subscription.findUnique({ where: { purchaseToken: `portone:${issueId}` } });
  if (sub && sub.status !== "pending") return "ignored";
  if (sub) await refuse(sub, billingKey, "config");
  else await discardKey(billingKey, issueId);
  return "discarded";
}

/**
 * 이미 끝났어야 할 구독을 만료로 — 다시 가입하려는 사람을 예약 작업(하루 1회)까지 기다리게 하지 않는다.
 *   · 해지 예약(canceled)의 이용 기간이 지남
 *   · 만료가 지났는데 active·grace로 남은 구독 중 더 결제될 수 없는 것(해지 예약됐거나 빌링키가 없다) — 경쟁으로 굳은 상태의 출구
 *     (부분 유일 인덱스가 이 행을 '살아 있는 이용권'으로 세어 같은 어르신의 새 결제를 영구히 막았다 — 2026-10-22 검토)
 */
async function expireLapsed(beneficiaryUserId: string, now: Date): Promise<void> {
  await prisma.subscription.updateMany({
    where: { beneficiaryUserId, provider: "portone", status: "canceled", expiresAt: { lte: now } },
    data: { status: "expired", nextChargeAt: null },
  });
  await prisma.subscription.updateMany({
    where: {
      beneficiaryUserId, provider: "portone", status: { in: ["active", "grace"] }, expiresAt: { lte: now },
      OR: [{ cancelAtPeriodEnd: true }, { billingKeyEnc: null }],
    },
    data: { status: "expired", nextChargeAt: null, nextScheduleId: null },
  });
}

/** 첫 결제가 이만큼 activating에 머물면 멈춘 것으로 본다(결제 요청은 60초 안에 끝난다 — maxDuration) */
export const STUCK_ACTIVATION_MS = 10 * 60_000;

/**
 * 멈춘 첫 결제 하나를 확정한다 — 포트원 결과로 반영하고, 포트원에 결제가 아예 없으면(요청이 닿지 않았거나 요청 전에 멈춤 — 원장 행도
 *   없음) 실패 처리 + 빌링키 삭제. 예전엔 원장 행이 없으면 아무것도 하지 않아 activating에 영영 남았다(재가입을 막는다). 결과(로그용)
 */
export async function settleStuckActivation(sub: Subscription, now = new Date()): Promise<string> {
  const paymentId = paymentIdFor(sub.id, 1);
  const result = await syncPayment(paymentId, now);
  if (result !== "not_found" && result !== "ignored") return `first_${result}`;
  const row = await prisma.billingPayment.findUnique({ where: { paymentId } });
  if (row) return `first_${await markFailedAndRetry(row, "결제 요청이 확인되지 않음", now)}`;
  const r = await prisma.subscription.updateMany({
    where: { id: sub.id, status: "activating" }, data: { status: "failed", canceledAt: now, cancelType: "payment_failed" },
  });
  if (r.count > 0) await tryDropBillingKey(sub, "ADMIN", now);
  return "first_failed";
}

/** 이 어르신의 멈춘 첫 결제를 정리한다 — 새 발급 준비가 예약 작업을 기다리지 않게. 포트원이 실패하면 그대로 둔다(duplicate로 남는다) */
async function settleStuckActivations(beneficiaryUserId: string, now: Date): Promise<void> {
  const stuck = await prisma.subscription.findMany({
    where: { beneficiaryUserId, provider: "portone", status: "activating", updatedAt: { lte: new Date(now.getTime() - STUCK_ACTIVATION_MS) } },
  });
  for (const sub of stuck) {
    try {
      await settleStuckActivation(sub, now);
    } catch (e) {
      console.error(`[billing-pg] 멈춘 첫 결제 정리 실패 sub=${sub.id.slice(0, 8)}:`, e instanceof Error ? e.message.slice(0, 80) : e);
    }
  }
}

/** 첫 결제 — 결과는 syncPayment가 포트원 재조회로 확정한다(웹훅과 같은 함수) */
async function chargeFirst(sub: Subscription, billingKey: string, now: Date): Promise<ActivateResult> {
  const paymentId = paymentIdFor(sub.id, 1);
  const amountKrw = sub.priceKrw as number;
  await prisma.billingPayment.upsert({
    where: { paymentId },
    update: {},
    create: {
      paymentId, subscriptionId: sub.id, purchaserUserId: sub.purchaserUserId, cycleNo: 1, kind: "first", attempt: 0,
      amountKrw, payMethod: sub.payMethod, billingKeyHash: billingKeyFingerprint(billingKey), status: "requested",
    },
  });
  try {
    await portone().payment.payWithBillingKey({ paymentId, ...billingPaymentInput(sub, billingKey, amountKrw) });
  } catch (e) {
    // ALREADY_PAID = 같은 결제가 이미 됐다(재요청) · SDK 오류가 아니면(시간 초과 등) 결과를 모르니 다시 조회해 본다
    const t = portoneErrorType(e);
    if (t !== null && t !== "ALREADY_PAID") return firstPaymentFailed(sub, paymentId, pgMessageOf(e), now);
  }
  switch (await syncPayment(paymentId, now)) {
    case "paid":
      return { ok: true, subscriptionId: sub.id, status: "active" };
    case "mismatch":
      return { ok: false, code: "verification_failed" }; // 운영 경보가 나갔다 — 혜택 보류
    case "failed": {
      const row = await prisma.billingPayment.findUnique({ where: { paymentId }, select: { failureReason: true } });
      return { ok: false, code: "payment_failed", ...(row?.failureReason ? { message: row.failureReason } : {}) };
    }
    case "not_found":
      return firstPaymentFailed(sub, paymentId, null, now); // 요청이 포트원에 닿지 않았다
    default: {
      // 승인 대기(웹훅이 확정한다)·동시에 들어온 처리가 먼저 반영 — 지금 상태를 그대로 알려 준다
      const latest = await prisma.subscription.findUnique({ where: { id: sub.id } });
      return latest ? currentState(latest) : { ok: false, code: "not_found" };
    }
  }
}

/** 첫 결제 실패 — 원장 failed, 구독 failed(혜택 없음), 빌링키 삭제. PG 메시지는 가공하지 않고 그대로(네이버페이 조건) */
async function firstPaymentFailed(sub: Subscription, paymentId: string, pgMessage: string | null, now: Date): Promise<ActivateResult> {
  await prisma.billingPayment.updateMany({
    where: { paymentId, status: "requested" }, data: { status: "failed", failureReason: pgMessage ?? "결제 실패" },
  });
  const r = await prisma.subscription.updateMany({
    where: { id: sub.id, status: "activating" }, data: { status: "failed", canceledAt: now, cancelType: "payment_failed" },
  });
  if (r.count > 0) await tryDropBillingKey(sub, "ADMIN", now);
  return { ok: false, code: "payment_failed", ...(pgMessage ? { message: pgMessage } : {}) };
}

/**
 * BillingKey.Deleted 웹훅 — 결제회원이 카카오페이·네이버페이 앱에서 자동결제를 직접 해지한 경우 등.
 *   우리가 지운 것(구독이 이미 끝났거나 다른 빌링키로 바뀐 뒤)은 무시한다. 살아 있는 구독이면 다음 결제부터 해지로 바꾼다
 *   (이미 낸 기간은 만료일까지 — 결제수단이 없어 다음 결제가 어차피 실패한다). 이 웹훅이 오는지 자체는 실측 필요(research B 7).
 */
export async function onBillingKeyDeleted(billingKey: string, now = new Date()): Promise<"ignored" | "unchanged" | "canceled"> {
  let issueId: string | undefined;
  try {
    const info = await portone().payment.billingKey.getBillingKeyInfo({ billingKey });
    issueId = info.status === "DELETED" || info.status === "ISSUED" ? info.issueId : undefined;
  } catch (e) {
    if (portoneErrorType(e) === "BILLING_KEY_NOT_FOUND") return "ignored";
    throw e;
  }
  const sub = issueId ? await prisma.subscription.findUnique({ where: { purchaseToken: `portone:${issueId}` } }) : null;
  if (!sub || sub.provider !== "portone") return "ignored";
  const current = readBillingKey(sub.billingKeyEnc);
  if ((sub.status !== "active" && sub.status !== "grace") || current !== billingKey) return "unchanged";
  // 빌링키는 이미 지워졌다 — 남은 예약만 취소된다(삭제는 BILLING_KEY_ALREADY_DELETED로 성공 처리)
  await stopRenewal(sub, "key_deleted", { requester: "CUSTOMER" }, now);
  return "canceled";
}
