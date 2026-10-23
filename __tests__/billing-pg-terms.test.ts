/**
 * 웹 PG 이용권의 약관·환불정책·요금 안내 화면과 공통 문구(lib/billing/pg-terms) — 2026-10-22.
 *
 * 지키는 것:
 *   · 환불정책 계산 예시 = 실제 환불 계산(refundAmount) = 환불정책 권장안 표(research C 5 — 19,900·16,584·10,746·0원).
 *   · 유료서비스 이용약관에 법정 필수 조항(research D 9)이 빠지지 않는다 — 청약철회 기한·방법·효과, 해지 두 방식, 환불 기한, 결제 실패, 요금 변경…
 *   · 요금 안내(/pricing): PG가 꺼지면 404, 켜지면 요금제마다 하루 대화 한도와 **부가세 포함 월 총액** · 자동결제·해지·환불 요약 · 계속 무료인 기능.
 *     앱인지 모르는 서버 렌더 HTML에는 웹 결제 안내가 없다(WebOnly — Play 결제 정책).
 *   · 표현(설계 11): 결제·요금제·약관 화면에 '충전·크레딧·횟수권'과 '치매·검출' 같은 의학적 효능 표현이 없다
 *     ('진단'은 "의료 진단이나 치료를 대신하지 않으며" — 효능이 아님을 밝히는 문장에만).
 * 렌더링: 비동기 서버 페이지는 함수를 직접 불러 나온 요소를 react-dom/server로 그린다(connection·notFound는 대체).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({ pgEnabled: true, portoneConfigured: true, webOnlyPassThrough: false }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  notFound: () => { throw new Error("NOT_FOUND"); },
}));
vi.mock("@/lib/billing/portone-plans", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/billing/portone-plans")>();
  return {
    ...real,
    isPgEnabled: () => state.pgEnabled,
    portoneConfigured: () => state.portoneConfigured,
    getPgPlans: () => real.DEFAULT_PG_PLANS,
    availablePayMethods: () => ["CARD", "KAKAOPAY"] as const,
  };
});
vi.mock("@/app/components/WebOnly", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/app/components/WebOnly")>();
  // 기본은 진짜 WebOnly(서버 렌더 = 앱인지 모름 → 아무것도). 내용을 보려는 시험만 브라우저처럼 그대로 통과시킨다
  return { ...real, WebOnly: (p: { children: ReactNode }) => (state.webOnlyPassThrough ? p.children : real.WebOnly(p)) };
});

const terms = await import("@/lib/billing/pg-terms");
const { EARLY_CANCEL_PENALTY_PERCENT, WITHDRAWAL_DAYS, RETRY_OFFSETS_DAYS } = await import("@/lib/billing/portone-period");
const { REQUIRED_CONSENTS, PG_TERMS_VERSION } = await import("@/lib/billing/portone-consent");
const PaidTermsPage = (await import("@/app/terms/paid/page")).default;
const RefundPolicyPage = (await import("@/app/terms/refund/page")).default;
const PricingPage = (await import("@/app/pricing/page")).default;

const html = (el: ReactNode) => renderToStaticMarkup(el as ReactElement).replace(/<!-- -->/g, "");
const renderPage = async (page: () => Promise<ReactElement>) => html(await page());

beforeEach(() => { state.pgEnabled = true; state.portoneConfigured = true; state.webOnlyPassThrough = false; });

describe("환불 계산 예시 — 실제 환불 계산과 같고 환불정책 표(research C 5)와 같다", () => {
  it("3일째 철회·미사용 19,900원 / 5일째 철회·사용 16,584원 / 12일째 지금 해지 10,746원 / 12일째 다음 결제부터 0원", () => {
    expect(terms.refundExamples().map((e) => e.refundKrw)).toEqual([19_900, 16_584, 10_746, 0]);
  });

  it("계산 설명도 같은 숫자(이용 5일 3,316원 · 이용 12일 7,960원 · 남은 11,940원의 10% 1,194원)", () => {
    const how = terms.refundExamples().map((e) => e.how);
    expect(how[1]).toBe("19,900원 − 이용 5일 3,316원");
    expect(how[2]).toBe(`19,900원 − 이용 12일 7,960원 − 남은 기간 요금 11,940원의 ${EARLY_CANCEL_PENALTY_PERCENT}% 1,194원`);
  });

  it("/terms/refund가 그 예시를 그대로 그린다", async () => {
    const out = await renderPage(RefundPolicyPage);
    for (const s of ["19,900원", "16,584원", "10,746원", "0원", "환불 없음, 이용기간 끝까지 이용"]) expect(out, s).toContain(s);
    expect(out).toContain(`${WITHDRAWAL_DAYS}일 이후, 지금 해지`);
    expect(out).toContain(`남은 기간 이용요금의 ${EARLY_CANCEL_PENALTY_PERCENT}%를 빼고 환불`);
    expect(out).toContain("포인트 등으로 환불을 대신하지 않습니다");
  });
});

describe("공통 문구(lib/billing/pg-terms)", () => {
  it("금액·날짜 표시 — 자릿점, 한국 시간(서버·브라우저 시간대와 무관)", () => {
    expect(terms.krw(19_900)).toBe("19,900원");
    expect(terms.krw(1_000_000)).toBe("1,000,000원");
    expect(terms.krw(0)).toBe("0원");
    expect(terms.kstDateLabel(new Date("2026-10-31T16:00:00Z"))).toBe("2026년 11월 1일"); // UTC로는 10/31
  });

  it("결제일 — 1월 31일 결제면 매월 31일, 다음 결제는 2월 말일 10:00 KST", () => {
    const s = terms.chargeSchedule(new Date("2026-01-31T05:00:00Z")); // KST 1/31 14:00
    expect(s.chargeDay).toBe(31);
    expect(s.nextCharge.toISOString()).toBe("2026-02-28T01:00:00.000Z");
  });

  it("청약철회 기한 문구는 계산과 같다 — 결제 당일부터 되고, 결제일로부터 7일 뒤 같은 날 24시까지(다음 날부터라고 쓰지 않는다)", async () => {
    const { withinWithdrawalWindow } = await import("@/lib/billing/portone-period");
    const paidAt = new Date("2026-11-02T05:05:00Z"); // KST 11/2 14:05
    expect(withinWithdrawalWindow(paidAt, new Date("2026-11-02T06:00:00Z"))).toBe(true); // 결제 당일
    expect(withinWithdrawalWindow(paidAt, new Date("2026-11-09T14:59:59Z"))).toBe(true); // 11/9 23:59:59 KST
    expect(withinWithdrawalWindow(paidAt, new Date("2026-11-09T15:00:00Z"))).toBe(false); // 11/10 0시 KST
    expect(terms.WITHDRAWAL_SUMMARY).toContain(`결제한 날(자동결제일 포함) 당일부터 ${WITHDRAWAL_DAYS}일 뒤 같은 날 24시(한국 시간)까지`);
    expect(terms.WITHDRAWAL_SUMMARY).not.toContain("다음 날부터");
  });

  it("이용 끝 날짜는 화면·메일·약관이 같다 — 다음 결제일 전날(12월 2일 10시에 다음 결제면 12월 1일까지)", () => {
    expect(terms.kstDateLabel(terms.lastUsableDay(new Date("2026-12-02T01:00:00Z")))).toBe("2026년 12월 1일");
    expect(terms.kstDateLabel(terms.lastUsableDay(new Date("2026-12-01T15:00:00Z")))).toBe("2026년 12월 1일"); // 12/2 0시 KST
  });

  it("숫자는 계산 모듈에서 — 7일·10%·1일 뒤와 3일 뒤", () => {
    expect(terms.CANCEL_SUMMARY[1]).toContain(`${EARLY_CANCEL_PENALTY_PERCENT}%`);
    expect(RETRY_OFFSETS_DAYS).toEqual([1, 3]);
    expect(terms.RETRY_SUMMARY).toContain("1일 뒤와 3일 뒤 오전 10시");
    expect(terms.freeFeaturesLine(10)).toBe("위급 상황 감지와 보호자 위급 알림, 하루 10회 대화는 이용권 없이도 계속 무료입니다.");
    expect(terms.freeFeaturesLine(0)).toBe("위급 상황 감지와 보호자 위급 알림는 이용권 없이도 계속 무료입니다.");
  });

  it("필수 동의 넷 — 모두 (필수)·'보기' 링크, 자동결제 동의에는 금액과 매월 결제일", () => {
    expect([...REQUIRED_CONSENTS].sort()).toEqual(["autoRenew", "privacyEntrust", "refundPolicy", "terms"]);
    for (const k of REQUIRED_CONSENTS) {
      const l = terms.consentLabel(k, { priceKrw: 19_900, chargeDay: 2 });
      expect(l.text, k).toMatch(/^\(필수\) /);
      expect(l.href, k).toMatch(/^\/(terms\/paid|terms\/refund|privacy)/);
    }
    expect(terms.consentLabel("autoRenew", { priceKrw: 19_900, chargeDay: 2 }).text).toContain("매월 2일(그날이 없는 달은 말일)에 19,900원이 자동결제");
    expect(terms.consentLabel("privacyEntrust", { priceKrw: 1, chargeDay: 1 }).href).toBe("/privacy#payment-entrust");
  });
});

describe("유료서비스 이용약관(/terms/paid) — 법정 필수 조항(research D 9)", () => {
  it.each([
    ["정의(결제회원·이용회원·이용권·결제일·이용기간·유료 혜택 이용)", ["“결제회원”", "“이용회원”", "“이용권”", "“결제일”", "“이용기간”", "“유료 혜택 이용”"]],
    ["이용권 내용·한도 초기화·무료 기능·제공 시기", ["한국 시간 0시에 다시 셉니다", "무료 기능은 이용권과 관계없이", "결제가 완료되는 즉시"]],
    ["가격(부가세 포함)·자동 갱신·결제일·결제 통지", ["월 금액(부가세 포함)", "그날이 없는 달은 말일", "결제할 때마다 금액·일시·결제수단·다음 결제 예정일을 이메일로", "자동결제 3일 전"]],
    ["청약철회 기한·방법·효과", [`당일부터 ${WITHDRAWAL_DAYS}일 뒤 같은 날 24시`, "전액을 환불", "위약금은 받지 않습니다", "[구독 관리] 화면에서 [지금 해지]"]],
    ["해지 두 방식·같은 크기 안내", ["다음 결제부터 해지:", "지금 해지:", "같은 크기와 같은 방식"]],
    ["환불 계산·방법·기한·지연배상·포인트 금지", ["원 미만은 버립니다", "3영업일", "지연배상금", "포인트 등으로 환불을 대신하지 않습니다"]],
    ["결제 실패", ["1일 뒤와 3일 뒤", "무료 이용으로 바뀝니다"]],
    ["요금 변경(30일 전 동의)", ["30일 동안의 기간에 알리고 따로 동의", "오른 금액으로 결제되지 않습니다"]],
    ["장애 보상·잘못 결제된 금액", ["3배를 무료로 연장", "기간과 관계없이 전액"]],
    ["결제회원과 이용회원", ["연결이 끊기면", "위약금 없이 지금 해지", "하나의 이용권만"]],
    ["탈퇴와 기록 5년", ["환불을 마친 뒤 탈퇴", "5년 동안 보관"]],
    ["기술 요건·앱에서는 결제 불가", ["웹 브라우저", "앱 안에서는 이 이용권을 결제하거나 해지할 수 없습니다"]],
    ["의료 서비스 아님", ["의료 진단이나 치료를 대신하지 않으며", "119 신고를 대신하지 않습니다"]],
    ["개인정보·분쟁 처리·약관 변경", ["href=\"/privacy\"", "1372", "시행일 7일 전부터"]],
  ])("%s", async (_name, needles) => {
    const out = await renderPage(PaidTermsPage);
    for (const s of needles) expect(out, s).toContain(s);
  });

  it("요금표는 설정(BILLING_PLANS)에서 — 하루 대화 한도와 부가세 포함 월 금액, 문안 버전·시행일을 머리에 적는다", async () => {
    const out = await renderPage(PaidTermsPage);
    for (const s of ["월 이용권(하루 대화 20회)", "14,900원", "19,900원", "39,900원", `문안 버전 ${PG_TERMS_VERSION}`, `시행 ${terms.PG_TERMS_EFFECTIVE}`]) {
      expect(out, s).toContain(s);
    }
    // '보기' 링크가 가리키는 자리
    expect(out).toContain('id="auto-renew"');
    expect(out).toContain('id="withdrawal"');
  });

  it("판매 스위치가 꺼져도 포트원 설정(상점 아이디)이 있으면 열린다 — 이미 가입한 결제회원이 계약 내용을 볼 수 있어야 한다", async () => {
    state.pgEnabled = false;
    expect(await renderPage(PaidTermsPage)).toContain("제7조(청약철회)");
    expect(await renderPage(RefundPolicyPage)).toContain("계산 예시");
  });

  it("포트원 설정 전이고 판매도 꺼져 있으면 없는 페이지(404) — 설정 없이 배포해도 법률 검토 전 초안이 공개되지 않는다(운영 변화 0)", async () => {
    state.pgEnabled = false;
    state.portoneConfigured = false;
    await expect(PaidTermsPage()).rejects.toThrow("NOT_FOUND");
    await expect(RefundPolicyPage()).rejects.toThrow("NOT_FOUND");
  });

  it("결제는 보호자만 — 일반 회원 결제·'본인' 혜택 문구가 없다(일반 회원은 하루 대화 한도가 없어 이용권 효과가 없다)", async () => {
    state.webOnlyPassThrough = true;
    const paid = await renderPage(PaidTermsPage);
    expect(paid).toContain("결제는 보호자 계정으로만 할 수 있습니다");
    for (const out of [paid, await renderPage(PricingPage)]) {
      expect(out).not.toMatch(/보호자 또는 일반 회원|보호자·일반 회원|일반 회원이 자신을 위해|\(또는 본인\)/);
    }
  });

  it("요금제를 직접 바꾸는 기능이 없으니 '요금제를 바꾸면 다음 결제일부터' 조항도 없다", async () => {
    expect(await renderPage(PaidTermsPage)).not.toContain("직접 요금제를 바꾸면");
  });
});

describe("요금 안내(/pricing)", () => {
  it("PG가 꺼져 있으면 없는 페이지(404)", async () => {
    state.pgEnabled = false;
    await expect(PricingPage()).rejects.toThrow("NOT_FOUND");
  });

  it("브라우저 — 요금제마다 하루 대화 한도와 부가세 포함 월 총액, 미리 고른 요금제 없음, 자동결제·해지·청약철회·가격 변경·무료 기능", async () => {
    state.webOnlyPassThrough = true;
    const out = await renderPage(PricingPage);
    for (const s of [
      "월 이용권(하루 대화 30회)", "하루 대화 30회", "월 19,900원 <span", "(부가세 포함)",
      "매월 자동결제", "그날이 없는 달은 말일", "결제수단: 카드·카카오페이", terms.CANCEL_SUMMARY[0], terms.CANCEL_SUMMARY[1],
      terms.WITHDRAWAL_SUMMARY, terms.PRICE_CHANGE_SUMMARY, "위급 상황 감지와 보호자 위급 알림",
      'href="/terms/paid"', 'href="/terms/refund"', 'href="/subscribe"',
    ]) expect(out, s).toContain(s);
    // 🔒 요금제를 미리 골라 두지 않는다(제21조의2①2호) — 요금 안내에는 고르는 칸 자체가 없다
    expect(out).not.toMatch(/type="radio"|checked/);
  });

  it("서버 렌더(앱인지 모름) HTML에는 웹 결제 안내가 없다 — 앱 웹뷰에 잠깐도 보이지 않게", async () => {
    const out = await renderPage(PricingPage);
    expect(out).toContain("요금 안내"); // 페이지 머리는 있다
    for (const s of ["19,900원", "자동결제", "이용권 신청하기", "/terms/paid"]) expect(out, s).not.toContain(s);
  });
});

describe("표현 — 결제·요금제·약관 화면(설계 11·research D 8)", () => {
  const FORBIDDEN = /충전|크레딧|횟수권|치매|검출|선별|효능|예방|인지 기능|인지 검사/;
  const DIAGNOSIS_OK = "의료 진단이나 치료를 대신하지 않으며";

  function check(where: string, text: string) {
    expect(text.match(FORBIDDEN)?.[0] ?? null, where).toBeNull();
    // '진단'은 효능이 아님을 밝히는 문장에만
    expect(text.split(DIAGNOSIS_OK).join("").includes("진단"), `${where} — 진단`).toBe(false);
  }

  it("그린 화면 — 요금 안내·약관·환불정책", async () => {
    state.webOnlyPassThrough = true;
    check("/pricing", await renderPage(PricingPage));
    check("/terms/paid", await renderPage(PaidTermsPage));
    check("/terms/refund", await renderPage(RefundPolicyPage));
  });

  it("소스의 문자열(주석 제외) — app/subscribe·app/pricing·app/terms·lib/billing/pg-terms", () => {
    const files = [...walk("app/subscribe"), ...walk("app/pricing"), ...walk("app/terms"), "lib/billing/pg-terms.ts"];
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) check(f, stripComments(readFileSync(f, "utf-8")));
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n).replace(/\\/g, "/");
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|ts)$/.test(p) ? [p] : [];
  });
}

/** 주석(/* *\/ · // · JSX {/* *\/})을 지운다 — 금지 표현은 화면에 나가는 문자열에서만 본다(주석은 그 규칙을 설명하느라 그 말을 쓴다) */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}
