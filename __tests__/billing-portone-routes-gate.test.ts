/**
 * 포트원 결제 API의 관문(lib/billing/portone-route pgGate) — 기능 스위치·앱 WebView 거절·로그인·오리진·요청 빈도.
 *
 * 지키는 것:
 *   · BILLING_PG_ENABLED가 정확히 "1"이 아니면(또는 필수 설정이 빠지면) 새 가입 API(config·prepare·activate)는 503 — DB에 아무것도 쓰지 않는다.
 *   · 포트원 키가 없으면(설정 전) 해지·환불·웹훅·예약 작업·구독 상태의 pg도 전부 꺼진다(운영 변화 0).
 *   · 판매 스위치만 꺼졌으면 이미 결제한 이용권은 해지할 수 있다(해지 방해 금지 — 포트원 예약 결제는 스위치와 무관하게 실행된다).
 *   · 앱(MaeumApp) WebView의 새 가입 요청은 403 — 응답에 요금제·상점 아이디·채널 키 같은 PG 정보가 없다(Play 결제 정책).
 *     카카오톡·구글 앱·덕덕고 등 다른 앱의 인앱 브라우저는 앱으로 오판하지 않는다(그 링크로 연 보호자가 결제할 수 있어야 한다).
 *   · 해지·청약철회는 우리 앱이 틀림없을 때만(X-Requested-With·앱 UA 접미사) 403 — WebView 표지만으로 막으면 해지 방해다.
 *   · 로그인 필수 · 다른 사이트에서 온 쓰기 요청(Origin 불일치) 거절 · 계정당 요청 빈도 제한.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  db, pg, mail, auth, apiReq, read, loginAs, setRole, rate, startSubscription, subRow, kst, APP_UA, CHROME_UA, BASE, CONSENT,
} from "./helpers/billing-portone-route-harness";

const config = () => import("@/app/api/billing/portone/config/route");
const prepare = () => import("@/app/api/billing/portone/prepare/route");
const activate = () => import("@/app/api/billing/portone/activate/route");
const cancel = () => import("@/app/api/billing/portone/cancel/route");
const refund = () => import("@/app/api/billing/portone/refund/route");
const webhook = () => import("@/app/api/billing/portone/webhook/route");
const cron = () => import("@/app/api/cron/billing/route");
const status = () => import("@/app/api/billing/status/route");
const routeLib = () => import("@/lib/billing/portone-route");

const consents = Object.fromEntries(CONSENT.items.map((k) => [k, true]));
const prepareBody = {
  planId: "day30", method: "CARD", beneficiaryUserId: "elder-1", consents, termsVersion: "2026-10-22", expectedPriceKrw: 19_900, expectedDailyTurnLimit: 30,
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(kst("2026-11-02T14:05:00"));
  setRole("guardian-1", "guardian", "보호자");
  setRole("elder-1", "user", "김영자");
  db.expertPatient.rows.push({ id: "link-1", expertUserId: "guardian-1", patientUserId: "elder-1", status: "active", createdAt: new Date() });
  loginAs("guardian-1");
});
afterEach(() => vi.useRealTimers());

/** 새 가입 API 셋 — 같은 요청을 다시 만들 수 있게 함수로 */
const salesCalls = [
  ["config", async (ua?: string) => (await config()).GET(apiReq("/api/billing/portone/config", { ua }))],
  ["prepare", async (ua?: string) => (await prepare()).POST(apiReq("/api/billing/portone/prepare", { body: prepareBody, ua }))],
  ["activate", async (ua?: string) => (await activate()).POST(apiReq("/api/billing/portone/activate", {
    body: { issueId: `bk${"0".repeat(32)}`, billingKey: "billing-key-x" }, ua,
  }))],
] as const;

describe("앱 WebView 판별 — 우리 앱만 막고, 다른 앱의 인앱 브라우저는 막지 않는다", () => {
  it.each([
    ["우리 앱 WebView 기본 UA(; wv)", true, { "user-agent": APP_UA }],
    ["X-Requested-With: com.maeumapp(크롬 UA라도)", true, { "user-agent": CHROME_UA, "x-requested-with": "com.maeumapp" }],
    ["앱이 UA 접미사를 붙인 경우(MaeumApp/1.3.0)", true, { "user-agent": `${CHROME_UA} MaeumApp/1.3.0` }],
    ["카카오톡 인앱 브라우저(; wv) + KAKAOTALK", false, { "user-agent": `${APP_UA};KAKAOTALK 2409030`, "x-requested-with": "com.kakao.talk" }],
    ["네이버 앱 인앱 브라우저", false, { "user-agent": `${APP_UA} NAVER(inapp; search; 2000; 12.10.3)` }],
    ["구글 앱(GSA) 인앱 브라우저", false, { "user-agent": `${APP_UA} GSA/15.40.38.29.arm64` }],
    ["덕덕고 브라우저(WebView 기반)", false, { "user-agent": `${APP_UA} DuckDuckGo/5` }],
    ["당근 인앱 브라우저", false, { "user-agent": `${APP_UA} DaangnApp/24.41.0` }],
    ["토스 인앱 브라우저", false, { "user-agent": `${APP_UA} TossApp/5.190.0` }],
    ["카카오페이 인앱 브라우저", false, { "user-agent": `${APP_UA} KAKAOPAY/7.5.0` }],
    ["목록에 없는 앱이라도 X-Requested-With가 다른 패키지면 우리 앱이 아니다", false, { "user-agent": APP_UA, "x-requested-with": "com.example.reader" }],
    ["X-Requested-With: XMLHttpRequest는 패키지가 아니다 — UA로 가른다", true, { "user-agent": APP_UA, "x-requested-with": "XMLHttpRequest" }],
    ["안드로이드 크롬", false, { "user-agent": "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36" }],
    ["삼성 인터넷", false, { "user-agent": "Mozilla/5.0 (Linux; Android 14; SM-S921N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36" }],
    ["PC 크롬", false, { "user-agent": CHROME_UA }],
  ])("%s → 앱 %s", async (_name, expected, headers) => {
    const { isAppWebViewRequest } = await routeLib();
    expect(isAppWebViewRequest(new Request(`${BASE}/api/x`, { headers }))).toBe(expected);
  });

  // 해지·환불·구독 관리 정보는 이 판별로만 막는다 — WebView 표지(; wv)는 목록에 없는 인앱 브라우저도 갖고 있어 해지를 막을 수 있다
  it.each([
    ["X-Requested-With: com.maeumapp", true, { "user-agent": APP_UA, "x-requested-with": "com.maeumapp" }],
    ["앱 UA 접미사(MaeumApp/1.3.0)", true, { "user-agent": `${APP_UA} MaeumApp/1.3.0` }],
    ["WebView 표지(; wv)만", false, { "user-agent": APP_UA }],
    ["PC 크롬", false, { "user-agent": CHROME_UA }],
  ])("우리 앱이 틀림없나: %s → %s", async (_name, expected, headers) => {
    const { isDefiniteAppRequest } = await routeLib();
    expect(isDefiniteAppRequest(new Request(`${BASE}/api/x`, { headers }))).toBe(expected);
  });
});

describe("기능 스위치 — BILLING_PG_ENABLED가 정확히 1이 아니면 새 가입 API는 꺼진다", () => {
  it.each(salesCalls)("%s: 스위치 미설정 → 503 pg_disabled, DB에 쓰지 않는다", async (_name, call) => {
    delete process.env.BILLING_PG_ENABLED;
    const r = await read(await call());
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: "pg_disabled", enabled: false });
    expect(db.subscription.rows).toHaveLength(0);
    expect(pg.log).toEqual([]);
  });

  it.each([["true"], [" 1"], ["0"]])("스위치 값 %j는 꺼짐", async (v) => {
    process.env.BILLING_PG_ENABLED = v;
    expect((await read(await salesCalls[1][1]())).status).toBe(503);
  });

  it("스위치가 1이어도 필수 설정(API Secret)이 빠지면 꺼짐", async () => {
    delete process.env.PORTONE_API_SECRET;
    expect((await read(await salesCalls[0][1]())).status).toBe(503);
  });
});

describe("포트원 설정 전(키 없음) — 이미 있는 이용권 쪽 API도 꺼져 있다(운영 변화 0)", () => {
  beforeEach(() => { delete process.env.PORTONE_API_SECRET; delete process.env.PORTONE_STORE_ID; delete process.env.BILLING_PG_ENABLED; });

  it("해지·청약철회 503", async () => {
    const c = await read(await (await cancel()).POST(apiReq("/api/billing/portone/cancel", { body: { subscriptionId: "s1", mode: "now" } })));
    const f = await read(await (await refund()).POST(apiReq("/api/billing/portone/refund", { body: { subscriptionId: "s1" } })));
    expect([c.status, f.status]).toEqual([503, 503]);
  });

  it("웹훅 503(포트원이 나중에 재전송) · 예약 작업은 아무것도 하지 않는다", async () => {
    const w = await (await webhook()).POST(new Request(`${BASE}/api/billing/portone/webhook`, { method: "POST", body: "{}" }));
    expect(w.status).toBe(503);
    process.env.CRON_SECRET = "cron-secret-test-value";
    const c = await read(await (await cron()).GET(new Request(`${BASE}/api/cron/billing`, { headers: { authorization: "Bearer cron-secret-test-value" } })));
    expect(c.body).toEqual({ ok: true, skipped: "pg_not_configured" });
    expect(db.subscription.findMany).not.toHaveBeenCalled();
  });

  it("구독 상태의 pg는 null — 결제 표를 조회하지 않는다", async () => {
    const r = await read(await (await status()).GET(apiReq("/api/billing/status")));
    expect(r.status).toBe(200);
    expect(r.body.pg).toBeNull();
    expect(db.billingPayment.findMany).not.toHaveBeenCalled();
  });
});

describe("운영 중 API Secret이 빠지면(교체 실수·만료) — 포트원은 예약 결제를 계속하므로 해지·관리는 열려 있어야 한다(10-22 검토)", () => {
  beforeEach(() => { delete process.env.PORTONE_API_SECRET; delete process.env.BILLING_PG_ENABLED; });

  it("지금 해지 → 의사는 기록(revoked), 환불은 미뤄짐 202 — 503으로 막지 않는다", async () => {
    process.env.PORTONE_API_SECRET = "secret-test";
    const s = await startSubscription({ seed: false });
    delete process.env.PORTONE_API_SECRET;
    pg.failRevokeWith = "UNAUTHORIZED"; // Secret 없이 부른 포트원 — 시험마다 초기화되는 하네스 값(남아도 다음 시험으로 새지 않는다)
    vi.setSystemTime(kst("2026-11-13T09:00:00"));
    const r = await read(await (await cancel()).POST(apiReq("/api/billing/portone/cancel", { body: { subscriptionId: s.subscriptionId, mode: "now" } })));
    expect(r.status).toBe(202);
    expect(subRow(s.subscriptionId).status).toBe("revoked");
  });

  it("구독 관리 정보(pg)가 실리고 · 예약 작업은 돌며 API Secret이 없다고 운영 경보", async () => {
    process.env.PORTONE_API_SECRET = "secret-test";
    await startSubscription({ seed: false });
    delete process.env.PORTONE_API_SECRET;
    const st = await read(await (await status()).GET(apiReq("/api/billing/status")));
    expect(st.body.pg).toMatchObject({ subscriptions: [expect.objectContaining({ status: "active" })] });
    const c = await read(await (await cron()).GET(new Request(`${BASE}/api/cron/billing`, { headers: { authorization: "Bearer cron-secret-test-value" } })));
    expect(c.body).toMatchObject({ ok: true });
    expect(mail.ops.map((o) => o.subject)).toContain("[결제] 포트원 API Secret 없음 — 결제 반영·해지 정리가 멈춰 있다");
  });
});

describe("판매 스위치만 끄면 — 새로 팔지 않지만 이미 결제한 이용권은 해지할 수 있다(해지 방해 금지)", () => {
  it("스위치를 끈 뒤: 발급 준비 503, 다음 결제부터 해지 200(예약 취소 → 빌링키 삭제)", async () => {
    const s = await startSubscription({ seed: false });
    process.env.BILLING_PG_ENABLED = "0";
    expect((await read(await salesCalls[1][1]())).status).toBe(503);
    const r = await read(await (await cancel()).POST(apiReq("/api/billing/portone/cancel", { body: { subscriptionId: s.subscriptionId, mode: "period_end" } })));
    expect(r.status).toBe(200);
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", billingKeyEnc: null });
    expect(pg.log.filter((l) => l.startsWith("revoke:") || l.startsWith("deleteKey:"))).toEqual([`revoke:${s.billingKey}`, `deleteKey:${s.billingKey}`]);
  });
});

describe("앱 WebView 요청은 거절 — PG 정보를 싣지 않는다", () => {
  it.each(salesCalls)("%s: 403 app_webview, 요금제·상점·채널 정보 없음, DB 변화 없음", async (_name, call) => {
    const r = await read(await call(APP_UA));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("app_webview");
    expect(r.text).not.toMatch(/store-test|channel-key|day30|19900|포트원|결제/);
    expect(db.subscription.rows).toHaveLength(0);
  });

  it("해지·청약철회는 WebView 표지(; wv)만으로 막지 않는다 — 목록 밖 인앱 브라우저(당근·토스 등)를 오판해 해지를 막으면 해지 방해다", async () => {
    const s = await startSubscription({ seed: false });
    const unknownInApp = `${APP_UA} SomeShoppingApp/3.2`;
    const r = await read(await (await cancel()).POST(apiReq("/api/billing/portone/cancel", {
      body: { subscriptionId: s.subscriptionId, mode: "period_end" }, ua: unknownInApp,
    })));
    expect(r.status).toBe(200);
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", cancelAtPeriodEnd: true });
    const f = await (await refund()).POST(apiReq("/api/billing/portone/refund", { body: { subscriptionId: "nope" }, ua: unknownInApp }));
    expect(f.status).toBe(404); // 앱 거절(403)이 아니라 평소 판단
  });

  it("우리 앱이 틀림없으면(X-Requested-With: com.maeumapp) 해지·청약철회도 403 — 브라우저에서 다시 열라고 알린다", async () => {
    const headers = { "x-requested-with": "com.maeumapp" };
    const c = await read(await (await cancel()).POST(apiReq("/api/billing/portone/cancel", { body: { subscriptionId: "s1", mode: "now" }, ua: APP_UA, headers })));
    const f = await read(await (await refund()).POST(apiReq("/api/billing/portone/refund", { body: { subscriptionId: "s1" }, ua: APP_UA, headers })));
    expect([c.status, f.status]).toEqual([403, 403]);
    expect([c.body.code, f.body.code]).toEqual(["app_webview", "app_webview"]);
    expect(c.body.error).toContain("크롬·삼성 인터넷 같은 브라우저에서 다시 열어 주세요");
  });

  it("가입 거절 문구에는 브라우저로 옮기라는 안내를 싣지 않는다(앱 안에서 보이면 바깥 결제로 이끄는 말이 된다)", async () => {
    const r = await read(await salesCalls[1][1](APP_UA));
    expect(r.body.error).toBe("이 화면에서는 이용할 수 없어요.");
  });

  it("앱 응답에도 Play 구매 버튼 스위치는 실린다(BILLING_PLAY_ENABLED=1일 때만 true)", async () => {
    process.env.BILLING_PLAY_ENABLED = "1";
    expect((await read(await salesCalls[0][1](APP_UA))).body.playPurchaseEnabled).toBe(true);
    delete process.env.BILLING_PLAY_ENABLED;
    expect((await read(await salesCalls[0][1](APP_UA))).body.playPurchaseEnabled).toBe(false);
  });

  it("카카오톡 인앱 브라우저로 연 보호자는 발급 준비를 할 수 있다", async () => {
    const r = await read(await salesCalls[1][1](`${APP_UA};KAKAOTALK 2409030`));
    expect(r.status).toBe(200);
  });
});

describe("로그인·오리진·요청 빈도", () => {
  it("로그인하지 않으면 401", async () => {
    auth.session = null;
    for (const [, call] of salesCalls) expect((await read(await call())).status).toBe(401);
    const c = await (await cancel()).POST(apiReq("/api/billing/portone/cancel", { body: { subscriptionId: "s1", mode: "now" } }));
    expect(c.status).toBe(401);
  });

  it("다른 사이트에서 보낸 쓰기 요청(Origin 불일치)은 403 — 같은 오리진·NEXTAUTH_URL 오리진은 통과", async () => {
    const { POST } = await prepare();
    const evil = await read(await POST(apiReq("/api/billing/portone/prepare", { body: prepareBody, origin: "https://evil.example" })));
    expect(evil.status).toBe(403);
    expect(evil.body.code).toBe("cross_site");
    expect(db.subscription.rows).toHaveLength(0);
    expect((await read(await POST(apiReq("/api/billing/portone/prepare", { body: prepareBody })))).status).toBe(200);
  });

  it("계정당 요청 빈도를 넘으면 429 — 키는 계정별", async () => {
    rate.ok = false;
    const r = await read(await salesCalls[1][1]());
    expect(r.status).toBe(429);
    expect(rate.keys).toEqual(["billing-pg-prepare:guardian-1"]);
    expect(db.subscription.rows).toHaveLength(0);
  });
});
