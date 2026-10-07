/** 특정 메시지 인덱스 범위만 평가 (최근 N 대신 과거 구간 비교용) */
import "dotenv/config";
import { Pool } from "pg";
import { pgTlsOptions } from "../../lib/db-tls";
interface MsgRow { id: string; role: string; content: string; isAnomaly: boolean | null; analysisNote: string | null; createdAt: Date; }

const ANOMALY_SIGNATURES: { name: string; pattern: RegExp }[] = [
  { name: "비현실_생물", pattern: /(UFO|외계인|공룡|천사|도깨비|유령|마당에.*호랑이|화단에.*호랑이)/ },
  { name: "사망인물", pattern: /(박정희|이승만|전두환|김구|세종대왕).*(만나|먹|저녁|차 한잔|각하.*연설|동기|인사|봤|말씀)/ },
  { name: "과거연도_오늘", pattern: /오늘.*(19[5-9]\d|200\d|201\d)년|오늘이? ?(19[5-9]\d|20[01]\d)년/ },
  { name: "미래연도_오늘", pattern: /오늘이? ?(203\d|204\d|205\d)년|금년이? ?(203\d|204\d|205\d)년/ },
  { name: "원거리_장소", pattern: /(하와이|미국 LA|LA에 있|뉴욕|파리|에펠탑|제주도|서귀포|부산 해운대|해운대 바다|설악산.*와있)/ },
  { name: "계절_반전", pattern: /(한겨울|눈이 소복|눈이 펑펑|눈이 쌓|창밖에 눈)/ },
  { name: "연령_이벤트", pattern: /(다음달|내일|이번달).*(군대 입대|초등학교 입학|대학(?:교)? 입학|유치원 입학|훈련소|입대.*걱정)/ },
  { name: "수리_이상", pattern: /만원.*2만원.*돌려|5천원.*천원.*4천원|만원.*천원.*4천원|천원 냈는데 4천원|2천원.*만원.*만오천원/ },
  { name: "관계_혼동", pattern: /민지.*(둘째딸|내 딸|내 아들|내 엄마|며느리)/ },
  { name: "역사사건_오늘", pattern: /오늘.*(유신헌법|88올림픽|1988.*올림픽|광주민주화|월드컵 한국.*이겼|박정희.*연설)/ },
  { name: "연도_본인나이_혼동", pattern: /아흔이 됐|군대 갈.*나이|입학.*설레|엄마가 새옷|입학식이라 양복/ },
];
const NEGATION = /(안\s*갔|안\s*했|안\s*먹|없었|아니야|아니고|아니지|한\s*적\s*없|그런\s*말\s*한\s*적|무슨|옛날이지|헷갈렸네|내가\s*잠깐)/;

function detect(text: string): string[] {
  if (NEGATION.test(text)) return [];
  return ANOMALY_SIGNATURES.filter((s) => s.pattern.test(text)).map((s) => s.name);
}

function detectHonorificError(ai: string): boolean {
  return /회원님|고객님|사장님|어르신.*(세요|예요)/.test(ai);
}
function detectTimeLabelLeak(ai: string): boolean {
  return /\[\s*(방금|어제|오늘)\s*\]|\[\s*\d+\s*(분|시간|일|주|개월|달|년)\s*전\s*\]/.test(ai);
}
function detectRepeatQuestion(ai: string, prevUser: string): boolean {
  const dims: { wh: RegExp; ans: RegExp }[] = [
    { wh: /어디로|어디에 가|어디 가시|어디예요/, ans: /\b(복지관|병원|시장|경로당|교회|공원|집|마트|편의점|학교|식당)\b/ },
    { wh: /몇 살|몇살|나이가 어떻게|연세가/, ans: /\b(\d+살|\d+세|여섯살|일곱살|여덟살|아홉살)\b/ },
    { wh: /언제 가시|언제 오시|언제예요|며칠|몇 시에|무슨 요일/, ans: /\b(오늘|내일|어제|모레|다음주|주말|오전|오후|아침|저녁|\d+시|\d+일|\d+월)\b/ },
    { wh: /뭘 드셨|뭐 드셨|무엇을 드셨|어떤 음식/, ans: /\b(밥|국|찌개|김치|국수|빵|과일|커피|차|죽)\b/ },
    { wh: /누구랑|누구와|누구하고/, ans: /\b(아들|딸|손자|손녀|친구|아내|남편|혼자)\b/ },
  ];
  for (const d of dims) if (d.wh.test(ai) && d.ans.test(prevUser)) return true;
  return false;
}
function detectHallucinationName(ai: string, recent: string[]): string[] {
  const suspects = ai.match(/(하와이|LA|뉴욕|파리|에펠탑|제주도|부산|서귀포|해운대|병원|책|드라마|영화|카페|등산|낚시|공룡|UFO|물리치료|허리)/g) || [];
  const hay = recent.join(" ");
  return Array.from(new Set(suspects.filter((s) => !hay.includes(s))));
}

async function main() {
  const convId = process.argv[2];
  const offset = parseInt(process.argv[3] || "60", 10);
  const window = parseInt(process.argv[4] || "60", 10);

  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT id, role, content, "isAnomaly", "analysisNote", "createdAt"
       FROM "Message" WHERE "conversationId"=$1
       ORDER BY "createdAt" DESC OFFSET $2 LIMIT $3`,
      [convId, offset, window]
    );
    const msgs: MsgRow[] = r.rows.reverse();
    console.log(`\n=== range offset=${offset} window=${window} (msgs ${msgs.length}) ===\n`);

    let rq = 0, hon = 0, tl = 0;
    const hall: number[] = [];
    let tp = 0, fn = 0, fp = 0, tn = 0;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role === "assistant") {
        if (detectHonorificError(m.content)) hon++;
        if (detectTimeLabelLeak(m.content)) tl++;
        const prev = msgs[i-1];
        if (prev?.role === "user" && detectRepeatQuestion(m.content, prev.content)) rq++;
        const recentU = msgs.slice(Math.max(0, i-10), i).filter(x=>x.role==="user").map(x=>x.content);
        if (detectHallucinationName(m.content, recentU).length > 0) hall.push(i);
      } else {
        const sigs = detect(m.content);
        const should = sigs.length > 0;
        const flagged = m.isAnomaly === true;
        if (should && flagged) tp++;
        else if (should && !flagged) fn++;
        else if (!should && flagged) fp++;
        else tn++;
      }
    }
    const ai = msgs.filter(m=>m.role==="assistant").length;
    console.log(`반복질문:   ${rq}/${ai} (${(rq/Math.max(1,ai)*100).toFixed(1)}%)`);
    console.log(`할루시:     ${hall.length}/${ai}`);
    console.log(`호칭오류:   ${hon}/${ai}`);
    console.log(`시간라벨:   ${tl}/${ai}`);
    const recall = tp+fn>0?(tp/(tp+fn)*100).toFixed(1):"-";
    const prec = tp+fp>0?(tp/(tp+fp)*100).toFixed(1):"-";
    console.log(`Recall ${recall}% / Precision ${prec}% (TP=${tp} FN=${fn} FP=${fp} TN=${tn})`);
  } finally {
    client.release(); await pool.end();
  }
}
main().catch(console.error);
