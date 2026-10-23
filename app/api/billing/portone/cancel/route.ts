/**
 * 이용권 해지 — { subscriptionId, mode } 두 방식(설계 '조사 반영 결정' 6 · research C 3·4 · 약관 '해지'):
 *   · period_end — 다음 결제부터 해지(일반해지). 이용기간 끝까지 그대로 쓰고 그 뒤 결제 없음, 환불 없음.
 *   · now        — 지금 해지. 바로 끝나고 결제 취소로 환불한다. 결제일부터 7일 안이면 청약철회 규칙(유료 혜택 미사용 전액 /
 *                  사용 시 이용일수만 공제), 그 뒤면 중도해지 규칙(이용일수 + 남은 기간 요금의 10% 공제), 연결이 끊긴 뒤면 위약금 없음.
 * 한 번의 요청으로 끝난다 — 해지 사유를 묻지 않고, 재확인은 화면에서 1회 이하(다크패턴 금지 — research D 6).
 * 결제회원 본인만(남의 구독은 없는 것과 같은 404 — IDOR). 환불액은 서버가 그 자리에서 다시 계산한다(화면의 예상액을 믿지 않는다).
 * 판매 스위치가 꺼져도 열려 있다(포트원 키가 있으면) — 해지를 막으면 해지 방해다(lib/billing/portone-route 머리말).
 * 우리 앱이 틀림없는 요청만 거절한다(앱 안에는 웹 결제 화면이 없다). WebView 표지만으로는 막지 않는다 — 목록 밖 인앱 브라우저를
 *   우리 앱으로 오판해 해지를 막으면 해지 방해다(lib/billing/portone-route isDefiniteAppRequest).
 */
import { NextResponse } from "next/server";
import { cancelAtPeriodEnd, cancelNow } from "@/lib/billing/portone-cancel";
import {
  cancelNowFailed, cancelRefusal, errorKind, pgError, pgGate, readJsonObject, stringField,
} from "@/lib/billing/portone-route";

export const maxDuration = 60;

export async function POST(req: Request) {
  const gate = await pgGate(req, "service", "cancel");
  if (!gate.ok) return gate.res;
  const body = await readJsonObject(req);
  const subscriptionId = stringField(body?.subscriptionId, 40);
  const mode = body?.mode === "now" || body?.mode === "period_end" ? body.mode : null;
  if (!subscriptionId || !mode) return pgError(400, "bad_request", "잘못된 요청입니다.");

  if (mode === "now") {
    try {
      const r = await cancelNow(subscriptionId, { purchaserUserId: gate.userId });
      return r.ok ? NextResponse.json({ ok: true, mode, endsAt: r.endsAt, refundKrw: r.refundKrw }) : cancelRefusal(r.code);
    } catch (e) {
      return cancelNowFailed(subscriptionId, gate.userId, e);
    }
  }
  try {
    // 포트원 정리(예약 취소 → 빌링키 삭제)가 실패해도 해지는 성립한다 — 예약 작업이 마저 하고, 그 사이 결제는 전액 취소된다
    const r = await cancelAtPeriodEnd(subscriptionId, { purchaserUserId: gate.userId });
    return r.ok ? NextResponse.json({ ok: true, mode, endsAt: r.endsAt, refundKrw: 0 }) : cancelRefusal(r.code);
  } catch (e) {
    console.error(`[billing-pg] 다음 결제부터 해지 실패 sub=${subscriptionId.slice(0, 8)}: ${errorKind(e)}`);
    return pgError(502, "temporary", "해지를 처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
  }
}
