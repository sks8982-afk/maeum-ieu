import Link from "next/link";
import { PUSH_DEVICE_SCOPE, SUBSCRIPTION_SCOPE } from "@/lib/privacy-scopes";

/**
 * 계정·데이터 삭제 안내 (/account-deletion) — Google Play 데이터 안전성 '계정 삭제 URL' 요구사항.
 * 로그인 없이 접근 가능해야 함(공개). 앱/개발자 이름·삭제 절차·삭제 항목·보관기간 명시.
 *
 * 2026-10-08 10차 — 삭제 항목을 코드 사실에 맞췄다(⚠ 동작을 바꾸면 여기도 바꾼다):
 *   · 휴대폰 등록(push_device — 보호자·의사 계정만 저장): user_id FK ON DELETE CASCADE
 *     (scripts/ops-push-device.ts) — 계정과 함께 지워진다. 예전 목록엔 없었다.
 *   · 구독 기록(Subscription — Play 구독 검증 결과): 결제한 계정·혜택 받는 계정 **둘 다** FK ON DELETE
 *     CASCADE(prisma/schema.prisma, scripts/ops-create-subscription.ts) — 어느 쪽을 지워도 그 기록이 지워진다. 계정을 지워도 Play 정기 결제는
 *     해지되지 않는다 — 그래서 먼저 해지하라고 적는다.
 *   (11차) 구독 기록의 범위를 스키마 그대로 적는다(SUBSCRIPTION_SCOPE): 상품(productId)·구독 상태(status)·만료일(expiresAt)·구매 토큰
 *     (purchaseToken)·마지막 확인 시각(verifiedAt)·환불·강제 해지 시각(revokedAt), 그리고 결제한 계정·혜택 받는 계정. 예전 문구("결제·환불
 *     내역을 저장하지 않습니다")는 환불·해지 시각을 저장하는 사실과 어긋났다 — 저장하지 않는 것은 결제 수단·결제 금액이고, 결제·환불 처리
 *     기록은 Google Play에 남는다. 출시 가이드의 데이터 안전성 "구매 기록" 설명도 같은 범위다(docs/playstore/README_출시가이드.md 3절).
 *   (12차) 휴대폰 등록 정보·구독 기록의 범위는 lib/privacy-scopes(PUSH_DEVICE_SCOPE·SUBSCRIPTION_SCOPE)에서 가져온다 — 개인정보처리방침
 *     1·7항·출시 가이드의 데이터 안전성 설명과 같은 문자열이다(__tests__/account-deletion-page.test.ts가 셋을 맞대어 본다).
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
            <li>위급 알림을 받는 휴대폰 등록 정보({PUSH_DEVICE_SCOPE} — 보호자·의사 계정)</li>
            <li>
              구독 기록(Google Play 구독 확인 결과 — {SUBSCRIPTION_SCOPE}). 결제한 계정과 혜택을 받는 계정 중
              어느 쪽을 삭제해도 그 구독 기록은 함께 삭제됩니다.
            </li>
          </ul>
          <p className="mt-2 leading-relaxed">
            요청이 처리되면 위 데이터는 모두 <b>영구 삭제</b>되며 복구할 수 없습니다. 원본 음성은 애초에 저장하지
            않습니다. 관련 법령상 별도 보관 의무가 있는 데이터는 없습니다.
          </p>
          <p className="mt-2 leading-relaxed">
            <b>구독 중이라면 먼저 해지해 주세요.</b> 구독 결제는 Google Play에서 이루어지며, 서비스는 결제 수단·결제 금액을
            저장하지 않습니다 — 결제·환불 처리 기록은 Google Play에 남고, 서비스에는 위 구독 기록(환불·강제 해지 시각 포함)만
            남습니다. 계정을 삭제해도 Google Play 정기 결제는 해지되지 않으니, Google Play 앱 → 결제 및 정기 결제 → 정기
            결제에서 마음이음 구독을 해지해 주세요.
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
