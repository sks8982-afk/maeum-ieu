import Link from "next/link";

/**
 * 계정·데이터 삭제 안내 (/account-deletion) — Google Play 데이터 안전성 '계정 삭제 URL' 요구사항.
 * 로그인 없이 접근 가능해야 함(공개). 앱/개발자 이름·삭제 절차·삭제 항목·보관기간 명시.
 */
export const metadata = { title: "계정 삭제 · 마음이음" };

const CONTACT = "jongwoo@firstcorea.com";
const CONTACT2 = "kyungsuk@firstcorea.com";

export default function AccountDeletionPage() {
  return (
    <div className="min-h-screen bg-white px-5 py-8 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm text-[#007bff] hover:underline">← 홈</Link>
        <h1 className="mt-3 text-2xl font-bold text-zinc-900 dark:text-zinc-100">계정 및 데이터 삭제</h1>
        <p className="mt-1 text-sm text-zinc-500">마음이음 (제공: FIRST C&D)</p>

        <p className="mt-6 leading-relaxed">
          마음이음 이용자는 언제든지 본인 계정과 관련 데이터의 삭제를 요청할 수 있습니다. 아래 방법 중 하나로
          요청해 주세요.
        </p>

        <Section title="삭제 요청 방법">
          <p className="leading-relaxed">
            가입에 사용한 이메일 주소를 적어
            {" "}
            <a href={`mailto:${CONTACT}?subject=마음이음 계정 삭제 요청`} className="font-medium text-[#007bff] hover:underline">{CONTACT}</a>
            {" "}또는{" "}
            <a href={`mailto:${CONTACT2}?subject=마음이음 계정 삭제 요청`} className="font-medium text-[#007bff] hover:underline">{CONTACT2}</a>
            {" "}
            로 &ldquo;계정 삭제 요청&rdquo;이라고 보내주세요. 본인 확인 후 <b>7일 이내</b>에 계정과 데이터를 삭제해 드립니다.
          </p>
        </Section>

        <Section title="삭제되는 데이터">
          <ul className="list-disc space-y-1 pl-5">
            <li>계정 정보(이메일·이름·나이·성별)</li>
            <li>대화 기록 및 대화 기반 인지·정서 분석 결과</li>
            <li>복약 일정·복용 기록</li>
            <li>보호자 연락처 등 연결 정보</li>
            <li>목소리 등록 정보(목소리 특징값·성문)와 상시 감시 기록</li>
          </ul>
          <p className="mt-2 leading-relaxed">
            요청이 처리되면 위 데이터는 모두 <b>영구 삭제</b>되며 복구할 수 없습니다. 원본 음성은 애초에 저장하지
            않습니다. 관련 법령상 별도 보관 의무가 있는 데이터는 없습니다.
          </p>
        </Section>

        <Section title="문의">
          <p className="leading-relaxed">
            <a href={`mailto:${CONTACT}`} className="text-[#007bff] hover:underline">{CONTACT}</a>
            {" · "}
            <a href={`mailto:${CONTACT2}`} className="text-[#007bff] hover:underline">{CONTACT2}</a>
          </p>
        </Section>

        <p className="mt-8 text-xs text-zinc-400">
          개인정보 처리에 관한 자세한 내용은 <Link href="/privacy" className="hover:underline">개인정보처리방침</Link>을 참고하세요.
        </p>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title}</h2>
      <div className="text-[15px] leading-relaxed text-zinc-700 dark:text-zinc-300">{children}</div>
    </section>
  );
}
