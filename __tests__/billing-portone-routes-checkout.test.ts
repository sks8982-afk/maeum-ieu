/**
 * 웹 결제 시작 API — config(화면 설정) · prepare(발급 준비) · activate(빌링키 확정·첫 결제).
 *
 * 지키는 것:
 *   · config는 비밀값(API Secret·웹훅 시크릿)을 싣지 않는다. 채널 키가 있는 결제수단만, 혜택 대상 후보는 연결(active)된 어르신만.
 *   · 결제 주체는 보호자·일반인만 — 어르신·의사는 canPurchase false이고 prepare도 403. 역할은 세션(JWT)이 아니라 DB 값으로 본다.
 *   · 금액·한도는 서버 요금제 값만 — 화면이 보낸 가격을 무시한다. 필수 동의 넷이 전부 true(문자열 "true"는 동의가 아니다)여야 하고
 *     옛 약관 버전에서 온 동의는 거절한다. 동의 기록(항목·버전)이 남는다.
 *   · 혜택 대상은 연결된 어르신 중 고른 분만(미연결·해제된 연결·고르지 않음 → 403), 이미 이용권이 있는 분은 409.
 *   · activate: 남의 발급 준비를 확정하려 하면 404(있는지조차 알리지 않는다), 형식이 틀리면 포트원을 부르지도 않는다,
 *     첫 결제 실패는 402 + PG 메시지 그대로(네이버페이 조건), 두 번 불러도 결제는 한 번, 포트원 일시 오류는 502.
 *   · 응답에 빌링키·암호문이 없다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  db, pg, fakeClient, apiReq, read, loginAs, setRole, issueKey, startSubscription, subRow, kst, CONSENT,
} from "./helpers/billing-portone-route-harness";

const config = () => import("@/app/api/billing/portone/config/route");
const prepare = () => import("@/app/api/billing/portone/prepare/route");
const activate = () => import("@/app/api/billing/portone/activate/route");

const consents = Object.fromEntries(CONSENT.items.map((k) => [k, true]));
/** 화면(runCheckout)이 보내는 본문 — 고른 요금제와 화면에 보인 금액·한도, 화면 문안 버전 */
const body = (over: Record<string, unknown> = {}) => ({
  planId: "day30", method: "CARD", beneficiaryUserId: "elder-1", consents, termsVersion: "2026-10-22",
  expectedPriceKrw: 19_900, expectedDailyTurnLimit: 30, ...over,
});

function link(expert: string, patient: string, status = "active") {
  db.expertPatient.rows.push({ id: `${expert}-${patient}`, expertUserId: expert, patientUserId: patient, status, createdAt: new Date() });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(kst("2026-11-02T14:05:00"));
  setRole("guardian-1", "guardian", "보호자");
  setRole("elder-1", "user", "김영자");
  setRole("elder-2", "user", "이순자");
  link("guardian-1", "elder-1");
  loginAs("guardian-1");
});
afterEach(() => vi.useRealTimers());

const getConfig = async () => read(await (await config()).GET(apiReq("/api/billing/portone/config")));
const postPrepare = async (b: unknown) => read(await (await prepare()).POST(apiReq("/api/billing/portone/prepare", { body: b })));
const postActivate = async (b: unknown) => read(await (await activate()).POST(apiReq("/api/billing/portone/activate", { body: b })));

describe("config — 화면 설정", () => {
  it("보호자: 요금제·채널 키 있는 결제수단만·상점 아이디·약관 버전·필수 동의 넷·연결된 어르신(해제된 연결 제외)", async () => {
    link("guardian-1", "elder-2", "revoked");
    process.env.BIZ_NAME = "마음이음";
    const r = await getConfig();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      enabled: true, mode: "test", storeId: "store-test", canPurchase: true, role: "guardian", termsVersion: "2026-10-22",
      requiredConsents: ["terms", "autoRenew", "privacyEntrust", "refundPolicy"], freeDailyTurnLimit: 10,
      rules: { withdrawalDays: 7, earlyCancelPenaltyPercent: 10, retryOffsetsDays: [1, 3] }, business: { name: "마음이음", phone: "031-000-0000" },
    });
    expect((r.body.plans as { id: string; priceKrw: number }[]).map((p) => [p.id, p.priceKrw])).toEqual([["day20", 14_900], ["day30", 19_900], ["day60", 39_900]]);
    expect(r.body.payMethods).toEqual([{ method: "CARD", label: "카드", channelKey: "channel-key-card" }]);
    // 연결한 날도 싣는다 — 같은 이름의 계정이 보호자 코드로 끼어들어도 보호자가 가려낼 수 있게(10-22 검토)
    expect(r.body.beneficiaries).toEqual([{ userId: "elder-1", name: "김영자", covered: false, linkedAt: kst("2026-11-02T14:05:00").toISOString() }]);
    // 🔒 비밀값은 어떤 이름으로도 나가지 않는다
    expect(r.text).not.toContain("secret-test");
    expect(r.text).not.toContain("whsec_test");
  });

  it("이미 이용권이 있는 어르신은 covered", async () => {
    await startSubscription({ seed: false });
    expect((await getConfig()).body.beneficiaries).toEqual([{ userId: "elder-1", name: "김영자", covered: true, linkedAt: expect.any(String) }]);
  });

  it.each([["user"], ["pro"]])("%s 계정은 canPurchase false · 혜택 대상 후보 없음", async (role) => {
    setRole("guardian-1", role);
    const r = await getConfig();
    expect(r.body).toMatchObject({ canPurchase: false, role, beneficiaries: [] });
  });

  it("일반인은 canPurchase false — 일반 회원은 하루 대화 한도가 없어 이용권으로 얻는 것이 없다(효과 없는 상품을 팔지 않는다)", async () => {
    setRole("general-1", "general", "박일반");
    loginAs("general-1", "general");
    expect((await getConfig()).body).toMatchObject({ canPurchase: false, role: "general", beneficiaries: [] });
  });

  it("보호자에게 연결된 계정이 어르신(user)이 아니면(일반·의사) 혜택 대상 후보에서 빠진다 — 그 계정에는 하루 한도가 없다", async () => {
    setRole("general-2", "general", "최일반");
    setRole("doctor-2", "pro", "정의사");
    link("guardian-1", "general-2");
    link("guardian-1", "doctor-2");
    expect((await getConfig()).body.beneficiaries).toEqual([{ userId: "elder-1", name: "김영자", covered: false, linkedAt: expect.any(String) }]);
  });
});

describe("prepare — 발급 준비", () => {
  it("보호자 → 연결된 어르신: 브라우저 SDK 매개변수 + pending 구독(서버 요금제 금액·한도) + 동의 기록", async () => {
    const r = await postPrepare(body({ priceKrw: 100, dailyTurnLimit: 999, name: "하루 무제한" }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      storeId: "store-test", channelKey: "channel-key-card", method: "CARD", billingKeyMethod: "CARD",
      issueName: "마음이음 월 이용권(하루 대화 30회)", priceKrw: 19_900, dailyTurnLimit: 30, planName: "월 이용권(하루 대화 30회)",
      customerId: "guardian-1", buyer: { fullName: "보호자", email: "guardian-1@example.com" },
      beneficiary: { userId: "elder-1", name: "김영자" }, expiresInSec: 3600,
    });
    const issueId = r.body.issueId as string;
    expect(issueId).toMatch(/^bk[0-9a-f]{32}$/);
    expect(r.body.redirectUrl).toBe(`https://maeum.example.com/subscribe/return?issueId=${issueId}`);
    // 🔒 화면이 보낸 가격·한도는 무시 — 가입 당시 서버 요금제 값으로 고정
    expect(subRow(r.body.subscriptionId as string)).toMatchObject({
      status: "pending", provider: "portone", priceKrw: 19_900, dailyTurnLimit: 30, beneficiaryUserId: "elder-1", purchaseToken: `portone:${issueId}`,
    });
    expect(db.billingConsent.rows).toEqual([expect.objectContaining({
      userId: "guardian-1", subscriptionId: r.body.subscriptionId, termsVersion: "2026-10-22", items: CONSENT.items,
    })]);
  });

  it("세션(JWT)은 보호자라도 DB 역할이 어르신이면 403 — 역할이 바뀐 뒤 남은 토큰으로 결제하지 못한다", async () => {
    setRole("guardian-1", "user");
    const r = await postPrepare(body());
    expect([r.status, r.body.code]).toEqual([403, "role_not_allowed"]);
    expect(db.subscription.rows).toHaveLength(0);
  });

  it("의사 계정 403", async () => {
    setRole("guardian-1", "pro");
    expect((await postPrepare(body())).status).toBe(403);
  });

  it.each([
    ["하나라도 false", { ...consents, refundPolicy: false }],
    ["빠진 항목", { terms: true, autoRenew: true, privacyEntrust: true }],
    ["문자열 \"true\"", { terms: "true", autoRenew: true, privacyEntrust: true, refundPolicy: true }],
    ["배열", ["terms", "autoRenew", "privacyEntrust", "refundPolicy"]],
  ])("필수 동의 — %s → 400 consent_required, 기록 없음", async (_n, c) => {
    const r = await postPrepare(body({ consents: c }));
    expect([r.status, r.body.code]).toEqual([400, "consent_required"]);
    expect(db.subscription.rows).toHaveLength(0);
    expect(db.billingConsent.rows).toHaveLength(0);
  });

  it("옛 약관 버전 화면에서 온 동의 → 409 terms_outdated · 지금 버전이면 통과", async () => {
    expect((await postPrepare(body({ termsVersion: "2026-01-01" }))).body.code).toBe("terms_outdated");
    expect((await postPrepare(body({ termsVersion: "2026-10-22" }))).status).toBe(200);
  });

  it("약관 버전을 빼면 400 — 어느 문안에 동의했는지 모르는 동의를 지금 버전으로 적지 않는다", async () => {
    const r = await postPrepare(body({ termsVersion: undefined }));
    expect([r.status, r.body.code]).toEqual([400, "bad_request"]);
    expect(db.billingConsent.rows).toHaveLength(0);
  });

  it.each([
    ["금액이 바뀜(화면 19,900원 → 서버 24,900원)", { expectedPriceKrw: 19_900 }, JSON.stringify([
      { id: "day20", dailyTurnLimit: 20, priceKrw: 14_900 }, { id: "day30", dailyTurnLimit: 30, priceKrw: 24_900 }, { id: "day60", dailyTurnLimit: 60, priceKrw: 39_900 }])],
    ["한도가 바뀜(화면 30회 → 서버 25회)", { expectedDailyTurnLimit: 30 }, JSON.stringify([
      { id: "day20", dailyTurnLimit: 20, priceKrw: 14_900 }, { id: "day30", dailyTurnLimit: 25, priceKrw: 19_900 }, { id: "day60", dailyTurnLimit: 60, priceKrw: 39_900 }])],
  ])("화면이 본 요금과 지금 요금이 다르면 409 price_changed — %s, 결제를 준비하지 않는다(본 적 없는 금액으로 자동결제되지 않게)", async (_n, over, plans) => {
    process.env.BILLING_PLANS = plans;
    const r = await postPrepare(body(over));
    expect([r.status, r.body.code]).toEqual([409, "price_changed"]);
    expect(db.subscription.rows).toHaveLength(0);
  });

  it("화면이 본 금액·한도를 빼면 400 — 확인하지 못한 금액으로 결제를 준비하지 않는다", async () => {
    expect((await postPrepare(body({ expectedPriceKrw: undefined }))).status).toBe(400);
    expect((await postPrepare(body({ expectedDailyTurnLimit: "30" }))).status).toBe(400);
  });

  it("시험 모드에서 정한 계정(PORTONE_TEST_USER_IDS)이 아니면 403 test_mode_restricted — 시험 결제로 실제 유료 혜택이 생기지 않게", async () => {
    process.env.PORTONE_TEST_USER_IDS = "tester-1";
    const r = await postPrepare(body());
    expect([r.status, r.body.code]).toEqual([403, "test_mode_restricted"]);
    expect(db.subscription.rows).toHaveLength(0);
    expect((await getConfig()).body).toMatchObject({ canPurchase: false, testModeRestricted: true, beneficiaries: [] });
    process.env.PORTONE_TEST_USER_IDS = "tester-1,guardian-1";
    expect((await postPrepare(body())).status).toBe(200);
  });

  it("하루에 발급 준비를 5번 넘게 하면 429 too_many_attempts", async () => {
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(new Date(kst("2026-11-02T14:05:00").getTime() + i * 60_000));
      expect((await postPrepare(body())).status, `${i + 1}번째`).toBe(200);
    }
    const r = await postPrepare(body());
    expect([r.status, r.body.code]).toEqual([429, "too_many_attempts"]);
  });

  it.each([
    ["없는 요금제", { planId: "day999" }, "invalid_plan"],
    ["채널 키가 없는 결제수단(카카오페이)", { method: "KAKAOPAY" }, "invalid_method"],
    ["모르는 결제수단", { method: "BITCOIN" }, "invalid_method"],
  ])("%s → 400 %s", async (_n, over, code) => {
    const r = await postPrepare(body(over));
    expect([r.status, r.body.code]).toEqual([400, code]);
  });

  it.each([
    ["연결되지 않은 어르신", { beneficiaryUserId: "elder-2" }],
    ["해제된 연결", { beneficiaryUserId: "elder-3" }],
    ["혜택 대상을 고르지 않음", { beneficiaryUserId: undefined }],
    ["보호자 본인", { beneficiaryUserId: "guardian-1" }],
  ])("%s → 403 not_linked(다른 사람으로 바꿔 붙이지 않는다)", async (_n, over) => {
    link("guardian-1", "elder-3", "revoked");
    const r = await postPrepare(body(over));
    expect([r.status, r.body.code]).toEqual([403, "not_linked"]);
    expect(db.subscription.rows).toHaveLength(0);
  });

  it("일반인은 결제할 수 없다 — 본인이든 남이든 403 role_not_allowed, 기록 없음", async () => {
    setRole("general-1", "general");
    loginAs("general-1", "general");
    for (const over of [{ beneficiaryUserId: "elder-1" }, { beneficiaryUserId: undefined }, { beneficiaryUserId: "general-1" }]) {
      const r = await postPrepare(body(over));
      expect([r.status, r.body.code]).toEqual([403, "role_not_allowed"]);
    }
    expect(db.subscription.rows).toHaveLength(0);
  });

  it("연결된 계정이라도 어르신(user)이 아니면 403 not_eligible — 하루 한도가 없는 계정에 한도를 늘리는 이용권을 붙이지 않는다", async () => {
    setRole("general-2", "general", "최일반");
    link("guardian-1", "general-2");
    const r = await postPrepare(body({ beneficiaryUserId: "general-2" }));
    expect([r.status, r.body.code]).toEqual([403, "not_eligible"]);
    expect(db.subscription.rows).toHaveLength(0);
  });

  it("이미 이용권이 있는 어르신 → 409 duplicate", async () => {
    await startSubscription({ seed: false });
    const r = await postPrepare(body());
    expect([r.status, r.body.code]).toEqual([409, "duplicate"]);
  });

  it("JSON이 아닌 본문 → 400", async () => {
    expect((await postPrepare("not json")).status).toBe(400);
  });
});

describe("activate — 빌링키 확정·첫 결제", () => {
  async function prepared() {
    const r = await postPrepare(body());
    const issueId = r.body.issueId as string;
    const billingKey = `billing-key-${issueId.slice(2, 10)}`;
    issueKey(billingKey, issueId);
    return { issueId, billingKey, subscriptionId: r.body.subscriptionId as string };
  }

  it("정상 → 200 active, 응답에 빌링키·암호문 없음 · 다시 불러도 결제는 한 번", async () => {
    const p = await prepared();
    const r = await postActivate({ issueId: p.issueId, billingKey: p.billingKey });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, status: "active", subscriptionId: p.subscriptionId });
    expect(r.text).not.toContain(p.billingKey);
    expect(r.text).not.toContain("enc:v1");
    expect(subRow(p.subscriptionId)).toMatchObject({ status: "active", cycleNo: 1 });
    expect((await postActivate({ issueId: p.issueId, billingKey: p.billingKey })).body.status).toBe("active");
    expect(pg.log.filter((l) => l.startsWith("pay:"))).toHaveLength(1);
  });

  it("남의 발급 준비를 확정하려 함 → 404(있는지 알리지 않는다), 결제하지 않고 pending 그대로", async () => {
    const p = await prepared();
    setRole("guardian-2", "guardian");
    loginAs("guardian-2");
    const r = await postActivate({ issueId: p.issueId, billingKey: p.billingKey });
    expect([r.status, r.body.code]).toEqual([404, "not_found"]);
    expect(subRow(p.subscriptionId).status).toBe("pending");
    expect(pg.log.some((l) => l.startsWith("pay:"))).toBe(false);
  });

  it.each([
    ["issueId 꼴이 아님", { issueId: "bk-1' OR 1=1", billingKey: "billing-key-x" }],
    ["빌링키에 공백·제어문자", { issueId: `bk${"a".repeat(32)}`, billingKey: "billing key\n" }],
    ["빌링키 없음", { issueId: `bk${"a".repeat(32)}` }],
  ])("%s → 400, 포트원을 부르지 않는다", async (_n, b) => {
    const r = await postActivate(b);
    expect(r.status).toBe(400);
    expect(fakeClient.payment.billingKey.getBillingKeyInfo).not.toHaveBeenCalled();
  });

  it("첫 결제 PG 거절 → 402, PG 메시지를 가공하지 않고 그대로(네이버페이 조건)", async () => {
    const p = await prepared();
    pg.declineNext = "[PG] 잔액이 부족합니다(코드 51).";
    const r = await postActivate({ issueId: p.issueId, billingKey: p.billingKey });
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ code: "payment_failed", error: "[PG] 잔액이 부족합니다(코드 51).", pgMessage: "[PG] 잔액이 부족합니다(코드 51)." });
    expect(subRow(p.subscriptionId).status).toBe("failed");
  });

  it("테스트 모드에 실연동(LIVE) 채널 빌링키 → 400 invalid_billing_key", async () => {
    const r0 = await postPrepare(body());
    issueKey("billing-key-live", r0.body.issueId as string, "LIVE");
    const r = await postActivate({ issueId: r0.body.issueId, billingKey: "billing-key-live" });
    expect([r.status, r.body.code]).toEqual([400, "invalid_billing_key"]);
  });

  it("발급 준비 뒤 1시간이 지남 → 410 expired", async () => {
    const p = await prepared();
    vi.setSystemTime(kst("2026-11-02T15:06:00"));
    expect((await postActivate({ issueId: p.issueId, billingKey: p.billingKey })).status).toBe(410);
  });

  it("포트원 일시 오류(시간 초과) → 502 temporary — 결과를 모르니 실패로 단정하지 않는다", async () => {
    const p = await prepared();
    fakeClient.payment.billingKey.getBillingKeyInfo.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    const r = await postActivate({ issueId: p.issueId, billingKey: p.billingKey });
    expect([r.status, r.body.code]).toEqual([502, "temporary"]);
    expect(subRow(p.subscriptionId).status).toBe("pending");
  });
});
