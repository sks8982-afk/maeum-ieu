/**
 * 웹 PG(포트원) 요금제·결제수단·기능 스위치 — 가격은 코드가 아니라 설정이다(lib/billing/plans.ts와 같은 원칙).
 *
 * 요금제: env BILLING_PLANS(JSON 배열) — **없으면** 임시 기본 3개, **형식이 틀리면 유료를 아예 노출하지 않는다**(fail-closed)
 *   + 경고 로그. 틀린 설정으로 엉뚱한 금액·한도를 파는 것보다 잠시 못 파는 편이 낫다.
 *   ⚠ 이미 가입한 구독은 이 목록에 기대지 않는다 — 가입 당시 금액·한도를 Subscription(priceKrw·dailyTurnLimit)에 적어 두고
 *   그대로 쓴다(요금 인상은 30일 전 별도 동의 — 전자상거래법 제13조⑥). 그래서 설정이 깨져도 낸 돈만큼의 혜택은 이어진다.
 *   카카오페이 '상품 3개 이상' 조건 때문에 기본값이 3개다(research uncertain 6).
 *
 * 기능 스위치: BILLING_PG_ENABLED가 정확히 "1"이고 필수 설정이 다 있어야 켜진다(isPgEnabled) — 키를 넣기 전 운영 변화 0.
 *   런타임 env를 매번 읽는다(NEXT_PUBLIC_ 금지 — 빌드에 박히면 재빌드 없이 끌 수 없다, lib/feature-flags 주석).
 *
 * 표현: '월 이용권(하루 대화 N회)'. '충전·크레딧·횟수권'은 쓰지 않는다(카드사 충전형 고위험 심사 — research D 8).
 *   그래서 이름은 설정에서 받지 않고 한도로 만든다(planDisplayName) — 설정 JSON의 name은 읽지 않는다.
 *   설정 예: BILLING_PLANS=[{"id":"day30","dailyTurnLimit":30,"priceKrw":19900},{"id":"day60","dailyTurnLimit":60,"priceKrw":39900}]
 */
import { flagOn } from "@/lib/flags";
import { DAILY_TURN_LIMIT } from "@/lib/usage/daily-limit";
import { serviceEmailProblem } from "@/lib/notify/email";
import { missingBizFields } from "@/lib/biz-info";

export interface PgPlan {
  id: string;
  name: string;
  dailyTurnLimit: number;
  /** 월 금액(원, 부가세 포함) */
  priceKrw: number;
}

export type PayMethod = "CARD" | "KAKAOPAY" | "NAVERPAY";
export const PAY_METHODS: readonly PayMethod[] = ["CARD", "KAKAOPAY", "NAVERPAY"];
export const PAY_METHOD_LABELS: Readonly<Record<PayMethod, string>> = { CARD: "카드", KAKAOPAY: "카카오페이", NAVERPAY: "네이버페이" };

/** 결제 이름의 앞부분 — 결제창·영수증·메일에 같은 말로 나간다 */
export const ORDER_NAME = "마음이음 월 이용권";

/** 표시 이름 — 요금제가 무엇이든 같은 꼴 */
export function planDisplayName(dailyTurnLimit: number): string {
  return `월 이용권(하루 대화 ${dailyTurnLimit}회)`;
}

/** 임시 기본값(설계 '조사 반영 결정' 4) — 가격은 사용자 결정 전 임시 */
export const DEFAULT_PG_PLANS: readonly PgPlan[] = [
  { id: "day20", name: planDisplayName(20), dailyTurnLimit: 20, priceKrw: 14_900 },
  { id: "day30", name: planDisplayName(30), dailyTurnLimit: 30, priceKrw: 19_900 },
  { id: "day60", name: planDisplayName(60), dailyTurnLimit: 60, priceKrw: 39_900 },
];

/** 네이버페이 최소 결제 100원(포트원 V2) · 월 100만 원 넘는 값은 자릿수 오타로 본다 */
const MIN_PRICE_KRW = 100;
const MAX_PRICE_KRW = 1_000_000;
const MAX_PLANS = 10;
const PLAN_ID_RE = /^[a-z0-9]{1,20}$/;

/** 요금제 한 개가 올바른가 — 틀린 이유(없으면 null) */
function planProblem(p: unknown, freeLimit: number): string | null {
  if (typeof p !== "object" || p === null) return "객체가 아님";
  const o = p as Record<string, unknown>;
  if (typeof o.id !== "string" || !PLAN_ID_RE.test(o.id)) return "id는 영소문자·숫자 1~20자";
  if (!Number.isInteger(o.dailyTurnLimit) || (o.dailyTurnLimit as number) <= 0) return `${o.id}: dailyTurnLimit는 양의 정수`;
  // 무료 한도 이하인 유료 요금제는 돈을 받고 아무것도 주지 않는다 — 무료 한도가 꺼져 있으면(0 이하) 비교하지 않는다
  if (freeLimit > 0 && (o.dailyTurnLimit as number) <= freeLimit) return `${o.id}: 하루 ${o.dailyTurnLimit}회가 무료 한도(${freeLimit}회) 이하`;
  const price = o.priceKrw as number;
  if (!Number.isInteger(price) || price < MIN_PRICE_KRW || price > MAX_PRICE_KRW) return `${o.id}: priceKrw는 ${MIN_PRICE_KRW}~${MAX_PRICE_KRW} 정수`;
  return null;
}

/** 목록 전체가 올바른가 — 하나라도 틀리면 전체를 버린다(일부만 노출하면 약관·화면의 요금표와 어긋난다) */
export function parsePgPlans(raw: string | undefined, freeLimit: number): { plans: readonly PgPlan[]; problem: string | null } {
  let list: unknown = DEFAULT_PG_PLANS;
  if (raw?.trim()) {
    try { list = JSON.parse(raw); } catch { return { plans: [], problem: "JSON 파싱 실패" }; }
  }
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PLANS) return { plans: [], problem: `배열(1~${MAX_PLANS}개)이 아님` };
  for (const p of list) {
    const problem = planProblem(p, freeLimit);
    if (problem) return { plans: [], problem };
  }
  const plans = (list as PgPlan[]).map((p) => ({
    id: p.id, name: planDisplayName(p.dailyTurnLimit), dailyTurnLimit: p.dailyTurnLimit, priceKrw: p.priceKrw,
  }));
  if (new Set(plans.map((p) => p.id)).size !== plans.length) return { plans: [], problem: "id 중복" };
  return { plans, problem: null };
}

// 같은 설정값은 한 번만 파싱·경고한다(요청마다 경고가 쌓이지 않게). 값이 바뀌면 다시 읽는다 — 재시작 없이 바꿀 수 있게
let cached: { raw: string | undefined; plans: readonly PgPlan[] } | null = null;

/** 지금 팔 수 있는 요금제 — 형식이 틀리면 빈 목록(유료 노출 안 함) */
export function getPgPlans(): readonly PgPlan[] {
  const raw = process.env.BILLING_PLANS;
  if (cached && cached.raw === raw) return cached.plans;
  const { plans, problem } = parsePgPlans(raw, DAILY_TURN_LIMIT);
  if (problem) console.warn(`[billing-pg] BILLING_PLANS 형식 오류 — 유료 요금제를 노출하지 않는다: ${problem}`);
  cached = { raw, plans };
  return plans;
}

export function findPlan(id: string): PgPlan | undefined {
  return getPgPlans().find((p) => p.id === id);
}

/** 결제수단별 포트원 채널 키(서버 런타임 env — 화면에는 config API로) */
export function channelKeyFor(method: PayMethod): string | undefined {
  const key = { CARD: process.env.PORTONE_CHANNEL_KEY_CARD, KAKAOPAY: process.env.PORTONE_CHANNEL_KEY_KAKAOPAY,
    NAVERPAY: process.env.PORTONE_CHANNEL_KEY_NAVERPAY }[method]?.trim();
  return key || undefined;
}

/** 쓸 수 있는 결제수단 — 채널 키가 있는 것만(비면 그 버튼을 숨긴다) */
export function availablePayMethods(): PayMethod[] {
  return PAY_METHODS.filter((m) => channelKeyFor(m) !== undefined);
}

export function isPayMethod(v: unknown): v is PayMethod {
  return typeof v === "string" && (PAY_METHODS as readonly string[]).includes(v);
}

/** 결제·빌링키의 channel.type이 이것이어야 한다 — PORTONE_MODE=live일 때만 LIVE(테스트 결제로 혜택을 주지 않게) */
export function expectedChannelType(): "LIVE" | "TEST" {
  return process.env.PORTONE_MODE?.trim() === "live" ? "LIVE" : "TEST";
}

/**
 * 시험(TEST) 모드에서 결제를 시작할 수 있는 계정인가 — PORTONE_TEST_USER_IDS(쉼표로 가른 사용자 id, "*"면 모두). 실연동(live)은 가리지 않는다.
 *   왜(2026-10-22 검토): 시험 채널 결제는 돈이 나가지 않거나(카카오페이) 밤에 자동 취소되는데(이니시스) 서버는 결제로 보고 유료 혜택을 준다.
 *   심사 기간에 스위치를 켜 두면 아무 보호자나 시험 결제로 유료 혜택을 받는다 — 시험은 정한 계정(운영자·심사용 계정)만(설정 가이드 결정 6).
 *   비어 있으면 아무도 시험 결제를 할 수 없다(실수로 비워도 열리지 않게). "*"는 개발 환경용 — 운영에 넣지 않는다.
 */
export function testModeAllows(userId: string): boolean {
  if (expectedChannelType() === "LIVE") return true;
  const raw = process.env.PORTONE_TEST_USER_IDS?.trim() ?? "";
  if (raw === "*") return true;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).includes(userId);
}

/**
 * 포트원 설정을 시작했나 — 상점 아이디(비밀 아님)가 있으면. 이미 있는 이용권을 돌보는 쪽(해지·환불·결제 웹훅·예약 작업·구독 관리 화면·
 *   약관 화면)이 이것을 본다(lib/billing/portone-route portoneServiceable). API Secret은 보지 않는다 — 운영 중 Secret이 빠지거나 만료돼도
 *   포트원은 걸어 둔 예약 결제를 그대로 실행하므로, 해지 의사를 받아 적고(포트원 정리는 실패를 알리고 예약 작업이 다시 한다) 관리 화면을
 *   보여야 한다(2026-10-22 검토 — 키를 빼자 해지까지 503이 됐다). 설정 전(상점 아이디 없음)에는 그대로 꺼진다(운영 변화 0).
 */
export function portoneConfigured(): boolean {
  return Boolean(process.env.PORTONE_STORE_ID?.trim());
}

/**
 * 켜는 데 필요한데 빠진 설정 — 이름만(값은 찍지 않는다). 빈 배열이면 다 있다.
 *   ENCRYPTION_KEY: 빌링키를 암호화해 저장한다 — 없으면 평문으로 남는다(lib/crypto 키 없음 = 원문 통과).
 *   PORTONE_MODE: 비우면 시험 모드로 본다 — 운영에서 빠지면 실결제가 대조에 걸린다. test|live를 **명시**해야 켜진다.
 *   CRON_SECRET: 없으면 예약 작업(3일 전 안내·대사·만료·환불 이어 하기)이 404로 멈춘다.
 *   서비스 메일(SERVICE_GMAIL_*): 자동결제마다 결제 내역을 알려야 한다(전자상거래법 제8조③ — 알리지 않은 자동결제는 분쟁해결기준상 환급).
 *     위급 메일 계정과 같으면 안 된다(lib/notify/email serviceEmailProblem).
 *   BIZ_*: 결제 직전 고지·하단의 판매자 정보(제10조①·제13조①) — 하나라도 비면 고지가 빈칸을 가리킨다.
 */
export function pgConfigProblems(): string[] {
  const required = ["PORTONE_STORE_ID", "PORTONE_API_SECRET", "PORTONE_WEBHOOK_SECRET", "ENCRYPTION_KEY"] as const;
  const problems: string[] = required.filter((k) => !process.env[k]?.trim());
  if (availablePayMethods().length === 0) problems.push("PORTONE_CHANNEL_KEY_*(하나 이상)");
  if (getPgPlans().length === 0) problems.push("BILLING_PLANS(팔 수 있는 요금제 없음 — 경고 로그 참조)");
  const mode = process.env.PORTONE_MODE?.trim();
  if (mode !== "test" && mode !== "live") problems.push("PORTONE_MODE(test|live)");
  if (!process.env.CRON_SECRET?.trim()) problems.push("CRON_SECRET");
  const mail = serviceEmailProblem();
  if (mail) problems.push(mail);
  return [...problems, ...missingBizFields()];
}

/** 웹 PG 결제가 켜져 있나 — 스위치(정확히 "1") + 필수 설정. 꺼져 있으면 PG 화면·API는 전부 꺼진다 */
export function isPgEnabled(): boolean {
  return flagOn(process.env.BILLING_PG_ENABLED) && pgConfigProblems().length === 0;
}

/** 포트원 요금제 id인가 — lib/billing/plans isProProduct가 쓴다(BILLING_PRO_PRODUCT_IDS와 무관하게 유료로 인정) */
export function isPgPlanId(productId: string): boolean {
  return getPgPlans().some((p) => p.id === productId);
}
