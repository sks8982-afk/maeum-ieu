/**
 * gemini-config-contract의 소스 판독기 — app/·lib/ 소스를 TypeScript 구문 트리로 읽는 스캐너들(계약 표·테스트는 그 파일).
 *   정규식이 아니라 구문 트리라 주석·문자열 속 키는 무시된다. 스캐너가 공허하지 않은지는 그 파일의 '스캐너 자체 검증'이,
 *   실파일 사본에 낸 구멍을 잡는지는 '실파일 사본 변이'가 고정한다. 여유 불변식의 128은 helpers/gemini-headroom 하나다.
 */
import ts from "typescript";
import { readdirSync } from "node:fs";
import path from "node:path";
import { MIN_OUTPUT_HEADROOM } from "@/__tests__/helpers/gemini-headroom";

export const HELPER_FILE = "lib/ai/gemini-config.ts";
const HELPER_NAME = "geminiTuning";
/** Gemini에 직접 실으면 안 되는 키 — thinkingConfig 통째로도 헬퍼 밖에선 금지 */
const FORBIDDEN = new Set(["temperature", "topP", "topK", "thinkingBudget", "thinkingLevel", "thinkingConfig"]);

/** 헬퍼 모듈(저장소 상대·확장자 없음) — 각 파일의 import 경로를 이것으로 풀어 헬퍼인지 본다 */
const HELPER_MODULE = HELPER_FILE.replace(/\.ts$/, "");
/** SDK 요청을 내는 호출 — 호출식 끝의 `<소유>.<메서드>`(ai.models.generateContent·getGenAI().models.generateContent 등) */
const REQUEST_CALLS = new Set(["models.generateContent", "models.generateContentStream", "authTokens.create", "live.connect"]);

/**
 * 예산을 env로 정하는 호출부 — 그 파일에서 env로 정한 **식별자 하나만** 기본값으로 읽는다(소스에서 값을 읽을 수 없다).
 *   다른 식별자·식은 원문으로 남아 위반이 된다 — 예전엔 파일 단위로 기본값을 끼워 넣어 `thinkingBudget: -1`(2.5의 동적
 *   thinking — 상한 안에서 얼마나 생각할지 정해지지 않는다)도 512로 읽혀 녹색이었다. 기본값 512는 실요청 캡처
 *   (gemini-config-callsites '동반자 getTextModel')가 고정한다 — 바꾸면 둘 다. env로 1921 이상을 줘도 llm.ts가
 *   1920(상한 2048 − 128)에서 자른다 — 그 천장은 소스로 못 읽어 gemini-config-callsites가 "5000" → 1920으로 고정한다.
 * 그 식별자도 이름이 아니라 선언으로 푼다(resolvesToEnvBudget): 파일에 그 이름의 선언이 하나뿐이고 그것이 scope 함수
 *   본문의 const일 때만 — 이름만 보던 때는 getTextModel을 베낀 getter가 자기 THINKING_BUDGET(기본값 2048)을 선언해도
 *   512로 읽혀 녹색이었다(상한 2048이면 답 쓸 몫이 0이다).
 */
const ENV_BUDGET: Record<string, { identifier: string; scope: string; defaultValue: number }> = {
  "lib/chat/llm.ts": { identifier: "THINKING_BUDGET", scope: "getTextModel", defaultValue: 512 },
};

export function listSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.posix.join(dir, e.name);
    if (e.isDirectory()) return listSources(p);
    return /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts") ? [p] : [];
  });
}

export function parse(fileName: string, text: string): ts.SourceFile {
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
export function findRawTuningKeys(fileName: string, text: string): string[] {
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

export function countHelperCalls(fileName: string, text: string): number {
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
export function countRequestSites(fileName: string, text: string): number {
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
export function helperImport(fileName: string, text: string): { imported: boolean; violations: string[] } {
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
export function helperLevels(fileName: string, text: string): (string | null)[] {
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

export type Headroom = { at: string; budget: number | string; maxOutputTokens: number | string };

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

/** 파일 안의 `name` 선언 전부 — 변수·매개변수·구조 분해 원소·함수 선언. 범위는 가리지 않는다(안쪽에서 다시 선언해도 센다) */
function declarationsOf(name: string, sf: ts.SourceFile): ts.Node[] {
  const decls: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n) || ts.isFunctionDeclaration(n))
      && n.name !== undefined && ts.isIdentifier(n.name) && n.name.text === name) decls.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return decls;
}

/**
 * 파일에 `name` 선언이 **하나뿐**이고 그것이 `const name = …` 문장이면 그 선언과 문장이 놓인 자리(파일 최상위면 SourceFile ·
 *   함수 본문 바로 아래면 그 Block) — 그 밖은 undefined. 어디서든 같은 이름을 다시 선언하면(가림·다른 함수) 하나를 못 고른다.
 */
function soleConst(name: string, sf: ts.SourceFile): { decl: ts.VariableDeclaration; home: ts.Node } | undefined {
  const decls = declarationsOf(name, sf);
  const d = decls.length === 1 ? decls[0] : undefined;
  if (!d || !ts.isVariableDeclaration(d)) return undefined;
  const list = d.parent;
  return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0 && ts.isVariableStatement(list.parent)
    ? { decl: d, home: list.parent.parent } : undefined;
}

/**
 * env 예산 식별자가 그 env 선언으로 풀리는가 — 파일에 그 이름의 선언이 하나뿐이고(soleConst) 그것이 scope 함수 본문 바로
 *   아래의 const이며, 참조도 그 본문 안이다. 두 함수가 같은 이름을 각자 선언하면(베낀 getter의 자기 기본값) 어느 쪽이 env인지
 *   소스로 못 정하므로 둘 다 아니다 → 원문 → 위반. 그 const의 값(기본값 512·천장 1920)은 gemini-config-callsites가 실요청으로 본다.
 */
function resolvesToEnvBudget(ref: ts.Identifier, scope: string, sf: ts.SourceFile): boolean {
  const body = soleConst(ref.text, sf)?.home;
  const fn = body?.parent;
  return body !== undefined && ts.isBlock(body) && fn !== undefined && ts.isFunctionDeclaration(fn) && fn.name?.text === scope
    && ref.pos >= body.pos && ref.end <= body.end;
}

/**
 * 헬퍼 두 번째 인자의 thinkingBudget — 숫자 리터럴이면 그 수. 인자 안의 펼침·계산된 키도 예산을 바꿀 수 있어 원문으로 남긴다.
 *   env 예산 파일(ENV_BUDGET)은 **그 env 식별자가 그 env 선언으로 풀릴 때만**(resolvesToEnvBudget) 기본값 — 그 밖의 식
 *   (-1 같은 음수 포함)·같은 이름의 다른 선언은 원문이라 위반이 된다.
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
    && resolvesToEnvBudget(b.value, env.scope, sf) ? env.defaultValue : b.value.getText(sf);
}

/**
 * 숫자 리터럴, 또는 같은 파일 **최상위** `const 이름 = <숫자 리터럴>`을 가리키는 식별자의 값 — 그 밖은 undefined.
 *   상한을 이름 붙인 상수로 적는 호출부용(동반자: config 상한과 thinking 예산 상한이 COMPANION_MAX_OUTPUT_TOKENS
 *   하나를 쓴다). 그 이름의 선언이 파일에 하나뿐일 때만 읽는다 — 안쪽에서 같은 이름을 다시 선언하면(가림) 못 읽은 것.
 */
function numericValue(e: ts.Expression, sf: ts.SourceFile): number | undefined {
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (!ts.isIdentifier(e)) return undefined;
  const c = soleConst(e.text, sf);
  return c?.home === sf && c.decl.initializer && ts.isNumericLiteral(c.decl.initializer)
    ? Number(c.decl.initializer.text) : undefined;
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
export function thinkingHeadroom(fileName: string, text: string): Headroom[] {
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
export const rowHeadroomViolations = (rows: Headroom[]): string[] => rows
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
 * maxOutputTokens를 정할 수 있는 모든 곳 — 객체 리터럴의 `키: 값`(따옴표 키 "maxOutputTokens": … 포함)·축약형·메서드/접근자·
 *   계산된 키(["maxOutputTokens"]), 사후 쓰기(X.maxOutputTokens = …·X["maxOutputTokens"] = …·복합 대입·++/--), 그 밖의 문자열
 *   "maxOutputTokens"(const K = "maxOutputTokens" 뒤 cfg[K] = … 처럼 키로 쓰일 수 있다). Object.assign 원본 리터럴의 원소는
 *   원문 앞에 "Object.assign 원본". 타입 위치(interface·Pick<…, "maxOutputTokens">)는 값이 아니라 뺀다. 읽기(cfg.maxOutputTokens)는
 *   상한을 정하지 않는다. 원소 하나는 한 번만 센다 — 키 자리의 문자열(계산된 키·따옴표 키)과 쓰기 대상은 그 원소·쓰기로 센다.
 */
export function capOccurrences(sf: ts.SourceFile): { node: ts.Node; text: string }[] {
  const found: { node: ts.Node; text: string }[] = [];
  const covered = new Set<ts.Node>();   // 계산된 키·따옴표 키·쓰기 대상으로 이미 센 문자열
  const visit = (n: ts.Node): void => {
    if (ts.isTypeNode(n) && !ts.isExpressionWithTypeArguments(n)) return;
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isMethodDeclaration(n)
      || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) && ts.isObjectLiteralExpression(n.parent)) {
      const name = n.name;
      const computed = ts.isComputedPropertyName(name) && isCapLiteral(name.expression) ? name.expression : undefined;
      if (computed) covered.add(computed);
      // 따옴표 키는 원소로 셌다 — 이름 문자열을 또 세면 검증된 행의 상한이 '행 밖 상한'으로 한 번 더 잡힌다
      if (isCapLiteral(name)) covered.add(name);
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
export function capClosureViolations(fileName: string, text: string): string[] {
  const sf = parse(fileName, text);
  const verified = rowCapMembers(sf);
  return capOccurrences(sf).filter((o) => !verified.has(o.node)).map((o) => `${fileName}:${lineOf(sf, o.node)} ${o.text}`);
}
