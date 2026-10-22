/**
 * 구독 구매 검증 — 앱이 Play 결제를 마친 뒤 purchaseToken을 보내면 서버가 Google에 확인한다.
 *
 * 신뢰 모델: 클라이언트는 **토큰만** 보낸다. 상품·만료·상태는 모두 Google 응답에서 가져온다.
 *   클라이언트가 보낸 productId는 승인(acknowledge) 호출에만 쓰고, 기록은 Google 값으로 한다.
 *
 * 검증 실패 시 권리를 주지 않는다 — 다른 실패는 '열린 방향'으로 처리하지만 돈이 걸린
 *   판정은 닫힌 방향이 맞다.
 *
 * 혜택 대상: 보호자가 결제하면 연결된 어르신에게 적용된다(resolveBeneficiary).
 *   클라이언트가 보낸 대상은 active 링크인지 확인한 뒤에만 인정한다.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { getSubscription, acknowledgeSubscription, mapState, isPlayConfigured } from "@/lib/billing/play-api";
import { resolveBeneficiary, getEntitlement } from "@/lib/billing/entitlement";
import { isProProduct } from "@/lib/billing/plans";

/** 토큰은 로그에 남기지 않는다 — 구매 토큰은 권리 증명이라 유출되면 안 된다 */
const mask = (t: string) => `${t.slice(0, 6)}…${t.slice(-4)}(${t.length})`;

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const userId = session.user.id;

  // 토큰 대입 공격·재전송 방어 — 계정당 분당 10회
  const rl = await checkRateLimit(`billing-verify:${userId}`, 10, 60_000);
  if (!rl.ok) {
    return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });
  }

  const body = await req.json().catch(() => null) as
    { purchaseToken?: unknown; productId?: unknown; beneficiaryUserId?: unknown } | null;
  const purchaseToken = typeof body?.purchaseToken === "string" ? body.purchaseToken.trim() : "";
  const clientProductId = typeof body?.productId === "string" ? body.productId.trim().slice(0, 200) : "";
  const requestedBeneficiary = typeof body?.beneficiaryUserId === "string" ? body.beneficiaryUserId.trim().slice(0, 100) : undefined;
  if (!purchaseToken || purchaseToken.length > 4000) {
    return NextResponse.json({ error: "purchaseToken이 필요합니다." }, { status: 400 });
  }

  if (!isPlayConfigured()) {
    // 설정 전에는 조용히 성공시키지 않는다 — 검증 없는 권리 부여를 막는다
    console.error("[billing] Play 검증 미설정(PLAY_PACKAGE_NAME / PLAY_SERVICE_ACCOUNT_JSON)");
    return NextResponse.json({ error: "결제 확인 기능이 아직 준비되지 않았습니다." }, { status: 503 });
  }

  let sub;
  try {
    sub = await getSubscription(purchaseToken);
  } catch (e) {
    console.warn(`[billing] 검증 실패 user=${userId.slice(0, 8)} token=${mask(purchaseToken)}:`, e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "구매를 확인할 수 없습니다. 잠시 후 다시 시도해주세요." }, { status: 502 });
  }

  const productId = sub.productId || clientProductId;
  if (!productId) {
    return NextResponse.json({ error: "구매 상품을 확인할 수 없습니다." }, { status: 502 });
  }
  if (!isProProduct(productId)) {
    console.warn(`[billing] 유료 티어가 아닌 상품: ${productId}`);
    return NextResponse.json({ error: "지원하지 않는 상품입니다." }, { status: 400 });
  }

  const status = mapState(sub.state, sub.autoRenewing);

  // 이미 등록된 토큰이면 혜택 대상을 바꾸지 않는다 — 같은 구매를 다른 어르신에게
  //   옮겨 붙이는 경로를 막는다(대상 변경은 해지 후 재결제로).
  const existing = await prisma.subscription.findUnique({
    where: { purchaseToken },
    select: { id: true, beneficiaryUserId: true, purchaserUserId: true },
  });

  if (existing && existing.purchaserUserId !== userId) {
    // 남의 구매 토큰을 자기 계정에 붙이려는 시도
    console.warn(`[billing] 토큰 소유자 불일치 — 거부 user=${userId.slice(0, 8)} token=${mask(purchaseToken)}`);
    return NextResponse.json({ error: "이미 다른 계정에 등록된 구매입니다." }, { status: 409 });
  }

  const beneficiaryUserId = existing?.beneficiaryUserId ?? await resolveBeneficiary(userId, requestedBeneficiary);

  // 돌려받을 칸은 id만 — 웹 결제 컬럼이 아직 DB에 없을 때(DDL보다 배포가 먼저) 없는 컬럼을 읽다 500이 나면 아래 승인을 못 한다(2026-10-22)
  await prisma.subscription.upsert({
    where: { purchaseToken },
    create: {
      purchaserUserId: userId, beneficiaryUserId, productId, purchaseToken,
      status, expiresAt: sub.expiresAt, verifiedAt: new Date(),
    },
    update: { productId, status, expiresAt: sub.expiresAt, verifiedAt: new Date() },
    select: { id: true },
  });

  // 3일 안에 승인하지 않으면 Google이 자동 환불한다. 클라이언트가 결제 직후 꺼져도
  //   권리가 유실되지 않도록 서버에서 승인한다.
  if (sub.needsAcknowledge) {
    const ok = await acknowledgeSubscription(productId, purchaseToken);
    console.log(`[billing] 승인 ${ok ? "완료" : "실패"} product=${productId} token=${mask(purchaseToken)}`);
  }

  const ent = await getEntitlement(userId);
  console.log(`[billing] 검증 완료 user=${userId.slice(0, 8)} beneficiary=${beneficiaryUserId.slice(0, 8)} status=${status} tier=${ent.tier}`);

  return NextResponse.json({
    ok: true,
    status,
    tier: ent.tier,
    expiresAt: sub.expiresAt?.toISOString() ?? null,
    beneficiaryIsSelf: beneficiaryUserId === userId,
  });
}
