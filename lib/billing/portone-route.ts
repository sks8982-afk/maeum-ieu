/**
 * 웹 PG(포트원) API 라우트 공용 관문 — **서버 전용**. 스위치·앱 WebView 거절·오리진·로그인·요청 빈도를 한 곳에서 가른다.
 *
 * 스위치는 두 단계다(설계 0 '기능 스위치'):
 *   · sales   새 가입(config·prepare·activate·BillingKey.Issued 웹훅) — isPgEnabled()(BILLING_PG_ENABLED=1 + 필수 설정)일 때만.
 *   · service 이미 있는 이용권 돌보기(해지·환불·결제 결과 웹훅·예약 작업·구독 상태) — 포트원 키(PORTONE_API_SECRET·PORTONE_STORE_ID)만
 *     있으면. 키가 없으면(설정 전) 이것도 꺼져 **운영 변화 0**은 그대로다.
 *   ⚠ 설계와 다르게 한 점: 판매 스위치를 끄고 나서도 포트원은 이미 걸어 둔 예약 결제를 그대로 실행한다. 그때 해지 API까지 끄면
 *     결제는 되는데 해지를 못 하는 해지 방해(전자상거래법 제21조의2 제1항 제4호)가 되고, 웹훅·대사를 끄면 돈은 나갔는데 혜택이
 *     끊긴다. 그래서 스위치는 "새로 팔지 않는다"까지만 막는다.
 *
 * 앱 WebView(설계 5·10 — Play 결제 정책): 화면은 window.ReactNativeWebView로 PG를 숨기고, 서버는 앱 요청을 한 번 더 막는다.
 *   · 새 가입(sales)은 넓게 — isAppWebViewRequest(앱 표지 + Android WebView 표지 "; wv)").
 *   · 해지·환불·구독 관리 정보(service)는 우리 앱이 틀림없을 때만 — isDefiniteAppRequest(2026-10-22 검토). "; wv)"는 목록에 없는 다른 앱의
 *     인앱 브라우저(당근·토스 등)도 갖고 있어, 그것으로 해지를 막으면 해지 방해(전자상거래법 제21조의2)가 된다. Play 정책은 구매로 이끄는
 *     것을 막는 것이고, 앱 화면은 해지 API를 부르지 않는다(PG 화면이 없다).
 * CSRF: 세션 쿠키는 SameSite=Lax라 다른 사이트의 POST에 실리지 않지만, 돈이 움직이는 요청은 Origin도 본다(다르면 거절).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { flagOn } from "@/lib/flags";
import { checkRateLimit } from "@/lib/rate-limit";
import { isPgEnabled, portoneConfigured } from "@/lib/billing/portone-plans";
import { portoneErrorType } from "@/lib/billing/portone-client";

/** 우리 앱(MaeumApp)의 Android 패키지 — Android WebView는 요청에 X-Requested-With: <앱 패키지>를 붙인다(Chromium이 없애는 중이라 없을 수 있다) */
const APP_PACKAGE = "com.maeumapp";

/**
 * 다른 앱의 인앱 브라우저 표지 — 있으면 우리 앱이 아니다. 보호자가 카카오톡으로 받은 링크를 누르면 카카오톡 인앱 브라우저가 열리고,
 *   그것도 Android WebView라 UA에 "; wv)"가 붙는다. 그런 사람을 앱 사용자로 오판해 결제를 막지 않게 한다(설계 5).
 *   구글 앱(GSA/)·덕덕고(DuckDuckGo/)·당근·토스·카카오페이도 WebView다(2026-10-22 검토 — 목록은 끝이 없어, 해지 쪽은 이 목록에 기대지 않는다).
 *   우리 앱 UA에는 이런 표지가 없다(MaeumApp App.jsx — userAgent·applicationNameForUserAgent를 바꾸지 않는다).
 */
const OTHER_IN_APP_BROWSER = /KAKAOTALK|KAKAOPAY|NAVER\(inapp|DaumApps|Instagram|FBAN|FBAV|FB_IAB|\bLine\/|BAND\/|\bGSA\/|DuckDuckGo\/|DaangnApp|TossApp/i;

/** X-Requested-With의 앱 패키지 이름(점으로 이은 꼴만) — "XMLHttpRequest" 같은 값은 패키지가 아니라 없는 것으로 본다 */
function requestingPackage(req: Request): string | null {
  const v = req.headers.get("x-requested-with")?.trim().toLowerCase() ?? "";
  return /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(v) ? v : null;
}

/**
 * 우리 앱(MaeumApp)이 틀림없는 요청인가 — 해지·환불·구독 관리 정보(service)의 앱 거절은 이것만 본다.
 *   ① X-Requested-With가 우리 패키지 — Android WebView가 붙인다(Chromium이 없애는 중이라 없을 수 있다)
 *   ② UA에 "MaeumApp/" — 앱이 UA 접미사를 붙이게 되면(applicationNameForUserAgent) 그대로 잡힌다(지금 앱은 붙이지 않는다 — TODO 앱 저장소)
 */
export function isDefiniteAppRequest(req: Request): boolean {
  if (requestingPackage(req) === APP_PACKAGE) return true;
  return /\bMaeumApp\//i.test(req.headers.get("user-agent") ?? "");
}

/**
 * 앱(MaeumApp) WebView에서 온 요청으로 볼까 — 새 가입(sales)의 앱 거절. 우리 앱이 틀림없으면(isDefiniteAppRequest) 앱이고, 그 밖에는
 *   ③ X-Requested-With가 다른 앱 패키지면 그 앱의 WebView다 — 우리 앱이 아니다
 *   ④ UA에 Android WebView 표지 "; wv)"가 있고 다른 앱의 인앱 브라우저 표지가 없다 — 우리 앱 WebView의 기본 UA가 이 꼴이다
 *      (예: "Mozilla/5.0 (Linux; Android 14; SM-S921N Build/…; wv) AppleWebKit/537.36 … Chrome/… Mobile Safari/537.36").
 *   앱 버전 전역값(window.MAEUM_APP_VERSION)은 화면만 볼 수 있다 — 화면 쪽 판별(inApp)이 그것으로 PG를 숨긴다.
 */
export function isAppWebViewRequest(req: Request): boolean {
  if (isDefiniteAppRequest(req)) return true;
  if (requestingPackage(req)) return false;
  const ua = req.headers.get("user-agent") ?? "";
  return /; wv\)/.test(ua) && !OTHER_IN_APP_BROWSER.test(ua);
}

/** 다른 사이트에서 보낸 요청인가 — Origin이 있으면 이 서버(요청 주소 또는 NEXTAUTH_URL)와 같아야 한다. 없으면 비브라우저로 보고 통과(세션은 따로 본다) */
export function isCrossSiteRequest(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const allowed = new Set<string>([new URL(req.url).origin]);
  const base = process.env.NEXTAUTH_URL?.trim();
  if (base) {
    try { allowed.add(new URL(base).origin); } catch { /* 잘못된 설정 — 요청 주소만 인정 */ }
  }
  return !allowed.has(origin);
}

/**
 * 이미 있는 이용권을 돌볼 수 있나 — 포트원 설정을 시작했으면(상점 아이디 — lib/billing/portone-plans portoneConfigured). 판매 스위치와 별개.
 *   API Secret은 보지 않는다(2026-10-22 검토): 운영 중 Secret이 빠지거나 만료돼도 포트원은 걸어 둔 예약 결제를 실행한다 — 그때 해지·환불
 *   API와 구독 관리 화면까지 꺼지면 돈은 나가는데 해지를 못 한다(해지 방해). Secret이 없으면 해지 의사는 기록되고 포트원 정리는 실패를
 *   알린다(운영 경보·예약 작업). 설정 전(상점 아이디 없음)에는 그대로 꺼진다(운영 변화 0).
 */
export function portoneServiceable(): boolean {
  return portoneConfigured();
}

/** 앱 안 Play 구독 구매 버튼을 보일까 — BILLING_PLAY_ENABLED=1일 때만(설계 '조사 반영 결정' 10. 기본은 구독 상태만) */
export function isPlayPurchaseEnabled(): boolean {
  return flagOn(process.env.BILLING_PLAY_ENABLED);
}

/** 오류 응답 — 화면이 갈래를 나눌 code와 그대로 보여 줄 error(한국어) */
export function pgError(status: number, code: string, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ ...extra, error, code }, { status });
}

/**
 * 앱 WebView 거절 — PG 정보·문구는 싣지 않는다(앱 화면이 이 응답을 그대로 보여 줘도 웹 결제 안내가 되지 않게).
 *   해지·환불(service)에는 브라우저에서 다시 열라고 덧붙인다 — 해지 길을 알려 주는 말이라 구매로 이끌지 않는다. 가입(sales)에는 붙이지 않는다.
 */
export function appWebViewRefusal(mode: "sales" | "service" = "sales"): NextResponse {
  const error = mode === "service"
    ? "이 화면에서는 이용할 수 없어요. 크롬·삼성 인터넷 같은 브라우저에서 다시 열어 주세요."
    : "이 화면에서는 이용할 수 없어요.";
  return pgError(403, "app_webview", error, { enabled: false, playPurchaseEnabled: isPlayPurchaseEnabled() });
}

export type PgGate = { ok: true; userId: string } | { ok: false; res: NextResponse };

/** 1분에 이만큼까지(계정당) — 결제 확정·해지를 연타하거나 남의 issueId를 대입하는 시도를 늦춘다(/api/billing/verify와 같은 값) */
const RATE_LIMIT_PER_MIN = 10;

/**
 * 관문 — 순서: 앱 WebView → 스위치 → 오리진(쓰기 요청) → 로그인 → 요청 빈도(rateKey를 주면).
 *   mode "sales"는 새 가입, "service"는 이미 있는 이용권(맨 위 주석 — 앱 판별의 넓이도 다르다).
 */
export async function pgGate(req: Request, mode: "sales" | "service", rateKey?: string): Promise<PgGate> {
  const inApp = mode === "sales" ? isAppWebViewRequest(req) : isDefiniteAppRequest(req);
  if (inApp) return { ok: false, res: appWebViewRefusal(mode) };
  const open = mode === "sales" ? isPgEnabled() : portoneServiceable();
  if (!open) return { ok: false, res: pgError(503, "pg_disabled", "웹 결제를 준비하고 있어요.", { enabled: false }) };
  if (req.method !== "GET" && isCrossSiteRequest(req)) return { ok: false, res: pgError(403, "cross_site", "잘못된 요청입니다.") };
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return { ok: false, res: pgError(401, "login_required", "로그인이 필요합니다.") };
  if (rateKey) {
    const rl = await checkRateLimit(`billing-pg-${rateKey}:${userId}`, RATE_LIMIT_PER_MIN, 60_000);
    if (!rl.ok) return { ok: false, res: pgError(429, "rate_limited", "잠시 후 다시 시도해 주세요.") };
  }
  return { ok: true, userId };
}

/** JSON 본문(객체만) — 형식이 틀리면 null */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await req.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** 문자열 입력 — 앞뒤 공백을 지우고 비었거나 너무 길면 null */
export function stringField(v: unknown, maxLength: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s && s.length <= maxLength ? s : null;
}

/** 이 서비스의 바깥 주소 — 결제창이 돌아올 주소(redirectUrl)의 기준. NEXTAUTH_URL이 없으면 요청 주소 */
export function publicBaseUrl(req: Request): string {
  const base = process.env.NEXTAUTH_URL?.trim().replace(/\/+$/, "");
  return base || new URL(req.url).origin;
}

/** 오류 종류만(로그용) — 포트원 오류는 e.data.type, 그 밖에는 메시지 앞부분만(개인정보가 섞이지 않게) */
export function errorKind(e: unknown): string {
  return portoneErrorType(e) ?? (e instanceof Error ? e.message.slice(0, 80) : "알 수 없음");
}

/** 해지·환불 거절 → 응답. 남의 것과 없는 것은 같은 답이다(IDOR — 있는지조차 알리지 않는다) */
export function cancelRefusal(code: "not_found" | "forbidden" | "not_cancellable"): NextResponse {
  return code === "not_cancellable"
    ? pgError(409, "not_cancellable", "이미 끝났거나 해지할 수 없는 이용권이에요.")
    : pgError(404, "not_found", "이용권을 찾을 수 없어요.");
}

/**
 * 지금 해지(청약철회 포함) 도중 오류 — 해지가 이미 기록됐으면(revoked: 혜택 종료·환불 목표 고정) 환불만 남은 것이다.
 *   그때는 예약 작업(/api/cron/billing → finishRevocation)이 같은 금액으로 이어 간다고 알린다(202). 기록 전이면 아무것도 바뀌지 않았다(502).
 */
export async function cancelNowFailed(subscriptionId: string, userId: string, e: unknown): Promise<NextResponse> {
  console.error(`[billing-pg] 지금 해지 처리 실패 sub=${subscriptionId.slice(0, 8)}: ${errorKind(e)}`);
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId }, select: { status: true, purchaserUserId: true } })
    .catch(() => null);
  if (sub?.status === "revoked" && sub.purchaserUserId === userId) {
    return NextResponse.json({
      ok: true, refundPending: true,
      // 약관 '환불 금액 계산과 방법' ③ — 신청일부터 3영업일 안에 결제 취소를 요청한다(예약 작업은 하루 1회)
      message: "해지는 끝났어요. 환불(결제 취소)이 늦어져 자동으로 다시 시도해요. 신청일부터 3영업일 안에 결제한 수단으로 취소를 요청해요.",
    }, { status: 202 });
  }
  return pgError(502, "temporary", "해지를 처리하지 못했어요. 잠시 후 다시 시도해 주세요.");
}
