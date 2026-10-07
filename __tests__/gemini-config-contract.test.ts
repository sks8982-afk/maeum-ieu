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
 * 그리고 오늘 세대에 싣는 예산의 여유 불변식: maxOutputTokens ≥ thinkingBudget + 128(라우팅된 호출부 전부).
 *   상한·예산을 정할 수 있는 꼴 중 숫자 리터럴로 확인되지 않는 것(축약형·계산된 키·다른 펼침·숫자 아닌 값)은
 *   원문을 드러내며 실패한다 — '상한 없음'은 상한이 어떤 꼴로도 없고 헬퍼 결과 말고는 펼침도 없을 때뿐이다.
 *   config를 다시 펼치는 래퍼(getTextModel 등)의 덮어쓰기는 소스로 못 따라간다 — gemini-config-callsites가
 *   SDK에 실제로 간 요청에서 같은 불변식을 본다.
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
 * 새 모델용 thinkingLevel — 호출부가 헬퍼 두 번째 인자에 **리터럴로** 적는 값(헬퍼 헤더 매핑표). 타입은 넷 다
 *   허용하므로 tsc는 못 막는다. 실패를 삼키는 텍스트 경로는 전부 "low"(3.7/3.8 Flash가 minimal을 400으로 거부 →
 *   조용히 멈춘다), Live 토큰만 null(수준을 하나 고르면 거부하는 Live 모델이 있다 → thinkingConfig 생략).
 */
const LIVE_ROUTE = "app/api/live/token/route.ts";
const expectedLevel = (file: string): string | null => (file === LIVE_ROUTE ? null : "low");

/**
 * 오늘 세대(≤3.8)의 thinking 여유 — maxOutputTokens는 thinking 토큰을 **포함**한다(문서 "including thought
 *   tokens"). 예산만큼 생각하고도 답(JSON)을 끝까지 쓸 몫이 남아야 한다. 정신건강 분류가 64/64로 보내다가
 *   2026-10-07 실측에서 LLM 경로 답 7개 중 5개를 잘린 JSON으로 잃었다(-1 → 재질문).
 *   새 모델(thinkingLevel)엔 토큰 예산이 없어 이 불변식이 닿지 않는다 — 헬퍼 헤더 '불확실한 것' 참고.
 */
const MIN_OUTPUT_HEADROOM = 128;
/**
 * 예산을 env로 정하는 호출부 — 소스에서 값을 읽을 수 없어 기본값을 적는다. 이 기본값은 실요청 캡처
 *   (gemini-config-callsites '동반자 getTextModel': thinkingBudget 512)가 고정한다 — 바꾸면 둘 다 바꿀 것.
 *   ⚠ env(COMPANION_THINKING_BUDGET)로 1921 이상을 주면 이 불변식 밖이다(maxOutputTokens 2048).
 */
const ENV_BUDGET_DEFAULT: Record<string, number> = { "lib/chat/llm.ts": 512 };

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

type Headroom = { at: string; budget: number | string; maxOutputTokens: number | string };

/** 헬퍼 결과가 펼쳐지는 config 객체 — `{ ...geminiTuning(…) }`, 또는 `const t = geminiTuning(…)` 뒤 같은 함수의 `{ ...t }` 전부 */
function configsOf(call: ts.CallExpression): ts.ObjectLiteralExpression[] {
  const p = call.parent;
  if (ts.isSpreadAssignment(p) && ts.isObjectLiteralExpression(p.parent)) return [p.parent];
  if (!ts.isVariableDeclaration(p) || !ts.isIdentifier(p.name)) return [];
  const name = p.name.text;
  let scope: ts.Node = p;
  while (!ts.isFunctionLike(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  const found: ts.ObjectLiteralExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n) && n.properties.some((q) =>
      ts.isSpreadAssignment(q) && ts.isIdentifier(q.expression) && q.expression.text === name)) found.push(n);
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/**
 * 객체 리터럴에서 key를 정할 수 있는 원소를 **전부** 본다 — `key: 값` 꼴만 찾으면, 상한을 축약형이나 다른 객체
 *   펼침으로 64로 내려도 '없음 = 상한 없음(Infinity)'으로 읽혀 녹색이었다.
 *   value: 그 키의 값 식(`key: 값`의 값 · 축약형 `key`는 그 식별자, 마지막 것이 이긴다)
 *   unverifiable: 정적으로 따질 수 없는 원소의 원문 — 계산된 키(무엇이든)·그 키의 메서드/접근자·allowSpread가 허용하지 않은 펼침
 */
function readKey(obj: ts.ObjectLiteralExpression, key: string, sf: ts.SourceFile,
  allowSpread: (e: ts.Expression) => boolean): { value?: ts.Expression; unverifiable: string[] } {
  let value: ts.Expression | undefined;
  const unverifiable: string[] = [];
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      if (!allowSpread(p.expression)) unverifiable.push(p.getText(sf));
    } else if (ts.isComputedPropertyName(p.name)) {
      unverifiable.push(p.getText(sf));
    } else if (keyName(p.name) === key) {
      if (ts.isPropertyAssignment(p)) value = p.initializer;
      else if (ts.isShorthandPropertyAssignment(p)) value = p.name;
      else unverifiable.push(p.getText(sf));
    }
  }
  return { value, unverifiable };
}

/** config에 허용되는 유일한 펼침 — 그 헬퍼 호출 자체(`...geminiTuning(…)`)나 그 결과를 담은 변수(`const t = geminiTuning(…)` 뒤 `...t`) */
function isOwnTuning(call: ts.CallExpression): (e: ts.Expression) => boolean {
  const v = call.parent;
  const name = ts.isVariableDeclaration(v) && ts.isIdentifier(v.name) ? v.name.text : undefined;
  return (e) => e === call || (name !== undefined && ts.isIdentifier(e) && e.text === name);
}

/** 헬퍼 두 번째 인자의 thinkingBudget — 인자 안의 펼침·계산된 키도 예산을 바꿀 수 있어 원문으로 남긴다. env 예산 파일은 기본값 */
function budgetOf(call: ts.CallExpression, fileName: string, sf: ts.SourceFile): number | string {
  const arg = call.arguments[1];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return `<객체 리터럴 아님: ${(arg ?? call).getText(sf)}>`;
  const b = readKey(arg, "thinkingBudget", sf, () => false);
  if (b.unverifiable.length > 0) return b.unverifiable.join(", ");
  if (b.value === undefined) return "<thinkingBudget 없음>";
  return ts.isNumericLiteral(b.value) ? Number(b.value.text) : ENV_BUDGET_DEFAULT[fileName] ?? b.value.getText(sf);
}

/**
 * 헬퍼 결과가 펼쳐진 config의 maxOutputTokens — 숫자 리터럴이면 그 수, 그 밖의 꼴은 원문(위반으로 드러난다).
 *   Infinity(상한 없음 = 모델 기본 상한, Live)는 상한이 **어떤 꼴로도 없고** 헬퍼 결과 말고는 펼침도 없을 때만.
 */
function capOf(config: ts.ObjectLiteralExpression, call: ts.CallExpression, sf: ts.SourceFile): number | string {
  const m = readKey(config, "maxOutputTokens", sf, isOwnTuning(call));
  if (m.unverifiable.length > 0) return m.unverifiable.join(", ");
  if (m.value === undefined) return Infinity;
  return ts.isNumericLiteral(m.value) ? Number(m.value.text) : m.value.getText(sf);
}

/** 헬퍼 호출마다 (오늘 세대에 싣는 thinkingBudget, 그 결과가 펼쳐진 config의 maxOutputTokens) 쌍 */
function thinkingHeadroom(fileName: string, text: string): Headroom[] {
  const sf = parse(fileName, text);
  const rows: Headroom[] = [];
  const visit = (node: ts.Node): void => {
    if (isHelperCall(node)) {
      const at = `${fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
      const budget = budgetOf(node, fileName, sf);
      const configs = configsOf(node);
      if (configs.length === 0) rows.push({ at, budget, maxOutputTokens: "<config를 못 찾음>" });
      for (const c of configs) rows.push({ at, budget, maxOutputTokens: capOf(c, node, sf) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return rows;
}

/** 불변식 위반 — 숫자로 못 읽었거나 maxOutputTokens < thinkingBudget + 128 */
const headroomViolations = (rows: Headroom[]): string[] => rows
  .filter((r) => typeof r.budget !== "number" || typeof r.maxOutputTokens !== "number"
    || r.maxOutputTokens < r.budget + MIN_OUTPUT_HEADROOM)
  .map((r) => `${r.at} thinkingBudget=${r.budget} maxOutputTokens=${r.maxOutputTokens}`);

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
    expect(headroomViolations(rows)).toEqual([
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
    expect(headroomViolations(rows)).toEqual([
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
    expect(headroomViolations(rows)).toEqual([]);
  });
});
