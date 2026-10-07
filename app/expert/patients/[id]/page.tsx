"use client";

/**
 * 전문가용 환자 상세 리포트 — 영역별 7일/30일 비교, 8주 추이, 이상 이벤트(분석기 임상 근거).
 * 대화 원문은 표시하지 않음(프라이버시 기본값).
 */
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useState } from "react";
import { ThemeToggle } from "../../../theme-toggle";
import { LogoutButton } from "../../../LogoutButton";

interface DomainRow { domain: string; label: string; recentAvg: number | null; recentCount: number; baselineAvg: number | null; baselineCount: number }
interface WeekRow { weekStart: string; avg: number; count: number }
interface EventRow { date: string; domain: string; score: number; note: string | null; evidence: string | null }
interface Detail {
  viewerRole?: "pro" | "guardian";
  patient: { name: string; age: number | null; gender: string | null };
  overallAvg: number | null; tier: string; tierText: string;
  reliability?: { reliable: boolean; provisional: boolean; showLevel: boolean };
  trend: string; trendText: string; trendDelta: number;
  domains: DomainRow[]; weekly: WeekRow[]; events: EventRow[];
  emergencies?: { level: number; category: string; at: string; notified: boolean; utterance: string }[];
  sessions?: { date: string; overallAvg: number | null; tier: string; count: number; domains: { label: string; avg: number }[] }[];
  medication?: { items: { id: string; label: string; times: string[]; enabled: boolean }[]; todayConfirmed: string[]; weekCompliance: { confirmed: number; expected: number } };
  cistEstimate?: { earned: number; max: number; assessedDomains: number } | null;
  examDisclaimer?: string;
  examSessions?: ExamSession[];
  examTrend?: { direction: string; label: string; detail: string } | null;
  examTrendPoints?: { round: number; date: string; score: number; max: number; band: string | null }[];
  // 보호자(guardian) 요약 전용 — 상세(domains/weekly/events/examSessions)는 서버가 보내지 않음
  statusLine?: string; needsCare?: boolean; advice?: string;
  emergency?: { count: number; lastAt: string | null; notifiedCount: number };
  /** 구독 미보유로 요약 지표가 가려진 상태(위급 이력은 그대로 제공됨) */
  locked?: boolean;
}
interface ExamSession {
  id: string; startedAt: string; endedAt: string | null; doctorComment: string;
  totalScore: number | null; maxScore: number | null;
  coverage: { answered: number; total: number; sufficient: boolean };
  evalBand: string | null; evalLabel: string | null; evalAdvice: string | null;
  educationYears: number | null; visuospatialScore: number | null;
  formalBand: string | null; formalLabel: string | null; formalAdvice: string | null; formalScore: number | null; formalMax: number | null;
  items: { itemId: string; label: string; domain: string; prompt: string; answer: string; score: number; max: number; reason: string }[];
  qa: { role: string; content: string; at: string }[];
  trend: null | { direction: string; deltaPct: number };
}

const BAND_STYLE: Record<string, string> = {
  "정상범위": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  "경계": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  "저하의심": "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  "자료부족": "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300",
};
const TREND_STYLE: Record<string, string> = {
  "개선": "text-emerald-600 dark:text-emerald-400",
  "악화": "text-red-600 dark:text-red-400",
  "유지": "text-zinc-500 dark:text-zinc-400",
};

/** 도움말 아이콘 — 마우스 hover 시 설명(title) 표시. */
function Help({ text }: { text: string }) {
  return (
    <span title={text} className="ml-0.5 inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full bg-zinc-300 align-middle text-[9px] font-bold text-white dark:bg-zinc-600" aria-label={text}>?</span>
  );
}

const TIER_STYLE: Record<string, string> = {
  "정상": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  "경증": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  "중증": "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  "고위험": "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  "평가전": "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};
const scoreColor = (v: number | null) => v === null ? "bg-zinc-200 dark:bg-zinc-700" : v >= 1.5 ? "bg-red-400" : v >= 0.8 ? "bg-orange-400" : v >= 0.3 ? "bg-amber-400" : "bg-emerald-400";

/** 보호자(guardian) 요약 뷰 — 결과 문구 + 위급 여부 + 복약 이행률만. 문항·점수·근거 등 상세는 담지 않는다. */
function GuardianSummary({ d }: { d: Detail }) {
  const care = !!d.needsCare;
  const fmt = (s: string | null | undefined) => s ? new Date(s).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  const comp = d.medication?.weekCompliance;
  const compPct = comp && comp.expected > 0 ? Math.round((comp.confirmed / comp.expected) * 100) : null;
  return (
    <>
      {/* 핵심 상태 — 크게 */}
      <section className={`mb-5 rounded-2xl border p-6 ${care ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-900/20" : "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-900/20"}`}>
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold text-zinc-900 dark:text-zinc-100">{d.patient.name}</span>
          <span className="text-sm text-zinc-500">{d.patient.age ? `${d.patient.age}세` : ""} {d.patient.gender === "male" ? "남" : d.patient.gender === "female" ? "여" : ""}</span>
          <span className={`ml-auto rounded-full px-3 py-1 text-sm font-bold ${care ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200" : "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"}`}>{care ? "🩺 진료 권장" : "양호"}</span>
        </div>
        <p className={`mt-4 text-lg font-bold leading-relaxed ${care ? "text-red-800 dark:text-red-200" : "text-zinc-800 dark:text-zinc-100"}`}>{d.statusLine}</p>
        {d.locked && (
          // 구독 필요 — 위급 알림은 아래에서 계속 제공되므로 "안전은 그대로"임을 분명히 밝힌다
          <div className="mt-3 rounded-lg bg-white/80 px-3 py-3 text-sm dark:bg-zinc-900/60">
            <p className="text-zinc-700 dark:text-zinc-200">상태 요약·추세·복약 이행률은 구독 후 볼 수 있어요.</p>
            <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">위급 알림은 구독과 무관하게 계속 받습니다.</p>
            <Link href="/subscribe" className="mt-2 inline-block rounded-full bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">
              구독 알아보기
            </Link>
          </div>
        )}
        {d.advice && <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{d.advice}</p>}
        {d.trend && d.trend !== "자료부족" && d.trendText && (
          <p className="mt-3 rounded-lg bg-white/70 px-3 py-2 text-sm text-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-200">{d.trendText}</p>
        )}
      </section>

      {/* 위급 이력 */}
      <section className="mb-5 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">🚨 위급 감지 이력</h2>
        {d.emergency && d.emergency.count > 0 ? (
          <p className="text-sm text-zinc-700 dark:text-zinc-200">
            지금까지 <b className="text-red-600 dark:text-red-400">{d.emergency.count}건</b>의 위급 징후가 감지되었어요.
            {d.emergency.lastAt && <> 가장 최근은 <b>{fmt(d.emergency.lastAt)}</b>입니다.</>}
            {/* "보호자에게 발송되었습니다"는 받은 것처럼 읽혔다 — 앱 알림은 FCM이 받아들인 것까지만 안다(기기 수신은 모름) */}
            {d.emergency.notifiedCount > 0 && <> 이 중 {d.emergency.notifiedCount}건은 알림을 보냈어요(앱·이메일·메신저 중 한 곳 이상).</>}
          </p>
        ) : (
          <p className="text-sm text-zinc-500">감지된 위급 징후가 없습니다.</p>
        )}
      </section>

      {/* 복약 이행 */}
      {compPct !== null && (
        <section className="mb-5 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">💊 최근 7일 복약 이행</h2>
          <div className="flex items-center gap-3">
            <div className="h-3 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
              <div className={`h-full ${compPct >= 80 ? "bg-emerald-400" : compPct >= 50 ? "bg-amber-400" : "bg-red-400"}`} style={{ width: `${compPct}%` }} />
            </div>
            <span className="text-sm font-bold text-zinc-700 dark:text-zinc-200">{compPct}%</span>
          </div>
          <p className="mt-1 text-xs text-zinc-400">{comp!.confirmed}회 복용 확인 / 예정 {comp!.expected}회</p>
        </section>
      )}

      <p className="rounded-xl bg-zinc-100 px-4 py-3 text-xs leading-relaxed text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
        질문 내역·문항별 점수·평가 기준 등 상세 평가내역은 담당 <b>의사</b>만 열람할 수 있어요. 보호자에게는 결과 요약과 위급 알림만 제공됩니다.
        어르신 본인에게는 결과가 보이지 않으며, 일상 대화 내용도 공개되지 않습니다.
      </p>
    </>
  );
}

export default function PatientDetailPage() {
  const { status } = useSession();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});
  const [savedComment, setSavedComment] = useState<string | null>(null);
  const [tab, setTab] = useState<"exam" | "daily">("exam");
  const [evalDrafts, setEvalDrafts] = useState<Record<string, { edu: string; vs: string }>>({});

  async function reload() {
    if (!params?.id) return;
    try { const r = await fetch(`/api/expert/patients/${params.id}`); const d = await r.json(); if (r.ok) setData(d); } catch { /* noop */ }
  }

  async function saveComment(sessionId: string, comment: string) {
    try {
      const r = await fetch("/api/expert/exam", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "comment", sessionId, comment }) });
      if (r.ok) { setSavedComment(sessionId); setTimeout(() => setSavedComment(null), 2000); }
    } catch { /* noop */ }
  }

  async function saveEvalInput(sessionId: string, edu: string, vs: string) {
    try {
      const r = await fetch("/api/expert/exam", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "evalInput", sessionId, educationYears: edu === "" ? null : Number(edu), visuospatialScore: vs === "" ? null : Number(vs) }) });
      if (r.ok) await reload();
    } catch { /* noop */ }
  }

  useEffect(() => {
    if (status === "unauthenticated") { router.replace("/login"); return; }
    if (status !== "authenticated" || !params?.id) return;
    fetch(`/api/expert/patients/${params.id}`)
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) { setError(d.error ?? "불러오지 못했습니다."); return; }
        setData(d);
      })
      .catch(() => setError("불러오지 못했습니다. 새로고침해 주세요."));
  }, [status, params, router]);

  const maxWeekly = data && Array.isArray(data.weekly) ? Math.max(0.5, ...data.weekly.map((w) => w.avg)) : 1;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{data?.viewerRole === "guardian" ? "👨‍👩‍👧 상태 요약" : "🩺 환자 리포트"}</h1>
          <div className="flex items-center gap-3">
            {params?.id && data?.viewerRole !== "guardian" && (
              <Link href={`/chat?patient=${params.id}`} className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700">
                🩺 검사 시작
              </Link>
            )}
            <ThemeToggle />
            <Link href="/expert" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">← {data?.viewerRole === "guardian" ? "목록" : "환자 목록"}</Link>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</p>}
        {!error && !data && <p className="text-sm text-zinc-500">불러오는 중…</p>}
        {data && data.viewerRole === "guardian" && <GuardianSummary d={data} />}
        {data && data.viewerRole !== "guardian" && (
          <>
            <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xl font-bold text-zinc-900 dark:text-zinc-100">{data.patient.name}</span>
                <span className="text-sm text-zinc-500">{data.patient.age ? `${data.patient.age}세` : ""} {data.patient.gender === "male" ? "남" : data.patient.gender === "female" ? "여" : ""}</span>
                {(() => {
                  const latest = data.examSessions?.find((e) => e.totalScore != null);
                  const label = latest?.formalLabel ?? latest?.evalLabel;
                  return label
                    ? <span className={`rounded-full px-3 py-1 text-sm font-bold ${BAND_STYLE[(latest!.formalLabel ? latest!.formalBand : latest!.evalBand) ?? "자료부족"] ?? BAND_STYLE["자료부족"]}`}>검진: {label}{latest!.totalScore != null && latest!.coverage.sufficient ? ` · ${latest!.totalScore}/${latest!.maxScore}점` : ""}</span>
                    : <span className={`rounded-full px-3 py-1 text-sm font-bold ${TIER_STYLE["평가전"]}`}>검진 기록 없음</span>;
                })()}
                <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                  일상 모니터링: {data.reliability && !data.reliability.showLevel ? "자료 수집중" : `${data.tier}${data.reliability?.provisional ? "(잠정)" : ""}`}
                </span>
              </div>
              <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">정식 검진(전문가 문진)이 1차 평가이고, 일상 대화 분석은 참고용 보조 신호입니다.</p>
            </section>

            {/* 탭 — 정식 검진(1차 신호) / 일상대화 참고(보조) */}
            <div className="mb-5 flex gap-2 border-b border-zinc-200 dark:border-zinc-800">
              {([["exam", "정식 검진"], ["daily", "일상대화 참고"]] as const).map(([k, l]) => (
                <button key={k} onClick={() => setTab(k)}
                  className={`-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${tab === k ? "border-teal-500 text-teal-600 dark:text-teal-400" : "border-transparent text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"}`}>{l}</button>
              ))}
            </div>

            {tab === "exam" && (
              <section className="mb-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">정식 검진 결과 (회차별)</h2>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-zinc-400">최근 {data.examSessions?.length ?? 0}회</span>
                    {data.examSessions && data.examSessions.length > 0 && (
                      <a href={`/expert/patients/${params.id}/report`} target="_blank" rel="noreferrer" className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs font-semibold text-zinc-600 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800">🖨 검진 결과지</a>
                    )}
                  </div>
                </div>
                {/* 회차 추세 — 다회차 그래프 + 해석 */}
                {data.examTrend && data.examTrendPoints && data.examTrendPoints.length >= 2 && (
                  <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                    <div className="mb-2 flex items-center gap-2">
                      <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">회차 추세</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${data.examTrend.direction === "개선" ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200" : data.examTrend.direction === "악화" ? "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200" : data.examTrend.direction === "변동" ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200" : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"}`}>{data.examTrend.label}</span>
                    </div>
                    <div className="flex items-end gap-2 border-b border-zinc-100 pb-2 dark:border-zinc-800" style={{ height: 88 }}>
                      {data.examTrendPoints.map((p) => {
                        const h = Math.max(6, Math.round((p.score / (p.max || 29)) * 72));
                        const col = p.band === "정상범위" ? "bg-emerald-400" : p.band === "경계" ? "bg-amber-400" : p.band === "저하의심" ? "bg-red-400" : "bg-zinc-300";
                        return (
                          <div key={p.round} className="flex flex-1 flex-col items-center justify-end gap-1" title={`${p.round}회차 ${p.date} · ${p.score}/${p.max}`}>
                            <span className="text-[10px] text-zinc-500">{p.score}</span>
                            <div className={`w-full rounded-t ${col}`} style={{ height: h }} />
                            <span className="text-[10px] text-zinc-400">{p.round}회</span>
                          </div>
                        );
                      })}
                    </div>
                    <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">{data.examTrend.detail}</p>
                  </div>
                )}
                {(!data.examSessions || data.examSessions.length === 0) && (
                  <p className="rounded-xl bg-zinc-50 px-4 py-6 text-center text-sm text-zinc-400 dark:bg-zinc-800/40">아직 검진 기록이 없습니다. 전문가 모드에서 ‘검진 시작’으로 시행하세요.</p>
                )}
                {data.examSessions?.map((ex, i) => {
                  const round = (data.examSessions!.length) - i;
                  const draft = evalDrafts[ex.id] ?? { edu: ex.educationYears != null ? String(ex.educationYears) : "", vs: ex.visuospatialScore != null ? String(ex.visuospatialScore) : "" };
                  return (
                    <div key={ex.id} className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-100 pb-2 dark:border-zinc-800">
                        <span className="rounded bg-teal-50 px-2 py-0.5 text-xs font-bold text-teal-700 dark:bg-teal-900/40 dark:text-teal-200">{round}회차</span>
                        <span className="text-xs font-semibold text-zinc-600 dark:text-zinc-300">{new Date(ex.startedAt).toLocaleString("ko-KR")}</span>
                        {ex.evalLabel && <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${BAND_STYLE[ex.evalBand ?? "자료부족"] ?? BAND_STYLE["자료부족"]}`}>{ex.evalLabel}</span>}
                        {ex.totalScore != null && ex.coverage.sufficient && <span className="text-xs font-bold text-zinc-700 dark:text-zinc-200">{ex.totalScore}/{ex.maxScore}점</span>}
                        {ex.trend && <span className={`text-xs font-semibold ${TREND_STYLE[ex.trend.direction] ?? ""}`}>이전 대비 {ex.trend.direction}{ex.trend.deltaPct ? ` (${ex.trend.deltaPct > 0 ? "+" : ""}${ex.trend.deltaPct}%p)` : ""}</span>}
                        {!ex.endedAt && <span className="text-[11px] text-amber-600">진행 중</span>}
                      </div>
                      {ex.evalAdvice && <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-300">{ex.evalAdvice}</p>}
                      {!ex.coverage.sufficient && ex.endedAt && (
                        <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">무응답이 많아 평가가 어렵습니다(응답 {ex.coverage.answered}/{ex.coverage.total}영역). 추가 문진을 권장합니다.</p>
                      )}
                      <div className="mt-3 rounded-xl bg-zinc-50 px-3 py-2.5 dark:bg-zinc-800/50">
                        <p className="mb-1.5 text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">의사 보정 — 학력·시계 그리기를 입력하면 학력보정 잠정 평가로 승급</p>
                        <div className="flex flex-wrap items-center gap-2">
                          <label className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            학력(년)<Help text="환자가 학교를 다닌 햇수(교육 연수)예요. 인지검사 점수는 학력 영향이 커서, 못 배우신 분은 치매가 아니어도 낮게 나옵니다. 저학력일수록 점수를 조금 후하게 보정해 과잉 '저하의심'(위양성)을 줄입니다. 예: 무학 0 · 초졸 6 · 중졸 9 · 고졸 12"/>
                            <input type="number" min={0} max={30} value={draft.edu} onChange={(e) => setEvalDrafts((p) => ({ ...p, [ex.id]: { ...draft, edu: e.target.value } }))} className="ml-1 w-16 rounded border border-zinc-200 px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-800" />
                          </label>
                          <label className="text-[11px] text-zinc-500 dark:text-zinc-400">
                            시계 그리기<Help text="종이에 동그란 시계를 그리고 '11시 10분'을 표시하게 하는 검사(0~2점)예요. 그림 검사라 음성으로는 못 해서 음성 검진(29점)에는 빠져 있습니다. 의사가 직접 종이로 시행한 점수를 입력하면 시공간 능력까지 포함한 더 정확한 평가(31점 기준)가 됩니다."/>
                            <select value={draft.vs} onChange={(e) => setEvalDrafts((p) => ({ ...p, [ex.id]: { ...draft, vs: e.target.value } }))} className="ml-1 rounded border border-zinc-200 px-1.5 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-800">
                              <option value="">미입력</option><option value="0">0점</option><option value="1">1점</option><option value="2">2점</option>
                            </select>
                          </label>
                          <button onClick={() => saveEvalInput(ex.id, draft.edu, draft.vs)} className="rounded bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-teal-700">저장</button>
                          {ex.formalLabel && <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${BAND_STYLE[ex.formalBand ?? ex.evalBand ?? "자료부족"] ?? BAND_STYLE["자료부족"]}`}>{ex.formalLabel}{ex.formalScore != null ? ` · ${ex.formalScore}/${ex.formalMax}점` : ""}</span>}
                        </div>
                      </div>
                      {ex.items.length > 0 && (
                        <div className="mt-3">
                          <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                            <p className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">항목별 채점</p>
                            {/* 색상 범례 */}
                            <span className="flex flex-wrap items-center gap-2 text-[10px] text-zinc-400">
                              <span className="flex items-center gap-0.5"><span className="inline-block h-2 w-2 rounded-sm bg-emerald-400" />만점</span>
                              <span className="flex items-center gap-0.5"><span className="inline-block h-2 w-2 rounded-sm bg-amber-400" />부분정답</span>
                              <span className="flex items-center gap-0.5"><span className="inline-block h-2 w-2 rounded-sm bg-red-400" />0점(오답)</span>
                              <span className="flex items-center gap-0.5"><span className="inline-block h-2 w-2 rounded-sm bg-zinc-300" />무응답</span>
                            </span>
                          </div>
                          <div className="flex flex-wrap gap-1">
                            {ex.items.map((it) => (
                              <span key={it.itemId} title={`${it.prompt} → ${it.answer || "(무응답)"} · ${it.score}/${it.max}점${it.reason ? " · " + it.reason : ""}`} className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${it.reason === "무응답" ? "bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500" : it.max > 0 && it.score >= it.max ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-200" : it.score > 0 ? "bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-200" : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-200"}`}>{it.label} {it.score}/{it.max}</span>
                            ))}
                          </div>
                        </div>
                      )}
                      <details className="mt-3">
                        <summary className="cursor-pointer text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">문답 기록 ({ex.qa.length})</summary>
                        <div className="mt-1.5 max-h-60 space-y-1.5 overflow-y-auto">
                          {ex.qa.length === 0 && <p className="text-xs text-zinc-400">기록된 문답이 없습니다.</p>}
                          {ex.qa.map((m, j) => (
                            <div key={j} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                              <div className={`max-w-[85%] rounded-xl px-3 py-1.5 text-xs ${m.role === "user" ? "bg-blue-50 text-blue-900 dark:bg-blue-900/30 dark:text-blue-100" : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"}`}>
                                <span className="mr-1 text-[10px] font-semibold opacity-60">{m.role === "user" ? "환자" : "AI"}</span>{m.content}
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>
                      <div className="mt-3 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                        <textarea value={commentDrafts[ex.id] ?? ex.doctorComment} onChange={(e) => setCommentDrafts((p) => ({ ...p, [ex.id]: e.target.value }))} placeholder="의사 소견·코멘트 (환자 일지)" rows={2} className="w-full rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-800" />
                        <div className="mt-1 flex items-center justify-end gap-2">
                          {savedComment === ex.id && <span className="text-[11px] text-emerald-600">저장됨</span>}
                          <button onClick={() => saveComment(ex.id, commentDrafts[ex.id] ?? ex.doctorComment)} className="rounded bg-zinc-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-zinc-800 dark:bg-zinc-600">코멘트 저장</button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {data.examDisclaimer && <p className="text-[11px] leading-relaxed text-zinc-400">{data.examDisclaimer}</p>}
              </section>
            )}

            {tab === "daily" && (<>
            {data.cistEstimate && (
              <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
                <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                  MMSE-K 환산 추정 <span className="text-base">{data.cistEstimate.earned}</span><span className="text-zinc-500">/{data.cistEstimate.max}점</span>
                </p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">
                  음성 시행 {data.cistEstimate.assessedDomains}개 영역의 정성 평가(0정상~2저하) 기반 추정치 — <strong>시공간(그리기)은 음성 미시행</strong>이라 만점에서 제외. 정식 MMSE-K/CIST 점수가 아니라 참고용이에요.
                </p>
              </section>
            )}

            {data.medication && data.medication.items.length > 0 && (
              <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">복약 · 오늘</h2>
                  {data.medication.weekCompliance.expected > 0 && (() => {
                    const pct = Math.round((data.medication.weekCompliance.confirmed / data.medication.weekCompliance.expected) * 100);
                    const tone = pct >= 80 ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200" : pct >= 50 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200" : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200";
                    return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>이번 주 이행 {pct}%</span>;
                  })()}
                </div>
                <div className="grid gap-2">
                  {data.medication.items.map((m) => (
                    <div key={m.id} className={`rounded-xl px-3 py-2.5 ${m.enabled ? "bg-zinc-50 dark:bg-zinc-800/50" : "bg-zinc-50 opacity-60 dark:bg-zinc-800/30"}`}>
                      <div className="mb-1 text-sm font-medium text-zinc-800 dark:text-zinc-100">{m.label}{!m.enabled && <span className="ml-1 text-xs text-zinc-400">(알림 꺼짐)</span>}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {m.times.map((tm) => {
                          const done = data.medication!.todayConfirmed.includes(`${m.id}|${tm}`);
                          return (
                            <span key={tm} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${done ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200" : "bg-zinc-200 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400"}`}>
                              {done ? `✓ ${tm} 복용` : `${tm} 미확인`}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-zinc-400">어르신이 복용을 확인하면 ✓로 표시됩니다.</p>
              </section>
            )}

            <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-200">영역별 점수 — 최근 7일 vs 이전 30일 (0 정상 ~ 2 주의)</h2>
              <div className="grid gap-2">
                {data.domains.map((d) => (
                  <div key={d.domain} className="flex items-center gap-3 text-xs">
                    <span className="w-24 shrink-0 font-medium text-zinc-600 dark:text-zinc-300">{d.label}</span>
                    <div className="flex flex-1 flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <div className="h-2.5 flex-1 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                          <div className={`h-full ${scoreColor(d.recentAvg)}`} style={{ width: `${Math.min(100, ((d.recentAvg ?? 0) / 2) * 100)}%` }} />
                        </div>
                        <span className="w-20 shrink-0 text-zinc-500">7일 {d.recentAvg ?? "—"} ({d.recentCount})</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded bg-zinc-100 dark:bg-zinc-800">
                          <div className="h-full bg-zinc-400 dark:bg-zinc-500" style={{ width: `${Math.min(100, ((d.baselineAvg ?? 0) / 2) * 100)}%` }} />
                        </div>
                        <span className="w-20 shrink-0 text-zinc-400">30일 {d.baselineAvg ?? "—"} ({d.baselineCount})</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-3 text-sm font-semibold text-zinc-700 dark:text-zinc-200">주간 추이 (8주)</h2>
              {data.weekly.length === 0 && <p className="text-xs text-zinc-400">평가 데이터가 없습니다.</p>}
              <div className="flex h-24 items-end gap-2">
                {data.weekly.map((w) => (
                  <div key={w.weekStart} className="flex flex-1 flex-col items-center gap-1">
                    <div className={`w-full rounded-t ${scoreColor(w.avg)}`} style={{ height: `${Math.max(4, (w.avg / maxWeekly) * 80)}px` }} title={`${w.avg} (${w.count}건)`} />
                    <span className="text-[10px] text-zinc-400">{w.weekStart.slice(5)}</span>
                  </div>
                ))}
              </div>
            </section>

            {data.sessions && data.sessions.length > 0 && (
              <section className="mb-6 rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
                <h2 className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-200">회차별 분석 (검사일 기준 · 최근 12회)</h2>
                <p className="mb-3 text-[11px] text-zinc-400">검사일마다 한 회차로 묶어 종합 점수(0 정상 ~ 2 주의)와 직전 회차 대비 변화를 봅니다.</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-700">
                        <th className="py-1.5 pr-3 font-medium">검사일</th>
                        <th className="py-1.5 pr-3 font-medium">회차</th>
                        <th className="py-1.5 pr-3 font-medium">종합</th>
                        <th className="py-1.5 pr-3 font-medium">등급</th>
                        <th className="py-1.5 pr-3 font-medium">직전 대비</th>
                        <th className="py-1.5 font-medium">문항수</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sessions.map((s, i) => {
                        const round = data.sessions!.length - i; // 오래된 것이 1회차
                        const prev = data.sessions![i + 1]; // 더 오래된(직전) 회차
                        const delta = s.overallAvg !== null && prev?.overallAvg != null ? Number((s.overallAvg - prev.overallAvg).toFixed(2)) : null;
                        const deltaTxt = delta === null ? "—" : delta > 0.05 ? `▲ +${delta} 악화` : delta < -0.05 ? `▼ ${delta} 개선` : "= 비슷";
                        const deltaTone = delta === null ? "text-zinc-400" : delta > 0.05 ? "text-red-600 dark:text-red-300" : delta < -0.05 ? "text-green-600 dark:text-green-300" : "text-zinc-500";
                        return (
                          <tr key={s.date} className="border-b border-zinc-100 dark:border-zinc-800">
                            <td className="py-1.5 pr-3 text-zinc-700 dark:text-zinc-200">{s.date}</td>
                            <td className="py-1.5 pr-3 text-zinc-500">{round}회차</td>
                            <td className="py-1.5 pr-3 font-semibold text-zinc-800 dark:text-zinc-100">{s.overallAvg ?? "—"}</td>
                            <td className="py-1.5 pr-3"><span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${TIER_STYLE[s.tier] ?? TIER_STYLE["평가전"]}`}>{s.tier}</span></td>
                            <td className={`py-1.5 pr-3 font-medium ${deltaTone}`}>{deltaTxt}</td>
                            <td className="py-1.5 text-zinc-400">{s.count}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className="rounded-2xl border border-rose-200 bg-white p-5 dark:border-rose-900/50 dark:bg-zinc-900">
              <h2 className="mb-1 text-sm font-semibold text-rose-700 dark:text-rose-300">🚨 위급 알림 이력 (응급 감지 · 최대 20건)</h2>
              <p className="mb-3 text-[11px] text-zinc-400">응급(즉시·주의) 신호가 감지된 시각·발화·알림 발송 여부입니다. <b>일상 대화는 비공개</b>이며, 문제 있는 발화만 표시됩니다.</p>
              {(!data.emergencies || data.emergencies.length === 0) && <p className="text-xs text-zinc-400">위급 알림 이력이 없습니다.</p>}
              <div className="grid gap-2">
                {data.emergencies?.map((em, i) => (
                  <div key={i} className="rounded-xl border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-800/50">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-zinc-400">{new Date(em.at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                      <span className={`rounded px-1.5 py-0.5 font-bold ${em.level >= 3 ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200" : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200"}`}>{em.level >= 3 ? "즉시 응급" : "주의"}</span>
                      <span className="font-semibold text-zinc-700 dark:text-zinc-200">{em.category}</span>
                      <span className={`ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium ${em.notified ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-200" : "bg-zinc-200 text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400"}`}>{/* "보호자 알림 발송됨"은 틀릴 수 있었다 — 보호자 없이 의사만 연결돼 의사 앱으로만 나가도 이렇게 떴다(재검토) */}{em.notified ? "알림 보냄" : "알림 기록 없음"}</span>
                    </div>
                    {em.utterance && <p className="mt-1.5 rounded-lg bg-white px-2.5 py-1.5 text-[12px] leading-relaxed text-zinc-700 dark:bg-zinc-900 dark:text-zinc-200">“{em.utterance}”</p>}
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
              <h2 className="mb-1 text-sm font-semibold text-zinc-700 dark:text-zinc-200">최근 이상 이벤트 (분석기 기록 · 최대 20건)</h2>
              <p className="mb-3 text-[11px] text-zinc-400">분석 근거 요약만 표시됩니다 — 대화 원문은 환자 프라이버시 보호를 위해 공개되지 않습니다.</p>
              {data.events.length === 0 && <p className="text-xs text-zinc-400">이상 이벤트가 없습니다.</p>}
              <div className="grid gap-2">
                {data.events.map((e, i) => (
                  <div key={i} className="rounded-xl border border-zinc-100 bg-zinc-50 px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-800/50">
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-400">{e.date}</span>
                      <span className="font-semibold text-zinc-700 dark:text-zinc-200">{e.domain}</span>
                      <span className={`rounded px-1.5 py-0.5 font-bold ${e.score >= 2 ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-200" : "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200"}`}>{e.score}점</span>
                    </div>
                    {(e.note || e.evidence) && <p className="mt-1 text-zinc-500 dark:text-zinc-400">{e.note || e.evidence}</p>}
                  </div>
                ))}
              </div>
            </section>
            </>)}
          </>
        )}
      </main>
    </div>
  );
}
