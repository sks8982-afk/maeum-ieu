/**
 * 구독 플랜 정의 — 가격·상품 ID는 코드가 아니라 설정이다.
 *
 * 왜 설정인가: 가격 정책은 Play Console에서 정해지고 바뀐다. 상품 ID를 코드에 박으면
 *   가격 실험 한 번에 배포가 필요해진다. 서버는 "이 상품 ID는 유료 티어다"만 알면 된다.
 *
 * 비용 실측(2026-10-02 30턴 e2e, 10-06 재측정 13.12원): 턴당 약 13.5원 — 2027년 3.8-flash 정가 기준 14.6원.
 *   하루 10턴 ≈ 월 4,050원 / 30턴 ≈ 월 12,150원 / 100턴 ≈ 월 40,500원 (현재 원가).
 *   ⚠ 가격을 정할 때 이 원가를 기준으로 상한을 잡아야 한다 — 상한이 가격보다 비싸면 적자다.
 *   ⚠ 수령액 = 요금 ÷ 1.1(부가세 — 국내 개발자가 직접 납부) × 0.85(Play 수수료).
 *   권장안(docs/마음이음_AI모델_가격정책_2026-10-07.pptx 결론): 무료 DAILY_TURN_LIMIT=10 · 유료 PRO_DAILY_TURN_LIMIT=30 · 월 19,900원.
 *
 * 무료 티어는 **기존 DAILY_TURN_LIMIT을 그대로 쓴다**. 구독은 상한을 '올리는' 장치이며,
 *   구독 도입이 기존 사용자의 조건을 조용히 낮추지 않는다.
 */

/** 유료 티어로 인정할 Play 구독 상품 ID 목록 — 쉼표 구분. 비어 있으면 모든 상품을 유료로 인정 */
export const PRO_PRODUCT_IDS: readonly string[] = (process.env.BILLING_PRO_PRODUCT_IDS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

/**
 * 결제 강제 여부. 0(기본)이면 **혜택만 주고 아무것도 막지 않는다**.
 *   가격이 확정되고 Play Console 상품이 준비된 뒤 1로 켠다. 끄고 켜는 것만으로
 *   유료 기능 차단이 on/off 되므로, 출시 전에 코드 변경 없이 검증할 수 있다.
 */
export const BILLING_ENFORCE = process.env.BILLING_ENFORCE === "1";

/** 유료 티어 일일 상한 — 미설정 시 무료 상한의 3배 */
export function proDailyTurnLimit(freeLimit: number): number {
  // 빈 문자열은 미설정으로 — daily-limit.ts와 같은 이유(Number("")===0 함정)
  const rawStr = process.env.PRO_DAILY_TURN_LIMIT?.trim();
  const raw = rawStr ? Number(rawStr) : NaN;
  if (Number.isFinite(raw) && raw > 0) return raw;
  return freeLimit > 0 ? freeLimit * 3 : 0;
}

/** 이 상품 ID가 유료 티어인가 */
export function isProProduct(productId: string): boolean {
  return PRO_PRODUCT_IDS.length === 0 || PRO_PRODUCT_IDS.includes(productId);
}

/**
 * 혜택이 유지되는 구독 상태.
 *   canceled = 해지 예약 — 만료일까지는 이미 낸 돈에 대한 권리가 있으므로 혜택을 유지한다.
 *   grace    = 결제 실패 복구 기간(Play 권장) — 끊지 않는다.
 *   on_hold·paused·expired·revoked = 혜택 종료.
 */
export const ENTITLED_STATUSES: readonly string[] = ["active", "grace", "canceled"];
