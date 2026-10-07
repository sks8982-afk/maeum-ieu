/**
 * 오늘 세대(≤3.8) thinking 여유 — 테스트 공용 단일 출처(상수 하나, 사본 없음).
 *
 * maxOutputTokens는 thinking 토큰을 **포함**한다(문서 "including thought tokens"). 예산만큼 생각하고도 답(JSON)을
 *   끝까지 쓸 몫이 남아야 한다 — 정신건강 분류가 64/64로 보내다 2026-10-07 실측에서 LLM 경로 답 7개 중 5개를
 *   잘린 JSON으로 잃었다(-1 → 재질문). 새 모델(thinkingLevel)엔 토큰 예산이 없어 대상이 아니다.
 *
 * 쓰는 곳:
 *   · gemini-config-contract — 소스 구문 트리에서 읽은 (예산, 상한) 쌍에 MIN_OUTPUT_HEADROOM을 쓴다
 *   · SDK 경계에서 붙잡은 실요청 — afterEach마다 headroomViolations: gemini-config-callsites(lib 호출부)·
 *     chat-stt-tuning·observe-turn-gates(STT)·live-token-gates(Live 토큰의 liveConnectConstraints)
 *   lib/chat/llm.ts도 같은 128로 동반자 예산 천장을 정한다(2048 − 128) — 이 값을 바꾸면 그 상수도 볼 것.
 */
import { acceptsLegacyTuning } from "@/lib/ai/gemini-config";

export const MIN_OUTPUT_HEADROOM = 128;

/** SDK 경계에서 받아 적은 요청 — 모델 id + config (Live 토큰이면 liveConnectConstraints의 model·config) */
export type CapturedRequest = { model: string; config: Record<string, unknown> };

/**
 * 오늘 세대 요청마다: maxOutputTokens가 없거나(모델 기본 상한), 있으면 thinkingBudget이 0 이상의 숫자이고
 *   maxOutputTokens ≥ thinkingBudget + 128. 예산이 없거나 음수(-1 = 동적 thinking)면 상한 안에서 얼마나 생각할지
 *   정해지지 않는다 → 위반. 위반마다 "모델 thinkingBudget=… maxOutputTokens=…".
 */
export function headroomViolations(reqs: readonly CapturedRequest[]): string[] {
  return reqs.filter((r) => acceptsLegacyTuning(r.model)).flatMap((r) => {
    const max = r.config.maxOutputTokens;
    const budget = (r.config.thinkingConfig as { thinkingBudget?: unknown } | undefined)?.thinkingBudget;
    const ok = max === undefined || (typeof max === "number" && typeof budget === "number" && budget >= 0
      && max >= budget + MIN_OUTPUT_HEADROOM);
    return ok ? [] : [`${r.model} thinkingBudget=${JSON.stringify(budget)} maxOutputTokens=${JSON.stringify(max)}`];
  });
}
