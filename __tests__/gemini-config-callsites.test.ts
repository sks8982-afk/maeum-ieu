/**
 * 호출부 → 실제 요청 — lib 호출부(7개 파일·8곳)가 헬퍼 결과를 **실제로 요청 config에 싣는지**, 그리고 그 config가
 * 오늘(HEAD 53eb438)과 키 하나까지 같은지 본다.
 *
 * 왜 따로 필요한가: 헬퍼 단위 테스트(gemini-config.test.ts)는 "헬퍼가 무엇을 돌려주는가"만 본다. 호출부가
 *   결과를 펼치지 않거나(=temperature·thinking이 통째로 빠짐) 다른 값을 넘기면 거기선 녹색이다. 여기서는
 *   진짜 모듈을 그대로 돌리고 SDK 경계에서 요청을 받아 적는다.
 *
 * 목 체제: @google/genai의 GoogleGenAI만 바꾼다(원본을 펼친다 — ThinkingLevel·Type 등은 실물). lib/chat/llm의
 *   getGenAI 싱글톤이 이 클래스로 만들어지므로 모든 호출부가 같은 기록기를 탄다. prisma는 요약기의 조회만
 *   흉내내고, 응답("{}")은 쓰기 경로에 닿기 전에 끝나도록 골랐다.
 * 기대값: HEAD 소스의 config 리터럴을 그대로 옮겼다. 스키마·안전설정·시그널처럼 이번 변경이 건드리지 않은
 *   객체는 모양만 본다(expect.any / objectContaining).
 *   예외 1곳(의도한 변경): 정신건강 분류 maxOutputTokens 64→256 — 그 테스트의 주석 참고.
 * thinking 여유 불변식: 테스트마다 붙잡은 요청 **전부**(오늘 세대 모델)가 maxOutputTokens ≥ thinkingBudget + 128
 *   (또는 상한 없음)인지 afterEach가 본다 — 아래 headroomViolations 주석 참고.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Req = { model: string; config: Record<string, unknown> };
const calls: Req[] = [];
let replyText = "{}";

vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    models = {
      generateContent: async (req: Req) => { calls.push(req); return { text: replyText }; },
      generateContentStream: async (req: Req) => { calls.push(req); return (async function* () { /* 빈 스트림 */ })(); },
    };
  },
}));

/** 롤업이 읽는 주간 요약 4개 — 그 외 조회(중복 확인)는 빈 결과 */
const weekly = (i: number) => ({
  id: `s${i}`, summary: "요약", keyFacts: "{}", messageCount: 3, level: "weekly",
  periodStart: new Date(Date.UTC(2026, 8, 1 + i * 7)), periodEnd: new Date(Date.UTC(2026, 8, 7 + i * 7)),
});
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async (sql: string) => (sql.includes("parent_id IS NULL") ? [0, 1, 2, 3].map(weekly) : [])),
    $executeRawUnsafe: vi.fn(async () => 1),
    $transaction: vi.fn(async () => []),
  },
}));

// 모델·예산을 바꾸는 env는 비운 상태에서 시작한다(분석기 기본 모델은 import 시점에 읽힌다)
const MODEL_ENVS = ["COMPANION_MODEL", "COMPANION_PROBE_MODEL", "COMPANION_THINKING_BUDGET", "COGNITIVE_MODEL", "COGNITIVE_TWO_STAGE"];
for (const k of MODEL_ENVS) delete process.env[k];
process.env.GEMINI_API_KEY = "test-key";

const { getTextModel, COMPANION_SAFETY_SETTINGS } = await import("@/lib/chat/llm");
const { analyzeCognitive } = await import("@/lib/chat/cognitive-analyzer");
const { detectEmergencyLLM } = await import("@/lib/chat/emergency-llm");
const { summarizeMessages, rollupSummaries } = await import("@/lib/chat/summarizer");
const { extractWithLLM } = await import("@/lib/chat/profile-extractor-llm");
const { classifyAnswer } = await import("@/lib/health/mental-scorer");
const { scoreDomainAnswer } = await import("@/lib/screening/exam-runner");
const { acceptsLegacyTuning } = await import("@/lib/ai/gemini-config");

const SAFETY = COMPANION_SAFETY_SETTINGS;
const SIGNAL = expect.any(AbortSignal);
const SCHEMA = expect.objectContaining({ type: "OBJECT" });
const CLEAN_ANALYSIS = JSON.stringify({ isAnomaly: false, analysisNote: "", cognitiveChecks: [] });

/** 정확히 n번 불렸는지부터 — 0번이면 아래 단언이 undefined를 보고 엉뚱하게 실패한다 */
function expectCalls(n: number): Req[] {
  expect(calls.length, `Gemini 호출 횟수 (${calls.map((c) => c.model).join(", ")})`).toBe(n);
  return calls;
}

/**
 * 오늘 세대 thinking 여유 — SDK에 실제로 간 요청마다 maxOutputTokens가 없거나(모델 기본 상한) ≥ thinkingBudget + 128.
 *   maxOutputTokens는 thinking을 포함한다 — 모자라면 예산만큼 생각하다 상한에 닿아 답(JSON)이 잘린다.
 *   소스 계약(gemini-config-contract '오늘 세대 thinking 여유')은 헬퍼 결과가 펼쳐진 config 리터럴만 읽는다 — 그 config를
 *   다시 펼쳐 상한을 덮어쓰는 래퍼(getTextModel의 withTimeout 등)나 env 예산(COMPANION_THINKING_BUDGET)은 소스로 못
 *   따라간다. 여기선 SDK 경계에서 받은 값을 그대로 본다. 새 모델(thinkingLevel)엔 토큰 예산이 없어 대상이 아니다.
 *   128은 gemini-config-contract의 MIN_OUTPUT_HEADROOM과 같다 — 바꾸면 둘 다 바꿀 것.
 */
const MIN_OUTPUT_HEADROOM = 128;
function headroomViolations(reqs: Req[]): string[] {
  return reqs.filter((r) => acceptsLegacyTuning(r.model)).flatMap((r) => {
    const max = r.config.maxOutputTokens;
    const budget = (r.config.thinkingConfig as { thinkingBudget?: unknown } | undefined)?.thinkingBudget;
    const ok = max === undefined
      || (typeof max === "number" && typeof budget === "number" && max >= budget + MIN_OUTPUT_HEADROOM);
    return ok ? [] : [`${r.model} thinkingBudget=${JSON.stringify(budget)} maxOutputTokens=${JSON.stringify(max)}`];
  });
}

beforeEach(() => {
  calls.length = 0;
  replyText = "{}";
  for (const k of MODEL_ENVS) delete process.env[k];
});

afterEach(() => {
  // 🔒 걸린 요청은 답이 잘린다 — JSON 호출부는 파싱 실패를 삼켜 조용히 품질만 떨어진다(정신건강 분류 64/64: 7개 중 5개 -1)
  expect(headroomViolations(calls), "SDK에 간 요청의 thinking 여유 (maxOutputTokens ≥ thinkingBudget + 128)").toEqual([]);
});

describe("thinking 여유 검사기 — 공허하지 않다", () => {
  it("상한 < 예산+128·예산 없는 상한·숫자 아닌 상한은 잡고, 경계·상한 없음·새 모델은 통과", () => {
    const req = (model: string, config: Record<string, unknown>): Req => ({ model, config });
    expect(headroomViolations([
      req("gemini-2.5-flash", { maxOutputTokens: 64, thinkingConfig: { thinkingBudget: 64 } }),
      req("gemini-2.5-flash", { maxOutputTokens: 192, thinkingConfig: { thinkingBudget: 64 } }),
      req("gemini-3.8-flash", { maxOutputTokens: 1024 }),
      req("gemini-2.5-flash", { maxOutputTokens: "256", thinkingConfig: { thinkingBudget: 64 } }),
      req("gemini-2.5-flash", { thinkingConfig: { thinkingBudget: 512 } }),
      req("gemini-4-flash", { maxOutputTokens: 64, thinkingConfig: { thinkingLevel: "LOW" } }),
    ])).toEqual([
      "gemini-2.5-flash thinkingBudget=64 maxOutputTokens=64",
      "gemini-3.8-flash thinkingBudget=undefined maxOutputTokens=1024",
      "gemini-2.5-flash thinkingBudget=64 maxOutputTokens=\"256\"",
    ]);
  });
});

describe("동반자 getTextModel — HEAD 그대로", () => {
  // thinkingBudget 512 = COMPANION_THINKING_BUDGET 기본값. gemini-config-contract의 ENV_BUDGET_DEFAULT가 이 값을
  //   빌려 thinking 여유 불변식을 본다(env 예산은 소스에서 못 읽는다) — 기본값을 바꾸면 둘 다 바꿀 것.
  const base = {
    temperature: 0.7, maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 512 },
    safetySettings: SAFETY, tools: undefined, abortSignal: SIGNAL,
  };

  it("수다 턴(2.5) · 비캐시", async () => {
    await getTextModel("SYS", false).generateContent("안녕");
    const [c] = expectCalls(1);
    expect(c.model).toBe("gemini-2.5-flash");
    expect(c.config).toStrictEqual({ systemInstruction: "SYS", ...base });
  });

  it("확인 턴(3.8) — temperature를 무시하는 모델이어도 오늘은 같은 요청을 보낸다", async () => {
    await getTextModel("SYS", false, undefined, true).generateContent("안녕");
    const [c] = expectCalls(1);
    expect(c.model).toBe("gemini-3.8-flash");
    expect(c.config).toStrictEqual({ systemInstruction: "SYS", ...base });
  });

  it("명시적 캐시 · 검색 on · 스트리밍 경로도 같은 값", async () => {
    await getTextModel("", true, "cachedContents/abc").generateContentStream("안녕");
    const [c] = expectCalls(1);
    expect(c.config).toStrictEqual({ cachedContent: "cachedContents/abc", ...base, tools: [{ googleSearch: {} }] });
  });

  it("COMPANION_THINKING_BUDGET은 그대로 실린다 (A/B 튜닝 경로 유지)", async () => {
    process.env.COMPANION_THINKING_BUDGET = "300";
    await getTextModel("SYS", false).generateContent("안녕");
    expect(expectCalls(1)[0].config.thinkingConfig).toStrictEqual({ thinkingBudget: 300 });
  });

  it.each([
    ["1920", 1920],   // 경계 — 1920 이하는 그대로(오늘과 같은 요청)
    ["5000", 1920],   // 상한 2048 − 여유 128 = 1920으로 자른다
  ] as const)("COMPANION_THINKING_BUDGET=%s → thinkingBudget %i (1921 이상이면 답 쓸 자리가 없다 → 잘림·폴백 문구)", async (env, budget) => {
    process.env.COMPANION_THINKING_BUDGET = env;
    await getTextModel("SYS", false).generateContent("안녕");
    const [c] = expectCalls(1);
    // 🔒 자르는 쪽은 예산이다 — 상한(maxOutputTokens 2048)과 나머지 키는 그대로
    expect(c.config).toStrictEqual({ systemInstruction: "SYS", ...base, thinkingConfig: { thinkingBudget: budget } });
  });

  it.each([
    ["COMPANION_MODEL", "gemini-4-flash", false],
    ["COMPANION_PROBE_MODEL", "gemini-flash-latest", true],
  ] as const)("%s=%s 로 올리면 temperature·thinkingBudget 없이 thinkingLevel LOW", async (env, model, probe) => {
    process.env[env] = model;
    await getTextModel("SYS", false, undefined, probe).generateContent("안녕");
    const [c] = expectCalls(1);
    expect(c.model).toBe(model);
    expect(c.config).toStrictEqual({
      systemInstruction: "SYS", maxOutputTokens: 2048, thinkingConfig: { thinkingLevel: "LOW" },
      safetySettings: SAFETY, tools: undefined, abortSignal: SIGNAL,
    });
  });
});

describe("인지 분석기 — lite(2.5)·정밀(3.8) 공용 config", () => {
  const today = {
    temperature: 0, maxOutputTokens: 2048, responseMimeType: "application/json", responseSchema: SCHEMA,
    thinkingConfig: { thinkingBudget: 1024 }, safetySettings: SAFETY, abortSignal: SIGNAL,
  };
  const turn = { userMessage: "오늘 날씨가 참 좋네", assistantResponse: "그러게요, 산책하기 좋은 날이에요.", historyText: "", envBlock: "" };

  it("확인 턴 → 정밀 3.8", async () => {
    replyText = CLEAN_ANALYSIS;
    await analyzeCognitive({ ...turn, probeContext: true });
    const [c] = expectCalls(1);
    expect(c.model).toBe("gemini-3.8-flash");
    expect(c.config).toStrictEqual(today);
  });

  it("수다 턴 → lite 2.5 (이상 없음이면 승급 없음)", async () => {
    replyText = CLEAN_ANALYSIS;
    await analyzeCognitive({ ...turn, probeContext: false });
    const [c] = expectCalls(1);
    expect(c.model).toBe("gemini-2.5-flash");
    expect(c.config).toStrictEqual(today);
  });

  it("COGNITIVE_MODEL=gemini-3.9-flash 면 정밀 채점은 thinkingLevel LOW (temperature 없음)", async () => {
    process.env.COGNITIVE_MODEL = "gemini-3.9-flash";
    replyText = CLEAN_ANALYSIS;
    await analyzeCognitive({ ...turn, probeContext: true });
    const [c] = expectCalls(1);
    expect(c.model).toBe("gemini-3.9-flash");
    expect(c.config).toStrictEqual({
      maxOutputTokens: 2048, responseMimeType: "application/json", responseSchema: SCHEMA,
      thinkingConfig: { thinkingLevel: "LOW" }, safetySettings: SAFETY, abortSignal: SIGNAL,
    });
  });
});

describe("나머지 호출부 — HEAD 리터럴 그대로", () => {
  it("응급 백스톱", async () => {
    await detectEmergencyLLM("수면제를 모아뒀다가 한 번에 먹을까 싶어");
    const [c] = expectCalls(1);
    expect(c.model).toBe("gemini-2.5-flash");
    expect(c.config).toStrictEqual({
      temperature: 0, maxOutputTokens: 1024, responseMimeType: "application/json", responseSchema: SCHEMA,
      thinkingConfig: { thinkingBudget: 256 }, safetySettings: SAFETY, abortSignal: SIGNAL,
    });
  });

  const summaryToday = {
    temperature: 0.2, maxOutputTokens: 3072, responseMimeType: "application/json", responseSchema: SCHEMA,
    thinkingConfig: { thinkingBudget: 512 }, safetySettings: SAFETY, abortSignal: SIGNAL,
  };

  it("주간 요약", async () => {
    await summarizeMessages({
      userId: "u-12345678", conversationId: "c-1",
      messages: [{ id: "m1", role: "user", content: "오늘 손주가 놀러 왔어", createdAt: new Date("2026-10-01T01:00:00Z") }],
    });
    const [c] = expectCalls(1);
    expect(c.model).toBe("gemini-2.5-flash");
    expect(c.config).toStrictEqual(summaryToday);
  });

  it("요약 롤업", async () => {
    await rollupSummaries({ userId: "u-12345678", conversationId: "c-1", childLevel: "weekly" });
    const [c] = expectCalls(1);
    expect(c.model).toBe("gemini-2.5-flash");
    expect(c.config).toStrictEqual(summaryToday);
  });

  it("프로필 추출 (타임아웃 없음 — HEAD도 없었다)", async () => {
    await extractWithLLM({ userId: "u-1", userMessage: "우리 큰아들 이름은 철수고 지금 서울에 살고 있어" });
    const [c] = expectCalls(1);
    expect(c.model).toBe("gemini-2.5-flash");
    expect(c.config).toStrictEqual({
      temperature: 0.1, maxOutputTokens: 1024, responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 128 }, safetySettings: SAFETY,
    });
  });

  it("정신건강 답변 분류 (정규식이 못 잡는 답만 LLM) — maxOutputTokens만 64→256(의도한 변경)", async () => {
    await classifyAnswer("글쎄, 그게 어떻다고 해야 할지");
    const [c] = expectCalls(1);
    expect(c.model).toBe("gemini-2.5-flash");
    expect(c.config).toStrictEqual({
      // ⚠ HEAD(53eb438)는 maxOutputTokens 64. maxOutputTokens는 thinking을 포함해서 예산 64와 같은 상한으론
      //   JSON이 잘렸다 — 2026-10-07 실측: LLM 경로 답 7개 중 5개가 -1(재질문, thinking 34~53·출력 0~6토큰).
      //   256으로 올린 것만 다르고 나머지 키·값(thinkingBudget 64 포함)은 HEAD 그대로다.
      temperature: 0, maxOutputTokens: 256, responseMimeType: "application/json", responseSchema: SCHEMA,
      thinkingConfig: { thinkingBudget: 64 }, safetySettings: SAFETY,
    });
  });

  it("검진 채점", async () => {
    await scoreDomainAnswer("orientation_time", "올해가 2026년이고 가을이지", "오늘: 2026-10-07 화요일");
    const [c] = expectCalls(1);
    expect(c.model).toBe("gemini-2.5-flash");
    expect(c.config).toStrictEqual({
      temperature: 0, maxOutputTokens: 1024, responseMimeType: "application/json", responseSchema: SCHEMA,
      thinkingConfig: { thinkingBudget: 512 }, safetySettings: SAFETY, abortSignal: SIGNAL,
    });
  });
});
