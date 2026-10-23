"use client";

/**
 * 웹 결제(포트원 정기결제) 신청 — 요금제 → 혜택 받는 분 → 결제수단 → 결제 직전 고지 → 필수 동의 → [매월 N원 자동결제 시작].
 *
 * 흐름(research B 5·6 — runCheckout): prepare(서버가 금액·혜택 대상·동의 기록을 확정하고 issueId를 만든다) → 빌링키 발급 창
 *   (billing-key) → PC·모바일 모두 결제창이 끝나면 forceRedirect로 /subscribe/return에 돌아온다. 리디렉션 없이 돌아온 경우만 여기서
 *   첫 결제 확정(activate)을 부른다.
 * 결제 버튼과 취소 버튼은 같은 크기(제21조의2①3호). 결제 버튼에 금액과 '매월 자동결제'를 적는다(research D 3).
 * 금액은 서버 요금제 값만 쓴다 — 화면은 planId와 함께 **화면에 보인** 금액·한도를 보내고, 서버는 지금 요금과 다르면 결제를 시작하지 않는다
 *   (price_changed — 고지한 금액과 다른 금액이 결제되지 않게). 동의 문구 버전은 이 화면이 보여 준 문안(PG_TERMS_VERSION)을 보낸다(다르면 서버가 거절).
 * ⚠ 앱 WebView에서는 그리지 않는다 — 부르는 쪽(SubscribeView)이 브라우저일 때만 이 컴포넌트를 쓴다.
 * ⚠ 네이버페이 PC는 팝업이다 — prepare를 기다린 뒤 결제창을 여는 사이 팝업이 막히는지는 실측 필요(research uncertain 31). 막히면 SDK 문구가
 *   그대로 보이고 다시 누르면 된다.
 */
import { useState } from "react";
import { chargeSchedule, krw } from "@/lib/billing/pg-terms";
import { PG_TERMS_VERSION, REQUIRED_CONSENTS, type ConsentKey } from "@/lib/billing/portone-consent";
import { ACTIVATE_TEXT, activateIssue, requestJson, type PayMethod, type PgConfig, type PgPlan, type PreparedIssue } from "./pg-client";
import { issueBillingKey, normalizePhone, type Buyer } from "./billing-key";
import { BeneficiaryPicker, BuyerFields, ConsentList, MethodPicker, PlanPicker, type BuyerDraft } from "./CheckoutFields";
import { PgNotice } from "./PgNotice";

const NO_CONSENT = Object.fromEntries(REQUIRED_CONSENTS.map((k) => [k, false])) as Record<ConsentKey, boolean>;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 결제·취소 버튼 공통 모양 — 크기는 같고 색만 다르다(제21조의2①3호 — __tests__/billing-pg-checkout.test.ts) */
export const BIG_BUTTON = "flex w-full items-center justify-center rounded-2xl px-6 py-4 text-lg font-bold shadow transition disabled:opacity-50";
/** 설정을 다시 읽어야 하는 거절 — 문안이 바뀜·이미 이용권이 생김·요금제가 바뀜·요금(금액·한도)이 바뀜 */
const RELOAD_CODES = ["terms_outdated", "duplicate", "invalid_plan", "price_changed"];

/** 이보다 최근에 연결된 분은 하나뿐이어도 미리 고르지 않는다 */
const RECENT_LINK_MS = 7 * 24 * 3_600_000;

/**
 * 고를 수 있는 혜택 대상이 하나뿐이고 연결된 지 7일이 넘었으면 미리 고른다(이름·연결한 날은 화면에 보인다) — 둘 이상이거나 최근에 연결된
 *   분이면 직접 고른다(보호자 코드를 아는 사람이 같은 이름으로 연결해 결제 대상을 바꿔치기하지 못하게 — 2026-10-22 검토)
 */
export function defaultBeneficiary(config: PgConfig, now = new Date()): string | null {
  const open = config.beneficiaries.filter((b) => !b.covered);
  if (open.length !== 1) return null;
  const linkedAt = Date.parse(open[0].linkedAt);
  return Number.isFinite(linkedAt) && now.getTime() - linkedAt > RECENT_LINK_MS ? open[0].userId : null;
}

/** 자동결제 동의만 다시 미체크로 — 그 문구에 금액이 적혀 있어, 요금제·혜택 받는 분·결제수단이 바뀌면 다시 확인받는다(새 객체) */
export function withoutAutoRenew(c: Readonly<Record<ConsentKey, boolean>>): Record<ConsentKey, boolean> {
  return { ...c, autoRenew: false };
}

/** 카드 결제창 구매자 정보 — 맞으면 Buyer, 아니면 null */
export function toBuyer(d: BuyerDraft): Buyer | null {
  const phoneNumber = normalizePhone(d.phone);
  const fullName = d.fullName.trim();
  const email = d.email.trim();
  return fullName && fullName.length <= 40 && phoneNumber && EMAIL_RE.test(email) ? { fullName, phoneNumber, email } : null;
}

/** 아직 남은 것 — 비어 있어야 결제 버튼이 눌린다 */
export function checkoutMissing(s: {
  plan: PgPlan | null; hasTarget: boolean; method: PayMethod | null; cardBuyer: Buyer | null; consents: Readonly<Record<ConsentKey, boolean>>;
}): string[] {
  return [
    !s.plan && "요금제", !s.hasTarget && "혜택 받는 분", !s.method && "결제수단",
    s.method === "CARD" && !s.cardBuyer && "카드 결제 정보(이름·휴대전화·이메일)",
    !REQUIRED_CONSENTS.every((k) => s.consents[k] === true) && "필수 동의",
  ].filter((m): m is string => typeof m === "string");
}

/** 결제 버튼 문구 — 금액과 '매월 자동결제'(research D 3) */
export function payButtonLabel(plan: PgPlan | null, busy: boolean): string {
  if (busy) return "결제창을 여는 중…";
  return plan ? `매월 ${krw(plan.priceKrw)} 자동결제 시작` : "자동결제 시작";
}

export type CheckoutOutcome = { kind: "redirected" } | { kind: "error"; text: string; reload: boolean } | { kind: "done"; text: string };

/** 결제 시작 한 번 — prepare → 발급 창 → (리디렉션 없이 돌아오면) 첫 결제 확정. 문구는 서버·PG가 준 그대로 */
export async function runCheckout(input: {
  plan: PgPlan; method: PayMethod; beneficiaryUserId: string; consents: Readonly<Record<ConsentKey, boolean>>; buyer?: Buyer;
}): Promise<CheckoutOutcome> {
  const prep = await requestJson<PreparedIssue>("/api/billing/portone/prepare", {
    method: "POST",
    body: {
      planId: input.plan.id, method: input.method, beneficiaryUserId: input.beneficiaryUserId, consents: input.consents,
      termsVersion: PG_TERMS_VERSION,
      // 화면에 보인 금액·한도 — 서버가 지금 요금과 대조한다(결제 금액은 서버 값만 쓴다)
      expectedPriceKrw: input.plan.priceKrw, expectedDailyTurnLimit: input.plan.dailyTurnLimit,
    },
  });
  if (!prep.ok) return { kind: "error", text: prep.error, reload: RELOAD_CODES.includes(prep.code) };
  // 구매자 정보는 카드 결제창에만 실린다(buildIssueRequest — 간편결제는 customerId만)
  const issued = await issueBillingKey(prep.data, input.buyer);
  if (issued.kind === "redirected") return { kind: "redirected" }; // 결제창이 이 페이지를 떠났다 — 결과는 /subscribe/return이 받는다
  if (issued.kind === "failed") return { kind: "error", text: issued.message, reload: false };
  const done = await activateIssue(prep.data.issueId, issued.billingKey);
  if (done.kind === "failed") return { kind: "error", text: done.message, reload: false };
  // 결과를 모른다 — 다시 결제하라고 하지 않고 상태를 다시 읽는다(웹훅이 이어서 확정한다)
  if (done.kind === "unconfirmed") return { kind: "error", text: ACTIVATE_TEXT.unconfirmed, reload: true };
  return { kind: "done", text: ACTIVATE_TEXT[done.kind] };
}

export interface PgCheckoutProps {
  config: PgConfig;
  /** 로그인한 사람 — 카드 결제창 구매자 정보를 미리 채운다 */
  me: { name: string | null; email: string | null };
  /** 이용권이 생기거나 설정이 바뀌었을 수 있다 — 상태·설정을 다시 읽는다 */
  onChanged: () => void;
  /**
   * 결제가 끝났다는 안내 — 화면 맨 위(SubscribeView)에 띄운다. 이용권이 생기면 이 신청 영역은 다시 읽은 뒤 사라지므로(고를 분이 없다)
   *   여기 두면 안내가 함께 사라진다.
   */
  onNotice: (text: string) => void;
}

export function PgCheckout({ config, me, onChanged, onNotice }: PgCheckoutProps) {
  const singleMethod = config.payMethods.length === 1 ? config.payMethods[0].method : null;
  const [planId, setPlanId] = useState<string | null>(null);
  const [beneficiaryId, setBeneficiaryId] = useState<string | null>(() => defaultBeneficiary(config));
  const [method, setMethod] = useState<PayMethod | null>(singleMethod);
  const [consents, setConsents] = useState<Record<ConsentKey, boolean>>(NO_CONSENT);
  const [buyer, setBuyer] = useState<BuyerDraft>({ fullName: me.name ?? "", phone: "", email: me.email ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plan = config.plans.find((p) => p.id === planId) ?? null;
  const target = config.beneficiaries.find((b) => b.userId === beneficiaryId) ?? null;
  const cardBuyer = method === "CARD" ? toBuyer(buyer) : null;
  const missing = checkoutMissing({ plan, hasTarget: target !== null, method, cardBuyer, consents });

  const reset = () => {
    setPlanId(null); setBeneficiaryId(defaultBeneficiary(config)); setMethod(singleMethod); setConsents(NO_CONSENT); setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const start = async () => {
    if (!plan || !target || !method || missing.length > 0) return;
    setBusy(true); setError(null);
    const r = await runCheckout({ plan, method, beneficiaryUserId: target.userId, consents, buyer: cardBuyer ?? undefined });
    if (r.kind === "redirected") return;
    setBusy(false);
    if (r.kind === "done") { onNotice(r.text); onChanged(); return; }
    setError(r.text);
    if (r.reload) onChanged();
  };

  return (
    <div className="space-y-5">
      <PlanPicker plans={config.plans} value={planId} onChange={(id) => { setPlanId(id); setConsents(withoutAutoRenew); }} />
      <BeneficiaryPicker config={config} value={beneficiaryId} onChange={(id) => { setBeneficiaryId(id); setConsents(withoutAutoRenew); }} />
      <MethodPicker methods={config.payMethods} value={method} onChange={(m) => { setMethod(m); setConsents(withoutAutoRenew); }} />
      {method === "CARD" && <BuyerFields value={buyer} onChange={setBuyer} />}
      {plan ? (
        <>
          <PgNotice
            plan={plan} beneficiaryName={target?.name ?? null}
            methodLabel={config.payMethods.find((m) => m.method === method)?.label ?? null}
            freeDailyTurnLimit={config.freeDailyTurnLimit} business={config.business} now={new Date()}
          />
          <ConsentList
            items={REQUIRED_CONSENTS} value={consents} onChange={(k, v) => setConsents((c) => ({ ...c, [k]: v }))}
            priceKrw={plan.priceKrw} chargeDay={chargeSchedule(new Date()).chargeDay}
          />
        </>
      ) : (
        <p className="rounded-2xl bg-white/70 px-4 py-3 text-base text-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-200">
          요금제를 고르면 결제 전에 확인할 내용과 동의 항목이 나와요.
        </p>
      )}
      {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-base text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</p>}
      <div className="space-y-2">
        <button type="button" onClick={start} disabled={busy || missing.length > 0} className={`${BIG_BUTTON} bg-teal-600 text-white hover:bg-teal-700`}>
          {payButtonLabel(plan, busy)}
        </button>
        <button type="button" onClick={reset} disabled={busy} className={`${BIG_BUTTON} bg-zinc-600 text-white hover:bg-zinc-700`}>
          취소
        </button>
        {missing.length > 0 && !busy && (
          <p className="text-center text-sm text-zinc-600 dark:text-zinc-300">아직 남은 것: {missing.join(", ")}</p>
        )}
      </div>
    </div>
  );
}
