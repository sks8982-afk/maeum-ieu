/**
 * 사업자 정보 하단(lib/biz-info · app/components/BizInfoFooter · WebOnly) — 2026-10-22 웹 PG 정기결제 준비.
 *
 * 지키는 것:
 *   · 값이 없으면 그 칸을 숨긴다 — "(설정 필요)" 같은 자리 표시를 사이트에 내보내지 않는다(설계 6). 빠진 이름은 경고로만(값은 찍지 않는다).
 *   · 공정위 사업자정보 확인 링크는 사업자등록번호가 10자리일 때만(시행규칙 제7조② — research D 1·11).
 *   · 전화가 휴대폰 번호면 경고(PG 심사는 유선만 — research D 1).
 *   · 웹 결제 링크(유료서비스 이용약관·환불정책·요금 안내)는 PG가 켜졌을 때만, 그리고 WebOnly 안에만 — 앱인지 모르는 서버 렌더 HTML에는
 *     없다(앱 웹뷰가 하이드레이션 전 HTML을 그대로 보여 준다 — Play 결제 정책).
 * 렌더링: react-dom/server. WebOnly의 갈래(앱/브라우저/모름)는 그 판단 함수(webOnlyContent·inAppSnapshot)로 본다 — 서버 렌더는 늘 '모름'이다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const pg = vi.hoisted(() => ({ enabled: false, configured: false }));
vi.mock("@/lib/billing/portone-plans", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/portone-plans")>()),
  isPgEnabled: () => pg.enabled,
  portoneConfigured: () => pg.configured,
}));

const { readBizInfo, hasBizInfo, DEFAULT_HOSTING, FTC_BIZ_URL } = await import("@/lib/biz-info");
const { BizInfoFooter } = await import("@/app/components/BizInfoFooter");
const { WebOnly, webOnlyContent, inAppSnapshot } = await import("@/app/components/WebOnly");

const FULL = {
  BIZ_NAME: "주식회사 테스트상호", BIZ_OWNER: "홍길동", BIZ_ADDRESS: "경기도 화성시 테스트로 1", BIZ_PHONE: "031-000-0000",
  BIZ_EMAIL: "help@example.com", BIZ_REG_NO: "220-81-62517", BIZ_MAIL_ORDER_NO: "제2026-화성-0000호", BIZ_MAIL_ORDER_AUTHORITY: "화성시",
};
const BIZ_KEYS = [...Object.keys(FULL), "BIZ_HOSTING"];
const html = (el: ReactElement) => renderToStaticMarkup(el).replace(/<!-- -->/g, "");

/** 요소 트리에서 조건에 맞는 요소들(함수 컴포넌트는 펼치지 않는다 — 넘긴 children만 따라간다) */
function findAll(node: ReactNode, pred: (el: ReactElement) => boolean): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap((n) => findAll(n, pred));
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<{ children?: ReactNode }>;
  return [...(pred(el) ? [el] : []), ...findAll(el.props.children, pred)];
}

describe("readBizInfo — 값이 없으면 숨김, 공정위 링크, 휴대폰 경고", () => {
  it("아무것도 없으면 모든 칸 null·호스팅은 기본값, 빠진 이름만 문제로(값 없음)", () => {
    const { info, problems } = readBizInfo({});
    expect(info).toMatchObject({ name: null, owner: null, phone: null, regNo: null, ftcUrl: null, hosting: DEFAULT_HOSTING });
    expect(hasBizInfo(info)).toBe(false);
    expect(problems).toEqual(Object.keys(FULL).map((k) => `${k} 없음`));
  });

  it("다 있으면 그대로(앞뒤 공백 제거) — 공정위 링크는 숫자 10자리로, 문제 없음", () => {
    const { info, problems } = readBizInfo({ ...FULL, BIZ_NAME: `  ${FULL.BIZ_NAME}  ` });
    expect(info.name).toBe(FULL.BIZ_NAME);
    expect(info.regNo).toBe("220-81-62517");
    expect(info.ftcUrl).toBe(`${FTC_BIZ_URL}2208162517`);
    expect(FTC_BIZ_URL).toBe("https://www.ftc.go.kr/bizCommPop.do?wrkr_no=");
    expect(problems).toEqual([]);
    expect(hasBizInfo(info)).toBe(true);
  });

  it("빈 문자열·공백만 있는 값은 없는 것으로(칸을 숨긴다)", () => {
    const { info, problems } = readBizInfo({ ...FULL, BIZ_OWNER: "   ", BIZ_EMAIL: "" });
    expect(info.owner).toBeNull();
    expect(info.email).toBeNull();
    expect(problems).toEqual(["BIZ_OWNER 없음", "BIZ_EMAIL 없음"]);
  });

  it("사업자등록번호가 10자리가 아니면 공정위 링크를 붙이지 않고 경고", () => {
    const { info, problems } = readBizInfo({ ...FULL, BIZ_REG_NO: "220-81-6251" });
    expect(info.regNo).toBe("220-81-6251");
    expect(info.ftcUrl).toBeNull();
    expect(problems.join()).toContain("BIZ_REG_NO는 숫자 10자리");
  });

  it.each(["010-1234-5678", "011 123 4567", "01712345678"])("휴대폰 번호(%s)는 경고 — PG 심사는 유선 대표번호", (phone) => {
    expect(readBizInfo({ ...FULL, BIZ_PHONE: phone }).problems.join()).toContain("BIZ_PHONE이 휴대폰 번호");
  });

  it.each(["031-000-0000", "02-123-4567", "070-1234-5678", "1588-0000"])("유선·대표번호(%s)는 경고 없음", (phone) => {
    expect(readBizInfo({ ...FULL, BIZ_PHONE: phone }).problems).toEqual([]);
  });

  it("BIZ_HOSTING을 넣으면 그 값(AWS로 옮길 때)", () => {
    expect(readBizInfo({ ...FULL, BIZ_HOSTING: "Amazon Web Services, Inc." }).info.hosting).toBe("Amazon Web Services, Inc.");
  });
});

describe("BizInfoFooter — 서버 렌더", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of BIZ_KEYS) saved[k] = process.env[k];
    pg.enabled = false;
    pg.configured = false;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const setEnv = (vars: Record<string, string>) => {
    for (const k of BIZ_KEYS) delete process.env[k];
    Object.assign(process.env, vars);
  };

  it("다 있으면 상호·대표·사업자등록번호[사업자정보확인]·통신판매업(신고기관)·주소·전화·이메일·호스팅", () => {
    setEnv(FULL);
    const out = html(createElement(BizInfoFooter));
    for (const s of [
      "상호 주식회사 테스트상호", "대표 홍길동", "사업자등록번호 220-81-62517", "통신판매업 신고 제2026-화성-0000호(신고기관: 화성시)",
      "주소 경기도 화성시 테스트로 1", "고객센터 <a href=\"tel:031-000-0000\"", "help@example.com", `호스팅 제공: ${DEFAULT_HOSTING}`,
    ]) expect(out, s).toContain(s);
    // 🔒 첫 화면의 공정위 사업자정보 공개 링크(시행규칙 제7조②) — 새 창
    expect(out).toMatch(/<a href="https:\/\/www\.ftc\.go\.kr\/bizCommPop\.do\?wrkr_no=2208162517" target="_blank" rel="noopener noreferrer"[^>]*>\[사업자정보확인\]<\/a>/);
    expect(out).toContain('href="/privacy"');
  });

  it("값이 없으면 사업자 정보 칸을 통째로 숨긴다 — 자리 표시 없음, 처리방침 링크만", () => {
    setEnv({});
    vi.stubEnv("NODE_ENV", "production");
    const out = html(createElement(BizInfoFooter));
    expect(out).not.toContain("상호");
    expect(out).not.toContain("호스팅 제공");
    expect(out).not.toContain("설정 필요");
    expect(out).not.toContain("개발 모드");
    expect(out).toContain('href="/privacy"');
  });

  it("개발 모드면 빠진 이름을 화면 한 줄·서버 로그로 경고한다 — 값은 찍지 않는다", () => {
    setEnv({ ...FULL, BIZ_PHONE: "010-9999-8888" });
    delete process.env.BIZ_OWNER;
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = html(createElement(BizInfoFooter));
    expect(out).toContain("개발 모드 경고 — 사업자 정보 하단: BIZ_OWNER 없음, BIZ_PHONE이 휴대폰 번호");
    expect(warn).toHaveBeenCalledTimes(1);
    // 🔒 경고에는 이름만 — 값(전화번호)은 로그·화면 경고에 찍지 않는다
    expect(String(warn.mock.calls[0][0])).not.toContain("010-9999-8888");
    expect(out.slice(out.indexOf("개발 모드"))).not.toContain("010-9999-8888");
  });

  it("판매도 꺼지고 포트원 설정 전이면 웹 결제 링크가 아예 없다", () => {
    setEnv(FULL);
    const tree = BizInfoFooter();
    expect(findAll(tree, (el) => el.type === WebOnly)).toHaveLength(0);
    expect(html(createElement(BizInfoFooter))).not.toMatch(/terms\/paid|terms\/refund|pricing/);
  });

  it("판매만 꺼졌으면(포트원 설정은 있음) 약관·환불정책 링크는 남고 요금 안내는 없다 — 가입한 결제회원이 계약 내용을 찾을 수 있게", () => {
    setEnv(FULL);
    pg.configured = true;
    const webOnly = findAll(BizInfoFooter(), (el) => el.type === WebOnly);
    expect(webOnly).toHaveLength(1);
    const hrefs = findAll((webOnly[0].props as { children: ReactNode }).children, (el) => typeof (el.props as { href?: unknown }).href === "string")
      .map((el) => (el.props as { href: string }).href);
    expect(hrefs).toEqual(["/terms/paid", "/terms/refund"]);
  });

  it("PG가 켜지면 웹 결제 링크 셋이 WebOnly 안에만 있고, 서버 렌더 HTML(앱인지 모름)에는 나오지 않는다", () => {
    setEnv(FULL);
    pg.enabled = true;
    const webOnly = findAll(BizInfoFooter(), (el) => el.type === WebOnly);
    expect(webOnly).toHaveLength(1);
    const hrefs = findAll((webOnly[0].props as { children: ReactNode }).children, (el) => typeof (el.props as { href?: unknown }).href === "string")
      .map((el) => (el.props as { href: string }).href);
    expect(hrefs).toEqual(["/terms/paid", "/terms/refund", "/pricing"]);
    // 🔒 앱 웹뷰는 하이드레이션 전 HTML을 그대로 보여 준다 — 여기 결제 링크가 있으면 앱 안에 웹 결제 링크가 잠깐이라도 뜬다
    expect(html(createElement(BizInfoFooter))).not.toMatch(/terms\/paid|terms\/refund|pricing/);
  });
});

describe("WebOnly — 앱이면 숨김, 모르면 아무것도, 브라우저면 그린다", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const web = createElement("b", null, "웹 결제");
  const app = createElement("i", null, "앱 안내");
  const draw = (inApp: boolean | null) => html(createElement("div", null, webOnlyContent(inApp, web, app)));

  it("브라우저(false) — children만", () => { expect(draw(false)).toBe("<div><b>웹 결제</b></div>"); });
  it("앱(true) — inApp 대체만(웹 결제 없음)", () => { expect(draw(true)).toBe("<div><i>앱 안내</i></div>"); });
  it("모름(null — 서버 렌더·첫 그리기) — 아무것도", () => { expect(draw(null)).toBe("<div></div>"); });

  it("서버 렌더에서 WebOnly는 아무것도 그리지 않는다(앱인지 모름)", () => {
    // 타입이 children을 props로 요구한다(createElement 오버로드) — 변수로 넘긴다
    const props = { inApp: app, children: web };
    expect(html(createElement(WebOnly, props))).toBe("");
  });

  it("앱 판별 — RN 웹뷰 브릿지(window.ReactNativeWebView)가 있으면 앱", () => {
    vi.stubGlobal("window", { ReactNativeWebView: { postMessage: () => {} } });
    expect(inAppSnapshot()).toBe(true);
    vi.stubGlobal("window", {});
    expect(inAppSnapshot()).toBe(false);
  });
});
