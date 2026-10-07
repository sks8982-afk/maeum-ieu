/**
 * 소스 계약 — app/·lib/에서 Gemini 샘플링·thinking 키는 **헬퍼(lib/ai/gemini-config) 인자 안에서만** 쓴다.
 *
 * 왜(2026-10-07 Google 공지): 다음 세대 모델은 thinkingBudget·temperature·topP·topK를 400으로 거부한다.
 *   호출부 하나가 리터럴로 직접 보내면, env로 모델을 올리는 날 그 경로만 조용히 멈춘다(응급 백스톱은 null,
 *   분석기는 degraded로 실패를 삼킨다). 새 호출부가 헬퍼를 건너뛰는 순간 여기서 빨간불이 켜져야 한다.
 *
 * 방식: 정규식이 아니라 TypeScript 구문 트리로 본다 — 주석·문자열 속 "temperature:"는 무시되고,
 *   객체 리터럴 키(축약형 포함)와 `cfg.temperature = …` 같은 사후 대입을 잡는다. 스캐너가 공허하지 않은지는
 *   아래 '스캐너 자체 검증'이, 실파일 사본에 낸 구멍을 잡는지는 '실파일 사본 변이'가 고정한다(정규식 게이트가
 *   아무것도 못 잡던 사고를 반복하지 않으려고). 스캐너는 helpers/gemini-source-scan — 이 파일은 계약 표와 테스트다.
 * 같은 구문 트리로 헬퍼 호출부가 적은 **새 모델용 thinkingLevel 리터럴**도 고정한다(텍스트 경로 low · Live null) —
 *   단위 테스트의 호출부 표는 사본이라, 실제 호출부가 바뀌어도 녹색이었다.
 * 그리고 오늘 세대에 싣는 예산의 여유 불변식: maxOutputTokens ≥ thinkingBudget + 128(라우팅된 호출부 전부).
 *   상한·예산을 정할 수 있는 꼴 중 숫자로 확인되지 않는 것(축약형·계산된 키·다른 펼침·숫자 아닌 값·-1 같은 식)은
 *   원문을 드러내며 실패한다 — '상한 없음'은 상한이 어떤 꼴로도 없고 헬퍼 결과 말고는 펼침도 없을 때뿐이다.
 *   닫힘: app/·lib/의 maxOutputTokens는 **전부** 그렇게 검증된 행이어야 한다 — config를 다시 펼쳐 덮어쓰거나
 *   (`{ ...cfg, maxOutputTokens: 128 }`) 사후 대입·Object.assign으로 고치는 곳은 행이 아니라서 위반으로 드러난다.
 *   래퍼(getTextModel 등)·env 예산처럼 소스로 못 따라가는 값은 SDK 경계의 실요청으로 본다 — gemini-config-callsites
 *   (lib)·chat-stt-tuning·observe-turn-gates·live-token-gates(app 라우트). 검사기와 128은 helpers/gemini-headroom 하나다.
 * 요청 지점 인벤토리: app/·lib/의 SDK 요청(models.generateContent·generateContentStream·authTokens.create·live.connect)은
 *   라우팅된 파일과 허용 목록(이유를 적은 2곳)에만 있다. 헬퍼는 import로 확인한다 — 별칭·네임스페이스 import면
 *   스캐너가 호출을 못 알아보므로(금지 키·수준·여유 검사를 건너뛴다) 그 자체가 위반이다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  HELPER_FILE, listSources, parse, findRawTuningKeys, countHelperCalls, countRequestSites, helperImport, helperLevels,
  thinkingHeadroom, rowHeadroomViolations, capOccurrences, capClosureViolations,
} from "@/__tests__/helpers/gemini-source-scan";

const ROOTS = ["app", "lib"];

/**
 * 헬퍼로 라우팅된 호출부 — 하나라도 빠지면 그 파일이 헬퍼를 우회했다는 뜻.
 *   역방향도 본다: app/·lib/에서 헬퍼 호출이 있는 파일·호출 수가 이 표와 정확히 같아야 한다(아래 인벤토리) —
 *   표 밖의 새 호출부는 thinkingLevel·thinking 여유 검사를 받지 않고 지나가기 때문이다.
 */
const ROUTED_FILES: Record<string, number> = {
  "app/api/chat/route.ts": 1,
  "app/api/observe/turn/route.ts": 1,
  "app/api/live/token/route.ts": 1,
  "lib/chat/llm.ts": 1,
  "lib/chat/cognitive-analyzer.ts": 1,
  "lib/chat/emergency-llm.ts": 1,
  "lib/chat/summarizer.ts": 2,
  "lib/chat/profile-extractor-llm.ts": 1,
  "lib/health/mental-scorer.ts": 1,
  "lib/screening/exam-runner.ts": 1,
};

/**
 * 라우팅된 파일의 SDK 요청 지점 수 — 키는 ROUTED_FILES와 같다(아래 인벤토리 테스트가 고정). 헬퍼 호출 수와는 다를 수
 *   있다: 동반자는 헬퍼 결과 하나를 generateContent·generateContentStream 두 요청에 싣는다.
 */
const ROUTED_REQUEST_SITES: Record<string, number> = {
  "app/api/chat/route.ts": 1,
  "app/api/observe/turn/route.ts": 1,
  "app/api/live/token/route.ts": 1,
  "lib/chat/llm.ts": 2,
  "lib/chat/cognitive-analyzer.ts": 1,
  "lib/chat/emergency-llm.ts": 1,
  "lib/chat/summarizer.ts": 2,
  "lib/chat/profile-extractor-llm.ts": 1,
  "lib/health/mental-scorer.ts": 1,
  "lib/screening/exam-runner.ts": 1,
};
/**
 * 헬퍼 없이 요청하는 파일 — "이 요청엔 모델 세대별로 갈라야 할 필드가 없다"는 판단과 그 이유. 여기 올라 있어도
 *   샘플링·thinking 키를 싣는 순간 금지 키 스캔이, maxOutputTokens를 싣는 순간 닫힘 검사가 잡는다.
 */
const REQUEST_ALLOWLIST: Record<string, number> = {
  // Gemini TTS(Cloud TTS 실패 시 폴백): config가 responseModalities·speechConfig뿐이다 — 새 세대가 400으로 거부할
  //   샘플링·thinking 필드도, thinking과 나눠 쓸 maxOutputTokens도 없다(오디오 출력). 모델은 TTS 전용 목록(GEMINI_TTS_MODELS).
  "app/api/tts/route.ts": 1,
  // Live 브라우저 연결(ai.live.connect): 서버가 발급한 토큰으로 붙고 model·callbacks만 넘긴다. 세션 config(thinking 포함)는
  //   토큰의 liveConnectConstraints에 서버가 박아 두고 — 그 발급(app/api/live/token)이 헬퍼로 라우팅돼 있다 — 제약 연결에선
  //   클라 config가 무시된다(2026-06-12 전사 미수신으로 실증, live-voice.ts 주석).
  "app/chat/live-voice.ts": 1,
};

/**
 * 새 모델용 thinkingLevel — 호출부가 헬퍼 두 번째 인자에 **리터럴로** 적는 값(헬퍼 헤더 매핑표). 타입은 넷 다
 *   허용하므로 tsc는 못 막는다. 실패를 삼키는 텍스트 경로는 전부 "low"(3.7/3.8 Flash가 minimal을 400으로 거부 →
 *   조용히 멈춘다), Live 토큰만 null(수준을 하나 고르면 거부하는 Live 모델이 있다 → thinkingConfig 생략).
 */
const LIVE_ROUTE = "app/api/live/token/route.ts";
const expectedLevel = (file: string): string | null => (file === LIVE_ROUTE ? null : "low");

describe("스캐너 자체 검증 — 공허한 게이트가 아니다", () => {
  it("헬퍼를 건너뛴 리터럴은 키마다 잡는다", () => {
    const raw = `ai.models.generateContent({ model, config: { temperature: 0, maxOutputTokens: 9, thinkingConfig: { thinkingBudget: 64 } } });`;
    expect(findRawTuningKeys("x.ts", raw)).toEqual(["x.ts:1 temperature", "x.ts:1 thinkingConfig", "x.ts:1 thinkingBudget"]);
  });

  it("축약형·topP/topK·사후 대입·문자열 키도 잡는다", () => {
    const sneaky = [
      `const temperature = 0;`,
      `const a = { temperature, topP: 1, "topK": 2 };`,
      `cfg.thinkingConfig = { thinkingLevel: "LOW" };`,
      `cfg["temperature"] = 1;`,
    ].join("\n");
    expect(findRawTuningKeys("y.ts", sneaky)).toEqual([
      "y.ts:2 temperature", "y.ts:2 topP", "y.ts:2 topK",
      "y.ts:3 thinkingConfig", "y.ts:3 thinkingLevel",
      "y.ts:4 temperature",
    ]);
  });

  it("헬퍼 인자·주석·문자열·타입 선언은 허용한다", () => {
    const ok = [
      `const c = { ...geminiTuning(m, { temperature: 0, thinkingBudget: 64, thinkingLevel: "low" }), maxOutputTokens: 1 };`,
      `// temperature: 0, thinkingConfig: { thinkingBudget: 64 }`,
      `/* topP: 1 */ const s = "temperature: 0";`,
      `interface Cfg { temperature?: number; thinkingConfig?: unknown }`,
      `const w = data.current?.temperature_2m;`,
    ].join("\n");
    expect(findRawTuningKeys("z.tsx", ok)).toEqual([]);
  });

  it("헬퍼 호출마다 thinkingLevel 리터럴을 읽고, 리터럴이 아니면 원문을 드러낸다", () => {
    const src = [
      `const a = { ...geminiTuning(m, { thinkingBudget: 64, thinkingLevel: "low" }), maxOutputTokens: 1024 };`,
      `const b = { ...geminiTuning(m, { thinkingBudget: 0, thinkingLevel: null }) };`,
      `const c = geminiTuning(m, { thinkingLevel: lvl });`,
      `const d = geminiTuning(m, opts);`,
      `const e = geminiTuning(m, { thinkingLevel });`,
    ].join("\n");
    expect(helperLevels("s.ts", src)).toEqual(
      ["low", null, "<리터럴 아님: lvl>", "<리터럴 아님: opts>", "<리터럴 아님: { thinkingLevel }>"]);
  });

  it("thinking 여유 — 직접 펼침·변수 경유·상한 없음·읽을 수 없는 값을 호출부마다 읽고, 위반을 고른다", () => {
    const src = [
      `const a = { ...geminiTuning(m, { thinkingBudget: 64, thinkingLevel: "low" }), maxOutputTokens: 64 };`,
      `function f() {`,
      `  const t = geminiTuning(m, { thinkingBudget: 512, thinkingLevel: "low" });`,
      `  return [{ ...t, maxOutputTokens: 2048 }, { x: 1, ...t, maxOutputTokens: 600 }];`,
      `}`,
      `const c = { ...geminiTuning(m, { thinkingBudget: 0, thinkingLevel: null }) };`,
      `const d = { ...geminiTuning(m, { thinkingBudget: B, thinkingLevel: "low" }), maxOutputTokens: MAX };`,
      `const e = { ...geminiTuning(m, { thinkingLevel: "low" }), maxOutputTokens: 1024 };`,
      `use(geminiTuning(m, { thinkingBudget: 1, thinkingLevel: "low" }));`,
      `const g = { ...geminiTuning(m, { thinkingBudget: 64, thinkingLevel: "low" }), maxOutputTokens: 192 };`,
    ].join("\n");
    const rows = thinkingHeadroom("h.ts", src);
    expect(rows).toEqual([
      { at: "h.ts:1", budget: 64, maxOutputTokens: 64 },
      { at: "h.ts:3", budget: 512, maxOutputTokens: 2048 },
      { at: "h.ts:3", budget: 512, maxOutputTokens: 600 },
      { at: "h.ts:6", budget: 0, maxOutputTokens: Infinity },
      { at: "h.ts:7", budget: "B", maxOutputTokens: "MAX" },
      { at: "h.ts:8", budget: "<thinkingBudget 없음>", maxOutputTokens: 1024 },
      { at: "h.ts:9", budget: 1, maxOutputTokens: "<config를 못 찾음>" },
      { at: "h.ts:10", budget: 64, maxOutputTokens: 192 },
    ]);
    // 64+128=192는 경계 — 통과. 상한 없음(Live)도 통과
    expect(rowHeadroomViolations(rows)).toEqual([
      "h.ts:1 thinkingBudget=64 maxOutputTokens=64",
      "h.ts:3 thinkingBudget=512 maxOutputTokens=600",
      "h.ts:7 thinkingBudget=B maxOutputTokens=MAX",
      "h.ts:8 thinkingBudget=<thinkingBudget 없음> maxOutputTokens=1024",
      "h.ts:9 thinkingBudget=1 maxOutputTokens=<config를 못 찾음>",
    ]);
  });

  it("thinking 여유 — 축약형·다른 펼침·계산된 키·접근자는 원문으로 위반, '상한 없음'은 헬퍼 결과만 펼친 config뿐", () => {
    const T = `geminiTuning(m, { thinkingBudget: 64, thinkingLevel: "low" })`;
    const src = [
      `const a = { ...${T}, maxOutputTokens };`,
      `const b = { ...${T}, ...LIMITS };`,
      `const c = { ...${T}, maxOutputTokens: 256, ...LIMITS };`,
      `const d = { ...LIMITS, ...${T}, maxOutputTokens: 256 };`,
      `const e = { ...${T}, [K]: 64 };`,
      `const f = { ...${T}, get maxOutputTokens() { return 64; } };`,
      `function g() {`,
      `  const t = ${T};`,
      `  return { systemInstruction, ...t, tools };`,
      `}`,
      `const i = { ...geminiTuning(m, { thinkingBudget: 64, ...OVR, thinkingLevel: "low" }), maxOutputTokens: 256 };`,
      `const j = { ...geminiTuning(m, { thinkingBudget, thinkingLevel: "low" }), maxOutputTokens: 256 };`,
      `const k = { ...geminiTuning(m, opts), maxOutputTokens: 256 };`,
    ].join("\n");
    const rows = thinkingHeadroom("n.ts", src);
    expect(rows).toEqual([
      { at: "n.ts:1", budget: 64, maxOutputTokens: "maxOutputTokens" },
      { at: "n.ts:2", budget: 64, maxOutputTokens: "...LIMITS" },
      { at: "n.ts:3", budget: 64, maxOutputTokens: "...LIMITS" },
      { at: "n.ts:4", budget: 64, maxOutputTokens: "...LIMITS" },
      { at: "n.ts:5", budget: 64, maxOutputTokens: "[K]: 64" },
      { at: "n.ts:6", budget: 64, maxOutputTokens: "get maxOutputTokens() { return 64; }" },
      { at: "n.ts:8", budget: 64, maxOutputTokens: Infinity },
      { at: "n.ts:11", budget: "...OVR", maxOutputTokens: 256 },
      { at: "n.ts:12", budget: "thinkingBudget", maxOutputTokens: 256 },
      { at: "n.ts:13", budget: "<객체 리터럴 아님: opts>", maxOutputTokens: 256 },
    ]);
    // 다른 키의 축약형(systemInstruction·tools)과 헬퍼 결과 변수 펼침만 있는 config(8행)만 통과
    expect(rowHeadroomViolations(rows)).toEqual([
      "n.ts:1 thinkingBudget=64 maxOutputTokens=maxOutputTokens",
      "n.ts:2 thinkingBudget=64 maxOutputTokens=...LIMITS",
      "n.ts:3 thinkingBudget=64 maxOutputTokens=...LIMITS",
      "n.ts:4 thinkingBudget=64 maxOutputTokens=...LIMITS",
      "n.ts:5 thinkingBudget=64 maxOutputTokens=[K]: 64",
      "n.ts:6 thinkingBudget=64 maxOutputTokens=get maxOutputTokens() { return 64; }",
      "n.ts:11 thinkingBudget=...OVR maxOutputTokens=256",
      "n.ts:12 thinkingBudget=thinkingBudget maxOutputTokens=256",
      "n.ts:13 thinkingBudget=<객체 리터럴 아님: opts> maxOutputTokens=256",
    ]);
  });

  it("thinking 여유 — 상한이 식별자면 같은 파일 최상위 숫자 const만 읽는다 (let·계산식·가린 이름·선언 없음은 원문)", () => {
    const T = `geminiTuning(m, { thinkingBudget: 512, thinkingLevel: "low" })`;
    const src = [
      `const CAP = 2048;`,
      `let LET_CAP = 2048;`,
      `const EXPR_CAP = 1024 * 2;`,
      `const SHADOW = 2048;`,
      `const a = { ...${T}, maxOutputTokens: CAP };`,
      `const b = { ...${T}, maxOutputTokens: LET_CAP };`,
      `const c = { ...${T}, maxOutputTokens: EXPR_CAP };`,
      `function f(SHADOW: number) { return { ...${T}, maxOutputTokens: SHADOW }; }`,
      `const e = { ...${T}, maxOutputTokens: NOWHERE };`,
    ].join("\n");
    // 🔒 가린 이름을 바깥 상수로 읽으면, 함수 안에서 상한을 64로 다시 선언해도 2048로 보고 녹색이 된다
    expect(thinkingHeadroom("k.ts", src).map((r) => r.maxOutputTokens)).toEqual([2048, "LET_CAP", "EXPR_CAP", "SHADOW", "NOWHERE"]);
  });

  it("thinking 여유 — env 기본값은 그 파일의 env 식별자에만, -1 같은 식·다른 식별자는 원문으로 위반", () => {
    const cfg = (budget: string) =>
      `  const c = { ...geminiTuning(m, { thinkingBudget: ${budget}, thinkingLevel: "low" }), maxOutputTokens: 2048 };`;
    // env 식별자는 실파일처럼 getTextModel 본문의 const로 선언한다(선언으로 푸는 규칙은 다음 테스트)
    const getter = (...lines: string[]) =>
      [`function getTextModel() {`, `  const THINKING_BUDGET = envBudget();`, ...lines, `}`].join("\n");
    const src = getter(cfg("THINKING_BUDGET"), cfg("-1"), cfg("OTHER_BUDGET"), cfg("THINKING_BUDGET * 2"));
    const rows = thinkingHeadroom("lib/chat/llm.ts", src);
    expect(rows.map((r) => r.budget)).toEqual([512, "-1", "OTHER_BUDGET", "THINKING_BUDGET * 2"]);
    // 🔒 예전 판독기는 llm.ts의 숫자 아닌 예산을 전부 512로 읽었다 — -1(동적 thinking)도 녹색
    expect(rowHeadroomViolations(rows)).toEqual([
      "lib/chat/llm.ts:4 thinkingBudget=-1 maxOutputTokens=2048",
      "lib/chat/llm.ts:5 thinkingBudget=OTHER_BUDGET maxOutputTokens=2048",
      "lib/chat/llm.ts:6 thinkingBudget=THINKING_BUDGET * 2 maxOutputTokens=2048",
    ]);
    // env 예산 파일이 아니면 같은 이름도 원문
    expect(thinkingHeadroom("lib/chat/other.ts", getter(cfg("THINKING_BUDGET")))[0].budget).toBe("THINKING_BUDGET");
  });

  it("thinking 여유 — env 식별자는 이름이 아니라 선언으로 푼다: 두 함수가 각자 THINKING_BUDGET을 선언하면 둘 다 원문(위반)", () => {
    const T = `geminiTuning(m, { thinkingBudget: THINKING_BUDGET, thinkingLevel: "low" })`;
    const fn = (name: string, body = "", params = "") =>
      `function ${name}(${params}) { ${body} return { ...${T}, maxOutputTokens: 2048 }; }`;
    const ENV = `const THINKING_BUDGET = envBudget();`;
    const rows = thinkingHeadroom("lib/chat/llm.ts",
      [fn("getTextModel", ENV), fn("getTextModelCopy", `const THINKING_BUDGET = 2048;`)].join("\n"));
    // 🔒 이름만 보던 판독기는 둘 다 512로 읽었다 — 베낀 getter의 예산 2048(상한 2048이면 답 쓸 몫 0)도 녹색
    expect(rowHeadroomViolations(rows)).toEqual([
      "lib/chat/llm.ts:1 thinkingBudget=THINKING_BUDGET maxOutputTokens=2048",
      "lib/chat/llm.ts:2 thinkingBudget=THINKING_BUDGET maxOutputTokens=2048",
    ]);
    // 기본값은 파일의 유일한 그 이름 선언이 getTextModel 본문의 const이고, 참조도 그 본문 안일 때만
    const budgets = (...lines: string[]) => thinkingHeadroom("lib/chat/llm.ts", lines.join("\n")).map((r) => r.budget);
    expect(budgets(fn("getTextModel", ENV))).toEqual([512]);
    expect(budgets(fn("other", ENV))).toEqual(["THINKING_BUDGET"]);                                   // 다른 함수의 선언
    expect(budgets(ENV, fn("getTextModel"))).toEqual(["THINKING_BUDGET"]);                            // 최상위 선언
    expect(budgets(fn("getTextModel", ENV.replace("const", "let")))).toEqual(["THINKING_BUDGET"]);   // let — 뒤에서 바꿀 수 있다
    expect(budgets(fn("getTextModel", "", "THINKING_BUDGET = 4096"))).toEqual(["THINKING_BUDGET"]);  // 매개변수 — 호출부가 정한다
    // getTextModel 밖의 참조는 그 const가 아니다 — 여기선 수집기가 세지 않는 import로 풀린다
    expect(budgets(`import { THINKING_BUDGET } from "./budget";`, fn("getTextModel", ENV), fn("other")))
      .toEqual([512, "THINKING_BUDGET"]);
  });

  it("요청 지점 — models.generateContent·generateContentStream·authTokens.create·live.connect만 센다(점·대괄호·옵셔널 체인)", () => {
    const src = [
      `await getGenAI().models.generateContent({ model, contents });`,
      `await ai.models.generateContentStream({ model, contents });`,
      `await ai.authTokens.create({ config });`,
      `await ai.live.connect({ model, callbacks });`,
      `await ai?.models?.["generateContent"]({ model, contents });`,
      `const { models } = ai; await models.generateContent({ model, contents });`,
      `await model.generateContent(prompt);`,               // 어댑터 호출 — 요청 지점은 어댑터 안쪽(models.…)이다
      `await ai.models.embedContent({ model, contents });`,
      `source.connect(analyser); this.connect();`,
      `const s = "ai.models.generateContent(x)"; // ai.live.connect()`,
    ].join("\n");
    expect(countRequestSites("r.ts", src)).toBe(6);
  });

  it("헬퍼 import — 이름 그대로면 imported, 별칭·네임스페이스·동적 import·같은 이름의 다른 것은 위반", () => {
    expect(helperImport("lib/a.ts", `import { geminiTuning } from "@/lib/ai/gemini-config";`))
      .toEqual({ imported: true, violations: [] });
    expect(helperImport("lib/chat/b.ts", `import { geminiTuning, type GeminiTuning } from "../ai/gemini-config";`))
      .toEqual({ imported: true, violations: [] });
    const bad = [
      `import { geminiTuning as tune } from "@/lib/ai/gemini-config";`,
      `import * as G from "@/lib/ai/gemini-config";`,
      `const m = await import("@/lib/ai/gemini-config");`,
      `import { geminiTuning } from "@/lib/ai/other-config";`,
      `import { acceptsLegacyTuning as geminiTuning } from "./gemini-config";`,
      `function geminiTuning() { return {}; }`,
      `import type * as T from "@/lib/ai/gemini-config";`,   // 타입 전용 — 런타임 헬퍼를 들일 수 없다(위반 아님)
    ].join("\n");
    // 🔒 별칭·네임스페이스면 스캐너가 tune(…)·G.geminiTuning(…)을 헬퍼 호출로 못 알아본다
    expect(helperImport("lib/ai/c.ts", bad)).toEqual({ imported: false, violations: [
      "lib/ai/c.ts:1 geminiTuning as tune",
      "lib/ai/c.ts:2 * as G",
      `lib/ai/c.ts:3 import("@/lib/ai/gemini-config")`,
      `lib/ai/c.ts:4 geminiTuning from "@/lib/ai/other-config"`,
      `lib/ai/c.ts:5 acceptsLegacyTuning as geminiTuning from "./gemini-config"`,
      "lib/ai/c.ts:6 geminiTuning 선언",
    ] });
  });

  it("maxOutputTokens 닫힘 — 행 밖의 모든 꼴을 원문으로 잡고, 헬퍼 결과를 펼친 config의 상한(축약형 포함)만 통과", () => {
    const T = `geminiTuning(m, { thinkingBudget: 64, thinkingLevel: "low" })`;
    const src = [
      `const ok = { ...${T}, maxOutputTokens: 1024 };`,
      `function f() { const t = ${T}; return { ...t, maxOutputTokens: 256 }; }`,
      `const rs = { ...${T}, maxOutputTokens };`,             // 행의 축약형 — 값은 여유 검사가 원문으로 위반 처리
      `const re = { ...ok, maxOutputTokens: 128 };`,
      `ok.maxOutputTokens = 64;`,
      `ok["maxOutputTokens"] ??= 64;`,
      `ok.maxOutputTokens--;`,
      `Object.assign(ok, { maxOutputTokens: 64 });`,
      `const s = { maxOutputTokens };`,
      `const c = { ["maxOutputTokens"]: 64 };`,
      `const K = "maxOutputTokens";`,
      `const g = { get maxOutputTokens() { return 64; } };`,
      `interface L { maxOutputTokens?: number } type P = Pick<L, "maxOutputTokens">;`,
      `const r = ok.maxOutputTokens; // maxOutputTokens: 1`,
    ].join("\n");
    // 1~3행(검증된 행)·13행(타입)·14행(읽기·주석)만 통과
    expect(capClosureViolations("z.ts", src)).toEqual([
      "z.ts:4 maxOutputTokens: 128",
      "z.ts:5 ok.maxOutputTokens = 64",
      `z.ts:6 ok["maxOutputTokens"] ??= 64`,
      "z.ts:7 ok.maxOutputTokens--",
      "z.ts:8 Object.assign 원본 maxOutputTokens: 64",
      "z.ts:9 maxOutputTokens",
      `z.ts:10 ["maxOutputTokens"]: 64`,
      `z.ts:11 K = "maxOutputTokens"`,
      "z.ts:12 get maxOutputTokens() { return 64; }",
    ]);
  });

  it("maxOutputTokens 닫힘 — 따옴표 키는 한 번만 센다: 검증된 행이면 보통 키처럼 통과, 행 밖이면 위반 1건", () => {
    const src = [
      `const q = { ...geminiTuning(m, { thinkingBudget: 64, thinkingLevel: "low" }), "maxOutputTokens": 1024 };`,
      `const re = { ...q, "maxOutputTokens": 128 };`,
    ].join("\n");
    // 🔒 예전엔 원소와 그 이름 문자열을 따로 세어(2번) 검증된 1행의 상한도 '행 밖 상한'으로 잡혔다
    expect(capOccurrences(parse("q.ts", src)).map((o) => o.text)).toEqual([`"maxOutputTokens": 1024`, `"maxOutputTokens": 128`]);
    expect(capClosureViolations("q.ts", src)).toEqual([`q.ts:2 "maxOutputTokens": 128`]);
    const rows = thinkingHeadroom("q.ts", src);
    expect(rows).toEqual([{ at: "q.ts:1", budget: 64, maxOutputTokens: 1024 }]);
    expect(rowHeadroomViolations(rows)).toEqual([]);
  });
});

describe("app/·lib/ — Gemini 샘플링·thinking 키는 헬퍼 안에서만", () => {
  const sources = ROOTS.flatMap(listSources);
  const files = sources.filter((f) => f !== HELPER_FILE);

  it("스캔 범위가 실제 소스 전체다 (빈 목록으로 녹색이 되지 않게)", () => {
    expect(files.length).toBeGreaterThan(50);
    for (const f of Object.keys(ROUTED_FILES)) expect(files, f).toContain(f);
  });

  it("헬퍼 밖의 금지 키 0건", () => {
    const hits = files.flatMap((f) => findRawTuningKeys(f, readFileSync(f, "utf-8")));
    // 🔒 여기 걸리면: 그 config를 `...geminiTuning(model, { …오늘 값…, thinkingLevel })`로 감싸라(lib/ai/gemini-config 헤더의 매핑표)
    expect(hits).toEqual([]);
  });

  it.each(Object.entries(ROUTED_FILES))("%s — 헬퍼 호출 %i곳", (file, expected) => {
    // 🔒 줄면: 그 호출부가 헬퍼를 떼고 샘플링·thinking을 아예 안 보내게 됐다(오늘 요청이 바뀐다)
    expect(countHelperCalls(file, readFileSync(file, "utf-8"))).toBe(expected);
  });

  it("역방향 인벤토리 — 헬퍼 호출이 있는 파일과 호출 수가 ROUTED_FILES와 정확히 같다(헬퍼 파일 포함 전체)", () => {
    const inventory = Object.fromEntries(sources
      .map((f) => [f, countHelperCalls(f, readFileSync(f, "utf-8"))] as const)
      .filter(([, n]) => n > 0));
    // 🔒 표에 없는 파일·호출이 보이면: 그 호출부는 thinkingLevel·thinking 여유 검사를 받지 않고 지나간다 — ROUTED_FILES에 올려라
    expect(inventory).toEqual(ROUTED_FILES);
  });
});

describe("새 모델용 thinkingLevel — 호출부 소스에 적힌 리터럴 (텍스트 경로 low · Live null)", () => {
  it("Live 라우트가 대상에 있다 (null 기대가 공허하지 않게)", () => {
    expect(Object.keys(ROUTED_FILES)).toContain(LIVE_ROUTE);
  });

  it.each(Object.entries(ROUTED_FILES))("%s", (file, calls) => {
    // 🔒 텍스트 경로에 minimal: 3.7/3.8 Flash가 400 → 응급 백스톱 null·분석기 degraded로 조용히 멈춘다.
    //   Live에 수준을 넣으면: 3.8 Live(thinkingLevel 미지원)·3.8 Live Extended Thinking(minimal 거부)이 거부한다.
    expect(helperLevels(file, readFileSync(file, "utf-8"))).toEqual(Array(calls).fill(expectedLevel(file)));
  });
});

describe("오늘 세대 thinking 여유 — maxOutputTokens ≥ thinkingBudget + 128 (라우팅된 호출부 전부)", () => {
  const rows = Object.keys(ROUTED_FILES).flatMap((f) => thinkingHeadroom(f, readFileSync(f, "utf-8")));

  it("라우팅된 파일 전부에서 헬퍼 호출마다 쌍을 읽었다 (빈 목록으로 녹색이 되지 않게)", () => {
    expect(new Set(rows.map((r) => r.at.split(":")[0]))).toEqual(new Set(Object.keys(ROUTED_FILES)));
    expect(new Set(rows.map((r) => r.at)).size).toBe(Object.values(ROUTED_FILES).reduce((a, b) => a + b, 0));
  });

  it("thinkingBudget + 128 ≤ maxOutputTokens", () => {
    // 🔒 maxOutputTokens는 thinking을 포함한다 — 걸린 호출부는 예산만큼 생각하다 상한에 닿아 답이 잘린다.
    //   JSON 호출부는 파싱 실패를 삼켜 조용히 품질만 떨어진다(정신건강 분류 64/64: 2026-10-07 실측 7개 중 5개 -1).
    expect(rowHeadroomViolations(rows)).toEqual([]);
  });
});

const read = (f: string): string => readFileSync(f, "utf-8");

describe("SDK 요청 지점 인벤토리 — 라우팅된 파일 + 허용 목록뿐 (헬퍼는 import로 확인)", () => {
  const sources = ROOTS.flatMap(listSources);
  const files = sources.filter((f) => f !== HELPER_FILE);

  it("표의 라우팅 쪽 = ROUTED_FILES, 허용 목록과 겹치지 않는다", () => {
    expect(Object.keys(ROUTED_REQUEST_SITES).sort()).toEqual(Object.keys(ROUTED_FILES).sort());
    expect(Object.keys(REQUEST_ALLOWLIST).filter((f) => Object.hasOwn(ROUTED_FILES, f))).toEqual([]);
  });

  it("파일별 요청 지점 수가 정확히 라우팅된 파일 + 허용 목록이다 (헬퍼 파일 포함 전체)", () => {
    const inventory = Object.fromEntries(sources
      .map((f) => [f, countRequestSites(f, read(f))] as const)
      .filter(([, n]) => n > 0));
    // 🔒 표 밖 파일·지점이 보이면: 그 요청은 헬퍼·thinkingLevel·여유 검사를 모두 건너뛴다 — 헬퍼로 라우팅하거나,
    //   모델 세대별로 갈라야 할 필드가 정말 없다면 이유를 적어 REQUEST_ALLOWLIST에 올려라
    expect(inventory).toEqual({ ...ROUTED_REQUEST_SITES, ...REQUEST_ALLOWLIST });
  });

  it("요청 지점이 있는 파일은 헬퍼를 이름 그대로 import해 부르거나 허용 목록에 있다", () => {
    const offenders = files.filter((f) => {
      const text = read(f);
      if (countRequestSites(f, text) === 0 || Object.hasOwn(REQUEST_ALLOWLIST, f)) return false;
      return !(helperImport(f, text).imported && countHelperCalls(f, text) > 0);
    });
    expect(offenders).toEqual([]);
  });

  it("헬퍼 import — 별칭·네임스페이스·동적 import·같은 이름의 다른 것 0건", () => {
    // 🔒 별칭(geminiTuning as X)·네임스페이스(G.geminiTuning)면 스캐너가 그 호출을 못 알아본다 —
    //   금지 키·thinkingLevel·여유 검사가 그 호출부를 건너뛴다. 이름 그대로 import하라
    expect(files.flatMap((f) => helperImport(f, read(f)).violations)).toEqual([]);
  });
});

describe("maxOutputTokens 닫힘 — app/·lib/의 상한은 전부 검증된 여유 행이다", () => {
  const sources = ROOTS.flatMap(listSources);

  it("오늘: maxOutputTokens 11곳 = 상한이 있는 여유 행 11개 (오탐 0 · 공허하지 않음)", () => {
    const occurrences = sources.flatMap((f) => capOccurrences(parse(f, read(f))));
    const cappedRows = Object.keys(ROUTED_FILES).flatMap((f) => thinkingHeadroom(f, read(f)))
      .filter((r) => r.maxOutputTokens !== Infinity);
    expect(occurrences.length).toBe(11);
    expect(cappedRows.length).toBe(11);
  });

  it("검증된 행 밖의 maxOutputTokens 0건", () => {
    // 🔒 행 밖에서 정한 상한은 여유 검사를 받지 않는다 — config를 다시 펼쳐 덮어쓰거나({ ...cfg, maxOutputTokens: 128 })
    //   나중에 고치지(cfg.maxOutputTokens = 64·Object.assign) 말고, 헬퍼 결과를 펼친 config 리터럴에 적어라
    expect(sources.flatMap((f) => capClosureViolations(f, read(f)))).toEqual([]);
  });
});

/**
 * 파일 하나에 거는 계약 검사 전부 — 실파일과 그 메모리 사본(변이)을 같은 눈으로 비교한다. 수(헬퍼 호출·요청 지점·상한 원소·
 *   상한이 있는 여유 행)는 위의 표·'11곳 = 11개'와 맞추는 값이고, 나머지는 위반 목록이다(빈 배열 = 통과).
 */
const contractOf = (f: string, text: string) => ({
  rawKeys: findRawTuningKeys(f, text),
  helperCalls: countHelperCalls(f, text),
  levels: helperLevels(f, text),
  requestSites: countRequestSites(f, text),
  helperImport: helperImport(f, text),
  capOccurrences: capOccurrences(parse(f, text)).length,
  cappedRows: thinkingHeadroom(f, text).filter((r) => r.maxOutputTokens !== Infinity).length,
  closure: capClosureViolations(f, text),
  headroom: rowHeadroomViolations(thinkingHeadroom(f, text)),
});

/** 라우팅된 파일이 계약을 전부 통과할 때의 모양 — 위반 없음 · 수는 표와 같다(상한 원소 수는 파일마다 달라 뺀다) */
const passingContract = (f: string) => ({
  rawKeys: [], helperCalls: ROUTED_FILES[f], levels: Array(ROUTED_FILES[f]).fill(expectedLevel(f)),
  requestSites: ROUTED_REQUEST_SITES[f], helperImport: { imported: true, violations: [] }, closure: [], headroom: [],
});

/**
 * llm.ts 사본에 덧붙일 getter — getTextModel을 베끼되 THINKING_BUDGET을 자기 기본값 2048로 선언한다(천장 없음).
 *   상한은 같은 COMPANION_MAX_OUTPUT_TOKENS(2048)라 예산만큼 생각하면 답 쓸 몫이 0이다.
 */
const COPIED_GETTER = [
  `export function getTextModelCopy(systemInstruction: string) {`,
  `  const THINKING_BUDGET = parseInt(process.env.COPY_THINKING_BUDGET || "2048", 10);`,
  `  const model = process.env.COMPANION_MODEL || "gemini-2.5-flash";`,
  `  const tuning = geminiTuning(model, { temperature: 0.7, thinkingBudget: THINKING_BUDGET, thinkingLevel: "low" });`,
  `  const config = { systemInstruction, ...tuning, maxOutputTokens: COMPANION_MAX_OUTPUT_TOKENS };`,
  `  return getGenAI().models.generateContent({ model, contents: "", config });`,
  `}`,
].join("\n");

describe("실파일 사본 변이 — 메모리 사본에 낸 구멍은 잡고, 같은 뜻의 다른 꼴은 오탐하지 않는다", () => {
  it("lib/chat/llm.ts + 자기 THINKING_BUDGET(기본값 2048)을 선언한 getter — 표의 수를 올려 줘도 여유 검사가 잡는다", () => {
    const f = "lib/chat/llm.ts";
    const before = contractOf(f, read(f));
    expect(before).toMatchObject(passingContract(f));   // 기준: 실파일은 통과(캐시·비캐시 config 두 행이 env 기본값 512)
    const after = contractOf(f, `${read(f)}\n${COPIED_GETTER}\n`);
    // 수만 보는 검사는 표를 +1 해 주면 통과한다 — 헬퍼 호출·요청 지점·상한 원소·상한 행이 하나씩 늘 뿐 다른 위반은 없다
    expect({ ...after, headroom: [] }).toEqual({
      ...before, helperCalls: before.helperCalls + 1, levels: [...before.levels, "low"], requestSites: before.requestSites + 1,
      capOccurrences: before.capOccurrences + 1, cappedRows: before.cappedRows + 1,
    });
    // 🔒 이름만 보던 판독기는 두 getter의 THINKING_BUDGET을 다 512로 읽어 녹색이었다 — 이제 세 행 모두 원문 → 위반
    expect(after.headroom.map((v) => v.slice(v.indexOf(" ") + 1)))
      .toEqual(Array(3).fill("thinkingBudget=THINKING_BUDGET maxOutputTokens=2048"));
  });

  it("lib/chat/profile-extractor-llm.ts의 상한을 따옴표 키로 — 계약 검사 전부 통과, maxOutputTokens 수 그대로", () => {
    const f = "lib/chat/profile-extractor-llm.ts";
    const quoted = read(f).replace("maxOutputTokens: 1024", `"maxOutputTokens": 1024`);
    expect(quoted).not.toBe(read(f));   // 변이 지점이 있다
    expect(contractOf(f, read(f))).toMatchObject(passingContract(f));
    // 🔒 예전엔 이름 문자열을 한 번 더 세어 상한 원소 2개 + '행 밖 상한' 위반 1건이었다
    expect(contractOf(f, quoted)).toEqual(contractOf(f, read(f)));
  });
});
