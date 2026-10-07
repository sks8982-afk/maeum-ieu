/**
 * 소스 계약 — app/·lib/에서 Gemini 샘플링·thinking 키는 **헬퍼(lib/ai/gemini-config) 인자 안에서만** 쓴다.
 *
 * 왜(2026-10-07 Google 공지): 다음 세대 모델은 thinkingBudget·temperature·topP·topK를 400으로 거부한다.
 *   호출부 하나가 리터럴로 직접 보내면, env로 모델을 올리는 날 그 경로만 조용히 멈춘다(응급 백스톱은 null,
 *   분석기는 degraded로 실패를 삼킨다). 새 호출부가 헬퍼를 건너뛰는 순간 여기서 빨간불이 켜져야 한다.
 *
 * 방식: 정규식이 아니라 TypeScript 구문 트리로 본다 — 주석·문자열 속 "temperature:"는 무시되고,
 *   객체 리터럴 키(축약형 포함)와 `cfg.temperature = …` 같은 사후 대입을 잡는다. 스캐너가 공허하지 않은지는
 *   아래 '스캐너 자체 검증'이 고정한다(정규식 게이트가 아무것도 못 잡던 사고를 반복하지 않으려고).
 * 같은 구문 트리로 헬퍼 호출부가 적은 **새 모델용 thinkingLevel 리터럴**도 고정한다(텍스트 경로 low · Live null) —
 *   단위 테스트의 호출부 표는 사본이라, 실제 호출부가 바뀌어도 녹색이었다.
 */
import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOTS = ["app", "lib"];
const HELPER_FILE = "lib/ai/gemini-config.ts";
const HELPER_NAME = "geminiTuning";
/** Gemini에 직접 실으면 안 되는 키 — thinkingConfig 통째로도 헬퍼 밖에선 금지 */
const FORBIDDEN = new Set(["temperature", "topP", "topK", "thinkingBudget", "thinkingLevel", "thinkingConfig"]);

/** 헬퍼로 라우팅된 호출부 — 하나라도 빠지면 그 파일이 헬퍼를 우회했다는 뜻 */
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
 * 새 모델용 thinkingLevel — 호출부가 헬퍼 두 번째 인자에 **리터럴로** 적는 값(헬퍼 헤더 매핑표). 타입은 넷 다
 *   허용하므로 tsc는 못 막는다. 실패를 삼키는 텍스트 경로는 전부 "low"(3.7/3.8 Flash가 minimal을 400으로 거부 →
 *   조용히 멈춘다), Live 토큰만 null(수준을 하나 고르면 거부하는 Live 모델이 있다 → thinkingConfig 생략).
 */
const LIVE_ROUTE = "app/api/live/token/route.ts";
const expectedLevel = (file: string): string | null => (file === LIVE_ROUTE ? null : "low");

function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.posix.join(dir, e.name);
    if (e.isDirectory()) return listSources(p);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function keyName(name: ts.Node): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

const isHelperCall = (n: ts.Node): n is ts.CallExpression =>
  ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === HELPER_NAME;

/** 헬퍼 인자 밖에서 금지 키를 쓰는 곳 — "파일:줄 키" 목록 */
function findRawTuningKeys(fileName: string, text: string): string[] {
  const sf = parse(fileName, text);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (isHelperCall(node)) return;   // 인자 안은 헬퍼가 모델 세대에 맞게 거른다 — 여기만 허용
    let key: string | undefined;
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      key = keyName(node.name);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      // 객체를 만든 뒤 몰래 넣는 경로: cfg.temperature = 0 / cfg["thinkingConfig"] = {…}
      const l = node.left;
      if (ts.isPropertyAccessExpression(l)) key = l.name.text;
      else if (ts.isElementAccessExpression(l)) key = keyName(l.argumentExpression);
    }
    if (key && FORBIDDEN.has(key)) {
      hits.push(`${fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${key}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

function countHelperCalls(fileName: string, text: string): number {
  let n = 0;
  const visit = (node: ts.Node): void => { if (isHelperCall(node)) n++; ts.forEachChild(node, visit); };
  visit(parse(fileName, text));
  return n;
}

/** 객체 리터럴에서 키의 값 식 — 객체 리터럴이 아니거나 `키: 값` 꼴이 없으면 undefined(축약형은 리터럴이 아니다) */
function propValue(obj: ts.Expression | undefined, key: string): ts.Expression | undefined {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && keyName(p.name) === key) return p.initializer;
  }
  return undefined;
}

/** 헬퍼 호출마다 두 번째 인자의 thinkingLevel — 문자열 리터럴이면 그 값, null이면 null, 그 밖은 "<리터럴 아님: 원문>" */
function helperLevels(fileName: string, text: string): (string | null)[] {
  const sf = parse(fileName, text);
  const levels: (string | null)[] = [];
  const visit = (node: ts.Node): void => {
    if (isHelperCall(node)) {
      const v = propValue(node.arguments[1], "thinkingLevel");
      if (v && ts.isStringLiteralLike(v)) levels.push(v.text);
      else if (v?.kind === ts.SyntaxKind.NullKeyword) levels.push(null);
      else levels.push(`<리터럴 아님: ${(v ?? node.arguments[1] ?? node).getText(sf)}>`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return levels;
}

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
});

describe("app/·lib/ — Gemini 샘플링·thinking 키는 헬퍼 안에서만", () => {
  const files = ROOTS.flatMap(listSources).filter((f) => f !== HELPER_FILE);

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
