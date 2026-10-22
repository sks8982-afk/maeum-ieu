/**
 * 웹 PG(포트원) 이용권의 약관 버전·필수 동의·고지 문구 — 결제 화면(클라이언트)·요금 안내·약관(서버)이 **같은 말**을 쓰도록 한곳에 둔다(2026-10-22).
 *
 * 왜 한곳인가: 결제 직전 고지·요금 안내·약관·환불정책이 7일·10%·재시도 날짜를 저마다 적으면 하나만 바뀌어도 고지가 거짓이 된다
 *   (미고지·허위 고지 과태료 — 웨이브·벅스 2025-10, research C 6·D 3). 숫자는 계산 모듈(portone-period)에서 가져온다.
 * 클라이언트에서도 import한다 — 그래서 순수 모듈(portone-period)만 가져온다. ⚠ portone-plans는 가져오지 않는다(daily-limit → prisma를
 *   끌어와 브라우저 번들에 넣을 수 없다). 요금제·무료 한도는 서버가 넘긴다(config API·서버 화면).
 * 표현(설계 11): '월 이용권(하루 대화 N회)'. '충전·크레딧·횟수권'과 의학적 효능 표현은 쓰지 않는다(__tests__/billing-pg-terms.test.ts).
 * ⚠ 문안은 법률 검토 전 초안이다(research C 머리말) — 문안을 바꾸면 lib/billing/portone-consent의 PG_TERMS_VERSION을 올린다
 *   (동의 기록이 어느 문안인지 가리킨다 — 약관 화면 머리에 그 버전을 적는다).
 */
import {
  EARLY_CANCEL_PENALTY_PERCENT, RETRY_OFFSETS_DAYS, WITHDRAWAL_DAYS, anchorDayOf, kstDayNumber, nextChargeAt, refundAmount, type RefundInput,
} from "@/lib/billing/portone-period";
import type { ConsentKey } from "@/lib/billing/portone-consent";

/**
 * 약관·환불정책 시행일(화면 표시) — ⚠ 웹 결제를 실제로 여는 날(BILLING_PG_ENABLED=1 배포일)로 고친다.
 *   먼저 적힌 날짜로 열면 그날부터 시행된 것처럼 고지된다(개인정보처리방침 시행일과 같은 원칙 — app/privacy 주석).
 */
export const PG_TERMS_EFFECTIVE = "2026년 10월 22일";

/** 필수 동의 항목의 문구와 '보기' 링크 — 항목 이름·순서는 서버(lib/billing/portone-consent REQUIRED_CONSENTS)가 정한다 */
export function consentLabel(item: ConsentKey, o: { priceKrw: number; chargeDay: number }): { text: string; href: string } {
  switch (item) {
    case "terms":
      return { text: "(필수) 유료서비스 이용약관에 동의합니다.", href: "/terms/paid" };
    case "refundPolicy":
      return { text: "(필수) 청약철회·해지·환불 조건을 확인했고 동의합니다.", href: "/terms/refund" };
    case "autoRenew":
      return {
        text: `(필수) 해지할 때까지 매월 ${o.chargeDay}일(그날이 없는 달은 말일)에 ${krw(o.priceKrw)}이 자동결제되는 것에 동의합니다.`,
        href: "/terms/paid#auto-renew",
      };
    case "privacyEntrust":
      return { text: "(필수) 결제를 위해 결제대행사에 결제 정보 처리를 맡기는 것(처리 위탁)을 확인했습니다.", href: "/privacy#payment-entrust" };
  }
}

/** 금액 표시 — "19,900원". 정수 자릿점은 직접 찍는다(서버·브라우저 로캘 차이로 하이드레이션이 어긋나지 않게) */
export function krw(n: number): string {
  return `${String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}원`;
}

/** 한국 시간 날짜 — "2026년 11월 2일"(브라우저 시간대와 무관) */
export function kstDateLabel(d: Date): string {
  const k = new Date(d.getTime() + 9 * 3_600_000);
  return `${k.getUTCFullYear()}년 ${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일`;
}

/**
 * 이용기간 마지막 날 — 이용권이 끝나는 시각(다음 결제 예정일 10:00 KST)의 **전날**(약관 제2조 '이용기간'과 같은 말 — kstDateLabel로 적는다).
 *   화면·메일·약관이 저마다 다른 날짜를 적지 않게 한곳에서 센다(2026-10-22 검토: 화면 12월 2일·메일 12월 1일).
 */
export function lastUsableDay(end: Date): Date {
  return new Date((kstDayNumber(end) - 1) * 86_400_000);
}

/** 지금 결제하면 매월 결제일과 다음 결제 예정일 — 서버(lib/billing/portone-sync)와 같은 계산(첫 결제일 기준, 없는 달은 말일) */
export function chargeSchedule(now: Date): { chargeDay: number; nextCharge: Date } {
  const chargeDay = anchorDayOf(now);
  return { chargeDay, nextCharge: nextChargeAt(chargeDay, now) };
}

/** 계속 무료로 쓰는 것 — 안전 기능은 결제와 무관(설계 0). freeLimit 0 이하 = 무료 한도 없음 */
export function freeFeaturesLine(freeLimit: number): string {
  const talk = freeLimit > 0 ? `, 하루 ${freeLimit}회 대화` : "";
  return `위급 상황 감지와 보호자 위급 알림${talk}는 이용권 없이도 계속 무료입니다.`;
}

/**
 * 청약철회(기한·방법·효과) 한 줄 — 결제 화면에 **직접** 적는다(링크만으로는 부족 — 스포티파이·벅스 제재, research D 3).
 *   기한은 계산(portone-period withinWithdrawalWindow — 결제일을 세지 않고 7일째 되는 날 24시까지, 결제 당일도 된다)과 같은 말로
 *   적는다. "다음 날부터"라고 쓰면 당일엔 안 되는 것처럼 읽힌다(2026-10-22 검토).
 */
export const WITHDRAWAL_SUMMARY =
  `결제한 날(자동결제일 포함) 당일부터 ${WITHDRAWAL_DAYS}일 뒤 같은 날 24시(한국 시간)까지 [구독 관리]에서 [지금 해지]를 고르면 청약철회로 처리돼요. ` +
  "늘어난 대화(유료 혜택)를 쓰지 않았으면 전액, 썼으면 이용한 날짜만큼만 빼고 돌려드립니다(위약금 없음).";

/** 해지 두 방식 — 가입 단계에서도 둘 다 안내한다(웨이브·벅스 제재, research D 3) */
export const CANCEL_SUMMARY: readonly string[] = [
  "다음 결제부터 해지: 이번 이용기간 마지막 날까지 그대로 쓰고, 그 뒤로는 결제되지 않습니다(환불 없음).",
  `지금 해지: 바로 끝나고, 결제 금액에서 이용한 날짜만큼과 남은 기간 요금의 ${EARLY_CANCEL_PENALTY_PERCENT}%를 뺀 금액을 돌려드립니다` +
    `(청약철회 기간 안이면 청약철회 기준).`,
];

/** 결제 실패 — 재시도 날짜(1일 뒤·3일 뒤)는 예약 작업과 같은 값 */
export const RETRY_SUMMARY =
  `결제가 실패하면 ${RETRY_OFFSETS_DAYS.map((d) => `${d}일 뒤`).join("와 ")} 오전 10시에 다시 결제를 시도하고, 그동안 혜택을 유지합니다. ` +
  "모두 실패하면 이용권이 끝나고 무료 이용으로 바뀝니다.";

/** 환불 방법 — 결제한 수단의 결제 취소로만(자체 포인트 환불 금지 — 카드 가맹점 표준약관·네이버페이 결제형 조건) */
export const REFUND_METHOD_SUMMARY = "환불은 결제한 수단의 결제 취소(부분 취소 포함)로 하며, 신청일부터 3영업일 안에 취소를 요청합니다.";

/** 환불정책 계산 예시의 기준 — 월 19,900원, 이용기간 30일(research C 5) */
export const EXAMPLE_PRICE = 19_900;
export const EXAMPLE_DAYS = 30;

/**
 * 환불정책 계산 예시(/terms/refund) — 상황·계산 설명·환불액. 환불액은 **실제 환불 계산(refundAmount)** 으로 낸다 —
 *   손으로 적으면 위약금 비율이나 공제 방식을 바꿀 때 예시만 남아 허위 고지가 된다.
 */
export function refundExamples(): { situation: string; how: string; refundKrw: number }[] {
  const calc = (o: Omit<RefundInput, "paidKrw" | "periodDays">) => refundAmount({ paidKrw: EXAMPLE_PRICE, periodDays: EXAMPLE_DAYS, ...o });
  const used = (days: number) => Math.floor((EXAMPLE_PRICE * days) / EXAMPLE_DAYS);
  const rest12 = EXAMPLE_PRICE - used(12);
  const penalty12 = Math.floor((rest12 * EARLY_CANCEL_PENALTY_PERCENT) / 100);
  return [
    { situation: "결제 후 3일째 청약철회, 유료 혜택을 쓰지 않음", how: "전액",
      refundKrw: calc({ usedDays: 3, rule: "withdrawal", usedPaidBenefit: false }) },
    { situation: "결제 후 5일째 청약철회, 유료 혜택을 씀", how: `${krw(EXAMPLE_PRICE)} − 이용 5일 ${krw(used(5))}`,
      refundKrw: calc({ usedDays: 5, rule: "withdrawal", usedPaidBenefit: true }) },
    { situation: "12일째 지금 해지",
      how: `${krw(EXAMPLE_PRICE)} − 이용 12일 ${krw(used(12))} − 남은 기간 요금 ${krw(rest12)}의 ${EARLY_CANCEL_PENALTY_PERCENT}% ${krw(penalty12)}`,
      refundKrw: calc({ usedDays: 12, rule: "immediate", usedPaidBenefit: true }) },
    { situation: "12일째 다음 결제부터 해지", how: "환불 없음, 이용기간 끝까지 이용",
      refundKrw: calc({ usedDays: 12, rule: "period_end", usedPaidBenefit: true }) },
  ];
}

/** 가격 변경 — 가입 당시 금액 유지, 올릴 때는 30일 전 기간에 따로 동의(전자상거래법 제13조⑥) */
export const PRICE_CHANGE_SUMMARY =
  "가입할 때의 금액으로 계속 결제됩니다. 요금을 올릴 때는 바뀌기 전 30일 동안의 기간에 알리고 따로 동의를 받으며, 동의하지 않으면 이번 이용기간이 끝날 때 종료되고 오른 금액으로 결제되지 않습니다.";
