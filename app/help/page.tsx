/**
 * 도움말 — 계정 역할별 사용 안내.
 *
 * 왜 역할별인가: 같은 앱이지만 할 일이 전혀 다르다. 어르신은 말하는 법만 알면 되고,
 *   보호자는 연결·알림과 "무엇이 보이지 않는지"를, 의사는 검진 절차를, 일반인은 자가점검
 *   시작 방법을 알아야 한다. 하나의 안내로 합치면 각자에게 대부분이 남의 이야기가 된다.
 *
 * 어르신 안내는 **실제 동작과 1:1로 일치**해야 한다 — 호출어는 설정한 AI 이름을 따라가고
 *   ("민지"면 "민지야"), 종료는 "그만", 재개는 화면의 [다시 대화하기]다. 문구와 동작이
 *   어긋났던 실기기 결함 이력(2026-07-07)이 있어 여기 적는 말은 코드에서 확인한 것만 쓴다.
 */
import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeMode, type ScreeningMode } from "@/lib/roles";
import { COMPANION_DEFAULTS } from "@/lib/chat/constants";
import { hasJongseong } from "@/lib/chat/korean-particle";

export const metadata = { title: "도움말 — 마음이음" };

interface Card { icon: string; title: string; body: string }

/** 어르신 — 큰 글씨, 음성 동선만. 호칭·호출어는 설정값을 그대로 반영한다. */
function elderCards(companionName: string, wakeCall: string): Card[] {
  return [
    {
      icon: "💬", title: "대화 시작하기",
      body: `홈 화면의 가운데 큰 파란 버튼을 누르면 ${companionName}가 먼저 인사해요. 그다음부터는 평소처럼 편하게 말씀하시면 됩니다. 글자를 쓰지 않아도 돼요.`,
    },
    {
      icon: "🗣️", title: `부르실 때는 "${wakeCall}"`,
      body: `${companionName}가 말하는 중이거나 잠깐 쉬고 있을 때 "${wakeCall}"라고 부르면 다시 들어요. 이름은 설정에서 바꿀 수 있고, "마음아"라고 불러도 항상 대답해요.`,
    },
    {
      icon: "✋", title: "그만하고 싶을 때",
      body: `"그만" 또는 "조용히"라고 말씀하시면 멈춰요. 다시 이야기하고 싶으면 화면의 [다시 대화하기] 버튼을 누르시면 됩니다.`,
    },
    {
      icon: "🌙", title: "하루 분량이 끝나면",
      body: `이야기를 많이 나눈 날은 ${companionName}가 "오늘은 여기까지 하고 내일 또 만나요"라고 인사해요. 고장이 아니니 걱정하지 마시고, 다음 날 다시 눌러주세요.`,
    },
    {
      icon: "💊", title: "약 드실 시간",
      body: `설정에서 약 시간을 넣어두면 그 시간에 ${companionName}가 먼저 말을 걸어 알려드려요.`,
    },
    {
      icon: "🎤", title: "목소리가 안 들어갈 때",
      body: "마이크가 막혀 있으면 화면에 안내가 떠요. 휴대폰 설정 → 애플리케이션 → 마음이음 → 권한에서 마이크를 허용해 주세요. 그때까지는 [글씨로 대화하기]로 이야기할 수 있어요.",
    },
    {
      icon: "👂", title: "상시 감시 (베타)",
      body: "켜 두는 동안 등록한 목소리를 듣다가, 위급한 상황으로 보이면 가족에게 자동으로 알려드리는 기능이에요. 처음 켤 때 따로 동의를 받아요. 다른 분과 이야기하시거나 전화하실 때는 꺼 주세요. 쓰고 싶지 않으면 켜지 않아도 됩니다.",
    },
    {
      icon: "⚙️", title: "설정에서 바꿀 수 있는 것",
      body: `불러드릴 호칭, ${companionName}의 이름, 약 시간 알림, 가족·의사 연결 코드를 정할 수 있어요.`,
    },
    {
      icon: "🔒", title: "대화 내용은 비공개예요",
      body: `나눈 이야기의 원문은 가족이나 의사에게 보이지 않아요. 위급한 상황으로 보이는 말씀만 가족에게 알려드립니다.`,
    },
  ];
}

/** 보호자 — 연결·알림, 그리고 '볼 수 없는 것'을 분명히(동의서 §4와 같은 경계) */
const guardianCards: Card[] = [
  {
    icon: "🔗", title: "어르신과 연결하기",
    body: "[가족 상태] 화면의 '내 초대 코드'를 어르신께 알려주세요. 어르신이 마이페이지 → 보호자·전문가 연결에서 그 코드를 입력하면 목록에 나타납니다.",
  },
  {
    icon: "🚨", title: "위급 알림",
    body: "어르신이 숨이 가쁘다·가슴이 아프다·크게 다쳤다는 등 위급 신호로 보이는 말씀을 하면 앱 푸시와 이메일로 즉시 알려드립니다. 알림을 받으면 먼저 전화로 상태를 확인해 주세요.",
  },
  {
    icon: "📋", title: "볼 수 있는 것",
    body: "상태 요약(등급·추세)과 위급 알림 이력입니다. 변화가 보이면 진료를 권해 주세요.",
  },
  {
    icon: "🔒", title: "볼 수 없는 것",
    body: "일상 대화의 원문과 문항별 상세 평가내역은 보호자에게 공개되지 않습니다. 어르신이 마음 놓고 이야기할 수 있어야 평가가 정확해지기 때문이며, 가입 시 동의서에 명시된 약속입니다.",
  },
  {
    icon: "🩺", title: "판단은 의사가",
    body: "앱의 등급은 선별 참고용이며 진단이 아닙니다. 상세 평가내역 열람과 임상 판단은 연결된 의사·전문가의 역할입니다.",
  },
];

/** 의사·전문가 — 검진 시행 절차 */
const proCards: Card[] = [
  {
    icon: "🔗", title: "환자 연결",
    body: "[환자 관리]의 '내 초대 코드'를 환자(또는 보호자)에게 전달하세요. 환자가 마이페이지 → 보호자·전문가 연결에서 입력하면 목록에 추가됩니다.",
  },
  {
    icon: "🩺", title: "검진 시행",
    body: "환자 상세 화면에서 검진을 시작하면 영역별 문항이 순서대로 제시됩니다. 환자 앞에서 진행하는 대리 검사이므로 호출어 없이 바로 음성 청취가 시작되고, 종료 명령도 받지 않습니다(환자의 '그만하고 싶다'가 검사를 중단시키지 않도록).",
  },
  {
    icon: "📝", title: "문항지와 채점",
    body: "[검진 문항지]에서 영역·문항과 채점 기준을 미리 확인할 수 있습니다. 미채점 항목은 0점이 아니라 '미채점'으로 구분 표기됩니다.",
  },
  {
    icon: "📊", title: "상세 평가내역",
    body: "문항별 채점, 응답 원문, 임상 근거는 의사 계정에서만 열람됩니다. 단, 환자의 일상 대화 원문은 의사에게도 공개되지 않습니다(동의서 §4).",
  },
  {
    icon: "⚠️", title: "선별이지 진단이 아님",
    body: "등급과 추세는 선별 보조 지표입니다. 확진·처방은 임상 판단과 표준 검사로 확인해 주세요.",
  },
];

/** 일반인 — 자가점검 시작 방법 */
const generalCards: Card[] = [
  {
    icon: "💬", title: "검사 시작하기",
    body: '대화 화면에서 "우울 검사", "불안 검사", "성격 검사"라고 말하거나 입력하면 바로 시작됩니다.',
  },
  {
    icon: "📊", title: "결과 보기",
    body: "[마음 건강] 화면에서 점수·해석과 지난 결과의 추이를 볼 수 있어요. 결과는 본인만 볼 수 있습니다.",
  },
  {
    icon: "🧠", title: "인지 선별은 없어요",
    body: "일반인 계정은 치매 인지 선별 대상이 아닙니다. 대화 중 인지 확인 질문이 섞이지 않고, 인지 평가 데이터도 만들지 않습니다.",
  },
  {
    icon: "⚠️", title: "자가 점검이에요",
    body: "PHQ-9·GAD-7 기반 자가 점검이며 의학적 진단이 아닙니다. 점수가 높게 나오면 전문의 상담을 권합니다.",
  },
];

const TITLES: Record<ScreeningMode, string> = {
  user: "도움말",
  guardian: "보호자 사용 안내",
  pro: "전문가 사용 안내",
  general: "사용 안내",
};

export default async function HelpPage() {
  const session = await getServerSession(authOptions);
  const mode = normalizeMode(session?.user?.screeningMode);

  // 어르신 안내는 설정값(동반자 이름)에 따라 호출어가 달라진다 — 화면 문구와 실제 동작을 일치시킨다.
  let companionName: string = COMPANION_DEFAULTS.name;
  if (mode === "user" && session?.user?.id) {
    const u = await prisma.user.findUnique({
      where: { id: session.user.id }, select: { companionName: true },
    }).catch(() => null);
    companionName = u?.companionName?.trim() || COMPANION_DEFAULTS.name;
  }
  const wakeCall = companionName + (hasJongseong(companionName) ? "아" : "야");

  const cards = mode === "guardian" ? guardianCards
    : mode === "pro" ? proCards
    : mode === "general" ? generalCards
    : elderCards(companionName, wakeCall);

  const homeHref = mode === "guardian" || mode === "pro" ? "/expert" : mode === "general" ? "/mental" : "/";
  const elder = mode === "user";

  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-50 to-[#eef2f7] px-5 py-6 dark:from-[#0b1220] dark:to-[#0b0d10]">
      <div className={`mx-auto ${elder ? "max-w-md" : "max-w-2xl"}`}>
        <div className="mb-5 flex items-center justify-between">
          <h1 className={`font-extrabold text-zinc-800 dark:text-zinc-100 ${elder ? "text-3xl" : "text-2xl"}`}>
            {TITLES[mode]}
          </h1>
          <Link href={homeHref} className="rounded-full bg-white px-4 py-2 text-base font-semibold text-zinc-600 shadow-sm dark:bg-zinc-900 dark:text-zinc-300">
            ← 돌아가기
          </Link>
        </div>

        <div className="space-y-3">
          {cards.map((it) => (
            <section key={it.title} className="rounded-2xl bg-white p-5 shadow-sm dark:bg-zinc-900">
              <h2 className={`flex items-center gap-2 font-bold text-zinc-800 dark:text-zinc-100 ${elder ? "text-xl" : "text-lg"}`}>
                <span className="text-2xl">{it.icon}</span> {it.title}
              </h2>
              <p className={`mt-2 leading-relaxed text-zinc-600 dark:text-zinc-300 ${elder ? "text-lg" : "text-base"}`}>
                {it.body}
              </p>
            </section>
          ))}

          {/* 위급 안내는 모든 역할에 공통 — 앱보다 119가 먼저다 */}
          <section className="rounded-2xl border-2 border-red-200 bg-red-50 p-5 dark:border-red-900 dark:bg-red-900/20">
            <h2 className={`font-bold text-red-700 dark:text-red-300 ${elder ? "text-xl" : "text-lg"}`}>🚨 위급할 때</h2>
            <p className={`mt-2 leading-relaxed text-red-700 dark:text-red-200 ${elder ? "text-lg" : "text-base"}`}>
              {elder
                ? <>숨쉬기 힘들거나 가슴이 아프거나 크게 다치셨다면, 앱보다 먼저 <b>119</b>에 전화하세요.</>
                : <>이 앱은 응급 대응 수단이 아닙니다. 위급 상황에는 <b>119</b>에 먼저 연락하세요. 알림은 보조 수단이며 전달이 지연·실패할 수 있습니다.</>}
            </p>
          </section>

          {!elder && (
            <p className="px-1 pt-1 text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
              개인정보 처리와 열람 범위는 <Link href="/privacy" className="underline">개인정보처리방침</Link>에서 확인할 수 있습니다.
            </p>
          )}
        </div>

        {elder && (
          // 홈과 같은 동선 — 라이브 베타가 켜진 환경에선 /live로 바로 간다(중간 선택화면 스킵)
          <Link href={process.env.NEXT_PUBLIC_SHOW_LIVE_BETA === "1" ? "/live?start=1" : "/chat?start=1"} className="mt-6 flex items-center justify-center gap-2 rounded-2xl bg-[#007bff] px-6 py-5 text-xl font-bold text-white shadow-lg transition hover:bg-[#0069d9]">
            💬 지금 대화하기
          </Link>
        )}
      </div>
    </div>
  );
}
