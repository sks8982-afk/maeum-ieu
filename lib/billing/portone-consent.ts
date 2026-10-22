/**
 * 웹 PG(포트원) 결제의 필수 동의 — 항목 이름과 약관 문구 버전. 동의 기록(BillingConsent)에 이 값이 그대로 남는다(분쟁 대비).
 *
 * 화면(app/subscribe)은 config API(/api/billing/portone/config)로 이 목록·버전을 받아 체크박스를 그린다 — 필수·항목마다 분리·
 *   기본 미체크(전자상거래법 시행령 제9조, research D 3). 서버(prepare)는 항목이 **전부 true**일 때만 발급 준비를 한다.
 * ⚠ 유료서비스 이용약관(/terms/paid)·환불정책(/terms/refund)·처리방침의 결제 문구를 바꾸면 PG_TERMS_VERSION을 올린다 —
 *   "언제 어떤 문구에 동의했나"가 기록의 전부다. 버전이 바뀌면 옛 화면에서 보낸 동의는 거절된다(terms_outdated).
 * 서버 전용 값이 없다 — 화면에서 import해도 된다.
 */

/** 결제 약관·환불정책·처리방침(결제 위탁) 문구 버전 */
export const PG_TERMS_VERSION = "2026-10-22";

/**
 * 필수 동의 항목(설계 3 consents).
 *   terms          유료서비스 이용약관
 *   autoRenew      매월 자동결제(해지 전까지)·결제일·금액
 *   privacyEntrust 결제 처리를 위한 개인정보 처리 위탁(포트원·결제대행사)
 *   refundPolicy   해지·환불·청약철회 정책
 */
export const REQUIRED_CONSENTS = ["terms", "autoRenew", "privacyEntrust", "refundPolicy"] as const;
export type ConsentKey = (typeof REQUIRED_CONSENTS)[number];

/**
 * 필수 동의가 전부 true인가 — { terms: true, … } 꼴만 받는다(문자열 "true"·1은 동의로 보지 않는다).
 *   모르는 항목이 섞여 있어도 필수 항목만 본다.
 */
export function consentsComplete(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  return REQUIRED_CONSENTS.every((k) => o[k] === true);
}
