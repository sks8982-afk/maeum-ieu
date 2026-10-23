import Link from "next/link";
import { connection } from "next/server";
import { Article, TermsShell } from "../TermsShell";
import { notFound } from "next/navigation";
import { DAILY_TURN_LIMIT } from "@/lib/usage/daily-limit";
import { EARLY_CANCEL_PENALTY_PERCENT, WITHDRAWAL_DAYS } from "@/lib/billing/portone-period";
import { isPgEnabled, portoneConfigured } from "@/lib/billing/portone-plans";
import { EXAMPLE_DAYS, EXAMPLE_PRICE, REFUND_METHOD_SUMMARY, krw, refundExamples } from "@/lib/billing/pg-terms";

/**
 * 환불·청약철회 정책 (/terms/refund) — 환불정책 권장안(research C 3)과 계산 예시(C 5)를 그대로 보여 준다(2026-10-22).
 *
 * 계산 예시는 손으로 적지 않고 **실제 환불 계산 함수(refundAmount)로 그린다**(lib/billing/pg-terms refundExamples) — 위약금 비율·
 *   공제 방식을 바꾸면 예시도 함께 바뀐다(예시와 실제 환불이 다르면 허위 고지다). 기대값은 __tests__/billing-pg-terms.test.ts가 고정한다.
 * 판매 스위치가 꺼져도 포트원 설정이 있으면 열린다(유료서비스 이용약관과 같은 이유 — 가입한 결제회원이 언제든 볼 수 있어야 한다).
 *   설정 전이면 없는 페이지다(운영 변화 0 — app/terms/paid 주석).
 * ⚠ 법률 검토 전 초안 — 바꾸면 lib/billing/portone-consent의 PG_TERMS_VERSION을 올린다.
 */
export const metadata = { title: "환불·청약철회 정책 · 마음이음" };

const SUMMARY: readonly [string, string][] = [
  [`결제일부터 ${WITHDRAWAL_DAYS}일 안, 유료 혜택을 쓰지 않음`, "전액 환불"],
  [`결제일부터 ${WITHDRAWAL_DAYS}일 안, 유료 혜택을 씀`, "이용일수 금액만 빼고 환불(위약금 없음)"],
  [`${WITHDRAWAL_DAYS}일 이후, 다음 결제부터 해지(기본)`, "이용기간 마지막 날까지 이용, 그 뒤 결제 없음, 환불 없음"],
  [`${WITHDRAWAL_DAYS}일 이후, 지금 해지`, `이용일수 금액과 남은 기간 이용요금의 ${EARLY_CANCEL_PENALTY_PERCENT}%를 빼고 환불`],
  ["회사 사정(장기 장애 등)으로 제공할 수 없을 때", "위약금 없이 남은 기간 이용요금 전액 환불, 장애 시간 보상"],
  ["보호자와 어르신의 연결이 끊김", "다음 결제부터 해지. 원하면 위약금 없이 지금 해지"],
  ["혜택을 받는 어르신 계정 삭제", "위약금 없이 지금 해지(이용일수만 공제)"],
  ["결제회원 탈퇴", "지금 해지 기준으로 환불한 뒤 탈퇴"],
];

export default async function RefundPolicyPage() {
  await connection();
  if (!isPgEnabled() && !portoneConfigured()) notFound();
  const free = DAILY_TURN_LIMIT > 0 ? `하루 ${DAILY_TURN_LIMIT}회` : "무료 이용 한도";
  return (
    <TermsShell title="환불·청약철회 정책">
      <p className="mt-6 leading-relaxed">
        마음이음 월 이용권의 청약철회·해지·환불 기준입니다. 자세한 조건은{" "}
        <Link href="/terms/paid" className="text-[#007bff] hover:underline">유료서비스 이용약관</Link> 제7조~제10조와 같습니다.
      </p>

      <Article title="1. 한눈에 보기">
        <Table head={["경우", "처리"]} rows={SUMMARY.map(([a, b]) => [a, b])} />
        <p>
          &lsquo;결제일&rsquo;에는 매월 자동결제일도 들어갑니다. {WITHDRAWAL_DAYS}일은 결제한 날 당일부터 {WITHDRAWAL_DAYS}일 뒤 같은 날
          24시(한국 시간)까지입니다(예: 11월 2일 결제 → 11월 9일 24시까지).
        </p>
      </Article>

      <Article title="2. '유료 혜택을 썼다'의 뜻">
        <p>
          이용기간 중 혜택을 받는 분의 하루 대화 수가 무료 이용 한도({free})를 넘은 날이 하루라도 있으면 유료 혜택을 쓴 것입니다.
          하루는 한국 시간 0시에 다시 셉니다. 웹의 [구독 관리] 화면에 &lsquo;유료 혜택 사용: 있음/없음&rsquo;으로 보여 드립니다.
        </p>
      </Article>

      <Article title="3. 계산 방법">
        <ul className="list-disc space-y-1 pl-5">
          <li>이용일수: 이용기간 첫날부터 신청한 날까지(둘 다 포함, 한국 시간)</li>
          <li>하루 요금: 결제 금액 ÷ 그 이용기간의 실제 날짜 수</li>
          <li>공제하는 금액의 원 미만은 버립니다(돌려드리는 금액이 줄지 않게).</li>
        </ul>
      </Article>

      <Article title={`4. 계산 예시(월 ${krw(EXAMPLE_PRICE)}, 이용기간 ${EXAMPLE_DAYS}일)`}>
        <Table head={["상황", "계산", "환불액"]} rows={refundExamples().map((e) => [e.situation, e.how, krw(e.refundKrw)])} />
      </Article>

      <Article title="5. 신청 방법">
        <p>
          웹 브라우저에서 마음이음에 로그인해 [구독 관리] 화면에서 해지 방식을 고르면 됩니다. 결제일부터 {WITHDRAWAL_DAYS}일 안에
          [지금 해지]를 고르면 청약철회로 처리됩니다. 고객센터 전화나 이메일(이 화면 아래)로도 신청할 수 있습니다.
          해지는 결제회원(결제한 분)이 신청합니다.
        </p>
      </Article>

      <Article title="6. 환불 방법과 기간">
        <ul className="list-disc space-y-1 pl-5">
          <li>{REFUND_METHOD_SUMMARY} 카드사 등 결제수단 회사의 처리 기간은 각 회사 기준을 따릅니다.</li>
          <li>회사가 정당한 이유 없이 환불을 늦추면 법이 정한 지연배상금을 지급합니다.</li>
          <li>이 서비스에서만 쓸 수 있는 포인트 등으로 환불을 대신하지 않습니다.</li>
          <li>잘못 결제되었거나 더 결제된 금액은 기간과 관계없이 전액 돌려드립니다.</li>
        </ul>
      </Article>
    </TermsShell>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <table className="w-full border-collapse text-left text-sm">
      <thead>
        <tr className="border-b border-zinc-200 dark:border-zinc-700">
          {head.map((h) => <th key={h} className="py-1.5 pr-2 font-semibold">{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r[0]} className="border-b border-zinc-100 align-top dark:border-zinc-800">
            {r.map((c, i) => <td key={i} className="py-1.5 pr-2">{c}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
