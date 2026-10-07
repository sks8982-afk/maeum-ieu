/**
 * C2 — 인지등급 변화(악화 추세) 보호자 알림.
 *
 * 배경: C1(급성악화 감지)·B4(영구 베이스라인)는 감지까지 완성됐으나 보호자 "전달" 경로가
 * 비어 있었음(2026-06-02 보류 항목). 이 모듈이 그 갭을 잇는다.
 *
 * 정책 (보수적 기본값 — 오경보가 가족 불안을 만들므로):
 *  - 발동 조건: 최근 7일 vs 이전 30일 비교가 "급성악화"이거나,
 *               "악화" 추세이면서 현재 등급이 중증 이상일 때만.
 *  - 디바운스: 72시간 내 동일 알림 발송 이력이 있으면 skip.
 *  - 게이트: C2_NOTIFY=1 일 때만 활성 (알림 문구·임계는 제품 결정 후 조정).
 *
 * 호출: runCognitiveAnalysis에서 isAnomaly 턴에만 fire-and-forget (매 턴 집계 쿼리 방지).
 */
import { prisma } from "@/lib/prisma";
import { computeOverallAvg, detectAcuteChange, classifySeverity, type DomainStat } from "@/lib/health/severity";
import { notifyGuardian } from "@/lib/chat/emergency-notify";

const DEBOUNCE_MS = 72 * 60 * 60 * 1000; // 72시간
const CATEGORY = "cognitive_decline";

export async function fetchDomainStats(userId: string, fromDaysAgo: number, toDaysAgo: number): Promise<DomainStat[]> {
  // fromDaysAgo(과거) ~ toDaysAgo(최근) 구간의 영역별 평균/건수. 예: (36, 7) = 이전 30일, (6, 0) = 최근 7일.
  return prisma.$queryRawUnsafe<DomainStat[]>(
    `SELECT AVG(score)::float AS avg_score, COUNT(*)::int AS count
       FROM cognitive_assessments
      WHERE user_id = $1
        AND session_date >= CURRENT_DATE - ($2::int * INTERVAL '1 day')
        AND session_date <= CURRENT_DATE - ($3::int * INTERVAL '1 day')
      GROUP BY domain`,
    userId, fromDaysAgo, toDaysAgo,
  );
}

export async function maybeNotifyCognitiveDecline(params: {
  userId: string;
  userMsgId: string;
  userName: string; // 호칭 (알림 표시용 — 실명 미사용)
}): Promise<{ sent: boolean; reason?: string }> {
  const { userId, userMsgId, userName } = params;
  if (process.env.C2_NOTIFY !== "1") return { sent: false, reason: "env off" };

  try {
    // 1) 디바운스 — 72h 내 동일 카테고리 발송 이력
    const cutoff = new Date(Date.now() - DEBOUNCE_MS);
    const dup = await prisma.message.findFirst({
      where: {
        conversation: { userId },
        emergencyEvidence: { startsWith: `${CATEGORY}:` },
        notifiedAt: { gte: cutoff },
      },
      select: { id: true },
    });
    if (dup) return { sent: false, reason: "debounce 72h" };

    // 2) 추세 계산 — 최근 7일 vs 이전 30일 (C1 detectAcuteChange 재사용)
    const [recent, baseline] = await Promise.all([
      fetchDomainStats(userId, 6, 0),
      fetchDomainStats(userId, 36, 7),
    ]);
    const recentAvg = computeOverallAvg(recent);
    const baselineAvg = computeOverallAvg(baseline);
    const trend = detectAcuteChange({
      recentAvg,
      recentCount: recent.reduce((s, d) => s + d.count, 0),
      baselineAvg,
      baselineCount: baseline.reduce((s, d) => s + d.count, 0),
    });
    const tier = classifySeverity(recentAvg);

    // 3) 발동 조건 (보수적): 급성악화, 또는 악화+중증 이상
    const shouldNotify =
      trend.status === "급성악화" ||
      (trend.status === "악화" && (tier.tier === "중증" || tier.tier === "고위험"));
    if (!shouldNotify) return { sent: false, reason: `trend=${trend.status}, tier=${tier.tier}` };

    // 4) 발송 — 기존 보호자 웹훅 경로 재사용 (notifyGuardian이 messageId에 notifiedAt 마킹)
    const content = `${trend.text} (최근 7일 평균 ${recentAvg.toFixed(2)} · 평소 ${baselineAvg.toFixed(2)} · 등급 ${tier.tier})`;
    const r = await notifyGuardian({
      userId, userName, messageId: userMsgId, level: 2,
      category: CATEGORY, content, aiReply: "", createdAt: new Date(),
      realName: false,   // 위 userName 주석의 "실명 미사용" 규칙 — notifyGuardian 기본(실명)을 끈다
    });
    if (!r.sent) return { sent: false, reason: r.reason };

    // 5) 디바운스 마커 — 같은 메시지에 카테고리 evidence 기록(기존 응급 evidence가 있으면 보존)
    await prisma.message.updateMany({
      where: { id: userMsgId, emergencyEvidence: null },
      data: { emergencyEvidence: `${CATEGORY}:${trend.status}` },
    });
    return { sent: true, reason: trend.status };
  } catch (e) {
    console.warn("[c2-notify] error:", (e as Error).message);
    return { sent: false, reason: "error" };
  }
}
