/**
 * 100건 자연스러운 대화 테스트 + 같은 질문 반복 검증
 * 사용법: npx tsx scripts/bulk-chat-100.ts
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

// 자연스러운 일상 대화 100건 — 다양한 주제
const MESSAGES: string[] = [
  "안녕 민지야", "오늘 아침은 뭐 먹을까", "날씨가 흐리네", "뉴스에서 물가 오른다던데", "손자 학교 잘 다녀왔대",
  "커피 한잔 마셨어", "등이 좀 결려", "TV에서 야구 중계 하더라", "친구한테 전화왔어", "산책 다녀왔어",
  "아침에 찬바람이 차네", "며느리가 김치 담가줬어", "약국 다녀왔어", "은행 업무 좀 봤어", "복지관 갔다왔어",
  "경로당에서 점심 먹었어", "병원 예약 잡았어", "청소기 돌렸어", "세탁 했어", "설거지 했어",
  "라디오 듣는 중이야", "어제 드라마 봤어", "아들이 전화왔어", "딸이 맛있는거 보내줬어", "손녀가 편지 보내왔어",
  "꽃에 물 줬어", "화분 정리했어", "이불 빨래 했어", "장 볼 게 많네", "오늘 저녁은 국수 먹을까",
  "손주한테 용돈 줬어", "친척 생일이라 선물 샀어", "책 한권 읽었어", "성경책 펼쳤어", "기도 드렸어",
  "약을 깜빡할뻔 했네", "허리 스트레칭 했어", "눈이 침침해", "안경 새로 맞춰야겠어", "귀가 좀 먹은것같아",
  "이빨이 시려", "무릎이 쑤셔", "어제 잠을 잘 못 잤어", "오늘은 컨디션이 좋네", "가볍게 체조 했어",
  "뒷산에 꽃이 피었어", "공원에 벚꽃 구경갔어", "강변 산책했어", "마트 세일한다던데", "우유 배달 왔어",
  "신문 읽었어", "요즘 날씨가 변덕스러워", "봄비가 내리네", "미세먼지가 심해", "창문 열어 환기했어",
  "집이 조용하네", "고양이가 낮잠 자네", "강아지 산책시켰어", "텃밭에 상추 심었어", "고추 모종 샀어",
  "김치냉장고 정리했어", "냉장고 청소했어", "음식물 쓰레기 버렸어", "재활용 분리수거 했어", "우체국 갔다왔어",
  "택배 왔어", "편지 한통 썼어", "족보 정리하다 옛날 사진 봤어", "젊었을 때 추억이 생각나", "고향 친구가 그리워",
  "동네 목욕탕 갔다왔어", "이발소 다녀왔어", "미용실 예약했어", "교회 다녀왔어", "절에 가고 싶네",
  "제사 준비해야해", "시장 좀 봤어", "두부 한모 사왔어", "계란 사왔어", "과일 사왔어",
  "오늘 점심은 미역국 먹었어", "저녁은 된장찌개 끓이려고", "반찬이 떨어졌어", "김 좀 사와야해", "쌀이 떨어져가",
  "냉장고에 반찬 정리했어", "밥통에 밥 새로 했어", "압력솥 사용법이 헷갈려", "가스레인지 청소했어", "전자렌지 돌렸어",
  "TV 리모콘이 고장났어", "휴대폰 충전 했어", "안경 닦았어", "양말 정리했어", "옷장 정리했어",
  "이불 햇볕에 말렸어", "마당 쓸었어", "화단 가꿨어", "오늘 하루도 무사히 보냈네", "이제 좀 쉬려고",
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

const aiReplies: string[] = [];
const userMsgs: string[] = [];

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
  console.log("=== 100건 자연스러운 대화 테스트 ===\n");
  const cookie = await getCookie();
  console.log("로그인 완료\n");

  const history: { role: string; content: string; createdAt: string }[] = [];

  for (let i = 0; i < MESSAGES.length; i++) {
    const msg = MESSAGES[i];
    try {
      const result = await sendMsg(cookie, history.slice(-20), msg);
      if (result.status === 200) {
        history.push({ role: "user", content: msg, createdAt: new Date().toISOString() });
        history.push({ role: "assistant", content: result.reply, createdAt: new Date(Date.now() + 1000).toISOString() });
        userMsgs.push(msg);
        aiReplies.push(result.reply);
        console.log(`[${i + 1}/100] "${msg}" → "${result.reply.slice(0, 60)}..."`);
      } else {
        console.log(`[${i + 1}/100] ❌ status=${result.status}`);
      }
    } catch (e) {
      console.log(`[${i + 1}/100] ❌ ${(e as Error).message.slice(0, 50)}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  // === 반복 질문 분석 ===
  console.log("\n\n=== 반복 질문 분석 ===");
  const dayCount = aiReplies.filter(r => /무슨 요일|오늘 요일|요일\s*이에요/.test(r)).length;
  const trashCount = aiReplies.filter(r => /쓰레기 버리는/.test(r)).length;
  const monthCount = aiReplies.filter(r => /이번 달.*몇 월|몇 월이었죠/.test(r)).length;
  const dateCount = aiReplies.filter(r => /며칠.*맞.*나요|오늘 며칠/.test(r)).length;
  const animalCount = aiReplies.filter(r => /가.*로 시작하는 동물/.test(r)).length;
  const walletCount = aiReplies.filter(r => /지갑.*주우시면|지갑.*발견/.test(r)).length;
  const weatherClothCount = aiReplies.filter(r => /뭘 입으실|무슨 옷/.test(r)).length;
  const calcCount = aiReplies.filter(r => /100에서 7|거스름돈.*얼마|5000원.*만원/.test(r)).length;
  const introCount = aiReplies.filter(r => /저는.*민지|AI 손녀|AI 딸|이렇게 만나 뵙게/.test(r)).length;

  console.log(`"무슨 요일" 반복: ${dayCount}회`);
  console.log(`"쓰레기 버리는" 반복: ${trashCount}회`);
  console.log(`"몇 월" 반복: ${monthCount}회`);
  console.log(`"며칠" 반복: ${dateCount}회`);
  console.log(`"가로 시작하는 동물" 반복: ${animalCount}회`);
  console.log(`"지갑 주우시면" 반복: ${walletCount}회`);
  console.log(`"무슨 옷" 반복: ${weatherClothCount}회`);
  console.log(`"거스름돈 계산" 반복: ${calcCount}회`);
  console.log(`자기소개 반복: ${introCount}회`);

  // 연속 중복 질문 탐지
  console.log("\n=== 연속 유사 질문 (경고 이상) ===");
  let warnCount = 0;
  for (let i = 1; i < aiReplies.length; i++) {
    // AI 응답에 질문이 포함되어 있으면 추출
    const prev = aiReplies[i - 1];
    const curr = aiReplies[i];
    // 질문 문장 추출 (물음표 기준)
    const prevQ = (prev.match(/[^?.!]+\?/g) || []).join(" ");
    const currQ = (curr.match(/[^?.!]+\?/g) || []).join(" ");
    if (!prevQ || !currQ) continue;
    // 공통 키워드 3개 이상 매칭되면 경고
    const prevWords = new Set(prevQ.split(/\s+/).filter(w => w.length >= 2));
    const currWords = currQ.split(/\s+/).filter(w => w.length >= 2);
    const overlap = currWords.filter(w => prevWords.has(w)).length;
    if (overlap >= 3) {
      warnCount++;
      if (warnCount <= 5) {
        console.log(`\n[턴 ${i}] 사용자: "${userMsgs[i]}"`);
        console.log(`  이전 AI 질문: ${prevQ.slice(0, 80)}`);
        console.log(`  현재 AI 질문: ${currQ.slice(0, 80)}`);
      }
    }
  }
  console.log(`\n총 연속 유사 질문: ${warnCount}회`);

  // DB에서 cognitive_assessments 확인
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT domain, COUNT(*)::int as c FROM cognitive_assessments WHERE user_id = 'cmni80fn0000604lkm80q2u1o' AND session_date = CURRENT_DATE GROUP BY domain ORDER BY c DESC`
    );
    console.log("\n=== 오늘 cognitive_assessments (영역 확인) ===");
    r.rows.forEach((row: { domain: string; c: number }) => console.log(`  ${row.domain}: ${row.c}회`));
  } finally { client.release(); await pool.end(); }
}

main().catch(console.error);
