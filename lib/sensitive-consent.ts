/**
 * 민감정보 **별도 동의**(선택) — 목소리 등록(성문)·상시 감시.
 *
 * 왜 건강정보 동의(v1.1, User.consentedAt)와 따로 두나 (2026-10-06, 개인정보 보호법 조사):
 *   · 성문(목소리 특징값)은 생체인식정보 = 민감정보(시행령 제18조 3호) → 제23조①1호 **별도 동의**.
 *   · 상시 감시는 새 수집 방법(주변 소리 청취·혼잣말 전사)이고, 위급 시 보호자 알림은 제3자 제공 →
 *     처리 동의와 제공 동의를 **각각** 받는다(제22조① 구분 동의).
 *   · v1.1은 셋 다 다루지 않는다. 거기에 끼워 넣으면 선택 기능이 서비스 이용 조건에 묶인다(제22조⑤).
 *
 * 저장: raw 테이블 sensitive_consent(user_id, kind, version, consented_at, withdrawn_at).
 *   ⚠ prisma db push 금지(raw 테이블을 지운다) — scripts/ops-sensitive-consent.ts로 만든다.
 *
 * 버전: 문안을 바꾸면 SENSITIVE_CONSENT_VERSION을 올린다 → 이전 버전 동의는 효력을 잃는다(재동의).
 *   건강정보 동의(CONSENT_VERSION)는 어디서도 버전을 비교하지 않아 올려도 재동의가 안 됐다 —
 *   같은 실수를 하지 않으려고 유효 판정에 버전을 넣었다.
 */
import { prisma } from "@/lib/prisma";

export type SensitiveKind = "voiceprint" | "observe" | "observe_share";

/** 동의 문안 버전 — 화면 문안(app/components/sensitive-consent)을 바꾸면 올린다 */
export const SENSITIVE_CONSENT_VERSION: Record<SensitiveKind, string> = {
  voiceprint: "1.0",
  observe: "1.0",
  observe_share: "1.0",
};

/** 상시 감시를 켜는 데 필요한 동의 — 음성·건강정보 처리(제23조) + 보호자·의사 제공(제17조) */
export const OBSERVE_KINDS: readonly SensitiveKind[] = ["observe", "observe_share"];

export function isSensitiveKind(v: unknown): v is SensitiveKind {
  return v === "voiceprint" || v === "observe" || v === "observe_share";
}

/**
 * 테이블이 없다 = 운영 스크립트보다 배포가 먼저 나갔다. 장애가 아니라 "아무도 동의하지 않은 상태"다.
 *   이걸 장애로 보면 상시 감시의 "조회 실패 시 계속" 비대칭(app/api/observe/turn)을 타고
 *   **동의 없이** 감시가 돌아간다 — 그래서 여기서 갈라 동의 없음으로 돌려준다.
 */
export function isMissingConsentTable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("42P01") || msg.includes(`relation "sensitive_consent" does not exist`);
}

/** 유효한(철회되지 않았고 현재 문안 버전인) 동의 종류. 테이블이 없으면 빈 집합, 그 밖의 실패는 throw */
export async function getActiveSensitiveConsents(userId: string): Promise<Set<SensitiveKind>> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ kind: string; version: string }[]>(
      `SELECT kind, version FROM sensitive_consent WHERE user_id = $1 AND withdrawn_at IS NULL`, userId,
    );
    const active = new Set<SensitiveKind>();
    for (const r of rows) {
      if (isSensitiveKind(r.kind) && r.version === SENSITIVE_CONSENT_VERSION[r.kind]) active.add(r.kind);
    }
    return active;
  } catch (e) {
    if (isMissingConsentTable(e)) {
      console.error("[sensitive-consent] 테이블 없음 — 동의 없음으로 처리한다(scripts/ops-sensitive-consent.ts 실행 필요)");
      return new Set();
    }
    throw e;
  }
}

/**
 * 동의 기록 문(다시 동의하면 시각·버전 갱신, 철회 표시 해제).
 *   호출부가 한 트랜잭션에 넣는다 — 여러 종류를 함께 받을 때 반쪽 동의를 남기지 않고,
 *   이전 기록 정리와 같은 단위로 커밋한다(app/api/users/sensitive-consent).
 */
export function grantSensitiveConsentStatement(userId: string, kind: SensitiveKind) {
  return prisma.$executeRawUnsafe(
    `INSERT INTO sensitive_consent (user_id, kind, version, consented_at, withdrawn_at)
     VALUES ($1, $2, $3, now(), NULL)
     ON CONFLICT (user_id, kind) DO UPDATE SET version = EXCLUDED.version, consented_at = now(), withdrawn_at = NULL`,
    userId, kind, SENSITIVE_CONSENT_VERSION[kind],
  );
}

/** 철회 표시 문(트랜잭션에 넣어 파기와 함께 커밋한다 — app/api/users/sensitive-consent) */
export function withdrawSensitiveConsentStatement(userId: string, kind: SensitiveKind) {
  return prisma.$executeRawUnsafe(
    `UPDATE sensitive_consent SET withdrawn_at = now() WHERE user_id = $1 AND kind = $2 AND withdrawn_at IS NULL`,
    userId, kind,
  );
}
