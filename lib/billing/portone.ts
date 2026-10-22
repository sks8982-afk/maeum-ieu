/**
 * 웹 PG(포트원 V2) 정기결제 — **서버 전용** 진입점. API·예약 작업은 이 모듈에서 가져다 쓴다(클라이언트 컴포넌트에서 import 금지).
 *
 * 구성(한 파일 400줄 안팎으로 나눴다 — 아래 모듈은 서로를 직접 가져다 쓰고, 이 파일은 다시 내보내기만 한다):
 *   portone-plans        요금제(BILLING_PLANS)·결제수단(채널 키)·기능 스위치(isPgEnabled) — 서버·화면 공용
 *   portone-period       날짜·환불 계산(순수 함수) — KST 10:00 결제, 말일 보정, 청약철회 7일, 환불액
 *   portone-client       SDK 접점 — 클라이언트, 오류 종류, 예약 취소 → 빌링키 삭제
 *   portone-sync         결제 상태 동기화(웹훅·복귀·대사 공통) — 결제 완료·실패·재시도·취소 반영, 다음 회차 예약
 *   portone-activate     발급 준비(pending) → 빌링키 확정 → 첫 결제, BillingKey.Deleted
 *   portone-cancel       다음 결제부터 해지 · 지금 해지(환불) · 탈퇴·연결 해제
 *   paid-benefit         유료 혜택 사용 판정(무료 한도를 넘은 날)
 *   portone-mail         결제 안내 메일
 *   portone-maintenance  하루 1회 예약 작업(대사·만료·3일 전 안내)
 * ⚠ 안전 경로와 무관 — lib/chat/emergency*·lib/notify는 이 모듈을 import하지 않는다(__tests__/billing.test.ts '안전 경로 분리').
 */
export {
  paymentIdFor, nextChargeAt, anchorDayOf, periodDays, usedDays, withinWithdrawalWindow, retryAt, refundAmount, kstDayNumber,
  RETRY_OFFSETS_DAYS, WITHDRAWAL_DAYS, EARLY_CANCEL_PENALTY_PERCENT,
} from "@/lib/billing/portone-period";
export type { RefundRule, RefundInput } from "@/lib/billing/portone-period";
export { portone, revokeAll, deleteKey, revokeThenDeleteKey, portoneErrorType, pgMessageOf } from "@/lib/billing/portone-client";
export {
  syncPayment, markPaid, markFailedAndRetry, markCancelled, ensureNextSchedule, stopRenewal, linkActive, orderNameFor,
} from "@/lib/billing/portone-sync";
export type { SyncResult } from "@/lib/billing/portone-sync";
export {
  newIssueId, hasLiveSubscription, resolvePgBeneficiary, createPendingSubscription, activateByBillingKey, onBillingKeyDeleted,
  PENDING_TTL_MS,
} from "@/lib/billing/portone-activate";
export type { ActivateResult, PendingInput } from "@/lib/billing/portone-activate";
export {
  quoteCancellation, cancelAtPeriodEnd, cancelNow, finishRevocation, cancelForPurchaserDeletion, cancelForBeneficiaryGone,
} from "@/lib/billing/portone-cancel";
export type { CancellationQuote, CancelResult, SettleSummary } from "@/lib/billing/portone-cancel";
export { usedPaidBenefit } from "@/lib/billing/paid-benefit";
export { runBillingMaintenance, findSubscriptionsToReconcile, reconcileSubscription, sendRenewalNotices } from "@/lib/billing/portone-maintenance";
