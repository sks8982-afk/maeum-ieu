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
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

const SAFETY = COMPANION_SAFETY_SETTINGS;
const SIGNAL = expect.any(AbortSignal);
const SCHEMA = expect.objectContaining({ type: "OBJECT" });
const CLEAN_ANALYSIS = JSON.stringify({ isAnomaly: false, analysisNote: "", cognitiveChecks: [] });

/** 정확히 n번 불렸는지부터 — 0번이면 아래 단언이 undefined를 보고 엉뚱하게 실패한다 */
function expectCalls(n: number): Req[] {
  expect(calls.length, `Gemini 호출 횟수 (${calls.map((c) => c.model).join(", ")})`).toBe(n);
  return calls;
}

beforeEach(() => {
  calls.length = 0;
  replyText = "{}";
  for (const k of MODEL_ENVS) delete process.env[k];
});

describe("동반자 getTextModel — HEAD 그대로", () => {
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

  it("정신건강 답변 분류 (정규식이 못 잡는 답만 LLM)", async () => {
    await classifyAnswer("글쎄, 그게 어떻다고 해야 할지");
    const [c] = expectCalls(1);
    expect(c.model).toBe("gemini-2.5-flash");
    expect(c.config).toStrictEqual({
      temperature: 0, maxOutputTokens: 64, responseMimeType: "application/json", responseSchema: SCHEMA,
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
