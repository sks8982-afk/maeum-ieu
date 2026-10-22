/**
 * 웹 PG 화면의 배치·경계(2026-10-22) — 어디서 무엇이 보이고 무엇이 막히는가.
 *
 * 지키는 것:
 *   · 공개 경로: /pricing·/terms/*·/subscribe(/return)는 로그인 미들웨어를 거치지 않는다(PG 심사 — 로그인 없이 요금·약관),
 *     /api/billing/portone/webhook·/api/cron/billing도 미들웨어 밖(matcher에 /api가 없다 — 설계 '조사 반영 결정' 1).
 *   · CSP는 결제 화면(/subscribe·/subscribe/return)에만 넓힌다 — 다른 화면은 포트원 SDK를 불러올 수 없다(Next가 쓰는 경로 매처로 확인).
 *   · 앱인지 모르는 첫 그리기(서버 렌더)에는 웹 결제가 없다 · 앱 안이면 결제 결과 화면도 웹 결제 문구를 그리지 않는다(Play 결제 정책).
 *   · 앱 안 화면(PlayPanel)의 문자열에는 웹 결제 문구·링크가 없다.
 *   · 사업자 정보 하단이 첫 화면(/ 로그아웃)·/login·/pricing·/subscribe·/terms/*·/privacy에 붙어 있다(research D 1).
 */
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { BillingStatus, PgPayment, PgSubscription } from "@/app/subscribe/pg-client";

const ui = vi.hoisted(() => ({ inApp: null as boolean | null }));
vi.mock("@/app/components/WebOnly", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/components/WebOnly")>()),
  useInApp: () => ui.inApp,
}));

const { config: middlewareConfig } = await import("@/middleware");
const nextConfig = (await import("@/next.config")).default;
const { SubscribeView } = await import("@/app/subscribe/SubscribeView");
const { ReturnView } = await import("@/app/subscribe/return/ReturnView");
const require = createRequire(import.meta.url);
const { buildCustomRoute } = require("next/dist/lib/build-custom-route.js") as {
  buildCustomRoute: (type: "header", route: { source: string; headers: unknown[] }) => { regex: string };
};

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");
/** 웹 결제를 가리키는 말·링크('결제수단'은 Play 해지 안내에도 쓰는 일반어라 넣지 않는다) */
const WEB_PAYMENT = /포트원|웹 결제|웹에서|이용권|자동결제|카카오페이|네이버페이|\/terms\/|\/pricing|청약철회/;
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("미들웨어 — 공개 화면과 웹훅·예약 작업은 로그인 관문 밖", () => {
  const matcher = middlewareConfig.matcher as string[];
  it.each(["/pricing", "/terms", "/subscribe", "/api"])("%s는 matcher에 없다", (path) => {
    expect(matcher.some((m) => m === path || m.startsWith(`${path}/`) || path.startsWith(`${m}/`))).toBe(false);
  });
});

describe("CSP — 결제 화면에만 포트원 SDK·결제창 도메인", () => {
  it("/subscribe·/subscribe/return에만 넓힌 CSP가 걸리고 그 밖(요금 안내·약관·홈)은 기존 CSP", async () => {
    const rules = await nextConfig.headers!();
    const csp = (r: (typeof rules)[number]) => r.headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
    const widened = rules.filter((r) => csp(r).includes("https://cdn.portone.io"));
    expect(widened).toHaveLength(1);
    const re = new RegExp(buildCustomRoute("header", { source: widened[0].source, headers: [] }).regex);
    for (const p of ["/subscribe", "/subscribe/return"]) expect(re.test(p), p).toBe(true);
    for (const p of ["/pricing", "/terms/paid", "/", "/login", "/subscriber"]) expect(re.test(p), p).toBe(false);
    // 다른 경로의 CSP에는 포트원이 없다
    const base = rules.find((r) => r.source === "/:path*");
    expect(csp(base!)).not.toContain("portone");
    expect(csp(widened[0])).toMatch(/script-src [^;]*https:\/\/cdn\.portone\.io/);
  });
});

describe("앱인지 모르는 첫 그리기·앱 안 — 웹 결제가 보이지 않는다", () => {
  it("구독 화면 서버 렌더(앱인지 모름) — 머리와 상태 카드뿐", () => {
    ui.inApp = null;
    const out = html(createElement(SubscribeView));
    expect(out).toContain("구독");
    expect(out).toContain("확인 중…");
    expect(out.match(WEB_PAYMENT)?.[0] ?? null).toBeNull();
  });

  it("결제 결과 화면 — 앱 안이면 결과 문구(PG 문구 포함)를 그리지 않고, 모르면 아무것도", () => {
    const query = { issueId: "bk0", billingKey: "k", code: "FAILURE_TYPE_PG", message: "[NAVERPAY] 결제가 거절되었습니다", pgMessage: null };
    ui.inApp = true;
    const inApp = html(createElement(ReturnView, { query, trusted: true }));
    expect(inApp).not.toContain("NAVERPAY");
    expect(inApp).not.toContain("결제 결과");
    ui.inApp = null;
    expect(html(createElement(ReturnView, { query, trusted: true }))).toBe("");
    ui.inApp = false;
    expect(html(createElement(ReturnView, { query, trusted: true }))).toContain("[NAVERPAY] 결제가 거절되었습니다");
    // 내 발급 시도로 확인되지 않은 링크의 문구는 그리지 않는다(남이 만든 주소로 결제 화면에 문구를 띄우지 못하게)
    expect(html(createElement(ReturnView, { query, trusted: false }))).not.toContain("NAVERPAY");
  });

  it("결제 결과 화면은 서버가 '내 최근 발급 시도인지'를 확인해 넘긴다", () => {
    const src = readFileSync("app/subscribe/return/page.tsx", "utf-8");
    expect(src).toContain("isOwnRecentIssue(");
    expect(src).toContain("<ReturnView query={query} trusted={trusted} />");
  });

  it("앱 안 화면(PlayPanel)의 문자열에는 웹 결제 문구·링크가 없다(주석 제외)", () => {
    const src = stripComments(readFileSync("app/subscribe/PlayPanel.tsx", "utf-8"));
    expect(src.match(WEB_PAYMENT)?.[0] ?? null).toBeNull();
  });

  it("웹 결제 화면(신청·관리)은 브라우저로 확인된 뒤에만 그린다", () => {
    const src = readFileSync("app/subscribe/SubscribeView.tsx", "utf-8");
    expect(src).toContain("{inApp === false && st && <WebPanel");
    expect(src).toContain("{inApp === true && <AppPanel");
    // 신청·관리 화면은 WebPanel 안에서만 쓴다
    expect(src.match(/<PgCheckout\b/g)).toHaveLength(1);
    expect(src.match(/<PgManage\b/g)).toHaveLength(1);
  });
});

describe("구독 관리로 가는 길 — 결제회원이 웹에서 해지 화면을 찾을 수 있다(해지가 가입보다 어렵지 않게 — 전자상거래법 제21조의2)", () => {
  const ST: BillingStatus = {
    tier: "pro", expiresAt: null, source: "purchaser", guardianFeatures: true, beneficiaryName: null, usage: null, productIds: [], enforced: false,
  };
  const SUB = { subscriptionId: "s1" } as PgSubscription;
  const PAY = { subscriptionId: "s1", status: "cancelled" } as PgPayment;

  it("구독 화면 제목은 '구독 관리'다(약관·결제 안내가 가리키는 이름)", () => {
    ui.inApp = null;
    expect(html(createElement(SubscribeView))).toContain(">구독 관리</h1>");
  });

  it("/expert 머리와 /mypage에 '구독 관리' 링크(/subscribe)를 둔다", () => {
    for (const f of ["app/expert/page.tsx", "app/mypage/page.tsx"]) expect(readFileSync(f, "utf-8"), f).toContain("<SubscriptionManageLink");
    expect(readFileSync("app/components/SubscriptionManageLink.tsx", "utf-8")).toContain('href="/subscribe"');
  });

  it("링크는 브라우저로 확인됐고 웹 결제 이용권이나 결제 내역이 있을 때만(앱 안·설정 전·없는 분에게는 그리지 않는다)", async () => {
    const { hasPgRecords } = await import("@/app/subscribe/pg-client");
    const { manageLinkVisible } = await import("@/app/components/SubscriptionManageLink");
    const withSub = { ...ST, pg: { subscriptions: [SUB], payments: [] } };
    expect(hasPgRecords(null)).toBe(false);
    expect(hasPgRecords({ ...ST, pg: null })).toBe(false);
    expect(hasPgRecords({ ...ST, pg: { error: "x" } })).toBe(false);
    expect(hasPgRecords({ ...ST, pg: { subscriptions: [], payments: [] } })).toBe(false);
    expect(hasPgRecords(withSub)).toBe(true);
    expect(hasPgRecords({ ...ST, pg: { subscriptions: [], payments: [PAY] } })).toBe(true); // 해지한 뒤에도 결제 내역·영수증을 볼 수 있게
    expect([manageLinkVisible(false, withSub), manageLinkVisible(true, withSub), manageLinkVisible(null, withSub)]).toEqual([true, false, false]);
  });

  it("구독 화면의 [로그인]은 로그인 뒤 구독 화면으로 돌아오게 한다", () => {
    expect(readFileSync("app/subscribe/SubscribeView.tsx", "utf-8")).toContain('href="/login?callbackUrl=%2Fsubscribe"');
    expect(readFileSync("app/login/page.tsx", "utf-8")).toContain("loginReturnPath(");
  });

  it.each([
    [null, "/"],
    ["/subscribe", "/subscribe"],
    ["https://maeum.example.com/subscribe", "/subscribe"], // 같은 사이트의 절대 주소(next-auth 꼴)
    ["/subscribe?from=mail", "/subscribe"],
    ["https://evil.example/subscribe", "/"],
    ["//evil.example/subscribe", "/"],
    ["/\\evil.example/subscribe", "/"],
    ["/subscribe/../admin", "/"],
    ["javascript:alert(1)", "/"],
    ["/chat", "/"], // 그 밖의 화면은 예전처럼 홈(역할별 첫 화면)
  ])("로그인 뒤 갈 곳: %s → %s(같은 사이트의 구독 화면만 따른다 — 바깥 주소로 보내지 않는다)", async (raw, want) => {
    const { loginReturnPath } = await import("@/app/login/return-path");
    expect(loginReturnPath(raw, "https://maeum.example.com")).toBe(want);
  });
});

describe("사업자 정보 하단 — 첫 화면·로그인·요금·결제·약관·처리방침", () => {
  it.each([
    ["app/page.tsx", "첫 화면(로그아웃)"], ["app/login/layout.tsx", "/login"], ["app/pricing/page.tsx", "/pricing"],
    ["app/subscribe/page.tsx", "/subscribe"], ["app/subscribe/return/page.tsx", "/subscribe/return"],
    ["app/terms/TermsShell.tsx", "/terms/*"], ["app/privacy/layout.tsx", "/privacy"],
  ])("%s(%s)", (file) => {
    expect(readFileSync(file, "utf-8")).toContain("<BizInfoFooter />");
  });

  it("서버 env를 읽는 화면은 요청마다 그린다(빌드 때 굳히지 않게 — connection)", () => {
    for (const f of ["app/login/layout.tsx", "app/privacy/layout.tsx", "app/pricing/page.tsx", "app/subscribe/page.tsx",
      "app/subscribe/return/page.tsx", "app/terms/paid/page.tsx", "app/terms/refund/page.tsx"]) {
      expect(readFileSync(f, "utf-8"), f).toContain("await connection();");
    }
    // 첫 화면은 세션(쿠키)을 읽어 원래 요청마다 그려진다
    expect(readFileSync("app/page.tsx", "utf-8")).toContain("await getServerSession(authOptions)");
  });
});
