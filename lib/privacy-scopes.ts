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
 *   계정=purchaser·beneficiary. 나머지(id·createdAt·updatedAt)는 행 관리용. 결제 수단·결제 금액은 저장하지 않는다.
 */
export const SUBSCRIPTION_SCOPE = "상품·구독 상태·만료일·구매 토큰·마지막 확인 시각·환불·강제 해지 시각, 결제한 계정과 혜택을 받는 계정";
