"use client";

/**
 * 구독 상태 카드와 앱(Play) 구독 — 예전 /subscribe 화면 그대로 옮겼다(2026-10-22, 웹 결제 화면과 나누면서).
 *
 * 앱 안 Play 구매(왜 앱에서만 Play인가 — 안드로이드 앱의 디지털 구독은 Google Play 결제를 써야 한다):
 *   [구독하기] → RN에 PURCHASE_SUBSCRIPTION → 앱이 Play 시트 → 구매 토큰 검증은 앱 전역 브릿지(RnBridge)가 한다 → 이 화면은
 *   BILLING_UPDATED_EVENT로 결과만 받아 상태를 다시 읽는다.
 *   ⚠ 구매 버튼은 서버가 BILLING_PLAY_ENABLED=1일 때만 보이게 한다(status.playPurchaseEnabled — 설계 '조사 반영 결정' 10. 기본은 상태만).
 *   ⚠ 앱 안에서는 웹 결제(PG)를 언급하지 않는다(Play 결제 정책) — 이 파일에는 웹 결제 문구·링크가 없다.
 */
import { useEffect, useState } from "react";
import { BILLING_UPDATED_EVENT } from "../RnBridge";
import { MIN_BILLING_APP_VERSION, isOlderVersion } from "@/lib/app-version";
import type { BillingStatus } from "./pg-client";

/** 현재 이용 중 — 무료/구독 중·만료일·혜택 대상·오늘 대화량(앱·웹 공통) */
export function StatusCard({ st }: { st: BillingStatus | null }) {
  const isPro = st?.tier === "pro";
  return (
    <section className={`mb-4 rounded-2xl border p-5 ${isPro ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-900/20" : "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"}`}>
      <h2 className="text-sm font-semibold text-zinc-600 dark:text-zinc-300">현재 이용 중</h2>
      <p className="mt-1 text-xl font-bold text-zinc-900 dark:text-zinc-100">
        {st === null ? "확인 중…" : isPro ? "구독 중" : "무료"}
      </p>
      {isPro && st?.expiresAt && (
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
          {new Date(st.expiresAt).toLocaleDateString("ko-KR")}까지 이용할 수 있어요.
        </p>
      )}
      {isPro && st?.beneficiaryName && (
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">혜택 적용 대상: <b>{st.beneficiaryName}</b></p>
      )}
      {st?.usage && (
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">
          오늘 대화 {st.usage.used}회{st.usage.limit > 0 ? ` / ${st.usage.limit}회` : ""}
        </p>
      )}
    </section>
  );
}

/** 구독하면 — 혜택 설명(예전 화면 그대로). 앱 안에서는 구매 버튼이 보일 때·구독 중일 때만(기본은 상태만 — SubscribeView) */
export function PlayBenefits() {
  return (
    <section className="mb-4 rounded-2xl bg-white p-5 shadow-sm dark:bg-zinc-900">
      <h2 className="text-lg font-bold text-zinc-800 dark:text-zinc-100">구독하면</h2>
      <ul className="mt-3 space-y-2 text-base text-zinc-700 dark:text-zinc-200">
        <li>💬 <b>하루 대화량이 늘어나요</b> — 어르신이 더 오래 이야기할 수 있어요.</li>
        <li>📋 <b>상태 요약·추세를 볼 수 있어요</b> — 보호자 화면의 등급·변화 추이와 복약 이행률.</li>
      </ul>
      <p className="mt-3 rounded-xl bg-zinc-50 px-3 py-2 text-sm text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
        🚨 위급 알림은 <b>구독과 무관하게 항상</b> 제공됩니다. 안전 기능에는 돈을 받지 않아요.
      </p>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
        보호자가 결제하면 연결된 어르신 계정에 혜택이 적용됩니다.
      </p>
    </section>
  );
}

/** Google Play 구독 해지 안내 — Play로 결제한 구독에만 해당한다고 적는다(웹 결제 이용권은 이 길로 해지되지 않는다) */
export const PLAY_MANAGE_TEXT = "Google Play에서 결제한 구독은 Google Play 스토어 → 메뉴 → 결제 및 정기 결제에서 해지·결제수단 변경을 할 수 있어요.";

/** 앱 안 Play 구매 — 서버 스위치(playPurchaseEnabled)가 켜졌고 아직 무료일 때만 버튼 */
export function PlayPurchase({ st, onReload, onError }: {
  st: BillingStatus | null; onReload: () => void; onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  // 구버전 앱은 결제 메시지를 처리하지 못해 버튼이 멈춘 것처럼 보인다 — 업데이트를 안내한다.
  const appVersion = typeof window !== "undefined"
    ? (window as unknown as { MAEUM_APP_VERSION?: string }).MAEUM_APP_VERSION : undefined;
  const appTooOld = !appVersion || isOlderVersion(appVersion, MIN_BILLING_APP_VERSION);

  useEffect(() => {
    const onBilling = (e: Event) => {
      const detail = (e as CustomEvent<{ ok?: boolean; error?: string }>).detail;
      setBusy(false);
      if (detail?.ok) { onError(""); onReload(); }
      else if (detail?.error) onError(`${detail.error} 앱을 다시 열면 자동으로 다시 시도합니다.`);
    };
    const onMsg = (e: MessageEvent) => {
      const d = typeof e.data === "string" ? e.data : "";
      if (!d.includes("PURCHASE_")) return;
      try {
        const msg = JSON.parse(d) as { type?: string; error?: string };
        if (msg.type === "PURCHASE_CANCELED") setBusy(false);
        if (msg.type === "PURCHASE_FAILED") { setBusy(false); onError(msg.error || "결제가 완료되지 않았습니다."); }
      } catch { /* 다른 메시지 */ }
    };
    window.addEventListener(BILLING_UPDATED_EVENT, onBilling);
    window.addEventListener("message", onMsg);
    document.addEventListener("message", onMsg as EventListener); // 안드로이드 WebView
    return () => {
      window.removeEventListener(BILLING_UPDATED_EVENT, onBilling);
      window.removeEventListener("message", onMsg);
      document.removeEventListener("message", onMsg as EventListener);
    };
  }, [onReload, onError]);

  const purchase = () => {
    const productId = st?.productIds?.[0];
    if (!productId) { onError("구독 상품이 아직 준비되지 않았습니다."); return; }
    onError(""); setBusy(true);
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "PURCHASE_SUBSCRIPTION", productId }));
    // 앱이 응답하지 않는 경우(구버전 앱)에도 버튼이 영구 비활성되지 않게
    setTimeout(() => setBusy(false), 60_000);
  };

  if (st?.tier === "pro") return <p className="text-sm text-zinc-500 dark:text-zinc-400">{PLAY_MANAGE_TEXT}</p>;
  if (!st?.playPurchaseEnabled) return null; // 기본: 구독 상태만(구매 버튼 없음)
  if (appTooOld) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-900/20 dark:text-amber-200">
        구독 결제는 <b>최신 버전 앱</b>에서 이용할 수 있어요. Play 스토어에서 마음이음을 업데이트해 주세요.
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={purchase}
      disabled={busy || st.productIds.length === 0}
      className="flex w-full items-center justify-center rounded-2xl bg-teal-600 px-6 py-4 text-lg font-bold text-white shadow-lg transition hover:bg-teal-700 disabled:opacity-50"
    >
      {busy ? "결제 창을 여는 중…" : st.productIds.length === 0 ? "준비 중입니다" : "구독하기"}
    </button>
  );
}
