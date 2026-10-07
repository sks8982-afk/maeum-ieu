/**
 * 대화 품질 + 이상 감지 성능 자동 평가기
 *
 * 사용법:
 *   npx tsx scripts/eval-quality.ts [conversationId] [lastN]
 *     conversationId: 생략 시 가장 최근 대화
 *     lastN: 뒤에서부터 몇 턴 평가할지 (기본 30)
 *
 * 출력 지표
 * ─ 대화 품질 (AI 응답 기반)
 *   repeat_question   AI가 직전 user 발언의 정보를 재질문한 횟수
 *   hallucination     대화 맥락 밖 고유명사 등장
 *   honorific_err     회원님/고객님 등
 *   time_label_leak   [N일 전] 등 누출
 * ─ 이상 감지 (user 발언 기반)
 *   TP / FN / FP      휴리스틱 ground truth 대비
 *   recall / precision
 */
import "dotenv/config";
import { Pool } from "pg";
import { pgTlsOptions } from "../lib/db-tls";
interface MsgRow {
  id: string;
  role: string;
  content: string;
  isAnomaly: boolean | null;
  analysisNote: string | null;
  createdAt: Date;
}

// ── 이상 발언 휴리스틱 (실제 이상 발화가 포함하는 시그니처) ───────────────
const ANOMALY_SIGNATURES: { name: string; pattern: RegExp }[] = [
  { name: "비현실_생물", pattern: /(UFO|외계인|공룡|천사|도깨비|유령|마당에.*호랑이|화단에.*호랑이|화단에.*사자|거실에.*사자|집에서.*호랑이)/ },
  // 한국 역사 인물 + 현대 사망 정치인 + 외국 위인 망라. 동사도 자연 대화에 자주 나오는 형태로 확장.
  { name: "사망인물", pattern: /(박정희|이승만|전두환|김구|김대중|노무현|이순신(?:\s*장군)?|세종(?:대왕)?|이방원|영조|정조|숙종|태조|광개토(?:대왕)?|이성계|마더\s*테레사|히틀러|마오쩌둥|레닌|스탈린|김일성|김정일).*(만나|만났|먹었|먹었어|저녁|점심|아침|차\s*한잔|연설|봤|보았|말씀|함께|같이|이야기|대화|나눴|나누|통일|통화|찾아왔|왔어|와서|왔|들렀|놀러|인사|갔어|가서|갔|동네|우리\s*집|우리집|댁에)|(?:만났|먹었|봤|함께|같이|왔어|와서|찾아왔|들렀).*(박정희|이승만|전두환|김구|김대중|노무현|이순신|세종|이방원|영조|정조|광개토|마더\s*테레사|히틀러|마오쩌둥|김일성)/ },
  { name: "과거연도_오늘", pattern: /오늘.*(19[5-9]\d|200\d|201\d)년|오늘이? ?(19[5-9]\d|20[01]\d)년|(19[5-9]\d|20[01]\d)년.*(광복절|개막|생중계|특집)/ },
  { name: "미래연도_오늘", pattern: /오늘이? ?(203\d|204\d|205\d)년|금년이? ?(203\d|204\d|205\d)년/ },
  { name: "원거리_장소", pattern: /(하와이|미국 LA|LA에 있|뉴욕|파리|에펠탑|제주도|서귀포|부산 해운대|해운대 바다|설악산.*와있|설악산에 와|도쿄|일본 도쿄|오사카)/ },
  { name: "계절_반전", pattern: /(한겨울|눈이 소복|눈이 펑펑|눈이 쌓|창밖에 눈|올해도 눈이 많)/ },
  { name: "연령_이벤트", pattern: /(다음달|내일|이번달|오늘).*(군대 입대|초등학교 입학|대학(?:교)? 입학|유치원 입학|훈련소|첫 등교|입대.*걱정)/ },
  { name: "수리_이상", pattern: /만원.*2만원.*돌려|5천원.*천원.*4천원|만원.*천원.*4천원|천원 냈는데 4천원|5천원어치.*천원.*돌려|만원짜리.*2만원.*거스|2천원.*만원.*만오천원|천원짜리.*만원.*거스|3천원짜리.*5만원.*3천원만|\d+원짜리.*\d+만원.*\d+천원만/ },
  { name: "관계_혼동", pattern: /민지.*(둘째딸|내 딸|내 아들|내 엄마|며느리|큰아들|장녀)/ },
  { name: "역사사건_오늘", pattern: /오늘.*(유신헌법|88올림픽|1988.*올림픽|광주민주화|월드컵 한국.*이겼|박정희.*연설)|금방 88올림픽|88올림픽.*생중계/ },
  { name: "연도_본인나이_혼동", pattern: /아흔이 됐|군대 갈.*나이|입학.*설레|엄마가 새옷|입학식이라 양복/ },
  // 주의: 자해·자살 의도는 cognitive isAnomaly 축이 아니라 emergency 트랙(emergencyLevel/보호자 알림)으로 처리됨.
  //       따라서 이 GT(isAnomaly 비교)에는 자해 시그니처를 넣지 않는다 — 넣으면 임상 축을 혼동해 가짜 FN 발생.
  //       (자해 ideation 탐지·109 안내 검증은 scripts/_tmp-emergency.ts + 라이브로 별도 수행.)
];

// 부정/정정 발언은 이상 아님 (AI 응답 반박 / 본인 정정)
// "농담이야/꿈이었나/장난"도 자기 정정으로 간주.
const NEGATION_PATTERNS: RegExp[] = [
  /(안\s*갔|안\s*했|안\s*먹|없었|아니야|아니고|아니지|한\s*적\s*없|그런\s*말\s*한\s*적|무슨|옛날이지|헷갈렸네|내가\s*잠깐|농담이(?:야|에)|장난이(?:야|에)|꿈에서|꿈이었|꿈인가|상상)/,
];

function detectAnomalySignatures(text: string): string[] {
  // 발화를 절(clause) 단위로 쪼개 각 절별로 검사.
  // 한 발화에 "이순신 농담이야 + 김대중 만났어"처럼 부정·이상이 혼재하는 케이스 처리.
  // 부정어가 있는 절은 정상으로 보지만, 다른 절에 별도 시그니처가 있으면 이상으로 판정.
  const segments = text.split(/[.!?]+\s*|\s+그것보다\s+|\s+그건\s+|\s+근데\s+|\s+그리고\s+|\s+그러고\s+/).filter((s) => s.trim().length > 0);
  const found = new Set<string>();
  for (const seg of segments) {
    if (NEGATION_PATTERNS.some((p) => p.test(seg))) continue;
    for (const sig of ANOMALY_SIGNATURES) {
      if (sig.pattern.test(seg)) found.add(sig.name);
    }
  }
  return Array.from(found);
}

// ── 대화 품질 탐지기 ──────────────────────────────────────────────────────
function detectHonorificError(ai: string): boolean {
  return /회원님|고객님|사장님|어르신.*(세요|예요)/.test(ai);
}

function detectTimeLabelLeak(ai: string): boolean {
  return /\[\s*(방금|어제|오늘)\s*\]|\[\s*\d+\s*(분|시간|일|주|개월|달|년)\s*전\s*\]/.test(ai);
}

function extractContentWords(s: string): Set<string> {
  const stop = new Set([
    "할아버지","할머니","민지","오늘","그리고","그래서","정말","근데","그런데",
    "있어","있지","맞아","으면","으니","지만","에요","네요","지요","때문","요즘",
    "많이","좀","그","이","저","것","거","수","때","안","못","때문","혹시","생각"
  ]);
  const words = (s.match(/[가-힣]{2,}/g) || []).filter((w) => !stop.has(w));
  return new Set(words);
}

// 반복 질문: AI가 묻는 "답"이 직전 user 발화에 이미 명시된 경우만
// 예: user "노인복지관 체조 하러 간다" → AI "어디로 가시는 거예요?" (장소는 이미 말함) → 반복
// 예: user "여섯살 유치원" → AI "몇 살이에요?" → 반복
// 예: user "무릎 아파" → AI "언제 아파요?" → 세부 질문이지 반복 아님
function detectRepeatQuestion(ai: string, prevUser: string): boolean {
  const askDimensions: { wh: RegExp; hasAnswer: RegExp }[] = [
    { wh: /어디로|어디에 가|어디 가시|어디에서|어디예요/, hasAnswer: /\b(복지관|병원|시장|경로당|교회|공원|집|마트|편의점|학교|식당)\b/ },
    { wh: /몇 살|몇살|나이가 어떻게|연세가 어떻게/, hasAnswer: /\b(\d+살|\d+세|여섯살|일곱살|여덟살|아홉살|열살)\b/ },
    { wh: /언제 가시|언제 오시|언제예요|며칠에|몇 시에|무슨 요일/, hasAnswer: /\b(오늘|내일|어제|모레|다음주|이번주|주말|오전|오후|아침|저녁|\d+시|\d+일|\d+월)\b/ },
    { wh: /뭘 드셨|뭐 드셨|무엇을 드셨|어떤 음식/, hasAnswer: /\b(밥|국|찌개|김치|국수|면|고기|생선|빵|과일|커피|차|죽|누룽지)\b/ },
    { wh: /누구랑|누구와|누구하고/, hasAnswer: /\b(아들|딸|손자|손녀|친구|아내|남편|이웃|혼자|혼자서)\b/ },
    { wh: /얼마(?:예요|인가요)|얼마나 주|가격이/, hasAnswer: /\b\d+원\b/ },
  ];
  for (const d of askDimensions) {
    if (d.wh.test(ai) && d.hasAnswer.test(prevUser)) return true;
  }
  return false;
}

function detectHallucinationName(
  ai: string,
  recentUserTexts: string[],
  rag: string
): string[] {
  // AI 응답에서 구체 명사/속성이 등장했는데, 최근 user 발화·rag에 없으면 할루시.
  // 호칭(아드님·며느님·따님·어머님·아버님)은 한국어 자연 화법의 가족 호칭일 뿐 정보 노출이 아님 → 검사 대상에서 제외.
  // 진짜 할루시는 구체 장소·사물·사건·신체 부위·관계 등 사실 정보가 근거 없이 등장하는 경우.
  const suspects = ai.match(/(하와이|LA|뉴욕|파리|에펠탑|제주도|부산|서귀포|해운대|병원|책|드라마|영화|카페|등산|낚시|공룡|UFO|물리치료|허리|아내|전화)/g) || [];
  // 의미 동의어: AI가 "아내" 했을 때 사용자가 "안사람/처/와이프/마누라/집사람" 으로 말했다면 동일 대상.
  const SYNONYMS: Record<string, string[]> = {
    "아내": ["안사람", "와이프", "마누라", "집사람", "여편네", "처"],
    "남편": ["바깥양반", "주인양반", "남편"],
  };
  const haystack = (recentUserTexts.join(" ") + " " + rag);
  const hits: string[] = [];
  for (const s of suspects) {
    if (haystack.includes(s)) continue;
    // 동의어 매칭
    const syns = SYNONYMS[s];
    if (syns && syns.some((alt) => haystack.includes(alt))) continue;
    hits.push(s);
  }
  return Array.from(new Set(hits));
}

// ── 메인 ──────────────────────────────────────────────────────────────────
async function main() {
  const convIdArg = process.argv[2];
  const lastN = parseInt(process.argv[3] || "30", 10);

  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const client = await pool.connect();
  try {
    let convId = convIdArg;
    if (!convId) {
      const r = await client.query(
        `SELECT "conversationId" FROM "Message" ORDER BY "createdAt" DESC LIMIT 1`
      );
      convId = r.rows[0]?.conversationId;
      if (!convId) { console.log("대화 없음"); return; }
    }

    const msgs: MsgRow[] = (await client.query(
      `SELECT id, role, content, "isAnomaly", "analysisNote", "createdAt"
       FROM "Message" WHERE "conversationId" = $1
       ORDER BY "createdAt" DESC LIMIT $2`,
      [convId, lastN * 2]
    )).rows.reverse();

    console.log(`\n=== conversationId: ${convId} (최근 ${msgs.length}건) ===\n`);

    let repeatQ = 0;
    let honorificErr = 0;
    let timeLabelLeak = 0;
    const hallucinations: { idx: number; names: string[] }[] = [];

    let tp = 0, fn = 0, fp = 0, tn = 0;
    const fnSamples: string[] = [];
    const fpSamples: string[] = [];

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === "assistant") {
        if (detectHonorificError(m.content)) honorificErr++;
        if (detectTimeLabelLeak(m.content)) timeLabelLeak++;

        // 직전 user 발언 찾기
        const prev = msgs[i - 1];
        if (prev && prev.role === "user") {
          if (detectRepeatQuestion(m.content, prev.content)) {
            repeatQ++;
            if (repeatQ <= 6) console.log(`  [REPEAT] prev="${prev.content.slice(0,50)}" ai="${m.content.slice(0,80)}"`);
          }
        }

        // 할루시네이션 검사: 최근 10턴 user + 빈 RAG
        const recentUsers = msgs.slice(Math.max(0, i - 10), i).filter((x) => x.role === "user").map((x) => x.content);
        const halluNames = detectHallucinationName(m.content, recentUsers, "");
        if (halluNames.length > 0) hallucinations.push({ idx: i, names: halluNames });
      } else if (m.role === "user") {
        const sigs = detectAnomalySignatures(m.content);
        const shouldFlag = sigs.length > 0;
        const flagged = m.isAnomaly === true;
        if (shouldFlag && flagged) tp++;
        else if (shouldFlag && !flagged) { fn++; fnSamples.push(`"${m.content.slice(0,60)}" [${sigs.join(",")}]`); }
        else if (!shouldFlag && flagged) { fp++; fpSamples.push(`"${m.content.slice(0,60)}" note:${(m.analysisNote||"").slice(0,60)}`); }
        else tn++;
      }
    }

    const aiCount = msgs.filter((m) => m.role === "assistant").length;
    const userCount = msgs.filter((m) => m.role === "user").length;

    console.log("── 대화 품질 (AI 응답 기준) ────────────");
    console.log(`  반복 질문:         ${repeatQ}/${aiCount} (${(repeatQ/Math.max(1,aiCount)*100).toFixed(1)}%)`);
    console.log(`  할루시네이션 명사: ${hallucinations.length}/${aiCount}`);
    if (hallucinations.length) {
      for (const h of hallucinations.slice(0, 5)) console.log(`    → idx=${h.idx}: ${h.names.join(", ")}`);
    }
    console.log(`  호칭 오류:         ${honorificErr}/${aiCount}`);
    console.log(`  시간 라벨 누출:    ${timeLabelLeak}/${aiCount}`);

    console.log("\n── 이상 감지 (user 발언 기준, 휴리스틱 GT) ────");
    console.log(`  TP (정탐): ${tp}   FN (놓침): ${fn}   FP (오탐): ${fp}   TN: ${tn}`);
    const recall = tp + fn > 0 ? (tp / (tp + fn) * 100).toFixed(1) : "-";
    const precision = tp + fp > 0 ? (tp / (tp + fp) * 100).toFixed(1) : "-";
    console.log(`  Recall: ${recall}%   Precision: ${precision}%`);
    if (fnSamples.length) {
      console.log(`  놓친 것:`);
      for (const s of fnSamples.slice(0, 5)) console.log(`    ❌ ${s}`);
    }
    if (fpSamples.length) {
      console.log(`  오탐:`);
      for (const s of fpSamples.slice(0, 5)) console.log(`    ⚠️ ${s}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(console.error);
