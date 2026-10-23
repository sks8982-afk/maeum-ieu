"use client";

/**
 * 결제창 복귀 결과(클라이언트) — app/subscribe/return/page.tsx가 쿼리와 trusted(내 최근 발급 시도인가 — 서버 확인)를 넘긴다.
 *   · code 있음 → 실패. 내 발급 시도로 확인되면(trusted) message(없으면 pgMessage)를 **그대로** 보여 준다(앞뒤에 말을 붙이지 않는다 —
 *     네이버페이 조건). 확인되지 않으면 고정 안내만 — 쿼리는 누구나 만들 수 있다(공식 결제 화면에 피싱 문구가 뜨지 않게, 2026-10-22 검토).
 *   · code 없음 + issueId·billingKey → /api/billing/portone/activate(첫 결제) → 결과. 결과를 모르면(로그인 없음·네트워크·일시 오류)
 *     실패라 하지 않는다 — BillingKey.Issued 웹훅이 이어서 확정하고 결제 안내 메일이 간다(pg-client activateIssue).
 *   · 주소창의 쿼리는 바로 지운다 — 새로 고침으로 같은 확정을 다시 보내지 않고, 빌링키가 주소창·방문 기록에 오래 남지 않게
 *     (서버 확정은 멱등이고, 결과를 놓쳐도 웹훅이 이어서 확정한다).
 * 앱(WebView) 안이면 웹 결제 결과를 그리지 않는다(Play 결제 정책 — 이 화면으로 올 일은 없지만 링크를 따라 들어와도 문구가 없게).
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useInApp } from "@/app/components/WebOnly";
import { ACTIVATE_TEXT, activateIssue, type ActivateOutcome } from "../pg-client";

export interface ReturnQuery {
  issueId: string | null;
  billingKey: string | null;
  code: string | null;
  message: string | null;
  pgMessage: string | null;
}

type View =
  | { kind: "working" } | { kind: "ok"; text: string } | { kind: "error"; text: string }
  | { kind: "info"; text: string; needsLogin: boolean };

const NOT_DONE = "결제수단 등록이 끝나지 않았어요. 구독 화면에서 다시 시도해 주세요.";
const NO_RESULT = "결제 결과를 확인할 수 없어요. 구독 화면에서 이용권이 적용됐는지 확인해 주세요.";
/** 이보다 긴 쿼리 문구는 보이지 않는다 — PG 실패 문구는 짧다. 자르면 가공이라 통째로 고정 안내로 */
const MAX_PG_TEXT = 300;

/** 쿼리만으로 정해지는 결과(서버를 부르지 않는 경우) — 순수 함수(시험이 본다). null이면 첫 결제 확정을 부른다 */
export function immediateView(q: ReturnQuery, trusted: boolean): View | null {
  if (q.code) {
    const pgText = q.message || q.pgMessage;
    return { kind: "error", text: trusted && pgText && pgText.length <= MAX_PG_TEXT ? pgText : NOT_DONE };
  }
  if (!q.issueId || !q.billingKey) return { kind: "error", text: NO_RESULT };
  return null;
}

/** 첫 결제 확정 결과 → 화면 */
export function activateView(r: ActivateOutcome): View {
  if (r.kind === "failed") return { kind: "error", text: r.message };
  if (r.kind === "unconfirmed") return { kind: "info", text: ACTIVATE_TEXT.unconfirmed, needsLogin: r.needsLogin };
  return { kind: "ok", text: ACTIVATE_TEXT[r.kind] };
}

const BOX: Record<Exclude<View["kind"], "working">, string> = {
  error: "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300",
  ok: "bg-emerald-50 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200",
  info: "bg-amber-50 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100",
};

export function ReturnView({ query, trusted }: { query: ReturnQuery; trusted: boolean }) {
  const inApp = useInApp();
  const [view, setView] = useState<View>(() => immediateView(query, trusted) ?? { kind: "working" });
  const sent = useRef(false);

  useEffect(() => {
    if (inApp !== false || sent.current) return;
    sent.current = true;
    window.history.replaceState(null, "", window.location.pathname);
    if (immediateView(query, trusted)) return;
    (async () => {
      setView(activateView(await activateIssue(query.issueId as string, query.billingKey as string)));
    })();
  }, [inApp, query, trusted]);

  if (inApp === null) return null;
  return (
    <div className="mx-auto max-w-md px-5 py-10">
      <h1 className="mb-5 text-2xl font-extrabold text-zinc-800 dark:text-zinc-100">{inApp ? "구독" : "결제 결과"}</h1>
      {!inApp && view.kind === "working" && (
        <p role="status" className="rounded-2xl bg-white p-5 text-base text-zinc-700 shadow-sm dark:bg-zinc-900 dark:text-zinc-200">결제를 확인하고 있어요…</p>
      )}
      {!inApp && view.kind !== "working" && (
        <p role={view.kind === "error" ? "alert" : "status"} className={`rounded-2xl p-5 text-base ${BOX[view.kind]}`}>{view.text}</p>
      )}
      {!inApp && view.kind === "info" && view.needsLogin && (
        <Link href="/login?callbackUrl=%2Fsubscribe" className="mt-5 flex w-full items-center justify-center rounded-2xl bg-[#007bff] px-6 py-4 text-lg font-bold text-white">
          로그인하고 구독 관리 보기
        </Link>
      )}
      <Link href="/subscribe" className="mt-5 flex w-full items-center justify-center rounded-2xl bg-teal-600 px-6 py-4 text-lg font-bold text-white shadow-lg transition hover:bg-teal-700">
        구독 화면으로
      </Link>
    </div>
  );
}
