import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

interface CognitiveRow {
  domain: string;
  score: number;
  confidence: number;
  evidence: string | null;
  note: string | null;
  session_date: string;
  created_at: Date;
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

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const userId = session.user.id;

  // 기존 HealthLog 데이터
  const [logs, stats] = await Promise.all([
    prisma.healthLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, type: true, value: true, note: true, createdAt: true },
    }),
    prisma.healthLog.groupBy({
      by: ["type"],
      where: { userId },
      _count: { id: true },
    }),
  ]);

  const total = stats.reduce((sum, s) => sum + s._count.id, 0);
  const cognitiveCount = stats.find((s) => s.type === "cognitive")?._count.id ?? 0;

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const recentCognitive = await prisma.healthLog.count({
    where: { userId, type: "cognitive", createdAt: { gte: sevenDaysAgo } },
  });

  // cognitive_assessments 데이터 (테이블 없으면 빈 배열)
  let cognitiveAssessments: CognitiveRow[] = [];
  let domainAverages: DomainAvg[] = [];
  let dailyTrend: DailyTrend[] = [];

  try {
    // 최근 평가 기록 (최근 50건)
    cognitiveAssessments = await prisma.$queryRawUnsafe<CognitiveRow[]>(
      `SELECT domain, score, confidence, evidence, note, session_date::text, created_at
       FROM cognitive_assessments
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      userId,
    );

    // 영역별 평균 점수
    domainAverages = await prisma.$queryRawUnsafe<DomainAvg[]>(
      `SELECT domain, ROUND(AVG(score)::numeric, 2)::float AS avg_score, COUNT(*)::int AS count
       FROM cognitive_assessments
       WHERE user_id = $1
       GROUP BY domain
       ORDER BY avg_score DESC`,
      userId,
    );

    // 최근 14일 일별 추세
    dailyTrend = await prisma.$queryRawUnsafe<DailyTrend[]>(
      `SELECT session_date::text, ROUND(AVG(score)::numeric, 2)::float AS avg_score, COUNT(*)::int AS check_count
       FROM cognitive_assessments
       WHERE user_id = $1 AND session_date >= CURRENT_DATE - INTERVAL '14 days'
       GROUP BY session_date
       ORDER BY session_date ASC`,
      userId,
    );
  } catch {
    // cognitive_assessments 테이블이 없을 수 있음
  }

  return NextResponse.json({
    logs,
    summary: {
      total,
      cognitiveCount,
      recentCognitive,
      byType: stats.map((s) => ({ type: s.type, count: s._count.id })),
    },
    cognitive: {
      assessments: cognitiveAssessments,
      domainAverages,
      dailyTrend,
    },
  });
}
