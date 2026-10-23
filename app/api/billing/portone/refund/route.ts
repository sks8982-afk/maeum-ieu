/**
 * 청약철회 — { subscriptionId }. 결제일(자동 갱신 결제 포함)부터 7일 안에만 받는다(약관 '청약철회' · research C 3).
 *   유료 혜택(무료 한도를 넘는 대화)을 쓰지 않았으면 전액, 썼으면 이용일수만 빼고 환불(위약금 없음). 혜택은 바로 끝난다.
 *   7일이 지났으면 409 withdrawal_period_over — 해지(/api/billing/portone/cancel)는 언제든 된다고 안내한다.
 * 기간 판정과 실제 환불이 같은 시각(now)으로 계산된다 — 7일째 자정을 넘기는 사이에 위약금 있는 중도해지로 바뀌지 않게.
 * 결제회원 본인만(IDOR — 남의 것은 404). 환불은 원래 결제수단의 결제 취소로만(자체 포인트 환불 금지).
 */
import { NextResponse } from "next/server";
import { cancelNow, quoteCancellation } from "@/lib/billing/portone-cancel";
import { cancelNowFailed, cancelRefusal, pgError, pgGate, readJsonObject, stringField } from "@/lib/billing/portone-route";

export const maxDuration = 60;

export async function POST(req: Request) {
  const gate = await pgGate(req, "service", "refund");
  if (!gate.ok) return gate.res;
  const body = await readJsonObject(req);
  const subscriptionId = stringField(body?.subscriptionId, 40);
  if (!subscriptionId) return pgError(400, "bad_request", "잘못된 요청입니다.");

  const now = new Date();
  try {
    const q = await quoteCancellation(subscriptionId, { purchaserUserId: gate.userId }, now);
    if (!q.ok) return cancelRefusal(q.code);
    if (!q.quote.withinWithdrawal) {
      return pgError(409, "withdrawal_period_over", "청약철회 기간(결제일부터 7일)이 지났어요. 해지는 언제든 할 수 있어요.");
    }
    const r = await cancelNow(subscriptionId, { purchaserUserId: gate.userId }, now);
    return r.ok ? NextResponse.json({ ok: true, endsAt: r.endsAt, refundKrw: r.refundKrw }) : cancelRefusal(r.code);
  } catch (e) {
    return cancelNowFailed(subscriptionId, gate.userId, e);
  }
}
