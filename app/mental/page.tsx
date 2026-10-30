"use client";

/**
 * T3 마음 건강 체크 — 본인용 결과 페이지 (점수·해석·추이 + 시작 안내).
 * 비진단 고지 + 위기 상담 안내 상시 노출.
 */
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "../theme-toggle";
import { LogoutButton } from "../LogoutButton";

interface ResultRow { id: string; scale: string; scaleName?: string; maxTotal?: number; date: string; total: number; severity: string; crisis?: boolean; text: string; recommend: boolean; profile?: boolean }

const SEV_STYLE: Record<string, string> = {
  "정상": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  "가벼운 수준": "bg-lime-100 text-lime-800 dark:bg-lime-900/40 dark:text-lime-200",
  "중간 수준": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  "다소 심한 수준": "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  "심한 수준": "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
};

export default function MentalPage() {
  const { status } = useSession();
  const router = useRouter();
  const [results, setResults] = useState<ResultRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status === "unauthenticated") { router.replace("/login"); return; }
    if (status !== "authenticated") return;
    fetch("/api/mental/results")
      .then((r) => r.json())
      .then((d) => setResults(d.results ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [status, router]);

  const latest = results[0];
  // 척도별 추이 분리 — PHQ-9(27점)와 GAD-7(21점)을 한 그래프에 섞으면 점수 비교가 왜곡됨
  const byScale = results.reduce<Record<string, ResultRow[]>>((acc, r) => {
    (acc[r.scale] ??= []).push(r);
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-3xl items-center justify-between flex-wrap gap-x-3 gap-y-2 whitespace-nowrap">
          <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">🧠 마음 건강</h1>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ThemeToggle />
            <Link href="/chat" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">대화</Link>
            <Link href="/help" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">사용 안내</Link>
            <Link href="/mypage" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">마이페이지</Link>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8">
        <section className="mb-6 rounded-2xl border border-indigo-200 bg-indigo-50 p-5 dark:border-indigo-900 dark:bg-indigo-900/20">
          <h2 className="mb-1 text-sm font-semibold text-indigo-900 dark:text-indigo-200">검진 시작하기</h2>
          <p className="mb-2 text-xs text-indigo-700 dark:text-indigo-300">
            대화 화면에서 아래처럼 말씀하면 시작돼요. 결과는 <b>본인만</b> 볼 수 있습니다.
          </p>
          <ul className="mb-3 space-y-0.5 text-xs text-indigo-700 dark:text-indigo-300">
            <li>· <b>&quot;마음 건강 체크&quot;</b> — 우울(PHQ-9, 9문항)</li>
            <li>· <b>&quot;불안 체크&quot;</b> — 불안(GAD-7, 7문항)</li>
            <li>· <b>&quot;외로움 체크&quot;</b> — 외로움(UCLA-3, 3문항)</li>
            <li>· <b>&quot;성격 검사&quot;</b> — 성격 5요인(BFI-10, 10문항)</li>
          </ul>
          <Link href="/chat" className="inline-block rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">대화로 이동 →</Link>
        </section>

        {loading && <p className="text-sm text-zinc-500">불러오는 중…</p>}

        {!loading && latest && (
          <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
            <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-200">최근 결과 — {latest.scaleName ?? "우울(PHQ-9)"} ({latest.date})</h2>
            {latest.profile ? (
              <span className="rounded-full bg-indigo-100 px-3 py-1 text-sm font-bold text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-200">성격 프로파일</span>
            ) : (
              <div className="flex items-center gap-4">
                <span className="text-4xl font-bold text-zinc-900 dark:text-zinc-100">{latest.total}<span className="text-base font-normal text-zinc-400">/{latest.maxTotal ?? 27}</span></span>
                <span className={`rounded-full px-3 py-1 text-sm font-bold ${SEV_STYLE[latest.severity] ?? ""}`}>{latest.severity}</span>
              </div>
            )}
            {latest.crisis && (
              <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 dark:bg-red-900/30 dark:text-red-200">
                힘든 생각이 있다고 답해 주셨어요. 혼자 견디지 마세요 — 자살예방 ☎ 109 · 위기상담 ☎ 1577-0199 (24시간)
              </p>
            )}
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{latest.text}</p>
            {latest.recommend && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
                전문가 상담을 권해요 — 정신건강복지센터 ☎ 1577-0199 (24시간)
              </p>
            )}
          </section>
        )}

        {!loading && Object.entries(byScale).filter(([, rows]) => rows.length > 1 && !rows[0].profile).map(([scale, rows]) => {
          const max = rows[0].maxTotal ?? (scale === "GAD7" ? 21 : 27);
          const warn = Math.round(max * 0.37); // PHQ9 10/27, GAD7 8/21 근사 — 색 구간용
          const mild = Math.round(max * 0.19);
          return (
            <section key={scale} className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-200">추이 — {rows[0].scaleName ?? scale}</h2>
              <div className="flex h-24 items-end gap-2">
                {[...rows].reverse().map((r) => (
                  <div key={r.id} className="flex flex-1 flex-col items-center gap-1" title={`${r.total}점 (${r.severity})`}>
                    <div className={`w-full rounded-t ${r.total >= warn ? "bg-orange-400" : r.total >= mild ? "bg-amber-400" : "bg-emerald-400"}`}
                      style={{ height: `${Math.max(4, (r.total / max) * 80)}px` }} />
                    <span className="text-[10px] text-zinc-400">{r.date.slice(5)}</span>
                  </div>
                ))}
              </div>
            </section>
          );
        })}

        {!loading && results.length === 0 && (
          <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
            아직 검진 기록이 없어요. 위 안내대로 대화에서 시작해 보세요.
          </p>
        )}

        <footer className="mt-8 space-y-1 text-[11px] text-zinc-400">
          <p>· 이 결과는 의학적 진단이 아닌 자가 점검(PHQ-9·GAD-7 기반)이에요. 정확한 평가는 전문의와 상담해 주세요.</p>
          <p>· 마음이 많이 힘들 땐: 자살예방 상담전화 ☎ 109 · 정신건강 위기상담 ☎ 1577-0199 (24시간)</p>
        </footer>
      </main>
    </div>
  );
}
