import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { normalizeMode } from "@/lib/roles";
import { flagOn } from "@/lib/flags";
import { LogoutButton } from "./LogoutButton";
import { BrandLogo, CompanyLogo, TalkBadge } from "./BrandLogo";

export default async function Home() {
  const session = await getServerSession(authOptions);

  // 로그아웃 상태 — 로그인/가입 랜딩
  if (!session?.user?.id) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#f0f2f5] px-4 dark:bg-[#0b0d10]">
        <main className="flex max-w-md flex-col items-center text-center">
          <BrandLogo size="lg" />
          <p className="mt-4 text-zinc-600 dark:text-zinc-300">
            AI와 대화하며 일상과 마음 건강을 함께 살펴보는 서비스예요.
          </p>
          <div className="mt-10 flex w-full flex-col gap-3 sm:flex-row sm:justify-center">
            <Link href="/login" className="rounded-full bg-[#007bff] px-8 py-4 font-medium text-white transition hover:bg-[#0069d9]">
              로그인
            </Link>
            <Link href="/signup" className="rounded-full border border-zinc-300 bg-white px-8 py-4 font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800">
              회원가입
            </Link>
          </div>
          <div className="mt-12"><CompanyLogo /></div>
        </main>
      </div>
    );
  }

  const mode = normalizeMode(session.user.screeningMode);

  // 의사·보호자·일반인은 각자의 역할 화면으로 (서버에서 결정 — 깜빡임 방지)
  if (mode === "pro" || mode === "guardian") redirect("/expert");
  // 일반인(general)도 건강정보 동의가 필요하다 — 자가점검 응답·점수가 민감정보이기 때문.
  //   서버(/api/chat)에서도 막지만, 화면에서 먼저 동의를 받아야 대화가 403으로 끊기지 않는다.
  if (mode === "general") {
    const g = await prisma.user.findUnique({ where: { id: session.user.id }, select: { consentedAt: true } });
    redirect(g?.consentedAt ? "/mental" : "/consent");
  }

  // 어르신(user) — 건강정보 미동의면 동의 화면 먼저
  const u = await prisma.user.findUnique({ where: { id: session.user.id }, select: { consentedAt: true } });
  if (!u?.consentedAt) redirect("/consent");

  // 어르신 홈 — 큼지막한 [대화하기] + 하단 작은 3개 (치매 의심 어르신도 쉽게)
  const name = session.user.name?.trim();
  // 라이브베타 켜져 있으면 음성 동선은 /live로 바로(중간 /chat 선택화면 스킵). ?start=1로 도착 즉시 자동 시작.
  const talkHref = flagOn(process.env.NEXT_PUBLIC_SHOW_LIVE_BETA) ? "/live?start=1" : "/chat?start=1";
  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-sky-50 to-[#eef2f7] px-5 pb-6 pt-5 dark:from-[#0b1220] dark:to-[#0b0d10]">
      {/* 상단 브랜드 + 로그아웃 */}
      <header className="mx-auto flex w-full max-w-md items-center justify-between">
        <BrandLogo size="sm" />
        <LogoutButton
          title="로그아웃"
          className="rounded-full p-2 text-zinc-400 hover:bg-white/70 hover:text-zinc-700 dark:hover:bg-zinc-800"
        />
      </header>
      <p className="mx-auto mt-3 w-full max-w-md text-xl font-semibold text-zinc-700 dark:text-zinc-200">
        안녕하세요{name ? `, ${name}님` : ""} 👋
      </p>

      {/* 대화하기 — 화면의 대부분을 차지하는 초대형 버튼 */}
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 pt-3">
        <Link
          href={talkHref}
          className="flex flex-1 flex-col items-center justify-center gap-4 rounded-[2rem] bg-[#007bff] px-6 py-12 text-white shadow-xl shadow-blue-500/20 transition active:scale-[0.99] hover:bg-[#0069d9]"
        >
          <TalkBadge className="h-44 w-44" />
          <span className="text-4xl font-extrabold tracking-tight">대화하기</span>
          <span className="text-lg font-medium text-blue-50/90">터치하고 편하게 말씀하세요</span>
        </Link>

        {/* 하단 작은 3개 */}
        <div className="grid grid-cols-3 gap-3">
          <HomeTile href="/observe" icon="👂" label="상시 감시" />
          <HomeTile href="/mypage" icon="⚙️" label="설정" />
          <HomeTile href="/help" icon="❓" label="도움말" />
        </div>
        <div className="flex justify-center pt-1"><CompanyLogo /></div>
      </main>
    </div>
  );
}

/** 하단 작은 타일 버튼 — 큰 아이콘 + 라벨. */
function HomeTile({ href, icon, label }: { href: string; icon: string; label: string }) {
  return (
    <Link
      href={href}
      className="flex flex-col items-center justify-center gap-1.5 rounded-2xl bg-white px-2 py-5 text-center shadow-sm transition active:scale-95 hover:shadow-md dark:bg-zinc-900"
    >
      <span className="text-3xl leading-none">{icon}</span>
      <span className="text-base font-semibold text-zinc-700 dark:text-zinc-200">{label}</span>
    </Link>
  );
}
