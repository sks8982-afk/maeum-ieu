/**
 * lib/ai/gemini-config — 모델 세대별 샘플링·thinking 필드 선택.
 *
 * 왜(2026-10-07 Google 공지): 다음 세대 Gemini는 thinkingBudget·temperature·topP·topK가 담긴 요청을
 *   400으로 거부한다. 2.5는 반대로 thinkingLevel을 모른다. 헬퍼의 계약은 두 방향이고 둘 다 고정한다:
 *   (A) ZERO-DIFF — 오늘 쓰는 모델·값이면 **오늘 보내는 필드와 완전히 같다**(키·값·thinkingConfig 모양).
 *       기대값은 HEAD(53eb438) 호출부 소스에서 옮겨 적은 리터럴이다 — 헬퍼 출력으로 기대값을 만들면
 *       헬퍼가 바뀌어도 녹색이 된다.
 *   (B) 새 모델 — 3.9+·4+·별칭·판독 불가엔 temperature/topP/topK·thinkingBudget이 **하나도** 없고
 *       thinkingLevel만 있다.
 *   호출부가 이 값을 실제로 config에 싣는지는 gemini-config-callsites·라우트 테스트가 본다.
 */
import { describe, it, expect } from "vitest";
import { ThinkingLevel } from "@google/genai";
import { geminiTuning, acceptsLegacyTuning, parseGeminiVersion, type GeminiTuning } from "@/lib/ai/gemini-config";

/**
 * 호출부별 오늘(HEAD 53eb438) 값. `today`는 그 소스의 config 리터럴에서 해당 키만 옮긴 것.
 *   args = 호출부가 헬퍼에 넘기는 값(오늘 리터럴 + 새 모델용 thinkingLevel).
 */
const CALL_SITES: { site: string; models: string[]; args: GeminiTuning; today: Record<string, unknown> }[] = [
  {
    site: "app/api/chat/route.ts transcribeAudio (STT_MODEL 기본값)",
    models: ["gemini-2.5-flash"],
    args: { temperature: 0, thinkingBudget: 64, thinkingLevel: "low" },
    today: { temperature: 0, thinkingConfig: { thinkingBudget: 64 } },
  },
  {
    site: "app/api/observe/turn/route.ts transcribe (STT_MODEL 기본값)",
    models: ["gemini-2.5-flash"],
    args: { temperature: 0, thinkingBudget: 64, thinkingLevel: "low" },
    today: { temperature: 0, thinkingConfig: { thinkingBudget: 64 } },
  },
  {
    site: "app/api/live/token/route.ts liveConnectConstraints (LIVE_MODEL 기본값)",
    models: ["gemini-3.1-flash-live-preview"],
    args: { thinkingBudget: 0, thinkingLevel: "minimal" },
    today: { thinkingConfig: { thinkingBudget: 0 } },   // temperature를 보낸 적 없다 — 키가 생기면 안 된다
  },
  {
    site: "lib/chat/llm.ts getTextModel (수다 2.5 / 확인 턴 3.8, COMPANION_THINKING_BUDGET 기본 512)",
    models: ["gemini-2.5-flash", "gemini-3.8-flash"],
    args: { temperature: 0.7, thinkingBudget: 512, thinkingLevel: "low" },
    today: { temperature: 0.7, thinkingConfig: { thinkingBudget: 512 } },
  },
  {
    site: "lib/chat/cognitive-analyzer.ts buildAnalyzerModel (lite 2.5 / 정밀 3.8)",
    models: ["gemini-2.5-flash", "gemini-3.8-flash"],
    args: { temperature: 0, thinkingBudget: 1024, thinkingLevel: "low" },
    today: { temperature: 0, thinkingConfig: { thinkingBudget: 1024 } },
  },
  {
    site: "lib/chat/emergency-llm.ts detectEmergencyLLM",
    models: ["gemini-2.5-flash"],
    args: { temperature: 0, thinkingBudget: 256, thinkingLevel: "low" },
    today: { temperature: 0, thinkingConfig: { thinkingBudget: 256 } },
  },
  {
    site: "lib/chat/summarizer.ts summarizeMessages·rollupSummaries",
    models: ["gemini-2.5-flash"],
    args: { temperature: 0.2, thinkingBudget: 512, thinkingLevel: "low" },
    today: { temperature: 0.2, thinkingConfig: { thinkingBudget: 512 } },
  },
  {
    site: "lib/chat/profile-extractor-llm.ts extractWithLLM",
    models: ["gemini-2.5-flash"],
    args: { temperature: 0.1, thinkingBudget: 128, thinkingLevel: "low" },
    today: { temperature: 0.1, thinkingConfig: { thinkingBudget: 128 } },
  },
  {
    site: "lib/health/mental-scorer.ts classifyAnswer",
    models: ["gemini-2.5-flash"],
    args: { temperature: 0, thinkingBudget: 64, thinkingLevel: "low" },
    today: { temperature: 0, thinkingConfig: { thinkingBudget: 64 } },
  },
  {
    site: "lib/screening/exam-runner.ts scoreDomainAnswer",
    models: ["gemini-2.5-flash"],
    args: { temperature: 0, thinkingBudget: 512, thinkingLevel: "low" },
    today: { temperature: 0, thinkingConfig: { thinkingBudget: 512 } },
  },
  {
    site: "scripts/probe-compliance.ts judgeProbe (심판)",
    models: ["gemini-2.5-flash"],
    args: { temperature: 0, thinkingBudget: 64, thinkingLevel: "low" },
    today: { temperature: 0, thinkingConfig: { thinkingBudget: 64 } },
  },
  {
    site: "scripts/ab-thinking-budget.ts judge (심판)",
    models: ["gemini-2.5-flash"],
    args: { temperature: 0, thinkingBudget: 256, thinkingLevel: "low" },
    today: { temperature: 0, thinkingConfig: { thinkingBudget: 256 } },
  },
];

/** 오늘 세대 — 지금 쓰거나 env로 바꿔 넣을 수 있는 id들(접미 변형 포함) */
const LEGACY_IDS = [
  "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-2.0-flash",
  "gemini-2.5-flash-preview-09-2025", "gemini-2.5-flash-native-audio-preview-12-2025", "gemini-2.5-flash-preview-tts",
  "gemini-3-flash-preview", "gemini-3-pro-image",
  "gemini-3.1-flash-live-preview", "gemini-3.1-flash-tts-preview", "gemini-3.1-flash-lite", "gemini-3.1-pro-preview",
  "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.5-transcribe-live",
  "gemini-3.6-flash", "gemini-3.7-flash",
  "gemini-3.8-flash", "gemini-3.8-live", "gemini-3.8-live-extended-thinking", "gemini-3.8-flash-tts",
  "models/gemini-2.5-flash", "models/gemini-3.8-flash",
];

/** 새 모델·별칭·판독 불가 — 전부 thinkingLevel 쪽으로 가야 한다 */
const NEW_OR_UNKNOWN_IDS = [
  "gemini-3.9-flash", "gemini-3.9-flash-lite", "gemini-3.10-flash",       // 3.10은 문자열 비교면 3.8보다 '작다'
  "gemini-4-flash", "gemini-4.0-pro", "gemini-4.1-flash-live-preview", "gemini-10-flash",
  "gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest", "models/gemini-flash-latest",
  "gemini-2.5-flash-latest",                                                // 버전이 붙어도 별칭은 핫스왑된다
  "", "gemini", "gemini-2.5", "gemini-exp-1206", "gemini-3.8.1-flash", "GEMINI-2.5-FLASH", " gemini-2.5-flash",
  "gemini-nano-banana-2.1", "gemini-omni-1.1-flash", "gpt-4o", "tunedModels/my-model",
];

const SAMPLING_KEYS = ["temperature", "topP", "topK"] as const;

describe("모델 세대 판정 — 버전 숫자로", () => {
  it.each(LEGACY_IDS)("오늘 세대: %s", (id) => {
    expect(acceptsLegacyTuning(id)).toBe(true);
  });

  it.each(NEW_OR_UNKNOWN_IDS)("새 모델·별칭·판독 불가: %j", (id) => {
    expect(acceptsLegacyTuning(id)).toBe(false);
  });

  it("버전은 숫자로 비교한다 (3.10 > 3.8, 3 = 3.0)", () => {
    expect(parseGeminiVersion("gemini-3.10-flash")).toStrictEqual({ major: 3, minor: 10 });
    expect(parseGeminiVersion("gemini-3-flash-preview")).toStrictEqual({ major: 3, minor: 0 });
    expect(parseGeminiVersion("models/gemini-2.5-flash")).toStrictEqual({ major: 2, minor: 5 });
    expect(parseGeminiVersion("gemini-flash-latest")).toBeNull();
  });
});

describe("(A) ZERO-DIFF — 오늘 쓰는 모델은 오늘 보내는 필드 그대로", () => {
  const rows = CALL_SITES.flatMap((c) => c.models.map((model) => [c.site, model, c.args, c.today] as const));

  it.each(rows)("%s · %s", (_site, model, args, today) => {
    // 🔒 toStrictEqual — 키 하나(temperature: undefined 포함)라도 생기거나 빠지면 요청 모양이 달라진 것
    expect(geminiTuning(model, args)).toStrictEqual(today);
  });

  it("오늘 세대에선 thinkingLevel을 절대 싣지 않는다 (2.5는 thinkingLevel을 모른다 — 문서: \"don't support thinkingLevel\")", () => {
    for (const [, model, args] of rows) {
      const out = geminiTuning(model, args);
      expect(out.thinkingConfig, model).not.toHaveProperty("thinkingLevel");
    }
  });

  it("넘기지 않은 키는 만들지 않고, 넘긴 topP·topK는 그대로 싣는다", () => {
    expect(geminiTuning("gemini-2.5-flash", { thinkingLevel: "low" })).toStrictEqual({});
    expect(geminiTuning("gemini-3.8-flash", { temperature: 1, topP: 0.9, topK: 40, thinkingBudget: 128, thinkingLevel: "high" }))
      .toStrictEqual({ temperature: 1, topP: 0.9, topK: 40, thinkingConfig: { thinkingBudget: 128 } });
  });
});

describe("(B) 새 모델 — 샘플링·thinkingBudget 없이 thinkingLevel만", () => {
  it.each(NEW_OR_UNKNOWN_IDS)("%j — 호출부 전부", (model) => {
    for (const { site, args } of CALL_SITES) {
      const out = geminiTuning(model, args);
      for (const k of SAMPLING_KEYS) expect(out, `${site}: ${k}`).not.toHaveProperty(k);
      expect(out.thinkingConfig, site).not.toHaveProperty("thinkingBudget");
      // 🔒 thinkingBudget과 thinkingLevel을 같이 보내도 오류(문서) — thinkingConfig엔 thinkingLevel 하나만
      expect(out, site).toStrictEqual({ thinkingConfig: { thinkingLevel: expect.any(String) } });
    }
  });

  it("호출부가 고른 수준이 SDK enum 값으로 실린다 (SDK 타입: ThinkingLevel = \"MINIMAL\"|\"LOW\"|…)", () => {
    expect(geminiTuning("gemini-4-flash", { temperature: 0, thinkingBudget: 64, thinkingLevel: "low" }))
      .toStrictEqual({ thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } });
    expect(geminiTuning("gemini-4-flash-live", { thinkingBudget: 0, thinkingLevel: "minimal" }))
      .toStrictEqual({ thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } });
    expect(geminiTuning("gemini-flash-latest", { thinkingLevel: "medium" }))
      .toStrictEqual({ thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM } });
    expect(geminiTuning("gemini-3.9-pro", { topP: 0.5, topK: 3, thinkingLevel: "high" }))
      .toStrictEqual({ thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH } });
  });

  it("호출부별 새 모델 수준 — 매핑표(lib/ai/gemini-config 헤더)와 같다", () => {
    const levelOf = (site: string) => CALL_SITES.find((c) => c.site.startsWith(site))!.args.thinkingLevel;
    // Live만 minimal(실패가 화면에 드러나는 경로·지연 우선), 실패를 삼키는 텍스트 경로는 전부 거부되지 않는 low
    expect(levelOf("app/api/live/token")).toBe("minimal");
    for (const c of CALL_SITES.filter((x) => !x.site.startsWith("app/api/live/token"))) {
      expect(c.args.thinkingLevel, c.site).toBe("low");
    }
  });
});

describe("입력 불변", () => {
  it("넘긴 객체를 바꾸지 않고, 매번 새 객체를 돌려준다", () => {
    const args = Object.freeze({ temperature: 0, thinkingBudget: 64, thinkingLevel: "low" as const });
    const a = geminiTuning("gemini-2.5-flash", args);
    const b = geminiTuning("gemini-2.5-flash", args);
    expect(a).not.toBe(b);
    expect(a.thinkingConfig).not.toBe(b.thinkingConfig);
    expect(args).toStrictEqual({ temperature: 0, thinkingBudget: 64, thinkingLevel: "low" });
  });
});
