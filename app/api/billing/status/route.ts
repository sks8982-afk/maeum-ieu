/**
 * 내 구독 상태 조회 — 앱·웹이 유료 여부와 남은 대화량을 표시할 때 쓴다.
 *
 * 민감정보(구매 토큰·주문 ID)는 돌려주지 않는다. 화면에 필요한 것만 — 티어, 만료일,
 *   오늘 남은 대화 수, 혜택 대상(보호자가 결제한 경우 어르신 이름).
 *
 * 웹 PG(포트원) 이용권(2026-10-22): pg에 결제회원 본인의 구독 관리 정보를 싣는다(lib/billing/portone-status). 위의 Play 필드는 그대로다.
 *   · 우리 앱이 틀림없는 요청에는 싣지 않는다(pg: null — Play 정책상 앱 안에 웹 결제 정보·문구를 두지 않는다, lib/billing/portone-route
 *     isDefiniteAppRequest). WebView 표지("; wv)")만으로는 빼지 않는다 — 목록 밖 인앱 브라우저에서 해지 버튼이 사라진다(해지 방해).
 *     앱 화면은 pg를 그리지 않는다(app/subscribe SubscribeView — window.ReactNativeWebView면 Play만).
 *   · 포트원 설정 전에는 조회하지 않는다(pg: null — 운영 변화 0). 조회가 실패하면 pg: { error } — Play 필드는 그대로 나간다.
 *   · playPurchaseEnabled: 앱 안 Play 구매 버튼을 보일지(BILLING_PLAY_ENABLED=1일 때만 — 기본은 구독 상태만).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEntitlement } from "@/lib/billing/entitlement";
import { getDailyUsage } from "@/lib/usage/daily-limit";
import { BILLING_ENFORCE, ENTITLED_STATUSES, PRO_PRODUCT_IDS } from "@/lib/billing/plans";
import { type PgStatus, pgStatusFor } from "@/lib/billing/portone-status";
import { isDefiniteAppRequest, isPlayPurchaseEnabled, portoneServiceable } from "@/lib/billing/portone-route";

/** 결제회원의 포트원 이용권 — 우리 앱·설정 전이면 null, 실패해도 Play 응답을 막지 않는다 */
async function pgStatus(req: Request, userId: string): Promise<PgStatus | { error: string } | null> {
  if (isDefiniteAppRequest(req) || !portoneServiceable()) return null;
  try {
    return await pgStatusFor(userId);
  } catch (e) {
    console.warn("[billing] 포트원 구독 정보 조회 실패:", e instanceof Error ? e.message.slice(0, 80) : e);
    return { error: "결제 정보를 불러오지 못했어요. 잠시 후 다시 열어 주세요." };
  }
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  const userId = session.user.id;

  const ent = await getEntitlement(userId);

  // 어르신 본인 계정이면 오늘 사용량도 함께 — 보호자 화면에는 자기 대화량이 의미 없다.
  //   (2026-10-22) 일반 회원도 뺀다 — 하루 한도는 어르신 계정에만 걸린다(app/api/chat mode === "user"). 일반 회원에게 "15회 / 10회"를
  //   보이면 없는 한도가 있는 것처럼 보여 한도를 늘리는 이용권을 사게 만든다.
  let usage: { used: number; limit: number; remaining: number } | null = null;
  if ((session.user.screeningMode ?? "user") === "user") {
    const conv = await prisma.conversation.findFirst({
      where: { userId }, orderBy: { createdAt: "desc" }, select: { id: true },
    });
    if (conv) {
      const u = await getDailyUsage(conv.id, userId);
      usage = { used: u.used, limit: u.limit, remaining: u.remaining };
    }
  }

  // 보호자가 결제한 경우 누구에게 혜택이 가는지 보여준다(결제 후 "적용이 됐나?" 불안 해소)
  //   혜택이 있는 상태만 본다 — 포트원 결제 시도(pending·failed)는 만료 시각이 비어 있어 내림차순 맨 앞에 와, 결제하지 않은 분의
  //   이름이 나올 수 있다(Postgres DESC는 NULL 먼저).
  let beneficiaryName: string | null = null;
  if (ent.tier === "pro") {
    const sub = await prisma.subscription.findFirst({
      where: { purchaserUserId: userId, revokedAt: null, status: { in: [...ENTITLED_STATUSES] } },
      orderBy: { expiresAt: "desc" },
      select: { beneficiary: { select: { id: true, name: true } } },
    });
    if (sub?.beneficiary && sub.beneficiary.id !== userId) beneficiaryName = sub.beneficiary.name ?? null;
  }

  return NextResponse.json({
    tier: ent.tier,
    expiresAt: ent.expiresAt?.toISOString() ?? null,
    source: ent.source,
    guardianFeatures: ent.guardianFeatures,
    beneficiaryName,
    usage,
    // 앱이 구매 시트를 띄울 때 쓸 상품 ID. 비어 있으면 아직 가격이 정해지지 않은 상태다.
    productIds: PRO_PRODUCT_IDS,
    enforced: BILLING_ENFORCE,
    playPurchaseEnabled: isPlayPurchaseEnabled(),
    pg: await pgStatus(req, userId),
  });
}
