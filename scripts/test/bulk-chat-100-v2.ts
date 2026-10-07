/**
 * 100건 자연스러운 대화 테스트 v2 — AI 질문에 맞춰 대답하면서 주제 전환도 섞음
 * 사용법: npx tsx scripts/bulk-chat-100-v2.ts
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

// AI가 물을 가능성이 있는 질문 패턴 → 자연스러운 응답 매핑
const RESPONSE_RULES: { pattern: RegExp; responses: string[] }[] = [
  { pattern: /무슨 요일|오늘.*요일/, responses: ["화요일이야", "수요일이지", "목요일이야 오늘은"] },
  { pattern: /몇 월|이번 달/, responses: ["4월이지", "4월이야 봄이잖아"] },
  { pattern: /며칠|몇 일/, responses: ["20일이야", "오늘 20일인가 그럴걸"] },
  { pattern: /계절/, responses: ["봄이지", "봄이야 꽃 피잖아"] },
  { pattern: /점심.*드셨|점심.*뭐|점심.*메뉴/, responses: ["김치찌개 먹었어", "된장국에 밥 먹었지", "국수 한그릇 먹었어"] },
  { pattern: /아침.*드셨|아침.*뭐/, responses: ["미역국 먹었지", "밥 한공기 먹었어", "토스트 먹었어"] },
  { pattern: /저녁.*뭐|저녁.*드실/, responses: ["된장찌개 끓일까 해", "반찬에 밥 먹지 뭐"] },
  { pattern: /어디.*계세|어디.*가셨|집에 계/, responses: ["집에 있어", "거실에 앉아있어", "방에 있지"] },
  { pattern: /동네.*이름|어디 사/, responses: ["화성 동탄에 살아", "동탄에 있어"] },
  { pattern: /가.*로 시작.*동물|동물.*가/, responses: ["가물치", "가재", "가오리도 있지"] },
  { pattern: /ㅂ.*시작.*물건|ㅂ.*시작/, responses: ["보자기", "바나나", "보리"] },
  { pattern: /기차.*버스.*공통점|공통점/, responses: ["둘 다 타는거지 교통수단이야", "사람 태우는거지"] },
  { pattern: /거스름돈|만 원.*5천|만원.*빼/, responses: ["5천원이지", "2천원이야"] },
  { pattern: /100에서 7|100.*7/, responses: ["93이지", "93이야"] },
  { pattern: /지갑.*주우|지갑.*발견/, responses: ["경찰서에 맡겨야지", "안내데스크에 맡기지"] },
  { pattern: /물이 안 나오|수도/, responses: ["관리실에 전화해야지", "옆집에 물어봐야지"] },
  { pattern: /쌀쌀.*뭘 입|옷.*뭘/, responses: ["겉옷 챙겨 입지", "따뜻한 옷 입을거야"] },
  { pattern: /좋아하시는 과일|어떤 과일/, responses: ["수박 좋아해", "사과랑 배 좋아하지"] },
  { pattern: /좋아하시는 음식|무슨 음식/, responses: ["김치찌개 좋아해", "된장찌개지"] },
  { pattern: /고향|어릴 때 살던/, responses: ["김해야", "부산 근처였지"] },
  { pattern: /손자|손녀|자식|가족/, responses: ["잘 지내고 있어", "건강하게 잘 지내"] },
];

// 주제 전환용 (AI가 물은 내용과 무관한 새 주제 — 약 30%만 사용)
const TOPIC_SHIFT = [
  "오늘 날씨 참 좋네",
  "뉴스에서 물가 오른다더라",
  "TV 드라마 재밌는거 봤어",
  "어제 밤에 잠을 잘 못잤어",
  "허리가 좀 결려",
  "옛날 사진 보니까 추억이 생각나",
  "경로당 가서 친구들 만났어",
  "화분에 물 줬어",
  "산책 좀 다녀왔어",
  "안경 새로 맞춰야겠어",
  "병원 예약했어 다음주에",
  "마트 가서 장 볼게 많아",
  "이번 주말에 아들 온다고 했어",
  "요즘 허리가 안좋아",
  "라디오 들으며 쉬는 중이야",
  "오랜만에 친구한테 전화했어",
  "책 한권 읽는 중이야",
  "오늘 기분이 좋네",
  "옷장 정리 좀 했어",
  "음식 좀 해먹어야겠어",
];

function pickResponse(aiText: string, turnIdx: number): string {
  // 30%는 주제 전환
  if (Math.random() < 0.3) {
    return TOPIC_SHIFT[turnIdx % TOPIC_SHIFT.length];
  }
  // 70%는 AI 질문에 맞춰 대답
  for (const rule of RESPONSE_RULES) {
    if (rule.pattern.test(aiText)) {
      return rule.responses[Math.floor(Math.random() * rule.responses.length)];
    }
  }
  // 매칭되는 규칙이 없으면 자연스러운 대답
  const generic = [
    "그래 맞아", "응 그렇지", "알겠어", "좋은 생각이야",
    "그랬구나", "맞아 맞아", "응 그래",
    "민지도 잘 지내?", "그러게 말이야",
    TOPIC_SHIFT[turnIdx % TOPIC_SHIFT.length],
  ];
  return generic[Math.floor(Math.random() * generic.length)];
}

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
  console.log("=== 100건 자연스러운 대화 테스트 v2 (70% 응답 + 30% 주제전환) ===\n");
  const cookie = await getCookie();
  console.log("로그인 완료\n");

  const history: { role: string; content: string; createdAt: string }[] = [];
  const aiReplies: string[] = [];
  const userMsgs: string[] = [];

  // 첫 메시지는 시작 인사
  let userMsg = "안녕 민지야";

  for (let i = 0; i < 100; i++) {
    try {
      const result = await sendMsg(cookie, history.slice(-20), userMsg);
      if (result.status === 200) {
        history.push({ role: "user", content: userMsg, createdAt: new Date().toISOString() });
        history.push({ role: "assistant", content: result.reply, createdAt: new Date(Date.now() + 1000).toISOString() });
        userMsgs.push(userMsg);
        aiReplies.push(result.reply);
        console.log(`[${i + 1}/100]`);
        console.log(`  user: "${userMsg}"`);
        console.log(`  ai:   "${result.reply.slice(0, 100)}..."`);

        // 다음 사용자 메시지 결정
        userMsg = pickResponse(result.reply, i + 1);
      } else {
        console.log(`[${i + 1}/100] ❌ status=${result.status}`);
        userMsg = TOPIC_SHIFT[i % TOPIC_SHIFT.length];
      }
    } catch (e) {
      console.log(`[${i + 1}/100] ❌ ${(e as Error).message.slice(0, 50)}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  // === 반복 질문 분석 ===
  console.log("\n\n=== 반복 질문 분석 ===");
  const dayCount = aiReplies.filter(r => /무슨 요일|오늘.*요일|요일\s*이에요/.test(r)).length;
  const trashCount = aiReplies.filter(r => /쓰레기 버리는/.test(r)).length;
  const monthCount = aiReplies.filter(r => /이번 달.*몇 월|몇 월이었죠|몇 월이에요/.test(r)).length;
  const dateCount = aiReplies.filter(r => /며칠.*맞.*나요|오늘 며칠/.test(r)).length;
  const animalCount = aiReplies.filter(r => /가.*로 시작하는 동물/.test(r)).length;
  const walletCount = aiReplies.filter(r => /지갑.*주우시|지갑.*발견/.test(r)).length;
  const weatherClothCount = aiReplies.filter(r => /뭘 입으실|무슨 옷/.test(r)).length;
  const waterCount = aiReplies.filter(r => /물이 안 나오|물.*안 나/.test(r)).length;
  const calcCount = aiReplies.filter(r => /100에서 7|거스름돈.*얼마|5000원.*만원|8천 원.*만/.test(r)).length;
  const introCount = aiReplies.filter(r => /저는.*민지예요|AI 손녀|AI 딸|이렇게 만나 뵙게/.test(r)).length;

  console.log(`"무슨 요일" 반복: ${dayCount}회`);
  console.log(`"쓰레기 버리는" 반복: ${trashCount}회`);
  console.log(`"몇 월" 반복: ${monthCount}회`);
  console.log(`"며칠" 반복: ${dateCount}회`);
  console.log(`"가로 시작하는 동물" 반복: ${animalCount}회`);
  console.log(`"지갑 주우시면" 반복: ${walletCount}회`);
  console.log(`"무슨 옷 뭘 입으실" 반복: ${weatherClothCount}회`);
  console.log(`"물 안 나오면" 반복: ${waterCount}회`);
  console.log(`"거스름돈 계산" 반복: ${calcCount}회`);
  console.log(`자기소개 반복: ${introCount}회`);

  // 연속 유사 질문 탐지
  console.log("\n=== 연속 유사 질문 (경고 이상) ===");
  let warnCount = 0;
  const warnings: string[] = [];
  for (let i = 1; i < aiReplies.length; i++) {
    const prev = aiReplies[i - 1];
    const curr = aiReplies[i];
    const prevQ = (prev.match(/[^?.!]+\?/g) || []).join(" ");
    const currQ = (curr.match(/[^?.!]+\?/g) || []).join(" ");
    if (!prevQ || !currQ) continue;
    const prevWords = new Set(prevQ.split(/\s+/).filter(w => w.length >= 2));
    const currWords = currQ.split(/\s+/).filter(w => w.length >= 2);
    const overlap = currWords.filter(w => prevWords.has(w)).length;
    if (overlap >= 3) {
      warnCount++;
      if (warnCount <= 5) {
        warnings.push(`[턴 ${i}] 이전: ${prevQ.slice(0, 60)} / 현재: ${currQ.slice(0, 60)}`);
      }
    }
  }
  warnings.forEach(w => console.log(w));
  console.log(`\n총 연속 유사 질문: ${warnCount}회`);

  // DB cognitive_assessments 확인
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT domain, COUNT(*)::int as c,
              COUNT(*) FILTER (WHERE score = 0)::int as normal,
              COUNT(*) FILTER (WHERE score >= 1 AND score < 2)::int as border,
              COUNT(*) FILTER (WHERE score = 2)::int as warning
       FROM cognitive_assessments WHERE user_id = 'cmni80fn0000604lkm80q2u1o' AND session_date = CURRENT_DATE
       GROUP BY domain ORDER BY c DESC`
    );
    console.log("\n=== 오늘 cognitive_assessments (영역/점수) ===");
    r.rows.forEach((row: { domain: string; c: number; normal: number; border: number; warning: number }) =>
      console.log(`  ${row.domain}: 총 ${row.c}회 (정상:${row.normal} 경계:${row.border} 주의:${row.warning})`)
    );
  } finally { client.release(); await pool.end(); }
}

main().catch(console.error);
