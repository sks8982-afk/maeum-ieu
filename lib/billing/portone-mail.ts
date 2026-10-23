/**
 * 웹 PG(포트원) 결제 안내 메일 — 결제 완료·결제 3일 전·결제 실패·만료·해지·환불.
 *
 * 왜 보내나: 자동결제는 될 때마다 금액·시기·방법을 알려야 한다(전자상거래법 제8조③·시행규칙 제5조 — 알리지 않은 자동결제는
 *   분쟁해결기준상 '청구 금액 환급'). 결제 3일 전 안내는 권고(방미통위 구독 안내서 2026-05). research B 12·D 4~6.
 * 받는 사람은 **결제회원**(보호자 — User.email, 로그인 주소). 발송은 lib/notify/email의 sendServiceEmail — 위급 메일과 **다른 계정**
 *   (SERVICE_GMAIL_*)이다. 같은 계정이면 결제 메일이 Gmail 하루 발신 한도를 써 보호자 위급 메일이 막힐 수 있다(2026-10-22 검토).
 *   결제 쪽 운영 경보도 같은 계정으로 보낸다(billingOpsAlert).
 * 실패 방향: 메일은 결제 처리를 막지 않는다 — 설정이 없거나 보내지 못하면 경고 로그만 남기고 넘어간다(throw 없음).
 *   결제 완료 메일은 보냈는지 원장(BillingPayment.paidMailAt)에 남기고, 못 보냈으면 예약 작업이 다시 보낸다(lib/billing/portone-maintenance).
 * 표현: '월 이용권(하루 대화 N회)'. 의학적 효능 표현·'충전·크레딧·횟수권'은 쓰지 않는다(research D 8).
 */
import { prisma } from "@/lib/prisma";
import { isServiceEmailConfigured, sendOpsAlert, sendServiceEmail } from "@/lib/notify/email";
import { PAY_METHOD_LABELS, isPayMethod, planDisplayName } from "@/lib/billing/portone-plans";
import { kstDayNumber } from "@/lib/billing/portone-period";
import { CANCEL_SUMMARY, WITHDRAWAL_SUMMARY } from "@/lib/billing/pg-terms";
import { readBizInfo } from "@/lib/biz-info";

export interface MailBody { subject: string; html: string; text: string }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 1234567 → "1,234,567원" */
export function formatKrw(n: number): string {
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}원`;
}

/** KST "2026-11-02" 또는 "2026-11-02 14:05" — 서버 시간대(UTC)와 무관하게 */
export function formatKst(d: Date, withTime = false): string {
  const k = new Date(d.getTime() + 9 * 3_600_000).toISOString();
  return withTime ? `${k.slice(0, 10)} ${k.slice(11, 16)}` : k.slice(0, 10);
}

/** 이용기간 마지막 날(= 다음 결제일 전날)의 KST 날짜 */
function lastUsableDay(periodEnd: Date): string {
  return formatKst(new Date((kstDayNumber(periodEnd) - 1) * 86_400_000));
}

/** 영수증 주소 — https만 링크로 싣는다(포트원 응답이라도 메일 본문에 아무 주소나 넣지 않는다) */
export function safeReceiptUrl(url: string | null | undefined): string | null {
  return url && /^https:\/\/[^\s"<>]+$/.test(url) && url.length <= 2000 ? url : null;
}

/** 이 서비스의 화면 주소 — NEXTAUTH_URL이 없으면 링크를 싣지 않는다(엉뚱한 주소를 만들지 않게) */
function siteUrl(path: string): string | null {
  const base = process.env.NEXTAUTH_URL?.trim().replace(/\/+$/, "");
  return base ? `${base}${path}` : null;
}
const manageUrl = () => siteUrl("/subscribe");

/**
 * 판매자 정보 한 줄(값이 있는 것만, lib/biz-info) — 결제 완료 메일은 계약 내용을 적은 전자문서다(제13조②·시행령 제21조 — 판매자
 *   상호·대표자·주소·연락처·통신판매업 신고번호). 주소가 빠진 서면은 철회 기간 계산이 달라질 수 있다(제17조①2호, 10-22 검토)
 */
function sellerLine(): string | null {
  const b = readBizInfo().info;
  const mailOrder = b.mailOrderNo ? `통신판매업 신고 ${b.mailOrderNo}${b.mailOrderAuthority ? `(${b.mailOrderAuthority})` : ""}` : null;
  const parts = [
    b.name && `판매자 ${b.name}`, b.owner && `대표 ${b.owner}`, b.address && `주소 ${b.address}`,
    b.regNo && `사업자등록번호 ${b.regNo}`, mailOrder, b.phone && `고객센터 ${b.phone}`, b.email,
  ].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" · ") : null;
}

const SAFETY_NOTE = "위급 상황 감지와 보호자 알림은 결제와 관계없이 계속 무료로 제공됩니다.";

/** 표 한 장 + 문단 + 링크 → 메일 본문(html·text). 모든 값은 여기서 이스케이프한다 */
export function renderMail(
  subject: string, rows: readonly (readonly [string, string])[], notes: readonly string[],
  links: readonly { label: string; url: string | null }[] = [],
): MailBody {
  const usable = links.filter((l): l is { label: string; url: string } => !!l.url);
  const footer = [SAFETY_NOTE, sellerLine()].filter((s): s is string => !!s);
  const html = `
  <div style="font-family:'Malgun Gothic',Apple SD Gothic Neo,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#211B2E">
    <h2 style="font-size:18px;margin:0 0 12px">${esc(subject.replace(/^\[마음이음\]\s*/, ""))}</h2>
    <table style="font-size:14px;color:#4b4b5a;border-collapse:collapse">
      ${rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#6B7280">${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
    </table>
    ${notes.map((n) => `<p style="font-size:14px;margin:12px 0 0">${esc(n)}</p>`).join("")}
    ${usable.map((l) => `<p style="margin:12px 0 0"><a href="${esc(l.url)}">${esc(l.label)}</a></p>`).join("")}
    ${footer.map((f) => `<p style="margin:16px 0 0;font-size:12px;color:#9C93B0">${esc(f)}</p>`).join("")}
  </div>`;
  const text = [
    ...rows.map(([k, v]) => `· ${k}: ${v}`), "", ...notes, ...usable.map((l) => `${l.label}: ${l.url}`), "", ...footer,
  ].join("\n");
  return { subject, html, text };
}

/** 메일에 필요한 구독 정보 — 받는 주소(결제회원)·혜택 대상 이름·요금제 */
interface MailContext {
  to: string;
  beneficiaryName: string;
  planName: string;
  priceKrw: number;
  payMethodLabel: string;
  expiresAt: Date | null;
  nextChargeAt: Date | null;
}

async function loadContext(subscriptionId: string): Promise<MailContext | null> {
  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub || sub.provider !== "portone") return null;
  const [purchaser, beneficiary] = await Promise.all([
    prisma.user.findUnique({ where: { id: sub.purchaserUserId }, select: { email: true, name: true } }),
    prisma.user.findUnique({ where: { id: sub.beneficiaryUserId }, select: { name: true } }),
  ]);
  if (!purchaser?.email) return null;
  return {
    to: purchaser.email,
    beneficiaryName: beneficiary?.name?.trim() || "연결된 가족",
    planName: planDisplayName(sub.dailyTurnLimit ?? 0),
    priceKrw: sub.priceKrw ?? 0,
    payMethodLabel: isPayMethod(sub.payMethod) ? PAY_METHOD_LABELS[sub.payMethod] : "등록한 결제수단",
    expiresAt: sub.expiresAt,
    nextChargeAt: sub.nextChargeAt,
  };
}

/** 결제 쪽 운영 경보 — 결제 안내 메일 계정으로(위급 메일 계정의 하루 발신 한도를 쓰지 않는다). 실패해도 throw하지 않는다 */
export function billingOpsAlert(subject: string, lines: string[]): Promise<boolean> {
  return sendOpsAlert(subject, lines, { via: "service" });
}

let warnedNoMail = false;

/** 만들고 보낸다 — 설정이 없거나 실패해도 throw하지 않는다(결제 처리를 막지 않는다) */
async function deliver(kind: string, subscriptionId: string, build: (c: MailContext) => MailBody): Promise<boolean> {
  try {
    if (!isServiceEmailConfigured()) {
      if (!warnedNoMail) console.warn("[billing-mail] 메일 설정 없음(SERVICE_GMAIL_USER·SERVICE_GMAIL_APP_PASSWORD) — 결제 안내 메일을 건너뛴다");
      warnedNoMail = true;
      return false;
    }
    const ctx = await loadContext(subscriptionId);
    if (!ctx) return false;
    const result = await sendServiceEmail(ctx.to, build(ctx));
    if (result !== "ok") console.warn(`[billing-mail] ${kind} 메일 실패(${result}) sub=${subscriptionId.slice(0, 8)}`);
    return result === "ok";
  } catch (e) {
    console.warn(`[billing-mail] ${kind} 메일 준비 실패 sub=${subscriptionId.slice(0, 8)}:`, e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * 결제 완료 — 금액·일시·수단·이용기간·다음 결제·혜택 대상·영수증 + 청약철회 기한·효과와 해지 두 방식(결제 화면 고지와 같은 문구 —
 *   lib/billing/pg-terms) + 약관 두 링크(매 결제마다 — 계약 내용을 적은 전자문서)
 */
export function sendPaymentCompleteMail(subscriptionId: string, p: {
  amountKrw: number; paidAt: Date; periodStart: Date; periodEnd: Date; receiptUrl: string | null; nextCharge: boolean;
}): Promise<boolean> {
  return deliver("결제 완료", subscriptionId, (c) => renderMail(`[마음이음] 이용권 결제 완료 — ${formatKrw(p.amountKrw)}`, [
    ["상품", `마음이음 ${c.planName}`], ["혜택 받는 분", c.beneficiaryName], ["결제 금액", `${formatKrw(p.amountKrw)}(부가세 포함)`],
    ["결제 일시", formatKst(p.paidAt, true)], ["결제수단", c.payMethodLabel],
    ["이용 기간", `${formatKst(p.periodStart)} ~ ${lastUsableDay(p.periodEnd)}`],
    ["다음 결제", p.nextCharge ? `${formatKst(p.periodEnd)} ${formatKrw(c.priceKrw)}` : "없음(해지 예약됨)"],
  ], [
    `청약철회: ${WITHDRAWAL_SUMMARY}`,
    `해지(구독 관리 화면에서 언제든): ${CANCEL_SUMMARY.join(" / ")}`,
  ], [
    { label: "영수증 보기", url: safeReceiptUrl(p.receiptUrl) }, { label: "구독 관리(해지·환불)", url: manageUrl() },
    { label: "유료서비스 이용약관", url: siteUrl("/terms/paid") }, { label: "환불·청약철회 정책", url: siteUrl("/terms/refund") },
  ]));
}

/** 결제 3일 전 안내 */
export function sendRenewalNoticeMail(subscriptionId: string, chargeAt: Date): Promise<boolean> {
  return deliver("결제 예정", subscriptionId, (c) => renderMail(`[마음이음] ${formatKst(chargeAt)} 이용권 자동결제 예정 — ${formatKrw(c.priceKrw)}`, [
    ["상품", `마음이음 ${c.planName}`], ["혜택 받는 분", c.beneficiaryName], ["결제 예정일", formatKst(chargeAt)],
    ["결제 금액", `${formatKrw(c.priceKrw)}(부가세 포함)`], ["결제수단", c.payMethodLabel],
  ], ["더 이용하지 않으시려면 결제 예정일 전에 구독 관리 화면에서 해지해 주세요. 해지해도 이미 낸 기간은 끝까지 이용할 수 있습니다."], [
    { label: "구독 관리(해지)", url: manageUrl() },
  ]));
}

/** 결제 실패 — 다시 시도할 날짜(있으면). 그동안 혜택은 유지된다 */
export function sendPaymentFailedMail(subscriptionId: string, p: { retryAt: Date }): Promise<boolean> {
  return deliver("결제 실패", subscriptionId, (c) => renderMail("[마음이음] 이용권 결제가 되지 않았어요", [
    ["상품", `마음이음 ${c.planName}`], ["혜택 받는 분", c.beneficiaryName], ["결제 금액", formatKrw(c.priceKrw)],
    ["결제수단", c.payMethodLabel], ["다시 시도", formatKst(p.retryAt, true)],
  ], ["다시 시도하는 동안에도 이용권 혜택은 그대로입니다. 결제수단의 잔액·한도를 확인해 주세요. 끝까지 결제되지 않으면 이용권이 끝나고 무료 이용으로 바뀝니다."], [
    { label: "구독 관리", url: manageUrl() },
  ]));
}

/** 이용권이 끝남 — 결제 실패로 끝났는지, 해지한 기간이 끝났는지 */
export function sendExpiredMail(subscriptionId: string, reason: "payment_failed" | "period_end"): Promise<boolean> {
  const why = reason === "payment_failed"
    ? "여러 번 다시 시도했지만 결제가 되지 않아 이용권이 끝났습니다. 등록된 결제수단은 삭제했고 더 결제되지 않습니다."
    : "해지하신 이용권의 이용 기간이 끝났습니다. 더 결제되지 않습니다.";
  return deliver("만료", subscriptionId, (c) => renderMail("[마음이음] 이용권이 끝났어요", [
    ["상품", `마음이음 ${c.planName}`], ["혜택 받는 분", c.beneficiaryName],
  ], [why, "지금부터는 무료 이용으로 바뀝니다. 다시 이용하시려면 구독 화면에서 새로 결제해 주세요."], [
    { label: "구독 화면", url: manageUrl() },
  ]));
}

/**
 * 해지 완료(다음 결제부터) — 만료일까지 이용, 그 뒤 결제 없음.
 *   endedNow: 결제 재시도 중(grace)에 해지 — 이번 달 결제가 되지 않아 혜택이 바로 끝난다(지난 날짜를 "까지 이용"으로 적지 않는다, 10-22 검토).
 */
export function sendCanceledMail(subscriptionId: string, p: { endsAt: Date | null; linkGone?: boolean; endedNow?: boolean }): Promise<boolean> {
  const ends = p.endedNow
    ? "결제 재시도를 멈추고 이용권을 해지했습니다. 이번 달 결제가 되지 않아 이용권은 지금 끝났고, 더 결제되지 않습니다."
    : p.endsAt ? `${lastUsableDay(p.endsAt)}까지 그대로 이용할 수 있고, 그 뒤로는 결제되지 않습니다.` : "더 결제되지 않습니다.";
  const notes = [
    ends,
    ...(p.linkGone ? ["혜택 받는 분과의 연결이 해제되어 다음 결제부터 해지했습니다. 원하시면 위약금 없이 지금 해지(남은 기간 환불)도 할 수 있습니다."] : []),
  ];
  return deliver("해지", subscriptionId, (c) => renderMail("[마음이음] 이용권 해지 완료", [
    ["상품", `마음이음 ${c.planName}`], ["혜택 받는 분", c.beneficiaryName],
  ], notes, [{ label: "구독 관리", url: manageUrl() }]));
}

/** 환불(결제 취소) — 원래 결제수단으로 돌려준다 */
export function sendRefundMail(subscriptionId: string, p: { refundKrw: number; reason: string }): Promise<boolean> {
  return deliver("환불", subscriptionId, (c) => renderMail(`[마음이음] 이용권 환불 — ${formatKrw(p.refundKrw)}`, [
    ["상품", `마음이음 ${c.planName}`], ["혜택 받는 분", c.beneficiaryName], ["환불 금액", formatKrw(p.refundKrw)],
    ["환불 방법", `${c.payMethodLabel} 결제 취소`], ["사유", p.reason],
  ], ["카드사·결제사에 따라 실제 환불까지 며칠 걸릴 수 있습니다."], [{ label: "구독 관리", url: manageUrl() }]));
}
