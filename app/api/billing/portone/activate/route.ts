/**
 * 빌링키 확정과 첫 결제 — 브라우저가 결제창(또는 모바일 복귀 화면 /subscribe/return)에서 받은 { issueId, billingKey }를 보낸다.
 *
 * 신뢰 원천은 포트원 재조회다(research B 0): 빌링키를 포트원에서 다시 조회해 발급 완료·issueId·상점·채널(test/live)을 대조하고,
 *   그 발급 준비를 한 사람(결제회원)이 지금 로그인한 사람이어야 한다(아니면 남의 결제를 대신 확정하는 것 — 404로 숨긴다).
 *   같은 확정이 BillingKey.Issued 웹훅으로도 오지만 결제는 한 번뿐이다(lib/billing/portone-activate activateByBillingKey).
 * 첫 결제 실패는 402 — PG가 준 실패 메시지를 **가공하지 않고** 그대로 내려준다(네이버페이 조건, research B 5).
 * 응답에 빌링키·결제 id를 싣지 않는다. 포트원 호출이 있어 maxDuration 60초(포트원 권장 읽기 타임아웃 60초 이상 — research B 6).
 */
import { NextResponse } from "next/server";
import { activateByBillingKey, type ActivateResult } from "@/lib/billing/portone-activate";
import { errorKind, pgError, pgGate, readJsonObject, stringField } from "@/lib/billing/portone-route";

export const maxDuration = 60;

/** 발급 준비가 만든 issueId 꼴(lib/billing/portone-activate newIssueId) */
const ISSUE_ID_RE = /^bk[0-9a-f]{32}$/;
/** 빌링키는 포트원이 만든 불투명 문자열 — 보이는 ASCII만, 길이 제한 */
const BILLING_KEY_RE = /^[\x21-\x7e]{1,200}$/;

/** 실패 갈래 → 상태 코드·안내(화면이 그대로 보여 준다) */
const FAILURES: Record<Exclude<ActivateResult, { ok: true }>["code"], [number, string]> = {
  invalid_billing_key: [400, "결제수단을 확인하지 못했어요. 처음부터 다시 시도해 주세요."],
  not_found: [404, "결제 요청을 찾을 수 없어요. 처음부터 다시 시도해 주세요."],
  forbidden: [404, "결제 요청을 찾을 수 없어요. 처음부터 다시 시도해 주세요."],
  expired: [410, "결제 준비 시간이 지났어요. 처음부터 다시 시도해 주세요."],
  duplicate: [409, "이 분은 이미 이용권이 적용되어 있어요. 결제하지 않았어요."],
  not_linked: [409, "혜택 받을 분과의 연결이 해제되어 결제하지 않았어요."],
  config: [503, "결제를 준비하고 있어요. 잠시 후 다시 시도해 주세요."],
  payment_failed: [402, "결제가 완료되지 않았어요. 결제수단을 확인해 주세요."],
  verification_failed: [502, "결제 확인 중 문제가 생겨 이용권 적용을 보류했어요. 고객센터로 문의해 주세요."],
};

function toResponse(r: ActivateResult): NextResponse {
  if (r.ok) {
    return NextResponse.json({ ok: true, status: r.status, subscriptionId: r.subscriptionId }, { status: r.status === "active" ? 200 : 202 });
  }
  const [status, fallback] = FAILURES[r.code];
  // 남의 것과 없는 것은 같은 답(있는지조차 알리지 않는다)
  const code = r.code === "forbidden" ? "not_found" : r.code;
  // PG 메시지가 있으면 그것이 곧 안내다 — 덧붙이거나 바꾸지 않는다
  return pgError(status, code, r.message ?? fallback, { pgMessage: r.message ?? null });
}

export async function POST(req: Request) {
  const gate = await pgGate(req, "sales", "activate");
  if (!gate.ok) return gate.res;
  const body = await readJsonObject(req);
  const issueId = stringField(body?.issueId, 40);
  const billingKey = stringField(body?.billingKey, 200);
  if (!issueId || !ISSUE_ID_RE.test(issueId) || !billingKey || !BILLING_KEY_RE.test(billingKey)) {
    return pgError(400, "bad_request", "잘못된 요청입니다.");
  }
  try {
    return toResponse(await activateByBillingKey(billingKey, { issueId, purchaserUserId: gate.userId }));
  } catch (e) {
    // 포트원·DB 일시 오류 — 결과를 모른다. 웹훅(BillingKey.Issued·Transaction.Paid)이나 다시 부르기가 이어서 확정한다(멱등)
    console.error(`[billing-pg] 결제 확정 실패 user=${gate.userId.slice(0, 8)}: ${errorKind(e)}`);
    return pgError(502, "temporary", "결제 확인이 늦어지고 있어요. 잠시 후 구독 화면을 다시 열어 확인해 주세요.");
  }
}
