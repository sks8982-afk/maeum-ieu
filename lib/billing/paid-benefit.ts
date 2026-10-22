/**
 * 유료 혜택을 썼나 — 청약철회·지금 해지의 환불액을 가르는 판정(환불정책 권장안 — research C 3).
 *
 * 정의(약관 '유료 혜택 이용'): 이용기간 중 혜택 대상(어르신)의 **하루(KST) 대화 수가 무료 한도를 넘은 날**이 있는 것.
 *   세는 기준은 일일 한도(lib/usage/daily-limit.ts)와 같다 — 그 계정 대화의 사용자 발화(role="user"), KST 자정 기준 하루,
 *   상시 감시 기록 제외(EXCLUDE_OBSERVATION). 기준이 갈리면 화면의 '유료 혜택 사용: 있음/없음'과 실제 한도가 어긋난다.
 *
 * "넘은 날"은 그날 무료 한도를 넘는 발화가 **이용기간 안에서** 있었는지로 본다. 그날의 총 발화가 한도를 넘었어도
 *   넘는 몫이 전부 결제 전이면(무료로 한도에 닿은 뒤 마무리 인사를 받은 발화 — 한도 도달 턴도 저장된다) 쓰지 않은 것이다.
 *   발화는 시간순이므로 "그날 마지막 발화가 이용기간 안 + 그날 발화 수 > 무료 한도"와 같다.
 * ⚠ 한도를 넘어도 응급 발화는 늘 통과·저장된다(안전 우선) — 그런 날도 '썼다'로 센다(드묾 — 세는 기준을 daily-limit과 같게 둔다).
 * 무료 한도가 꺼져 있으면(DAILY_TURN_LIMIT ≤ 0) 유료 혜택이라는 것이 없으므로 false.
 * 조회 실패는 throw — 환불액을 추측으로 정하지 않는다(부르는 쪽이 오류로 돌려준다).
 */
import { prisma } from "@/lib/prisma";
import { EXCLUDE_OBSERVATION } from "@/lib/chat/observation";
import { DAILY_TURN_LIMIT } from "@/lib/usage/daily-limit";
import { kstDayNumber } from "@/lib/billing/portone-period";

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;

export async function usedPaidBenefit(
  beneficiaryUserId: string, period: { start: Date; end: Date }, freeLimit = DAILY_TURN_LIMIT,
): Promise<boolean> {
  if (freeLimit <= 0 || period.end <= period.start) return false;
  // 첫날의 KST 자정부터 센다 — 그날 결제 전 발화도 그날의 몇 번째인지에는 들어간다
  const dayStart = new Date(kstDayNumber(period.start) * DAY_MS - KST_OFFSET_MS);
  const rows = await prisma.message.findMany({
    where: {
      conversation: { userId: beneficiaryUserId }, role: "user",
      createdAt: { gte: dayStart, lt: period.end }, ...EXCLUDE_OBSERVATION,
    },
    select: { createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const perDay = new Map<number, { count: number; last: Date }>();
  for (const r of rows) {
    const day = kstDayNumber(r.createdAt);
    const prev = perDay.get(day);
    perDay.set(day, { count: (prev?.count ?? 0) + 1, last: r.createdAt });
  }
  for (const { count, last } of perDay.values()) {
    if (count > freeLimit && last >= period.start) return true;
  }
  return false;
}
