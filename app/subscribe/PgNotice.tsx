/**
 * 결제 직전 고지 상자 — 결제창을 띄우기 전에 보여 주는 이용권 정보·해지·청약철회·환불(research D 3 체크리스트 그대로, 설계 7).
 *
 * 법정 항목: 이용권 내용·가격·제공 기간(제8조②) · 판매자·지급 방법과 시기·공급 시기·**청약철회 기한·방법·효과**·환불 조건·기술 요건·
 *   불만·분쟁 처리·약관(제13조②) — 청약철회는 링크가 아니라 **이 상자에 직접** 적는다(스포티파이·벅스 제재). 해지 두 방식도 여기서
 *   둘 다 안내한다(웨이브·벅스 제재). 문구는 요금 안내·약관과 같은 곳(lib/billing/pg-terms)에서 가져온다.
 * 훅 없는 순수 컴포넌트 — 시험이 react-dom/server로 그대로 그려 본다(__tests__/billing-pg-checkout.test.ts).
 */
import Link from "next/link";
import {
  CANCEL_SUMMARY, PRICE_CHANGE_SUMMARY, REFUND_METHOD_SUMMARY, RETRY_SUMMARY, WITHDRAWAL_SUMMARY,
  chargeSchedule, freeFeaturesLine, kstDateLabel, krw,
} from "@/lib/billing/pg-terms";
import type { PgConfig, PgPlan } from "./pg-client";

export interface PgNoticeProps {
  plan: PgPlan;
  /** 혜택 받는 분 이름(아직 고르지 않았으면 null) */
  beneficiaryName: string | null;
  methodLabel: string | null;
  freeDailyTurnLimit: number;
  business: PgConfig["business"];
  /** 지금 — 첫 결제일·다음 결제 예정일 계산 기준 */
  now: Date;
}

const box = "rounded-2xl border border-zinc-200 bg-white p-4 text-[15px] leading-relaxed text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200";
const link = "text-[#007bff] underline-offset-2 hover:underline dark:text-blue-400";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <li><b className="text-zinc-900 dark:text-zinc-100">{label}</b>: {children}</li>;
}

export function PgNotice({ plan, beneficiaryName, methodLabel, freeDailyTurnLimit, business, now }: PgNoticeProps) {
  const { chargeDay, nextCharge } = chargeSchedule(now);
  const seller = [business.name, business.phone && `고객센터 ${business.phone}`, business.email].filter(Boolean).join(" · ");
  return (
    <section aria-labelledby="pg-notice-title" className="space-y-3">
      <h2 id="pg-notice-title" className="text-lg font-bold text-zinc-800 dark:text-zinc-100">결제 전에 꼭 확인해 주세요</h2>
      <div className={box}>
        <h3 className="mb-1 font-bold text-zinc-900 dark:text-zinc-100">이용권 정보</h3>
        <ul className="space-y-1">
          <Row label="상품">마음이음 {plan.name}</Row>
          <Row label="혜택 받는 분">{beneficiaryName ? `${beneficiaryName}님 계정(연결된 가족)` : "아직 고르지 않았어요"}</Row>
          <Row label="금액">월 {krw(plan.priceKrw)}(부가세 포함) · 매월 자동결제{methodLabel ? ` · ${methodLabel}` : ""}</Row>
          <Row label="결제일">
            첫 결제는 오늘({kstDateLabel(now)}), 다음 결제는 {kstDateLabel(nextCharge)} — 해지할 때까지 매월 {chargeDay}일(그날이 없는 달은 말일)
          </Row>
          <Row label="이용 기간">결제일부터 다음 결제일 전날까지 · 결제가 끝나는 즉시 적용</Row>
          <Row label="계속 무료">{freeFeaturesLine(freeDailyTurnLimit)}</Row>
        </ul>
      </div>
      <div className={box}>
        <h3 className="mb-1 font-bold text-zinc-900 dark:text-zinc-100">해지·청약철회·환불</h3>
        <ul className="space-y-1">
          <Row label="해지">웹의 [구독 관리]에서 언제든 할 수 있어요. 두 방식 중 고릅니다.</Row>
          {CANCEL_SUMMARY.map((s) => <li key={s} className="pl-3">· {s}</li>)}
          <Row label="청약철회">{WITHDRAWAL_SUMMARY}</Row>
          <Row label="환불 방법">{REFUND_METHOD_SUMMARY}</Row>
          <Row label="결제 실패">{RETRY_SUMMARY}</Row>
          <Row label="가격 변경">{PRICE_CHANGE_SUMMARY}</Row>
        </ul>
      </div>
      <div className={box}>
        <h3 className="mb-1 font-bold text-zinc-900 dark:text-zinc-100">결제와 문의</h3>
        <ul className="space-y-1">
          <Row label="결제대행">포트원과 각 결제사(카드사·카카오페이·네이버페이)의 결제창에서 결제해요. 마음이음은 카드 번호 등 결제수단 정보를 저장하지 않아요.</Row>
          <Row label="이용 환경">웹 브라우저(PC·휴대폰)에서 결제·해지해요. 결제창이 뜨도록 팝업을 허용해 주세요.</Row>
          <Row label="판매자·문의">{seller || "이 화면 아래 사업자 정보"} · 해결되지 않으면 한국소비자원 1372에 상담할 수 있어요.</Row>
          <li>
            <Link href="/terms/paid" target="_blank" className={link}>유료서비스 이용약관</Link>{" · "}
            <Link href="/terms/refund" target="_blank" className={link}>환불·청약철회 정책</Link>{" · "}
            <Link href="/privacy" target="_blank" className={link}>개인정보처리방침</Link>
          </li>
        </ul>
      </div>
    </section>
  );
}
