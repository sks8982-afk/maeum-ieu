"use client";

/**
 * 구독 관리(웹 결제 이용권) — 요금제·가격·결제수단·다음 결제일·혜택 받는 분·'유료 혜택 사용: 있음/없음'·해지·결제 내역(영수증).
 *
 * 해지(research C 6·D 6 — 다크패턴 금지): [해지하기]는 가입 버튼과 같은 크기로 첫 화면에 있다. 누르면 두 방식(다음 결제부터 해지 /
 *   지금 해지)과 **방식별 예상 환불액을 같은 크기**로 보여 주고, 고른 뒤 한 번 누르면 끝난다(재확인 1회 이하, 해지 사유를 묻지 않는다).
 * 청약철회 기간(결제일부터 7일) 안의 지금 해지는 청약철회로 보낸다(/refund) — 화면을 보는 사이 7일이 지나면 서버가 거절해, 본 적 없는
 *   위약금이 붙은 해지로 조용히 바뀌지 않는다. 그 밖의 지금 해지·다음 결제부터 해지는 /cancel.
 * 예상 환불액은 서버가 계산한 값(lib/billing/portone-status cancelOptions)이고, 실제 해지 때 서버가 다시 계산한다.
 * 결제 실패 사유(failureReason)는 PG가 준 문구 그대로 보여 준다(가공 금지 — 네이버페이 조건).
 * 이용 끝 날짜는 '다음 결제일 전날'로 적는다(pg-terms lastUsableDay — 약관·메일과 같은 날, 2026-10-22 검토).
 * 결제 재시도 중(grace)에는 해지가 한 가지다 — 이번 달 결제가 되지 않아 어느 쪽이든 혜택이 지금 끝나고 환불할 결제가 없다.
 *   "그대로 이용"이라 적지 않는다(10-22 검토: 실제로는 바로 무료로 바뀌었다).
 */
import { useState } from "react";
import { kstDateLabel, krw, lastUsableDay } from "@/lib/billing/pg-terms";
import { EARLY_CANCEL_PENALTY_PERCENT } from "@/lib/billing/portone-period";
import { requestJson, type PgPayment, type PgStatus, type PgSubscription } from "./pg-client";
import { BIG_BUTTON } from "./PgCheckout";

/** 해지 버튼은 가입(결제) 버튼과 같은 크기 — 같은 모양 상수를 쓴다(다크패턴 금지 — research D 6) */
const bigButton = BIG_BUTTON;
const card = "rounded-2xl bg-white p-5 shadow-sm dark:bg-zinc-900";
const dateOf = (iso: string | null) => (iso ? kstDateLabel(new Date(iso)) : "—");
/** 이용이 끝나는 시각(다음 결제일 10시) → 마지막 이용일(그 전날) */
const lastDayOf = (iso: string | null) => (iso ? kstDateLabel(lastUsableDay(new Date(iso))) : "—");
/** 결제 내역은 이만큼 먼저 보이고 나머지는 [더 보기] */
const HISTORY_FIRST = 5;

function statusLine(s: PgSubscription): string {
  switch (s.status) {
    case "activating": return "첫 결제를 확인하고 있어요. 잠시 뒤 다시 열어 주세요.";
    case "grace": return `결제가 실패해 다시 시도하고 있어요(다음 시도 ${dateOf(s.nextChargeAt)}). 그동안 혜택은 그대로예요.`;
    case "canceled": return `해지 예약됨 — ${lastDayOf(s.expiresAt)}까지 이용하고, 그 뒤로는 결제되지 않아요.`;
    default: return `다음 결제: ${dateOf(s.nextChargeAt)} ${s.plan.priceKrw !== null ? krw(s.plan.priceKrw) : ""}`.trim();
  }
}

type Mode = "period_end" | "now";

/** 고를 수 있는 해지 방식 — 해지 예약된 것은 지금 해지만, 결제 재시도 중은 결제를 멈추고 끝내기 하나(period_end — 서버가 바로 끝낸다) */
export function cancelModes(sub: PgSubscription): Mode[] {
  if (sub.status === "canceled") return ["now"];
  if (sub.status === "grace") return ["period_end"];
  return ["period_end", "now"];
}

/** 지금 해지의 계산 근거 한 줄 — 서버 규칙(rule)대로 */
function immediateBasis(s: PgSubscription): string {
  const o = s.cancelOptions?.immediate;
  if (!o) return "";
  if (o.rule === "withdrawal") return s.usedPaidBenefit ? "유료 혜택을 써서 이용한 날짜만큼만 빼요(위약금 없음)." : "유료 혜택을 쓰지 않아 전액이에요.";
  if (o.rule === "no_penalty") return `이용한 ${o.usedDays}일만큼만 빼요(위약금 없음).`;
  return `이용한 ${o.usedDays}일과 남은 기간 요금의 ${EARLY_CANCEL_PENALTY_PERCENT}%를 빼요.`;
}

/** 방식의 이름과 효과 한 줄 */
function optionText(mode: Mode, sub: PgSubscription): { title: string; effect: string } {
  const o = sub.cancelOptions;
  if (mode === "now") {
    return {
      title: sub.withinWithdrawal ? "지금 해지(청약철회)" : "지금 해지",
      effect: `오늘 바로 끝나요. 예상 환불액 ${krw(o?.immediate.refundKrw ?? 0)}(결제한 수단의 결제 취소로 환불)`,
    };
  }
  if (sub.status === "grace") {
    return { title: "결제를 멈추고 지금 끝내기", effect: "결제 재시도를 멈추고 이용권을 끝내요. 혜택도 지금 끝나요(이번 달 결제가 되지 않아 환불할 금액은 없어요)." };
  }
  return { title: "다음 결제부터 해지", effect: `${lastDayOf(o?.periodEnd.endsAt ?? sub.expiresAt)}까지 그대로 이용, 환불 없음` };
}

export function CancelOption({ mode, sub, checked, onPick }: { mode: Mode; sub: PgSubscription; checked: boolean; onPick: () => void }) {
  const { title, effect } = optionText(mode, sub);
  return (
    <label className={`flex cursor-pointer gap-3 rounded-2xl border-2 p-4 ${checked ? "border-teal-600 bg-teal-50 dark:bg-teal-900/20" : "border-zinc-200 dark:border-zinc-700"}`}>
      <input type="radio" name={`cancel-${sub.subscriptionId}`} checked={checked} onChange={onPick} className="mt-1 h-5 w-5 accent-teal-600" />
      <span>
        <span className="block text-base font-bold text-zinc-900 dark:text-zinc-100">{title}</span>
        <span className="block text-base text-zinc-700 dark:text-zinc-200">{effect}</span>
        {mode === "now" && <span className="mt-1 block text-sm text-zinc-600 dark:text-zinc-300">{immediateBasis(sub)}</span>}
      </span>
    </label>
  );
}

/** 해지 결과 문구 */
export function doneText(mode: Mode, data: Record<string, unknown>, sub: PgSubscription): string {
  if (typeof data.message === "string" && data.refundPending) return data.message;
  if (mode === "period_end" && sub.status === "grace") return "결제를 멈추고 이용권을 끝냈어요. 더 결제되지 않아요.";
  if (mode === "period_end") return `해지 예약을 마쳤어요. ${lastDayOf(sub.cancelOptions?.periodEnd.endsAt ?? sub.expiresAt)}까지 그대로 이용하고, 그 뒤로는 결제되지 않아요.`;
  const refund = typeof data.refundKrw === "number" ? data.refundKrw : 0;
  return refund > 0 ? `해지했어요. ${krw(refund)}을 결제한 수단으로 돌려드려요(신청일부터 3영업일 안에 결제 취소를 요청해요).` : "해지했어요. 돌려드릴 금액은 없어요.";
}

/**
 * 해지가 끝났다는 안내는 화면 맨 위(SubscribeView)로 올린다 — 지금 해지는 다시 읽은 목록에서 그 이용권이 빠져(revoked) 이 카드와 함께
 *   안내가 사라진다. 실패 안내는 그 자리에 둔다.
 */
interface Handlers { onChanged: () => void; onNotice: (text: string) => void }

function CancelPanel({ sub, onChanged, onNotice }: { sub: PgSubscription } & Handlers) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!sub.cancelOptions) return <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">첫 결제를 확인한 뒤 해지할 수 있어요.</p>;
  const modes = cancelModes(sub);

  const submit = async () => {
    if (!mode) return;
    setBusy(true); setError(null);
    const withdrawal = mode === "now" && sub.withinWithdrawal;
    const r = await requestJson<Record<string, unknown>>(withdrawal ? "/api/billing/portone/refund" : "/api/billing/portone/cancel", {
      method: "POST", body: withdrawal ? { subscriptionId: sub.subscriptionId } : { subscriptionId: sub.subscriptionId, mode },
    });
    setBusy(false);
    if (!r.ok) { setError(r.error); if (r.code === "withdrawal_period_over" || r.code === "not_cancellable") onChanged(); return; }
    setOpen(false); setMode(null);
    onNotice(doneText(mode, r.data, sub));
    onChanged();
  };

  return (
    <div className="mt-4 space-y-3">
      {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-base text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</p>}
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className={`${bigButton} bg-zinc-600 text-white hover:bg-zinc-700`}>
          {sub.status === "canceled" ? "지금 해지하기" : "해지하기"}
        </button>
      ) : (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-base font-bold text-zinc-800 dark:text-zinc-100">해지 방법을 골라 주세요</legend>
          <div className={`grid gap-2 ${modes.length > 1 ? "sm:grid-cols-2" : ""}`}>
            {modes.map((m) => <CancelOption key={m} mode={m} sub={sub} checked={mode === m} onPick={() => setMode(m)} />)}
          </div>
          <button type="button" onClick={submit} disabled={!mode || busy} className={`${bigButton} bg-teal-600 text-white hover:bg-teal-700`}>
            {busy ? "처리하는 중…" : "고른 방식으로 해지하기"}
          </button>
          <button type="button" onClick={() => { setOpen(false); setMode(null); }} disabled={busy} className={`${bigButton} bg-zinc-600 text-white hover:bg-zinc-700`}>
            돌아가기
          </button>
        </fieldset>
      )}
    </div>
  );
}

function SubscriptionCard({ sub, onChanged, onNotice }: { sub: PgSubscription } & Handlers) {
  return (
    <article className={card}>
      <h3 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">
        {sub.plan.name}{sub.plan.priceKrw !== null && <span className="ml-1 text-base font-semibold text-zinc-600 dark:text-zinc-300">· 월 {krw(sub.plan.priceKrw)}</span>}
      </h3>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-base text-zinc-700 dark:text-zinc-200">
        <dt className="font-semibold">혜택 받는 분</dt><dd>{sub.beneficiary.name}님</dd>
        <dt className="font-semibold">결제수단</dt><dd>{sub.payMethodLabel}</dd>
        <dt className="font-semibold">이용 기간</dt><dd>{sub.status === "grace" ? "결제 재시도 중(혜택 유지)" : `${lastDayOf(sub.expiresAt)}까지`}</dd>
        <dt className="font-semibold">유료 혜택 사용</dt><dd>{sub.usedPaidBenefit ? "있음" : "없음"}</dd>
      </dl>
      <p className="mt-2 text-base text-zinc-800 dark:text-zinc-100">{statusLine(sub)}</p>
      <CancelPanel sub={sub} onChanged={onChanged} onNotice={onNotice} />
    </article>
  );
}

const PAYMENT_STATUS: Record<string, string> = { paid: "결제 완료", failed: "결제 실패", cancelled: "전액 환불(결제 취소)" };

function PaymentRow({ p, who }: { p: PgPayment; who: string | null }) {
  const status = p.status === "partial_cancelled" ? `${krw(p.cancelledKrw)} 환불(부분 취소)` : PAYMENT_STATUS[p.status] ?? p.status;
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-zinc-100 py-2 last:border-0 dark:border-zinc-800">
      <span className="text-base text-zinc-800 dark:text-zinc-100">{dateOf(p.paidAt ?? p.updatedAt)} · {krw(p.amountKrw)}{who ? ` · ${who}님` : ""}</span>
      <span className="text-sm text-zinc-600 dark:text-zinc-300">
        {status}
        {p.receiptUrl && <> · <a href={p.receiptUrl} target="_blank" rel="noopener noreferrer" className="font-semibold text-teal-700 underline dark:text-teal-300">영수증</a></>}
      </span>
      {p.failureReason && <span className="w-full text-sm text-red-700 dark:text-red-300">{p.failureReason}</span>}
    </li>
  );
}

/** 결제 내역 — 최근 것부터 HISTORY_FIRST건, 나머지는 [더 보기](계약·결제 내용을 언제든 열람 — 제8조③, 10-22 검토: 예전엔 5건뿐) */
function PaymentHistory({ pg }: { pg: PgStatus }) {
  const [all, setAll] = useState(false);
  const nameOf = new Map(pg.subscriptions.map((s) => [s.subscriptionId, s.beneficiary.name]));
  const many = pg.subscriptions.length > 1;
  const shown = all ? pg.payments : pg.payments.slice(0, HISTORY_FIRST);
  const rest = pg.payments.length - shown.length;
  return (
    <div className={card}>
      <h3 className="mb-1 text-base font-bold text-zinc-800 dark:text-zinc-100">결제 내역</h3>
      <ul>{shown.map((p, i) => <PaymentRow key={`${p.subscriptionId}-${i}`} p={p} who={many ? nameOf.get(p.subscriptionId) ?? null : null} />)}</ul>
      {rest > 0 && (
        <button type="button" onClick={() => setAll(true)} className="mt-2 w-full rounded-xl border border-zinc-300 py-2 text-base font-semibold text-zinc-700 dark:border-zinc-700 dark:text-zinc-200">결제 내역 더 보기({rest}건)</button>
      )}
    </div>
  );
}

export function PgManage({ pg, onChanged, onNotice }: { pg: PgStatus } & Handlers) {
  return (
    <section aria-labelledby="pg-manage-title" className="space-y-3">
      <h2 id="pg-manage-title" className="text-lg font-bold text-zinc-800 dark:text-zinc-100">구독 관리</h2>
      {pg.subscriptions.map((s) => <SubscriptionCard key={s.subscriptionId} sub={s} onChanged={onChanged} onNotice={onNotice} />)}
      {pg.payments.length > 0 && <PaymentHistory pg={pg} />}
    </section>
  );
}
