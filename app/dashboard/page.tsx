"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import Link from "next/link";

interface CognitiveAssessment {
  domain: string; score: number; confidence: number;
  evidence: string | null; note: string | null; session_date: string;
}
interface DomainAvg { domain: string; avg_score: number; count: number; }
interface DailyTrend { session_date: string; avg_score: number; check_count: number; }
interface Summary { anomalyCount: number; recentAnomaly: number; }
interface CognitiveData { assessments: CognitiveAssessment[]; domainAverages: DomainAvg[]; dailyTrend: DailyTrend[]; }

const DOMAIN_LABELS: Record<string, string> = {
  orientation_time: "시간 지남력", orientation_place: "장소 지남력",
  memory_immediate: "즉시 기억력", memory_delayed: "지연 기억력",
  language: "언어 유창성", judgment: "판단력",
};
const SCORE_LABELS = ["정상", "경계", "주의"];
const SCORE_COLORS = ["bg-green-500", "bg-yellow-500", "bg-red-500"];
const SCORE_TEXT = ["text-green-600", "text-yellow-600", "text-red-600"];

function formatShortDate(d: string): string {
  return new Date(d + "T00:00:00+09:00").toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric" });
}

export default function DashboardPage() {
  const { status } = useSession();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [cognitive, setCognitive] = useState<CognitiveData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (status !== "authenticated") return;
    (async () => {
      try {
        const res = await fetch("/api/health-logs");
        if (!res.ok) return;
        const data = await res.json();
        setSummary(data.summary ?? null);
        setCognitive(data.cognitive ?? null);
      } catch (e) { console.error(e); }
      finally { setLoading(false); }
    })();
  }, [status]);

  if (status === "loading" || loading) {
    return <div className="flex min-h-screen items-center justify-center bg-[#f0f2f5]"><p className="text-zinc-500">로딩 중...</p></div>;
  }

  const totalChecks = cognitive?.domainAverages.reduce((s, d) => s + d.count, 0) ?? 0;
  const overallAvg = totalChecks > 0 ? cognitive!.domainAverages.reduce((s, d) => s + d.avg_score * d.count, 0) / totalChecks : -1;
  const oi = overallAvg < 0 ? -1 : overallAvg < 0.5 ? 0 : overallAvg < 1.5 ? 1 : 2;

  return (
    <div className="min-h-screen bg-[#f0f2f5]">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold text-zinc-800">건강 모니터링</h1>
        <Link href="/chat" className="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">대화로 돌아가기</Link>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-6">
        {/* 요약 카드 */}
        <div className="mb-6 grid grid-cols-3 gap-3">
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs text-zinc-500">인지 종합</p>
            <p className={`text-xl font-bold ${oi < 0 ? "text-zinc-400" : SCORE_TEXT[oi]}`}>{oi < 0 ? "미평가" : SCORE_LABELS[oi]}</p>
            {overallAvg >= 0 && <p className="text-xs text-zinc-400">{overallAvg.toFixed(1)} / 2.0</p>}
          </div>
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs text-zinc-500">총 평가</p>
            <p className="text-xl font-bold text-zinc-800">{totalChecks}회</p>
          </div>
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs text-zinc-500">이상 징후 (7일)</p>
            <p className={`text-xl font-bold ${(summary?.recentAnomaly ?? 0) > 0 ? "text-red-600" : "text-green-600"}`}>{summary?.recentAnomaly ?? 0}건</p>
          </div>
        </div>

        {/* 영역별 점수 */}
        {cognitive && (
          <div className="mb-6 rounded-xl bg-white p-4 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-zinc-700">영역별 인지 점수</h2>
            <div className="space-y-3">
              {Object.keys(DOMAIN_LABELS).map((domain) => {
                const item = cognitive.domainAverages.find((d) => d.domain === domain);
                const avg = item?.avg_score ?? -1;
                const ci = avg < 0 ? -1 : avg < 0.5 ? 0 : avg < 1.5 ? 1 : 2;
                return (
                  <div key={domain}>
                    <div className="mb-1 flex justify-between">
                      <span className="text-sm text-zinc-700">{DOMAIN_LABELS[domain]}</span>
                      <span className={`text-xs font-medium ${ci < 0 ? "text-zinc-400" : SCORE_TEXT[ci]}`}>
                        {ci < 0 ? "미평가" : `${avg.toFixed(1)} (${item!.count}회)`}
                      </span>
                    </div>
                    <div className="h-3 rounded-full bg-zinc-100">
                      {ci >= 0 && <div className={`h-full rounded-full ${SCORE_COLORS[ci]}`} style={{ width: `${Math.max(5, (avg / 2) * 100)}%` }} />}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-3 text-xs text-zinc-400">0.0=정상 | 1.0=경계 | 2.0=주의</p>
          </div>
        )}

        {/* 14일 추세 */}
        {cognitive && cognitive.dailyTrend.length > 0 && (
          <div className="mb-6 rounded-xl bg-white p-4 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-zinc-700">최근 14일 추세</h2>
            <div className="flex items-end gap-1" style={{ height: 120 }}>
              {cognitive.dailyTrend.map((d) => {
                const ci = d.avg_score < 0.5 ? 0 : d.avg_score < 1.5 ? 1 : 2;
                return (
                  <div key={d.session_date} className="flex flex-1 flex-col items-center gap-1">
                    <span className="text-[10px] text-zinc-400">{d.avg_score.toFixed(1)}</span>
                    <div className="flex w-full flex-1 items-end justify-center">
                      <div className={`w-full max-w-[28px] rounded-t ${SCORE_COLORS[ci]}`} style={{ height: `${Math.max(8, (d.avg_score / 2) * 100)}%` }} />
                    </div>
                    <span className="text-[10px] text-zinc-400">{formatShortDate(d.session_date)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 최근 기록 */}
        <div className="rounded-xl bg-white shadow-sm">
          <h2 className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold text-zinc-700">최근 인지 평가 기록</h2>
          {(!cognitive || cognitive.assessments.length === 0) ? (
            <p className="px-4 py-8 text-center text-zinc-400">아직 기록이 없습니다. 대화를 통해 자동으로 수집됩니다.</p>
          ) : (
            <ul className="divide-y divide-zinc-100">
              {cognitive.assessments.map((a, i) => {
                const si = Math.min(2, Math.max(0, a.score));
                return (
                  <li key={`${a.domain}-${i}`} className="px-4 py-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <span className="text-sm font-medium text-zinc-700">{DOMAIN_LABELS[a.domain] ?? a.domain}</span>
                        <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${si === 0 ? "bg-green-100 text-green-700" : si === 1 ? "bg-yellow-100 text-yellow-700" : "bg-red-100 text-red-700"}`}>
                          {SCORE_LABELS[si]}
                        </span>
                        {a.evidence && <p className="mt-1 text-sm text-zinc-600">&ldquo;{a.evidence}&rdquo;</p>}
                        {a.note && <p className="mt-0.5 text-xs text-zinc-400">{a.note}</p>}
                      </div>
                      <span className="ml-3 shrink-0 text-xs text-zinc-400">{a.session_date}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
