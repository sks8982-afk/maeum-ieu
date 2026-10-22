/**
 * 구독 화면 ↔ 서버 API 모양과 호출(클라이언트) — /api/billing/status · /api/billing/portone/{config,prepare,activate,cancel,refund}.
 *
 * 응답 모양은 서버 라우트(app/api/billing/portone/*, lib/billing/portone-status)와 같다 — JSON이라 날짜는 ISO 문자열로 온다.
 * 실패 응답은 { error, code } — error는 사람이 읽는 한국어라 그대로 보여 준다. 결제 실패의 PG 문구(activate 402 pgMessage)는
 *   **가공하지 않는다**(네이버페이 조건 — research B 5): 앞뒤에 말을 붙이지 않고 그 문자열만 보여 준다.
 * 서버 전용 모듈(lib/billing/portone-plans 등)은 가져오지 않는다(daily-limit → prisma가 브라우저 번들에 들어간다).
 */

export type PayMethod = "CARD" | "KAKAOPAY" | "NAVERPAY";

/** 기존 Play 필드 + 웹 PG(pg) — app/api/billing/status */
export interface BillingStatus {
  tier: "free" | "pro";
  expiresAt: string | null;
  source: "none" | "purchaser" | "beneficiary";
  guardianFeatures: boolean;
  beneficiaryName: string | null;
  usage: { used: number; limit: number; remaining: number } | null;
  productIds: string[];
  enforced: boolean;
  /** 앱 안 Play 구매 버튼을 보일까(BILLING_PLAY_ENABLED=1) — 없으면 꺼짐으로 본다 */
  playPurchaseEnabled?: boolean;
  /** 결제회원 본인의 포트원 이용권 — 앱 안·설정 전이면 null */
  pg?: PgStatus | { error: string } | null;
}

export interface PgSubscription {
  subscriptionId: string;
  /** activating(첫 결제 확인 중) | active | grace(결제 재시도 중) | canceled(해지 예약) */
  status: string;
  plan: { id: string; name: string; dailyTurnLimit: number | null; priceKrw: number | null };
  payMethodLabel: string;
  beneficiary: { userId: string; name: string };
  expiresAt: string | null;
  nextChargeAt: string | null;
  cancelAtPeriodEnd: boolean;
  usedPaidBenefit: boolean;
  withinWithdrawal: boolean;
  cancelOptions: {
    periodEnd: { endsAt: string | null; refundKrw: number };
    immediate: { refundKrw: number; rule: string; usedDays: number; periodDays: number; paidKrw: number };
  } | null;
}

export interface PgPayment {
  subscriptionId: string;
  kind: string;
  amountKrw: number;
  /** paid | failed | cancelled | partial_cancelled */
  status: string;
  paidAt: string | null;
  cancelledKrw: number;
  receiptUrl: string | null;
  failureReason: string | null;
  updatedAt: string;
}

export interface PgStatus { subscriptions: PgSubscription[]; payments: PgPayment[] }

/** 구독 상태의 포트원 이용권 — 실렸을 때만(앱 안·설정 전이면 null, 조회 실패면 error라 null) */
export const pgOf = (st: BillingStatus | null): PgStatus | null => (st?.pg && "subscriptions" in st.pg ? st.pg : null);

/** 관리할 것이 있나 — 이용권이나 결제 내역(해지한 뒤에도 결제 내역·영수증을 본다) */
export function hasPgRecords(st: BillingStatus | null): boolean {
  const pg = pgOf(st);
  return !!pg && pg.subscriptions.length + pg.payments.length > 0;
}

export interface PgPlan { id: string; name: string; dailyTurnLimit: number; priceKrw: number }

/** app/api/billing/portone/config 200 */
export interface PgConfig {
  enabled: true;
  plans: PgPlan[];
  payMethods: { method: PayMethod; label: string }[];
  termsVersion: string;
  requiredConsents: string[];
  role: string;
  canPurchase: boolean;
  /** 시험 모드(PORTONE_MODE=test)에서 허용 목록(PORTONE_TEST_USER_IDS) 밖이라 지금은 신청할 수 없다 */
  testModeRestricted: boolean;
  /** linkedAt: 연결한 시각(ISO) — 같은 이름의 계정과 구별하도록 화면에 보인다 */
  beneficiaries: { userId: string; name: string; covered: boolean; linkedAt: string }[];
  freeDailyTurnLimit: number;
  /** 사업자 정보(lib/biz-info readBizInfo — 값이 없는 칸은 null). 결제 직전 고지의 판매자·문의 줄에 쓴다 */
  business: Partial<Record<"name" | "phone" | "email", string | null>>;
  playPurchaseEnabled: boolean;
}

/** config를 불러온 결과 — 꺼짐(503)·앱 거절(403)은 오류가 아니라 화면 갈래다 */
export type ConfigState =
  | { kind: "loading" }
  | { kind: "ready"; config: PgConfig }
  | { kind: "off"; playPurchaseEnabled: boolean }
  | { kind: "error"; message: string };

/** 발급 준비 응답 — 브라우저 SDK에 넘길 값(app/api/billing/portone/prepare) */
export interface PreparedIssue {
  storeId: string;
  channelKey: string;
  issueId: string;
  issueName: string;
  method: PayMethod;
  priceKrw: number;
  customerId: string;
  redirectUrl: string;
  beneficiary: { userId: string; name: string | null };
}

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; code: string; error: string; body: Record<string, unknown> };

const NETWORK_ERROR = "인터넷 연결을 확인한 뒤 다시 시도해 주세요.";

/** JSON 요청 — 응답 본문이 객체가 아니어도 죽지 않는다. 네트워크 오류는 status 0 */
export async function requestJson<T>(url: string, init?: { method?: "GET" | "POST"; body?: unknown }): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? "GET",
      ...(init?.body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    return { ok: false, status: 0, code: "network", error: NETWORK_ERROR, body: {} };
  }
  const raw: unknown = await res.json().catch(() => null);
  const body = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  if (res.ok) return { ok: true, status: res.status, data: body as T };
  const error = typeof body.error === "string" && body.error ? body.error : "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.";
  return { ok: false, status: res.status, code: typeof body.code === "string" ? body.code : "unknown", error, body };
}

/** config 응답 → 화면 갈래. 403(앱)·503(꺼짐)은 PG 없음(off) — Play 버튼 스위치는 본문에 실려 오면 쓴다 */
export function toConfigState(r: ApiResult<PgConfig>): ConfigState {
  if (r.ok) return r.data.enabled === true ? { kind: "ready", config: r.data } : { kind: "off", playPurchaseEnabled: false };
  if (r.status === 403 || r.status === 503 || r.status === 404) {
    return { kind: "off", playPurchaseEnabled: r.body.playPurchaseEnabled === true };
  }
  return { kind: "error", message: r.error };
}

/** 첫 결제 확정 결과 — 화면 문구 갈래 */
export type ActivateOutcome =
  | { kind: "active" }
  | { kind: "processing" }
  /** 결과를 모른다 — BillingKey.Issued 웹훅이 이어서 확정한다(다시 결제하라고 하지 않는다). 로그인이 없으면 로그인 안내를 함께 */
  | { kind: "unconfirmed"; needsLogin: boolean }
  | { kind: "failed"; message: string };

/**
 * 결과를 모르는 응답인가(2026-10-22 검토 — 예전엔 '로그인이 필요합니다.'를 실패처럼 보이고, 그 뒤 웹훅이 그대로 결제했다).
 *   확정 전에 멈춤: 401(다른 브라우저로 돌아옴)·429·403 앱 오판(카드사 앱 WebView 등) / 도중에 멈춤: 502 temporary·5xx·네트워크(0).
 */
function unconfirmedResponse(r: { status: number; code: string }): boolean {
  return r.status === 0 || r.status === 401 || r.status === 429 || r.code === "temporary" || r.code === "app_webview"
    || (r.status >= 500 && r.code === "unknown");
}

/** 빌링키를 서버에 넘겨 첫 결제까지 — 브라우저 복귀(PC)와 모바일 복귀 화면(/subscribe/return)이 같이 쓴다 */
export async function activateIssue(issueId: string, billingKey: string): Promise<ActivateOutcome> {
  const r = await requestJson<{ ok: true; status: "active" | "processing" }>("/api/billing/portone/activate", {
    method: "POST", body: { issueId, billingKey },
  });
  if (r.ok) return r.data.status === "active" && r.status === 200 ? { kind: "active" } : { kind: "processing" };
  if (unconfirmedResponse(r)) return { kind: "unconfirmed", needsLogin: r.status === 401 };
  // PG 문구가 있으면 그 문자열만 그대로(가공 금지) — 없으면 서버 안내
  const pgMessage = typeof r.body.pgMessage === "string" && r.body.pgMessage ? r.body.pgMessage : null;
  return { kind: "failed", message: pgMessage ?? r.error };
}

/** 구독 화면의 결제 결과 문구(PC 복귀·모바일 복귀 공통) */
export const ACTIVATE_TEXT = {
  active: "이용권이 적용됐어요. 결제 내역은 이메일로도 보내 드려요.",
  processing: "결제를 확인하고 있어요. 잠시 뒤 구독 화면을 다시 열어 확인해 주세요.",
  unconfirmed: "결제 결과를 아직 확인하지 못했어요. 결제가 되면 이메일로 알려 드려요. 잠시 뒤 구독 관리에서 이용권이 적용됐는지 확인해 주세요.",
} as const;
