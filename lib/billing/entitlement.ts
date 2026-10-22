/**
 * 구독 권리(entitlement) 판정 — "이 계정이 지금 유료 티어인가".
 *
 * 결제자 ≠ 혜택 대상: 보호자가 자기 Play 계정으로 결제하고 혜택은 연결된 어르신에게 간다.
 *   그래서 판정은 **결제자이거나 혜택 대상이면 통과**로 본다(한 구독이 두 계정을 덮는다).
 *   - 어르신: 대화 상한이 올라간다(beneficiary)
 *   - 보호자: 보호자 전용 기능이 열린다(purchaser)
 *
 * 실패 방향: 조회 실패나 미설정은 **무료 티어**로 떨어진다. 무료 티어는 현재 운영 조건과
 *   같으므로 과금 장치의 장애가 서비스 중단이 되지 않는다. 반대로 '실패 시 유료 취급'은
 *   비용이 통제되지 않으므로 쓰지 않는다.
 *
 * ⚠ 안전 경로와 무관: 응급 감지·보호자 위급 알림은 구독과 절대 연동하지 않는다.
 *   돈을 내지 않아 119 안내가 막히는 설계는 어떤 경우에도 허용하지 않는다.
 *
 * 웹 PG(포트원) 구독(provider='portone')은 상한을 **그 구독에 적어 둔 요금제 상한**(dailyTurnLimit — 가입 당시 값)으로 준다.
 *   여러 개면 가장 큰 상한. 요금제 설정(BILLING_PLANS)에 기대지 않는다 — 설정이 깨져도 낸 돈만큼의 혜택은 이어져야 한다.
 *   포트원 구독은 만료 시각이 반드시 있어야 혜택이다(Play의 '만료 정보 아직 없음 = 유효' 예외를 쓰지 않는다 — 결제 확정 때 채운다).
 *   pending·activating·failed는 ENTITLED_STATUSES에 없어 혜택이 없다(결제가 끝나지 않았다).
 */
import { prisma } from "@/lib/prisma";
import { DAILY_TURN_LIMIT } from "@/lib/usage/daily-limit";
import { ENTITLED_STATUSES, isProProduct, proDailyTurnLimit } from "@/lib/billing/plans";

export type Tier = "free" | "pro";

export interface Entitlement {
  tier: Tier;
  /** 일일 대화 상한(0 이하 = 제한 없음) */
  dailyTurnLimit: number;
  /** 보호자 전용 기능(상태 요약·추세) 열람 가능 — 위급 알림은 여기에 포함되지 않는다 */
  guardianFeatures: boolean;
  /** 혜택 만료 시각(null=없음/무기한) */
  expiresAt: Date | null;
  /** 어떤 경로로 얻은 권리인가 — 결제자 본인 / 보호자가 결제해 받은 혜택 */
  source: "none" | "purchaser" | "beneficiary";
}

const FREE: Entitlement = {
  tier: "free",
  dailyTurnLimit: DAILY_TURN_LIMIT,
  guardianFeatures: false,
  expiresAt: null,
  source: "none",
};

/** 무료 티어 권리 — 조회 없이 알 수 있는 기본값 */
export function freeEntitlement(): Entitlement {
  return { ...FREE, dailyTurnLimit: DAILY_TURN_LIMIT };
}

/** 판정에 쓰는 구독 행(조회 select와 같다) */
interface EntitlementRow {
  productId: string;
  expiresAt: Date | null;
  beneficiaryUserId: string;
  purchaserUserId: string;
  provider?: string | null;
  dailyTurnLimit?: number | null;
}

/**
 * 지금 혜택이 살아 있는 구독이면 그 구독의 일일 상한, 아니면 null.
 *   Play는 기존 규칙 그대로(PRO_DAILY_TURN_LIMIT), 포트원은 만료 시각과 가입 당시 요금제 상한이 있어야 한다.
 */
function liveTurnLimit(s: EntitlementRow, now: Date): number | null {
  if (s.provider === "portone") {
    const limit = s.dailyTurnLimit ?? 0;
    return s.expiresAt && s.expiresAt > now && limit > 0 ? limit : null;
  }
  return (!s.expiresAt || s.expiresAt > now) && isProProduct(s.productId) ? proDailyTurnLimit(DAILY_TURN_LIMIT) : null;
}

/** Play만 있던 때의 조회 칸 — 웹 결제 컬럼(provider·dailyTurnLimit)이 아직 DB에 없을 때 쓴다(아래 findEntitledSubs) */
const PLAY_SELECT = { productId: true, expiresAt: true, beneficiaryUserId: true, purchaserUserId: true } as const;

/**
 * 혜택이 있을 수 있는 구독 — 웹 결제 컬럼이 아직 DB에 없으면(P2022 — 운영 DDL(scripts/ops-billing-pg.ts)보다 배포가 먼저 나간 경우)
 *   예전 칸으로 한 번 더 묻는다. 그러지 않으면 아래 catch가 무료로 떨어뜨려 Play 구독자 전원이 조용히 무료가 된다(2026-10-22 검토).
 *   그 컬럼이 없는 DB에는 포트원 구독도 없으니 예전 칸만으로 판정이 같다.
 */
async function findEntitledSubs(userId: string): Promise<EntitlementRow[]> {
  const query = {
    where: { OR: [{ beneficiaryUserId: userId }, { purchaserUserId: userId }], status: { in: [...ENTITLED_STATUSES] }, revokedAt: null },
    orderBy: { expiresAt: "desc" as const },
    take: 5,
  };
  try {
    return await prisma.subscription.findMany({ ...query, select: { ...PLAY_SELECT, provider: true, dailyTurnLimit: true } });
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code !== "P2022") throw e;
    console.warn("[entitlement] 웹 결제 컬럼 없음(P2022) — Play 칸으로 다시 조회한다. scripts/ops-billing-pg.ts를 실행해야 한다");
    return prisma.subscription.findMany({ ...query, select: PLAY_SELECT });
  }
}

/**
 * 계정의 현재 권리. 결제자이거나 혜택 대상이면 유료 티어.
 * 만료 시각이 지난 구독은 상태가 아직 active여도 무료로 본다(RTDN 지연 대비).
 */
export async function getEntitlement(userId: string): Promise<Entitlement> {
  if (!userId) return freeEntitlement();
  try {
    const now = new Date();
    const subs = await findEntitledSubs(userId);

    // 만료 시각이 지난 것은 제외 — RTDN(갱신·해지 통지)이 늦게 와도 혜택이 새지 않게.
    //   expiresAt이 null인 Play 구독은 만료 정보를 아직 받지 못한 상태이므로 유효로 본다
    //   (검증 직후 생성된 레코드. verify가 만료 시각을 채운다). 포트원은 liveTurnLimit 참조.
    const live = subs.flatMap((s) => {
      const limit = liveTurnLimit(s, now);
      return limit === null ? [] : [{ ...s, limit }];
    });
    if (live.length === 0) return freeEntitlement();

    const best = live[0];
    return {
      tier: "pro",
      // 여러 구독이 겹치면(Play + 포트원 등) 가장 큰 상한
      dailyTurnLimit: Math.max(...live.map((s) => s.limit)),
      guardianFeatures: true,
      expiresAt: best.expiresAt ?? null,
      source: best.purchaserUserId === userId ? "purchaser" : "beneficiary",
    };
  } catch (e) {
    console.warn("[entitlement] 조회 실패 — 무료 티어로 처리:", e instanceof Error ? e.message : e);
    return freeEntitlement();
  }
}

/**
 * 보호자가 결제할 때의 혜택 대상(= 연결된 어르신) 결정.
 *
 * 연결이 1명이면 그 사람, 여러 명이면 **가장 먼저 연결된 어르신**을 기본으로 한다
 *   (클라이언트가 보낸 대상을 그대로 믿지 않는다 — 남의 계정에 혜택을 붙일 수 있다).
 *   요청에 대상이 명시되면 active 링크인지 검증한 뒤에만 인정한다.
 * 연결된 어르신이 없으면 결제자 본인(어르신 계정이 직접 결제한 경우)이 대상이다.
 */
export async function resolveBeneficiary(purchaserUserId: string, requested?: string): Promise<string> {
  if (requested && requested !== purchaserUserId) {
    const link = await prisma.expertPatient.findUnique({
      where: { expertUserId_patientUserId: { expertUserId: purchaserUserId, patientUserId: requested } },
      select: { status: true },
    });
    if (link?.status === "active") return requested;
    // 연결되지 않은 대상 요청은 무시하고 기본 규칙으로 — 조용히 남의 계정에 붙지 않게
    console.warn(`[entitlement] 미연결 혜택 대상 요청 무시: purchaser=${purchaserUserId.slice(0, 8)}`);
  }
  const first = await prisma.expertPatient.findFirst({
    where: { expertUserId: purchaserUserId, status: "active" },
    orderBy: { createdAt: "asc" },
    select: { patientUserId: true },
  });
  return first?.patientUserId ?? purchaserUserId;
}
