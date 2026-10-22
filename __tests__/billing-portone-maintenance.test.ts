/**
 * 포트원 정기결제 예약 작업(lib/billing/portone-maintenance) — 하루 1회 대사·만료·결제 3일 전 안내.
 *
 * 지키는 것:
 *   · 웹훅이 끝내 오지 않아도 결과를 반영한다(포트원 재조회). 예약이 아예 없으면 같은 paymentId로 지금 결제 — 두 번 돌아도 한 번만.
 *   · 포트원 예약이 아직 남아 있으면 따로 결제하지 않는다(포트원이 실행한다).
 *   · 빠진 예약을 다시 건다, 해지 기간이 끝나면 expired + 메일, 끝난 구독의 빌링키는 마저 지운다, 덜 된 환불은 이어서.
 *   · 첫 결제가 멈췄고 포트원에 결제가 없으면 실패 처리.
 *   · 결제 3일 전 안내는 회차마다 한 번 — 메일이 실패하면 다음 실행에 다시.
 *   · 한 구독이 실패해도 나머지는 계속, 실패가 있으면 운영 경보.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { db, pg, mail, fakeClient, runSchedule, startSubscription, subRow, ledger, kst, sendServiceEmailMock, Payment } from "./helpers/billing-portone-harness";

const maint = () => import("@/lib/billing/portone-maintenance");
const pid = async (subId: string, cycle: number, suffix = "") => (await import("@/lib/billing/portone-period")).paymentIdFor(subId, cycle, suffix);

let err: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(kst("2026-11-02T14:05:00"));
  err = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); err.mockRestore(); });

describe("찾기 — 상태가 어긋났을 수 있는 포트원 구독만", () => {
  it("멀쩡한 구독(예약 있음·결제 전)과 Play 구독은 고르지 않는다", async () => {
    await startSubscription();
    db.subscription.rows.push({ id: "play-1", provider: "play", status: "active", nextScheduleId: null, cancelAtPeriodEnd: false, updatedAt: new Date(0) });
    const { findSubscriptionsToReconcile } = await maint();
    expect(await findSubscriptionsToReconcile()).toEqual([]);
  });

  it("결제 예정 30분이 지났는데 결과 없음 · 예약 없음 · 해지 기간 끝남 · 끝났는데 빌링키 남음 · 첫 결제 멈춤", async () => {
    const s = await startSubscription();
    const { findSubscriptionsToReconcile } = await maint();
    vi.setSystemTime(kst("2026-12-02T10:29:00"));
    expect(await findSubscriptionsToReconcile()).toEqual([]);
    vi.setSystemTime(kst("2026-12-02T10:31:00"));
    expect(await findSubscriptionsToReconcile()).toEqual([s.subscriptionId]);
    const base = { provider: "portone", nextScheduleId: "x", cancelAtPeriodEnd: false, billingKeyEnc: null, updatedAt: new Date(0) };
    db.subscription.rows.push(
      { ...base, id: "no-schedule", status: "active", nextScheduleId: null, nextChargeAt: kst("2027-01-01T10:00:00") },
      { ...base, id: "lapsed", status: "canceled", expiresAt: kst("2026-12-01T10:00:00") },
      { ...base, id: "key-left", status: "expired", billingKeyEnc: "enc:v1:x" },
      { ...base, id: "stuck", status: "activating" },
      { ...base, id: "done", status: "expired" },
    );
    expect((await findSubscriptionsToReconcile()).sort()).toEqual(["key-left", "lapsed", "no-schedule", s.subscriptionId, "stuck"].sort());
  });
});

describe("대사 — 늦은 결과 반영, 빠진 일 마치기", () => {
  it("웹훅이 끝내 안 옴(예약 결제는 실행됨) → 다시 조회해 2회차 반영", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-12-02T10:00:10"));
    runSchedule(await pid(s.subscriptionId, 2), "paid");
    vi.setSystemTime(kst("2026-12-03T03:00:00"));
    const { reconcileSubscription } = await maint();
    expect(await reconcileSubscription(s.subscriptionId)).toBe("overdue_paid");
    expect(subRow(s.subscriptionId).cycleNo).toBe(2);
  });

  it("포트원에 예약도 결제도 없음(예약 생성이 유실) → 같은 paymentId로 지금 결제, 두 번 돌아도 결제 1번", async () => {
    const s = await startSubscription();
    pg.schedules.length = 0; // 예약이 포트원에 없다
    vi.setSystemTime(kst("2026-12-03T03:00:00"));
    const { reconcileSubscription } = await maint();
    expect(await reconcileSubscription(s.subscriptionId)).toBe("overdue_charged_paid");
    expect(await reconcileSubscription(s.subscriptionId)).not.toContain("charged");
    const renewal = await pid(s.subscriptionId, 2);
    expect(fakeClient.payment.payWithBillingKey.mock.calls.filter((c) => (c[0] as { paymentId: string }).paymentId === renewal)).toHaveLength(1);
    expect(subRow(s.subscriptionId).cycleNo).toBe(2);
  });

  it("포트원 예약이 아직 남아 있으면(실행 지연) 따로 결제하지 않는다 — 예약 상태를 조회해 확인한다", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-12-02T11:00:00"));
    const { reconcileSubscription } = await maint();
    expect(await reconcileSubscription(s.subscriptionId)).toBe("overdue_still_scheduled");
    expect(pg.payments.has(await pid(s.subscriptionId, 2))).toBe(false);
    expect(pg.log.some((l) => l.startsWith("pay:") && l.endsWith("c2"))).toBe(false);
  });

  it("포트원에서 취소된(REVOKED) 예약 — 결제하지 않고 다음 결제부터 해지로 + 운영 경보(전화 해지를 콘솔에서 처리한 경우 등)", async () => {
    const s = await startSubscription();
    const c2 = await pid(s.subscriptionId, 2);
    pg.schedules.find((x) => x.paymentId === c2)!.status = "REVOKED"; // 우리 DB는 모른다
    vi.setSystemTime(kst("2026-12-02T11:00:00"));
    pg.log.length = 0;
    const { reconcileSubscription } = await maint();
    expect(await reconcileSubscription(s.subscriptionId)).toBe("overdue_revoked_external");
    expect(pg.log.filter((l) => l.startsWith("pay:"))).toEqual([]); // 🔒 취소된 예약을 지금 결제로 되살리지 않는다
    expect(pg.schedules.some((x) => x.paymentId.endsWith("c3"))).toBe(false); // 다음 달 예약도 다시 걸지 않는다
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", cancelType: "revoked_external", nextChargeAt: null });
    expect(mail.ops.map((o) => o.subject)).toContain("[결제] 포트원에서 취소된 예약 — 결제하지 않고 해지로 처리");
  });

  it("지금 결제가 설정 오류(FORBIDDEN 등)로 거절되면 카드 실패로 보지 않는다 — 재시도·만료로 보내지 않고 오류 코드를 결제 내역에 싣지 않는다", async () => {
    const s = await startSubscription();
    pg.schedules.length = 0; // 예약 생성이 유실 — 지금 결제로 간다
    fakeClient.payment.payWithBillingKey.mockImplementationOnce(async () => {
      throw new Payment.PayWithBillingKeyError({ type: "FORBIDDEN", message: "FORBIDDEN" } as never);
    });
    vi.setSystemTime(kst("2026-12-03T03:00:00"));
    const { reconcileSubscription } = await maint();
    await expect(reconcileSubscription(s.subscriptionId)).rejects.toThrow(); // 예약 작업 실패로 센다(운영 경보)
    expect(ledger(await pid(s.subscriptionId, 2))).toMatchObject({ status: "scheduled", failureReason: null });
    expect(subRow(s.subscriptionId).status).toBe("active");
  });

  it("결제수단이 지워져 결제할 수 없음(BILLING_KEY_NOT_FOUND) → 재시도 흐름, 실패 사유는 사람이 읽는 말(오류 코드 아님)", async () => {
    const s = await startSubscription();
    pg.schedules.length = 0;
    pg.keys.get(s.billingKey)!.status = "DELETED";
    vi.setSystemTime(kst("2026-12-03T03:00:00"));
    const { reconcileSubscription } = await maint();
    await reconcileSubscription(s.subscriptionId);
    const reason = String(ledger(await pid(s.subscriptionId, 2)).failureReason);
    expect(reason).not.toMatch(/[A-Z]{3,}_[A-Z_]+/);
    expect(reason).toContain("결제수단");
    expect(subRow(s.subscriptionId).status).toBe("grace");
  });

  it("다음 회차 예약이 빠졌으면 다시 건다", async () => {
    fakeClient.payment.paymentSchedule.createPaymentSchedule.mockImplementationOnce(async () => { throw new Error("ECONNRESET"); });
    const s = await startSubscription();
    expect(subRow(s.subscriptionId).nextScheduleId).toBeNull();
    const { reconcileSubscription } = await maint();
    expect(await reconcileSubscription(s.subscriptionId)).toBe("schedule_scheduled");
    expect(pg.schedules.filter((x) => x.status === "SCHEDULED")).toHaveLength(1);
  });

  it("재시도 예약이 빠졌으면 다시 건다(grace)", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-12-02T10:00:30"));
    runSchedule(await pid(s.subscriptionId, 2), "failed");
    fakeClient.payment.paymentSchedule.createPaymentSchedule.mockImplementationOnce(async () => { throw new Error("ECONNRESET"); });
    await (await import("@/lib/billing/portone-sync")).syncPayment(await pid(s.subscriptionId, 2));
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "grace", nextScheduleId: null });
    const { reconcileSubscription } = await maint();
    expect(await reconcileSubscription(s.subscriptionId)).toBe("retry_scheduled");
    expect(pg.schedules.find((x) => x.paymentId.endsWith("r1"))?.status).toBe("SCHEDULED");
  });

  it("해지 기간이 끝남 → expired + 만료 메일, 아직이면 그대로", async () => {
    const s = await startSubscription();
    await (await import("@/lib/billing/portone-cancel")).cancelAtPeriodEnd(s.subscriptionId);
    const { reconcileSubscription } = await maint();
    expect(await reconcileSubscription(s.subscriptionId)).toBe("ok");
    expect(subRow(s.subscriptionId).status).toBe("canceled");
    vi.setSystemTime(kst("2026-12-02T10:00:01"));
    expect(await reconcileSubscription(s.subscriptionId)).toBe("expired");
    expect(subRow(s.subscriptionId).status).toBe("expired");
    expect(mail.sent.at(-1)?.text).toContain("해지하신 이용권의 이용 기간이 끝났습니다");
  });

  it("해지했는데 빌링키 정리가 실패했던 구독 → 예약 취소 → 빌링키 삭제를 마저 한다", async () => {
    const s = await startSubscription();
    pg.failRevokeWith = "FORBIDDEN";
    await (await import("@/lib/billing/portone-cancel")).cancelAtPeriodEnd(s.subscriptionId);
    expect(subRow(s.subscriptionId).billingKeyEnc).not.toBeNull();
    pg.log.length = 0;
    const { reconcileSubscription } = await maint();
    await reconcileSubscription(s.subscriptionId);
    expect(subRow(s.subscriptionId).billingKeyEnc).toBeNull();
    expect(pg.log.filter((l) => !l.startsWith("get:"))).toEqual([`revoke:${s.billingKey}`, `deleteKey:${s.billingKey}`]);
  });

  it("지금 해지의 환불이 실패했던 구독(revoked) → 같은 목표액까지 이어서 환불", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-11-13T09:00:00"));
    pg.failCancelWith = "PG_PROVIDER";
    await expect((await import("@/lib/billing/portone-cancel")).cancelNow(s.subscriptionId)).rejects.toThrow();
    const { findSubscriptionsToReconcile, reconcileSubscription } = await maint();
    expect(await findSubscriptionsToReconcile()).toContain(s.subscriptionId);
    expect(await reconcileSubscription(s.subscriptionId)).toBe("revocation_finished");
    expect(pg.payments.get(await pid(s.subscriptionId, 1))?.amount.cancelled).toBe(10_746);
    expect(subRow(s.subscriptionId).billingKeyEnc).toBeNull();
  });

  it("빌링키를 이미 지운 구독(다음 결제부터 해지 → 지금 해지)의 환불 실패도 찾아서 이어 간다(원장의 목표액)", async () => {
    const s = await startSubscription();
    const { cancelAtPeriodEnd, cancelNow } = await import("@/lib/billing/portone-cancel");
    await cancelAtPeriodEnd(s.subscriptionId); // 빌링키 삭제됨
    vi.setSystemTime(kst("2026-11-13T09:00:00"));
    pg.failCancelWith = "PG_PROVIDER";
    await expect(cancelNow(s.subscriptionId)).rejects.toThrow();
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "revoked", billingKeyEnc: null });
    const { findSubscriptionsToReconcile, reconcileSubscription } = await maint();
    expect(await findSubscriptionsToReconcile()).toEqual([s.subscriptionId]);
    await reconcileSubscription(s.subscriptionId);
    expect(pg.payments.get(await pid(s.subscriptionId, 1))?.amount.cancelled).toBe(10_746);
    expect(await findSubscriptionsToReconcile()).toEqual([]); // 다 돌려준 뒤에는 더 고르지 않는다
  });

  it("첫 결제가 멈췄고 포트원에 결제가 없음 → 실패 처리 + 빌링키 삭제", async () => {
    fakeClient.payment.payWithBillingKey.mockImplementationOnce(async () => new Promise(() => {})); // 응답이 오지 않는다
    void startSubscription(); // 결제 요청이 걸린 채 멈춘 activating(서버가 그 사이 죽은 것과 같다)
    await vi.waitFor(() => expect(db.subscription.rows[0]?.status).toBe("activating"));
    const id = db.subscription.rows[0].id as string;
    vi.setSystemTime(kst("2026-11-02T14:20:00"));
    const { reconcileSubscription } = await maint();
    expect(await reconcileSubscription(id)).toBe("first_failed");
    expect(subRow(id)).toMatchObject({ status: "failed", billingKeyEnc: null });
    expect(ledger(await pid(id, 1)).status).toBe("failed");
  });

  it("첫 결제를 요청하기 전에 서버가 멈춤(원장 행도 없음) → 결제가 없으니 실패 처리 + 빌링키 삭제(예전엔 activating에 영영 남아 재가입을 막았다)", async () => {
    db.billingPayment.upsert.mockImplementationOnce(async () => { throw new Error("함수 종료(시뮬레이션)"); });
    await startSubscription().catch(() => undefined);
    const sub = db.subscription.rows[0];
    expect(sub.status).toBe("activating");
    expect(db.billingPayment.rows).toHaveLength(0);
    vi.setSystemTime(kst("2026-11-02T14:20:00"));
    const { reconcileSubscription } = await maint();
    expect(await reconcileSubscription(sub.id as string)).toBe("first_failed");
    expect(subRow(sub.id as string)).toMatchObject({ status: "failed", billingKeyEnc: null });
  });
});

describe("멈춘 첫 결제 — 재가입이 예약 작업(하루 1회)을 기다리지 않는다", () => {
  it("10분 넘게 activating에 멈춘 시도는 같은 어르신의 새 발급 준비가 그 자리에서 정리한다(포트원에 결제가 없으면 실패 처리)", async () => {
    fakeClient.payment.payWithBillingKey.mockImplementationOnce(async () => new Promise(() => {})); // 응답이 오지 않는다
    void startSubscription();
    await vi.waitFor(() => expect(db.subscription.rows[0]?.status).toBe("activating"));
    const stuckId = db.subscription.rows[0].id as string;
    vi.setSystemTime(kst("2026-11-02T14:20:00"));
    const { createPendingSubscription } = await import("@/lib/billing/portone-activate");
    const { PLAN_DAY30, CONSENT } = await import("./helpers/billing-portone-harness");
    const again = await createPendingSubscription({ purchaserUserId: "guardian-1", beneficiaryUserId: "elder-1", plan: PLAN_DAY30, method: "CARD", consent: CONSENT });
    expect(again).toMatchObject({ ok: true });
    expect(subRow(stuckId).status).toBe("failed");
  });

  it("아직 10분이 안 됐으면 기다린다(결제가 진행 중일 수 있다) — duplicate", async () => {
    fakeClient.payment.payWithBillingKey.mockImplementationOnce(async () => new Promise(() => {}));
    void startSubscription();
    await vi.waitFor(() => expect(db.subscription.rows[0]?.status).toBe("activating"));
    vi.setSystemTime(kst("2026-11-02T14:10:00"));
    const { createPendingSubscription } = await import("@/lib/billing/portone-activate");
    const { PLAN_DAY30, CONSENT } = await import("./helpers/billing-portone-harness");
    expect(await createPendingSubscription({ purchaserUserId: "guardian-1", beneficiaryUserId: "elder-1", plan: PLAN_DAY30, method: "CARD", consent: CONSENT }))
      .toEqual({ ok: false, code: "duplicate" });
  });
});

describe("결제 완료 안내 — 자동결제마다 알려야 한다(전자상거래법 제8조③) · 못 보냈으면 예약 작업이 다시", () => {
  it("보내면 원장에 보낸 시각 · 일시 실패면 비워 두고 다음 예약 작업이 다시 보낸다 · 보낸 뒤에는 다시 보내지 않는다", async () => {
    sendServiceEmailMock.mockResolvedValueOnce("transient" as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = await startSubscription();
      const first = await pid(s.subscriptionId, 1);
      expect(ledger(first).paidMailAt).toBeNull();
      expect(mail.sent.filter((m) => m.subject.includes("결제 완료"))).toHaveLength(0);
      vi.setSystemTime(kst("2026-11-03T11:00:00"));
      const { runBillingMaintenance } = await maint();
      await runBillingMaintenance();
      expect(mail.sent.filter((m) => m.subject.includes("결제 완료"))).toHaveLength(1);
      expect(ledger(first).paidMailAt).toEqual(kst("2026-11-03T11:00:00"));
      await runBillingMaintenance();
      expect(mail.sent.filter((m) => m.subject.includes("결제 완료"))).toHaveLength(1);
    } finally { warn.mockRestore(); }
  });

  it("처음에 보냈으면 원장에 그 시각이 남는다(예약 작업이 다시 보내지 않는다)", async () => {
    const s = await startSubscription();
    expect(ledger(await pid(s.subscriptionId, 1)).paidMailAt).toEqual(kst("2026-11-02T14:05:00"));
  });
});

describe("결제 3일 전 안내 — 회차마다 한 번", () => {
  it("결제 3일 안으로 들어오면 한 통, 다시 돌아도 같은 회차는 보내지 않는다", async () => {
    const s = await startSubscription();
    const { sendRenewalNotices } = await maint();
    vi.setSystemTime(kst("2026-11-28T09:00:00")); // 4일 전
    expect(await sendRenewalNotices()).toBe(0);
    vi.setSystemTime(kst("2026-11-29T11:00:00")); // 3일 안
    expect(await sendRenewalNotices()).toBe(1);
    expect(await sendRenewalNotices()).toBe(0);
    expect(subRow(s.subscriptionId).renewalNoticeFor).toEqual(kst("2026-12-02T10:00:00"));
    expect(mail.sent.at(-1)?.subject).toBe("[마음이음] 2026-12-02 이용권 자동결제 예정 — 19,900원");
  });

  it("해지 예약된 구독에는 보내지 않는다", async () => {
    const s = await startSubscription();
    await (await import("@/lib/billing/portone-cancel")).cancelAtPeriodEnd(s.subscriptionId);
    vi.setSystemTime(kst("2026-11-30T09:00:00"));
    expect(await (await maint()).sendRenewalNotices()).toBe(0);
  });

  it("메일이 실패하면 표시하지 않는다 — 다음 실행에 다시 보낸다", async () => {
    const s = await startSubscription();
    vi.setSystemTime(kst("2026-11-30T09:00:00"));
    sendServiceEmailMock.mockResolvedValueOnce("transient" as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { sendRenewalNotices } = await maint();
      expect(await sendRenewalNotices()).toBe(0);
      expect(subRow(s.subscriptionId).renewalNoticeFor).toBeNull();
      expect(await sendRenewalNotices()).toBe(1);
    } finally { warn.mockRestore(); }
  });
});

describe("예약 작업 본체", () => {
  it("한 구독의 포트원 실패는 세고 계속 — 나머지는 정리, 실패가 있으면 운영 경보", async () => {
    const { cancelAtPeriodEnd } = await import("@/lib/billing/portone-cancel");
    const a = await startSubscription();
    const b = await startSubscription({ guardian: "guardian-2", elder: "elder-2" });
    // 둘 다 해지했지만 빌링키 정리가 실패해 남아 있는 상태
    pg.failRevokeWith = "FORBIDDEN";
    await cancelAtPeriodEnd(a.subscriptionId);
    vi.setSystemTime(kst("2026-11-02T14:06:00"));
    pg.failRevokeWith = "FORBIDDEN";
    await cancelAtPeriodEnd(b.subscriptionId);
    expect([subRow(a.subscriptionId).billingKeyEnc, subRow(b.subscriptionId).billingKeyEnc].every(Boolean)).toBe(true);
    // 예약 작업에서 첫 정리(먼저 바뀐 a)만 또 실패
    vi.setSystemTime(kst("2026-11-03T03:00:00"));
    pg.failRevokeWith = "FORBIDDEN";
    mail.ops.length = 0;
    const { runBillingMaintenance } = await maint();
    expect(await runBillingMaintenance()).toEqual({ checked: 2, failed: 1, notices: 0 });
    expect(subRow(a.subscriptionId).billingKeyEnc).not.toBeNull();
    expect(subRow(b.subscriptionId).billingKeyEnc).toBeNull();
    expect(mail.ops.map((o) => o.subject)).toContain("[결제] 예약 작업 대사 실패");
  });
});
