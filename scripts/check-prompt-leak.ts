/**
 * Prompt-leak detector — 시스템 프롬프트 파일에 특정 사용자의 사실 정보(이름·지명·일상)가 박혀있는지 검출.
 *
 * 두 가지 모드:
 *   - **full** (default): DB에 접속해서 실제 사용자 family_member/user_profile 데이터 cross-check
 *     - 사용: npx tsx scripts/check-prompt-leak.ts
 *     - 가장 정확. 운영 환경에서 정기 실행 권장.
 *   - **regex-only**: DB 없이 한국어 이름 패턴 휴리스틱 정적 검사 (CI 안전 모드)
 *     - 사용: npx tsx scripts/check-prompt-leak.ts --regex-only
 *     - "큰아들 X" 같이 이름 placeholder 자리에 실제 한글 이름(2~3글자)이 박혔는지 휴리스틱.
 *     - DB 접근 불필요 — GitHub Actions/CI 환경에서 안전.
 *
 * Exit code: 0 = clean, 1 = leak found
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import { pgTlsOptions } from "../lib/db-tls";
const ROOT = path.resolve(__dirname, "..");
// systemPrompt에 직접 들어가는 정적 텍스트 파일만 검사.
// route.ts는 코드+주석이라 LLM prompt와 무관 — 제외.
const PROMPT_FILES = [
  "lib/chat/constants.ts",
  "lib/chat/prompt.ts",
];

/**
 * Regex-only 모드 — DB 없이 한국어 이름 패턴 휴리스틱 검사.
 *
 * 검출 패턴: "큰아들/장남/둘째/큰딸 + 공백·조사 + (2~3글자 한글)" 가 prompt 파일에 박혀있으면 의심.
 *   ○○ / [이름A] / "OO" 같은 placeholder는 매칭 안 함 (한글 X).
 *
 * False positive 방지: 일반 명사 (아들/딸/손주/큰애 등)와 호칭(할아버지/할머니)은 stopword.
 */
function regexOnlyScan(): Array<{ file: string; line: number; type: string; value: string; snippet: string }> {
  const violations: Array<{ file: string; line: number; type: string; value: string; snippet: string }> = [];
  // "관계명 + 조사 + (이름후보) + 종결" 패턴. 종결어미("이야/이고/이지")만 매칭해 일반 동사 활용 배제.
  const NAME_AFTER_RELATION = /(?:큰\s*아들|장남|차남|둘째\s*아들|막내\s*아들|큰\s*딸|장녀|차녀|둘째\s*딸|막내\s*딸|첫\s*손자|큰\s*손자|아드님|따님)(?:[은는이가]|\s)+([가-힣]{2,3})(?:이야|이고|이지|이며|이에요|예요|이세요|세요|야)/g;
  const STOPWORD = new Set([
    // 일반 명사
    "이름", "성함", "그분", "그녀", "그애", "큰애", "막내", "둘째", "셋째", "넷째",
    "이야", "이고", "이지", "이며", "예요", "이에요", "씨가", "씨는", "씨에",
    "아들", "딸", "손주", "손자", "손녀", "아내", "남편", "어머니", "아버지", "엄마", "아빠",
    "할아버지", "할머니", "선생님", "어르신", "회원", "고객",
    // 동사 활용·일반 동작
    "받았을", "받으면", "있으면", "없으면", "되시는", "되시면", "보시면", "드시면",
    "미언급", "언급된", "언급한", "기억해", "기억나", "기억함",
    // placeholder 한글 변형
    "이름이", "이름은", "성함이", "성함은",
  ]);

  for (const rel of PROMPT_FILES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf-8");
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      NAME_AFTER_RELATION.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = NAME_AFTER_RELATION.exec(line)) !== null) {
        const candidate = m[1];
        if (!candidate || STOPWORD.has(candidate)) continue;
        // ○○, [, '를 포함하면 placeholder → skip
        if (line.includes("○") || line.includes("[이름") || line.includes("[장소")) continue;
        violations.push({
          file: rel, line: i + 1, type: "regex_name", value: candidate,
          snippet: line.trim().slice(0, 140),
        });
      }
    }
  }
  return violations;
}

async function main() {
  const regexOnly = process.argv.includes("--regex-only");
  if (regexOnly) {
    console.log("[regex-only mode] Scanning prompt files for embedded Korean names...");
    const v = regexOnlyScan();
    if (v.length === 0) {
      console.log("✓ Prompt-leak (regex-only) clean — no Korean names embedded after family relations");
      process.exit(0);
    }
    console.error(`\n❌ Found ${v.length} suspicious patterns (regex-only):\n`);
    for (const x of v) {
      console.error(`  ${x.file}:${x.line} [${x.type}=${x.value}]`);
      console.error(`    ${x.snippet}`);
    }
    console.error("\nReplace with placeholders (○○, [이름A]) — DO NOT use real user names as examples.");
    process.exit(1);
  }

  // Full 모드 — DB 접근
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL not set. Use --regex-only flag for CI environments without DB access.");
    process.exit(2);
  }
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();

  // 1) 모든 사용자별 사실 데이터 수집.
  //    ⚠ stopword 필터(2026-07-10): 추출기가 가족 "이름"란에 일반 호칭(엄마/영감 등)이나 기본 AI 이름(민지)을
  //    저장하는 경우가 있어, 그대로 매칭하면 프롬프트의 정상 텍스트(호칭 로직·few-shot 예시·기본값)를
  //    누출로 오탐 — 야간 full-check가 5일 연속 헛빨간불이었음. 일반어는 "사용자 식별자"가 아니므로 제외.
  const GENERIC_NON_NAMES = new Set([
    "엄마", "아빠", "어머니", "아버지", "할머니", "할아버지", "할멈", "영감",
    "아들", "딸", "손주", "손자", "손녀", "며느리", "사위", "언니", "오빠", "누나", "동생", "형",
    "이모", "삼촌", "고모", "조카", "남편", "아내", "부인", "여보", "당신",
    "민지", // 기본 AI 동반자 이름(COMPANION_DEFAULTS) — 정적 프롬프트에 의도적으로 존재
  ]);
  const names = new Set<string>();
  const spouseNames = new Set<string>();
  const hometowns = new Set<string>();
  try {
    const fam = await c.query(`SELECT DISTINCT name FROM family_member`);
    for (const r of fam.rows) { if (r.name && !GENERIC_NON_NAMES.has(String(r.name).trim())) names.add(r.name); }

    const prof = await c.query(`SELECT DISTINCT spouse_name, hometown FROM user_profile WHERE spouse_name IS NOT NULL OR hometown IS NOT NULL`);
    for (const r of prof.rows) {
      if (r.spouse_name && !GENERIC_NON_NAMES.has(String(r.spouse_name).trim())) spouseNames.add(r.spouse_name);
      if (r.hometown) hometowns.add(r.hometown);
    }
  } finally {
    c.release(); await pool.end();
  }

  console.log(`DB collected: ${names.size} family names, ${spouseNames.size} spouse names, ${hometowns.size} hometowns`);

  // 2) prompt 파일 검사
  const violations: Array<{ file: string; line: number; type: string; value: string; snippet: string }> = [];

  for (const rel of PROMPT_FILES) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf-8");
    const lines = text.split("\n");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // 주석 안의 placeholder ○○ / [이름A] 등은 OK. 실제 이름만 검출
      for (const n of names) {
        // 한글이 앞뒤로 더 붙은 명사 일부일 수도 있으므로 word boundary 강제
        // 한국어는 자모 단위 boundary가 어려워, "이름 + 조사" 또는 "이름 + 공백/구두점" 패턴으로
        const pat = new RegExp(`(?:^|[^가-힣])${n.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?:[가-힣]|[^가-힣])`);
        if (pat.test(line)) {
          violations.push({ file: rel, line: i + 1, type: "family_name", value: n, snippet: line.trim().slice(0, 140) });
        }
      }
      for (const sp of spouseNames) {
        if (sp.length < 2) continue;
        // 일반 명사 (안사람/아내) 제외
        if (["안사람", "아내", "남편", "집사람", "마누라"].includes(sp)) continue;
        const pat = new RegExp(`(?:^|[^가-힣])${sp.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?:[가-힣]|[^가-힣])`);
        if (pat.test(line)) {
          violations.push({ file: rel, line: i + 1, type: "spouse_name", value: sp, snippet: line.trim().slice(0, 140) });
        }
      }
      for (const ht of hometowns) {
        if (ht.length < 2) continue;
        // 일반 지명 제외 (서울/부산 등은 예시로 박혀있어도 안전)
        const COMMON_PLACES = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "동탄", "수원", "성남", "고양", "용인", "화성"];
        if (COMMON_PLACES.includes(ht)) continue;
        const pat = new RegExp(`(?:^|[^가-힣])${ht.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?:[가-힣]|[^가-힣])`);
        if (pat.test(line)) {
          violations.push({ file: rel, line: i + 1, type: "hometown", value: ht, snippet: line.trim().slice(0, 140) });
        }
      }
    }
  }

  if (violations.length === 0) {
    console.log("✓ Prompt-leak check clean — no user-specific data leaked into prompts");
    process.exit(0);
  }

  console.error(`\n❌ Found ${violations.length} prompt leaks (user-specific data in static prompts):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line} [${v.type}=${v.value}]`);
    console.error(`    ${v.snippet}`);
  }
  console.error("\nAction: replace concrete examples with placeholders (○○, [이름A], [장소]) — DO NOT use real user data.");
  process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
