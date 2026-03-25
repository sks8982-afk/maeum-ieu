"use client";

import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import Link from "next/link";

// ─── 타입 ──────────────────────────────────────────────────────────────────

interface HealthLogEntry {
  id: string;
  type: string;
  value: string | null;
  note: string | null;
  createdAt: string;
}

interface Summary {
  total: number;
  cognitiveCount: number;
  recentCognitive: number;
  byType: { type: string; count: number }[];
}

interface CognitiveAssessment {
  domain: string;
  score: number;
  confidence: number;
  evidence: string | null;
  note: string | null;
  session_date: string;
  created_at: string;
}

interface DomainAvg {
  domain: string;
  avg_score: number;
  count: number;
}

interface DailyTrend {
  session_date: string;
  avg_score: number;
  check_count: number;
}

interface CognitiveData {
  assessments: CognitiveAssessment[];
  domainAverages: DomainAvg[];
  dailyTrend: DailyTrend[];
}

// ─── 상수 ──────────────────────────────────────────────────────────────────

const DOMAIN_LABELS: Record<string, string> = {
  orientation_time: "시간 지남력",
  orientation_place: "장소 지남력",
  memory_immediate: "즉시 기억력",
  memory_delayed: "지연 기억력",
  language: "언어 유창성",
  judgment: "판단력",
};

const SCORE_LABELS = ["정상", "경계", "주의"];
const SCORE_COLORS = ["bg-green-500", "bg-yellow-500", "bg-red-500"];
const SCORE_TEXT_COLORS = ["text-green-600", "text-yellow-600", "text-red-600"];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00+09:00");
  return d.toLocaleDateString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
  });
}

// ─── 컴포넌트 ──────────────────────────────────────────────────────────────

/** 영역별 평균 점수 바 차트 */
function DomainScoreChart({ data }: { data: DomainAvg[] }) {
  const allDomains = Object.keys(DOMAIN_LABELS);

  return (
    <div className="space-y-3">
      {allDomains.map((domain) => {
        const item = data.find((d) => d.domain === domain);
        const avg = item?.avg_score ?? -1;
        const count = item?.count ?? 0;
        const noData = avg < 0;
        const barWidth = noData ? 0 : Math.max(5, (avg / 2) * 100);
        const colorIdx = noData ? 0 : avg < 0.5 ? 0 : avg < 1.5 ? 1 : 2;

        return (
          <div key={domain}>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm text-zinc-700">{DOMAIN_LABELS[domain]}</span>
              <span className={`text-xs font-medium ${noData ? "text-zinc-400" : SCORE_TEXT_COLORS[colorIdx]}`}>
                {noData ? "미평가" : `${avg.toFixed(1)} / 2.0 (${count}회)`}
              </span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-zinc-100">
              {!noData && (
                <div
                  className={`h-full rounded-full transition-all ${SCORE_COLORS[colorIdx]}`}
                  style={{ width: `${barWidth}%` }}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 14일 추세 차트 (CSS 기반 심플 바 차트) */
function TrendChart({ data }: { data: DailyTrend[] }) {
  if (data.length === 0) {
    return <p className="py-6 text-center text-sm text-zinc-400">추세 데이터가 아직 없습니다.</p>;
  }

  const maxScore = 2;

  return (
    <div className="flex items-end gap-1" style={{ height: 120 }}>
      {data.map((day) => {
        const height = Math.max(8, (day.avg_score / maxScore) * 100);
        const colorIdx = day.avg_score < 0.5 ? 0 : day.avg_score < 1.5 ? 1 : 2;

        return (
          <div key={day.session_date} className="flex flex-1 flex-col items-center gap-1">
            <span className="text-[10px] text-zinc-400">{day.avg_score.toFixed(1)}</span>
            <div className="flex w-full flex-1 items-end justify-center">
              <div
                className={`w-full max-w-[28px] rounded-t ${SCORE_COLORS[colorIdx]}`}
                style={{ height: `${height}%` }}
                title={`${day.session_date}: 평균 ${day.avg_score.toFixed(1)} (${day.check_count}건)`}
              />
            </div>
            <span className="text-[10px] text-zinc-400">{formatShortDate(day.session_date)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 최근 인지 평가 기록 리스트 */
function AssessmentList({ data }: { data: CognitiveAssessment[] }) {
  if (data.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-zinc-400">
        아직 인지 평가 기록이 없습니다. 대화를 통해 자동으로 수집됩니다.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-zinc-100">
      {data.map((item, i) => {
        const scoreIdx = Math.min(2, Math.max(0, item.score));
        return (
          <li key={`${item.domain}-${item.created_at}-${i}`} className="px-4 py-3">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-zinc-700">
                    {DOMAIN_LABELS[item.domain] ?? item.domain}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      scoreIdx === 0
                        ? "bg-green-100 text-green-700"
                        : scoreIdx === 1
                          ? "bg-yellow-100 text-yellow-700"
                          : "bg-red-100 text-red-700"
                    }`}
                  >
                    {SCORE_LABELS[scoreIdx]}
                  </span>
                  <span className="text-xs text-zinc-400">
                    확신도 {Math.round(item.confidence * 100)}%
                  </span>
                </div>
                {item.evidence && (
                  <p className="mt-1 text-sm text-zinc-600">
                    &ldquo;{item.evidence}&rdquo;
                  </p>
                )}
                {item.note && (
                  <p className="mt-0.5 text-xs text-zinc-400">{item.note}</p>
                )}
              </div>
              <span className="ml-3 shrink-0 text-xs text-zinc-400">
                {item.session_date}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ─── 메인 페이지 ───────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { status } = useSession();
  const [logs, setLogs] = useState<HealthLogEntry[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [cognitive, setCognitive] = useState<CognitiveData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"cognitive" | "healthlog">("cognitive");

  useEffect(() => {
    if (status !== "authenticated") return;

    (async () => {
      try {
        const res = await fetch("/api/health-logs");
        if (!res.ok) return;
        const data = await res.json();
        setLogs(data.logs ?? []);
        setSummary(data.summary ?? null);
        setCognitive(data.cognitive ?? null);
      } catch (e) {
        console.error("Failed to load dashboard:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [status]);

  if (status === "loading" || loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#f0f2f5]">
        <p className="text-zinc-500">로딩 중...</p>
      </div>
    );
  }

  const totalAssessments = cognitive?.domainAverages.reduce((s, d) => s + d.count, 0) ?? 0;
  const overallAvg = totalAssessments > 0
    ? cognitive!.domainAverages.reduce((s, d) => s + d.avg_score * d.count, 0) / totalAssessments
    : -1;
  const overallLabel = overallAvg < 0 ? "미평가" : overallAvg < 0.5 ? "정상" : overallAvg < 1.5 ? "경계" : "주의";
  const overallColorIdx = overallAvg < 0 ? -1 : overallAvg < 0.5 ? 0 : overallAvg < 1.5 ? 1 : 2;

  return (
    <div className="min-h-screen bg-[#f0f2f5]">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold text-zinc-800">건강 모니터링</h1>
        <Link
          href="/chat"
          className="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100"
        >
          대화로 돌아가기
        </Link>
      </header>

      <div className="mx-auto max-w-3xl px-4 py-6">
        {/* 요약 카드 */}
        <div className="mb-6 grid grid-cols-3 gap-3">
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs text-zinc-500">인지 종합</p>
            <p className={`text-xl font-bold ${overallColorIdx < 0 ? "text-zinc-400" : SCORE_TEXT_COLORS[overallColorIdx]}`}>
              {overallLabel}
            </p>
            {overallAvg >= 0 && (
              <p className="text-xs text-zinc-400">{overallAvg.toFixed(1)} / 2.0</p>
            )}
          </div>
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs text-zinc-500">총 평가 횟수</p>
            <p className="text-xl font-bold text-zinc-800">{totalAssessments}</p>
            <p className="text-xs text-zinc-400">
              {cognitive?.domainAverages.length ?? 0}개 영역
            </p>
          </div>
          <div className="rounded-xl bg-white p-4 shadow-sm">
            <p className="text-xs text-zinc-500">이상 징후</p>
            <p className={`text-xl font-bold ${(summary?.recentCognitive ?? 0) > 0 ? "text-red-600" : "text-green-600"}`}>
              {summary?.recentCognitive ?? 0}건
            </p>
            <p className="text-xs text-zinc-400">최근 7일</p>
          </div>
        </div>

        {/* 영역별 점수 */}
        {cognitive && (
          <div className="mb-6 rounded-xl bg-white p-4 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-zinc-700">영역별 인지 점수</h2>
            <DomainScoreChart data={cognitive.domainAverages} />
            <p className="mt-3 text-xs text-zinc-400">
              0.0 = 정상 | 1.0 = 경계 | 2.0 = 주의 (낮을수록 좋음)
            </p>
          </div>
        )}

        {/* 14일 추세 */}
        {cognitive && (
          <div className="mb-6 rounded-xl bg-white p-4 shadow-sm">
            <h2 className="mb-4 text-sm font-semibold text-zinc-700">최근 14일 추세</h2>
            <TrendChart data={cognitive.dailyTrend} />
          </div>
        )}

        {/* 탭: 인지 평가 기록 / 기존 건강 기록 */}
        <div className="mb-4 flex gap-2">
          <button
            type="button"
            onClick={() => setTab("cognitive")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              tab === "cognitive"
                ? "bg-zinc-800 text-white"
                : "bg-white text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            인지 평가 기록
          </button>
          <button
            type="button"
            onClick={() => setTab("healthlog")}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              tab === "healthlog"
                ? "bg-zinc-800 text-white"
                : "bg-white text-zinc-600 hover:bg-zinc-100"
            }`}
          >
            건강 기록
          </button>
        </div>

        <div className="rounded-xl bg-white shadow-sm">
          {tab === "cognitive" ? (
            <>
              <h2 className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold text-zinc-700">
                최근 인지 평가 (최대 50건)
              </h2>
              <AssessmentList data={cognitive?.assessments ?? []} />
            </>
          ) : (
            <>
              <h2 className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold text-zinc-700">
                건강 기록 (최대 50건)
              </h2>
              {logs.length === 0 ? (
                <p className="px-4 py-8 text-center text-zinc-400">
                  아직 기록이 없습니다.
                </p>
              ) : (
                <ul className="divide-y divide-zinc-100">
                  {logs.map((log) => (
                    <li key={log.id} className="px-4 py-3">
                      <div className="flex items-start justify-between">
                        <div className="flex-1">
                          <span
                            className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                              log.type === "cognitive"
                                ? "bg-orange-100 text-orange-700"
                                : "bg-zinc-100 text-zinc-600"
                            }`}
                          >
                            {log.type}
                          </span>
                          {log.value && <span className="ml-2 text-sm text-zinc-700">{log.value}</span>}
                          {log.note && <p className="mt-1 text-sm text-zinc-500">{log.note}</p>}
                        </div>
                        <span className="ml-3 shrink-0 text-xs text-zinc-400">
                          {formatDate(log.createdAt)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
