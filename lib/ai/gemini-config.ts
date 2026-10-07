/**
 * Gemini 생성 설정(샘플링·thinking) 단일 출처 — 모델 세대에 맞는 필드만 골라 돌려준다.
 *
 * 왜 필요한가(2026-10-07 Google 공지):
 *   · 다음 세대 Gemini부터 thinkingBudget을 담은 요청은 400 INVALID_ARGUMENT로 거부된다.
 *     (지금의 3.x는 thinkingBudget을 thinking_level로 바꿔 받아 주지만, 새 모델부터는 바꿔 주지 않는다)
 *   · temperature·topP·topK도 새 모델에선 오류다. 3.6 Flash부터는 이미 **무시**되고 있다
 *     — 지금 3.8에 보내는 temperature는 요청 모양만 같을 뿐 효과가 없다.
 *   · 반대로 2.5는 thinkingLevel을 지원하지 않는다. 2.5에선 thinkingBudget·temperature가 실제로 듣는 값이다.
 *   호출부가 각자 리터럴을 보내면 env로 모델만 바꿨을 때 그 경로가 400으로 **조용히 멈춘다**(응급 백스톱은
 *   null, 분석기는 degraded, 분류기는 -1로 실패를 삼킨다). 그래서 모델 세대를 보고 한 곳에서 고른다.
 *
 * 규칙 — 모델 id의 **버전 숫자**로 판정한다(id 목록을 하드코딩하지 않는다: 새 접미 변형이 나와도 맞게).
 *   · 오늘 세대 = 2.x 전부 + 3.0~3.8 (-preview·-lite·-live·-tts·-native-audio 등 접미 무관, "models/" 접두 허용)
 *       → 호출부가 넘긴 값을 **그대로** 돌려준다(같은 키·같은 값·같은 thinkingConfig 모양 — 오늘 요청 불변).
 *   · 그 밖 = 3.9+·4+·"-latest" 별칭(gemini-flash-latest 등, 새 릴리스로 핫스왑된다)·판독 불가 id
 *       → temperature/topP/topK·thinkingBudget을 **빼고** thinkingConfig: { thinkingLevel }만 보낸다
 *         (호출부가 thinkingLevel: null이면 thinkingConfig도 **통째로 뺀다** — 그 모델의 기본 수준).
 *   판독 불가를 새 쪽으로 보내는 이유: 오늘 쓰는 id는 전부 판독되고(테스트로 고정), 별칭은 결국 새 모델을
 *   가리킨다. 어느 쪽으로 틀려도 실패 모양은 같다(400) — 그렇다면 앞으로 남는 쪽에 맞춘다.
 *   id 속 탭·CR·LF는 **지우고** 판정한다: SDK는 모델 id를 URL 경로에만 싣고 WHATWG URL 파서가 이 세 문자를
 *   어디서든 지운다 — "gemini-2.5-flash\n"(env 값 끝 줄바꿈 등)은 오늘 그 모델로 성공하므로 오늘 필드를 계속
 *   받아야 한다(새 쪽으로 보내면 2.5가 모르는 thinkingLevel이 실려 400). 앞뒤 공백은 지우지 않는다 — URL에
 *   %20으로 남아 오늘도 404다(판독 불가 그대로).
 *
 * 새 모델용 thinkingLevel — 호출부가 명시한다(오늘 예산에 가장 가까우면서 **거부되지 않는** 값, 그런 수준이
 * 없으면 null = thinkingConfig 생략):
 *   | 오늘 thinkingBudget | 호출부                                  | 새 모델  | 근거
 *   |    0                | Live 토큰(app/api/live/token)           | null     | 생략 — 어느 수준을 골라도 거부하는 Live 모델이 있다: 3.8 Live는
 *   |                     |                                         | (생략)   |   thinkingLevel 자체를, 3.8 Live Extended Thinking은 minimal을 받지 않는다.
 *   |                     |                                         |          |   참고로 3.1 Flash Live는 생략 시 기본값이 minimal(오늘 예산 0의 의도와 같다)
 *   |   64                | STT 2곳(chat·observe)·정신건강 분류     | low      | minimal이 가장 가깝지만 3.7/3.8 Flash는 minimal을 400으로 거부
 *   |  128                | 프로필 추출                             | low      | 〃
 *   |  256                | 응급 백스톱                             | low      | 〃
 *   |  512                | 동반자(env 기본값)·요약 2곳·검진 채점  | low      | 예산을 둔 목적이 '사고 제한'(응답 지연·JSON 잘림 방지)
 *   | 1024                | 인지 분석기(lite·정밀 공용)             | low      | 〃 — medium은 3.8의 기본값이라 사실상 제한 해제 = 이 호출부가
 *   |                     |                                         |          |   겪었던 "thinking이 maxOutputTokens를 먹어 JSON이 잘림"의 재현
 *   텍스트 호출부가 전부 low인 이유: 실패를 삼키는 경로다 — minimal이 거부되면 "조용한 기능 정지"가 된다. 그래서
 *   지원표의 모든 텍스트 모델이 받는 low. Live만 null인 이유: 수준 하나를 고르면 위 표의 어느 Live 모델에선 반드시
 *   거부된다(토큰 발급이나 세션 연결이 실패한다). 생략하면 모델 기본 수준을 받으므로 지연은 모델마다 다르다 —
 *   LIVE_MODEL을 바꿀 땐 그 모델의 기본 수준을 확인하고 실기기로 첫 오디오 지연을 재측정할 것.
 *   (각 호출부가 넘기는 수준 리터럴은 __tests__/gemini-config-contract가 소스 구문 트리에서 읽어 고정한다)
 *
 * 근거(2026-10-07 확인):
 *   - SDK node_modules/@google/genai 1.50.1 genai.d.ts — ThinkingConfig { includeThoughts?, thinkingBudget?,
 *     thinkingLevel?: ThinkingLevel }, ThinkingLevel enum 값은 "MINIMAL"|"LOW"|"MEDIUM"|"HIGH"(대문자 — 문서의
 *     JS 예제도 ThinkingLevel.LOW). 런타임 dist/index.mjs는 thinkingConfig 객체를 **그대로 복사**해 보낸다
 *     (generateContent·Live 연결 모두) — SDK 변환 단계에서 걸러지지 않는다. temperature 등은 값이 없으면 안 보낸다.
 *     generateContent는 모델 id를 요청 본문이 아니라 URL 경로(_url.model, tModel)에만 싣고 new URL()로 주소를
 *     만든다 → 탭·CR·LF가 지워진다(node로 확인: "gemini-2.5-flash\n" → /v1beta/models/gemini-2.5-flash:generateContent,
 *     " gemini-2.5-flash" → /v1beta/models/%20gemini-2.5-flash:…). Live 토큰은 모델을 본문(liveConnectConstraints)에 싣는다
 *     — 거기선 정규화가 성공을 보장하지 않지만, 보내는 필드는 오늘과 같다.
 *   - 구 SDK @google/generative-ai 0.24.1 — GenerationConfig 타입엔 thinkingConfig가 없지만 generationConfig를
 *     그대로 실어 보낸다(타입만 막힘). app/·lib/엔 구 SDK 호출부가 없다(scripts의 일회성 도구만 쓴다).
 *   - https://ai.google.dev/gemini-api/docs/generate-content/thinking — 수준 지원표(3.8·3.7 Flash: minimal
 *     "Not supported (error)"·기본 medium / 3.6·3.5 Flash: minimal 지원 / 3.5·3.1 Flash-Lite: minimal 기본),
 *     "Gemini 2.5 series models don't support thinkingLevel; use thinkingBudget instead",
 *     "max_output_tokens … including thought tokens".
 *   - https://ai.google.dev/gemini-api/docs/live-guide — 3.1 Flash Live: minimal~high(기본 minimal) / 3.8 Live:
 *     thinkingLevel 미지원(생략) / 3.8 Live Extended Thinking: low~high(minimal 미지원).
 *   - https://ai.google.dev/gemini-api/docs/gemini-3 — "You cannot use both thinking_level and the legacy
 *     thinking_budget parameter in the same request" / Gemini 3는 temperature 기본값(1.0) 유지 권장.
 *
 * 불확실한 것(추정을 사실처럼 쓰지 않는다):
 *   - 3.x가 오늘 thinkingBudget을 **어느 수준으로** 바꿔 받는지는 공개된 기준표가 없다. 위 매핑은 "예산을 둔
 *     목적"에서 고른 값이지 오늘 3.8 동작의 복제가 아니다.
 *   - 미래 모델이 어떤 수준을 지원할지는 모른다. 최신 세대(3.7/3.8 Flash)가 minimal을 거부한다는 것만 안다.
 *   - thinkingLevel은 토큰 상한이 아니라 상대 수준이다. maxOutputTokens에 thinking이 포함되므로 새 모델로 바꿀
 *     땐 JSON 응답 호출부(분석기·요약·응급·검진·정신건강 분류)의 잘림과 품질을 실측해야 한다.
 */
import { ThinkingLevel, type GenerateContentConfig } from "@google/genai";

/** 새 모델에 보낼 thinking 수준 — Google 문서 표기(소문자). SDK enum으로는 여기서 바꾼다 */
export type GeminiThinkingLevel = "minimal" | "low" | "medium" | "high";

/** 호출부가 오늘 보내는 값 + 새 모델용 thinking 수준 */
export interface GeminiTuning {
  temperature?: number;
  topP?: number;
  topK?: number;
  thinkingBudget?: number;
  /**
   * 새 모델(3.9+·4+·별칭·판독 불가)에만 쓰인다 — 오늘 세대 요청엔 실리지 않는다.
   * null = 새 모델엔 thinkingConfig를 통째로 생략(모델 기본 수준) — 어느 수준을 골라도 거부하는 모델이 있는 호출부용(Live)
   */
  thinkingLevel: GeminiThinkingLevel | null;
}

/** config에 펼쳐 넣을 필드 — SDK 타입에서 따와 generateContent·Live 연결 config 양쪽에 그대로 맞는다 */
export type GeminiTuningFields = Pick<GenerateContentConfig, "temperature" | "topP" | "topK" | "thinkingConfig">;

const SDK_LEVEL: Record<GeminiThinkingLevel, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/** 오늘 세대의 마지막 버전 — 3.8까지는 thinkingBudget·temperature를 받는다(2026-10-07 공지 시점의 최신) */
const LAST_LEGACY = { major: 3, minor: 8 } as const;

/** "gemini-<major>[.<minor>]-<변형>" — 변형 자리에 버전 밖의 접미(-flash-live-preview 등)가 온다 */
const VERSIONED_ID = /^(?:models\/)?gemini-(\d+)(?:\.(\d+))?-[a-z0-9][a-z0-9.-]*$/;

/** WHATWG URL 파서가 어디서든 지우는 문자(탭·LF·CR) — 요청이 실제로 가는 모델로 판정하려고 같이 지운다 */
const URL_STRIPPED_CHARS = /[\t\n\r]/g;

/**
 * 모델 id → 버전. 판독 불가·별칭이면 null.
 *   "gemini-2.5-flash" → 2.5 / "models/gemini-3.1-flash-live-preview" → 3.1 / "gemini-3-flash-preview" → 3.0
 *   "gemini-2.5-flash\n"·"models/gemini-3.8-flash\t" → 2.5·3.8(탭·CR·LF는 지우고 본다 — 헤더 '규칙')
 *   "gemini-flash-latest"·"gemini-2.5-flash-latest" → null(별칭은 버전 숫자를 믿을 수 없다)
 *   " gemini-2.5-flash" → null(공백은 지우지 않는다 — 오늘도 404)
 */
export function parseGeminiVersion(model: string): { major: number; minor: number } | null {
  const id = model.replace(URL_STRIPPED_CHARS, "");
  const m = VERSIONED_ID.exec(id);
  if (!m || /-latest(?:-|$)/.test(id)) return null;
  return { major: Number(m[1]), minor: m[2] === undefined ? 0 : Number(m[2]) };
}

/** 오늘 세대(≤3.8)인가 — thinkingBudget·temperature·topP·topK를 아직 받는 범위 */
export function acceptsLegacyTuning(model: string): boolean {
  const v = parseGeminiVersion(model);
  if (!v) return false;
  return v.major < LAST_LEGACY.major || (v.major === LAST_LEGACY.major && v.minor <= LAST_LEGACY.minor);
}

/**
 * 호출부 config에 펼쳐 넣을 샘플링·thinking 필드.
 *   오늘 세대 → 넘긴 키만 그대로(없는 키를 undefined로 만들지 않는다 — 요청 모양까지 오늘과 같게)
 *   새 모델   → { thinkingConfig: { thinkingLevel } }만 — thinkingLevel이 null이면 {}(thinkingConfig 생략)
 */
export function geminiTuning(model: string, tuning: GeminiTuning): GeminiTuningFields {
  if (!acceptsLegacyTuning(model)) {
    if (tuning.thinkingLevel === null) return {};
    return { thinkingConfig: { thinkingLevel: SDK_LEVEL[tuning.thinkingLevel] } };
  }
  const fields: GeminiTuningFields = {};
  if (tuning.temperature !== undefined) fields.temperature = tuning.temperature;
  if (tuning.topP !== undefined) fields.topP = tuning.topP;
  if (tuning.topK !== undefined) fields.topK = tuning.topK;
  if (tuning.thinkingBudget !== undefined) fields.thinkingConfig = { thinkingBudget: tuning.thinkingBudget };
  return fields;
}
