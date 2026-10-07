/**
 * 전문가 검진 상태머신 러너 — 영역별 표준 문항을 순서대로 시행하고, 답변을 항목별 0~배점으로 채점.
 * 진행은 영역 단위(한 번에 한 영역 배터리 질문), 채점은 항목 단위(정식 점수). 음성 미시행(시공간) 제외.
 */
import { CIST_ITEMS, buildExamOrder, CIST_DOMAIN_ORDER, VOICE_MAX_POINTS, type CistItem } from "./cist-bank";
import { getGenAI, COMPANION_SAFETY_SETTINGS, logUsage, LLM_TIMEOUT_MS, timeoutSignal } from "@/lib/chat/llm";
import { geminiTuning } from "@/lib/ai/gemini-config";
import { Type as SchemaType, type Schema } from "@google/genai";

const SCORER_MODEL = "gemini-2.5-flash";

export { VOICE_MAX_POINTS };

/** 검진 영역 시행 순서(시드로 매 검진 변형, 타당성 제약 유지). */
export function buildExamPlan(seed: string): string[] {
  return buildExamOrder(seed);
}

export function domainLabel(domain: string): string {
  return CIST_DOMAIN_ORDER.find((d) => d.domain === domain)?.label ?? domain;
}

export function itemsForDomain(domain: string): CistItem[] {
  return CIST_ITEMS.filter((i) => i.domain === domain && i.voice);
}

/** 한 영역의 문항(들)을 검사자가 읽을 한 번의 질문으로 렌더. */
export function renderDomainBattery(domain: string): string {
  return itemsForDomain(domain).map((i) => i.prompt).join(" ");
}

/** 영역 배점 합(만점). */
export function domainMaxPoints(domain: string): number {
  return itemsForDomain(domain).reduce((s, i) => s + i.points, 0);
}

// 무응답 영역 재질문용 — 더 쉽고 부드러운 대체 표현(예비문항). 같은 영역을 다시 묻되 표현을 낮춤.
const DOMAIN_REASK: Record<string, string> = {
  orientation_time: "천천히 생각하셔도 괜찮아요. 올해가 몇 년도일까요? 지금은 무슨 계절인가요?",
  orientation_place: "지금 계신 여기가 어디인지 편하게 말씀해 주세요. 무슨 동네, 어떤 곳인가요?",
  memory_immediate: "제가 단어 세 개를 천천히 다시 불러드릴게요 — ‘나무, 자동차, 모자’. 따라서 말씀해 보세요.",
  attention_calculation: "괜찮아요, 천천히 하셔도 돼요. 100에서 7을 빼고, 거기서 또 7씩 빼 나가 보실까요? (93, 86 …처럼요)",
  memory_delayed: "조금 전에 외워 두시라고 한 단어가 있었죠. 하나라도 생각나는 게 있으면 말씀해 주세요.",
  language: "제가 짧은 문장을 천천히 말할게요 — ‘백문이 불여일견’. 그대로 따라 해 보세요.",
  judgment: "기차하고 자전거, 둘 다 어디에 쓰는 물건일까요? 편하게 떠오르는 대로 말씀해 주세요.",
};

/** 응답이 사실상 없음(빈 응답·부호만·거부) — 무응답 처리/재질문 트리거. '모르겠다'는 응답으로 간주(=시도, 0점). */
export function isNonResponse(answer: string): boolean {
  const a = (answer || "").trim();
  const stripped = a.replace(/[\s.,…·~!?\-‘’"']/g, "");
  if (stripped.length === 0) return true; // 빈 응답 또는 "..." 같은 부호만
  if (/^(그만|안\s*할|안\s*해|안\s*하|싫|패스|관둬|관둘|됐어|됐다|하기\s*싫|그만하)/.test(a)) return true; // 명시적 거부
  return false;
}

/** 무응답 영역 재질문 — 더 쉬운 표현(없으면 원 문항). */
export function renderDomainReask(domain: string): string {
  return DOMAIN_REASK[domain] || renderDomainBattery(domain);
}

const SCORE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    scores: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          itemId: { type: SchemaType.STRING },
          score: { type: SchemaType.INTEGER },
          reason: { type: SchemaType.STRING },
        },
        required: ["itemId", "score"],
      },
    },
  },
  required: ["scores"],
};

export interface ItemScore {
  itemId: string; domain: string; label: string; prompt: string; answer: string;
  score: number; max: number; reason: string;
  /**
   * 채점이 **수행되지 않았음**(0점과 구별). 집계에서 제외하고 커버리지를 낮춰야 한다.
   *
   * 결함(2026-10-01 확증): LLM 채점이 1회 실패하면 그 영역 **모든 항목을 0점**으로 반환하고
   *   route.ts가 이를 '응답한 영역'으로 카운트해 total_score·eval_band를 계산하며
   *   coverage_status는 'ok'로 남겼다. 의사는 화면에서 **가짜 인지장애 근거**를 보게 된다.
   */
  unscored?: true;
}

/**
 * 한 영역 답변을 항목별로 채점(0~배점). 무응답·거부·딴소리는 0점. 채점 실패 시 0점 처리.
 * env: 오늘 날짜/계절/요일 등 환경(시간 지남력 채점에 필수 — 없으면 연도·요일 정답 판정 불가).
 * 장소 지남력은 환자 실제 위치를 시스템이 모르므로 "검사자 확인 필요"로 보수 채점(구체·일관 답변만 인정).
 */
export async function scoreDomainAnswer(domain: string, answer: string, env?: string): Promise<ItemScore[]> {
  const items = itemsForDomain(domain);
  const base = (score: number, reason: string): ItemScore[] =>
    items.map((i) => ({ itemId: i.id, domain, label: domainLabel(domain), prompt: i.prompt, answer, score, max: i.points, reason }));

  const apiKey = process.env.GEMINI_API_KEY;
  // 무응답은 0점이 맞다(환자가 답하지 못함). 키 없음은 '미채점'이다(시스템 문제).
  if (!answer.trim()) return base(0, "무응답");
  if (!apiKey) return base(0, "채점 불가(키 미설정)").map((r) => ({ ...r, unscored: true as const }));

  const envBlock = env ? `\n[채점 기준 환경 — 정답 판정에 사용]\n${env}\n` : "";
  const placeNote = domain === "orientation_place"
    ? "\n⚠ 장소 지남력: 시스템은 환자의 실제 위치를 모릅니다. 답변이 구체적이고 일관된 한국 지명·장소면 정답으로 인정(검사자가 최종 확인). '모르겠다'·무응답·비현실적이면 0점.\n"
    : "";
  const itemSpec = items.map((i) => `- ${i.id} (배점 ${i.points}): 문항 "${i.prompt}" / 채점기준: ${i.scoring}`).join("\n");

  /**
   * 지연회상 채점에 **등록 자극**을 명시 주입 (2026-10-01 결함 수정).
   *
   * itemsForDomain(domain)은 현재 영역 항목만 담으므로, memory_delayed 채점 프롬프트에는
   * "아까 외워 두시라고 한 단어 세 개가 무엇이었습니까?"와 채점기준만 들어가고
   * **정답 단어(나무·자동차·모자)는 어디에도 없었다** — 그 단어는 다른 영역 항목(mi_words)의
   * prompt에만 존재한다. 그래서 "사과, 바나나, 포도"에도 3점을 줄 수 있었고 정답을 말해도
   * 확신 없이 0점이 될 수 있었다. 치매 선별에서 판별력이 가장 높은 항목이 사실상 무작위였다.
   */
  const recallWords: string[] = (() => {
    if (domain !== "memory_delayed") return [];
    const reg = CIST_ITEMS.find((i) => i.id === "mi_words");
    if (!reg) return [];
    const m = /[‘'"“]([^’'"”]+)[’'"”]/.exec(reg.prompt);
    return m?.[1]?.split(/\s*,\s*/).map((w) => w.trim()).filter(Boolean) ?? [];
  })();

  const recallAnswerBlock = (() => {
    if (!recallWords.length) return "";
    const list = recallWords;
    return `
⛔⛔ [지연회상 채점 규칙 — 가장 중요] 환자가 외웠어야 하는 정답 단어는 **정확히 다음 ${list.length}개**입니다:
${list.map((w, i) => `  ${i + 1}. ${w}`).join("\n")}
- 환자 답변에서 **위 목록과 같은 단어**만 1개당 1점으로 세세요. 위 목록에 없는 단어는 **몇 개를 말했든 0점**입니다.
- 예: 정답이 "${list.join(", ")}"일 때 환자가 전혀 다른 단어 ${list.length}개를 말하면 → **0점**
  ("세 단어를 모두 회상했다"고 판단하면 안 됩니다. 단어가 일치해야 회상입니다.)
- 반드시 환자 답변의 각 단어를 위 목록과 하나씩 대조한 뒤 점수를 정하세요.
- 이 정답 목록은 채점 전용입니다 — reason에 정답 단어를 나열하지 마세요.
`;
  })();

  const prompt = `당신은 표준 인지선별검사(MMSE-K/MoCA-K/CIST) 채점자입니다. 아래 문항들에 대한 환자 답변을 각 채점기준대로 채점하세요.
- 무응답·거부·딴 얘기·"모르겠다"는 0점.
- 각 항목 점수는 0 이상 배점 이하 정수. 부분정답은 채점기준대로.
- 답변에 여러 문항이 섞여 있으면 각 문항에 해당하는 부분만 보고 채점.
- 시간 지남력(연도·계절·월·일·요일)은 위 환경의 오늘 날짜와 대조해 정답 판정.${envBlock}${placeNote}${recallAnswerBlock}
[문항]
${itemSpec}

[환자 답변]
"${answer.slice(0, 600)}"

JSON으로만: {"scores":[{"itemId":"...","score":N,"reason":"간단근거"}]}`;

  // 일시 오류(503/429/타임아웃)에 최대 3회 재시도 — 1회 실패로 영역이 미채점되는 것을 줄인다.
  //   (기존에는 재시도 없이 1회 실패 → 영역 전체 0점이 환자 기록에 확정됐다)
  const callScorer = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await getGenAI().models.generateContent({
          model: SCORER_MODEL,
          contents: prompt,
          // 예산 512는 ≤3.8 모델에만 실린다 — 3.9+·4+·별칭은 thinkingLevel "low"(lib/ai/gemini-config, 토큰 상한 아님:
          //   그 모델로 바꿀 땐 maxOutputTokens 1024 안에서 JSON이 안 잘리는지와 채점 일치도를 실측)
          config: { ...geminiTuning(SCORER_MODEL, { temperature: 0, thinkingBudget: 512, thinkingLevel: "low" }), maxOutputTokens: 1024, responseMimeType: "application/json", responseSchema: SCORE_SCHEMA, safetySettings: COMPANION_SAFETY_SETTINGS, abortSignal: timeoutSignal(LLM_TIMEOUT_MS.background) },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const transient = /\b(503|429)\b|Service Unavailable|overloaded|RESOURCE_EXHAUSTED|fetch failed|ECONNRESET|ETIMEDOUT|deadline|abort/i.test(msg);
        if (transient && attempt < 2) {
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  };

  try {
    const res = await callScorer();
    logUsage("exam-scorer", res);
    const parsed = JSON.parse((res.text ?? "{}").trim()) as { scores?: { itemId: string; score: number; reason?: string }[] };
    const map = new Map((parsed.scores ?? []).map((s) => [s.itemId, s]));

    /**
     * 지연회상 정답 단어를 reason에서 가린다.
     *
     * 채점 프롬프트에 "reason에 정답을 나열하지 마세요"라고 지시해도 LLM이 무시했다(실측).
     * reason은 exam_item_score에 저장되어 의사 화면에 표시되는데, 어딘가로 노출되면
     * 그 세션 이후의 지연회상 검사가 무효화된다. 코드로 결정적으로 제거한다.
     */
    const redact = (reason: string): string => {
      if (domain !== "memory_delayed" || !recallWords.length) return reason;
      let out = reason;
      for (const w of recallWords) out = out.split(w).join("○○");
      return out;
    };

    return items.map((i) => {
      const s = map.get(i.id);
      const score = s ? Math.max(0, Math.min(i.points, Math.round(Number(s.score) || 0))) : 0;
      return { itemId: i.id, domain, label: domainLabel(domain), prompt: i.prompt, answer, score, max: i.points, reason: redact(s?.reason ?? "") };
    });
  } catch (e) {
    // ⚠ 0점이 아니라 **미채점**으로 반환 — 0점으로 기록하면 환자 기록에 가짜 인지장애 근거가 남는다.
    console.warn(`[exam-scorer] ${domain} 채점 실패(재시도 소진) — 미채점 처리:`, e instanceof Error ? e.message : e);
    return base(0, "채점 실패(미채점)").map((r) => ({ ...r, unscored: true as const }));
  }
}
