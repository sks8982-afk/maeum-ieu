/**
 * 응급 카테고리 → 보호자가 읽는 한글 라벨 — **단일 출처**.
 *
 * 왜(2026-10-07 보호자 앱 푸시 추적): 앱 푸시·이메일·메신저 알림이 카테고리 **코드**를 그대로 보냈다
 *   ("할머니님 — fall_injury"). 보호자는 알림만 보고 무슨 일인지 알 수 없었다. 한글 라벨은 전문가 상세
 *   화면(app/api/expert/patients/[id])에만 있었다 — 여기로 옮겨 알림과 화면이 같은 말을 쓴다.
 *
 * 타입이 EmergencyCategory 전체를 요구하므로, 새 분류를 추가하면 라벨이 없을 때 컴파일이 깨진다.
 */
import type { EmergencyCategory } from "@/lib/chat/emergency";

export const EMERGENCY_CATEGORY_KO: Record<Exclude<EmergencyCategory, "none">, string> = {
  medical_acute: "급성 의학적 위급(호흡·가슴·의식)",
  fall_injury: "낙상·부상",
  medication_error: "약물 오남용",
  suicidal: "자해·자살 위험",
  bleeding: "출혈",
  severe_pain: "심한 통증",
  dizziness_help: "어지럼·도움 요청",
  weakness_trend: "누적 무기력",
  appetite_loss: "식욕 저하",
  sleep_distress: "수면 곤란",
};

/**
 * 응급 분류(EmergencyCategory) 밖에서 같은 알림 경로를 쓰는 분류.
 *   인지 변화 추세(C2, lib/health/cognitive-alert)가 notifyGuardian을 재사용한다 — 라벨이 없으면 "위급 신호"로
 *   나가 추세 알림이 응급처럼 읽혔다(2026-10-07 재검토).
 */
const OTHER_NOTICE_KO: Record<string, string> = {
  cognitive_decline: "인지 변화 추세",
};

/** 알림·화면용 라벨. 모르는 값이면 일반 문구 — 코드를 그대로 내보내지 않는다 */
export function emergencyCategoryKo(category: string, fallback = "위급 신호"): string {
  return (EMERGENCY_CATEGORY_KO as Record<string, string>)[category] ?? OTHER_NOTICE_KO[category] ?? fallback;
}
