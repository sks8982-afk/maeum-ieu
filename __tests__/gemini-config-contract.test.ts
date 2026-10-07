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
import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { MIN_OUTPUT_HEADROOM } from "@/__tests__/helpers/gemini-headroom";

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

/** 헬퍼 모듈(저장소 상대·확장자 없음) — 각 파일의 import 경로를 이것으로 풀어 헬퍼인지 본다 */
const HELPER_MODULE = HELPER_FILE.replace(/\.ts$/, "");
/** SDK 요청을 내는 호출 — 호출식 끝의 `<소유>.<메서드>`(ai.models.generateContent·getGenAI().models.generateContent 등) */
const REQUEST_CALLS = new Set(["models.generateContent", "models.generateContentStream", "authTokens.create", "live.connect"]);
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

/**
 * 예산을 env로 정하는 호출부 — 그 파일에서 env로 정한 **식별자 하나만** 기본값으로 읽는다(소스에서 값을 읽을 수 없다).
 *   다른 식별자·식은 원문으로 남아 위반이 된다 — 예전엔 파일 단위로 기본값을 끼워 넣어 `thinkingBudget: -1`(2.5의 동적
 *   thinking — 상한 안에서 얼마나 생각할지 정해지지 않는다)도 512로 읽혀 녹색이었다. 기본값 512는 실요청 캡처
 *   (gemini-config-callsites '동반자 getTextModel')가 고정한다 — 바꾸면 둘 다. env로 1921 이상을 줘도 llm.ts가
 *   1920(상한 2048 − 128)에서 자른다 — 그 천장은 소스로 못 읽어 gemini-config-callsites가 "5000" → 1920으로 고정한다.
 */
const ENV_BUDGET: Record<string, { identifier: string; defaultValue: number }> = {
  "lib/chat/llm.ts": { identifier: "THINKING_BUDGET", defaultValue: 512 },
};

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

const lineOf = (sf: ts.SourceFile, n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

/** `X.이름`·`X["이름"]`(옵셔널 체인 포함)의 이름 — 그 밖은 undefined */
function memberName(e: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
  return undefined;
}

/** SDK 요청 지점 수 — 호출식 끝의 `<소유>.<메서드>`가 REQUEST_CALLS인 호출(소유가 변수여도: const { models } = ai) */
function countRequestSites(fileName: string, text: string): number {
  let n = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const o = node.expression.expression;
      const owner = ts.isIdentifier(o) ? o.text : memberName(o);
      const method = memberName(node.expression);
      if (owner !== undefined && method !== undefined && REQUEST_CALLS.has(`${owner}.${method}`)) n++;
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(fileName, text));
  return n;
}

/** import 경로 → 저장소 상대 경로(확장자 없음). "@/…"·상대 경로만 — 패키지 이름은 undefined */
function resolveImport(fromFile: string, spec: string): string | undefined {
  const p = spec.startsWith("@/") ? path.posix.normalize(spec.slice(2))
    : spec.startsWith(".") ? path.posix.join(path.posix.dirname(fromFile), spec) : undefined;
  return p?.replace(/\.[jt]sx?$/, "");
}

/**
 * 헬퍼를 import로 확인한다 — 스캐너들은 `geminiTuning(…)`을 이름으로 알아보므로, 그 이름이 그 파일에서 진짜 헬퍼여야 한다.
 *   imported: `import { geminiTuning } from "@/lib/ai/gemini-config"`(상대 경로도)가 있다
 *   violations("파일:줄 원문"): 별칭(geminiTuning as X)·네임스페이스(* as G)·동적 import — 스캐너가 호출을 못 알아본다 —
 *     그리고 다른 것을 geminiTuning이라는 이름으로 들이거나 선언한 것(헬퍼가 아닌데 헬퍼로 센다).
 *   타입 전용 import는 런타임 헬퍼를 들일 수 없어 보지 않는다.
 */
function helperImport(fileName: string, text: string): { imported: boolean; violations: string[] } {
  const sf = parse(fileName, text);
  let imported = false;
  const violations: string[] = [];
  const flag = (n: ts.Node, what = n.getText(sf)): void => { violations.push(`${fileName}:${lineOf(sf, n)} ${what}`); };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause && !n.importClause.isTypeOnly) {
      const spec = n.moduleSpecifier.text;
      const fromHelper = resolveImport(fileName, spec) === HELPER_MODULE;
      const { name, namedBindings } = n.importClause;
      if (name?.text === HELPER_NAME) flag(name, `${HELPER_NAME} (기본 import) from "${spec}"`);
      if (namedBindings && ts.isNamespaceImport(namedBindings) && fromHelper) flag(namedBindings);
      for (const el of namedBindings && ts.isNamedImports(namedBindings) ? namedBindings.elements : []) {
        if (el.isTypeOnly) continue;
        if (fromHelper && (el.propertyName ?? el.name).text === HELPER_NAME) {
          if (el.propertyName) flag(el); else imported = true;
        } else if (el.name.text === HELPER_NAME) {
          flag(el, `${el.getText(sf)} from "${spec}"`);
        }
      }
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const spec = n.arguments[0];
      if (spec && ts.isStringLiteralLike(spec) && resolveImport(fileName, spec.text) === HELPER_MODULE) flag(n);
    } else if ((ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)
      || ts.isParameter(n) || ts.isBindingElement(n)) && n.name !== undefined && ts.isIdentifier(n.name)
      && n.name.text === HELPER_NAME) {
      flag(n.name, `${HELPER_NAME} 선언`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { imported, violations };
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

/**
 * 헬퍼 두 번째 인자의 thinkingBudget — 숫자 리터럴이면 그 수. 인자 안의 펼침·계산된 키도 예산을 바꿀 수 있어 원문으로 남긴다.
 *   env 예산 파일(ENV_BUDGET)은 **그 env 식별자일 때만** 기본값 — 그 밖의 식(-1 같은 음수 포함)은 원문이라 위반이 된다.
 */
function budgetOf(call: ts.CallExpression, fileName: string, sf: ts.SourceFile): number | string {
  const arg = call.arguments[1];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return `<객체 리터럴 아님: ${(arg ?? call).getText(sf)}>`;
  const b = readKey(arg, "thinkingBudget", sf, () => false);
  if (b.unverifiable.length > 0) return b.unverifiable.join(", ");
  if (b.value === undefined) return "<thinkingBudget 없음>";
  if (ts.isNumericLiteral(b.value)) return Number(b.value.text);
  const env = ENV_BUDGET[fileName];
  return env !== undefined && ts.isIdentifier(b.value) && b.value.text === env.identifier
    ? env.defaultValue : b.value.getText(sf);
}

/**
 * 숫자 리터럴, 또는 같은 파일 **최상위** `const 이름 = <숫자 리터럴>`을 가리키는 식별자의 값 — 그 밖은 undefined.
 *   상한을 이름 붙인 상수로 적는 호출부용(동반자: config 상한과 thinking 예산 상한이 COMPANION_MAX_OUTPUT_TOKENS
 *   하나를 쓴다). 그 이름의 선언이 파일에 하나뿐일 때만 읽는다 — 안쪽에서 같은 이름을 다시 선언하면(가림) 못 읽은 것.
 */
function numericValue(e: ts.Expression, sf: ts.SourceFile): number | undefined {
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (!ts.isIdentifier(e)) return undefined;
  const decls: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n))
      && n.name !== undefined && ts.isIdentifier(n.name) && n.name.text === e.text) decls.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const d = decls.length === 1 ? decls[0] : undefined;
  if (!d || !ts.isVariableDeclaration(d) || !d.initializer || !ts.isNumericLiteral(d.initializer)) return undefined;
  const list = d.parent;
  const topLevelConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0
    && ts.isVariableStatement(list.parent) && list.parent.parent === sf;
  return topLevelConst ? Number(d.initializer.text) : undefined;
}

/**
 * 헬퍼 결과가 펼쳐진 config의 maxOutputTokens — 숫자(리터럴·최상위 숫자 상수)면 그 수, 그 밖의 꼴은 원문(위반으로 드러난다).
 *   Infinity(상한 없음 = 모델 기본 상한, Live)는 상한이 **어떤 꼴로도 없고** 헬퍼 결과 말고는 펼침도 없을 때만.
 */
function capOf(config: ts.ObjectLiteralExpression, call: ts.CallExpression, sf: ts.SourceFile): number | string {
  const m = readKey(config, "maxOutputTokens", sf, isOwnTuning(call));
  if (m.unverifiable.length > 0) return m.unverifiable.join(", ");
  if (m.value === undefined) return Infinity;
  return numericValue(m.value, sf) ?? m.value.getText(sf);
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

/**
 * 소스에서 읽은 행의 불변식 위반 — 숫자로 못 읽었거나 maxOutputTokens < thinkingBudget + 128.
 *   (SDK에 실제로 간 요청은 helpers/gemini-headroom의 headroomViolations가 같은 128로 본다)
 */
const rowHeadroomViolations = (rows: Headroom[]): string[] => rows
  .filter((r) => typeof r.budget !== "number" || typeof r.maxOutputTokens !== "number"
    || r.maxOutputTokens < r.budget + MIN_OUTPUT_HEADROOM)
  .map((r) => `${r.at} thinkingBudget=${r.budget} maxOutputTokens=${r.maxOutputTokens}`);

const CAP_KEY = "maxOutputTokens";
const isCapLiteral = (n: ts.Node): boolean => ts.isStringLiteralLike(n) && n.text === CAP_KEY;

/** 검증된 여유 행의 상한 원소 — 헬퍼 결과가 펼쳐진 config의 `maxOutputTokens: …`·축약형(capOf가 값을 읽는 바로 그 노드) */
function rowCapMembers(sf: ts.SourceFile): Set<ts.Node> {
  const members = new Set<ts.Node>();
  const visit = (n: ts.Node): void => {
    if (isHelperCall(n)) {
      for (const p of configsOf(n).flatMap((c) => [...c.properties])) {
        if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && keyName(p.name) === CAP_KEY) members.add(p);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return members;
}

/** 쓰기 대상이 `X.maxOutputTokens`·`X["maxOutputTokens"]`면 그 이름 노드 */
function capWriteTarget(e: ts.Expression): ts.Node | undefined {
  if (ts.isPropertyAccessExpression(e) && e.name.text === CAP_KEY) return e.name;
  if (ts.isElementAccessExpression(e) && isCapLiteral(e.argumentExpression)) return e.argumentExpression;
  return undefined;
}

/** 객체 리터럴이 Object.assign(대상, …원본)의 원본 자리인가 */
function isObjectAssignSource(obj: ts.ObjectLiteralExpression): boolean {
  const call = obj.parent;
  return ts.isCallExpression(call) && call.arguments.indexOf(obj) >= 1
    && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "assign"
    && ts.isIdentifier(call.expression.expression) && call.expression.expression.text === "Object";
}

/**
 * maxOutputTokens를 정할 수 있는 모든 곳 — 객체 리터럴의 `키: 값`·축약형·메서드/접근자·계산된 키(["maxOutputTokens"]),
 *   사후 쓰기(X.maxOutputTokens = …·X["maxOutputTokens"] = …·복합 대입·++/--), 그 밖의 문자열 "maxOutputTokens"(const K =
 *   "maxOutputTokens" 뒤 cfg[K] = … 처럼 키로 쓰일 수 있다). Object.assign 원본 리터럴의 원소는 원문 앞에 "Object.assign 원본".
 *   타입 위치(interface·Pick<…, "maxOutputTokens">)는 값이 아니라 뺀다. 읽기(cfg.maxOutputTokens)는 상한을 정하지 않는다.
 */
function capOccurrences(sf: ts.SourceFile): { node: ts.Node; text: string }[] {
  const found: { node: ts.Node; text: string }[] = [];
  const covered = new Set<ts.Node>();   // 계산된 키·쓰기 대상으로 이미 센 문자열
  const visit = (n: ts.Node): void => {
    if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return;
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isMethodDeclaration(n)
      || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) && ts.isObjectLiteralExpression(n.parent)) {
      const name = n.name;
      const computed = ts.isComputedPropertyName(name) && isCapLiteral(name.expression) ? name.expression : undefined;
      if (computed) covered.add(computed);
      if (computed || keyName(name) === CAP_KEY) {
        found.push({ node: n, text: `${isObjectAssignSource(n.parent) ? "Object.assign 원본 " : ""}${n.getText(sf)}` });
      }
    } else {
      const written = ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? n.left
        : (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
          && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken) ? n.operand
          : undefined;
      const target = written && capWriteTarget(written);
      if (target) { covered.add(target); found.push({ node: n, text: n.getText(sf) }); }
      else if (isCapLiteral(n) && !covered.has(n)) found.push({ node: n, text: n.parent.getText(sf) });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** 검증된 여유 행 밖의 maxOutputTokens — "파일:줄 원문". 행 안의 값은 thinkingHeadroom·rowHeadroomViolations가 숫자로 본다 */
function capClosureViolations(fileName: string, text: string): string[] {
  const sf = parse(fileName, text);
  const verified = rowCapMembers(sf);
  return capOccurrences(sf).filter((o) => !verified.has(o.node)).map((o) => `${fileName}:${lineOf(sf, o.node)} ${o.text}`);
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
      `const c = { ...geminiTuning(m, { thinkingBudget: ${budget}, thinkingLevel: "low" }), maxOutputTokens: 2048 };`;
    const src = [cfg("THINKING_BUDGET"), cfg("-1"), cfg("OTHER_BUDGET"), cfg("THINKING_BUDGET * 2")].join("\n");
    const rows = thinkingHeadroom("lib/chat/llm.ts", src);
    expect(rows.map((r) => r.budget)).toEqual([512, "-1", "OTHER_BUDGET", "THINKING_BUDGET * 2"]);
    // 🔒 예전 판독기는 llm.ts의 숫자 아닌 예산을 전부 512로 읽었다 — -1(동적 thinking)도 녹색
    expect(rowHeadroomViolations(rows)).toEqual([
      "lib/chat/llm.ts:2 thinkingBudget=-1 maxOutputTokens=2048",
      "lib/chat/llm.ts:3 thinkingBudget=OTHER_BUDGET maxOutputTokens=2048",
      "lib/chat/llm.ts:4 thinkingBudget=THINKING_BUDGET * 2 maxOutputTokens=2048",
    ]);
    // env 예산 파일이 아니면 같은 이름도 원문
    expect(thinkingHeadroom("lib/chat/other.ts", cfg("THINKING_BUDGET"))[0].budget).toBe("THINKING_BUDGET");
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
