import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { BizInfoFooter } from "@/app/components/BizInfoFooter";
import { WebOnly } from "@/app/components/WebOnly";
import { PAY_METHOD_LABELS, availablePayMethods, getPgPlans, isPgEnabled } from "@/lib/billing/portone-plans";
import { DAILY_TURN_LIMIT } from "@/lib/usage/daily-limit";
import {
  CANCEL_SUMMARY, PRICE_CHANGE_SUMMARY, WITHDRAWAL_SUMMARY, freeFeaturesLine, krw,
} from "@/lib/billing/pg-terms";

/**
 * 요금 안내 (/pricing) — 로그인 없이 보는 요금제 공개 페이지(2026-10-22, 웹 PG 정기결제).
 *
 * 법정·심사 항목(research D 2): 요금제별 이름·하루 대화 한도·**부가세 포함 월 총액**(총액의 일부만 앞세우지 않는다 — 제21조의2①1호),
 *   매월 자동결제·결제일·해지 방법·환불 규정 요약, 계속 무료인 기능. 요금제를 미리 골라 두지 않는다(같은 조 2호 — 여기서는 고르지 않는다).
 * 기능 스위치(isPgEnabled)가 꺼져 있으면 없는 페이지다(404) — 결제할 수 없는데 가격을 보여 주지 않는다.
 * 앱(WebView) 안에서는 웹 결제 안내를 보이지 않는다(WebOnly — Play 결제 정책). 요금제·env는 런타임 값이라 요청마다 그린다(connection).
 * 표현(설계 11): '월 이용권(하루 대화 N회)'. 충전·크레딧·횟수권, 의학적 효능 표현 금지(__tests__/billing-pg-terms.test.ts).
 */
export const metadata = { title: "요금 안내 · 마음이음" };

const card = "rounded-2xl bg-white p-5 shadow-sm dark:bg-zinc-900";
const link = "text-[#007bff] hover:underline dark:text-blue-400";

export default async function PricingPage() {
  await connection();
  if (!isPgEnabled()) notFound();
  const plans = getPgPlans();
  const methods = availablePayMethods().map((m) => PAY_METHOD_LABELS[m]).join("·");
  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-50 to-[#eef2f7] dark:from-[#0b1220] dark:to-[#0b0d10]">
      <div className="mx-auto max-w-md px-5 py-6">
        <div className="mb-5 flex items-center justify-between">
          <h1 className="text-2xl font-extrabold text-zinc-800 dark:text-zinc-100">요금 안내</h1>
          <Link href="/" className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-zinc-600 shadow-sm dark:bg-zinc-900 dark:text-zinc-300">← 홈</Link>
        </div>
        <WebOnly inApp={<InAppNotice />}>
          <p className="mb-4 text-base text-zinc-700 dark:text-zinc-200">
            마음이음 <b>월 이용권</b>은 보호자가 결제해 연결된 어르신 계정의 <b>하루 대화 한도</b>를 늘려 드리는 월 구독이에요.
          </p>
          <p className="mb-4 rounded-xl bg-white/70 px-4 py-3 text-sm text-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-200">
            🚨 {freeFeaturesLine(DAILY_TURN_LIMIT)}
          </p>
          <ul className="mb-4 space-y-3">
            {plans.map((p) => (
              <li key={p.id} className={card}>
                <p className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{p.name}</p>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">하루 대화 {p.dailyTurnLimit}회</p>
                <p className="mt-2 text-2xl font-extrabold text-zinc-900 dark:text-zinc-100">
                  월 {krw(p.priceKrw)} <span className="text-sm font-semibold text-zinc-500">(부가세 포함)</span>
                </p>
              </li>
            ))}
          </ul>
          <Facts methods={methods} />
          <Link
            href="/subscribe"
            className="mt-5 flex w-full items-center justify-center rounded-2xl bg-teal-600 px-6 py-4 text-lg font-bold text-white shadow-lg transition hover:bg-teal-700"
          >
            이용권 신청하기
          </Link>
          <p className="mt-2 text-center text-sm text-zinc-500 dark:text-zinc-400">보호자 계정으로 로그인한 뒤 신청할 수 있어요.</p>
        </WebOnly>
      </div>
      <BizInfoFooter />
    </div>
  );
}

/** 결제·해지·환불 요약 — 결제 직전 고지와 같은 문구(lib/billing/pg-terms) */
function Facts({ methods }: { methods: string }) {
  return (
    <section className={`${card} space-y-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-200`}>
      <h2 className="text-base font-bold text-zinc-800 dark:text-zinc-100">결제·해지·환불</h2>
      <p><b>매월 자동결제</b>: 처음 결제한 날과 같은 날(그날이 없는 달은 말일) 오전 10시에, 해지할 때까지 같은 금액으로 결제돼요.{methods && ` 결제수단: ${methods}.`}</p>
      <p><b>결제하는 분</b>: 보호자 계정. 연결된 어르신 한 분에게 혜택이 적용돼요(하루 대화 한도는 어르신 계정에만 있어, 어르신·일반 회원 계정은 결제할 수 없어요).</p>
      <p><b>해지</b>: 웹의 [구독 관리]에서 언제든 할 수 있어요.</p>
      <ul className="list-disc space-y-1 pl-5">{CANCEL_SUMMARY.map((s) => <li key={s}>{s}</li>)}</ul>
      <p><b>청약철회</b>: {WITHDRAWAL_SUMMARY}</p>
      <p><b>가격 변경</b>: {PRICE_CHANGE_SUMMARY}</p>
      <p className="pt-1">
        <Link href="/terms/paid" className={link}>유료서비스 이용약관</Link>{" · "}
        <Link href="/terms/refund" className={link}>환불·청약철회 정책</Link>{" · "}
        <Link href="/privacy" className={link}>개인정보처리방침</Link>
      </p>
    </section>
  );
}

/** 앱 안 — 웹 결제 안내 없이 구독 상태 화면만 가리킨다 */
function InAppNotice() {
  return (
    <p className={`${card} text-base text-zinc-700 dark:text-zinc-200`}>
      구독 상태는 <Link href="/subscribe" className={link}>구독</Link> 화면에서 확인할 수 있어요.
    </p>
  );
}
