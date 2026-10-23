/**
 * 정기결제 발급 준비 — 요금제·결제수단·혜택 대상·필수 동의를 서버가 확정하고 빌링키 발급 매개변수를 내려준다(research B 5·6).
 *
 * 입력 { planId, method, beneficiaryUserId, consents: { terms, autoRenew, privacyEntrust, refundPolicy }, termsVersion,
 *        expectedPriceKrw, expectedDailyTurnLimit }
 *   · 금액은 **서버 요금제 값만** 쓴다 — 가입 당시 금액·한도는 구독에 고정된다(갱신도 그 금액). 화면이 보낸 금액·한도(expected*)는
 *     결제하는 데 쓰지 않고 **대조만** 한다: 화면에 보인 것과 지금 요금이 다르면 409 price_changed(요금 설정을 바꿔 배포하는 사이 열려
 *     있던 화면에서, 본 적 없는 금액으로 첫 결제와 매달 갱신이 걸리지 않게 — 카드·간편결제 발급 창에는 금액이 나오지 않는다, 10-22 검토).
 *   · 약관 문구 버전(termsVersion)은 필수 — 화면이 보여 준 문안과 지금 문안이 다르면 409, 빠지면 400(어느 문안인지 모르는 동의를 지금
 *     버전으로 적지 않는다 — 10-22 검토).
 *   · 결제 주체는 보호자만(설계 13 — 치매 어르신 본인 결제는 의사무능력으로 무효가 될 수 있다. 일반 회원은 하루 대화 한도가 없어
 *     이용권으로 얻는 것이 없다 — 10-22 검토). 역할은 DB 값으로 본다. 시험 모드에서는 정한 계정만(test_mode_restricted).
 *   · 혜택 대상: 보호자에게 연결(active)된 어르신 계정 중 고른 분 — 고른 사람과 다르면 바꿔 붙이지 않고 거절한다.
 *   · 어르신 1명당 살아 있는 이용권 하나(Play 포함) — 이미 있으면 409. 결제회원당 하루 발급 준비 상한(MAX_PENDING_PER_DAY) — 넘으면 429.
 *   · 필수 동의 넷이 전부 true여야 하고, 동의 기록(항목·문구 버전·안내한 조건·시각)을 구독과 함께 남긴다.
 * 응답은 브라우저 SDK(requestIssueBillingKey)에 그대로 넘길 값 — 상점 아이디·채널 키·issueId·결제창 이름·돌아올 주소.
 *   고객 식별은 내부 불투명 id만(customerId — 네이버페이 merchantUserId에 개인정보 금지). buyer(이름·이메일)는 이니시스 PC 결제창이
 *   요구해서 본인 화면에만 준다(전화번호는 저장하지 않으니 화면이 받는다).
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { type PayMethod, type PgPlan, channelKeyFor, findPlan, isPayMethod, testModeAllows } from "@/lib/billing/portone-plans";
import { PG_TERMS_VERSION, REQUIRED_CONSENTS, consentsComplete } from "@/lib/billing/portone-consent";
import { createPendingSubscription, resolvePgBeneficiary, PENDING_TTL_MS } from "@/lib/billing/portone-activate";
import { orderNameFor } from "@/lib/billing/portone-sync";
import { pgError, pgGate, publicBaseUrl, readJsonObject, stringField } from "@/lib/billing/portone-route";

const roleRefusal = () => pgError(403, "role_not_allowed", "보호자 계정에서 결제할 수 있어요.");
const badRequest = () => pgError(400, "bad_request", "잘못된 요청입니다.");

/** 혜택 대상 거절 → 응답 — 하루 한도가 걸리지 않는 계정(일반·의사)에는 한도를 늘리는 이용권을 붙이지 않는다(not_eligible) */
function beneficiaryRefusal(code: "role_not_allowed" | "not_linked" | "not_eligible"): NextResponse {
  if (code === "role_not_allowed") return roleRefusal();
  if (code === "not_eligible") return pgError(403, "not_eligible", "이용권은 연결된 어르신 계정에만 적용할 수 있어요.");
  return pgError(403, "not_linked", "혜택 받을 분을 연결된 가족 중에서 골라 주세요.");
}

/** 발급 준비 거절 → 응답 */
function pendingRefusal(code: "duplicate" | "consent_required" | "too_many_attempts"): NextResponse {
  if (code === "duplicate") return pgError(409, "duplicate", "이 분은 이미 이용권이 적용되어 있어요.");
  if (code === "too_many_attempts") return pgError(429, "too_many_attempts", "오늘은 결제 시도가 많았어요. 내일 다시 시도하거나 고객센터로 문의해 주세요.");
  return pgError(400, "consent_required", "필수 항목에 모두 동의해 주세요.");
}

type Selection = { ok: true; plan: PgPlan; method: PayMethod; channelKey: string } | { ok: false; res: NextResponse };

/** 화면이 보인 요금(금액·한도)과 지금 요금제가 같은가 — 정수가 아니면 null(형식 오류) */
function sameOffer(body: Record<string, unknown>, plan: PgPlan): boolean | null {
  const price = body.expectedPriceKrw;
  const limit = body.expectedDailyTurnLimit;
  if (!Number.isInteger(price) || !Number.isInteger(limit)) return null;
  return price === plan.priceKrw && limit === plan.dailyTurnLimit;
}

/** 요금제·결제수단·약관 버전·화면이 본 요금·필수 동의 — 하나라도 틀리면 그 이유로 거절 */
function parseSelection(body: Record<string, unknown>): Selection {
  const planId = stringField(body.planId, 40);
  const plan = planId ? findPlan(planId) : undefined;
  if (!plan) return { ok: false, res: pgError(400, "invalid_plan", "요금제를 다시 골라 주세요.") };
  const method = isPayMethod(body.method) ? body.method : null;
  const channelKey = method ? channelKeyFor(method) : undefined;
  if (!method || !channelKey) return { ok: false, res: pgError(400, "invalid_method", "결제수단을 다시 골라 주세요.") };
  if (typeof body.termsVersion !== "string") return { ok: false, res: badRequest() };
  // 다른 문구에 동의한 화면(새로 고치기 전의 옛 화면)에서 온 요청 — 동의 기록이 실제로 본 문구와 어긋나지 않게
  if (body.termsVersion !== PG_TERMS_VERSION) {
    return { ok: false, res: pgError(409, "terms_outdated", "약관이 바뀌었어요. 화면을 새로 고친 뒤 다시 확인해 주세요.") };
  }
  const same = sameOffer(body, plan);
  if (same === null) return { ok: false, res: badRequest() };
  if (!same) return { ok: false, res: pgError(409, "price_changed", "요금이 바뀌었어요. 화면을 새로 고친 뒤 금액을 다시 확인해 주세요.") };
  if (!consentsComplete(body.consents)) return { ok: false, res: pgError(400, "consent_required", "필수 항목에 모두 동의해 주세요.") };
  return { ok: true, plan, method, channelKey };
}

export async function POST(req: Request) {
  const gate = await pgGate(req, "sales", "prepare");
  if (!gate.ok) return gate.res;
  const userId = gate.userId;
  const body = await readJsonObject(req);
  if (!body) return badRequest();
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true, screeningMode: true } });
  if (!me) return pgError(401, "login_required", "로그인이 필요합니다.");
  if (me.screeningMode !== "guardian") return roleRefusal();
  if (!testModeAllows(userId)) {
    return pgError(403, "test_mode_restricted", "지금은 결제 시험 중이라 정해진 계정만 결제할 수 있어요.");
  }
  const sel = parseSelection(body);
  if (!sel.ok) return sel.res;

  const target = await resolvePgBeneficiary(userId, me.screeningMode, stringField(body.beneficiaryUserId, 100));
  if (!target.ok) return beneficiaryRefusal(target.code);
  const pending = await createPendingSubscription({
    purchaserUserId: userId, beneficiaryUserId: target.beneficiaryUserId, plan: sel.plan, method: sel.method,
    consent: { termsVersion: PG_TERMS_VERSION, items: REQUIRED_CONSENTS },
  });
  if (!pending.ok) return pendingRefusal(pending.code);
  const beneficiary = await prisma.user.findUnique({ where: { id: target.beneficiaryUserId }, select: { name: true } });

  return NextResponse.json({
    subscriptionId: pending.subscriptionId,
    storeId: process.env.PORTONE_STORE_ID?.trim(),
    channelKey: sel.channelKey,
    issueId: pending.issueId,
    issueName: orderNameFor(sel.plan.dailyTurnLimit),
    method: sel.method,
    billingKeyMethod: sel.method === "CARD" ? "CARD" : "EASY_PAY",
    priceKrw: sel.plan.priceKrw,
    planName: sel.plan.name,
    dailyTurnLimit: sel.plan.dailyTurnLimit,
    customerId: userId,
    buyer: { fullName: me.name?.trim() || null, email: me.email },
    redirectUrl: `${publicBaseUrl(req)}/subscribe/return?issueId=${pending.issueId}`,
    beneficiary: { userId: target.beneficiaryUserId, name: beneficiary?.name?.trim() || null },
    expiresInSec: Math.floor(PENDING_TTL_MS / 1000),
  });
}
