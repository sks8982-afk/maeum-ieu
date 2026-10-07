"use client";

/**
 * 환자 관리 — 연결된 환자 목록 + 내 초대 코드.
 *   의사(pro): 채점·요약 지표 전체.  보호자(guardian): 결과 요약 문구 + 위급 여부만(점수·상세 비공개).
 */
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "../theme-toggle";
import { LogoutButton } from "../LogoutButton";


interface PatientRow {
  id: string;
  name: string;
  age: number | null;
  gender: string | null;
  linkedAt: string;
  tier: string;
  lastActiveAt: string | null;
  // 의사 전용 상세 지표(보호자 응답에는 없음)
  overallAvg?: number | null;
  provisional?: boolean;
  showLevel?: boolean;
  trend?: string;
  trendText?: string;
  anomaly7d?: number;
  examLatest?: { band: string; label: string; score: number | null; max: number | null; sufficient: boolean; at: string } | null;
  // 보호자 전용 요약
  statusLine?: string;
  needsCare?: boolean;
  examBand?: string | null;
}

const BAND_STYLE: Record<string, string> = {
  "정상범위": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  "경계": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  "저하의심": "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  "자료부족": "bg-zinc-200 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300",
};

const TIER_STYLE: Record<string, string> = {
  "정상": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  "경증": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  "중증": "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  "고위험": "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  "평가전": "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
};
const TREND_LABEL: Record<string, string> = {
  "급성악화": "🔴 급성악화", "악화": "🟠 악화", "안정": "🟢 안정", "개선": "🔵 개선", "자료부족": "⚪ 자료부족",
};

export default function ExpertPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [code, setCode] = useState<string>("");
  const [viewerRole, setViewerRole] = useState<"pro" | "guardian">("pro");
  const [patients, setPatients] = useState<PatientRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") { router.replace("/login"); return; }
    if (status !== "authenticated") return;
    (async () => {
      try {
        const [codeRes, listRes] = await Promise.all([fetch("/api/expert/code"), fetch("/api/expert/patients")]);
        if (codeRes.status === 403 || listRes.status === 403) {
          setError("의사·보호자 계정 전용 페이지입니다. 어르신 계정에서는 열 수 없어요.");
          setLoading(false);
          return;
        }
        const codeData = await codeRes.json();
        const listData = await listRes.json();
        setCode(codeData.code ?? "");
        setViewerRole(listData.viewerRole === "guardian" ? "guardian" : "pro");
        setPatients(listData.patients ?? []);
      } catch {
        setError("정보를 불러오지 못했습니다. 새로고침해 주세요.");
      }
      setLoading(false);
    })();
  }, [status, router]);

  const copyCode = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* noop */ }
  };

  const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString("ko-KR", { month: "short", day: "numeric" }) : "—";

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <h1 className="text-lg font-bold text-zinc-900 dark:text-zinc-100">{viewerRole === "guardian" ? "👨‍👩‍👧 가족 상태" : "🩺 환자 관리"}</h1>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            {viewerRole === "pro" && (
              <Link href="/expert/protocol" className="text-sm text-teal-600 hover:text-teal-800 dark:text-teal-300 dark:hover:text-teal-200">검진 문항지</Link>
            )}
            <Link href="/help" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">사용 안내</Link>
            <Link href="/mypage" className="text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">마이페이지</Link>
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        {error && <p className="mb-6 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</p>}

        {!error && (
          <>
            <section className="mb-8 rounded-2xl border border-teal-200 bg-teal-50 p-5 dark:border-teal-900 dark:bg-teal-900/20">
              <h2 className="mb-1 text-sm font-semibold text-teal-900 dark:text-teal-200">내 초대 코드</h2>
              <p className="mb-3 text-xs text-teal-700 dark:text-teal-300">
                {viewerRole === "guardian"
                  ? "어르신이 마이페이지 → 보호자·전문가 연결에서 이 코드를 입력하면 목록에 추가됩니다. 연결 후에는 상태 요약과 위급 알림만 볼 수 있고, 대화 내용·상세 평가내역은 공개되지 않습니다."
                  : "환자(또는 보호자)가 마이페이지 → 보호자·전문가 연결에서 이 코드를 입력하면 목록에 추가됩니다. 연결 후에는 채점·요약 지표만 열람되며 대화 내용은 공개되지 않습니다."}
              </p>
              <div className="flex items-center gap-3">
                <span className="rounded-lg bg-white px-4 py-2 font-mono text-xl font-bold tracking-widest text-teal-800 dark:bg-zinc-900 dark:text-teal-200">
                  {loading ? "……" : code || "—"}
                </span>
                <button onClick={copyCode} className="rounded-lg border border-teal-300 px-3 py-2 text-sm text-teal-800 hover:bg-teal-100 dark:border-teal-700 dark:text-teal-200 dark:hover:bg-teal-900/40">
                  {copied ? "복사됨 ✓" : "복사"}
                </button>
              </div>
              {/* 2026-10-07: 앱 푸시가 오려면 무엇이 필요한지 화면 어디에도 없었다 — 연결만 하고 앱에 로그인하지 않은
                  보호자는 알림을 못 받는데도 "위급 알림을 받을 수 있어요"로만 안내됐다(보호자 앱 푸시 추적) */}
              <div className="mt-4 rounded-xl bg-white/70 px-4 py-3 text-xs leading-relaxed text-teal-900 dark:bg-zinc-900/60 dark:text-teal-100">
                <p className="font-semibold">📱 위급 알림을 휴대폰으로 받으려면</p>
                <ol className="mt-1 list-decimal space-y-0.5 pl-5">
                  <li><b>안드로이드 휴대폰</b>에 <b>마음이음 앱</b>을 설치하고, 앱에서 <b>이 계정으로 로그인</b>해 두세요.</li>
                  <li>앱이 알림 권한을 물으면 <b>허용</b>을 눌러 주세요.</li>
                  <li>위 코드를 {viewerRole === "guardian" ? "어르신" : "환자"} 계정에서 입력해 <b>연결</b>해 주세요.</li>
                </ol>
                {/* "로그아웃하면 안 온다"고 약속하지 않는다 — 구버전 앱은 저장해 둔 계정을 잃어 로그아웃해도 구독이 남을 수 있었다(재검토).
                    보호자에게 필요한 건 "계속 받으려면 로그인을 유지"라는 안내다 */}
                <p className="mt-1 text-teal-700 dark:text-teal-300">알림을 계속 받으려면 앱에서 로그아웃하지 말고 이 계정으로 로그인해 두세요.</p>
                <p className="mt-0.5 text-teal-700 dark:text-teal-300">아이폰은 아직 앱 알림을 받을 수 없어요 — {viewerRole === "guardian" ? "어르신" : "환자"} 마이페이지의 &lsquo;보호자 이메일&rsquo;에 주소를 적어 두면 메일로 받아요.</p>
              </div>
            </section>

            <h2 className="mb-3 text-sm font-semibold text-zinc-600 dark:text-zinc-300">연결된 {viewerRole === "guardian" ? "어르신" : "환자"} {patients.length}명</h2>
            {loading && <p className="text-sm text-zinc-500">불러오는 중…</p>}
            {!loading && patients.length === 0 && (
              <p className="rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
                아직 연결된 {viewerRole === "guardian" ? "어르신" : "환자"}이 없습니다. 위 초대 코드를 {viewerRole === "guardian" ? "어르신께" : "환자에게"} 전달해 주세요.
              </p>
            )}
            <div className="grid gap-3">
              {patients.map((p) => viewerRole === "guardian" ? (
                /* 보호자 카드 — 결과 요약 문구 + 진료 권장 여부만(점수·상세 비공개) */
                <Link key={p.id} href={`/expert/patients/${p.id}`} className="block rounded-2xl border border-zinc-200 bg-white p-4 transition hover:border-amber-400 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-amber-600">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{p.name}</span>
                      <span className="text-xs text-zinc-500">{p.age ? `${p.age}세` : ""} {p.gender === "male" ? "남" : p.gender === "female" ? "여" : ""}</span>
                    </div>
                    {p.needsCare
                      ? <span className="rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-bold text-red-800 dark:bg-red-900/40 dark:text-red-200">🩺 진료 권장</span>
                      : <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">양호</span>}
                  </div>
                  <p className={`mt-2 rounded-lg px-3 py-2 text-sm ${p.needsCare ? "bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-200" : "bg-zinc-50 text-zinc-700 dark:bg-zinc-800/60 dark:text-zinc-200"}`}>{p.statusLine}</p>
                  <div className="mt-1 text-xs text-zinc-400">최근 대화 {fmtDate(p.lastActiveAt)} · 자세히 보기 →</div>
                </Link>
              ) : (
                /* 의사 카드 — 채점·요약 지표 전체 */
                <Link key={p.id} href={`/expert/patients/${p.id}`} className="block rounded-2xl border border-zinc-200 bg-white p-4 transition hover:border-teal-400 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-teal-600">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-3">
                      <span className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{p.name}</span>
                      <span className="text-xs text-zinc-500">{p.age ? `${p.age}세` : ""} {p.gender === "male" ? "남" : p.gender === "female" ? "여" : ""}</span>
                      {/* 검진(1차 신호) */}
                      {p.examLatest
                        ? <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${BAND_STYLE[p.examLatest.band] ?? BAND_STYLE["자료부족"]}`}>검진 {p.examLatest.label}{p.examLatest.score != null && p.examLatest.sufficient ? ` ${p.examLatest.score}/${p.examLatest.max}` : ""}</span>
                        : <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${TIER_STYLE["평가전"]}`}>검진 전</span>}
                      {/* 일상 모니터링(보조) — 평소 대화 기반. 자료 없으면 '검진'의 자료부족과 혼동되지 않게 추세칩 숨김 */}
                      <span className="text-[11px] text-zinc-400">
                        {p.showLevel === false
                          ? "일상 대화 자료 수집중"
                          : `일상 ${p.tier}${p.provisional ? "(잠정)" : ""}${p.trend && p.trend !== "자료부족" ? ` · ${TREND_LABEL[p.trend] ?? p.trend}` : ""}`}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-500">
                      최근 활동 {fmtDate(p.lastActiveAt)} · 7일 이상징후 {p.anomaly7d ?? 0}건{p.overallAvg != null ? ` · 평균 ${p.overallAvg}` : ""}
                    </div>
                  </div>
                  {(p.trend === "급성악화" || p.trend === "악화") && p.trendText && (
                    <p className="mt-2 rounded-lg bg-orange-50 px-3 py-2 text-xs text-orange-800 dark:bg-orange-900/30 dark:text-orange-200">{p.trendText}</p>
                  )}
                </Link>
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
