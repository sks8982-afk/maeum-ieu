/**
 * 개인정보 고지에 적는 저장 범위 — 개인정보처리방침(1·7항)·계정 삭제 안내(/account-deletion)·출시 가이드의 데이터 안전성 설명
 *   (docs/playstore/README_출시가이드.md 3절)이 **같은 말**을 쓰도록 한곳에 둔다(2026-10-08 12차). 예전엔 셋이 휴대폰 등록 정보를
 *   저마다 달리 적었다("앱 버전·알림 허용 상태" / "알림 토큰·앱 버전·알림 허용 상태" / "앱 버전·알림 허용 상태·위급 알림 채널 상태").
 *   page 파일은 Next가 정한 이름만 내보낼 수 있어 여기서 가져다 쓴다. 출시 가이드(마크다운)는 같은 문자열을 손으로 적는다.
 *   ⚠ 저장하는 것을 바꾸면(컬럼·필드를 더하거나 빼면) 여기와 출시 가이드를 함께 고친다 — __tests__/account-deletion-page.test.ts가
 *   DDL·스키마와 세 문서를 맞대어 본다.
 */

/**
 * 위급 알림을 받는 휴대폰 등록(push_device — scripts/ops-push-device.ts, 보호자·의사 계정만 저장): 알림 토큰=token · 앱 버전=app_version ·
 *   알림 허용=permission · 위급 알림 채널 상태=channel_blocked · 마지막 확인 시각=updated_at. 나머지(user_id·platform·created_at)는 행 관리용.
 */
export const PUSH_DEVICE_SCOPE = "알림 토큰·앱 버전·알림 허용·위급 알림 채널 상태·마지막 확인 시각";

/**
 * 구독 기록(prisma/schema.prisma model Subscription — Play 구독 결제를 Google에 확인한 결과): 상품=productId · 구독 상태=status ·
 *   만료일=expiresAt · 구매 토큰=purchaseToken · 마지막 확인 시각=verifiedAt · 환불·강제 해지 시각=revokedAt · 결제한 계정·혜택을 받는
 *   계정=purchaser·beneficiary. 나머지(id·createdAt·updatedAt)는 행 관리용. **Play 구독은** 결제 수단·결제 금액을 저장하지 않는다
 *   (그 컬럼들은 웹 결제 이용권 행에만 채운다 — 아래 PG_SUBSCRIPTION_SCOPE).
 */
export const SUBSCRIPTION_SCOPE = "상품·구독 상태·만료일·구매 토큰·마지막 확인 시각·환불·강제 해지 시각, 결제한 계정과 혜택을 받는 계정";

/**
 * 웹 결제(포트원 월 이용권, 2026-10-22) 행에만 채우는 구독 기록 컬럼(같은 model Subscription — scripts/ops-billing-pg.ts):
 *   결제 경로=provider · 결제수단 종류=payMethod · 가입 당시 월 금액=priceKrw · 하루 대화 한도=dailyTurnLimit ·
 *   암호화한 자동결제 키(빌링키)=billingKeyEnc · 결제 기준일=anchorDay · 회차=cycleNo · 다음 결제 예정 시각=nextChargeAt ·
 *   결제 예약 번호=nextScheduleId · 해지 예약=cancelAtPeriodEnd · 해지 시각=canceledAt · 해지 사유=cancelType ·
 *   결제 실패 횟수=failedChargeCount · 결제 전 안내 발송 기록=renewalNoticeFor · 가입 당시 무료 대화 한도=freeTurnLimit.
 *   카드 번호 등 결제수단 정보는 받지도 저장하지도 않는다.
 *   계정 삭제 때 구독 기록과 함께 지워진다(FK CASCADE). 결제·동의 기록은 따로 5년 보존한다(아래 둘).
 */
export const PG_SUBSCRIPTION_SCOPE =
  "결제 경로·결제수단 종류·가입 당시 월 금액과 하루 대화 한도·가입 당시 무료 대화 한도·암호화한 자동결제 키·결제 기준일과 회차·다음 결제 예정 시각과 예약 번호·해지 예약·해지 시각과 사유·결제 실패 횟수·결제 전 안내 발송 기록";

/**
 * 웹 결제 원장(model BillingPayment — FK 없음, 5년 보존): 결제 번호=paymentId · 구독=subscriptionId · 결제한 계정=purchaserUserId ·
 *   회차=cycleNo · 종류=kind · 시도 차수=attempt · 금액=amountKrw · 결제수단 종류=payMethod · 자동결제 키의 지문=billingKeyHash ·
 *   결제 상태=status · 이용기간=periodStart·periodEnd · 예약 시각=scheduledAt · 결제 시각=paidAt · 결제 안내 발송 시각=paidMailAt ·
 *   환불 금액=cancelledKrw·refundTargetKrw · 해지·청약철회 종류와 신청 시각=cancelType·cancelRequestedAt · 실패 사유=failureReason ·
 *   영수증 주소=receiptUrl. 나머지(createdAt·updatedAt)는 행 관리용.
 */
export const PG_PAYMENT_SCOPE =
  "결제 번호·회차·종류와 시도 차수·금액·결제수단 종류·자동결제 키의 지문·결제 상태·이용기간·예약 시각·결제 시각·결제 안내 발송 시각·환불 금액·해지·청약철회 종류와 신청 시각·실패 사유·영수증 주소, 결제한 계정";

/**
 * 웹 결제 동의 기록(model BillingConsent — FK 없음, 5년 보존): 동의한 항목=items · 약관 문구 버전=termsVersion ·
 *   동의할 때 안내한 요금제와 금액·한도·결제수단·혜택 받는 분=offer · 동의 시각=createdAt · 동의한 계정=userId · 구독=subscriptionId
 */
export const PG_CONSENT_SCOPE = "동의한 항목·약관 문구 버전·동의할 때 안내한 요금제와 금액·한도·결제수단·혜택 받는 분·동의 시각, 동의한 계정";
