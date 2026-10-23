/**
 * 포트원 결제 상태 동기화(lib/billing/portone-sync) — 웹훅·복귀·예약 작업이 모두 거치는 syncPayment.
 *
 * 지키는 것:
 *   · 원장에 없는 결제는 무시(우리 결제가 아니다), 결제가 없으면 PAYMENT_NOT_FOUND를 던지지 않고 not_found.
 *   · 멱등 — 웹훅 재전송·중복 호출에 회차·메일이 두 번 반영되지 않는다.
 *   · 금액·빌링키·channel.type 중 하나라도 다르면 혜택을 주지 않는다(운영 경보).
 *   · 이중 결제 방어 — 같은 회차에 두 번째 결제, 해지 뒤 결제는 전액 취소한다.
 *   · 갱신: 결제일이 밀리지 않는다(재시도로 늦게 결제돼도 다음 결제는 원래 기준일).
 *   · 실패: 1일·3일 뒤 10:00 KST 재시도(grace — 혜택 유지) → 마지막 실패면 expired + 예약 취소 → 빌링키 삭제 + 메일.
 *   · 외부 전액 취소(콘솔 환불)면 혜택을 끊는다. 연결이 끊긴 구독에는 다음 회차를 걸지 않는다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { db, pg, mail, fakeClient, runSchedule, startSubscription, subRow, ledger, kst } from "./helpers/billing-portone-harness";

const sync = () => import("@/lib/billing/portone-sync");
const pid = async (subId: string, cycle: number, suffix = "") => (await import("@/lib/billing/portone-period")).paymentIdFor(subId, cycle, suffix);
const tier = async (userId: string) => (await (await import("@/lib/billing/entitlement")).getEntitlement(userId)).tier;

let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(kst("2026-11-02T14:05:00"));
  err = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); err.mockRestore(); });

/** 정기결제를 시작하고 첫 갱신 시각(12/2 10:00 KST)으로 시계를 옮긴다 */
async function atFirstRenewal() {
  const s = await startSubscription();
  vi.setSystemTime(kst("2026-12-02T10:00:30"));
  return { ...s, renewal: await pid(s.subscriptionId, 2) };
}

describe("우리 결제만, 결제가 없으면 조용히", () => {
  it("원장에 없는 paymentId는 무시하고 포트원을 부르지도 않는다", async () => {
    const { syncPayment } = await sync();
    expect(await syncPayment("someone-elses-payment")).toBe("ignored");
    expect(fakeClient.payment.getPayment).not.toHaveBeenCalled();
  });

  it("예약만 있고 아직 실행 전(포트원 PAYMENT_NOT_FOUND) → not_found, throw 없음", async () => {
    const s = await atFirstRenewal();
    const { syncPayment } = await sync();
    expect(await syncPayment(s.renewal)).toBe("not_found");
    expect(ledger(s.renewal).status).toBe("scheduled");
  });
});

describe("갱신 결제 — 회차·만료·다음 예약, 멱등", () => {
  it("예약 결제 성공 → 2회차, 만료 1/2 10:00 KST, 3회차 예약, 결제 완료 메일", async () => {
    const s = await atFirstRenewal();
    runSchedule(s.renewal, "paid");
    const { syncPayment } = await sync();
    expect(await syncPayment(s.renewal)).toBe("paid");
    const sub = subRow(s.subscriptionId);
    expect(sub).toMatchObject({ status: "active", cycleNo: 2 });
    expect(sub.expiresAt).toEqual(kst("2027-01-02T10:00:00"));
    expect(ledger(s.renewal)).toMatchObject({ status: "paid", periodStart: kst("2026-12-02T10:00:00"), periodEnd: kst("2027-01-02T10:00:00") });
    expect(pg.schedules.at(-1)).toMatchObject({ paymentId: await pid(s.subscriptionId, 3), status: "SCHEDULED" });
    expect(mail.sent.filter((m) => m.subject.includes("결제 완료"))).toHaveLength(2);
  });

  it("같은 결제를 다시 동기화(웹훅 재전송) → unchanged, 회차·메일·예약이 늘지 않는다", async () => {
    const s = await atFirstRenewal();
    runSchedule(s.renewal, "paid");
    const { syncPayment } = await sync();
    await syncPayment(s.renewal);
    const mails = mail.sent.length;
    const schedules = pg.schedules.length;
    expect(await syncPayment(s.renewal)).toBe("unchanged");
    expect(await syncPayment(s.renewal)).toBe("unchanged");
    expect(subRow(s.subscriptionId).cycleNo).toBe(2);
    expect(mail.sent).toHaveLength(mails);
    expect(pg.schedules).toHaveLength(schedules);
  });

  it("웹훅과 예약 작업이 **동시에** 같은 결제를 반영해도 한 번 — 조건부 갱신(paid가 아닐 때만)", async () => {
    const s = await atFirstRenewal();
    runSchedule(s.renewal, "paid");
    const { syncPayment } = await sync();
    const results = await Promise.all([syncPayment(s.renewal), syncPayment(s.renewal)]);
    expect(results.sort()).toEqual(["paid", "unchanged"]);
    expect(mail.sent.filter((m) => m.subject.includes("결제 완료"))).toHaveLength(2); // 첫 결제 1 + 갱신 1
  });

  it("다음 회차 예약은 멱등 — 두 번 걸어도 포트원 예약은 하나(PAYMENT_SCHEDULE_ALREADY_EXISTS는 성공)", async () => {
    const s = await startSubscription();
    const { ensureNextSchedule } = await sync();
    db.subscription.rows[0].nextScheduleId = null;
    expect(await ensureNextSchedule(s.subscriptionId)).toBe("exists");
    expect(pg.schedules.filter((x) => x.status === "SCHEDULED")).toHaveLength(1);
    expect(subRow(s.subscriptionId).nextScheduleId).toBe(await pid(s.subscriptionId, 2)); // '예약 있음' 표시
  });

  it("다음 회차 예약이 실패해도 결제 확정은 유지된다 — 예약 작업이 다시 건다(nextScheduleId 없음)", async () => {
    fakeClient.payment.paymentSchedule.createPaymentSchedule.mockImplementationOnce(async () => { throw new Error("ECONNRESET"); });
    const s = await startSubscription();
    expect(s.result).toMatchObject({ ok: true, status: "active" });
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "active", nextScheduleId: null });
  });
});

describe("결제 확인 대조 — 하나라도 다르면 혜택 없음", () => {
  async function paidWith(over: Partial<{ total: number; billingKey: string; channelType: string; currency: string }>) {
    const s = await atFirstRenewal();
    const p = runSchedule(s.renewal, "paid");
    if (over.total !== undefined) p.amount.total = over.total;
    if (over.billingKey !== undefined) p.billingKey = over.billingKey;
    if (over.channelType !== undefined) p.channel.type = over.channelType;
    if (over.currency !== undefined) p.currency = over.currency;
    const { syncPayment } = await sync();
    return { s, r: await syncPayment(s.renewal) };
  }

  it.each([
    ["금액", { total: 1_990 }],
    ["빌링키", { billingKey: "someone-elses-key" }],
    ["채널(test 모드에 LIVE 결제)", { channelType: "LIVE" }],
    ["통화", { currency: "USD" }],
  ])("%s 불일치 → mismatch, 회차·만료 그대로, 운영 경보", async (_l, over) => {
    const { s, r } = await paidWith(over);
    expect(r).toBe("mismatch");
    expect(subRow(s.subscriptionId)).toMatchObject({ cycleNo: 1, expiresAt: kst("2026-12-02T10:00:00") });
    expect(ledger(s.renewal).status).toBe("scheduled");
    expect(mail.ops.map((o) => o.subject)).toContain("[결제] 결제 확인 불일치 — 혜택 보류");
    // 🔒 결제 쪽 운영 경보는 결제 안내 메일 계정으로 — 위급 메일 계정의 하루 발신 한도를 쓰지 않는다(lib/notify/email)
    expect(mail.ops.map((o) => o.via)).toEqual(mail.ops.map(() => "service"));
  });
});

describe("돌려주기 시작한 결제 — 포트원이 아직 PAID로 보여도(결제사가 취소 처리 중) 새 결제로 반영하지 않는다", () => {
  it.each([
    ["목표액이 정해진 행(취소 요청 중)", { refundTargetKrw: 19_900 }],
    ["부분 취소로 적힌 행", { status: "partial_cancelled", cancelledKrw: 5_000 }],
  ])("%s → unchanged, 회차·메일이 늘지 않는다", async (_n, over) => {
    const s = await atFirstRenewal();
    runSchedule(s.renewal, "paid");
    Object.assign(ledger(s.renewal), over);
    const mails = mail.sent.length;
    const { syncPayment } = await sync();
    expect(await syncPayment(s.renewal)).toBe("unchanged");
    expect(subRow(s.subscriptionId).cycleNo).toBe(1);
    expect(mail.sent).toHaveLength(mails);
  });
});

describe("운영 전환(live) 뒤 남은 시험 구독 — 매일 같은 불일치 경보로 남기지 않는다", () => {
  it("시험 채널로 가입한 구독의 갱신(시험 결제)이 live 모드에서 들어오면 → 혜택 없이 결제 취소 + 구독 종료(예약 취소·빌링키 삭제)", async () => {
    const s = await atFirstRenewal(); // 시험 모드에서 가입(채널 TEST)
    process.env.PORTONE_MODE = "live"; // 실연동 전환
    runSchedule(s.renewal, "paid"); // 남아 있던 시험 예약이 실행됨(시험 결제)
    const { syncPayment } = await sync();
    expect(await syncPayment(s.renewal)).toBe("refunded");
    expect(pg.payments.get(s.renewal)?.status).toBe("CANCELLED");
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "expired", cancelType: "test_mode_ended", billingKeyEnc: null, cycleNo: 1 });
    expect(pg.keys.get(s.billingKey)?.status).toBe("DELETED");
    // 다음 날 예약 작업이 같은 결제를 다시 '불일치'로 붙들지 않는다
    mail.ops.length = 0;
    vi.setSystemTime(kst("2026-12-03T11:00:00"));
    await (await import("@/lib/billing/portone-maintenance")).runBillingMaintenance();
    expect(mail.ops.map((o) => o.subject)).not.toContain("[결제] 결제 확인 불일치 — 혜택 보류");
  });
});

describe("이중 결제 방어 — 받지 말아야 할 결제는 전액 취소", () => {
  it("같은 회차에 다른 결제가 또 PAID → 나중 것을 전액 취소, 혜택은 한 번만", async () => {
    const s = await startSubscription();
    const { syncPayment } = await sync();
    const dup = `${await pid(s.subscriptionId, 1)}x`;
    const first = ledger(await pid(s.subscriptionId, 1));
    db.billingPayment.rows.push({ ...first, paymentId: dup, status: "requested", paidAt: null });
    pg.payments.set(dup, { ...structuredClone(pg.payments.get(await pid(s.subscriptionId, 1))!), id: dup });
    expect(await syncPayment(dup)).toBe("refunded");
    expect(pg.payments.get(dup)?.status).toBe("CANCELLED");
    expect(ledger(dup)).toMatchObject({ status: "cancelled", cancelledKrw: 19_900 });
    expect(subRow(s.subscriptionId).cycleNo).toBe(1);
    expect(mail.ops.map((o) => o.subject)).toContain("[결제] 받지 말아야 할 결제를 전액 취소");
    expect(mail.sent.at(-1)?.subject).toContain("환불");
  });

  it("해지(다음 결제부터) 뒤에 들어온 갱신 결제(예약 취소와 실행이 겹침) → 전액 취소", async () => {
    const s = await atFirstRenewal();
    const p = runSchedule(s.renewal, "paid"); // 포트원은 이미 실행했다
    db.subscription.rows[0].status = "canceled";
    db.subscription.rows[0].cancelAtPeriodEnd = true;
    const { syncPayment } = await sync();
    expect(await syncPayment(s.renewal)).toBe("refunded");
    expect(p.status).toBe("CANCELLED");
    expect(subRow(s.subscriptionId).cycleNo).toBe(1);
  });

  it("구독 기록이 사라진 뒤(계정 삭제) 들어온 결제 → 전액 취소", async () => {
    const s = await atFirstRenewal();
    const p = runSchedule(s.renewal, "paid");
    db.subscription.rows.length = 0; // Cascade 삭제
    const { syncPayment } = await sync();
    expect(await syncPayment(s.renewal)).toBe("refunded");
    expect(p.status).toBe("CANCELLED");
  });
});

describe("결제 실패 — 1일·3일 뒤 10:00 KST 재시도(혜택 유지) → 마지막 실패면 만료", () => {
  it("갱신 실패 → grace, 12/3 10:00 재시도 예약, 혜택 유지(만료 = 재시도 + 하루), 실패 메일", async () => {
    const s = await atFirstRenewal();
    runSchedule(s.renewal, "failed");
    const { syncPayment } = await sync();
    expect(await syncPayment(s.renewal)).toBe("retry_scheduled");
    const sub = subRow(s.subscriptionId);
    expect(sub).toMatchObject({ status: "grace", failedChargeCount: 1, nextChargeAt: kst("2026-12-03T10:00:00") });
    expect(sub.expiresAt).toEqual(kst("2026-12-04T10:00:00"));
    const r1 = await pid(s.subscriptionId, 2, "r1");
    expect(ledger(r1)).toMatchObject({ kind: "retry", attempt: 1, status: "scheduled", scheduledAt: kst("2026-12-03T10:00:00") });
    expect(pg.schedules.find((x) => x.paymentId === r1)).toMatchObject({ status: "SCHEDULED", timeToPay: kst("2026-12-03T10:00:00").toISOString() });
    expect(await tier(s.elder)).toBe("pro");
    expect(mail.sent.at(-1)?.text).toContain("2026-12-03 10:00");
  });

  it("2차는 12/5 10:00, 마지막 실패 → expired, 예약 취소 → 빌링키 삭제(이 순서), 만료 메일, 혜택 끝", async () => {
    const s = await atFirstRenewal();
    const { syncPayment } = await sync();
    runSchedule(s.renewal, "failed"); await syncPayment(s.renewal);
    vi.setSystemTime(kst("2026-12-03T10:00:30"));
    const r1 = await pid(s.subscriptionId, 2, "r1");
    runSchedule(r1, "failed");
    expect(await syncPayment(r1)).toBe("retry_scheduled");
    expect(subRow(s.subscriptionId).nextChargeAt).toEqual(kst("2026-12-05T10:00:00"));
    vi.setSystemTime(kst("2026-12-05T10:00:30"));
    const r2 = await pid(s.subscriptionId, 2, "r2");
    runSchedule(r2, "failed");
    pg.log.length = 0;
    expect(await syncPayment(r2)).toBe("expired");
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "expired", cancelType: "payment_failed", billingKeyEnc: null, nextChargeAt: null });
    const revokeAt = pg.log.findIndex((l) => l.startsWith("revoke:"));
    const deleteAt = pg.log.findIndex((l) => l.startsWith("deleteKey:"));
    expect(revokeAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(revokeAt); // 🔒 예약이 남은 빌링키는 지울 수 없다
    expect(pg.keys.get(s.billingKey)?.status).toBe("DELETED");
    expect(mail.sent.at(-1)?.subject).toBe("[마음이음] 이용권이 끝났어요");
    expect(await tier(s.elder)).toBe("free");
  });

  it("재시도 성공 → active, 실패 횟수 0, 다음 결제는 원래 기준일(1/2) — 재시도한 날(12/3)로 밀리지 않는다", async () => {
    const s = await atFirstRenewal();
    const { syncPayment } = await sync();
    runSchedule(s.renewal, "failed"); await syncPayment(s.renewal);
    vi.setSystemTime(kst("2026-12-03T10:00:30"));
    const r1 = await pid(s.subscriptionId, 2, "r1");
    runSchedule(r1, "paid");
    expect(await syncPayment(r1)).toBe("paid");
    const sub = subRow(s.subscriptionId);
    expect(sub).toMatchObject({ status: "active", cycleNo: 2, failedChargeCount: 0 });
    expect(sub.expiresAt).toEqual(kst("2027-01-02T10:00:00"));
  });

  it("실패 웹훅 재전송 → unchanged(재시도를 두 번 예약하지 않는다)", async () => {
    const s = await atFirstRenewal();
    runSchedule(s.renewal, "failed");
    const { syncPayment } = await sync();
    await syncPayment(s.renewal);
    expect(await syncPayment(s.renewal)).toBe("unchanged");
    expect(pg.schedules.filter((x) => x.paymentId.endsWith("r1"))).toHaveLength(1);
  });

  it("해지한 구독의 실패는 다시 시도하지 않는다", async () => {
    const s = await atFirstRenewal();
    runSchedule(s.renewal, "failed");
    db.subscription.rows[0].cancelAtPeriodEnd = true;
    const { syncPayment } = await sync();
    expect(await syncPayment(s.renewal)).toBe("failed");
    expect(pg.schedules.some((x) => x.paymentId.endsWith("r1"))).toBe(false);
  });
});

describe("취소(환불) 반영", () => {
  it("우리가 시작하지 않은 전액 취소(콘솔 환불) → 혜택 즉시 종료(revoked), 예약 취소·빌링키 삭제, 환불 메일", async () => {
    const s = await startSubscription();
    const first = await pid(s.subscriptionId, 1);
    const p = pg.payments.get(first)!;
    p.status = "CANCELLED"; p.amount.cancelled = p.amount.total;
    const { syncPayment } = await sync();
    expect(await syncPayment(first)).toBe("cancelled");
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "revoked", cancelType: "refunded", billingKeyEnc: null });
    expect(pg.keys.get(s.billingKey)?.status).toBe("DELETED");
    expect(await tier(s.elder)).toBe("free");
    expect(mail.sent.at(-1)?.subject).toBe("[마음이음] 이용권 환불 — 19,900원");
  });

  it("부분 취소는 원장만 바꾼다 — 혜택은 그대로", async () => {
    const s = await startSubscription();
    const first = await pid(s.subscriptionId, 1);
    const p = pg.payments.get(first)!;
    p.status = "PARTIAL_CANCELLED"; p.amount.cancelled = 5_000;
    const { syncPayment } = await sync();
    expect(await syncPayment(first)).toBe("cancelled");
    expect(ledger(first)).toMatchObject({ status: "partial_cancelled", cancelledKrw: 5_000 });
    expect(subRow(s.subscriptionId).status).toBe("active");
    expect(await syncPayment(first)).toBe("unchanged");
  });
});

describe("연결이 끊긴 구독 — 다음 회차를 걸지 않는다", () => {
  it("갱신 결제 뒤 연결이 끊겨 있으면 다음 결제부터 해지(link_gone) + 빌링키 삭제 + 안내 메일", async () => {
    const s = await atFirstRenewal();
    db.expertPatient.rows[0].status = "revoked";
    runSchedule(s.renewal, "paid");
    const { syncPayment } = await sync();
    expect(await syncPayment(s.renewal)).toBe("paid"); // 이미 낸 이번 회차는 만료일까지
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", cancelType: "link_gone", nextChargeAt: null, billingKeyEnc: null });
    expect(subRow(s.subscriptionId).expiresAt).toEqual(kst("2027-01-02T10:00:00"));
    const third = await pid(s.subscriptionId, 3);
    expect(pg.schedules.find((x) => x.paymentId === third)).toBeUndefined();
    expect(mail.sent.at(-1)?.text).toContain("위약금 없이 지금 해지");
  });
});
