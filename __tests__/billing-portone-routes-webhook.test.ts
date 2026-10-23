/**
 * 포트원 웹훅(app/api/billing/portone/webhook) — 진짜 SDK(Webhook.verify)로 서명을 검증한다(서명 검증을 목으로 바꾸지 않는다).
 *
 * 지키는 것:
 *   · 원문 그대로 서명 검증 — 본문을 바꾸거나·시크릿이 다르거나·헤더가 없거나·시각이 5분 넘게 어긋나면 400, 아무것도 재조회하지 않는다.
 *     (JSON을 다시 직렬화하면 서명이 깨진다 — 들여쓰기 있는 본문으로 확인 · 헤더는 Object.fromEntries로 넘겨야 SDK가 읽는다)
 *   · 본문을 믿지 않고 포트원 재조회로 반영 — 갱신 결제 Transaction.Paid → 기간 연장, 우리 원장에 없는 결제는 무시(200).
 *   · webhook-id 중복은 한 번만 처리 · 처리 중 오류는 500이고 처리 기록을 남기지 않는다(재전송이 다시 처리한다).
 *   · 다른 상점의 웹훅은 재조회하지 않는다 · BillingKey.Issued는 판매 스위치가 켜져 있을 때만 결제를 시작한다(브라우저 복귀와 겹쳐도 한 번).
 *   · BillingKey.Deleted(앱에서 자동결제 해지) → 다음 결제부터 해지.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  db, pg, fakeClient, webhookEvents, read, setRole, issueKey, runSchedule, startSubscription, subRow, ledger, kst, CONSENT,
  signedWebhook, newWebhookSecret, paymentWebhookBody, billingKeyWebhookBody, PLAN_DAY30,
} from "./helpers/billing-portone-route-harness";

const route = () => import("@/app/api/billing/portone/webhook/route");
const period = () => import("@/lib/billing/portone-period");
const send = async (req: Request) => read(await (await route()).POST(req));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(kst("2026-11-02T14:05:00"));
  process.env.PORTONE_WEBHOOK_SECRET = newWebhookSecret();
  setRole("guardian-1", "guardian", "보호자");
  setRole("elder-1", "user", "김영자");
  db.expertPatient.rows.push({ id: "link-1", expertUserId: "guardian-1", patientUserId: "elder-1", status: "active", createdAt: new Date() });
});
afterEach(() => vi.useRealTimers());

/** 첫 결제를 마친 구독 → 12/2 10:00 갱신 예약 결제가 실행됨(웹훅은 아직) */
async function renewedAtPortone() {
  const s = await startSubscription({ seed: false });
  const { paymentIdFor } = await period();
  vi.setSystemTime(kst("2026-12-02T10:00:30"));
  const paymentId = paymentIdFor(s.subscriptionId, 2);
  runSchedule(paymentId, "paid");
  return { ...s, paymentId };
}

describe("서명 검증 — 원문 그대로, 실패는 400이고 아무것도 재조회하지 않는다", () => {
  it("올바른 서명(들여쓰기 있는 원문) → 200 · 갱신 결제가 반영된다", async () => {
    const s = await renewedAtPortone();
    const r = await send(signedWebhook(paymentWebhookBody("Transaction.Paid", s.paymentId, "store-test", true)));
    expect(r.status).toBe(200);
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "active", cycleNo: 2, expiresAt: kst("2027-01-02T10:00:00") });
    expect(ledger(s.paymentId).status).toBe("paid");
  });

  it.each([
    ["본문을 바꿈(금액·결제 id 위조)", (req: { body: string }) => ({ ...req, body: req.body.replace("Transaction.Paid", "Transaction.Cancelled") })],
    ["다른 시크릿으로 서명", (req: { body: string }) => ({ ...req, secret: newWebhookSecret() })],
    ["5분 넘게 지난 서명 시각", (req: { body: string }) => ({ ...req, timestamp: Math.floor(Date.now() / 1000) - 301 })],
  ])("%s → 400", async (_n, tamper) => {
    const s = await renewedAtPortone();
    const body = paymentWebhookBody("Transaction.Paid", s.paymentId);
    const t = tamper({ body }) as { body: string; secret?: string; timestamp?: number };
    const signedOriginal = signedWebhook(body, { secret: t.secret, timestamp: t.timestamp });
    const req = new Request(signedOriginal.url, { method: "POST", headers: signedOriginal.headers, body: t.body });
    const before = fakeClient.payment.getPayment.mock.calls.length; // 첫 결제 확정 때 부른 것까지
    const r = await send(req);
    expect(r.status).toBe(400);
    expect(fakeClient.payment.getPayment.mock.calls.length).toBe(before);
    expect(subRow(s.subscriptionId).cycleNo).toBe(1);
  });

  it("서명 헤더가 없으면 400", async () => {
    const r = await send(new Request("https://maeum.example.com/api/billing/portone/webhook", { method: "POST", body: "{}" }));
    expect(r.status).toBe(400);
  });

  it("웹훅 시크릿이 없으면 503(설정 전 — 포트원이 나중에 재전송)", async () => {
    delete process.env.PORTONE_WEBHOOK_SECRET;
    expect((await send(signedWebhook("{}", { secret: newWebhookSecret() }))).status).toBe(503);
  });
});

describe("재조회 반영 · 멱등", () => {
  it("같은 webhook-id가 다시 와도 한 번만 처리한다(재조회 1번)", async () => {
    const s = await renewedAtPortone();
    const body = paymentWebhookBody("Transaction.Paid", s.paymentId);
    expect((await send(signedWebhook(body, { id: "msg_same" }))).status).toBe(200);
    const calls = fakeClient.payment.getPayment.mock.calls.length;
    expect((await send(signedWebhook(body, { id: "msg_same" }))).status).toBe(200);
    expect(fakeClient.payment.getPayment.mock.calls.length).toBe(calls);
    expect(webhookEvents).toEqual([{ webhookId: "msg_same", type: "Transaction.Paid" }]);
  });

  it("우리 원장에 없는 결제 → 200, 포트원도 부르지 않는다", async () => {
    const r = await send(signedWebhook(paymentWebhookBody("Transaction.Paid", "someone-elses-payment")));
    expect(r.status).toBe(200);
    expect(fakeClient.payment.getPayment).not.toHaveBeenCalled();
  });

  it("다른 상점의 웹훅 → 200, 재조회하지 않는다", async () => {
    const s = await renewedAtPortone();
    const calls = fakeClient.payment.getPayment.mock.calls.length;
    const r = await send(signedWebhook(paymentWebhookBody("Transaction.Paid", s.paymentId, "store-other")));
    expect(r.status).toBe(200);
    expect(fakeClient.payment.getPayment.mock.calls.length).toBe(calls);
    expect(subRow(s.subscriptionId).cycleNo).toBe(1);
  });

  it("처리 중 오류 → 500, 처리 기록을 남기지 않는다 → 재전송이 다시 처리해 반영", async () => {
    const s = await renewedAtPortone();
    const body = paymentWebhookBody("Transaction.Paid", s.paymentId);
    fakeClient.payment.getPayment.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect((await send(signedWebhook(body, { id: "msg_retry" }))).status).toBe(500);
    expect(webhookEvents).toEqual([]);
    expect(subRow(s.subscriptionId).cycleNo).toBe(1);
    expect((await send(signedWebhook(body, { id: "msg_retry" }))).status).toBe(200);
    expect(subRow(s.subscriptionId).cycleNo).toBe(2);
  });

  it("갱신 결제 실패(Transaction.Failed) → grace, 다음 날 10:00 재시도 예약, 혜택 유지", async () => {
    const s = await startSubscription({ seed: false });
    const { paymentIdFor } = await period();
    vi.setSystemTime(kst("2026-12-02T10:00:30"));
    const paymentId = paymentIdFor(s.subscriptionId, 2);
    runSchedule(paymentId, "failed");
    expect((await send(signedWebhook(paymentWebhookBody("Transaction.Failed", paymentId)))).status).toBe(200);
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "grace", nextChargeAt: kst("2026-12-03T10:00:00") });
  });
});

describe("빌링키 웹훅", () => {
  async function pendingWithKey() {
    const { createPendingSubscription } = await import("@/lib/billing/portone-activate");
    const p = await createPendingSubscription({ purchaserUserId: "guardian-1", beneficiaryUserId: "elder-1", plan: PLAN_DAY30, method: "CARD", consent: CONSENT });
    if (!p.ok) throw new Error(p.code);
    const billingKey = `billing-key-${p.issueId.slice(2, 8)}`;
    issueKey(billingKey, p.issueId);
    return { ...p, billingKey };
  }

  it("BillingKey.Issued(창을 닫아 브라우저 복귀가 없음) → 첫 결제·active · 뒤늦은 브라우저 확정이 와도 결제는 한 번", async () => {
    const p = await pendingWithKey();
    expect((await send(signedWebhook(billingKeyWebhookBody("BillingKey.Issued", p.billingKey)))).status).toBe(200);
    expect(subRow(p.subscriptionId).status).toBe("active");
    const { activateByBillingKey } = await import("@/lib/billing/portone-activate");
    expect(await activateByBillingKey(p.billingKey, { issueId: p.issueId, purchaserUserId: "guardian-1" }))
      .toEqual({ ok: true, subscriptionId: p.subscriptionId, status: "active" });
    expect(pg.log.filter((l) => l.startsWith("pay:"))).toHaveLength(1);
  });

  it("판매 스위치가 꺼져 있으면 BillingKey.Issued로 결제를 시작하지 않는다(200) — 그 발급 준비를 닫고 빌링키를 지운다(결제사 앱에 등록이 남지 않게)", async () => {
    const p = await pendingWithKey();
    process.env.BILLING_PG_ENABLED = "0";
    expect((await send(signedWebhook(billingKeyWebhookBody("BillingKey.Issued", p.billingKey)))).status).toBe(200);
    expect(subRow(p.subscriptionId)).toMatchObject({ status: "failed", cancelType: "config" });
    expect(pg.keys.get(p.billingKey)?.status).toBe("DELETED");
    expect(pg.log.some((l) => l.startsWith("pay:"))).toBe(false);
  });

  it("닫힌 시도(탈퇴 정리·시간 초과)·기록이 없는 시도에 늦게 온 빌링키도 지운다 — 결제하지 않는다", async () => {
    const p = await pendingWithKey();
    db.subscription.rows.find((r) => r.id === p.subscriptionId)!.status = "failed"; // 예: 결제회원 탈퇴 정리가 닫았다
    expect((await send(signedWebhook(billingKeyWebhookBody("BillingKey.Issued", p.billingKey)))).status).toBe(200);
    expect(pg.keys.get(p.billingKey)?.status).toBe("DELETED");
    const q = await pendingWithKey();
    db.subscription.rows.splice(db.subscription.rows.findIndex((r) => r.id === q.subscriptionId), 1); // 계정 삭제로 함께 지워짐
    expect((await send(signedWebhook(billingKeyWebhookBody("BillingKey.Issued", q.billingKey)))).status).toBe(200);
    expect(pg.keys.get(q.billingKey)?.status).toBe("DELETED");
    expect(pg.log.some((l) => l.startsWith("pay:"))).toBe(false);
  });

  it("BillingKey.Deleted(카카오페이·네이버페이 앱에서 자동결제를 끊음) → 다음 결제부터 해지", async () => {
    const s = await startSubscription({ seed: false });
    pg.keys.get(s.billingKey)!.status = "DELETED";
    expect((await send(signedWebhook(billingKeyWebhookBody("BillingKey.Deleted", s.billingKey)))).status).toBe(200);
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", cancelType: "key_deleted", cancelAtPeriodEnd: true });
  });

  it("모르는 종류의 웹훅 → 200(새 이벤트가 생겨도 재전송 폭주가 없게)", async () => {
    const r = await send(signedWebhook(JSON.stringify({ type: "Transaction.SomethingNew", timestamp: new Date().toISOString(), data: {} })));
    expect(r.status).toBe(200);
  });
});
