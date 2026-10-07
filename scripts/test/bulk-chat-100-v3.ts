/**
 * 100건 자연스러운 대화 테스트 v3
 * - 실사용자처럼 구체적으로 답변 (70%) + 자연스러운 주제 전환 (30%)
 * - 중간중간 의도적 잘못된 답변(시간/장소/판단력 이상) 10건 섞음
 * 사용법: npx tsx scripts/bulk-chat-100-v3.ts
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

// AI 질문 패턴 → 사용자 답변 후보 (구체적이고 자연스럽게)
const Q_RESPONSE: { pattern: RegExp; responses: string[] }[] = [
  { pattern: /무슨 요일|오늘.*요일/, responses: ["오늘 화요일 아니야?", "음 수요일인가... 맞지?", "목요일 같은데 헷갈리네"] },
  { pattern: /몇 월|이번 달/, responses: ["4월이지 봄이잖아", "4월 맞아 꽃 피는 계절이네"] },
  { pattern: /며칠|오늘 날짜/, responses: ["20일 정도 된 것 같은데", "음 20일쯤인가"] },
  { pattern: /계절/, responses: ["봄이지 요즘 꽃이 많이 피잖아", "봄이야 따뜻해서 좋아"] },
  { pattern: /점심.*드셨|점심.*뭐|점심.*메뉴|점심.*어떻/, responses: ["김치찌개랑 계란말이 먹었어 맛있더라", "국수 한그릇 했어 얼큰하게", "반찬에 밥 비벼서 먹었지"] },
  { pattern: /아침.*드셨|아침.*뭐|아침 식사/, responses: ["미역국에 밥 말아 먹었어", "토스트 한쪽에 우유 마셨지", "죽 한그릇 먹었는데 속이 편하더라"] },
  { pattern: /저녁.*뭐|저녁.*드실|저녁 메뉴/, responses: ["된장찌개 끓일까 생각중이야", "간단하게 라면 먹을까 고민이야", "반찬이 많아서 따로 안 해도 되겠더라"] },
  { pattern: /어디.*계세|어디.*가셨|집에 계|밖에 나/, responses: ["지금 집에 있어 거실 소파에 앉아있지", "방에서 쉬고 있어", "마당에 잠깐 나와있어"] },
  { pattern: /동네.*이름|어디 사|사시는 곳/, responses: ["화성 동탄에 살고있지 벌써 몇 년 됐어", "동탄 새 아파트에 있어"] },
  { pattern: /가.*로 시작.*동물|가.*동물/, responses: ["가물치가 있지 그 큰 물고기", "가재도 가로 시작하고", "음 갈매기도 가네"] },
  { pattern: /ㅂ.*시작.*물건|ㅂ.*시작/, responses: ["보자기가 있지 옛날에 많이 썼어", "바구니도 ㅂ 맞지", "빗자루 같은거"] },
  { pattern: /기차.*버스.*공통점|공통점/, responses: ["둘 다 사람 태우는 교통수단이야", "많은 사람이 타는거지 편리해"] },
  { pattern: /거스름돈|만 원.*5천|거스름|잔돈/, responses: ["5천원 돌려주면 되지", "2천원 받아야지"] },
  { pattern: /100에서 7|100.*7.*빼/, responses: ["93이야 그정도는 알지", "93이지 뭐 어렵다고"] },
  { pattern: /지갑.*주우|지갑.*발견/, responses: ["당연히 경찰서에 가져다 줘야지", "안내데스크나 관리실에 맡겨야 맞지"] },
  { pattern: /물이 안 나오|수도가|단수/, responses: ["아파트 관리실에 전화해야지", "이웃집에 물어봐서 확인하지"] },
  { pattern: /쌀쌀.*뭘 입|쌀쌀.*옷|겉옷/, responses: ["따뜻한 가디건 챙겨입지", "목도리도 두르고 나가야지"] },
  { pattern: /좋아하시는 과일|어떤 과일|과일 중에/, responses: ["수박 참 좋아해 시원하잖아", "사과랑 배를 자주 먹어"] },
  { pattern: /좋아하시는 음식|무슨 음식|좋아하는 메뉴/, responses: ["김치찌개가 제일이지", "된장찌개랑 나물 반찬 좋아해"] },
  { pattern: /고향|어릴 때|어렸을 때|어릴적/, responses: ["김해가 내 고향이야 어릴때 기억이 많지", "시골에서 자랐어 친구들이랑 뛰어놀았지"] },
  { pattern: /손자|손녀|자식|가족.*어떻|가족.*잘/, responses: ["다들 잘 지내 바쁘게 살고있지", "손주들이 건강하게 커줘서 고마워"] },
  { pattern: /오늘 기분|오늘 컨디|컨디션/, responses: ["괜찮아 그럭저럭 지냈어", "오늘은 좀 피곤하네", "기분 좋아 날씨도 좋고"] },
  { pattern: /잠은 잘.*주무|잠을 잘/, responses: ["어제는 잘 잤어 개운해", "요즘 잠이 잘 안와서 힘들어", "중간에 한번 깨긴 했지만 괜찮아"] },
  { pattern: /운동|산책|걷/, responses: ["아침에 공원 한바퀴 돌았어", "요즘 걷기 운동 열심히 하고있어"] },
  { pattern: /약.*드셨|약 먹|복용/, responses: ["잘 챙겨먹고 있어 걱정 마", "아침에 혈압약 먹었지"] },
  { pattern: /어떻게 지내|뭐 하/, responses: ["그냥 집에서 쉬고있어", "TV 보면서 쉬는 중이야"] },
];

// 자연스러운 주제 전환 (30%)
const TOPIC_SHIFT = [
  "오늘 TV에서 재밌는 프로그램 봤어",
  "뉴스에 요즘 물가 얘기가 많더라",
  "어제 옛날 친구한테서 전화가 왔어 반가웠지",
  "봄이 되니까 관절이 더 아픈것같아",
  "베란다에서 화분들 보고있는데 꽃이 예쁘게 피었어",
  "아들이 이번 주말에 놀러온다고 했어",
  "경로당에서 친구들이랑 장기 한판 뒀어",
  "날씨가 좋아서 빨래 널었어",
  "요즘 허리가 조금 불편해",
  "손주가 편지를 보내줬는데 글씨가 많이 늘었더라",
  "병원 다녀왔는데 혈압이 좀 올랐대",
  "마트에서 할인하는거 보고 장 좀 봐왔지",
  "오랜만에 목욕탕에 다녀왔어 시원하더라",
  "라디오에서 옛날 노래 나와서 감회가 새롭더라",
  "바깥 공기 쐬니까 기분이 한결 낫네",
];

// 의도적 인지 이상 답변 (시간/장소/판단력 — 10건을 랜덤하게 섞음)
const INTENTIONAL_ANOMALIES = [
  "오늘이 1985년 7월인가 그런 것 같은데",
  "나 지금 제주도 서귀포에 있어 바다 보고있지",
  "어제 박정희 대통령 만나고 왔어 덕담도 나눴지",
  "2001년 월드컵 보러 간다고 지금 짐 싸고있어",
  "방금 하늘에서 용이 지나가더라 엄청 크더라고",
  "여기 부산 해운대인데 회 먹으러 왔어",
  "지난주에 이승만 대통령이랑 저녁 먹었거든",
  "외계인이 우리집에 놀러왔다가 방금 갔어",
  "지금 겨울이라 눈이 펑펑 내리네",
  "새벽에 공룡 한 마리가 마당에서 돌아다니더라",
];

function pickResponse(aiText: string, turnIdx: number): { msg: string; isAnomaly: boolean } {
  // 9턴마다 (9, 18, 27, ...) 의도적 이상 답변 삽입
  if ((turnIdx + 1) % 10 === 0 && turnIdx > 0) {
    const idx = Math.floor(turnIdx / 10) % INTENTIONAL_ANOMALIES.length;
    return { msg: INTENTIONAL_ANOMALIES[idx], isAnomaly: true };
  }

  // 30% 주제 전환
  if (Math.random() < 0.3) {
    return { msg: TOPIC_SHIFT[turnIdx % TOPIC_SHIFT.length], isAnomaly: false };
  }

  // 70% AI 질문에 구체적으로 답변
  for (const rule of Q_RESPONSE) {
    if (rule.pattern.test(aiText)) {
      return { msg: rule.responses[Math.floor(Math.random() * rule.responses.length)], isAnomaly: false };
    }
  }

  // 매칭 안 되면 주제 전환으로 fallback (단답 대신)
  return { msg: TOPIC_SHIFT[turnIdx % TOPIC_SHIFT.length], isAnomaly: false };
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
  console.log("=== 100건 자연스러운 대화 테스트 v3 ===");
  console.log("  - 실사용자처럼 구체적 답변 (70%) + 주제 전환 (30%)");
  console.log("  - 10건마다 의도적 이상 답변 삽입 (시간/장소/판단력)\n");
  const cookie = await getCookie();
  console.log("로그인 완료\n");

  const history: { role: string; content: string; createdAt: string }[] = [];
  const aiReplies: string[] = [];
  const userMsgs: { msg: string; isAnomaly: boolean }[] = [];

  let userMsg = "안녕 민지야 오늘은 뭐 하고 있었어?";
  let isAnomalyMsg = false;

  for (let i = 0; i < 100; i++) {
    try {
      const result = await sendMsg(cookie, history.slice(-20), userMsg);
      if (result.status === 200) {
        history.push({ role: "user", content: userMsg, createdAt: new Date().toISOString() });
        history.push({ role: "assistant", content: result.reply, createdAt: new Date(Date.now() + 1000).toISOString() });
        userMsgs.push({ msg: userMsg, isAnomaly: isAnomalyMsg });
        aiReplies.push(result.reply);
        const marker = isAnomalyMsg ? "🔴" : "  ";
        console.log(`[${i + 1}/100] ${marker}`);
        console.log(`  user: "${userMsg}"`);
        console.log(`  ai:   "${result.reply.slice(0, 110)}..."`);

        const next = pickResponse(result.reply, i + 1);
        userMsg = next.msg;
        isAnomalyMsg = next.isAnomaly;
      } else {
        console.log(`[${i + 1}/100] ❌ status=${result.status}`);
        const next = pickResponse("", i + 1);
        userMsg = next.msg;
        isAnomalyMsg = next.isAnomaly;
      }
    } catch (e) {
      console.log(`[${i + 1}/100] ❌ ${(e as Error).message.slice(0, 50)}`);
    }
    await new Promise((r) => setTimeout(r, 2500));
  }

  // === 앵무새 반응 분석 ===
  console.log("\n\n=== 앵무새 반응 분석 ===");
  let parrotCount = 0;
  const parrotExamples: string[] = [];
  for (let i = 0; i < userMsgs.length; i++) {
    const u = userMsgs[i].msg;
    const a = aiReplies[i] || "";
    // 사용자 발화의 주요 단어(3자 이상)가 AI 응답에 그대로 + "말씀/하셨다니/주셔서" 조합되면 앵무새
    const parrot = /말씀해주셔서 고마워|이라고 말씀|하셨다니 다행|라고 하셨다니|라고 말씀드리니/.test(a);
    if (parrot) {
      parrotCount++;
      if (parrotExamples.length < 5) parrotExamples.push(`user: "${u}" → ai: "${a.slice(0, 80)}"`);
    }
  }
  console.log(`앵무새 반응: ${parrotCount}/100회 (${Math.round(parrotCount)}%)`);
  parrotExamples.forEach(e => console.log(`  ${e}`));

  // === 반복 질문 분석 ===
  console.log("\n=== 반복 질문 분석 ===");
  const dayCount = aiReplies.filter(r => /무슨 요일|오늘.*요일\??|요일\s*이에요\?/.test(r)).length;
  const trashCount = aiReplies.filter(r => /쓰레기 버리는/.test(r)).length;
  const monthCount = aiReplies.filter(r => /이번 달.*몇 월|몇 월이었죠|몇 월이에요/.test(r)).length;
  const dateCount = aiReplies.filter(r => /며칠.*맞.*나요|오늘 며칠/.test(r)).length;
  const animalCount = aiReplies.filter(r => /가.*로 시작하는 동물/.test(r)).length;
  const walletCount = aiReplies.filter(r => /지갑.*주우시|지갑.*발견/.test(r)).length;
  const weatherClothCount = aiReplies.filter(r => /뭘 입으실|무슨 옷/.test(r)).length;
  const waterCount = aiReplies.filter(r => /물이 안 나오|물.*안 나/.test(r)).length;
  const calcCount = aiReplies.filter(r => /100에서 7|거스름돈.*얼마|5000원.*만원|8천 원.*만/.test(r)).length;

  console.log(`"무슨 요일" 반복: ${dayCount}회`);
  console.log(`"쓰레기 버리는" 반복: ${trashCount}회`);
  console.log(`"몇 월" 반복: ${monthCount}회`);
  console.log(`"며칠" 반복: ${dateCount}회`);
  console.log(`"가로 시작하는 동물" 반복: ${animalCount}회`);
  console.log(`"지갑 주우시면" 반복: ${walletCount}회`);
  console.log(`"무슨 옷 뭘 입으실" 반복: ${weatherClothCount}회`);
  console.log(`"물 안 나오면" 반복: ${waterCount}회`);
  console.log(`"거스름돈 계산" 반복: ${calcCount}회`);

  // === 의도적 이상 감지 정확도 ===
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const client = await pool.connect();
  try {
    // 방금 삽입한 의도적 이상 메시지들의 isAnomaly 상태 확인
    const anomalyMsgs = userMsgs.filter(m => m.isAnomaly).map(m => m.msg);
    console.log(`\n=== 의도적 이상 답변 감지 정확도 (총 ${anomalyMsgs.length}건) ===`);
    let detected = 0;
    for (const am of anomalyMsgs) {
      const r = await client.query(
        `SELECT "isAnomaly", "analysisNote" FROM "Message" WHERE content = $1 AND "isAnomaly" = true ORDER BY "createdAt" DESC LIMIT 1`,
        [am]
      );
      const ok = r.rows.length > 0;
      if (ok) detected++;
      console.log(`  ${ok ? "✅" : "❌"} "${am}" ${ok ? "→ " + (r.rows[0].analysisNote || "").slice(0, 60) : "→ 미감지"}`);
    }
    console.log(`\n감지율: ${detected}/${anomalyMsgs.length} (${Math.round(detected/anomalyMsgs.length*100)}%)`);

    // 정상 대화 오탐 확인
    const normalMsgs = userMsgs.filter(m => !m.isAnomaly).map(m => m.msg);
    let fp = 0;
    const fpExamples: string[] = [];
    for (const nm of normalMsgs) {
      const r = await client.query(
        `SELECT "analysisNote" FROM "Message" WHERE content = $1 AND "isAnomaly" = true ORDER BY "createdAt" DESC LIMIT 1`,
        [nm]
      );
      if (r.rows.length > 0) {
        fp++;
        if (fpExamples.length < 5) fpExamples.push(`"${nm}" → ${(r.rows[0].analysisNote || "").slice(0, 80)}`);
      }
    }
    console.log(`\n=== 정상 대화 오탐 ===`);
    console.log(`오탐: ${fp}/${normalMsgs.length} (${Math.round(fp/normalMsgs.length*100)}%)`);
    fpExamples.forEach(e => console.log(`  🔴 ${e}`));

    // 오늘 cognitive_assessments 영역별
    const dom = await client.query(
      `SELECT domain, COUNT(*)::int as c,
              COUNT(*) FILTER (WHERE score = 0)::int as normal,
              COUNT(*) FILTER (WHERE score >= 1 AND score < 2)::int as border,
              COUNT(*) FILTER (WHERE score = 2)::int as warning
       FROM cognitive_assessments WHERE user_id = 'cmni80fn0000604lkm80q2u1o' AND session_date = CURRENT_DATE
       GROUP BY domain ORDER BY c DESC`
    );
    console.log("\n=== 오늘 cognitive_assessments (영역/점수) ===");
    dom.rows.forEach((row: { domain: string; c: number; normal: number; border: number; warning: number }) =>
      console.log(`  ${row.domain}: 총 ${row.c}회 (정상:${row.normal} 경계:${row.border} 주의:${row.warning})`)
    );
  } finally { client.release(); await pool.end(); }
}

main().catch(console.error);
