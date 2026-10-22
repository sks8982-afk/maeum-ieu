/**
 * 포트원 정기결제의 날짜·환불 계산(lib/billing/portone-period) — 순수 함수.
 *
 * 왜 꼼꼼히: 결제일·이용기간·환불액은 돈이고, 서버는 UTC로 돈다. new Date().getDate()처럼 서버 시각으로 날짜를 읽으면
 *   KST 00~09시 결제가 전날로 잡혀 결제일·청약철회 기한·환불액이 하루씩 틀어진다 — 그 경계를 일부러 시험한다.
 *   월말(31일 → 2월 말일 → 다시 31일)·윤년(2028-02-29)·연말(12월 → 다음 해 1월)도 고정한다.
 * 환불액은 환불정책 권장안의 계산 예시 표(research C 5 — 월 19,900원, 이용기간 30일)를 그대로 검증한다.
 */
import { describe, it, expect } from "vitest";
import {
  anchorDayOf, kstDayNumber, nextChargeAt, paymentIdFor, periodDays, refundAmount, retryAt, usedDays, withinWithdrawalWindow,
} from "@/lib/billing/portone-period";

/** KST 벽시계 시각 → Date */
const kst = (s: string) => new Date(`${s}+09:00`);

describe("다음 결제 시각 — 매월 기준일 10:00 KST, 그날이 없는 달은 말일", () => {
  it("결제일과 같은 날 다음 달 10:00 KST", () => {
    const paid = kst("2026-11-02T14:05:00");
    expect(nextChargeAt(anchorDayOf(paid), paid)).toEqual(kst("2026-12-02T10:00:00"));
  });

  it("31일 기준 → 2월은 말일(28일), 그다음 달은 다시 31일 — 기준일이 줄어들지 않는다", () => {
    const feb = nextChargeAt(31, kst("2026-01-31T10:00:00"));
    expect(feb).toEqual(kst("2026-02-28T10:00:00"));
    // 🔒 2월 28일을 기준으로 다음 달을 계산하면 3/28이 된다 — anchorDay를 따로 들고 다니는 이유
    expect(nextChargeAt(31, feb)).toEqual(kst("2026-03-31T10:00:00"));
    expect(nextChargeAt(31, kst("2026-03-31T10:00:00"))).toEqual(kst("2026-04-30T10:00:00"));
  });

  it("윤년 2월은 29일까지 — 2028-02-29, 평년은 28일", () => {
    expect(nextChargeAt(31, kst("2028-01-31T10:00:00"))).toEqual(kst("2028-02-29T10:00:00"));
    expect(nextChargeAt(29, kst("2028-01-29T10:00:00"))).toEqual(kst("2028-02-29T10:00:00"));
    expect(nextChargeAt(29, kst("2027-01-29T10:00:00"))).toEqual(kst("2027-02-28T10:00:00"));
  });

  it("12월 → 다음 해 1월", () => {
    expect(nextChargeAt(15, kst("2026-12-15T10:00:00"))).toEqual(kst("2027-01-15T10:00:00"));
    expect(nextChargeAt(31, kst("2026-12-31T10:00:00"))).toEqual(kst("2027-01-31T10:00:00"));
  });

  it("KST 경계 — KST 4월 1일 00:30(UTC로는 3월 31일) 결제의 기준일은 1일이다", () => {
    const paid = kst("2026-04-01T00:30:00");
    expect(paid.getUTCDate()).toBe(31); // 서버(UTC)로 읽으면 31일 — 이 함정을 피해야 한다
    expect(anchorDayOf(paid)).toBe(1);
    expect(nextChargeAt(anchorDayOf(paid), paid)).toEqual(kst("2026-05-01T10:00:00"));
  });

  it("KST 경계 — 달의 마지막 날 23:30 KST 결제는 그 달 기준으로 다음 달", () => {
    const paid = kst("2026-01-31T23:30:00");
    expect(anchorDayOf(paid)).toBe(31);
    expect(nextChargeAt(31, paid)).toEqual(kst("2026-02-28T10:00:00"));
  });
});

describe("이용기간·이용일수 — KST 날짜, 첫날과 신청일 모두 포함", () => {
  const start = kst("2026-11-02T14:05:00");
  const end = kst("2026-12-02T10:00:00");

  it("이용기간 날짜 수 = 시작일부터 다음 결제일 전날까지(11/2~12/1 = 30일)", () => {
    expect(periodDays(start, end)).toBe(30);
    expect(periodDays(kst("2026-01-31T10:00:00"), kst("2026-02-28T10:00:00"))).toBe(28);
  });

  it("첫날 = 1일째, 12일째 = 12, 기간을 넘지 않는다", () => {
    expect(usedDays(start, kst("2026-11-02T20:00:00"), 30)).toBe(1);
    expect(usedDays(start, kst("2026-11-13T09:00:00"), 30)).toBe(12);
    expect(usedDays(start, kst("2027-01-10T09:00:00"), 30)).toBe(30);
  });

  it("KST 자정을 넘기면 하루가 늘어난다 — UTC로는 아직 같은 날이어도", () => {
    const afterMidnightKst = kst("2026-11-03T00:30:00");
    expect(afterMidnightKst.getUTCDate()).toBe(2);
    expect(usedDays(start, afterMidnightKst, 30)).toBe(2);
    expect(kstDayNumber(afterMidnightKst) - kstDayNumber(start)).toBe(1);
  });
});

describe("청약철회 기간 — 결제일 다음 날부터 7일째 되는 날 24:00 KST까지", () => {
  const paid = kst("2026-11-02T14:05:00");

  it("11/9 23:59 KST까지는 안, 11/10 00:00 KST부터는 밖", () => {
    expect(withinWithdrawalWindow(paid, kst("2026-11-02T15:00:00"))).toBe(true);
    expect(withinWithdrawalWindow(paid, kst("2026-11-09T23:59:00"))).toBe(true);
    expect(withinWithdrawalWindow(paid, kst("2026-11-10T00:00:00"))).toBe(false);
  });

  it("KST 경계 — 11/10 00:30 KST는 UTC로 11/9지만 기간 밖이다", () => {
    const t = kst("2026-11-10T00:30:00");
    expect(t.getUTCDate()).toBe(9);
    expect(withinWithdrawalWindow(paid, t)).toBe(false);
  });
});

describe("결제 실패 재시도 — 예정일로부터 1일·3일 뒤 10:00 KST", () => {
  const due = kst("2026-12-02T10:00:00");

  it("1차 12/3 10:00, 2차 12/5 10:00, 그 뒤는 없음(만료)", () => {
    expect(retryAt(due, 1, kst("2026-12-02T10:01:00"))).toEqual(kst("2026-12-03T10:00:00"));
    expect(retryAt(due, 2, kst("2026-12-03T10:01:00"))).toEqual(kst("2026-12-05T10:00:00"));
    expect(retryAt(due, 3, kst("2026-12-05T10:01:00"))).toBeNull();
  });

  it("실패를 늦게 알았으면 지금 이후 가장 가까운 10:00 KST — 지난 시각으로 예약하지 않는다", () => {
    expect(retryAt(due, 1, kst("2026-12-04T12:00:00"))).toEqual(kst("2026-12-05T10:00:00"));
    expect(retryAt(due, 1, kst("2026-12-04T09:00:00"))).toEqual(kst("2026-12-04T10:00:00"));
    // 5분 안으로 촉박하면 다음 날
    expect(retryAt(due, 1, kst("2026-12-04T09:58:00"))).toEqual(kst("2026-12-05T10:00:00"));
  });
});

describe("환불액 — 환불정책 계산 예시 표 그대로(월 19,900원, 이용기간 30일)", () => {
  const base = { paidKrw: 19_900, periodDays: 30 };

  it("결제 후 3일째 철회, 유료 혜택 안 씀 → 전액 19,900원", () => {
    expect(refundAmount({ ...base, usedDays: 3, rule: "withdrawal", usedPaidBenefit: false })).toBe(19_900);
  });

  it("결제 후 5일째 철회, 유료 혜택 씀 → 19,900 − ⌊19,900×5/30⌋(3,316) = 16,584원", () => {
    expect(refundAmount({ ...base, usedDays: 5, rule: "withdrawal", usedPaidBenefit: true })).toBe(16_584);
  });

  it("12일째 지금 해지 → 19,900 − 7,960(이용 12일) − ⌊11,940×10%⌋(1,194) = 10,746원", () => {
    expect(refundAmount({ ...base, usedDays: 12, rule: "immediate", usedPaidBenefit: true })).toBe(10_746);
    // 🔒 유료 혜택을 썼든 안 썼든 7일 뒤 지금 해지는 같은 계산
    expect(refundAmount({ ...base, usedDays: 12, rule: "immediate", usedPaidBenefit: false })).toBe(10_746);
  });

  it("12일째 다음 결제부터 해지 → 환불 없음(이용기간 끝까지 이용)", () => {
    expect(refundAmount({ ...base, usedDays: 12, rule: "period_end", usedPaidBenefit: false })).toBe(0);
  });

  it("위약금 없는 지금 해지(연결 끊김·혜택 대상 삭제) — 이용일수만 공제 = 11,940원", () => {
    expect(refundAmount({ ...base, usedDays: 12, rule: "no_penalty", usedPaidBenefit: true })).toBe(11_940);
  });

  it("공제액은 마지막에 한 번 내림 — 하루 요금(663.33원)을 먼저 내림하면 첫날 공제가 663원으로 같지만 5일째는 3,315원이 된다", () => {
    expect(refundAmount({ ...base, usedDays: 1, rule: "withdrawal", usedPaidBenefit: true })).toBe(19_900 - 663);
    expect(refundAmount({ ...base, usedDays: 5, rule: "withdrawal", usedPaidBenefit: true })).not.toBe(19_900 - 663 * 5);
  });

  it("기간을 다 쓰면 0원 — 음수가 되지 않는다", () => {
    expect(refundAmount({ ...base, usedDays: 30, rule: "immediate", usedPaidBenefit: true })).toBe(0);
  });
});

describe("결제 id — 회차마다 정해진 값(같은 id는 한 번만 결제된다)", () => {
  it("영숫자만, 40자 이내(cuid 25자 구독 id + 회차 + 재시도 접미사)", () => {
    const id = paymentIdFor("cmh0abcdefghijklmnopqrstu", 123, "r2");
    expect(id).toBe("scmh0abcdefghijklmnopqrstuc123r2");
    expect(id).toMatch(/^[a-z0-9]+$/);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(paymentIdFor("x", 1)).toBe(paymentIdFor("x", 1)); // 결정적
  });
});
