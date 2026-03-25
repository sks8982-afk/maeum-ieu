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

interface DomainAvg { domain: string; avg_score: number; count: number; }
interface DailyTrend { session_date: string; avg_score: number; check_count: number; }

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const userId = session.user.id;

  // Message 테이블에서 isAnomaly 건수
  const anomalyCount = await prisma.message.count({
    where: { conversation: { userId }, isAnomaly: true },
  });

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentAnomaly = await prisma.message.count({
    where: { conversation: { userId }, isAnomaly: true, createdAt: { gte: sevenDaysAgo } },
  });

  // cognitive_assessments 데이터
  let assessments: CognitiveRow[] = [];
  let domainAverages: DomainAvg[] = [];
  let dailyTrend: DailyTrend[] = [];

  try {
    assessments = await prisma.$queryRawUnsafe<CognitiveRow[]>(
      `SELECT domain, score, confidence, evidence, note, session_date::text, created_at
       FROM cognitive_assessments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, userId,
    );
    domainAverages = await prisma.$queryRawUnsafe<DomainAvg[]>(
      `SELECT domain, ROUND(AVG(score)::numeric, 2)::float AS avg_score, COUNT(*)::int AS count
       FROM cognitive_assessments WHERE user_id = $1 GROUP BY domain ORDER BY avg_score DESC`, userId,
    );
    dailyTrend = await prisma.$queryRawUnsafe<DailyTrend[]>(
      `SELECT session_date::text, ROUND(AVG(score)::numeric, 2)::float AS avg_score, COUNT(*)::int AS check_count
       FROM cognitive_assessments WHERE user_id = $1 AND session_date >= CURRENT_DATE - INTERVAL '14 days'
       GROUP BY session_date ORDER BY session_date ASC`, userId,
    );
  } catch { /* cognitive_assessments 테이블 없을 수 있음 */ }

  return NextResponse.json({
    summary: { anomalyCount, recentAnomaly },
    cognitive: { assessments, domainAverages, dailyTrend },
  });
}
