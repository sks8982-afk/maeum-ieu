/**
 * 웹 결제 화면 설정 — 요금제·결제수단(채널 키)·상점 아이디·약관 버전·필수 동의·혜택 대상 후보·사업자 정보(설계 '조사 반영 결정' 1·3).
 *
 * 왜 API인가: 상점 아이디·채널 키를 NEXT_PUBLIC_으로 두면 빌드에 박혀 테스트 ↔ 실연동을 바꿀 때마다 재빌드해야 한다(research B 2).
 *   상점 아이디·채널 키는 비밀이 아니다(브라우저 SDK에 그대로 넘어간다). API Secret·웹훅 시크릿은 절대 싣지 않는다.
 * 관문: 앱 WebView 403(PG 정보 없음) · 판매 스위치 꺼짐 503 · 로그인 필요(lib/billing/portone-route pgGate).
 * 결제 주체(설계 13 — 10-22 검토로 좁힘): 보호자만 canPurchase. 어르신·의사·일반 회원은 false — 화면은 결제 대신 안내만, 서버(prepare)도
 *   거절한다(일반 회원은 하루 대화 한도가 없어 이용권으로 얻는 것이 없다 — lib/billing/portone-activate BENEFICIARY_ROLE).
 *   역할은 세션(JWT — 바뀐 뒤에도 남아 있을 수 있다)이 아니라 DB 값을 본다.
 *   시험(TEST) 모드에서는 정한 계정만(PORTONE_TEST_USER_IDS — lib/billing/portone-plans testModeAllows): 나머지 보호자는
 *   testModeRestricted로 안내만 본다(시험 결제로 실제 유료 혜택이 생기지 않게 — 설정 가이드 결정 6).
 * 혜택 대상 후보: 보호자에게 연결(active)된 **어르신 계정**만(일반·의사 계정이 연결돼 있어도 빼낸다 — 한도가 없다). 이름과 함께 연결한 날을
 *   싣는다 — 같은 이름의 계정이 끼어들어도 보호자가 가려낼 수 있게. covered = 이미 이용권이 있는 분(Play 포함 — 다시 결제할 수 없다).
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { DAILY_TURN_LIMIT } from "@/lib/usage/daily-limit";
import {
  PAY_METHOD_LABELS, availablePayMethods, channelKeyFor, expectedChannelType, getPgPlans, testModeAllows,
} from "@/lib/billing/portone-plans";
import { PG_TERMS_VERSION, REQUIRED_CONSENTS } from "@/lib/billing/portone-consent";
import { EARLY_CANCEL_PENALTY_PERCENT, RETRY_OFFSETS_DAYS, WITHDRAWAL_DAYS } from "@/lib/billing/portone-period";
import { BENEFICIARY_ROLE, hasLiveSubscription } from "@/lib/billing/portone-activate";
import { isPlayPurchaseEnabled, pgError, pgGate } from "@/lib/billing/portone-route";
import { readBizInfo } from "@/lib/biz-info";

interface Beneficiary { userId: string; name: string; covered: boolean; linkedAt: Date }

/** 혜택 대상 후보 — 보호자에게 연결된 어르신 계정(먼저 연결된 순) */
async function beneficiariesFor(guardianUserId: string): Promise<Beneficiary[]> {
  const links = await prisma.expertPatient.findMany({
    where: { expertUserId: guardianUserId, status: "active" }, orderBy: { createdAt: "asc" }, select: { patientUserId: true, createdAt: true },
  });
  const ids = links.map((l) => l.patientUserId);
  const users = ids.length > 0
    ? await prisma.user.findMany({ where: { id: { in: ids }, screeningMode: BENEFICIARY_ROLE }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name?.trim() || "연결된 가족"]));
  const people = links.filter((l) => nameOf.has(l.patientUserId))
    .map((l) => ({ userId: l.patientUserId, name: nameOf.get(l.patientUserId) as string, linkedAt: l.createdAt }));
  return Promise.all(people.map(async (p) => ({ ...p, covered: await hasLiveSubscription(p.userId) })));
}

export async function GET(req: Request) {
  const gate = await pgGate(req, "sales");
  if (!gate.ok) return gate.res;
  const me = await prisma.user.findUnique({ where: { id: gate.userId }, select: { screeningMode: true } });
  if (!me) return pgError(401, "login_required", "로그인이 필요합니다.");
  const role = me.screeningMode;
  const testModeRestricted = role === "guardian" && !testModeAllows(gate.userId);
  const canPurchase = role === "guardian" && !testModeRestricted;

  return NextResponse.json({
    enabled: true,
    mode: expectedChannelType() === "LIVE" ? "live" : "test",
    storeId: process.env.PORTONE_STORE_ID?.trim(),
    plans: getPgPlans(),
    payMethods: availablePayMethods().map((m) => ({ method: m, label: PAY_METHOD_LABELS[m], channelKey: channelKeyFor(m) })),
    termsVersion: PG_TERMS_VERSION,
    requiredConsents: [...REQUIRED_CONSENTS],
    role,
    canPurchase,
    testModeRestricted,
    beneficiaries: canPurchase ? await beneficiariesFor(gate.userId) : [],
    // 결제 직전 고지에 쓰는 규칙 — 화면이 숫자를 따로 적어 두면 코드와 어긋난다(research D 3)
    freeDailyTurnLimit: DAILY_TURN_LIMIT,
    rules: {
      withdrawalDays: WITHDRAWAL_DAYS, earlyCancelPenaltyPercent: EARLY_CANCEL_PENALTY_PERCENT, retryOffsetsDays: [...RETRY_OFFSETS_DAYS],
    },
    // 사업자 정보(BIZ_*) — 하단 표시와 같은 함수로 읽는다(값이 없는 칸은 null — 화면이 숨긴다, 설계 12)
    business: readBizInfo().info,
    playPurchaseEnabled: isPlayPurchaseEnabled(),
  });
}
