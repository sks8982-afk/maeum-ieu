/**
 * 포트원 정기결제 시작(lib/billing/portone-activate) — 발급 준비 → 빌링키 확정 → 첫 결제 → 다음 회차 예약.
 *
 * 지키는 것:
 *   · 브라우저가 보낸 빌링키를 믿지 않는다 — 포트원에서 다시 조회해 발급 완료·issueId·상점·채널(test/live)을 대조한다.
 *   · 결제는 한 번만 — 브라우저 복귀와 BillingKey.Issued 웹훅이 둘 다 와도(조건부 pending → activating).
 *   · 어르신 1명당 살아 있는 이용권 하나 — 발급 준비에서, 결제 직전에, 동시 확정은 DB 부분 유일 인덱스(P2002)로.
 *   · 첫 결제 실패 → 구독 없음(failed) + 빌링키 삭제 + PG 메시지 그대로(네이버페이 조건).
 *   · 빌링키는 암호문으로만 저장한다(키가 없으면 결제를 시작하지 않는다).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  db, pg, mail, fakeClient, issueKey, seedFamily, startSubscription, subRow, ledger, kst, PLAN_DAY30, CONSENT,
} from "./helpers/billing-portone-harness";

const load = () => import("@/lib/billing/portone-activate");
const period = () => import("@/lib/billing/portone-period");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(kst("2026-11-02T14:05:00"));
});
afterEach(() => vi.useRealTimers());

async function pendingOnly(opts: { guardian?: string; elder?: string; seed?: boolean } = {}) {
  const { createPendingSubscription } = await load();
  const guardian = opts.guardian ?? "guardian-1";
  const elder = opts.elder ?? "elder-1";
  if (opts.seed !== false) seedFamily({ guardian, elder });
  const r = await createPendingSubscription({ purchaserUserId: guardian, beneficiaryUserId: elder, plan: PLAN_DAY30, method: "CARD", consent: CONSENT });
  if (!r.ok) throw new Error(r.code);
  return { ...r, guardian, elder };
}

describe("정상 흐름 — 첫 결제 후 혜택·다음 회차 예약·결제 완료 메일", () => {
  it("active · 1회차 · 기준일·만료(=다음 결제) · 가입 당시 금액·한도 · 빌링키 암호문", async () => {
    const s = await startSubscription();
    expect(s.result).toEqual({ ok: true, subscriptionId: s.subscriptionId, status: "active" });
    const sub = subRow(s.subscriptionId);
    expect(sub).toMatchObject({ status: "active", provider: "portone", cycleNo: 1, anchorDay: 2, priceKrw: 19_900, dailyTurnLimit: 30, payMethod: "CARD" });
    expect(sub.expiresAt).toEqual(kst("2026-12-02T10:00:00"));
    expect(sub.nextChargeAt).toEqual(kst("2026-12-02T10:00:00"));
    // 🔒 빌링키 원문이 DB에 남지 않는다
    expect(sub.billingKeyEnc).toMatch(/^enc:v1:/);
    expect(JSON.stringify(db.subscription.rows)).not.toContain(s.billingKey);
    expect(JSON.stringify(db.billingPayment.rows)).not.toContain(s.billingKey);
  });

  it("원장 — 첫 결제 paid(이용기간 결제 시각 ~ 다음 결제), 다음 회차 scheduled + 포트원 예약(같은 금액·시각)", async () => {
    const s = await startSubscription();
    const { paymentIdFor } = await period();
    expect(ledger(paymentIdFor(s.subscriptionId, 1))).toMatchObject({
      kind: "first", status: "paid", amountKrw: 19_900, periodStart: kst("2026-11-02T14:05:00"), periodEnd: kst("2026-12-02T10:00:00"),
    });
    expect(ledger(paymentIdFor(s.subscriptionId, 2))).toMatchObject({ kind: "renewal", status: "scheduled", scheduledAt: kst("2026-12-02T10:00:00") });
    expect(pg.schedules).toEqual([expect.objectContaining({
      paymentId: paymentIdFor(s.subscriptionId, 2), amount: 19_900, timeToPay: kst("2026-12-02T10:00:00").toISOString(), status: "SCHEDULED",
    })]);
    expect(subRow(s.subscriptionId).nextScheduleId).toBe("sch_1");
  });

  it("동의 기록 — 항목·문구 버전·결제회원, 구독과 연결", async () => {
    const s = await startSubscription();
    expect(db.billingConsent.rows).toEqual([expect.objectContaining({
      userId: "guardian-1", subscriptionId: s.subscriptionId, termsVersion: "2026-10-22", items: CONSENT.items,
    })]);
  });

  it("동의할 때 안내한 조건(요금제·금액·한도·무료 한도·결제수단·혜택 받는 분)과 가입 당시 무료 한도를 남긴다 — 구독 기록이 지워져도 계약 내용이 남게", async () => {
    const s = await startSubscription();
    expect(db.billingConsent.rows[0].offer).toEqual({
      planId: "day30", priceKrw: 19_900, dailyTurnLimit: 30, freeDailyTurnLimit: 10, payMethod: "CARD", beneficiaryUserId: "elder-1",
    });
    expect(subRow(s.subscriptionId).freeTurnLimit).toBe(10);
  });

  it("결제회원 한 명의 발급 준비는 하루 5번까지 — 6번째는 too_many_attempts(결제·철회를 되풀이해 메일을 쏟거나 시도 기록을 쌓지 못하게)", async () => {
    seedFamily();
    const { createPendingSubscription } = await load();
    const input = { purchaserUserId: "guardian-1", beneficiaryUserId: "elder-1", plan: PLAN_DAY30, method: "CARD" as const, consent: CONSENT };
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(new Date(kst("2026-11-02T14:05:00").getTime() + i * 60_000));
      expect((await createPendingSubscription(input)).ok, `${i + 1}번째`).toBe(true);
    }
    expect(await createPendingSubscription(input)).toEqual({ ok: false, code: "too_many_attempts" });
    expect(db.subscription.rows).toHaveLength(5);
    expect(db.billingConsent.rows).toHaveLength(5);
    vi.setSystemTime(kst("2026-11-03T14:06:00")); // 24시간이 지나면 다시
    expect((await createPendingSubscription(input)).ok).toBe(true);
  });

  it("동의 기록 없이는 발급 준비를 하지 않는다(문구 버전·항목이 비면 consent_required)", async () => {
    seedFamily();
    const { createPendingSubscription } = await load();
    const base = { purchaserUserId: "guardian-1", beneficiaryUserId: "elder-1", plan: PLAN_DAY30, method: "CARD" as const };
    expect(await createPendingSubscription({ ...base, consent: { termsVersion: "", items: CONSENT.items } })).toEqual({ ok: false, code: "consent_required" });
    expect(await createPendingSubscription({ ...base, consent: { termsVersion: "2026-10-22", items: [] } })).toEqual({ ok: false, code: "consent_required" });
    expect(db.subscription.rows).toHaveLength(0);
  });

  it("결제 완료 메일 — 결제회원에게, 금액·일시·수단·혜택 대상·다음 결제·영수증·관리 링크", async () => {
    await startSubscription();
    expect(mail.sent).toHaveLength(1);
    const m = mail.sent[0];
    expect(m.to).toBe("guardian-1@example.com");
    expect(m.subject).toContain("19,900원");
    for (const s of ["김영자", "2026-11-02 14:05", "카드", "2026-11-02 ~ 2026-12-01", "2026-12-02 19,900원", "https://receipt.example.com/",
      "https://maeum.example.com/subscribe", "위급 상황 감지와 보호자 알림은 결제와 관계없이"]) {
      expect(m.text, s).toContain(s);
    }
  });

  it("두 번째 호출(브라우저 복귀 + 웹훅)은 결제하지 않고 지금 상태만 — 결제 1번", async () => {
    const s = await startSubscription();
    const { activateByBillingKey } = await load();
    expect(await activateByBillingKey(s.billingKey)).toEqual({ ok: true, subscriptionId: s.subscriptionId, status: "active" });
    expect(fakeClient.payment.payWithBillingKey).toHaveBeenCalledTimes(1);
    expect(mail.sent).toHaveLength(1);
  });

  it("브라우저 복귀와 웹훅이 **동시에** 와도 결제 1번 — pending → activating 조건부 전환", async () => {
    const p = await pendingOnly();
    issueKey("bk-1", p.issueId);
    const { activateByBillingKey } = await load();
    const [a, b] = await Promise.all([activateByBillingKey("bk-1", { issueId: p.issueId }), activateByBillingKey("bk-1")]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(fakeClient.payment.payWithBillingKey).toHaveBeenCalledTimes(1);
    expect(subRow(p.subscriptionId).status).toBe("active");
  });
});

describe("빌링키 대조 — 하나라도 다르면 결제하지 않는다", () => {
  async function tryWith(setup: (p: Awaited<ReturnType<typeof pendingOnly>>) => { key: string; issueId?: string; purchaser?: string }) {
    const p = await pendingOnly();
    const { key, issueId, purchaser } = setup(p);
    const { activateByBillingKey } = await load();
    const r = await activateByBillingKey(key, { issueId, purchaserUserId: purchaser });
    return { r, p };
  }

  it("test 모드인데 실연동(LIVE) 채널 빌링키 → 거절", async () => {
    const { r, p } = await tryWith((p) => { issueKey("bk-live", p.issueId, "LIVE"); return { key: "bk-live", issueId: p.issueId }; });
    expect(r).toEqual({ ok: false, code: "invalid_billing_key" });
    expect(subRow(p.subscriptionId).status).toBe("pending");
    expect(fakeClient.payment.payWithBillingKey).not.toHaveBeenCalled();
  });

  it("live 모드인데 테스트(TEST) 채널 빌링키 → 거절 — 테스트 결제로 실서비스 혜택을 주지 않는다", async () => {
    process.env.PORTONE_MODE = "live";
    const { r } = await tryWith((p) => { issueKey("bk-test", p.issueId, "TEST"); return { key: "bk-test", issueId: p.issueId }; });
    expect(r).toEqual({ ok: false, code: "invalid_billing_key" });
    expect(fakeClient.payment.payWithBillingKey).not.toHaveBeenCalled();
  });

  it("브라우저가 보낸 issueId가 포트원 값과 다름 → 거절", async () => {
    const { r } = await tryWith((p) => { issueKey("bk-1", p.issueId); return { key: "bk-1", issueId: "bkdifferent" }; });
    expect(r).toEqual({ ok: false, code: "invalid_billing_key" });
  });

  it("다른 상점의 빌링키 → 거절", async () => {
    const { r } = await tryWith((p) => { issueKey("bk-1", p.issueId, "TEST", "store-other"); return { key: "bk-1", issueId: p.issueId }; });
    expect(r).toEqual({ ok: false, code: "invalid_billing_key" });
  });

  it("삭제된·없는 빌링키 → 거절", async () => {
    const del = await tryWith((p) => { issueKey("bk-1", p.issueId); pg.keys.get("bk-1")!.status = "DELETED"; return { key: "bk-1" }; });
    expect(del.r).toEqual({ ok: false, code: "invalid_billing_key" });
    const missing = await tryWith(() => ({ key: "bk-nowhere" }));
    expect(missing.r).toEqual({ ok: false, code: "invalid_billing_key" });
  });

  it("다른 사람이 남의 결제를 확정하려 함 → forbidden, 결제 없음", async () => {
    const { r } = await tryWith((p) => { issueKey("bk-1", p.issueId); return { key: "bk-1", issueId: p.issueId, purchaser: "intruder" }; });
    expect(r).toEqual({ ok: false, code: "forbidden" });
    expect(fakeClient.payment.payWithBillingKey).not.toHaveBeenCalled();
  });
});

describe("결제를 시작하지 않는 경우 — 시도는 failed, 받은 빌링키는 삭제", () => {
  it("발급 준비 뒤 1시간이 지나서 온 빌링키 → expired", async () => {
    const p = await pendingOnly();
    issueKey("bk-1", p.issueId);
    vi.setSystemTime(kst("2026-11-02T15:06:00"));
    const { activateByBillingKey } = await load();
    expect(await activateByBillingKey("bk-1")).toEqual({ ok: false, code: "expired" });
    expect(subRow(p.subscriptionId)).toMatchObject({ status: "failed", cancelType: "expired" });
    expect(pg.keys.get("bk-1")?.status).toBe("DELETED");
    expect(fakeClient.payment.payWithBillingKey).not.toHaveBeenCalled();
    // 같은 시도를 다시 확정하려 하면(새로고침·늦은 웹훅) 같은 이유를 돌려준다 — 빌링키가 이미 지워져 포트원 조회부터 실패하지 않게 키를 되살려 본다
    pg.keys.get("bk-1")!.status = "ISSUED";
    expect(await activateByBillingKey("bk-1")).toEqual({ ok: false, code: "expired" });
  });

  it("발급 준비와 결제 사이에 보호자·어르신 연결이 끊김 → not_linked", async () => {
    const p = await pendingOnly();
    db.expertPatient.rows[0].status = "revoked";
    issueKey("bk-1", p.issueId);
    const { activateByBillingKey } = await load();
    expect(await activateByBillingKey("bk-1", { issueId: p.issueId })).toEqual({ ok: false, code: "not_linked" });
    expect(fakeClient.payment.payWithBillingKey).not.toHaveBeenCalled();
  });

  it("ENCRYPTION_KEY가 없으면(빌링키가 평문이 된다) 결제하지 않는다 → config", async () => {
    const p = await pendingOnly();
    issueKey("bk-1", p.issueId);
    delete process.env.ENCRYPTION_KEY;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { activateByBillingKey } = await load();
      expect(await activateByBillingKey("bk-1")).toEqual({ ok: false, code: "config" });
      expect(subRow(p.subscriptionId).billingKeyEnc).toBeNull();
      expect(fakeClient.payment.payWithBillingKey).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
      process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    }
  });
});

describe("이중 결제 방어 — 어르신 1명당 살아 있는 이용권 하나", () => {
  it("이미 이용권이 있으면 발급 준비부터 거절(duplicate)", async () => {
    await startSubscription();
    const { createPendingSubscription } = await load();
    const again = await createPendingSubscription({ purchaserUserId: "guardian-1", beneficiaryUserId: "elder-1", plan: PLAN_DAY30, method: "CARD", consent: CONSENT });
    expect(again).toEqual({ ok: false, code: "duplicate" });
  });

  it("Play 구독이 살아 있어도 거절 — 같은 혜택에 두 번 결제하지 않게", async () => {
    seedFamily();
    db.subscription.rows.push({ id: "play-1", purchaserUserId: "guardian-2", beneficiaryUserId: "elder-1", productId: "maeum_pro", purchaseToken: "play-token",
      status: "active", provider: "play", expiresAt: kst("2026-12-01T00:00:00"), revokedAt: null });
    const { hasLiveSubscription } = await load();
    expect(await hasLiveSubscription("elder-1")).toBe(true);
  });

  it("발급 준비를 두 번 통과한 두 시도 — 먼저 확정한 것만 결제, 나중 것은 결제 직전에 막는다", async () => {
    const a = await pendingOnly();
    const b = await pendingOnly({ seed: false });
    issueKey("bk-a", a.issueId); issueKey("bk-b", b.issueId);
    const { activateByBillingKey } = await load();
    expect((await activateByBillingKey("bk-a")).ok).toBe(true);
    expect(await activateByBillingKey("bk-b")).toEqual({ ok: false, code: "duplicate" });
    expect(subRow(b.subscriptionId)).toMatchObject({ status: "failed", cancelType: "duplicate" });
    expect(pg.keys.get("bk-b")?.status).toBe("DELETED");
    expect(fakeClient.payment.payWithBillingKey).toHaveBeenCalledTimes(1);
    // 🔒 결제 직전 확인에서 막혔다 — activating 전환(DB 인덱스에 기대는 마지막 방어선)까지 가지 않았다
    const claims = db.subscription.updateMany.mock.calls.filter(([a]) => a.data.status === "activating");
    expect(claims.map(([a]) => a.where?.id)).not.toContain(b.subscriptionId);
  });

  it("동시에 확정돼 결제 직전 확인을 둘 다 통과해도 DB 부분 유일 인덱스(P2002)가 막는다", async () => {
    const a = await pendingOnly();
    const b = await pendingOnly({ seed: false });
    issueKey("bk-a", a.issueId); issueKey("bk-b", b.issueId);
    const { activateByBillingKey } = await load();
    expect((await activateByBillingKey("bk-a")).ok).toBe(true);
    // 결제 직전 확인(hasLiveSubscription)이 경쟁으로 '없음'을 본 상황
    db.subscription.findFirst.mockImplementationOnce(async () => null);
    expect(await activateByBillingKey("bk-b")).toEqual({ ok: false, code: "duplicate" });
    expect(subRow(b.subscriptionId).status).toBe("failed");
    expect(fakeClient.payment.payWithBillingKey).toHaveBeenCalledTimes(1);
  });

  it("해지 예약 기간이 이미 지난 구독은 다시 가입을 막지 않는다(예약 작업을 기다리지 않게)", async () => {
    const first = await startSubscription();
    const { cancelAtPeriodEnd } = await import("@/lib/billing/portone-cancel");
    await cancelAtPeriodEnd(first.subscriptionId);
    vi.setSystemTime(kst("2026-12-02T11:00:00"));
    const again = await pendingOnly({ seed: false });
    issueKey("bk-new", again.issueId);
    const { activateByBillingKey } = await load();
    expect((await activateByBillingKey("bk-new")).ok).toBe(true);
    expect(subRow(first.subscriptionId).status).toBe("expired");
  });
});

describe("첫 결제 실패 — 구독 없음 + 빌링키 삭제 + PG 메시지 그대로", () => {
  it("PG 거절 → payment_failed + 메시지 가공 없이, failed, 빌링키 삭제, 혜택 없음", async () => {
    pg.declineNext = "[NaverPay] 결제 한도를 초과했습니다 (코드 7001)";
    const s = await startSubscription();
    expect(s.result).toEqual({ ok: false, code: "payment_failed", message: "[NaverPay] 결제 한도를 초과했습니다 (코드 7001)" });
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "failed", cancelType: "payment_failed", billingKeyEnc: null });
    expect(pg.keys.get(s.billingKey)?.status).toBe("DELETED");
    expect(pg.schedules).toHaveLength(0);
    const { getEntitlement } = await import("@/lib/billing/entitlement");
    expect((await getEntitlement("elder-1")).tier).toBe("free");
  });

  it("시간 초과로 응답을 못 받았지만 실제로는 결제됨 → 다시 조회해 active", async () => {
    fakeClient.payment.payWithBillingKey.mockImplementationOnce(async (o: { paymentId: string; billingKey: string; amount: { total: number } }) => {
      pg.payments.set(o.paymentId, {
        id: o.paymentId, status: "PAID", billingKey: o.billingKey, currency: "KRW", paidAt: new Date().toISOString(),
        amount: { total: o.amount.total, taxFree: 0, discount: 0, paid: o.amount.total, cancelled: 0, cancelledTaxFree: 0 },
        channel: { type: "TEST", pgProvider: "INICIS_V2", pgMerchantId: "m" },
      });
      throw new Error("socket hang up");
    });
    const s = await startSubscription();
    expect(s.result).toMatchObject({ ok: true, status: "active" });
  });

  it("시간 초과 + 포트원에 결제가 없음(요청이 닿지 않음) → 실패 처리, 빌링키 삭제", async () => {
    fakeClient.payment.payWithBillingKey.mockImplementationOnce(async () => { throw new Error("ETIMEDOUT"); });
    const s = await startSubscription();
    expect(s.result).toEqual({ ok: false, code: "payment_failed" });
    expect(subRow(s.subscriptionId).status).toBe("failed");
    expect(pg.keys.get(s.billingKey)?.status).toBe("DELETED");
  });

  it("결제 금액이 원장과 다르면 혜택을 주지 않는다(verification_failed + 운영 경보)", async () => {
    fakeClient.payment.payWithBillingKey.mockImplementationOnce(async (o: { paymentId: string; billingKey: string }) => {
      pg.payments.set(o.paymentId, {
        id: o.paymentId, status: "PAID", billingKey: o.billingKey, currency: "KRW", paidAt: new Date().toISOString(),
        amount: { total: 100, taxFree: 0, discount: 0, paid: 100, cancelled: 0, cancelledTaxFree: 0 },
        channel: { type: "TEST", pgProvider: "INICIS_V2", pgMerchantId: "m" },
      });
      return { payment: { pgTxId: "tx", paidAt: new Date().toISOString() } };
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = await startSubscription();
      expect(s.result).toEqual({ ok: false, code: "verification_failed" });
      expect(subRow(s.subscriptionId).status).toBe("activating"); // 혜택 없음 — 사람이 확인한다
      expect(mail.ops.map((o) => o.subject)).toContain("[결제] 결제 확인 불일치 — 혜택 보류");
    } finally { err.mockRestore(); }
  });
});

describe("혜택 대상 확정(PG) — 조용히 다른 사람으로 바꾸지 않는다", () => {
  it.each([
    ["보호자 + 연결된 어르신", "guardian", "elder-1", { ok: true, beneficiaryUserId: "elder-1" }],
    ["보호자 + 연결 안 된 사람", "guardian", "stranger", { ok: false, code: "not_linked" }],
    ["보호자 + 본인", "guardian", "guardian-1", { ok: false, code: "not_linked" }],
    ["보호자 + 대상 없음", "guardian", undefined, { ok: false, code: "not_linked" }],
    // 일반 회원은 하루 대화 한도가 없다 — 한도를 늘리는 이용권으로 얻는 것이 없어 팔지 않는다
    ["일반인 + 본인", "general", "guardian-1", { ok: false, code: "role_not_allowed" }],
    ["일반인 + 대상 없음", "general", undefined, { ok: false, code: "role_not_allowed" }],
    ["일반인 + 다른 사람", "general", "elder-1", { ok: false, code: "role_not_allowed" }],
    ["어르신 본인 결제", "user", "guardian-1", { ok: false, code: "role_not_allowed" }],
    ["의사 계정", "pro", "elder-1", { ok: false, code: "role_not_allowed" }],
  ])("%s", async (_l, mode, requested, expected) => {
    seedFamily();
    const { resolvePgBeneficiary } = await load();
    expect(await resolvePgBeneficiary("guardian-1", mode, requested)).toEqual(expected);
  });

  it("끊긴(revoked) 연결의 어르신은 대상이 될 수 없다", async () => {
    seedFamily({ linked: false });
    const { resolvePgBeneficiary } = await load();
    expect(await resolvePgBeneficiary("guardian-1", "guardian", "elder-1")).toEqual({ ok: false, code: "not_linked" });
  });

  it.each([["general"], ["pro"], ["guardian"]])("연결된 계정이 %s(어르신 아님)이면 not_eligible — 하루 한도가 걸리는 계정에만 판다", async (role) => {
    seedFamily();
    db.user.rows.find((u) => u.id === "elder-1")!.screeningMode = role;
    const { resolvePgBeneficiary } = await load();
    expect(await resolvePgBeneficiary("guardian-1", "guardian", "elder-1")).toEqual({ ok: false, code: "not_eligible" });
  });
});

describe("BillingKey.Deleted 웹훅 — 결제사 앱에서 직접 해지", () => {
  it("살아 있는 구독의 빌링키가 지워짐 → 다음 결제부터 해지(만료일까지 혜택), 남은 예약 취소, 메일", async () => {
    const s = await startSubscription();
    pg.keys.get(s.billingKey)!.status = "DELETED";
    pg.schedules[0].status = "REVOKED"; // 키가 지워지면 결제사 쪽 예약도 쓸 수 없다
    const { onBillingKeyDeleted } = await load();
    expect(await onBillingKeyDeleted(s.billingKey)).toBe("canceled");
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", cancelType: "key_deleted", nextChargeAt: null, billingKeyEnc: null });
    expect(subRow(s.subscriptionId).expiresAt).toEqual(kst("2026-12-02T10:00:00"));
    expect(mail.sent.at(-1)?.subject).toBe("[마음이음] 이용권 해지 완료");
  });

  it("우리가 지운 빌링키(이미 해지된 구독)·모르는 빌링키는 무시", async () => {
    const s = await startSubscription();
    const { cancelAtPeriodEnd } = await import("@/lib/billing/portone-cancel");
    await cancelAtPeriodEnd(s.subscriptionId);
    const sent = mail.sent.length;
    const { onBillingKeyDeleted } = await load();
    expect(await onBillingKeyDeleted(s.billingKey)).toBe("unchanged");
    expect(await onBillingKeyDeleted("bk-unknown")).toBe("ignored");
    expect(mail.sent).toHaveLength(sent);
  });
});
