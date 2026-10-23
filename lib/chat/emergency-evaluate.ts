/**
 * 응급 평가 — 정규식 → LLM 백스톱 → **L1 24시간 누적 승격**. 모든 발화 진입점이 이것 하나를 쓴다.
 *
 * 왜 공유 모듈인가 (2026-10-06 적대 감사):
 *   이 3단계가 /api/chat 안에만 온전히 있었다. 상시 감시(/api/observe/turn)와 Live(/api/live/turn)는
 *   정규식·백스톱만 각자 복사해 두고 **승격 단계를 빠뜨렸다.** 그래서 두 경로에서는
 *   "입맛이 하나도 없어"·"기운이 하나도 없어"·"며칠째 잠을 못 자" 같은 L1을 하루 종일 말해도
 *   보호자에게 아무것도 가지 않았다. L1 규칙은 처음부터 "누적되면 L2"를 전제로 만든 신호라,
 *   승격이 없는 경로에서 L1 카테고리는 **죽은 규칙**이다.
 *   상시 감시는 대화가 어려운 어르신용이라 /api/chat에서 대신 승격될 기회도 거의 없고,
 *   Live가 기본 음성 경로가 되면(베타 on) 추세 알림이 모든 사용자에게서 소리 없이 사라진다.
 *   각자 구현하면 다음 경로도 같은 단계를 빠뜨린다(가이드 F3) — 그래서 한 함수로 모은다.
 *   (emergency-last-resort를 뽑아낸 것과 같은 이유다.)
 *
 * 동작은 /api/chat의 기존 evaluateEmergency와 **동일**하다(그대로 옮겼다):
 *   - L3·L2·0: 그대로
 *   - L1: 같은 대화의 최근 24시간 L1 수 + 이번 1건이 3 이상이면 effectiveLevel 2로 승격
 *     (승격된 발화는 2로 저장되므로 이후 L1 집계에서는 빠진다 — 기존 설계)
 *   - 집계 조회가 실패하면 승격하지 않는다(다음 L1에서 다시 평가). 집계 실패로 발화 처리
 *     전체가 무너지면 L2·L3 안전망까지 같이 잃기 때문이다.
 */
import { detectEmergencyDetailed, buildEmergencyL2Hint, shouldEscalateL1ToL2, type EmergencyResult } from "./emergency";
import { confirmEmergencyLLM, detectEmergencyLLM } from "./emergency-llm";
import { countRecentL1Signals } from "./messages";

export interface EmergencyEvaluation {
  /** 감지 결과(카테고리·근거). 승격돼도 원래 카테고리를 유지한다 */
  result: EmergencyResult;
  /** 저장·알림·응답 분기에 쓰는 실효 등급 — L1 누적 승격이 반영된 값 */
  effectiveLevel: 0 | 1 | 2 | 3;
  /** L2일 때 동반자 프롬프트에 붙일 지시(대화 경로만 사용) */
  hint: string;
}

/**
 * 1단계 — 정규식 → (L2 미만이면) LLM 백스톱. **DB를 치지 않는다**.
 *   정규식이 놓친 과소감지 꼬리(사투리·완곡어·어순 변형)를 백스톱이 잡는다.
 *   정규식이 L2 미만일 때만 + 사전필터 통과 시에만 LLM 호출(평범한 대화는 비용·지연 0).
 *   ⚠ (2026-10-19) 예전엔 none일 때만 불렀다. 그래서 "기운이 하나도 없고 숨이 너무 차"·"입맛이 하나도 없고 피를 토했어"처럼
 *   앞의 L1(관찰) 표현이 잡히면 뒤의 급성 신호가 있어도 백스톱이 아예 안 불렸다(독립 검토). 백스톱은 L2 이상만 돌려주므로
 *   L1을 태워도 올리기만 하고, 백스톱이 아니라고 하면 L1을 그대로 둔다(누적 승격은 2단계가 그대로 한다).
 *   (2026-10-22) **재확인** — 정규식이 L2+를 찾았는데 맥락 가드(남의 이야기·지난 일·꿈·TV·화투·음식 손질·관용·손주의 가벼운 상처)가
 *   지웠으면(suppressed) 사전필터 없이 백스톱에 다시 묻는다. '아님'일 때만 내리고, 위급이거나 **모름(키 없음·장애·시간 초과·파싱
 *   실패)이면 정규식 판정을 지킨다**. 예전엔 가드가 지우면 사전필터에 걸린 말만 백스톱이 받았고 백스톱이 실패하면 알림이 사라졌다
 *   ("TV 보다가 갑자기 입이 돌아갔어"는 사전필터에도 없어 알림 0). 실측: 맥락 낱말이 섞인 진짜 위급 80문장 × 3회를 모두 위급으로
 *   봤고(240/240), 이야기 60문장은 157/180을 '아님'으로 봤다(scripts/eval-backstop-category.ts … confirm).
 */
export async function detectWithBackstop(userContent: string): Promise<EmergencyResult> {
  const { result, suppressed } = detectEmergencyDetailed(userContent);
  // 가드가 지운 판정은 가드 켠 결과가 L1·L2여도 먼저 다시 묻는다 — L2에서 멈추면 지워진 L3가 재확인 없이 L2로 내려갔다(10-22 저녁 검토)
  if (suppressed) {
    const verdict = await confirmEmergencyLLM(userContent, suppressed.evidence).catch(() => ({ kind: "error" as const }));
    if (verdict.kind === "none") return result;
    // 위급이면 정규식 판정(근거·분류)을 쓰되 백스톱이 더 높게 보면 그쪽 — 모름이면 정규식 판정을 지킨다.
    //   백스톱 등급을 그대로 쓰지 않는 까닭(10-22 실측): 맥락 낱말이 섞인 진짜 위급 240회 중 43회를 백스톱이 '위급이지만 L2'로 봤다
    //   ("며느리가 내 발음이 이상하대"·"딸이 그러는데 아까 내가 약을 두 번 먹었대" — 뇌졸중 징후·과다 복용은 119 안내가 바로 나가야 한다).
    //   대신 이야기에 백스톱이 L2라고 한 것도 L3로 나간다(이야기 180회 중 17회) — 안전 쪽을 골랐다.
    return verdict.kind === "emergency" && verdict.result.level > suppressed.level ? verdict.result : suppressed;
  }
  if (result.level >= 2) return result;
  // 백스톱이 throw해도 정규식 판정으로 — 최후 안전망도 이 함수를 쓴다(거기서 예외가 새면 안전망째 무너진다)
  return (await detectEmergencyLLM(userContent).catch(() => null)) ?? result;
}

/**
 * 2단계 — L1이면 같은 대화의 최근 24시간 L1 수(+이번 1건)로 L2 승격 여부를 정한다.
 *   집계 조회가 실패하면 승격하지 않는다(다음 L1에서 다시 평가) — 집계 실패로 발화 처리 전체가
 *   무너지면 L2·L3 안전망까지 같이 잃는다.
 */
export async function applyL1Escalation(result: EmergencyResult, conversationId: string | undefined): Promise<0 | 1 | 2 | 3> {
  if (result.level !== 1 || !conversationId) return result.level;
  const recent = await countRecentL1Signals(conversationId).catch(() => null);
  // 현재 발화 1건이 곧 저장될 예정이므로 +1로 평가
  return recent !== null && shouldEscalateL1ToL2(recent + 1) ? 2 : 1;
}

/** 대화 경로용 — 1·2단계를 한 번에 + L2 프롬프트 지시 */
export async function evaluateEmergency(params: {
  userContent: string;
  conversationId: string | undefined;
}): Promise<EmergencyEvaluation> {
  const result = await detectWithBackstop(params.userContent);
  const effectiveLevel = await applyL1Escalation(result, params.conversationId);
  // 발화는 감지기가 본 글 — 화상 말이면 힌트에 식히는 말 한 줄을 더한다(2026-10-23)
  const hint = effectiveLevel === 2 ? buildEmergencyL2Hint(result.category, result.evidence, params.userContent) : "";
  return { result, effectiveLevel, hint };
}
