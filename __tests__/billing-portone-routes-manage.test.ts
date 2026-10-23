/**
 * 구독 관리 API — 해지(cancel: 다음 결제부터 / 지금) · 청약철회(refund) · 구독 상태(status의 pg).
 *
 * 지키는 것(환불정책 계산 예시 표 — 월 19,900원, 이용기간 30일):
 *   · 3일째 지금 해지·철회(유료 혜택 안 씀) → 전액 19,900원 / 5일째 철회(유료 혜택 씀) → 16,584원 / 12일째 지금 해지 → 10,746원 /
 *     다음 결제부터 해지 → 환불 없음, 만료일까지 이용. 순서는 예약 취소 → (결제 취소) → 빌링키 삭제.
 *   · 결제회원 본인만 — 다른 보호자·혜택 받는 어르신이 해지·환불하려 하면 404(IDOR), 아무것도 바뀌지 않고 포트원도 부르지 않는다.
 *   · 청약철회는 결제일부터 7일 안에만 — 지나면 409이고 구독은 그대로(위약금 있는 중도해지로 바꿔치기하지 않는다).
 *   · 지금 해지 도중 환불이 실패해도 해지는 기록됐으면 202(환불은 예약 작업이 같은 금액으로 이어 간다), 기록 전 실패면 502.
 *   · 구독 상태: Play 필드는 그대로, pg에 요금제·가격·수단·다음 결제일·혜택 대상·유료 혜택 사용·방식별 예상 환불액·결제 내역(예약 행 제외).
 *     빌링키·암호문은 싣지 않는다. 앱 WebView에는 pg를 싣지 않는다. pg 조회가 실패해도 Play 필드는 나간다.
 *   · 혜택 대상 이름은 혜택이 있는 구독에서만 — 결제 시도(pending, 만료 시각 없음)의 다른 어르신 이름이 나오지 않는다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  db, pg, mail, apiReq, read, loginAs, setRole, startSubscription, subRow, ledger, kst, PLAN_DAY30, CONSENT, APP_UA,
} from "./helpers/billing-portone-route-harness";

const cancelRoute = () => import("@/app/api/billing/portone/cancel/route");
const refundRoute = () => import("@/app/api/billing/portone/refund/route");
const statusRoute = () => import("@/app/api/billing/status/route");
const period = () => import("@/lib/billing/portone-period");

const cancel = async (b: unknown) => read(await (await cancelRoute()).POST(apiReq("/api/billing/portone/cancel", { body: b })));
const refund = async (b: unknown) => read(await (await refundRoute()).POST(apiReq("/api/billing/portone/refund", { body: b })));
const status = async (ua?: string) => read(await (await statusRoute()).GET(apiReq("/api/billing/status", { ua })));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(kst("2026-11-02T14:05:00"));
  setRole("guardian-1", "guardian", "보호자");
  setRole("elder-1", "user", "김영자");
  db.expertPatient.rows.push({ id: "link-1", expertUserId: "guardian-1", patientUserId: "elder-1", status: "active", createdAt: new Date() });
  loginAs("guardian-1");
});
afterEach(() => vi.useRealTimers());

/** 첫 결제를 마친 이용권(11/2 14:05 KST, 하루 30회 19,900원, 이용기간 11/2 ~ 12/1) */
async function subscribed() {
  const s = await startSubscription({ seed: false });
  const { paymentIdFor } = await period();
  pg.log.length = 0; // 이 뒤의 포트원 호출만 본다
  return { ...s, firstPaymentId: paymentIdFor(s.subscriptionId, 1) };
}

/** 어르신이 그날 무료 한도(10회)를 넘겨 이야기함 — 유료 혜택 사용 */
function elderTalked(day: string, count: number) {
  db.conversation.rows.push({ id: "conv-elder", userId: "elder-1" });
  for (let i = 0; i < count; i++) {
    db.message.rows.push({ id: `m-${day}-${i}`, conversationId: "conv-elder", role: "user", content: "오늘 날씨 좋네", createdAt: kst(`${day}T09:${String(10 + i).padStart(2, "0")}:00`) });
  }
}

const portoneSteps = () => pg.log.filter((l) => /^(revoke|cancel|deleteKey):/.test(l)).map((l) => l.split(":")[0]);

describe("해지 — 두 방식", () => {
  it("다음 결제부터 해지 → 만료일까지 이용·환불 없음, 예약 취소 → 빌링키 삭제, 해지 메일", async () => {
    const s = await subscribed();
    vi.setSystemTime(kst("2026-11-13T12:00:00"));
    const r = await cancel({ subscriptionId: s.subscriptionId, mode: "period_end" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, mode: "period_end", endsAt: kst("2026-12-02T10:00:00").toISOString(), refundKrw: 0 });
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", cancelAtPeriodEnd: true, nextChargeAt: null, billingKeyEnc: null });
    expect(portoneSteps()).toEqual(["revoke", "deleteKey"]);
    expect(mail.sent.at(-1)?.subject).toContain("해지 완료");
  });

  it("12일째 지금 해지 → 10,746원(이용 12일 7,960원 + 남은 기간 10% 1,194원 공제), 예약 취소 → 결제 취소 → 빌링키 삭제", async () => {
    const s = await subscribed();
    vi.setSystemTime(kst("2026-11-13T12:00:00"));
    const r = await cancel({ subscriptionId: s.subscriptionId, mode: "now" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mode: "now", refundKrw: 10_746 });
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "revoked", cancelType: "immediate", billingKeyEnc: null });
    expect(pg.log).toContain(`cancel:${s.firstPaymentId}:10746`);
    expect(portoneSteps()).toEqual(["revoke", "cancel", "deleteKey"]);
  });

  it("3일째 지금 해지(유료 혜택 안 씀) → 청약철회 규칙으로 전액 19,900원", async () => {
    const s = await subscribed();
    vi.setSystemTime(kst("2026-11-04T12:00:00"));
    expect((await cancel({ subscriptionId: s.subscriptionId, mode: "now" })).body).toMatchObject({ refundKrw: 19_900 });
    expect(subRow(s.subscriptionId).cancelType).toBe("withdrawal");
  });

  it.each([["다른 보호자", "guardian-2"], ["혜택 받는 어르신 본인", "elder-1"]])("%s가 해지 → 404, 그대로이고 포트원을 부르지 않는다", async (_n, who) => {
    const s = await subscribed();
    setRole("guardian-2", "guardian");
    loginAs(who);
    for (const mode of ["period_end", "now"]) {
      const r = await cancel({ subscriptionId: s.subscriptionId, mode });
      expect([r.status, r.body.code]).toEqual([404, "not_found"]);
    }
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "active", cancelAtPeriodEnd: false });
    expect(pg.log).toEqual([]);
  });

  it.each([[{ mode: "now" }], [{ subscriptionId: "x", mode: "later" }], [{ subscriptionId: "x" }]])("입력 오류 %j → 400", async (b) => {
    expect((await cancel(b)).status).toBe(400);
  });

  it("이미 끝난 이용권 → 409 not_cancellable", async () => {
    const s = await subscribed();
    await cancel({ subscriptionId: s.subscriptionId, mode: "now" });
    vi.setSystemTime(kst("2026-11-05T12:00:00"));
    const r = await cancel({ subscriptionId: s.subscriptionId, mode: "period_end" });
    expect([r.status, r.body.code]).toEqual([409, "not_cancellable"]);
  });

  it("지금 해지 도중 결제 취소가 실패 → 202 refundPending(해지는 기록, 환불 목표 고정 — 예약 작업이 이어 간다)", async () => {
    const s = await subscribed();
    vi.setSystemTime(kst("2026-11-13T12:00:00"));
    pg.failCancelWith = "PG_PROVIDER";
    const r = await cancel({ subscriptionId: s.subscriptionId, mode: "now" });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ ok: true, refundPending: true });
    expect(subRow(s.subscriptionId).status).toBe("revoked");
    expect(ledger(s.firstPaymentId)).toMatchObject({ refundTargetKrw: 10_746, cancelledKrw: 0 });
  });

  it("해지를 기록하기 전에 실패(DB) → 502, 이용권은 그대로", async () => {
    const s = await subscribed();
    db.subscription.findUnique.mockRejectedValueOnce(new Error("connection reset"));
    const r = await cancel({ subscriptionId: s.subscriptionId, mode: "now" });
    expect([r.status, r.body.code]).toEqual([502, "temporary"]);
    expect(subRow(s.subscriptionId).status).toBe("active");
  });
});

describe("청약철회 — 결제일부터 7일 안에만", () => {
  it("3일째(유료 혜택 안 씀) → 전액 19,900원, 혜택 즉시 종료", async () => {
    const s = await subscribed();
    vi.setSystemTime(kst("2026-11-04T12:00:00"));
    const r = await refund({ subscriptionId: s.subscriptionId });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, refundKrw: 19_900 });
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "revoked", cancelType: "withdrawal" });
  });

  it("5일째(유료 혜택 씀 — 11/3에 11번 이야기) → 이용 5일만 빼고 16,584원(위약금 없음)", async () => {
    const s = await subscribed();
    elderTalked("2026-11-03", 11);
    vi.setSystemTime(kst("2026-11-06T12:00:00"));
    expect((await refund({ subscriptionId: s.subscriptionId })).body).toMatchObject({ refundKrw: 16_584 });
  });

  it("12일째 → 409 withdrawal_period_over, 구독은 그대로(해지는 따로 할 수 있다)", async () => {
    const s = await subscribed();
    vi.setSystemTime(kst("2026-11-13T12:00:00"));
    const r = await refund({ subscriptionId: s.subscriptionId });
    expect([r.status, r.body.code]).toEqual([409, "withdrawal_period_over"]);
    expect(subRow(s.subscriptionId).status).toBe("active");
    expect(pg.log).toEqual([]);
  });

  it("다른 보호자가 철회 → 404, 그대로", async () => {
    const s = await subscribed();
    setRole("guardian-2", "guardian");
    loginAs("guardian-2");
    expect((await refund({ subscriptionId: s.subscriptionId })).status).toBe(404);
    expect(subRow(s.subscriptionId).status).toBe("active");
  });
});

describe("구독 상태(/api/billing/status) — Play 필드 그대로 + pg", () => {
  /** 메모리 DB는 관계(select beneficiary)를 모른다 — 혜택 대상 이름 조회 한 번에만 관계를 붙인다 */
  function withBeneficiaryRelation() {
    const original = db.subscription.findFirst.getMockImplementation()!;
    db.subscription.findFirst.mockImplementationOnce(async (args) => {
      const row = await original(args);
      const u = row ? db.user.rows.find((x) => x.id === row.beneficiaryUserId) : undefined;
      return row ? { ...row, beneficiary: u ? { id: u.id, name: u.name } : null } : null;
    });
  }

  it("결제 당일: 요금제·가격·수단·혜택 대상·다음 결제일·유료 혜택 없음·철회 기간 안·예상 환불(다음 결제부터 0원 / 지금 19,900원)·결제 내역", async () => {
    const s = await subscribed();
    withBeneficiaryRelation();
    const r = await status();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tier: "pro", source: "purchaser", guardianFeatures: true, beneficiaryName: "김영자", enforced: false, productIds: [] });
    const end = kst("2026-12-02T10:00:00").toISOString();
    expect(r.body.pg).toMatchObject({
      subscriptions: [{
        subscriptionId: s.subscriptionId, status: "active",
        plan: { id: "day30", name: "월 이용권(하루 대화 30회)", dailyTurnLimit: 30, priceKrw: 19_900 },
        payMethod: "CARD", payMethodLabel: "카드", beneficiary: { userId: "elder-1", name: "김영자" },
        expiresAt: end, nextChargeAt: end, cancelAtPeriodEnd: false, usedPaidBenefit: false, withinWithdrawal: true,
        cancelOptions: {
          periodEnd: { endsAt: end, refundKrw: 0 },
          immediate: { refundKrw: 19_900, rule: "withdrawal", usedDays: 1, periodDays: 30, paidKrw: 19_900 },
        },
      }],
      // 🔒 다음 회차 예약 행(scheduled)은 결제 내역이 아니다
      payments: [{ subscriptionId: s.subscriptionId, kind: "first", amountKrw: 19_900, status: "paid", receiptUrl: `https://receipt.example.com/${s.firstPaymentId}`, failureReason: null }],
    });
    expect((r.body.pg as { payments: unknown[] }).payments).toHaveLength(1);
    expect(r.text).not.toContain(s.billingKey);
    expect(r.text).not.toContain("enc:v1");
  });

  it("12일째: 철회 기간 밖, 지금 해지 예상 10,746원 · 5일째 유료 혜택 씀: 있음, 16,584원", async () => {
    const s = await subscribed();
    vi.setSystemTime(kst("2026-11-13T12:00:00"));
    const late = (await status()).body.pg as { subscriptions: Record<string, unknown>[] };
    expect(late.subscriptions[0]).toMatchObject({ withinWithdrawal: false, cancelOptions: { immediate: { refundKrw: 10_746, rule: "immediate" } } });
    elderTalked("2026-11-03", 11);
    vi.setSystemTime(kst("2026-11-06T12:00:00"));
    const used = (await status()).body.pg as { subscriptions: Record<string, unknown>[] };
    expect(used.subscriptions[0]).toMatchObject({ usedPaidBenefit: true, cancelOptions: { immediate: { refundKrw: 16_584 } } });
    expect(s.subscriptionId).toBeTruthy();
  });

  it("혜택 대상 이름은 혜택이 있는 구독에서 — 나중에 시작만 한 다른 어르신 결제 시도(pending)의 이름이 나오지 않는다", async () => {
    await subscribed();
    setRole("elder-2", "user", "이순자");
    const { createPendingSubscription } = await import("@/lib/billing/portone-activate");
    await createPendingSubscription({ purchaserUserId: "guardian-1", beneficiaryUserId: "elder-2", plan: PLAN_DAY30, method: "CARD", consent: CONSENT });
    withBeneficiaryRelation();
    expect((await status()).body.beneficiaryName).toBe("김영자");
  });

  it("우리 앱이 틀림없는 요청(앱 패키지 헤더·앱 UA 접미사)에는 pg를 싣지 않는다(Play 필드·Play 버튼 스위치만)", async () => {
    await subscribed();
    for (const req of [
      apiReq("/api/billing/status", { ua: APP_UA, headers: { "x-requested-with": "com.maeumapp" } }),
      apiReq("/api/billing/status", { ua: `${APP_UA} MaeumApp/1.3.0` }),
    ]) {
      const r = await read(await (await statusRoute()).GET(req));
      expect(r.body).toMatchObject({ tier: "pro", pg: null, playPurchaseEnabled: false });
      expect(r.text).not.toMatch(/19900|카드|cancelOptions/);
    }
  });

  it("WebView 표지(; wv)만 있는 요청에는 pg를 싣는다 — 목록 밖 인앱 브라우저에서 해지 버튼이 사라지지 않게(앱 화면은 pg를 그리지 않는다)", async () => {
    await subscribed();
    const r = await status(`${APP_UA} SomeShoppingApp/3.2`);
    expect(r.body.pg).toMatchObject({ subscriptions: [expect.objectContaining({ status: "active" })] });
  });

  it("일반 회원에게는 오늘 대화 수(한도)를 싣지 않는다 — 일반 회원은 하루 한도가 없어 '15회 / 10회'는 거짓 표시다", async () => {
    setRole("general-1", "general", "박일반");
    loginAs("general-1", "general");
    db.conversation.rows.push({ id: "conv-general", userId: "general-1" });
    for (let i = 0; i < 15; i++) {
      db.message.rows.push({ id: `g-${i}`, conversationId: "conv-general", role: "user", content: "안녕", createdAt: kst(`2026-11-02T09:${String(10 + i)}:00`) });
    }
    expect((await status()).body.usage).toBeNull();
    loginAs("elder-1", "user");
    db.conversation.rows.push({ id: "conv-elder-2", userId: "elder-1" });
    expect((await status()).body.usage).toMatchObject({ limit: 10 }); // 어르신은 그대로
  });

  it("결제 내역은 최근 5건만이 아니라 최대 100건 — 첫 결제와 그 영수증을 언제든 볼 수 있다(제8조③ — 화면은 5건 뒤 [더 보기])", async () => {
    const s = await subscribed();
    for (let i = 0; i < 7; i++) {
      db.billingPayment.rows.push({
        id: `old-${i}`, paymentId: `old-pay-${i}`, subscriptionId: s.subscriptionId, purchaserUserId: "guardian-1", kind: "renewal",
        amountKrw: 19_900, status: "paid", paidAt: kst(`2026-0${i + 1}-02T10:00:00`), cancelledKrw: 0, refundTargetKrw: null,
        receiptUrl: null, failureReason: null, updatedAt: kst(`2026-0${i + 1}-02T10:00:00`),
      });
    }
    const pgBody = (await status()).body.pg as { payments: { paidAt: string }[] };
    expect(pgBody.payments).toHaveLength(8);
    expect(pgBody.payments.at(-1)?.paidAt).toBe(kst("2026-01-02T10:00:00").toISOString()); // 가장 오래된 것까지
  });

  it("혜택 받는 어르신 계정에는 관리 정보가 없다(해지·환불은 결제회원만)", async () => {
    await subscribed();
    loginAs("elder-1", "user");
    expect((await status()).body.pg).toEqual({ subscriptions: [], payments: [] });
  });

  it("pg 조회가 실패해도 Play 필드는 나간다 — pg.error", async () => {
    await subscribed();
    db.billingPayment.findMany.mockRejectedValueOnce(new Error("timeout"));
    const r = await status();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tier: "pro", pg: { error: expect.any(String) } });
  });
});
