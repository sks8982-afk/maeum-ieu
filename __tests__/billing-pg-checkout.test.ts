/**
 * 웹 결제 화면(app/subscribe — 신청·결제창 호출·결제 직전 고지·구독 관리·복귀) — 2026-10-22. 포트원 SDK·fetch는 전부 모의.
 *
 * 지키는 것:
 *   · 결제수단별 빌링키 발급 매개변수(research B 5 표) — 카드 CARD+구매자+제공 기간 1m · 카카오페이 EASY_PAY+customerId만(windowType 없음)
 *     · 네이버페이 EASY_PAY+displayAmount·KRW 함께 · 셋 다 forceRedirect.
 *   · 성공 판정은 code가 **없는지**로(실패해도 billingKey가 있다) · 실패 문구는 **가공하지 않고 그대로**(네이버페이 조건).
 *   · 결제 직전 고지(research D 3)를 빠짐없이 — 청약철회 기한·방법·효과를 상자에 **직접**, 해지 두 방식 모두.
 *   · 필수 동의는 항목마다 따로·기본 미체크·각 '보기' · 요금제를 미리 고르지 않는다 · 결제 버튼에 금액과 '매월 자동결제'
 *     · 결제 버튼과 취소 버튼은 같은 크기 · 해지 두 방식과 예상 환불액을 같은 모양으로.
 *   · 앱(AppPanel)에는 웹 결제 문구·링크가 없다 · Play 구매 버튼은 BILLING_PLAY_ENABLED(playPurchaseEnabled)일 때만.
 *   · 판매가 꺼져도(config off) 가입한 이용권의 관리·해지는 보인다(해지 방해 금지).
 * 렌더링: react-dom/server(첫 그리기). 상태가 바뀐 뒤의 갈래는 화면이 쓰는 순수 함수(checkoutMissing·payButtonLabel·runCheckout)로 본다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

const sdk = vi.hoisted(() => ({ requestIssueBillingKey: vi.fn() }));
vi.mock("@portone/browser-sdk/v2", () => ({ requestIssueBillingKey: sdk.requestIssueBillingKey }));
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: { user: { name: "김보호", email: "guard@example.com" } }, status: "authenticated" }) }));

const { buildIssueRequest, readIssueResponse, issueBillingKey, normalizePhone } = await import("@/app/subscribe/billing-key");
const { toConfigState, activateIssue, ACTIVATE_TEXT } = await import("@/app/subscribe/pg-client");
const { PgNotice } = await import("@/app/subscribe/PgNotice");
const { ConsentList, PlanPicker, BeneficiaryPicker } = await import("@/app/subscribe/CheckoutFields");
const {
  PgCheckout, BIG_BUTTON, checkoutMissing, payButtonLabel, runCheckout, toBuyer, defaultBeneficiary, withoutAutoRenew,
} = await import("@/app/subscribe/PgCheckout");
const { PgManage, CancelOption, cancelModes, doneText } = await import("@/app/subscribe/PgManage");
const { AppPanel, WebPanel } = await import("@/app/subscribe/SubscribeView");
const { PLAY_MANAGE_TEXT } = await import("@/app/subscribe/PlayPanel");
const { immediateView, activateView } = await import("@/app/subscribe/return/ReturnView");
const { REQUIRED_CONSENTS, PG_TERMS_VERSION } = await import("@/lib/billing/portone-consent");
const terms = await import("@/lib/billing/pg-terms");
import type { BillingStatus, PgConfig, PgStatus, PgSubscription, PreparedIssue } from "@/app/subscribe/pg-client";

const html = (el: ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");
const PLAN = { id: "day30", name: "월 이용권(하루 대화 30회)", dailyTurnLimit: 30, priceKrw: 19_900 };
const PREP: PreparedIssue = {
  storeId: "store-1", channelKey: "channel-key-x", issueId: "bk0123456789abcdef0123456789abcdef", issueName: "마음이음 월 이용권(하루 대화 30회)",
  method: "CARD", priceKrw: 19_900, customerId: "user_1", redirectUrl: "https://example.com/subscribe/return?issueId=bk01",
  beneficiary: { userId: "elder_1", name: "김어르신" },
};
const CONFIG: PgConfig = {
  enabled: true, plans: [PLAN, { id: "day60", name: "월 이용권(하루 대화 60회)", dailyTurnLimit: 60, priceKrw: 39_900 }],
  payMethods: [{ method: "CARD", label: "카드" }, { method: "KAKAOPAY", label: "카카오페이" }],
  termsVersion: PG_TERMS_VERSION, requiredConsents: [...REQUIRED_CONSENTS], role: "guardian", canPurchase: true,
  beneficiaries: [
    { userId: "elder_1", name: "김어르신", covered: false, linkedAt: "2026-09-01T03:00:00.000Z" },
    { userId: "elder_2", name: "이어르신", covered: true, linkedAt: "2026-08-15T03:00:00.000Z" },
  ],
  testModeRestricted: false,
  freeDailyTurnLimit: 10, business: { name: "주식회사 테스트", phone: "031-000-0000" }, playPurchaseEnabled: false,
};
const NONE = Object.fromEntries(REQUIRED_CONSENTS.map((k) => [k, false])) as Record<(typeof REQUIRED_CONSENTS)[number], boolean>;
const ALL = Object.fromEntries(REQUIRED_CONSENTS.map((k) => [k, true])) as Record<(typeof REQUIRED_CONSENTS)[number], boolean>;
/** 웹 결제를 가리키는 말·링크 — 앱 안에는 하나도 없어야 한다 */
const WEB_PAYMENT = /포트원|웹 결제|웹에서|이용권|자동결제|카카오페이|네이버페이|\/terms\/|\/pricing|청약철회/;

beforeEach(() => { sdk.requestIssueBillingKey.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("빌링키 발급 매개변수 — 결제수단별(research B 5)", () => {
  const base = {
    storeId: "store-1", channelKey: "channel-key-x", issueId: PREP.issueId, issueName: PREP.issueName, redirectUrl: PREP.redirectUrl, forceRedirect: true,
  };
  it("카드 — CARD + 구매자(이니시스 PC 필수) + 제공 기간 1m(모바일 필수)", () => {
    expect(buildIssueRequest(PREP, { fullName: "김보호", phoneNumber: "01012345678", email: "g@example.com" })).toEqual({
      ...base, billingKeyMethod: "CARD", offerPeriod: { interval: "1m" },
      customer: { customerId: "user_1", fullName: "김보호", phoneNumber: "01012345678", email: "g@example.com" },
    });
  });
  it("카카오페이 — EASY_PAY + customerId만, windowType·금액 표시 없음", () => {
    const r = buildIssueRequest({ ...PREP, method: "KAKAOPAY" }, { fullName: "x", phoneNumber: "01000000000", email: "x@x.co" });
    expect(r).toEqual({ ...base, billingKeyMethod: "EASY_PAY", customer: { customerId: "user_1" } });
    expect(r).not.toHaveProperty("windowType");
  });
  it("네이버페이 — EASY_PAY + customerId만 + displayAmount·currency(KRW)를 함께", () => {
    expect(buildIssueRequest({ ...PREP, method: "NAVERPAY" })).toEqual({
      ...base, billingKeyMethod: "EASY_PAY", customer: { customerId: "user_1" }, displayAmount: 19_900, currency: "KRW",
    });
  });
});

describe("발급 창 결과 — code로 판정, 문구는 그대로", () => {
  it("리디렉션(undefined) → redirected", () => { expect(readIssueResponse(undefined)).toEqual({ kind: "redirected" }); });
  it("code가 있으면 billingKey가 있어도 실패 — message를 한 글자도 바꾸지 않는다", () => {
    const message = "[NAVERPAY] 잔액이 부족합니다. (코드 NotEnoughAccountBalance)";
    expect(readIssueResponse({ transactionType: "ISSUE_BILLING_KEY", billingKey: "billing-key-x", code: "FAILURE_TYPE_PG", message }))
      .toEqual({ kind: "failed", message });
  });
  it("message가 없으면 pgMessage를 그대로", () => {
    expect(readIssueResponse({ transactionType: "ISSUE_BILLING_KEY", billingKey: "", code: "X", pgMessage: "한도 초과" }))
      .toEqual({ kind: "failed", message: "한도 초과" });
  });
  it("code 없이 billingKey → issued", () => {
    expect(readIssueResponse({ transactionType: "ISSUE_BILLING_KEY", billingKey: "billing-key-x" })).toEqual({ kind: "issued", billingKey: "billing-key-x" });
  });
  it("SDK가 결제수단별 요청을 받고, reject하면 화면 문구(팝업·다시 시도)로 바꾼다", async () => {
    sdk.requestIssueBillingKey.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("[PortOne] Failed to load window.PortOne"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await issueBillingKey({ ...PREP, method: "KAKAOPAY" })).toEqual({ kind: "redirected" });
    expect(sdk.requestIssueBillingKey.mock.calls[0][0]).toMatchObject({ billingKeyMethod: "EASY_PAY", forceRedirect: true });
    const failed = await issueBillingKey(PREP);
    expect(failed.kind).toBe("failed");
    expect(failed.kind === "failed" && failed.message).toContain("팝업 차단을 풀거나");
  });
  it.each([["010-1234-5678", "01012345678"], ["011 123 4567", "0111234567"], ["02-123-4567", null], ["0101234", null]])(
    "휴대전화 %s → %s", (v, want) => { expect(normalizePhone(v)).toBe(want); });
});

describe("서버 응답 → 화면 갈래(pg-client)", () => {
  it("config: 200 ready · 403(앱) off(+Play 스위치) · 503(꺼짐) off · 그 밖은 오류 문구", () => {
    expect(toConfigState({ ok: true, status: 200, data: CONFIG }).kind).toBe("ready");
    expect(toConfigState({ ok: false, status: 403, code: "app_webview", error: "x", body: { playPurchaseEnabled: true } }))
      .toEqual({ kind: "off", playPurchaseEnabled: true });
    expect(toConfigState({ ok: false, status: 503, code: "pg_disabled", error: "x", body: { enabled: false } }))
      .toEqual({ kind: "off", playPurchaseEnabled: false });
    expect(toConfigState({ ok: false, status: 500, code: "unknown", error: "잠시 후", body: {} })).toEqual({ kind: "error", message: "잠시 후" });
  });

  const respond = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
  it("activate 200 active · 202 processing", async () => {
    respond(200, { ok: true, status: "active" });
    expect(await activateIssue(PREP.issueId, "bkey")).toEqual({ kind: "active" });
    respond(202, { ok: true, status: "processing" });
    expect(await activateIssue(PREP.issueId, "bkey")).toEqual({ kind: "processing" });
  });
  it("activate 402 — PG 문구(pgMessage)만 그대로 보여 준다", async () => {
    respond(402, { error: "결제가 완료되지 않았어요.", code: "payment_failed", pgMessage: "카드 한도가 초과되었습니다" });
    expect(await activateIssue(PREP.issueId, "bkey")).toEqual({ kind: "failed", message: "카드 한도가 초과되었습니다" });
  });
  it.each([
    ["401 로그인 없음(다른 브라우저로 돌아옴)", 401, { error: "로그인이 필요합니다.", code: "login_required" }, true],
    ["429 요청 빈도", 429, { error: "잠시 후 다시 시도해 주세요.", code: "rate_limited" }, false],
    ["502 temporary", 502, { error: "결제 확인이 늦어지고 있어요.", code: "temporary" }, false],
    ["500 알 수 없는 오류", 500, "Internal Server Error", false],
    ["403 앱으로 오판(카드사 앱 WebView 등)", 403, { error: "이 화면에서는 이용할 수 없어요.", code: "app_webview" }, false],
  ])("activate %s — 실패가 아니라 '확인 중'(웹훅이 이어서 확정한다 — 다시 결제하라고 하지 않는다)", async (_n, status, body, needsLogin) => {
    respond(status, body);
    expect(await activateIssue(PREP.issueId, "bkey")).toEqual({ kind: "unconfirmed", needsLogin });
  });
  it("activate 네트워크 오류도 '확인 중'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(await activateIssue(PREP.issueId, "bkey")).toEqual({ kind: "unconfirmed", needsLogin: false });
  });
  it.each([
    [404, "not_found", "결제 요청을 찾을 수 없어요. 처음부터 다시 시도해 주세요."],
    [409, "duplicate", "이 분은 이미 이용권이 적용되어 있어요. 결제하지 않았어요."],
    [502, "verification_failed", "결제 확인 중 문제가 생겨 이용권 적용을 보류했어요. 고객센터로 문의해 주세요."],
    [503, "pg_disabled", "웹 결제를 준비하고 있어요."],
  ])("activate %s %s — 결과가 정해진 거절은 서버 문구 그대로", async (status, code, error) => {
    respond(status, { error, code });
    expect(await activateIssue(PREP.issueId, "bkey")).toEqual({ kind: "failed", message: error });
  });
});

describe("runCheckout — prepare → 발급 창 → 첫 결제(모의)", () => {
  function server(prepare: { status: number; body: unknown }, activate?: { status: number; body: unknown }) {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
      const r = url.endsWith("/prepare") ? prepare : activate;
      if (!r) throw new Error(`unexpected ${url}`);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  const input = {
    plan: PLAN, method: "CARD" as const, beneficiaryUserId: "elder_1", consents: ALL, buyer: { fullName: "김보호", phoneNumber: "01012345678", email: "g@example.com" },
  };

  it("prepare에는 planId·결제수단·혜택 대상·동의 넷·화면 문안 버전 + 화면에 보인 금액·한도(서버가 같은지 대조한다 — 결제 금액은 서버가 정한다)", async () => {
    const f = server({ status: 200, body: PREP });
    sdk.requestIssueBillingKey.mockResolvedValue(undefined);
    expect(await runCheckout(input)).toEqual({ kind: "redirected" });
    const body = JSON.parse(String((f.mock.calls[0][1] as RequestInit).body));
    expect(body).toEqual({
      planId: "day30", method: "CARD", beneficiaryUserId: "elder_1", consents: ALL, termsVersion: PG_TERMS_VERSION,
      expectedPriceKrw: 19_900, expectedDailyTurnLimit: 30,
    });
    // 카드만 구매자 정보를 결제창에 넘긴다
    expect(sdk.requestIssueBillingKey.mock.calls[0][0].customer).toMatchObject({ fullName: "김보호", phoneNumber: "01012345678" });
  });
  it("카카오페이로 고르면 구매자 정보를 결제창에 넘기지 않는다", async () => {
    server({ status: 200, body: { ...PREP, method: "KAKAOPAY" } });
    sdk.requestIssueBillingKey.mockResolvedValue(undefined);
    await runCheckout({ ...input, method: "KAKAOPAY" });
    expect(sdk.requestIssueBillingKey.mock.calls[0][0].customer).toEqual({ customerId: "user_1" });
  });
  it("prepare 거절은 서버 문구 그대로 — 문안·요금이 바뀜·이미 이용권이 있음은 설정을 다시 읽는다", async () => {
    server({ status: 409, body: { error: "약관이 바뀌었어요.", code: "terms_outdated" } });
    expect(await runCheckout(input)).toEqual({ kind: "error", text: "약관이 바뀌었어요.", reload: true });
    server({ status: 409, body: { error: "요금이 바뀌었어요.", code: "price_changed" } });
    expect(await runCheckout(input)).toEqual({ kind: "error", text: "요금이 바뀌었어요.", reload: true });
    server({ status: 400, body: { error: "필수 항목에 모두 동의해 주세요.", code: "consent_required" } });
    expect(await runCheckout(input)).toEqual({ kind: "error", text: "필수 항목에 모두 동의해 주세요.", reload: false });
    expect(sdk.requestIssueBillingKey).not.toHaveBeenCalled();
  });
  it("발급 창 실패 — PG 문구 그대로, 첫 결제를 부르지 않는다", async () => {
    const f = server({ status: 200, body: PREP });
    sdk.requestIssueBillingKey.mockResolvedValue({ transactionType: "ISSUE_BILLING_KEY", billingKey: "k", code: "FAILURE_TYPE_PG", message: "사용자가 결제를 취소하였습니다" });
    expect(await runCheckout(input)).toEqual({ kind: "error", text: "사용자가 결제를 취소하였습니다", reload: false });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("리디렉션 없이 돌아오면 그 빌링키로 첫 결제를 확정한다", async () => {
    const f = server({ status: 200, body: PREP }, { status: 200, body: { ok: true, status: "active" } });
    sdk.requestIssueBillingKey.mockResolvedValue({ transactionType: "ISSUE_BILLING_KEY", billingKey: "billing-key-x" });
    expect(await runCheckout(input)).toEqual({ kind: "done", text: ACTIVATE_TEXT.active });
    expect(JSON.parse(String((f.mock.calls[1][1] as RequestInit).body))).toEqual({ issueId: PREP.issueId, billingKey: "billing-key-x" });
  });
  it("첫 결제 확정 결과를 모르면(네트워크 등) 실패라 하지 않고 '확인 중' — 상태를 다시 읽는다", async () => {
    server({ status: 200, body: PREP }, { status: 502, body: { error: "결제 확인이 늦어지고 있어요.", code: "temporary" } });
    sdk.requestIssueBillingKey.mockResolvedValue({ transactionType: "ISSUE_BILLING_KEY", billingKey: "billing-key-x" });
    expect(await runCheckout(input)).toEqual({ kind: "error", text: ACTIVATE_TEXT.unconfirmed, reload: true });
  });
});

describe("결제 직전 고지(PgNotice — research D 3)", () => {
  const now = new Date("2026-11-02T05:05:00Z"); // KST 11/2 14:05
  const out = html(createElement(PgNotice, { plan: PLAN, beneficiaryName: "김어르신", methodLabel: "카드", freeDailyTurnLimit: 10, business: CONFIG.business, now }));
  it.each([
    ["상품", "마음이음 월 이용권(하루 대화 30회)"],
    ["혜택 받는 분", "김어르신님 계정(연결된 가족)"],
    ["가격·지급 방법·주기", "월 19,900원(부가세 포함) · 매월 자동결제 · 카드"],
    ["첫 결제·다음 결제일", "첫 결제는 오늘(2026년 11월 2일), 다음 결제는 2026년 12월 2일 — 해지할 때까지 매월 2일(그날이 없는 달은 말일)"],
    ["제공 기간·공급 시기", "결제일부터 다음 결제일 전날까지 · 결제가 끝나는 즉시 적용"],
    ["계속 무료", "위급 상황 감지와 보호자 위급 알림, 하루 10회 대화는 이용권 없이도 계속 무료입니다."],
    ["해지 두 방식", terms.CANCEL_SUMMARY[0]],
    ["해지 두 방식(지금 해지)", terms.CANCEL_SUMMARY[1]],
    ["청약철회 기한·방법·효과(직접)", terms.WITHDRAWAL_SUMMARY],
    ["환불 방법·기한", "3영업일"],
    ["결제 실패", terms.RETRY_SUMMARY],
    ["가격 변경", "30일 동안의 기간에 알리고 따로 동의"],
    ["결제대행·카드 정보 미저장", "카드 번호 등 결제수단 정보를 저장하지 않아요"],
    ["기술 요건", "웹 브라우저(PC·휴대폰)에서 결제·해지해요"],
    ["판매자·불만 처리", "주식회사 테스트 · 고객센터 031-000-0000 · 해결되지 않으면 한국소비자원 1372"],
  ])("%s", (_label, text) => { expect(out).toContain(text); });
  it("약관·환불정책·처리방침 링크는 새 창(고르던 내용이 사라지지 않게)", () => {
    for (const href of ["/terms/paid", "/terms/refund", "/privacy"]) {
      const a = [...out.matchAll(/<a [^>]*>/g)].map((m) => m[0]).find((tag) => tag.includes(`href="${href}"`));
      expect(a, href).toContain('target="_blank"');
    }
  });
  it("판매자 정보가 config에 없으면 화면 아래 사업자 정보를 가리킨다 · 혜택 받는 분을 아직 안 골랐으면 그렇다고(본인 계정이라 하지 않는다)", () => {
    const o = html(createElement(PgNotice, { plan: PLAN, beneficiaryName: null, methodLabel: null, freeDailyTurnLimit: 10, business: {}, now }));
    expect(o).toContain("이 화면 아래 사업자 정보");
    expect(o).toContain("혜택 받는 분</b>: 아직 고르지 않았어요");
    expect(o).not.toContain("본인 계정");
  });
});

describe("입력 칸과 버튼 — 미리 고르지 않음·동의 분리·같은 크기", () => {
  it("필수 동의 넷 — 따로, 기본 미체크, 각 '보기'(새 창)", () => {
    const out = html(createElement(ConsentList, { items: REQUIRED_CONSENTS, value: NONE, onChange: () => {}, priceKrw: 19_900, chargeDay: 2 }));
    expect(out.match(/type="checkbox"/g)).toHaveLength(4);
    // 🔒 미리 체크해 두지 않는다(시행령 제9조)
    expect(out).not.toMatch(/checked/);
    expect(out.match(/target="_blank"[^>]*>보기<\/a>/g)).toHaveLength(4);
    expect(out).toContain("매월 2일(그날이 없는 달은 말일)에 19,900원이 자동결제");
  });
  it("요금제 — 미리 고른 것이 없다, 금액은 부가세 포함", () => {
    const out = html(createElement(PlanPicker, { plans: CONFIG.plans, value: null, onChange: () => {} }));
    expect(out.match(/type="radio"/g)).toHaveLength(2);
    expect(out).not.toMatch(/checked/);
    expect(out).toContain("월 19,900원");
    expect(out).toContain("부가세 포함");
  });
  it("혜택 받는 분 — 이름과 연결한 날을 보고 고른다, 이미 이용권이 있는 분은 고를 수 없다", () => {
    const out = html(createElement(BeneficiaryPicker, { config: CONFIG, value: null, onChange: () => {} }));
    expect(out).toContain("김어르신님");
    expect(out).toContain("2026년 9월 1일 연결"); // 같은 이름으로 새로 연결된 계정과 구별할 수 있게
    expect(out).toMatch(/<input[^>]*disabled=""[^>]*value="elder_2"|<input[^>]*value="elder_2"[^>]*disabled=""/);
    expect(out).toContain("이미 이용권이 있어요");
  });
  it("고를 분이 하나여도 최근 7일 안에 연결된 분은 미리 고르지 않는다(보호자 코드를 아는 사람이 같은 이름으로 연결해 결제 대상을 바꿔치기하지 못하게)", () => {
    const now = new Date("2026-11-02T05:05:00Z");
    expect(defaultBeneficiary(CONFIG, now)).toBe("elder_1"); // 두 달 전에 연결
    const fresh = { ...CONFIG, beneficiaries: [{ userId: "elder_9", name: "김어르신", covered: false, linkedAt: "2026-10-30T03:00:00.000Z" }] };
    expect(defaultBeneficiary(fresh, now)).toBeNull();
    const two = { ...CONFIG, beneficiaries: [...CONFIG.beneficiaries, { userId: "elder_3", name: "박", covered: false, linkedAt: "2026-01-01T00:00:00.000Z" }] };
    expect(defaultBeneficiary(two, now)).toBeNull();
  });
  it("요금제·혜택 받는 분·결제수단을 바꾸면 금액이 적힌 자동결제 동의를 다시 미체크로(미리 체크해 둔 것과 같아지지 않게)", () => {
    const after = withoutAutoRenew(ALL);
    expect(after).toEqual({ ...ALL, autoRenew: false });
    expect(ALL.autoRenew).toBe(true); // 원래 값은 그대로(새 객체)
    const src = readFileSync("app/subscribe/PgCheckout.tsx", "utf-8");
    for (const picker of ["PlanPicker", "BeneficiaryPicker", "MethodPicker"]) {
      expect(src, picker).toMatch(new RegExp(`<${picker}[^>]*onChange=\\{[^}]*withoutAutoRenew`));
    }
  });
  it("일반 회원 결제 갈래는 없다 — 결제는 보호자만(일반 회원은 하루 대화 한도가 없다)", () => {
    for (const f of ["app/subscribe/PgCheckout.tsx", "app/subscribe/CheckoutFields.tsx"]) {
      expect(readFileSync(f, "utf-8"), f).not.toContain('"general"');
    }
  });
  it("첫 화면 — 결제 버튼은 눌리지 않고, 고지·동의는 요금제를 고른 뒤에, 결제·취소 버튼은 같은 크기", () => {
    const out = html(createElement(PgCheckout, { config: CONFIG, me: { name: "김보호", email: "g@example.com" }, onChanged: () => {}, onNotice: () => {} }));
    expect(out).toContain("요금제를 고르면 결제 전에 확인할 내용과 동의 항목이 나와요.");
    expect(out).not.toContain('type="checkbox"');
    const buttons = [...out.matchAll(/<button type="button"([^>]*)>([^<]*)<\/button>/g)];
    expect(buttons.map((b) => b[2])).toEqual(["자동결제 시작", "취소"]);
    expect(buttons[0][1]).toContain("disabled");
    // 🔒 크기·모양은 같고 색만 다르다(제21조의2①3호)
    const shape = (attrs: string) => attrs.match(/class="([^"]*)"/)?.[1].split(" ").filter((c) => !/^(bg-|text-white|hover:)/.test(c)).sort();
    expect(shape(buttons[0][1])).toEqual(shape(buttons[1][1]));
    expect(shape(buttons[0][1])).toEqual(BIG_BUTTON.split(" ").sort());
  });
  it("결제 버튼 문구 — 금액과 '매월 자동결제'", () => {
    expect(payButtonLabel(PLAN, false)).toBe("매월 19,900원 자동결제 시작");
    expect(payButtonLabel(null, false)).toBe("자동결제 시작");
    expect(payButtonLabel(PLAN, true)).toBe("결제창을 여는 중…");
  });
  it("남은 것 — 요금제·혜택 받는 분·결제수단·카드 정보(카드일 때만)·필수 동의(넷 다)", () => {
    expect(checkoutMissing({ plan: null, hasTarget: false, method: null, cardBuyer: null, consents: NONE }))
      .toEqual(["요금제", "혜택 받는 분", "결제수단", "필수 동의"]);
    expect(checkoutMissing({ plan: PLAN, hasTarget: true, method: "CARD", cardBuyer: null, consents: ALL }))
      .toEqual(["카드 결제 정보(이름·휴대전화·이메일)"]);
    expect(checkoutMissing({ plan: PLAN, hasTarget: true, method: "KAKAOPAY", cardBuyer: null, consents: { ...ALL, privacyEntrust: false } }))
      .toEqual(["필수 동의"]);
    expect(checkoutMissing({ plan: PLAN, hasTarget: true, method: "KAKAOPAY", cardBuyer: null, consents: ALL })).toEqual([]);
    expect(toBuyer({ fullName: " 김보호 ", phone: "010-1234-5678", email: "g@example.com" })).toEqual({ fullName: "김보호", phoneNumber: "01012345678", email: "g@example.com" });
    expect(toBuyer({ fullName: "김보호", phone: "02-123-4567", email: "g@example.com" })).toBeNull();
  });
});

const SUB: PgSubscription = {
  subscriptionId: "sub_1", status: "active", plan: { id: "day30", name: "월 이용권(하루 대화 30회)", dailyTurnLimit: 30, priceKrw: 19_900 },
  payMethodLabel: "카카오페이", beneficiary: { userId: "elder_1", name: "김어르신" },
  expiresAt: "2026-12-02T01:00:00.000Z", nextChargeAt: "2026-12-02T01:00:00.000Z", cancelAtPeriodEnd: false,
  usedPaidBenefit: true, withinWithdrawal: false,
  cancelOptions: { periodEnd: { endsAt: "2026-12-02T01:00:00.000Z", refundKrw: 0 }, immediate: { refundKrw: 10_746, rule: "immediate", usedDays: 12, periodDays: 30, paidKrw: 19_900 } },
};
const PG: PgStatus = {
  subscriptions: [SUB],
  payments: [
    { subscriptionId: "sub_1", kind: "first", amountKrw: 19_900, status: "paid", paidAt: "2026-11-02T05:05:00.000Z", cancelledKrw: 0, receiptUrl: "https://receipt.example.com/r1", failureReason: null, updatedAt: "2026-11-02T05:05:00.000Z" },
    { subscriptionId: "sub_1", kind: "retry", amountKrw: 19_900, status: "failed", paidAt: null, cancelledKrw: 0, receiptUrl: null, failureReason: "[NAVERPAY] 잔액 부족", updatedAt: "2026-10-03T01:00:00.000Z" },
  ],
};

describe("구독 관리(PgManage)", () => {
  const out = html(createElement(PgManage, { pg: PG, onChanged: () => {}, onNotice: () => {} }));
  it("요금제·가격·결제수단·혜택 받는 분·이용 기간(다음 결제일 전날까지 — 약관·메일과 같은 날)·다음 결제일·'유료 혜택 사용: 있음/없음'", () => {
    for (const s of ["월 이용권(하루 대화 30회)", "· 월 19,900원", "카카오페이", "김어르신님", "<dd>2026년 12월 1일까지</dd>", "다음 결제: 2026년 12월 2일 19,900원"]) {
      expect(out, s).toContain(s);
    }
    expect(out).toMatch(/<dt class="font-semibold">유료 혜택 사용<\/dt><dd>있음<\/dd>/);
    expect(html(createElement(PgManage, { pg: { ...PG, subscriptions: [{ ...SUB, usedPaidBenefit: false }] }, onChanged: () => {}, onNotice: () => {} })))
      .toMatch(/유료 혜택 사용<\/dt><dd>없음<\/dd>/);
  });
  it("[해지하기]는 첫 화면에, 가입 버튼과 같은 크기", () => {
    const btn = out.match(/<button type="button" class="([^"]*)">해지하기<\/button>/);
    expect(btn).not.toBeNull();
    expect(btn?.[1].startsWith(BIG_BUTTON)).toBe(true);
  });
  it("결제 내역 — 금액·일시·상태·영수증(새 창), 실패 사유는 PG 문구 그대로", () => {
    expect(out).toContain("2026년 11월 2일 · 19,900원");
    expect(out).toContain("결제 완료");
    expect(out).toMatch(/<a href="https:\/\/receipt\.example\.com\/r1" target="_blank" rel="noopener noreferrer"[^>]*>영수증<\/a>/);
    expect(out).toContain("[NAVERPAY] 잔액 부족");
  });
  it("해지 두 방식 — 같은 모양, 방식별 효과와 예상 환불액", () => {
    const a = html(createElement(CancelOption, { mode: "period_end", sub: SUB, checked: false, onPick: () => {} }));
    const b = html(createElement(CancelOption, { mode: "now", sub: SUB, checked: false, onPick: () => {} }));
    expect(a).toContain("다음 결제부터 해지");
    expect(a).toContain("2026년 12월 1일까지 그대로 이용, 환불 없음");
    expect(b).toContain("지금 해지");
    expect(b).toContain("예상 환불액 10,746원");
    expect(b).toContain("이용한 12일과 남은 기간 요금의 10%를 빼요.");
    // 🔒 같은 크기·같은 방식(research D 6) — 겉 모양(label 클래스)이 같다
    expect(a.match(/^<label class="([^"]*)"/)?.[1]).toBe(b.match(/^<label class="([^"]*)"/)?.[1]);
  });
  it("해지 예약된 이용권 — 마지막 이용일(다음 결제일 전날)까지 쓰고 그 뒤 결제 없음 · 해지 완료 문구도 같은 날", () => {
    const canceled = { ...SUB, status: "canceled", cancelAtPeriodEnd: true };
    expect(html(createElement(PgManage, { pg: { ...PG, subscriptions: [canceled] }, onChanged: () => {}, onNotice: () => {} })))
      .toContain("해지 예약됨 — 2026년 12월 1일까지 이용하고, 그 뒤로는 결제되지 않아요.");
    expect(doneText("period_end", {}, SUB)).toBe("해지 예약을 마쳤어요. 2026년 12월 1일까지 그대로 이용하고, 그 뒤로는 결제되지 않아요.");
  });
  it("결제 재시도 중(grace) — 해지는 한 가지(결제를 멈추고 지금 끝내기)뿐이고 혜택도 지금 끝난다고 적는다('그대로 이용'이라 하지 않는다)", () => {
    const grace = { ...SUB, status: "grace", cancelOptions: { ...SUB.cancelOptions!, immediate: { ...SUB.cancelOptions!.immediate, refundKrw: 0 } } };
    expect(cancelModes(grace)).toEqual(["period_end"]);
    expect(cancelModes(SUB)).toEqual(["period_end", "now"]);
    expect(cancelModes({ ...SUB, status: "canceled" })).toEqual(["now"]);
    const opt = html(createElement(CancelOption, { mode: "period_end", sub: grace, checked: false, onPick: () => {} }));
    expect(opt).toContain("결제를 멈추고 지금 끝내기");
    expect(opt).toContain("혜택도 지금 끝나요");
    expect(opt).not.toContain("그대로 이용");
    expect(doneText("period_end", {}, grace)).toBe("결제를 멈추고 이용권을 끝냈어요. 더 결제되지 않아요.");
    const card = html(createElement(PgManage, { pg: { ...PG, subscriptions: [grace] }, onChanged: () => {}, onNotice: () => {} }));
    expect(card).toContain("<dd>결제 재시도 중(혜택 유지)</dd>");
  });
  it("결제 내역 — 최근 5건을 먼저 보이고 나머지는 [더 보기](언제든 열람 — 제8조③)", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...PG.payments[0], paidAt: `2026-${String(4 + i).padStart(2, "0")}-02T05:05:00.000Z` }));
    const o = html(createElement(PgManage, { pg: { ...PG, payments: many }, onChanged: () => {}, onNotice: () => {} }));
    expect(o.match(/<li /g)).toHaveLength(5);
    expect(o).toContain(">결제 내역 더 보기(2건)</button>");
    expect(o).toContain("결제 내역</h3>");
  });
  it("결제일부터 7일 안 — 지금 해지는 '청약철회'로, 미사용이면 전액이라고", () => {
    const sub = { ...SUB, withinWithdrawal: true, usedPaidBenefit: false, cancelOptions: { ...SUB.cancelOptions!, immediate: { ...SUB.cancelOptions!.immediate, rule: "withdrawal", refundKrw: 19_900 } } };
    const b = html(createElement(CancelOption, { mode: "now", sub, checked: false, onPick: () => {} }));
    expect(b).toContain("지금 해지(청약철회)");
    expect(b).toContain("예상 환불액 19,900원");
    expect(b).toContain("유료 혜택을 쓰지 않아 전액이에요.");
  });
});

describe("앱 안(AppPanel) — 웹 결제 없음, Play 버튼은 스위치가 켜졌을 때만", () => {
  const ST: BillingStatus = {
    tier: "free", expiresAt: null, source: "none", guardianFeatures: false, beneficiaryName: null, usage: null,
    productIds: ["maeum_pro_monthly"], enforced: false, playPurchaseEnabled: false, pg: null,
  };
  const app = (st: BillingStatus) => html(createElement(AppPanel, { st, onReload: () => {}, onError: () => {} }));

  it("기본(스위치 꺼짐) — 구매 버튼도 혜택 설명도 없이 상태만", () => {
    expect(app(ST)).toBe("");
  });
  it("구독 중 — Play 해지 안내만(Play로 결제한 구독에 한정한 말), 웹 결제 문구 없음", () => {
    const out = app({ ...ST, tier: "pro", source: "purchaser" });
    expect(out).toContain(PLAY_MANAGE_TEXT);
    expect(out.match(WEB_PAYMENT)?.[0] ?? null).toBeNull();
  });
  it("스위치 켜짐 + 최신 앱 — [구독하기]와 혜택 설명, 웹 결제 문구 없음", () => {
    vi.stubGlobal("window", { MAEUM_APP_VERSION: "1.2.0" });
    const out = app({ ...ST, playPurchaseEnabled: true });
    expect(out).toContain(">구독하기</button>");
    expect(out).toContain("구독하면");
    expect(out.match(WEB_PAYMENT)?.[0] ?? null).toBeNull();
  });
});

describe("브라우저(WebPanel) — 역할·스위치별 갈래", () => {
  const ST: BillingStatus = {
    tier: "free", expiresAt: null, source: "none", guardianFeatures: false, beneficiaryName: null, usage: null,
    productIds: [], enforced: false, playPurchaseEnabled: false, pg: { subscriptions: [], payments: [] },
  };
  const web = (st: BillingStatus, cfg: Parameters<typeof WebPanel>[0]["cfg"]) => html(createElement(WebPanel, { st, cfg, onChanged: () => {}, onNotice: () => {} }));

  it("보호자 — 이용권 신청(혜택 받는 분 고르기)", () => {
    const out = web(ST, { kind: "ready", config: CONFIG });
    expect(out).toContain("월 이용권 신청");
    expect(out).toContain("김어르신님");
  });
  it.each([
    ["user", "보호자 계정"], ["pro", "의사 계정에서는 이용권을 결제할 수 없어요"],
    ["general", "일반 회원 계정에는 하루 대화 한도가 없어 이용권이 필요 없어요"],
  ])("%s 계정 — 결제 화면 대신 안내만", (role, text) => {
    const out = web(ST, { kind: "ready", config: { ...CONFIG, role, canPurchase: false, beneficiaries: [] } });
    expect(out).toContain(text);
    expect(out).not.toContain("자동결제 시작");
    expect(out).not.toContain("월 이용권 신청");
  });
  it("시험 운영 중(허용 목록 밖 보호자) — 역할 안내가 아니라 '지금은 신청할 수 없다'고", () => {
    const out = web(ST, { kind: "ready", config: { ...CONFIG, canPurchase: false, testModeRestricted: true } });
    expect(out).toContain("지금은 시험 운영 중이라 이용권을 신청할 수 없어요.");
    expect(out).not.toContain("보호자 계정</b>에서 신청");
    expect(out).not.toContain("자동결제 시작");
  });
  it("연결된 어르신이 없는 보호자 — 연결 안내만(결제 칸 없음)", () => {
    const out = web(ST, { kind: "ready", config: { ...CONFIG, beneficiaries: [] } });
    expect(out).toContain("먼저 어르신 계정과 연결해 주세요");
    expect(out).not.toContain("자동결제 시작");
  });
  it("판매가 꺼져도(off) 가입한 이용권의 관리·해지는 보인다 — 해지를 막으면 해지 방해", () => {
    const out = web({ ...ST, pg: PG }, { kind: "off", playPurchaseEnabled: false });
    expect(out).toContain("구독 관리");
    expect(out).toContain(">해지하기</button>");
  });
  it("판매가 꺼졌고 가입한 이용권도 Play 구매도 없으면 '준비 중' — 앱에서 결제하라고 하지 않는다", () => {
    const out = web(ST, { kind: "off", playPurchaseEnabled: false });
    expect(out).toContain("구독 결제는 아직 준비 중이에요.");
    expect(out).not.toContain("마음이음 앱</b>에서 진행됩니다");
    expect(web({ ...ST, playPurchaseEnabled: true }, { kind: "off", playPurchaseEnabled: false })).toContain("<b>마음이음 앱</b>에서 진행됩니다");
  });
});

describe("결제창 복귀(/subscribe/return) — 쿼리만으로 정해지는 결과", () => {
  const q = { issueId: PREP.issueId, billingKey: "billing-key-x", code: null, message: null, pgMessage: null };
  it("code가 있고 내 발급 시도로 확인되면(trusted) 실패 — message를 그대로(가공 없음)", () => {
    expect(immediateView({ ...q, code: "FAILURE_TYPE_PG", message: "[NAVERPAY] 결제가 거절되었습니다" }, true))
      .toEqual({ kind: "error", text: "[NAVERPAY] 결제가 거절되었습니다" });
    expect(immediateView({ ...q, code: "X", pgMessage: "한도 초과" }, true)).toEqual({ kind: "error", text: "한도 초과" });
  });
  it("확인되지 않은 링크(남이 만든 주소·로그인 없음)의 문구는 보여 주지 않는다 — 고정 안내만(결제 화면에 피싱 문구가 뜨지 않게)", () => {
    const phishing = "결제 오류로 이중 결제되었습니다. 고객센터 070-0000-0000으로 연락 주세요";
    const v = immediateView({ ...q, code: "FAILURE_TYPE_PG", message: phishing }, false);
    expect(v).toEqual({ kind: "error", text: "결제수단 등록이 끝나지 않았어요. 구독 화면에서 다시 시도해 주세요." });
  });
  it("너무 긴 문구는 잘라 보이지 않고(가공 금지) 고정 안내로", () => {
    expect(immediateView({ ...q, code: "X", message: "가".repeat(301) }, true))
      .toEqual({ kind: "error", text: "결제수단 등록이 끝나지 않았어요. 구독 화면에서 다시 시도해 주세요." });
  });
  it("issueId·billingKey가 없으면 확인할 수 없다고 · 다 있으면 첫 결제 확정을 부른다(null)", () => {
    expect(immediateView({ ...q, billingKey: null }, true)?.kind).toBe("error");
    expect(immediateView(q, false)).toBeNull();
  });
  it("첫 결제 확정 결과 → 화면: 확인 중(unconfirmed)은 실패처럼 보이지 않고, 로그인이 없으면 로그인 링크를 함께", () => {
    expect(activateView({ kind: "active" })).toEqual({ kind: "ok", text: ACTIVATE_TEXT.active });
    expect(activateView({ kind: "processing" })).toEqual({ kind: "ok", text: ACTIVATE_TEXT.processing });
    expect(activateView({ kind: "unconfirmed", needsLogin: true })).toEqual({ kind: "info", text: ACTIVATE_TEXT.unconfirmed, needsLogin: true });
    expect(activateView({ kind: "failed", message: "카드 한도가 초과되었습니다" })).toEqual({ kind: "error", text: "카드 한도가 초과되었습니다" });
  });
});
