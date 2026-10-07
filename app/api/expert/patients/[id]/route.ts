/**
 * 전문가용 환자 상세 리포트 — GET. pro + 활성 연결 필수.
 * 열람 범위: 채점 지표 + 분석기가 작성한 임상 근거(note/evidence)까지.
 *   사용자 대화 원문(Message.content)은 조회하지 않음 — 프라이버시 기본값.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeOverallAvg, classifySeverity, detectAcuteChange, assessReliability, guardianStatusLine, type DomainStat } from "@/lib/health/severity";
import { classifyProvisional, classifyFormal, compareSessions, summarizeExamTrend, EXAM_DISCLAIMER, type ExamTrend } from "@/lib/screening/exam-eval";
import { itemLabel } from "@/lib/screening/cist-bank";
import { buildExamQa } from "@/lib/screening/exam-qa";
import { toKstDateString } from "@/lib/chat/time";
import { resolveViewerRole } from "@/lib/roles";
import { BILLING_ENFORCE } from "@/lib/billing/plans";
import { getEntitlement } from "@/lib/billing/entitlement";
import { emergencyCategoryKo } from "@/lib/chat/emergency-labels";

interface DomainRow extends DomainStat { domain: string }
interface WeekRow { week_start: string; avg_score: number; count: number }
interface EventRow { domain: string; score: number; note: string | null; evidence: string | null; session_date: string }

const DOMAIN_KO: Record<string, string> = {
  orientation_time: "시간 지남력", orientation_place: "장소 지남력",
  memory_immediate: "즉시 기억", memory_delayed: "지연 기억",
  language: "언어", judgment: "판단력", attention_calculation: "주의·계산",
};


export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  // 의사(pro)=상세 평가내역 전체, 보호자(guardian)=결과 요약만. 그 외 계정은 차단.
  const role = resolveViewerRole(session.user.screeningMode);
  if (!role) return NextResponse.json({ error: "의사·보호자 계정 전용 기능입니다." }, { status: 403 });
  const isDoctor = role === "pro";
  const { id: patientId } = await params;

  // 연결 관계 검증 — 미연결 환자 접근 차단
  const link = await prisma.expertPatient.findUnique({
    where: { expertUserId_patientUserId: { expertUserId: session.user.id, patientUserId: patientId } },
    select: { status: true },
  });
  if (!link || link.status !== "active") {
    return NextResponse.json({ error: "연결되지 않은 환자입니다." }, { status: 403 });
  }

  const domainStats = (from: number, to: number) => prisma.$queryRawUnsafe<DomainRow[]>(
    `SELECT domain, AVG(score)::float AS avg_score, COUNT(*)::int AS count
       FROM cognitive_assessments
      WHERE user_id = $1
        AND session_date >= CURRENT_DATE - ($2::int * INTERVAL '1 day')
        AND session_date <= CURRENT_DATE - ($3::int * INTERVAL '1 day')
      GROUP BY domain`, patientId, from, to);

  const [patient, recent, baseline, weekly, events] = await Promise.all([
    prisma.user.findUnique({ where: { id: patientId }, select: { name: true, age: true, gender: true, createdAt: true } }),
    domainStats(6, 0),
    domainStats(36, 7),
    prisma.$queryRawUnsafe<WeekRow[]>(
      `SELECT to_char(date_trunc('week', session_date), 'YYYY-MM-DD') AS week_start,
              AVG(score)::float AS avg_score, COUNT(*)::int AS count
         FROM cognitive_assessments
        WHERE user_id = $1 AND session_date >= CURRENT_DATE - INTERVAL '56 day'
        GROUP BY 1 ORDER BY 1`, patientId),
    prisma.$queryRawUnsafe<EventRow[]>(
      `SELECT domain, score, note, evidence, to_char(session_date, 'YYYY-MM-DD') AS session_date
         FROM cognitive_assessments
        WHERE user_id = $1 AND score >= 1
        ORDER BY session_date DESC, created_at DESC
        LIMIT 20`, patientId),
  ]);
  if (!patient) return NextResponse.json({ error: "환자를 찾을 수 없습니다." }, { status: 404 });

  const recentAvg = computeOverallAvg(recent);
  const tier = classifySeverity(recentAvg);
  // 표본 신뢰도 — 소표본(예: 7턴)에 '중증' 단정 방지. 충분/잠정/판정보류 구분.
  const reliability = assessReliability(recent.reduce((s, d) => s + d.count, 0), recent.filter((d) => d.count >= 2).length);
  const trend = detectAcuteChange({
    recentAvg,
    recentCount: recent.reduce((s, d) => s + d.count, 0),
    baselineAvg: computeOverallAvg(baseline),
    baselineCount: baseline.reduce((s, d) => s + d.count, 0),
  });

  const baseMap = new Map(baseline.map((d) => [d.domain, d]));
  const domains = Object.keys(DOMAIN_KO).map((domain) => {
    const r = recent.find((d) => d.domain === domain);
    const b = baseMap.get(domain);
    return {
      domain, label: DOMAIN_KO[domain],
      recentAvg: r ? Number(r.avg_score.toFixed(2)) : null, recentCount: r?.count ?? 0,
      baselineAvg: b ? Number(b.avg_score.toFixed(2)) : null, baselineCount: b?.count ?? 0,
    };
  });

  // MMSE-K 환산 추정(참고용) — 음성 시행 7영역의 정성 점수(0정상~2저하)를 영역 가중치로 환산.
  //   시공간(구성)은 음성 미시행이라 만점에서 제외. 정식 검사 점수가 아닌 추정치.
  const CIST_WEIGHT: Record<string, number> = {
    orientation_time: 5, orientation_place: 5, memory_immediate: 3,
    attention_calculation: 5, memory_delayed: 3, language: 5, judgment: 3,
  };
  let cistEarned = 0, cistMax = 0;
  for (const d of domains) {
    const w = CIST_WEIGHT[d.domain] ?? 0;
    if (d.recentAvg === null || w === 0) continue;
    cistMax += w;
    cistEarned += w * (1 - Math.min(2, Math.max(0, d.recentAvg)) / 2);
  }
  const cistEstimate = cistMax > 0 ? { earned: Math.round(cistEarned), max: cistMax, assessedDomains: domains.filter((d) => d.recentAvg !== null && CIST_WEIGHT[d.domain]).length } : null;

  // 복약 — 일정 + 오늘 복용 + 주간 이행률(보호자·전문가 열람용, 읽기전용)
  let medications: { id: string; label: string; times: string[]; enabled: boolean }[] = [];
  let medToday: string[] = [];
  let medWeek = { confirmed: 0, expected: 0 };
  try {
    const meds = await prisma.medicationSchedule.findMany({ where: { userId: patientId }, orderBy: { createdAt: "asc" } });
    medications = meds.map((m) => ({ id: m.id, label: m.label, times: Array.isArray(m.times) ? (m.times as string[]) : [], enabled: m.enabled }));
    const today = toKstDateString(new Date());
    const tRows = await prisma.$queryRawUnsafe<{ schedule_id: string; dose_time: string }[]>(
      `SELECT schedule_id, dose_time FROM medication_log WHERE user_id = $1 AND taken_date = $2::date AND status = 'confirmed'`, patientId, today);
    medToday = tRows.map((r) => `${r.schedule_id}|${r.dose_time}`);
    const wRows = await prisma.$queryRawUnsafe<{ c: number }[]>(
      `SELECT COUNT(*)::int AS c FROM medication_log WHERE user_id = $1 AND status = 'confirmed' AND taken_date >= CURRENT_DATE - INTERVAL '6 days'`, patientId);
    const dailyDoses = medications.filter((m) => m.enabled).reduce((s, m) => s + m.times.length, 0);
    medWeek = { confirmed: wRows[0]?.c ?? 0, expected: dailyDoses * 7 };
  } catch { /* medication_log 미생성 환경 방어 */ }

  // ── 보호자(guardian) 요약 응답 ──
  //   상세 평가내역(문항별 채점·문답 원문·임상 근거·응급 발화 원문)은 조회도 반환도 하지 않는다.
  //   결과 요약(등급 문구) + 위급 발생 건수 + 복약 이행률만. 상세는 의사(pro)만.
  if (!isDoctor) {
    const shownTier = reliability.showLevel ? tier.tier : "평가전";
    const status = guardianStatusLine(shownTier);

    /**
     * 구독 게이트 — 인지 평가 요약(등급·추세·권고·복약 이행률)은 유료 기능이다.
     *
     * 🔒 위급 알림 이력은 **절대 막지 않는다**. 돈을 내지 않아 어르신의 응급 상황을
     *   모르게 되는 설계는 허용하지 않는다. 그래서 emergency 블록은 그대로 내보내고
     *   요약 지표만 가린다.
     *
     * BILLING_ENFORCE=0(기본)이면 아무것도 막지 않는다 — 가격이 확정되고 Play Console
     *   상품이 준비된 뒤에 켠다(코드 변경 없이 전환).
     */
    if (BILLING_ENFORCE && !(await getEntitlement(session.user.id)).guardianFeatures) {
      const [emgAgg, emgNotified] = await Promise.all([
        prisma.message.aggregate({
          where: { conversation: { userId: patientId }, emergencyLevel: { gte: 2 }, role: "user" },
          _count: { _all: true }, _max: { createdAt: true },
        }),
        prisma.message.count({
          where: { conversation: { userId: patientId }, emergencyLevel: { gte: 2 }, role: "user", notifiedAt: { not: null } },
        }),
      ]);
      return NextResponse.json({
        viewerRole: "guardian",
        patient: { name: patient.name ?? "이름 미설정", age: patient.age, gender: patient.gender, joinedAt: patient.createdAt },
        locked: true,
        tier: "평가전",
        statusLine: "상태 요약은 구독 후 확인할 수 있어요.",
        needsCare: false,
        advice: "",
        trend: "", trendText: "",
        reliability: { showLevel: false, reason: "구독이 필요합니다.", checkCount: 0 },
        // 🔒 안전 경로 — 구독과 무관하게 항상 제공
        emergency: { count: emgAgg._count._all, lastAt: emgAgg._max.createdAt, notifiedCount: emgNotified },
        medication: null,
      });
    }
    const [emgAgg, emgNotified] = await Promise.all([
      prisma.message.aggregate({
        where: { conversation: { userId: patientId }, emergencyLevel: { gte: 2 }, role: "user" },
        _count: { _all: true }, _max: { createdAt: true },
      }),
      prisma.message.count({
        where: { conversation: { userId: patientId }, emergencyLevel: { gte: 2 }, role: "user", notifiedAt: { not: null } },
      }),
    ]);
    prisma.$executeRawUnsafe(
      `INSERT INTO expert_access_log (id, expert_user_id, patient_user_id, action) VALUES ($1, $2, $3, 'summary')`,
      `eal_${Date.now()}_${session.user.id.slice(0, 8)}`, session.user.id, patientId,
    ).catch(() => {});
    return NextResponse.json({
      viewerRole: "guardian",
      patient: { name: patient.name ?? "이름 미설정", age: patient.age, gender: patient.gender, joinedAt: patient.createdAt },
      tier: shownTier,
      statusLine: status.headline,
      needsCare: status.needsCare || trend.status === "급성악화" || trend.status === "악화",
      advice: reliability.showLevel ? tier.text : "",   // severity.ts 등급별 권고(단일 출처)
      trend: trend.status, trendText: trend.text,
      reliability,
      emergency: { count: emgAgg._count._all, lastAt: emgAgg._max.createdAt, notifiedCount: emgNotified },
      medication: { weekCompliance: medWeek },
    });
  }

  // 회차별 분석 — 검사일(session_date)별로 묶어 회차로 비교(주기적 검사: 월 1회 등)
  const sessionRows = await prisma.$queryRawUnsafe<{ date: string; domain: string; avg: number; cnt: number }[]>(
    `SELECT to_char(session_date,'YYYY-MM-DD') AS date, domain, AVG(score)::float AS avg, COUNT(*)::int AS cnt
       FROM cognitive_assessments WHERE user_id = $1
       GROUP BY session_date, domain ORDER BY session_date DESC`, patientId);
  const byDate = new Map<string, DomainRow[]>();
  for (const r of sessionRows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date)!.push({ domain: r.domain, avg_score: r.avg, count: r.cnt });
  }
  const sessions = [...byDate.entries()].slice(0, 12).map(([date, stats]) => {
    const avg = computeOverallAvg(stats);
    return {
      date,
      overallAvg: avg < 0 ? null : Number(avg.toFixed(2)),
      tier: classifySeverity(avg).tier,
      count: stats.reduce((s, d) => s + d.count, 0),
      domains: stats.map((d) => ({ label: DOMAIN_KO[d.domain] ?? d.domain, avg: Number(d.avg_score.toFixed(2)) })),
    };
  });

  // 검진 세션 — 문답(Q&A) + 의사 코멘트 + 평가(잠정/학력보정) + 회차 추세. 문답 원문은 검진 구간 메시지만 노출(일상대화와 분리).
  interface ExamSessionView {
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
  let examSessions: ExamSessionView[] = [];
  let examTrend: ExamTrend | null = null;
  let examTrendPoints: { round: number; date: string; score: number; max: number; band: string | null }[] = [];
  try {
    const rows = await prisma.$queryRawUnsafe<{ id: string; started_at: Date; ended_at: Date | null; doctor_comment: string | null; total_score: number | null; max_score: number | null; eval_band: string | null; coverage_status: string | null; answered_domains: number | null; total_domains: number | null; education_years: number | null; visuospatial_score: number | null }[]>(
      `SELECT id, started_at, ended_at, doctor_comment, total_score, max_score, eval_band, coverage_status, answered_domains, total_domains, education_years, visuospatial_score FROM exam_session WHERE patient_user_id = $1 AND expert_user_id = $2 ORDER BY started_at DESC LIMIT 10`,
      patientId, session.user.id);
    const built = await Promise.all(rows.map(async (r) => {
      const start = new Date(r.started_at);
      /**
       * 🔒 문답 기록은 **검진 테이블에서만** 만든다 — 환자의 메시지 테이블을 시간 창으로 읽지 않는다.
       *
       * 결함(2026-10-06 적대 감사, 반증 0/2): 예전엔 "검진 시작 ~ 종료(최대 30분) 사이의 **모든** 메시지"를
       *   문답 기록으로 보여줬다. 그래서 검진을 '시작'만 해 두면 그 30분 동안 환자가 집에서 나눈 일상 대화
       *   (상시 감시 혼잣말 포함)가 원문째 전문가 화면에 떴다 — 동의서 §4 "일상 대화 비공개" 위반.
       *   전문가는 대화 목록 API의 lastMessageAt으로 환자가 대화 중인 시점도 고를 수 있었다.
       *   07-07의 30분 상한은 창을 좁혔을 뿐 창이라는 구조를 그대로 둬, 악의적 시작·방치를 막지 못했다.
       *
       * 그래서 창을 좁히지 않고 **출처를 바꾼다**: exam_item_score는 검진 경로만 쓰는 테이블이라 일상 대화가
       *   들어올 수 없다(구조적 차단). 과거 세션까지 소급해 막힌다.
       *   질문 = 그 영역 문항 프롬프트의 결합(= 환자가 실제로 들은 renderDomainBattery와 같은 문장),
       *   답 = 그 영역 답(음성이면 전사). 잃는 것은 재질문 대화와 인사·종결 멘트뿐이고,
       *   재질문 끝의 무응답은 점수·사유("무응답")에 남는다.
       */
      const itemRows = await prisma.$queryRawUnsafe<{ item_id: string; domain: string; prompt: string | null; answer: string | null; score: number; max_points: number; reason: string | null; created_at: Date }[]>(
        `SELECT item_id, domain, prompt, answer, score, max_points, reason, created_at FROM exam_item_score WHERE session_id = $1 ORDER BY created_at`, r.id);
      const sufficient = r.coverage_status !== "insufficient";
      const provisional = r.total_score != null ? classifyProvisional(r.total_score, r.max_score ?? undefined, sufficient) : null;
      // 의사가 학력·시공간을 입력했으면 학력보정 잠정 등급 계산
      const formal = (r.total_score != null && (r.education_years != null || r.visuospatial_score != null))
        ? classifyFormal({ voiceScore: r.total_score, visuospatial: r.visuospatial_score, educationYears: r.education_years, sufficient })
        : null;
      return {
        id: r.id,
        startedAt: start.toISOString(),
        endedAt: r.ended_at ? new Date(r.ended_at).toISOString() : null,
        doctorComment: r.doctor_comment ?? "",
        totalScore: r.total_score, maxScore: r.max_score,
        coverage: { answered: r.answered_domains ?? 0, total: r.total_domains ?? 0, sufficient },
        evalBand: provisional?.band ?? null, evalLabel: provisional?.label ?? null, evalAdvice: provisional?.advice ?? null,
        educationYears: r.education_years, visuospatialScore: r.visuospatial_score,
        formalBand: formal?.band ?? null, formalLabel: formal?.label ?? null, formalAdvice: formal?.advice ?? null, formalScore: formal?.fullScore ?? null, formalMax: formal?.fullMax ?? null,
        // 배점 0점 보조 문항(예: 숫자 거꾸로)은 총점 미반영 → 항목별 채점/결과지에서 제외(질문·답변은 문답 기록에 남음)
        items: itemRows.filter((it) => it.max_points > 0).map((it) => ({ itemId: it.item_id, label: itemLabel(it.item_id), domain: it.domain, prompt: it.prompt ?? "", answer: it.answer ?? "", score: it.score, max: it.max_points, reason: it.reason ?? "" })),
        // 배점 0점 보조 문항도 문답 기록에는 남는다(itemRows 전체 사용 — 위 items만 0점을 뺀다)
        qa: buildExamQa(itemRows),
        trend: null as null | { direction: string; deltaPct: number },
      };
    }));
    // 회차 추세 — 각 회차를 바로 이전(더 오래된) 회차와 비교(DESC 정렬이므로 i+1이 이전 회차)
    for (let i = 0; i < built.length - 1; i++) {
      const cur = built[i], prev = built[i + 1];
      if (cur.totalScore != null && cur.maxScore && prev.totalScore != null && prev.maxScore && cur.coverage.sufficient && prev.coverage.sufficient) {
        cur.trend = compareSessions(prev.totalScore, prev.maxScore, cur.totalScore, cur.maxScore);
      }
    }
    examSessions = built;
    // 회차 추세 — 평가가능(자료충분·점수있음) 회차를 시간순(오래된→최신)으로 분석
    const chrono = [...built].reverse().filter((e) => e.totalScore != null && e.maxScore && e.coverage.sufficient);
    examTrendPoints = chrono.map((e, i) => ({ round: i + 1, date: e.startedAt.slice(0, 10), score: e.totalScore as number, max: e.maxScore as number, band: e.evalBand }));
    examTrend = summarizeExamTrend(chrono.map((e) => ({ score: e.totalScore as number, max: e.maxScore as number })));
  } catch { /* exam_session 미생성 환경 방어 */ }

  // 위급 알림 이력 — 응급(L2/L3) 감지 이벤트 + 보호자 알림 발송 여부(notifiedAt)
  // 위급(응급/이상) 메시지는 role=user(어르신 발화)에만 emergencyLevel이 기록됨.
  //   ⚠️ 프라이버시 원칙: 일상 대화 원문은 비공개. 단 '문제 있는 발화(응급)'는 보호자가 상황 파악하도록 해당 발화만 노출.
  const emergencyRows = await prisma.message.findMany({
    where: { conversation: { userId: patientId }, emergencyLevel: { gte: 2 }, role: "user" },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { emergencyLevel: true, emergencyEvidence: true, notifiedAt: true, createdAt: true, content: true },
  });
  const emergencies = emergencyRows.map((e) => {
    const key = (e.emergencyEvidence ?? "").split(":")[0];
    return {
      level: e.emergencyLevel ?? 0,
      category: emergencyCategoryKo(key, "기타 위급"),   // 라벨은 알림과 같은 단일 출처(lib/chat/emergency-labels)
      at: e.createdAt.toISOString(),
      notified: e.notifiedAt != null,
      utterance: (e.content ?? "").slice(0, 300), // 응급 당시 어르신 발화(문제 있는 대화만)
    };
  });

  // 감사 로그 — 환자 상세 열람 기록 (규제 대비, 실패 무시)
  prisma.$executeRawUnsafe(
    `INSERT INTO expert_access_log (id, expert_user_id, patient_user_id, action) VALUES ($1, $2, $3, 'detail')`,
    `eal_${Date.now()}_${session.user.id.slice(0, 8)}`, session.user.id, patientId,
  ).catch(() => {});
  return NextResponse.json({
    viewerRole: "pro",
    patient: { name: patient.name ?? "이름 미설정", age: patient.age, gender: patient.gender, joinedAt: patient.createdAt },
    overallAvg: recentAvg < 0 ? null : Number(recentAvg.toFixed(2)),
    tier: tier.tier, tierText: tier.text, reliability,
    trend: trend.status, trendText: trend.text, trendDelta: trend.delta,
    domains,
    weekly: weekly.map((w) => ({ weekStart: w.week_start, avg: Number(w.avg_score.toFixed(2)), count: w.count })),
    events: events.map((e) => ({ date: e.session_date, domain: DOMAIN_KO[e.domain] ?? e.domain, score: e.score, note: e.note, evidence: e.evidence })),
    emergencies,
    medication: { items: medications, todayConfirmed: medToday, weekCompliance: medWeek },
    sessions,
    cistEstimate,
    examSessions,
    examTrend,
    examTrendPoints,
    examDisclaimer: EXAM_DISCLAIMER,
  });
}
