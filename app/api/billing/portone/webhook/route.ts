/**
 * 포트원 V2 웹훅(2024-04-25 버전 — Standard Webhooks: webhook-id·webhook-timestamp·webhook-signature, HMAC-SHA256, ±300초).
 *
 * 신뢰 모델(research B 7): **본문을 믿지 않는다.** 서명을 원문 그대로 검증한 뒤, 본문은 "이 결제·빌링키를 다시 보라"는 신호로만 쓰고
 *   상태·금액은 포트원 재조회로 정한다(lib/billing/portone-sync syncPayment — 원장에 없는 결제는 우리 것이 아니라 무시).
 *   · 원문(request.text())으로 검증한다 — JSON.parse 뒤 다시 직렬화하면 서명이 맞지 않는다.
 *   · 헤더는 Object.fromEntries(request.headers)로 넘긴다 — Headers 객체를 그대로 주면 SDK가 Object.entries로 읽지 못해
 *     늘 MISSING_REQUIRED_HEADERS가 난다(research B 7 — SDK 원본으로 확인).
 *   · webhook-id는 재전송해도 같다 — 처리를 마친 id는 BillingWebhookEvent에 남기고 다시 오면 그냥 200(처리 함수 자체도 멱등).
 * 받는 것: Transaction.*(결제·예약 결제·취소 — paymentId로 재조회), BillingKey.Issued(창을 닫아 브라우저 복귀가 없을 때의 확정 —
 *   새 가입이라 판매 스위치가 켜져 있을 때만), BillingKey.Deleted(카카오페이·네이버페이 앱에서 자동결제를 끊은 경우 등).
 * 응답(research B 7): 처리 200 · 서명 실패 400 · 우리 것이 아님 200 · 내부 오류 500(포트원이 재전송하게 — 최대 5회).
 * 인증 미들웨어 밖이다(middleware matcher에 /api가 없다) — 서명이 곧 인증이다. 포트원 호출이 있어 maxDuration 60초.
 */
import { Webhook } from "@portone/server-sdk";
import { prisma } from "@/lib/prisma";
import { isPgEnabled } from "@/lib/billing/portone-plans";
import { syncPayment } from "@/lib/billing/portone-sync";
import { activateByBillingKey, discardIssuedKey, onBillingKeyDeleted } from "@/lib/billing/portone-activate";
import { errorKind, portoneServiceable } from "@/lib/billing/portone-route";

export const maxDuration = 60;

const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

type Verified = Awaited<ReturnType<typeof Webhook.verify>>;

/** 서명 검증 — 실패면 null(400), 우리 설정이 틀렸으면 throw(500 — 고친 뒤 재전송으로 받는다) */
async function verified(body: string, headers: Headers): Promise<Verified | null> {
  try {
    return await Webhook.verify(process.env.PORTONE_WEBHOOK_SECRET?.trim() ?? "", body, Object.fromEntries(headers));
  } catch (e) {
    if (e instanceof Webhook.WebhookVerificationError || e instanceof SyntaxError) return null;
    throw e; // InvalidInputError(시크릿 형식 오류) 등
  }
}

/** 받은 웹훅을 처리한다 — 무엇을 했는지(로그용 — 결제 id는 남기고 빌링키는 남기지 않는다). 포트원·DB 실패는 throw */
async function dispatch(webhook: Verified): Promise<string> {
  if (Webhook.isUnrecognizedWebhook(webhook)) return "unrecognized";
  if ("paymentId" in webhook.data) {
    const paymentId = webhook.data.paymentId;
    return `payment ${paymentId.slice(0, 40)}:${await syncPayment(paymentId)}`;
  }
  if (webhook.type === "BillingKey.Issued") {
    // 새 가입은 판매 스위치를 따른다 — 꺼져 있으면 결제하지 않고 그 발급 준비를 닫고 빌링키를 지운다(결제사 앱에 등록이 남지 않게)
    if (!isPgEnabled()) return `issued:sales_off:${await discardIssuedKey(webhook.data.billingKey)}`;
    const r = await activateByBillingKey(webhook.data.billingKey);
    return `issued:${r.ok ? r.status : r.code}`;
  }
  if (webhook.type === "BillingKey.Deleted") return `deleted:${await onBillingKeyDeleted(webhook.data.billingKey)}`;
  return `ignored:${webhook.type}`; // BillingKey.Ready·Failed·Updated — 결제·혜택에 영향 없음
}

const isUniqueViolation = (e: unknown) => (e as { code?: unknown } | null)?.code === "P2002";

/** 처리를 마쳤다고 남긴다 — 같은 id가 동시에 두 번 와서 먼저 남긴 쪽이 있으면 그대로 둔다 */
async function remember(webhookId: string, type: string): Promise<void> {
  try {
    await prisma.billingWebhookEvent.upsert({ where: { webhookId }, update: {}, create: { webhookId, type: type.slice(0, 100) } });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
}

export async function POST(request: Request) {
  if (!portoneServiceable() || !process.env.PORTONE_WEBHOOK_SECRET?.trim()) {
    return text("not configured", 503); // 설정 전 — 포트원이 나중에 재전송한다
  }
  const body = await request.text();
  let webhook: Verified | null;
  try {
    webhook = await verified(body, request.headers);
  } catch (e) {
    console.error(`[billing-webhook] 서명 검증을 할 수 없음(설정 확인): ${errorKind(e)}`);
    return text("error", 500);
  }
  if (!webhook) return text("invalid signature", 400);

  const webhookId = request.headers.get("webhook-id") ?? ""; // 서명 검증을 통과했으면 반드시 있다
  const type = String(webhook.type); // 모르는 종류는 SDK 타입상 심볼이지만 실제로는 문자열이다
  const storeId = (webhook as { data?: { storeId?: unknown } }).data?.storeId;
  try {
    if (await prisma.billingWebhookEvent.findUnique({ where: { webhookId } })) return text("ok"); // 재전송 — 이미 처리했다
    const outcome = storeId !== undefined && storeId !== process.env.PORTONE_STORE_ID?.trim() ? "other_store" : await dispatch(webhook);
    await remember(webhookId, type);
    // 결제 결과가 어디에 반영됐는지 운영 로그로 남긴다("결제했는데 혜택이 없다" 문의를 결제 id로 찾을 수 있게)
    if (outcome !== "unrecognized") console.warn(`[billing-webhook] ${type} → ${outcome}`);
    return text("ok");
  } catch (e) {
    console.error(`[billing-webhook] 처리 실패(포트원이 재전송한다) ${type}: ${errorKind(e)}`);
    return text("error", 500);
  }
}
