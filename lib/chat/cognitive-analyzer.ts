/**
 * 텍스트 채팅 스트리밍 완료 후 비동기로 인지 평가를 수행하는 모듈.
 * 사용자 경험에 영향 없이 백그라운드에서 실행됨.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CognitiveCheck } from "./types";
import { COGNITIVE_DOMAINS } from "./constants";

const ANALYSIS_PROMPT = `당신은 고령자 인지 기능 선별 전문가입니다.
아래 대화를 분석하여 인지 평가가 가능한 항목이 있으면 기록하세요.

평가 가능한 6개 영역:
- orientation_time: 시간 지남력 (날짜/요일/계절 관련 발화)
- orientation_place: 장소 지남력 (현재 위치/동네 관련 발화)
- memory_immediate: 즉시 기억력 (5분 내 대화 내용 기억 여부)
- memory_delayed: 지연 기억력 (이전 대화 내용 기억 여부)
- language: 언어 유창성 ("그거","저기" 과다 사용, 단어 찾기 어려움, 문장 반복)
- judgment: 판단력 (상황에 맞지 않는 판단, 현실과 동떨어진 발화)

점수 기준:
- 0: 정상 (해당 영역에서 문제 없음)
- 1: 경계 (약간의 혼동이나 반복 패턴)
- 2: 주의 (명백한 인지 오류)

중요 원칙:
- 평가할 근거가 없는 영역은 포함하지 마세요.
- 단순한 깜빡함이나 일반적 노화는 정상(0)입니다.
- 사용자가 AI를 정정한 경우는 절대 인지 오류로 기록하지 마세요.
- 근거 없이 추측하지 마세요. 확실한 관찰만 기록하세요.

JSON 배열로만 응답하세요:
[{"domain":"영역명","score":0,"confidence":0.7,"evidence":"근거 발화","note":"판단 사유"}]
평가할 것이 없으면 빈 배열 [] 을 반환하세요.`;

/** cognitiveChecks 배열을 안전하게 파싱 */
function parseCognitiveChecksFromArray(raw: string): CognitiveCheck[] {
  try {
    const trimmed = raw.trim();
    // [...] 배열 추출
    const start = trimmed.indexOf("[");
    const end = trimmed.lastIndexOf("]");
    if (start === -1 || end === -1) return [];

    const arr = JSON.parse(trimmed.slice(start, end + 1)) as unknown[];
    if (!Array.isArray(arr)) return [];

    const validDomains = new Set<string>(COGNITIVE_DOMAINS);

    return arr
      .filter((item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null &&
        typeof (item as Record<string, unknown>).domain === "string" &&
        validDomains.has((item as Record<string, unknown>).domain as string) &&
        typeof (item as Record<string, unknown>).score === "number",
      )
      .map((item) => ({
        domain: item.domain as string,
        score: Math.min(2, Math.max(0, item.score as number)),
        confidence: typeof item.confidence === "number" ? Math.min(1, Math.max(0, item.confidence)) : 0.5,
        evidence: typeof item.evidence === "string" ? String(item.evidence).slice(0, 500) : "",
        note: typeof item.note === "string" ? String(item.note).slice(0, 500) : "",
      }));
  } catch {
    return [];
  }
}

/**
 * 대화 내용을 기반으로 인지 평가를 수행.
 * 스트리밍 응답 완료 후 비동기로 호출됨.
 */
export async function analyzeCognitive(params: {
  userMessage: string;
  assistantResponse: string;
  historyText: string;
  environmentInfo: string;
}): Promise<CognitiveCheck[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];

  const { userMessage, assistantResponse, historyText, environmentInfo } = params;

  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      temperature: 0.3, // 분석은 낮은 temperature로 일관성 확보
      maxOutputTokens: 200,
      responseMimeType: "application/json",
    },
  });

  const prompt = `${ANALYSIS_PROMPT}

${environmentInfo}

대화 내역:
${historyText}

[이번 턴]
사용자: ${userMessage}
AI: ${assistantResponse}

위 대화에서 인지 평가가 가능한 항목을 JSON 배열로 반환하세요.`;

  const res = await model.generateContent(prompt);
  const raw = res.response.text().trim();

  return parseCognitiveChecksFromArray(raw);
}
