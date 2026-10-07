/**
 * T3 응답 분류기 — 자연어 답변을 PHQ-9 빈도 점수(0~3)로 분류.
 * 1차: 정규식 fast-path (명확한 표현 — LLM 비용 0)
 * 2차: 경량 LLM(2.5-flash, responseSchema) — 모호한 답변만
 * -1 = 분류 불가(재질문 필요). 응답 원문은 어디에도 저장하지 않음.
 */
import { Type as SchemaType, type Schema } from "@google/genai";
import { COMPANION_SAFETY_SETTINGS, logUsage, getGenAI } from "@/lib/chat/llm";
import { geminiTuning } from "@/lib/ai/gemini-config";

// 순서 중요 — 강한 빈도(3)부터 검사 (예: "거의 매일"이 "며칠"보다 먼저)
const FAST_PATTERNS: Array<{ score: 0 | 1 | 2 | 3; pattern: RegExp }> = [
  { score: 3, pattern: /거의\s*매일|매일\s*(?:같이|그래|그랬|이야|이었)|맨날|밤낮없이|하루도\s*안?\s*빠짐|항상\s*그(?:래|랬)/ },
  { score: 2, pattern: /절반.{0,3}(?:이상|넘|쯤)|반\s*(?:은\s*)?(?:이상|넘)|일주일에\s*[4-7]|자주\s*그(?:래|랬)|꽤\s*많(?:이|은)/ },
  { score: 1, pattern: /며칠|몇\s*[일번]|가끔|종종|한두\s*[번일]|두세\s*[번일]|일주일에\s*[1-3]|드물게|조금\s*있/ },
  { score: 0, pattern: /전혀|하나도\s*없|없었|없어|아니(?:요|야|에요)?\s*[.!~]?$|안\s*그(?:래|랬)|그런\s*적\s*없|괜찮(?:아|았)/ },
];

export function classifyFast(answer: string): number {
  const t = answer.trim();
  if (!t) return -1;
  for (const { score, pattern } of FAST_PATTERNS) {
    if (pattern.test(t)) return score;
  }
  return -1;
}

const SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: { score: { type: SchemaType.INTEGER } },
  required: ["score"],
};

// ── 5점 동의 척도 (BFI-10): 0 전혀 아니다 ~ 4 매우 그렇다 ──
// 순서 중요 — 강한 표현 먼저("정말 그래"가 "그래"보다, "전혀"가 "아니"보다 앞서 판정)
const AGREE5_PATTERNS: Array<{ score: 0 | 1 | 2 | 3 | 4; pattern: RegExp }> = [
  { score: 4, pattern: /매우\s*그(?:래|렇|러)|정말\s*그(?:래|렇|러)|완전\s*(?:그래|맞)|딱\s*(?:나|내)\s*(?:얘기|이야기|모습)|아주\s*그(?:래|렇)|백\s*퍼|항상\s*그(?:래|렇)/ },
  { score: 0, pattern: /전혀\s*아니|절대\s*아니|하나도\s*안?\s*(?:맞|그)|정반대|전혀\s*안\s*그(?:래|렇)|말도\s*안\s*돼/ },
  { score: 3, pattern: /그런\s*편|그렇\s*[지긴]|맞는\s*것\s*같|맞아|그래\s*그래|대체로\s*그(?:래|렇)|좀\s*그(?:래|런|렇)|그렇다고\s*봐/ },
  { score: 1, pattern: /아닌\s*편|별로\s*안?\s*(?:그|맞)|잘\s*안\s*그(?:래|렇)|그렇진\s*않|아니(?:야|에요|지)?\s*[.!~]?$|안\s*맞(?:아|는)/ },
  { score: 2, pattern: /보통|반반|중간|그럴\s*때도\s*있|때에\s*따라|글쎄\s*반|어중간/ },
];

// ── 3점 빈도 척도 (UCLA-3): 1 거의 없다 / 2 가끔 / 3 자주 ──
const FREQ3_PATTERNS: Array<{ score: 1 | 2 | 3; pattern: RegExp }> = [
  { score: 3, pattern: /자주|맨날|매일|항상|늘\s*그(?:래|렇)|수시로|밤낮없이|허구한\s*날/ },
  { score: 1, pattern: /거의\s*없|전혀|별로\s*없|하나도\s*없|없어|없었|안\s*그(?:래|렇)|그런\s*적\s*없/ },
  { score: 2, pattern: /가끔|종종|때때로|이따금|어쩌다|간혹|있긴\s*(?:있|해)|좀\s*있/ },
];

export function classifyAgree5Fast(answer: string): number {
  const t = answer.trim();
  if (!t) return -1;
  for (const { score, pattern } of AGREE5_PATTERNS) if (pattern.test(t)) return score;
  return -1;
}

export function classifyFreq3Fast(answer: string): number {
  const t = answer.trim();
  if (!t) return -1;
  for (const { score, pattern } of FREQ3_PATTERNS) if (pattern.test(t)) return score;
  return -1;
}

const PROMPTS: Record<string, { prompt: string; min: number; max: number; fast: (a: string) => number }> = {
  freq4: {
    min: 0, max: 3, fast: classifyFast,
    prompt: `다음은 "지난 2주 동안 얼마나 자주 그랬는지" 묻는 설문에 대한 한국어 답변입니다.
답변을 빈도 점수로 분류하세요:
0 = 전혀 없었다 / 1 = 며칠 정도 / 2 = 2주의 절반 이상 / 3 = 거의 매일
답변이 빈도와 무관하거나(딴 얘기, 질문) 판단이 정말 불가능하면 -1.
주의: 부정("안 그래", "없어")은 0. 약한 긍정("좀 그랬어", "가끔")은 1. 강한 긍정("계속", "내내")은 3.`,
  },
  agree5: {
    min: 0, max: 4, fast: classifyAgree5Fast,
    prompt: `다음은 "이 말이 본인과 얼마나 맞는지" 묻는 성격 설문에 대한 한국어 답변입니다.
동의 정도를 분류하세요:
0 = 전혀 아니다 / 1 = 아닌 편이다 / 2 = 보통이다 / 3 = 그런 편이다 / 4 = 매우 그렇다
답변이 동의 여부와 무관하거나 판단이 정말 불가능하면 -1.
주의: 겸손한 부분 긍정("뭐 좀 그렇긴 하지")은 3. 망설이는 중립("글쎄, 반반인 것 같아")은 2.`,
  },
  freq3: {
    min: 1, max: 3, fast: classifyFreq3Fast,
    prompt: `다음은 "얼마나 자주 그렇게 느끼는지" 묻는 설문에 대한 한국어 답변입니다.
빈도를 분류하세요:
1 = 거의 없다 / 2 = 가끔 그렇다 / 3 = 자주 그렇다
답변이 빈도와 무관하거나 판단이 정말 불가능하면 -1.
주의: 부정("안 외로워", "없어")은 1. "요즘 들어 좀"같은 약한 긍정은 2.`,
  },
};

/**
 * answerType별 답변 분류 — 1차 정규식 fast-path(비용 0), 모호할 때만 경량 LLM.
 * 반환: 점수 또는 -1(분류 불가 → 재질문).
 */
export async function classifyAnswer(answer: string, answerType: "freq4" | "agree5" | "freq3" = "freq4"): Promise<number> {
  const cfg = PROMPTS[answerType] ?? PROMPTS.freq4;
  const fast = cfg.fast(answer);
  if (fast >= cfg.min) return fast;

  if (!process.env.GEMINI_API_KEY) return -1;
  try {
    const model = "gemini-2.5-flash";
    const res = await getGenAI().models.generateContent({
      model,
      contents: `${cfg.prompt}\nJSON {"score": n} 만 출력.\n\n답변: ${answer.slice(0, 200)}`,
      // ⚠ maxOutputTokens는 thinking을 포함한다(문서 "including thought tokens"). 예전 64는 예산(64)과 같아서
      //   thinking이 상한을 거의 다 먹고 JSON이 잘렸다 — 2026-10-07 실측(모호한 답 8개, freq4): LLM 경로 7개 중
      //   5개가 -1(재질문). 오류는 "Unterminated string in JSON"·"Unexpected end of JSON input"·"No number after
      //   minus sign", "Here is the JSON req…"로 시작한 응답 1건 / usage: thinking 34~53, 출력 0~6토큰.
      //   256 = 예산 64 + 출력 몫(불변식 maxOutputTokens ≥ thinkingBudget + 128 — __tests__/gemini-config-contract).
      //   예산 64는 ≤3.8 모델에만 실리고, 3.9+·4+·별칭은 thinkingLevel "low"(lib/ai/gemini-config — 토큰 상한이
      //   아님)가 된다 → 그 모델로 바꿀 땐 이 상한 안에서 JSON이 안 잘리는지 다시 실측할 것.
      config: { ...geminiTuning(model, { temperature: 0, thinkingBudget: 64, thinkingLevel: "low" }), maxOutputTokens: 256, responseMimeType: "application/json", responseSchema: SCHEMA, safetySettings: COMPANION_SAFETY_SETTINGS },
    });
    logUsage("mental-classify", res);
    const parsed = JSON.parse((res.text ?? "").trim()) as { score?: number };
    const s = typeof parsed.score === "number" ? Math.round(parsed.score) : -1;
    return s >= cfg.min && s <= cfg.max ? s : -1;
  } catch (e) {
    console.warn("[mental-scorer] classify error:", (e as Error).message);
    return -1;
  }
}

/** 기존 호출부 호환 (freq4 전용) */
export async function classifyFrequencyAnswer(answer: string): Promise<number> {
  return classifyAnswer(answer, "freq4");
}
