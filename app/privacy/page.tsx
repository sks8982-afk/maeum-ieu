import Link from "next/link";

/**
 * 개인정보처리방침 (/privacy) — Google Play 등록 필수 URL.
 * 앱의 실제 데이터 처리에 맞춰 작성. ⚠ 게시 전 법률 검토 권장(건강정보 민감정보 처리).
 *
 * 2026-10-06 개정: 목소리 등록(성문)·상시 감시를 추가하면서 개인정보 보호법 제30조·시행령 제31조 항목을
 *   다시 맞췄다(제3자 제공·국외 이전·위탁 사업자 누락분, 보호자 정보 암호화 표기 정정). 근거 조사는
 *   docs/CYCLE_FIXLOG.md 같은 날 항목. ⚠ 각 문장은 코드 동작과 맞춰 썼다 — 동작을 바꾸면 여기도 바꾼다.
 */
export const metadata = { title: "개인정보처리방침 · 마음이음" };

const UPDATED = "2026년 10월 6일";
const PREVIOUS = "2026년 9월 10일";
const CONTACT = "jongwoo@firstcorea.com";
const CONTACT2 = "kyungsuk@firstcorea.com";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-white px-5 py-8 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
      <div className="mx-auto max-w-2xl">
        <Link href="/" className="text-sm text-[#007bff] hover:underline">← 홈</Link>
        <h1 className="mt-3 text-2xl font-bold text-zinc-900 dark:text-zinc-100">개인정보처리방침</h1>
        <p className="mt-1 text-sm text-zinc-500">마음이음 (제공: FIRST C&D) · 시행 {UPDATED}</p>

        <p className="mt-6 leading-relaxed">
          마음이음(이하 &ldquo;서비스&rdquo;)은 어르신이 AI와 음성으로 대화하며 일상과 인지·마음 건강을 함께
          살피도록 돕는 서비스입니다. 본 방침은 서비스가 어떤 개인정보를 수집·이용·보관·보호하는지 설명합니다.
        </p>
        <p className="mt-2 leading-relaxed">
          서비스는 <b>생성형 인공지능(Google Gemini)</b>을 이용해 대화 응답을 만들고, 음성을 글자로 바꾸고,
          위급 신호를 판단합니다.
        </p>

        <div className="mt-4 flex flex-wrap gap-2 text-xs font-semibold">
          {["민감정보(건강정보) 처리", "생체인식정보(목소리 특징값) 처리 — 선택", "보호자·의사 제공", "처리 위탁", "국외 이전"].map((t) => (
            <span key={t} className="rounded-full bg-zinc-100 px-3 py-1 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">{t}</span>
          ))}
        </div>

        <Section title="1. 수집하는 개인정보 항목">
          <ul className="list-disc space-y-1 pl-5">
            <li><b>계정 정보</b>: 이메일, 비밀번호(암호화 저장), 이름, 나이, 성별</li>
            <li><b>건강·인지 정보(민감정보)</b>: AI와의 대화 내용, 대화에서 도출된 인지 선별 결과·이상 신호, 복약 일정·복용 기록</li>
            <li><b>음성 데이터</b>: 대화 중 마이크로 입력된 음성. 음성은 실시간 인식(텍스트 변환)에만 사용되며 원본 음성 파일은 서버에 보관하지 않습니다.</li>
            <li><b>보호자 정보</b>: 위급 상황 알림을 위한 보호자 이름·관계, 연락처(전화번호·이메일 — 암호화 저장), 알림을 받을 메신저 주소(선택)</li>
            <li><b>위치 정보(대략적)</b>: 대화 중 &lsquo;장소 지남력&rsquo; 참고 및 날씨 안내를 위한 도시 수준의 대략적 위치. 정밀(GPS) 위치는 사용하지 않으며, 기기 설정에서 언제든 철회할 수 있습니다.</li>
            <li><b>기기·이용 정보</b>: 앱 버전, 알림 토큰(푸시 알림용)</li>
            <li><b>목소리 특징값(성문) — 민감정보(생체인식정보), 선택</b>: 목소리 등록에 따로 동의한 어르신만. 아래 3항 참고.</li>
            <li><b>상시 감시 정보 — 민감정보(건강정보), 선택</b>: 상시 감시에 따로 동의한 어르신만. 어르신 목소리로 판단된 말소리(저장하지 않음), 위급 신호로 판정된 말(글자)과 판정 결과. 아래 3항 참고.</li>
          </ul>
        </Section>

        <Section title="2. 개인정보의 이용 목적">
          <ul className="list-disc space-y-1 pl-5">
            <li>AI 음성 대화 동반 및 일상 돌봄 제공</li>
            <li>인지·마음 건강 상태의 지속적 관찰 및 위급 신호(응급) 감지</li>
            <li>위급 상황 시 보호자에게 알림 발송</li>
            <li>복약 시간 알림 제공</li>
            <li>연결된 보호자·의사에게 결과 요약 또는 상세 평가내역 제공(아래 9항 참고)</li>
            <li>(선택) 목소리 등록: 상시 감시 중 들린 말소리가 어르신 본인 목소리인지 확인(화자 확인)</li>
            <li>(선택) 상시 감시: 어르신이 혼자 계실 때 하시는 말에서 위급 신호를 찾아 보호자·의사에게 알림</li>
          </ul>
        </Section>

        <Section title="3. 목소리 등록(성문)과 상시 감시 — 선택 기능">
          <p className="leading-relaxed">
            두 기능은 <b>선택</b>이며, 각각 <b>따로 동의</b>(개인정보 보호법 제23조 민감정보 별도 동의, 상시 감시의
            보호자·의사 알림은 제17조 제공 동의)를 받은 경우에만 처리합니다. 동의하지 않아도 다른 기능은 그대로
            이용할 수 있습니다. 동의는 어르신 본인의 뜻이어야 하며 가족이 대신할 수 없습니다(법원이 선임한 후견인은
            문의해 주세요).
          </p>
          <h3 className="mt-3 font-semibold text-zinc-900 dark:text-zinc-100">목소리 등록(성문)</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li><b>항목</b>: 목소리 특징값(성문) — 목소리에서 뽑은 숫자 256개. 녹음 파일이 아니며, 등록할 때마다 만든 값과 그 평균값을 보관합니다.</li>
            <li><b>처리 방식</b>: 등록할 때 30초 동안 읽은 녹음은 휴대폰 안에서 특징값을 만드는 데만 쓰고, 저장하거나 서버로 보내지 않습니다. 확인 테스트 때 녹음한 목소리의 특징값은 비교에만 쓰고 저장하지 않습니다.</li>
            <li><b>이용 범위</b>: 상시 감시의 화자 확인에만 씁니다. 인지 분석, 인공지능 학습, 광고 등 다른 목적에는 쓰지 않습니다.</li>
            <li><b>보관</b>: 목소리 등록을 지우거나 동의를 철회하면 바로, 회원 탈퇴 때는 계정과 함께 삭제합니다.</li>
            <li><b>보호</b>: 암호화(AES-256-GCM)해 저장하고, 특징값은 어르신 본인 기기로만 내려보냅니다. 연결된 의사(전문가)는 등록 여부만 볼 수 있습니다. 의사가 등록을 도울 수 있지만 어르신 본인의 동의가 있을 때만 가능합니다.</li>
          </ul>
          <h3 className="mt-3 font-semibold text-zinc-900 dark:text-zinc-100">상시 감시</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li><b>처리 방식</b>: 켜 두는 동안 휴대폰이 주변 소리를 듣고, 말소리가 들리면 휴대폰 안에서 등록된 목소리와 비교해 <b>어르신 목소리로 판단된 말소리만</b> 서버로 보냅니다. 서버는 이를 글자로 바꿔 위급 신호를 판단하고, 위급하면 보호자·의사에게 알립니다. [감시 끄기]를 누르거나 화면을 나가면 멈춥니다.</li>
            <li><b>다른 사람의 목소리</b>: 다른 사람 목소리·TV 소리·잡음으로 판단된 소리는 휴대폰 안에서 비교만 하고 바로 버리며, 누구인지 알아보지 않습니다. <b>다만 기계 판단이라 완벽하지 않아, 어르신과 다른 분의 말소리가 섞이면 함께 서버로 보내질 수 있습니다.</b> 그래서 다른 분과 이야기하거나 통화할 때는 끄도록 안내하고, 함께 사는 분·방문하는 분께 미리 알리도록 안내합니다.</li>
            <li><b>보관</b>: 말소리(음성)는 서버에 저장하지 않습니다. 위급 신호가 없는 말은 글자로 바꿔 확인한 뒤 저장하지 않습니다. 위급 신호로 판정된 말과 판정 결과(단계·종류·시각)는 상시 감시 동의를 철회하거나 회원 탈퇴할 때까지 보관합니다.</li>
          </ul>
        </Section>

        <Section title="4. 개인정보의 제3자 제공">
          <ul className="list-disc space-y-1 pl-5">
            <li><b>받는 자</b>: 어르신이 직접 연결한 보호자·의사(앱 계정), 어르신이 등록한 보호자 이메일·메신저 알림 주소</li>
            <li><b>목적</b>: 위급 상황 확인과 대응, 연결된 보호자·의사의 결과 확인(열람 범위는 9항)</li>
            <li><b>위급 알림 항목</b>: 어르신 이름, 위급 신호의 단계·종류, 감지 시각(메신저 알림 주소에는 해당 발화 일부 최대 200자 포함). 연결된 의사는 앱에서 위급으로 판정된 발화를 볼 수 있습니다.</li>
            <li><b>받는 자의 보유 기간</b>: 앱에서 보는 정보는 연결이 해제되거나 관련 동의를 철회·탈퇴하면 더 이상 볼 수 없습니다. 이메일·메신저로 받은 알림은 받는 분이 관리합니다.</li>
            <li><b>근거</b>: 정보주체의 동의(건강정보 수집·이용 동의, 상시 감시의 보호자·의사 알림 동의)</li>
          </ul>
        </Section>

        <Section title="5. 개인정보 처리 위탁">
          <p className="leading-relaxed">서비스 제공을 위해 아래 사업자에 개인정보 처리를 위탁합니다.</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li><b>Google LLC (Gemini API)</b>: 음성 인식, AI 대화 생성, 위급 신호 판단 보조, 상시 감시 말소리의 글자 변환</li>
            <li><b>Google LLC (Firebase Cloud Messaging)</b>: 보호자·의사 앱 위급 알림 발송</li>
            <li><b>Google LLC (Gmail)</b>: 보호자 위급 알림 이메일 발송</li>
            <li><b>Amazon Web Services</b>: 데이터베이스 저장(한국/서울 리전)</li>
            <li><b>Vercel Inc.</b>: 애플리케이션 호스팅(서버 실행 지역: 서울)</li>
            <li><b>Upstash, Inc.</b>: 과도한 요청 제한(이용자 식별값을 짧게 처리)</li>
          </ul>
          <p className="mt-2 leading-relaxed">위 사업자는 각자의 개인정보 보호정책에 따라 데이터를 처리하며, 서비스는 목적 달성에 필요한 범위에서만 정보를 전달합니다.</p>
        </Section>

        <Section title="6. 개인정보의 국외 이전">
          <p className="leading-relaxed">
            개인정보 보호법 제28조의8제1항제3호(서비스 제공 계약 이행을 위한 처리위탁·보관)에 따라 다음과 같이 알려 드립니다.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li><b>이전받는 자</b>: Google LLC (문의: policies.google.com/privacy 의 문의 창구)</li>
            <li><b>이전 국가</b>: 미국 등 Google 또는 그 수탁자가 설비를 운영하는 국가</li>
            <li><b>이전 항목</b>: AI 대화의 음성·텍스트, 상시 감시 말소리와 그 글자(건강정보가 포함될 수 있음), 위급 알림에 담기는 정보(어르신 이름·위급 신호 종류·시각, 보호자 이메일 주소, 알림 토큰)</li>
            <li><b>이전 시기·방법</b>: 서비스를 이용할 때마다(위급 알림은 위급 신호가 감지될 때) 암호화된 통신(TLS)으로 전송</li>
            <li><b>이용 목적</b>: 음성 인식, AI 대화 생성, 위급 신호 판단, 알림 발송</li>
            <li><b>보유·이용 기간</b>: Gemini API는 요청을 처리하는 데 쓰며(응답 속도를 위해 최대 10분 임시 저장될 수 있음), Google 유료 API 약관에 따라 AI 학습에 쓰이지 않습니다. 다만 정책 위반 감시를 위해 제한된 기간 기록될 수 있습니다. 위급 알림 메일은 발송용 메일 계정에 사본이 남을 수 있습니다.</li>
            <li><b>거부 방법·효과</b>: 문의처로 요청하거나 해당 기능을 쓰지 않으면 이전되지 않습니다. 다만 AI 대화와 상시 감시는 이 처리 없이는 제공할 수 없습니다.</li>
          </ul>
        </Section>

        <Section title="7. 보관 및 파기">
          <ul className="list-disc space-y-1 pl-5">
            <li>계정 정보, 텍스트로 변환된 대화 기록, 인지 분석 결과, 복약 기록: 회원 탈퇴 또는 동의 철회 시까지 보관 후 지체 없이 파기</li>
            <li>원본 음성(대화·상시 감시): 저장하지 않습니다.</li>
            <li>목소리 특징값: 등록 삭제·동의 철회 시 즉시, 회원 탈퇴 시 계정과 함께 삭제</li>
            <li>상시 감시: 위급 신호가 없는 말은 저장하지 않으며, 위급 판정 기록은 상시 감시 동의 철회 또는 회원 탈퇴 시 삭제</li>
          </ul>
          <p className="mt-2 leading-relaxed">
            파기는 데이터베이스에서 복구할 수 없게 삭제하는 방법으로 합니다. 회원 탈퇴(계정 삭제)는 요청 후 본인
            확인을 거쳐 7일 이내에 처리합니다(<Link href="/account-deletion" className="text-[#007bff] hover:underline">계정 삭제 안내</Link>).
          </p>
        </Section>

        <Section title="8. 보호 조치">
          <ul className="list-disc space-y-1 pl-5">
            <li>모든 통신은 HTTPS(TLS)로 암호화됩니다.</li>
            <li>보호자 연락처(전화번호·이메일)는 AES 방식으로 암호화하여 저장합니다.</li>
            <li>목소리 특징값(성문)은 AES-256-GCM으로 암호화하여 저장합니다.</li>
            <li>비밀번호는 복호화 불가능한 해시(bcrypt)로 저장됩니다.</li>
            <li>데이터베이스 접근은 최소 권한 원칙에 따라 통제됩니다.</li>
          </ul>
        </Section>

        <Section title="9. 결과 열람 범위 (프라이버시 원칙)">
          <ul className="list-disc space-y-1 pl-5">
            <li><b>어르신 본인</b>: 대화만 하며, 인지 결과는 본인에게 표시하지 않습니다(불안 방지).</li>
            <li><b>연결된 의사</b>: 검진 문답·평가 상세를 열람합니다.</li>
            <li><b>연결된 보호자</b>: 결과 요약과 위급 알림만 받습니다.</li>
            <li><b>일상 대화 원문</b>은 보호자·의사에게 공개되지 않습니다(위급으로 감지된 발화 제외).</li>
          </ul>
          <p className="mt-2 leading-relaxed">보호자·의사 연결은 어르신 본인이 코드를 입력해 동의한 경우에만 이루어집니다.</p>
        </Section>

        <Section title="10. 마이크·위치·알림 권한">
          <p className="leading-relaxed">
            음성 대화를 위해 <b>마이크 권한</b>이, 위급·복약 알림을 위해 <b>알림 권한</b>이 필요합니다.
            또한 &lsquo;장소 지남력&rsquo; 참고 및 날씨 안내를 위해 <b>대략적 위치 권한</b>을 사용합니다(선택 — 거부해도 나머지 기능은 정상 이용).
            모든 권한은 해당 기능 사용 시에만 이용되며, 기기 설정에서 언제든 철회할 수 있습니다.
            상시 감시를 켜면 [감시 끄기]를 누르거나 화면을 나갈 때까지 마이크로 주변 소리를 계속 듣습니다(화면에 상태 표시).
          </p>
        </Section>

        <Section title="11. 위급 신호 자동 판단">
          <p className="leading-relaxed">
            대화와 상시 감시의 위급 신호는 규칙(단어·문장)과 인공지능(Google Gemini)이 자동으로 판단합니다.
            위급을 놓치거나 위급이 아닌데 알림이 갈 수 있으며, <b>119 신고를 대신하지 않습니다.</b> 판단 기준과
            결과에 대한 설명은 아래 문의처로 요청하실 수 있습니다.
          </p>
        </Section>

        <Section title="12. 이용자의 권리">
          <p className="leading-relaxed">
            이용자(또는 법정대리인·위임을 받은 사람)는 본인 개인정보의 열람·정정·삭제·처리정지 및 동의 철회를
            요청할 수 있습니다. 요청은 아래 연락처로 접수해 주시면 10일 이내에 처리 결과를 알려 드립니다.
            대리인은 위임장을 함께 제출해 주세요.
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>목소리 등록 확인·삭제·동의 철회: 마이페이지 &gt; 목소리 등록 화면(아래 [목소리 등록 동의 철회])</li>
            <li>상시 감시 동의 철회: 상시 감시 화면 아래 [상시 감시 동의 철회] — 보관한 상시 감시 기록이 함께 삭제됩니다.</li>
            <li>회원 탈퇴: <Link href="/account-deletion" className="text-[#007bff] hover:underline">계정 삭제 안내</Link></li>
          </ul>
        </Section>

        <Section title="13. 아동">
          <p className="leading-relaxed">본 서비스는 만 14세 이상을 대상으로 하며, 아동을 대상으로 하지 않습니다.</p>
        </Section>

        <Section title="14. 문의처">
          <p className="leading-relaxed">
            개인정보 관련 문의: <a href={`mailto:${CONTACT}`} className="text-[#007bff] hover:underline">{CONTACT}</a>
            {" · "}
            <a href={`mailto:${CONTACT2}`} className="text-[#007bff] hover:underline">{CONTACT2}</a>
          </p>
          <p className="mt-2 leading-relaxed">
            개인정보 침해에 대한 신고·상담은 개인정보침해신고센터(국번 없이 118, privacy.kisa.or.kr),
            개인정보분쟁조정위원회(1833-6972, kopico.go.kr)에 하실 수 있습니다.
          </p>
        </Section>

        <Section title="15. 변경 내역">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <b>{UPDATED} 시행</b>: 목소리 등록(성문)·상시 감시 항목과 별도 동의 신설(1·2·3항), 제3자 제공(4항)·국외 이전(6항)·
              위급 신호 자동 판단(11항) 안내 신설, 처리 위탁 사업자 추가(Firebase Cloud Messaging·Gmail·Upstash),
              항목별 보관 기간 명시(7항), 목소리 특징값 암호화 저장(8항), 보호자 정보 표기 정정(이름·관계는 암호화 대상 아님),
              권리 행사 방법 보완(12항), 생성형 인공지능 이용 안내
            </li>
            <li>이전 방침: {PREVIOUS} 시행</li>
          </ul>
        </Section>

        <p className="mt-8 text-xs text-zinc-400">
          본 방침은 관련 법령 및 서비스 변경에 따라 개정될 수 있으며, 개정 시 본 페이지를 통해 공지합니다.
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
