/**
 * 빌링키 발급 창 호출(브라우저) — 포트원 브라우저 SDK requestIssueBillingKey(research B 5 결제수단별 매개변수 표 그대로).
 *
 *   카드(KG이니시스)  billingKeyMethod CARD · PC 결제창이 구매자 이름·휴대전화·이메일을 요구 · 모바일은 제공 기간(offerPeriod 1m) 필수
 *   카카오페이        billingKeyMethod EASY_PAY · customerId만 · windowType은 넣지 않는다(PC IFRAME·모바일 REDIRECTION만 된다)
 *   네이버페이        billingKeyMethod EASY_PAY · customerId만 · displayAmount와 currency(KRW)는 함께 넣는다(하나만 넣으면 오류)
 *   공통: forceRedirect — PC·모바일 결과를 돌아오는 화면(/subscribe/return) 한 곳에서 처리한다. 발급이 시작되기도 전에 난 오류만
 *   리디렉션 없이 여기로 돌아온다.
 * ⚠ 성공 판정은 code가 **없는지**로 한다 — 실패해도 billingKey 값이 들어 있다(research B 5). SDK가 reject하는 경로도 있어 try/catch.
 * ⚠ 실패 문구(message)는 가공하지 않고 그대로 보여 준다(네이버페이 조건) — 앞뒤에 말을 붙이지 않는다.
 * customerId는 내부 불투명 id(prepare가 준다 — 네이버페이 merchantUserId에 개인정보 금지). 구매자 정보는 카드일 때만 싣는다.
 */
import * as PortOne from "@portone/browser-sdk/v2";
import type { PreparedIssue } from "./pg-client";

/** 카드 결제창(KG이니시스 PC)이 요구하는 구매자 정보 — 서비스는 저장하지 않는다(결제창으로만 넘어간다) */
export interface Buyer { fullName: string; phoneNumber: string; email: string }

/** 결제수단별 발급 요청 — 순수 함수(시험이 그대로 본다) */
export function buildIssueRequest(prep: PreparedIssue, buyer?: Buyer): PortOne.IssueBillingKeyRequest {
  const base = {
    storeId: prep.storeId,
    channelKey: prep.channelKey,
    issueId: prep.issueId,
    issueName: prep.issueName,
    redirectUrl: prep.redirectUrl,
    forceRedirect: true,
  };
  if (prep.method === "CARD") {
    return {
      ...base, billingKeyMethod: "CARD",
      customer: { customerId: prep.customerId, ...(buyer ?? {}) },
      offerPeriod: { interval: "1m" },
    };
  }
  if (prep.method === "NAVERPAY") {
    return { ...base, billingKeyMethod: "EASY_PAY", customer: { customerId: prep.customerId }, displayAmount: prep.priceKrw, currency: "KRW" };
  }
  return { ...base, billingKeyMethod: "EASY_PAY", customer: { customerId: prep.customerId } };
}

/** 발급 창의 결과 — redirected: 결제창이 이 페이지를 떠났다(결과는 /subscribe/return이 받는다) */
export type IssueOutcome =
  | { kind: "issued"; billingKey: string }
  | { kind: "redirected" }
  | { kind: "failed"; message: string };

const OPEN_FAILED = "결제창을 열지 못했어요. 팝업 차단을 풀거나 잠시 후 다시 시도해 주세요.";
const NOT_DONE = "결제수단 등록이 끝나지 않았어요. 다시 시도해 주세요.";

/** SDK 응답 → 결과. code가 있으면 실패(billingKey가 있어도) — message를 그대로, 없으면 pgMessage를 그대로 */
export function readIssueResponse(res: PortOne.IssueBillingKeyResponse | undefined): IssueOutcome {
  if (res === undefined) return { kind: "redirected" };
  if (res.code !== undefined) return { kind: "failed", message: res.message || res.pgMessage || NOT_DONE };
  return res.billingKey ? { kind: "issued", billingKey: res.billingKey } : { kind: "failed", message: NOT_DONE };
}

/** 발급 창 열기 — SDK가 reject하면(스크립트를 못 받음 등) 화면 문구로 바꾼다(그 경우는 PG 문구가 아니다) */
export async function issueBillingKey(prep: PreparedIssue, buyer?: Buyer): Promise<IssueOutcome> {
  try {
    return readIssueResponse(await PortOne.requestIssueBillingKey(buildIssueRequest(prep, buyer)));
  } catch (e) {
    console.warn("[subscribe] 결제창 호출 실패:", e instanceof Error ? e.message.slice(0, 120) : e);
    return { kind: "failed", message: OPEN_FAILED };
  }
}

/** 카드 결제창용 휴대전화 번호 — 숫자만 10~11자리(01로 시작). 아니면 null */
export function normalizePhone(v: string): string | null {
  const digits = v.replace(/\D/g, "");
  return /^01\d{8,9}$/.test(digits) ? digits : null;
}
