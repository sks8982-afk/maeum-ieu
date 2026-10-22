import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Article, Clauses, TermsShell } from "../TermsShell";
import { getPgPlans, isPgEnabled, portoneConfigured } from "@/lib/billing/portone-plans";
import { DAILY_TURN_LIMIT } from "@/lib/usage/daily-limit";
import { readBizInfo } from "@/lib/biz-info";
import { EARLY_CANCEL_PENALTY_PERCENT, WITHDRAWAL_DAYS } from "@/lib/billing/portone-period";
import { CANCEL_SUMMARY, PRICE_CHANGE_SUMMARY, REFUND_METHOD_SUMMARY, RETRY_SUMMARY, krw } from "@/lib/billing/pg-terms";

/**
 * 유료서비스(월 이용권) 이용약관 (/terms/paid) — 웹 PG 정기결제(2026-10-22). 로그인 없이 열린다(PG 심사·결제 전 확인).
 *
 * 조항: 법정 필수 조항 목록(research D 9 — 정의·사업자 정보와 분쟁 처리·이용권 내용·가격과 결제·제공 시기·청약철회·해지와 환불·
 *   결제 실패·요금과 약관 변경·장애 보상·잘못 결제된 금액·결제회원과 이용회원·기술 요건·탈퇴와 기록 보관·의료 서비스 아님·개인정보)
 *   + 환불정책 권장안의 조항 초안(research C 4)을 그대로 옮겼다. 무료 체험 조항은 도입하지 않아 넣지 않았다(도입할 때만 — C 4).
 * 숫자(7일·10%·재시도 날짜·요금표)는 코드에서 가져온다 — 결제 화면·요금 안내와 어긋나지 않게(lib/billing/pg-terms 주석).
 * ⚠ 법률 검토 전 초안 — 문안을 바꾸면 lib/billing/portone-consent의 PG_TERMS_VERSION을 올린다(동의 기록이 문안을 가리킨다).
 *   판매 스위치(BILLING_PG_ENABLED)가 꺼져도 포트원 설정(상점 아이디)이 있으면 열린다 — 이미 가입한 결제회원이 계약 내용을 언제든 볼 수
 *   있어야 한다(제8조③·시행규칙 제5조). 둘 다 없으면(설정 전) 없는 페이지다 — 설정 없이 배포해도 초안이 공개되지 않는다(운영 변화 0).
 * 요금표·사업자 정보는 런타임 env라 요청마다 그린다(connection).
 */
export const metadata = { title: "유료서비스 이용약관 · 마음이음" };

export default async function PaidTermsPage() {
  await connection();
  if (!isPgEnabled() && !portoneConfigured()) notFound();
  const plans = getPgPlans();
  const company = readBizInfo().info.name;
  const free = DAILY_TURN_LIMIT > 0 ? `하루 ${DAILY_TURN_LIMIT}회` : "회사가 정한 무료 이용 한도";
  return (
    <TermsShell title="유료서비스(월 이용권) 이용약관">
      <Article title="제1조(목적)">
        <p>
          이 약관은 {company ?? "마음이음을 운영하는 회사"}(이하 &ldquo;회사&rdquo;)가 제공하는 마음이음의 유료서비스인 월 이용권의
          결제·이용·해지·환불에 관한 조건과 절차를 정합니다.
        </p>
      </Article>

      <Article title="제2조(용어)">
        <Clauses items={[
          <>&ldquo;결제회원&rdquo;은 이용권을 결제한 회원(보호자)을, &ldquo;이용회원&rdquo;은 결제회원과 연결되어 이용권 혜택을 받는 회원(어르신)을 말합니다.</>,
          <>&ldquo;이용권&rdquo;은 매월 자동결제로 이용회원의 하루 대화 이용 한도를 늘려 주는 유료서비스입니다. 위급 상황 감지와 보호자 위급 알림 등 무료 기능은 이용권과 관계없이 제공합니다.</>,
          <>&ldquo;결제일&rdquo;은 이용권 대금이 결제된 날이고, &ldquo;이용기간&rdquo;은 결제일부터 다음 결제 예정일 전날까지입니다.</>,
          <>&ldquo;유료 혜택 이용&rdquo;은 이용기간 중 이용회원의 하루 대화 수가 무료 이용 한도({free})를 넘은 날이 있는 것을 말합니다.</>,
        ]} />
      </Article>

      <Article title="제3조(사업자 정보와 약관의 게시)">
        <p>
          회사의 상호·대표자·영업소 주소·전화·이메일·사업자등록번호·통신판매업 신고번호는 이 화면 아래에 표시합니다. 회사는 이 약관을
          결제 화면과 <Link href="/pricing" className="text-[#007bff] hover:underline">요금 안내</Link> 화면에서 볼 수 있게 합니다.
        </p>
      </Article>

      <Article title="제4조(이용권의 내용과 제공 시기)">
        <Clauses items={[
          <>요금제와 월 금액(부가세 포함)은 아래와 같습니다. 이미 가입한 이용권에는 가입할 때의 금액과 하루 대화 한도가 그대로 적용됩니다(제11조).</>,
          <>하루 대화 수는 한국 시간 0시에 다시 셉니다.</>,
          <>이용권은 결제가 완료되는 즉시 이용회원 계정에 적용됩니다.</>,
          <>이용회원 한 명에게는 하나의 이용권만 적용됩니다.</>,
        ]} />
        <PlanTable plans={plans} />
      </Article>

      <Article id="auto-renew" title="제5조(결제와 자동 갱신)">
        <Clauses items={[
          <>결제수단은 신용·체크카드, 카카오페이, 네이버페이 중 회사가 결제 화면에 표시한 수단입니다.</>,
          <>첫 결제는 신청할 때 하고, 그 뒤로는 해지할 때까지 매월 첫 결제일과 같은 날(그날이 없는 달은 말일) 오전 10시(한국 시간)에 같은 금액이 자동결제됩니다.</>,
          <>회사는 결제할 때마다 금액·일시·결제수단·다음 결제 예정일을 이메일로 알리고, 자동결제 3일 전에도 이메일로 안내합니다.</>,
          <>결제는 결제대행사(포트원과 각 결제사)를 통해 이루어지며, 회사는 카드 번호 등 결제수단 정보를 저장하지 않습니다.</>,
          <>결제는 보호자 계정으로만 할 수 있습니다. 어르신·일반 회원·의사 계정은 결제할 수 없습니다(하루 대화 한도는 어르신 계정에만 있습니다).</>,
        ]} />
      </Article>

      <Article title="제6조(결제 실패)">
        <p>{RETRY_SUMMARY} 회사는 결제 실패와 이용권 종료를 이메일로 알립니다.</p>
      </Article>

      <Article id="withdrawal" title="제7조(청약철회)">
        <Clauses items={[
          <>결제회원은 결제일(자동 갱신 결제일을 포함합니다) 당일부터 {WITHDRAWAL_DAYS}일 뒤 같은 날 24시(한국 시간)까지 청약을 철회할 수 있습니다(예: 11월 2일에 결제했다면 11월 9일 24시까지).</>,
          <>그 기간에 유료 혜택을 이용하지 않았다면 결제 금액 전액을 환불합니다.</>,
          <>유료 혜택을 이용했다면 결제 금액에서 이용일수에 해당하는 금액만 빼고 환불하며, 위약금은 받지 않습니다.</>,
          <>신청은 웹의 [구독 관리] 화면에서 [지금 해지]를 누르면 되고, 청약철회 기간 안이면 청약철회로 처리됩니다. 고객센터 전화나 이메일로도 신청할 수 있습니다.</>,
          <>회사는 결제 화면에 청약철회의 기한·방법·효과를 표시하고, 무료 이용으로 서비스를 미리 써 볼 수 있게 합니다.</>,
        ]} />
      </Article>

      <Article id="cancel" title="제8조(해지)">
        <Clauses items={[
          <>결제회원은 언제든지 웹의 [구독 관리] 화면에서 이용권을 해지할 수 있습니다. 고객센터 전화나 이메일로도 신청할 수 있습니다.</>,
          <>해지 방식은 다음 두 가지 중 결제회원이 고릅니다. ({CANCEL_SUMMARY.join(" / ")})</>,
          <>회사는 해지 화면에 두 방식과 방식별 예상 환불액을 같은 크기와 같은 방식으로 보여 주고, 해지가 끝나면 이메일로 알립니다.</>,
        ]} />
      </Article>

      <Article id="refund" title="제9조(환불 금액 계산과 방법)">
        <Clauses items={[
          <>이용일수는 이용기간 첫날부터 해지(또는 철회)를 신청한 날까지의 날짜 수입니다(첫날과 신청일을 모두 포함하며, 한국 시간 기준). 하루 요금은 결제 금액을 그 이용기간의 실제 날짜 수로 나눈 금액입니다.</>,
          <>지금 해지의 공제액은 이용일수에 해당하는 금액과 남은 기간 이용요금의 {EARLY_CANCEL_PENALTY_PERCENT}%이며, 공제하는 금액의 원 미만은 버립니다.</>,
          <>{REFUND_METHOD_SUMMARY} 카드사 등 결제수단 회사의 처리 기간은 각 회사 기준을 따릅니다.</>,
          <>회사가 정당한 이유 없이 환불을 늦추면 그 기간에 대해 「전자상거래 등에서의 소비자보호에 관한 법률」이 정한 지연배상금을 지급합니다.</>,
          <>회사는 이 서비스에서만 쓸 수 있는 포인트 등으로 환불을 대신하지 않습니다. 계산 예시는 <Link href="/terms/refund" className="text-[#007bff] hover:underline">환불·청약철회 정책</Link>에 있습니다.</>,
        ]} />
      </Article>

      <Article title="제10조(회사 사정에 따른 해지와 서비스 장애)">
        <Clauses items={[
          <>회사 사정으로 이용권을 제공할 수 없어 계약이 해지되면 위약금 없이 남은 기간 이용요금 전액을 환불합니다. 그 밖의 손해는 관련 법령에 따라 배상합니다.</>,
          <>미리 알리지 않은 상태에서 유료 혜택이 4시간 이상 중지되거나 장애가 나면, 중지·장애 시간의 3배를 무료로 연장합니다. 3일 이상 이어지거나 한 달 누적 72시간을 넘으면 결제회원은 계약을 해지하고 남은 기간 이용요금을 돌려받을 수 있습니다.</>,
          <>24시간 전에 미리 알린 점검이라도 10시간을 넘기면 넘긴 시간만큼 무료로 연장합니다.</>,
          <>천재지변 같은 불가항력이나 이용자 과실로 생긴 시간은 계산에서 뺍니다.</>,
        ]} />
      </Article>

      <Article title="제11조(요금 변경)">
        <Clauses items={[
          <>{PRICE_CHANGE_SUMMARY}</>,
          <>요금을 올릴 때 회사는 변경 일시, 변경 전후 가격, 결제 방법과 함께 취소·해지의 조건·방법·효과를 알립니다.</>,
        ]} />
      </Article>

      <Article title="제12조(잘못 결제된 금액)">
        <p>잘못 결제되었거나 더 결제된 금액은 기간과 관계없이 전액 돌려드립니다.</p>
      </Article>

      <Article title="제13조(결제회원과 이용회원)">
        <Clauses items={[
          <>해지와 환불은 결제회원이 신청합니다.</>,
          <>결제회원과 이용회원의 연결이 끊기면 회사는 결제회원에게 알리고, 다음 결제부터 해지되도록 처리합니다. 결제회원은 연결이 끊긴 날부터 위약금 없이 지금 해지를 신청할 수 있습니다.</>,
          <>이용회원의 계정이 삭제되면 이용권은 위약금 없이 지금 해지되고, 이용일수에 해당하는 금액만 빼고 결제회원에게 환불합니다.</>,
        ]} />
      </Article>

      <Article title="제14조(회원 탈퇴와 기록 보관)">
        <Clauses items={[
          <>결제회원이 탈퇴하면 이용권은 지금 해지 기준으로 해지되고, 환불을 마친 뒤 탈퇴가 완료됩니다.</>,
          <>결제·환불 기록과 계약·청약철회 기록은 「전자상거래 등에서의 소비자보호에 관한 법률」에 따라 5년 동안 보관합니다(<Link href="/privacy#payment-retention" className="text-[#007bff] hover:underline">개인정보처리방침</Link>).</>,
          <>다른 사람의 결제수단을 허락 없이 쓰는 등 부정한 이용이 확인되면 회사는 이용권을 해지할 수 있으며, 이 경우의 환불도 이 약관의 기준을 따릅니다.</>,
        ]} />
      </Article>

      <Article title="제15조(서비스의 성격)">
        <p>마음이음의 AI 대화는 의료 진단이나 치료를 대신하지 않으며, 위급 상황 감지는 119 신고를 대신하지 않습니다.</p>
      </Article>

      <Article title="제16조(기술 요건)">
        <p>
          결제와 구독 관리는 웹 브라우저(PC·휴대폰의 최신 Chrome·Safari·Edge·삼성 인터넷 등)에서 할 수 있으며, 결제 창이 뜨도록 팝업을
          허용해야 할 수 있습니다. 마음이음 앱 안에서는 이 이용권을 결제하거나 해지할 수 없습니다.
        </p>
      </Article>

      <Article title="제17조(개인정보)">
        <p>
          이용권 결제·해지·환불에 필요한 개인정보의 처리(결제대행사에 맡기는 처리 위탁 포함)는{" "}
          <Link href="/privacy" className="text-[#007bff] hover:underline">개인정보처리방침</Link>을 따릅니다.
        </p>
      </Article>

      <Article title="제18조(불만·분쟁 처리)">
        <p>
          이용권에 관한 불만이나 분쟁은 고객센터(이 화면 아래 전화·이메일)로 접수하면 회사가 확인해 처리 결과를 알려 드립니다.
          회사와 협의가 되지 않으면 한국소비자원(소비자상담센터 국번 없이 1372) 등에 상담·조정을 신청할 수 있습니다.
        </p>
      </Article>

      <Article title="제19조(약관의 변경)">
        <p>
          회사는 이 약관을 바꿀 때 시행일과 바뀌는 내용을 시행일 7일 전부터(결제회원에게 불리한 변경은 30일 전부터) 이 화면과 이메일로
          알립니다. 요금 인상은 제11조를 따릅니다.
        </p>
      </Article>
    </TermsShell>
  );
}

function PlanTable({ plans }: { plans: readonly { id: string; name: string; dailyTurnLimit: number; priceKrw: number }[] }) {
  if (plans.length === 0) return <p className="text-sm text-zinc-500">지금은 새로 가입할 수 있는 요금제가 없습니다.</p>;
  return (
    <table className="mt-2 w-full border-collapse text-left text-sm">
      <thead>
        <tr className="border-b border-zinc-200 dark:border-zinc-700">
          <th className="py-1.5 font-semibold">요금제</th>
          <th className="py-1.5 font-semibold">하루 대화</th>
          <th className="py-1.5 font-semibold">월 금액(부가세 포함)</th>
        </tr>
      </thead>
      <tbody>
        {plans.map((p) => (
          <tr key={p.id} className="border-b border-zinc-100 dark:border-zinc-800">
            <td className="py-1.5">{p.name}</td>
            <td className="py-1.5">{p.dailyTurnLimit}회</td>
            <td className="py-1.5">{krw(p.priceKrw)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
