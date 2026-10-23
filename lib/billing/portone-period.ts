/**
 * 포트원 정기결제의 날짜·금액 계산 — 순수 함수만(DB·네트워크 없음).
 *
 * 기준은 전부 **한국 시간(KST, UTC+9 — 서머타임 없음)**이다. 서버는 UTC로 돈다(Vercel·ECS) — 날짜를 new Date().getDate()로
 *   읽으면 KST 00~09시 결제가 전날로 잡힌다. 하루의 경계는 lib/usage/daily-limit.ts(KST 자정)와 같다.
 *
 * 결제 시각: 매월 기준일 **10:00 KST**. 자정 근처는 피한다(네이버페이 23:45~00:10 은행 점검 — research B25).
 * 기간·환불 규칙은 환불정책 권장안(research C) 그대로다:
 *   · 이용기간 = 결제일부터 다음 결제 예정일 전날까지, 하루 요금 = 결제 금액 ÷ 그 기간의 실제 날짜 수
 *   · 이용일수 = 이용기간 첫날부터 신청일까지(둘 다 포함, KST)
 *   · 공제액의 원 미만은 버린다(소비자에게 유리하게)
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const KST_OFFSET_MS = 9 * HOUR_MS;
/** 결제 시각 10:00 KST = 01:00 UTC */
const CHARGE_HOUR_UTC = 1;

/** 결제 실패 뒤 재시도 — 회차 예정일로부터 1일·3일 뒤 10:00 KST(설계 '조사 반영 결정' 7) */
export const RETRY_OFFSETS_DAYS: readonly number[] = [1, 3];
/** 재시도 중(grace) 혜택 유지 여유 — 재시도 결과(웹훅)가 늦게 와도 그 사이 혜택이 끊기지 않게 */
export const GRACE_MARGIN_MS = DAY_MS;
/** 재시도 예약을 너무 촉박하게 잡지 않는다 — 이보다 가까우면 다음 10:00 KST로 */
const MIN_RETRY_LEAD_MS = 5 * 60_000;
/** 청약철회 기간 — 결제일(자동 갱신 포함)부터 7일 */
export const WITHDRAWAL_DAYS = 7;
/** 7일 뒤 지금 해지(중도해지)의 위약금 — 남은 기간 이용요금의 10%(환불정책 권장안. 0으로 정하면 단순화안) */
export const EARLY_CANCEL_PENALTY_PERCENT = 10;

/** KST 날짜 번호(1970-01-01 KST = 0) — 두 시각이 KST로 같은 날인지·며칠 차이인지를 이것으로 잰다 */
export function kstDayNumber(d: Date): number {
  return Math.floor((d.getTime() + KST_OFFSET_MS) / DAY_MS);
}

/** KST 날짜 번호의 10:00 KST */
export function kstTenAm(dayNumber: number): Date {
  return new Date(dayNumber * DAY_MS + CHARGE_HOUR_UTC * HOUR_MS);
}

/** 결제 기준일(KST 1~31) — 첫 결제일의 날짜. 그날이 없는 달은 말일에 결제한다(nextChargeAt) */
export function anchorDayOf(paidAt: Date): number {
  return new Date(paidAt.getTime() + KST_OFFSET_MS).getUTCDate();
}

/**
 * 다음 결제 시각: dueAt이 속한 달(KST)의 다음 달 anchorDay 10:00 KST — 그날이 없으면 그 달 말일.
 *   dueAt에는 이번 회차의 **예정 시각**을 넣는다(첫 회차는 결제 시각). 재시도로 늦게 결제돼도 결제일이 밀리지 않게 하기 위해서다.
 *   anchorDay를 따로 들고 다니는 이유: 1/31 → 2/28 → 3/28로 줄어들지 않고 3/31로 돌아온다.
 */
export function nextChargeAt(anchorDay: number, dueAt: Date): Date {
  const kst = new Date(dueAt.getTime() + KST_OFFSET_MS);
  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth() + 1; // 다음 달(0-based) — 12면 Date.UTC가 다음 해 1월로 넘긴다
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(anchorDay, lastDay), CHARGE_HOUR_UTC));
}

/** 이용기간의 실제 날짜 수 — 시작일부터 끝(다음 결제일) 전날까지. 최소 1 */
export function periodDays(periodStart: Date, periodEnd: Date): number {
  return Math.max(1, kstDayNumber(periodEnd) - kstDayNumber(periodStart));
}

/** 이용일수 — 이용기간 첫날부터 신청일까지(둘 다 포함, KST). 1 ~ 기간 날짜 수로 자른다 */
export function usedDays(periodStart: Date, now: Date, totalDays: number): number {
  return Math.min(totalDays, Math.max(1, kstDayNumber(now) - kstDayNumber(periodStart) + 1));
}

/**
 * 청약철회 기간 안인가 — 결제일 다음 날부터 7일째 되는 날 24:00(KST)까지.
 *   "결제일부터 7일"을 민법 제157조(초일 불산입)대로 읽는다: 결제는 하루 중간에 일어나므로 결제일은 세지 않는다.
 *   결제 시각으로부터 7×24시간으로 자르는 것보다 소비자에게 불리하지 않다.
 */
export function withinWithdrawalWindow(paidAt: Date, now: Date): boolean {
  return kstDayNumber(now) - kstDayNumber(paidAt) <= WITHDRAWAL_DAYS;
}

/**
 * 재시도 시각 — attempt번째 재시도(1·2)를 회차 예정일(dueAt)로부터 RETRY_OFFSETS_DAYS[attempt-1]일 뒤 10:00 KST에.
 *   그 시각이 이미 지났거나 촉박하면(실패를 늦게 알았을 때) 지금 이후 가장 가까운 10:00 KST.
 *   재시도를 다 썼으면 null(만료).
 */
export function retryAt(dueAt: Date, attempt: number, now: Date): Date | null {
  const offset = RETRY_OFFSETS_DAYS[attempt - 1];
  if (offset === undefined) return null;
  const planned = kstTenAm(kstDayNumber(dueAt) + offset);
  const earliest = now.getTime() + MIN_RETRY_LEAD_MS;
  if (planned.getTime() > earliest) return planned;
  const today = kstTenAm(kstDayNumber(now));
  return today.getTime() > earliest ? today : kstTenAm(kstDayNumber(now) + 1);
}

/**
 * 환불 규칙(환불정책 권장안 — research C 3절)
 *   withdrawal  결제일부터 7일 안 철회 — 유료 혜택을 안 썼으면 전액, 썼으면 이용일수만 공제(위약금 없음)
 *   immediate   7일 뒤 지금 해지 — 이용일수와 남은 기간 이용요금의 10% 공제
 *   no_penalty  위약금 없는 지금 해지 — 보호자·어르신 연결이 끊긴 뒤, 혜택 받는 어르신 계정이 삭제될 때(이용일수만 공제)
 *   period_end  다음 결제부터 해지 — 만료일까지 이용, 환불 없음
 */
export type RefundRule = "withdrawal" | "immediate" | "no_penalty" | "period_end";

export interface RefundInput {
  paidKrw: number;
  periodDays: number;
  usedDays: number;
  rule: RefundRule;
  usedPaidBenefit: boolean;
}

/** 환불액(원). 공제액의 원 미만은 버린다 — 하루 요금을 먼저 내림하지 않고 마지막에 한 번 내림한다(⌊19,900×5/30⌋ = 3,316) */
export function refundAmount(a: RefundInput): number {
  if (a.rule === "period_end") return 0;
  if (a.rule === "withdrawal" && !a.usedPaidBenefit) return a.paidKrw;
  const usedKrw = Math.floor((a.paidKrw * a.usedDays) / a.periodDays);
  const remaining = a.paidKrw - usedKrw;
  // 정수 연산 — 소수(0.1) 곱셈은 1194.0000000000002 같은 값을 만든다
  const penalty = a.rule === "immediate" ? Math.floor((remaining * EARLY_CANCEL_PENALTY_PERCENT) / 100) : 0;
  return Math.max(0, remaining - penalty);
}

/**
 * 포트원 결제 id — 회차마다 정해진 값. 같은 id는 한 번만 결제되므로(ALREADY_PAID) 재요청이 이중 결제가 되지 않는다.
 *   영숫자만, 40자 이내(구독 id는 cuid 25자 → 최대 약 33자). suffix: 재시도 r1·r2.
 */
export function paymentIdFor(subscriptionId: string, cycleNo: number, suffix = ""): string {
  return `s${subscriptionId}c${cycleNo}${suffix}`;
}
