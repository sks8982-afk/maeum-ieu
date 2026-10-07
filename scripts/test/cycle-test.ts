/**
 * 사이클 테스트: 10턴 대화 + 앵무새/반복 검증
 * 사용법: npx tsx scripts/cycle-test.ts <cycleNumber>
 */
import "dotenv/config";

// 함수 내부 지연 require를 정적 import로 올림(2026-10-02 린트 정리).
//   pg.Pool·fs·os·path는 import만으로 부작용이 없어 로딩 시점 변경이 동작에 영향 없다.
import { Pool } from "pg";
import { pgTlsOptions } from "../../lib/db-tls";

const BASE_URL = "http://localhost:3000";
const CONV_ID = "cmni80oop000704lk3m8ayf3b";
const EMAIL = "abc@abc.com";
const PASS = "134679";

const cycle = parseInt(process.argv[2] || "1", 10);

// AI 응답에 대한 사람같은 답변을 생성하는 로직
// AI 질문 → 적절한 답변 매핑 (사람답게, 구체적으로)
function generateUserReply(aiText: string, turnIdx: number, cycleNum: number): string {
  const t = aiText;

  // 인지 질문 답변 (구체적으로)
  if (/무슨 요일/.test(t)) return "화요일이지 오늘은";
  if (/몇 월/.test(t)) return "4월이야 지금";
  if (/며칠|날짜.*맞/.test(t)) return "20일이지";
  if (/계절/.test(t)) return "봄이야 따뜻해서 좋아";
  if (/어디.*계세|집에 계|밖에 나/.test(t)) return "지금 집 거실에 앉아있어";
  if (/동네|어디 사/.test(t)) return "화성 동탄에 살아";
  if (/가.*시작.*동물/.test(t)) return "가물치가 있지, 가재도";
  if (/ㅂ.*시작/.test(t)) return "보자기 바구니 같은거";
  if (/기차.*버스|공통점/.test(t)) return "둘다 교통수단이지";
  if (/거스름돈|만원.*5천|빼면/.test(t)) return "5천원 돌려주면 되지";
  if (/100.*7|100에서 7/.test(t)) return "93이야";
  if (/지갑.*주우|지갑.*발견/.test(t)) return "경찰서에 맡겨야지";
  if (/물이 안 나오|단수/.test(t)) return "관리실에 전화해야지";
  if (/쌀쌀.*뭘 입|옷 챙|겉옷/.test(t)) return "따뜻한 가디건 챙기지";

  // 일상 질문
  if (/점심.*뭐|점심.*드셨|점심.*메뉴/.test(t)) return "김치찌개 먹었어 맛있더라";
  if (/아침.*뭐|아침.*드셨/.test(t)) return "미역국에 밥 말아먹었어";
  if (/저녁.*뭐|저녁.*드실/.test(t)) return "간단하게 국 먹으려고";
  if (/과일/.test(t)) return "수박이랑 사과 좋아해";
  if (/고향|어릴 때|어렸을/.test(t)) return "김해가 고향이야 시골 출신이지";
  if (/가족|손자|손녀|자식/.test(t)) return "다들 잘 지내 고맙지";
  if (/기분|컨디션/.test(t)) return "오늘은 컨디션 좋아";
  if (/잠/.test(t)) return "잠은 잘 잤어 개운해";
  if (/운동|산책/.test(t)) return "아침에 공원 한바퀴 돌았어";
  if (/약|복용/.test(t)) return "잘 챙겨먹고 있어";
  if (/취미|여가|심심/.test(t)) return "TV 드라마 보는거 좋아해";
  if (/병원/.test(t)) return "다음주에 물리치료 가";
  if (/날씨/.test(t)) return "오늘 맑고 따뜻해서 좋아";
  if (/친구/.test(t)) return "경로당에서 가끔 만나";

  // 주제 전환 (턴 기반 + 사이클별 다양화)
  const topics = [
    "그나저나 TV에서 재밌는 드라마 봤어",
    "아들이 주말에 온다고 해서 기대돼",
    "요즘 물가가 많이 올랐더라",
    "허리가 좀 시큰거려서 걱정이야",
    "동네에 꽃이 예쁘게 피었어",
    "경로당에서 친구들 만나고 왔어",
    "어제 교회 다녀왔어",
    "라디오 들으면서 쉬는 중이야",
    "마당 청소 좀 했어",
    "요즘 통 잠이 안와서 힘드네",
  ];
  return topics[(turnIdx + cycleNum * 3) % topics.length];
}

// 의도적 이상 답변 (10번째 턴에 삽입)
const ANOMALIES = [
  "오늘이 1985년 봄인가 그렇지?",
  "나 지금 제주도 서귀포에 와있어",
  "어제 박정희 대통령 만나고 왔지",
  "새벽에 마당에서 공룡 봤어",
  "지금 한겨울이라 눈이 펑펑 오네",
];

async function getCookie(): Promise<string> {
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  const { csrfToken } = await csrfRes.json() as { csrfToken: string };
  const cookies = csrfRes.headers.get("set-cookie") || "";
  const loginRes = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies },
    body: `csrfToken=${csrfToken}&email=${EMAIL}&password=${PASS}`,
    redirect: "manual",
  });
  const allCookies = loginRes.headers.getSetCookie?.() || [];
  return [...cookies.split(","), ...allCookies].join("; ");
}

async function sendMsg(cookie: string, history: { role: string; content: string; createdAt: string }[], msg: string) {
  const now = new Date().toISOString();
  const full = [...history, { role: "user", content: msg, createdAt: now }];
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      conversationId: CONV_ID,
      messages: full,
      context: { currentTime: now, latitude: 37.2049, longitude: 127.0771 },
    }),
  });
  const data = await res.json() as { text?: string };
  return { status: res.status, reply: data.text || "" };
}

async function main() {
  console.log(`\n========= 사이클 ${cycle} — 10턴 테스트 =========\n`);
  const cookie = await getCookie();

  const history: { role: string; content: string; createdAt: string }[] = [];
  const aiReplies: string[] = [];
  const userMsgs: { msg: string; isAnomaly: boolean; aiReply: string }[] = [];

  // 첫 메시지는 AI에게 먼저 질문
  let userMsg = cycle === 1
    ? "안녕 민지야 오늘 어떻게 지냈어?"
    : `민지야 나왔어 오늘도 같이 이야기 하자`;
  let isAnomalyMsg = false;

  for (let i = 0; i < 10; i++) {
    // 10번째 턴은 의도적 이상 답변
    if (i === 9) {
      userMsg = ANOMALIES[(cycle - 1) % ANOMALIES.length];
      isAnomalyMsg = true;
    }

    const result = await sendMsg(cookie, history.slice(-12), userMsg);
    if (result.status === 200) {
      history.push({ role: "user", content: userMsg, createdAt: new Date().toISOString() });
      history.push({ role: "assistant", content: result.reply, createdAt: new Date(Date.now() + 1000).toISOString() });
      aiReplies.push(result.reply);
      userMsgs.push({ msg: userMsg, isAnomaly: isAnomalyMsg, aiReply: result.reply });
      const mark = isAnomalyMsg ? "🔴" : "  ";
      console.log(`[${i + 1}/10] ${mark}`);
      console.log(`  user: "${userMsg}"`);
      console.log(`  ai:   "${result.reply.slice(0, 130)}"`);

      // 다음 사용자 메시지 결정 (AI 응답 기반)
      if (i < 8) {
        userMsg = generateUserReply(result.reply, i + 1, cycle);
        isAnomalyMsg = false;
      }
    } else {
      console.log(`[${i + 1}/10] ❌ status=${result.status}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  // === 앵무새 분석 ===
  let parrotCount = 0;
  const parrotExamples: string[] = [];
  for (let i = 0; i < userMsgs.length; i++) {
    const u = userMsgs[i].msg;
    const a = userMsgs[i].aiReply;
    const tokens = u.split(/[\s,.!?~]+/).filter((w) => w.length >= 2 && !["할아버지","민지","오늘","그래"].includes(w));
    const hits = tokens.filter((t) => a.includes(t)).length;
    const parrotPhrase = /다니\s+정말|하셨다니|까지\s+드|까지\s+넣|까지\s+주무|라고\s+말씀|말씀해주셔서\s+고마워/.test(a);
    if (hits >= 3 && parrotPhrase) {
      parrotCount++;
      if (parrotExamples.length < 3) parrotExamples.push(`T${i + 1}: "${u.slice(0, 35)}" → "${a.slice(0, 70)}"`);
    }
  }

  // === 반복 질문 ===
  const dayCount = aiReplies.filter(r => /무슨 요일|요일이에요|요일인지/.test(r)).length;
  const animalCount = aiReplies.filter(r => /가.*시작하는 동물/.test(r)).length;
  const walletCount = aiReplies.filter(r => /지갑.*주우/.test(r)).length;
  const weatherClothCount = aiReplies.filter(r => /뭘 입으실|무슨 옷/.test(r)).length;

  // === 이상 감지 ===
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const client = await pool.connect();
  let anomalyDetected = 0;
  let fpCount = 0;
  try {
    const anoms = userMsgs.filter(m => m.isAnomaly);
    for (const am of anoms) {
      const r = await client.query(
        `SELECT "isAnomaly" FROM "Message" WHERE content = $1 AND "isAnomaly" = true ORDER BY "createdAt" DESC LIMIT 1`,
        [am.msg]
      );
      if (r.rows.length > 0) anomalyDetected++;
    }
    const norms = userMsgs.filter(m => !m.isAnomaly);
    for (const nm of norms) {
      const r = await client.query(
        `SELECT "isAnomaly" FROM "Message" WHERE content = $1 AND "isAnomaly" = true ORDER BY "createdAt" DESC LIMIT 1`,
        [nm.msg]
      );
      if (r.rows.length > 0) fpCount++;
    }
  } finally { client.release(); await pool.end(); }

  console.log(`\n===== 사이클 ${cycle} 결과 =====`);
  console.log(`앵무새 반응: ${parrotCount}/10 (${parrotCount * 10}%)`);
  parrotExamples.forEach(e => console.log(`  ${e}`));
  console.log(`"무슨 요일" 질문 반복: ${dayCount}회`);
  console.log(`"동물 게임" 질문 반복: ${animalCount}회`);
  console.log(`"지갑 주우면" 질문 반복: ${walletCount}회`);
  console.log(`"뭘 입으실" 질문 반복: ${weatherClothCount}회`);
  console.log(`의도적 이상 감지: ${anomalyDetected}/${userMsgs.filter(m => m.isAnomaly).length}`);
  console.log(`정상 대화 오탐: ${fpCount}/${userMsgs.filter(m => !m.isAnomaly).length}`);
}

main().catch(console.error);
