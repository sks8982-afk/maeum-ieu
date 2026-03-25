/**
 * 대화 완료 후 인지 평가를 수행하는 경량 분석기.
 * 메인 응답과 완전히 분리 — googleSearch 없이 JSON 전용 모델 사용.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { CognitiveAnalysisResult, CognitiveCheck } from "./types";
import { COGNITIVE_DOMAINS } from "./constants";

const PROMPT = `당신은 고령자 인지 기능 선별 전문가입니다.
아래 대화를 분석하여 결과를 JSON으로 반환하세요.

평가 영역: orientation_time, orientation_place, memory_immediate, memory_delayed, language, judgment
점수: 0(정상), 1(경계), 2(주의)

판단 기준:
- 사용자가 날짜/월/년도/요일을 명백히 틀리게 말했으면 → isAnomaly: true, orientation_time score 2
- 사용자가 현재 날씨와 명백히 다른 말을 했으면 → isAnomaly: true
- 사용자가 AI를 정정한 경우 → isAnomaly: false (AI가 틀렸을 수 있음)
- 근거 없으면 평가하지 마세요

JSON 형식:
{"isAnomaly": false, "analysisNote": "", "cognitiveChecks": []}
cognitiveChecks 항목: {"domain": "영역", "score": 0, "confidence": 0.8, "evidence": "근거", "note": "사유"}
`;

function parseResult(raw: string): CognitiveAnalysisResult {
  const empty: CognitiveAnalysisResult = { isAnomaly: false, analysisNote: "", cognitiveChecks: [] };
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) return empty;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;

    const result: CognitiveAnalysisResult = {
      isAnomaly: parsed.isAnomaly === true,
      analysisNote: typeof parsed.analysisNote === "string" ? parsed.analysisNote.slice(0, 500) : "",
      cognitiveChecks: [],
    };

    if (Array.isArray(parsed.cognitiveChecks)) {
      const valid = new Set<string>(COGNITIVE_DOMAINS);
      result.cognitiveChecks = (parsed.cognitiveChecks as Record<string, unknown>[])
        .filter((c) => typeof c.domain === "string" && valid.has(c.domain) && typeof c.score === "number")
        .map((c) => ({
          domain: c.domain as string,
          score: Math.min(2, Math.max(0, c.score as number)),
          confidence: typeof c.confidence === "number" ? Math.min(1, Math.max(0, c.confidence)) : 0.5,
          evidence: typeof c.evidence === "string" ? (c.evidence as string).slice(0, 500) : "",
          note: typeof c.note === "string" ? (c.note as string).slice(0, 500) : "",
        }));
    }
    return result;
  } catch {
    return empty;
  }
}

export async function analyzeCognitive(params: {
  userMessage: string;
  assistantResponse: string;
  historyText: string;
  envBlock: string;
}): Promise<CognitiveAnalysisResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { isAnomaly: false, analysisNote: "", cognitiveChecks: [] };

  try {
    const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { temperature: 0.2, maxOutputTokens: 300, responseMimeType: "application/json" },
    });

    const res = await model.generateContent(`${PROMPT}\n\n${params.envBlock}\n\n대화:\n${params.historyText}\n\n[이번 턴]\n사용자: ${params.userMessage}\nAI: ${params.assistantResponse}`);
    return parseResult(res.response.text().trim());
  } catch (e) {
    console.warn("Cognitive analyzer error:", e);
    return { isAnomaly: false, analysisNote: "", cognitiveChecks: [] };
  }
}
