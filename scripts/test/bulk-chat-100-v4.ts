/**
 * 100건 대화 테스트 v4 — 사전 준비된 자연스러운 사용자 발화 순차 전송
 * 각 발화는 실제 사람이 말할 법한 구체적 내용 + 감정 + 주제 흐름
 * 의도적 이상 답변 10건 포함 (10턴마다)
 * 사용법: npx tsx scripts/bulk-chat-100-v4.ts
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

// 실제 사람이 자연스럽게 이어갈 수 있는 구체적 발화 100개
// (주제가 자연스럽게 이어지면서, 10턴마다 의도적 인지 이상 삽입)
const MESSAGES: { msg: string; isAnomaly: boolean }[] = [
  // 1~5: 일상 인사 + 하루 얘기
  { msg: "안녕 민지야 오늘 하루 어땠어?", isAnomaly: false },
  { msg: "괜찮았어. 아침에 산책 좀 나갔다왔고 점심엔 된장찌개 끓여 먹었지", isAnomaly: false },
  { msg: "응 시원하게 잘 됐어. 무랑 두부 넣어서 끓였거든", isAnomaly: false },
  { msg: "저녁은 간단하게 국에다 밥 말아먹으려고", isAnomaly: false },
  { msg: "미역국 끓여놓은게 있어서 그걸 먹을거야", isAnomaly: false },

  // 6~9: 가족 얘기
  { msg: "그나저나 오늘 아들한테 전화가 왔더라", isAnomaly: false },
  { msg: "이번 주말에 손자랑 같이 온다고 해서 기대돼", isAnomaly: false },
  { msg: "손자가 초등학교 3학년인데 축구를 좋아해", isAnomaly: false },
  { msg: "지난번에 왔을때 같이 공놀이 했거든. 재밌었어", isAnomaly: false },

  // 10: 🔴 의도적 이상 (시간 지남력)
  { msg: "그때가 아마 1985년 여름이었을거야 생각해보니", isAnomaly: true },

  // 11~15: 건강
  { msg: "요즘 무릎이 좀 시큰거려서 걱정이야", isAnomaly: false },
  { msg: "병원은 다음주 수요일에 예약 잡아놨어", isAnomaly: false },
  { msg: "혈압약은 아침마다 꼬박꼬박 먹고있어", isAnomaly: false },
  { msg: "가끔 잠이 잘 안오는 날이 있긴한데 그래도 괜찮은 편이야", isAnomaly: false },
  { msg: "운동이 부족한것 같아서 산책을 더 자주 하려고", isAnomaly: false },

  // 16~19: 취미/여가
  { msg: "요즘 TV에서 옛날 드라마 재방송 해주더라", isAnomaly: false },
  { msg: "어제 본 드라마 내용이 참 재밌었는데 배우가 연기를 잘 하더라", isAnomaly: false },
  { msg: "라디오도 자주 듣는데 트로트 나오면 흥이 나", isAnomaly: false },
  { msg: "옛날 가수들 노래 들으면 추억이 떠올라", isAnomaly: false },

  // 20: 🔴 의도적 이상 (장소 지남력)
  { msg: "나 지금 제주도 서귀포에 와있거든 바다 보러", isAnomaly: true },

  // 21~25: 가족 얘기 연장
  { msg: "딸도 이번 달 안에 한번 오고싶다고 했어", isAnomaly: false },
  { msg: "딸이 맛있는 떡을 보내줬는데 아주 쫄깃해", isAnomaly: false },
  { msg: "며느리도 친절해서 고마워하고 있지", isAnomaly: false },
  { msg: "명절때마다 음식 준비하느라 애쓰거든", isAnomaly: false },
  { msg: "이번 명절엔 내가 조금 돕고 싶더라", isAnomaly: false },

  // 26~29: 동네 사람
  { msg: "옆집 할머니가 오늘 떡을 갖다주셨어", isAnomaly: false },
  { msg: "경로당에서 같이 고스톱 치던 김씨 할아버지가 요즘 안 보여", isAnomaly: false },
  { msg: "편찮으신건 아닌지 걱정이네", isAnomaly: false },
  { msg: "내일은 한번 찾아가봐야겠다", isAnomaly: false },

  // 30: 🔴 의도적 이상 (판단력 - 사망 인물)
  { msg: "어제 박정희 대통령을 만나서 같이 차 한잔 했거든", isAnomaly: true },

  // 31~35: 음식/생활
  { msg: "김치 담근지 좀 됐는데 아직 맛있어", isAnomaly: false },
  { msg: "며느리가 담가준건데 시원하게 잘 익었지", isAnomaly: false },
  { msg: "나는 싱겁게 먹는 편이야. 나이 드니까 짠거 먹기 힘들어", isAnomaly: false },
  { msg: "과일은 수박이랑 사과 좋아해", isAnomaly: false },
  { msg: "요즘 딸기가 제철이라 많이 먹고있어", isAnomaly: false },

  // 36~39: 날씨/계절
  { msg: "봄이 되니까 꽃들이 예쁘게 피었더라", isAnomaly: false },
  { msg: "공원에 벚꽃 구경 가려고 생각중이야", isAnomaly: false },
  { msg: "햇살이 따뜻해서 기분이 좋아", isAnomaly: false },
  { msg: "근데 낮엔 덥고 밤엔 쌀쌀해서 감기 조심해야겠어", isAnomaly: false },

  // 40: 🔴 의도적 이상 (판단력 - 비현실)
  { msg: "오늘 새벽에 마당에서 공룡을 한 마리 봤는데 크더라", isAnomaly: true },

  // 41~45: 자녀/손주
  { msg: "손녀가 중학생이 되었다니 세월이 참 빠르네", isAnomaly: false },
  { msg: "공부를 열심히 한다는데 대견해", isAnomaly: false },
  { msg: "그 아이한테 용돈을 얼마나 주면 좋을까?", isAnomaly: false },
  { msg: "요즘 물가가 비싸서 5만원은 줘야 할것 같아", isAnomaly: false },
  { msg: "손자는 아직 어리니까 만원 정도면 될거고", isAnomaly: false },

  // 46~49: 일상 활동
  { msg: "어제는 은행 일 좀 보고왔어", isAnomaly: false },
  { msg: "요즘은 은행도 가면 번호표 뽑고 기다려야 하더라", isAnomaly: false },
  { msg: "통장 정리 좀 하고 공과금도 냈지", isAnomaly: false },
  { msg: "요즘 공과금이 많이 올랐어", isAnomaly: false },

  // 50: 🔴 의도적 이상 (시간 지남력 - 계절)
  { msg: "지금 한겨울인데 눈이 펑펑 오네", isAnomaly: true },

  // 51~55: 건강 관리
  { msg: "허리가 아파서 병원에서 물리치료 받고있어", isAnomaly: false },
  { msg: "나이 드니까 이런저런 데가 아프네", isAnomaly: false },
  { msg: "그래도 이만하면 건강한 편이지", isAnomaly: false },
  { msg: "하루에 한번은 꼭 걷기운동 하려고 노력해", isAnomaly: false },
  { msg: "동네 한바퀴 도는데 30분정도 걸려", isAnomaly: false },

  // 56~59: 옛날 얘기
  { msg: "내가 젊었을 때는 시골에서 농사 지었어", isAnomaly: false },
  { msg: "새벽부터 일어나서 논에 나가고 했지", isAnomaly: false },
  { msg: "그때는 힘들었지만 보람있었어", isAnomaly: false },
  { msg: "지금 생각하면 다 추억이야", isAnomaly: false },

  // 60: 🔴 의도적 이상 (장소 지남력)
  { msg: "지금 부산 해운대 와서 바닷바람 쐬고있어", isAnomaly: true },

  // 61~65: 가전제품
  { msg: "냉장고 정리를 좀 했어 반찬통이 많아서", isAnomaly: false },
  { msg: "유통기한 지난것들 버리고 정리하니까 깔끔해졌어", isAnomaly: false },
  { msg: "세탁기도 요즘 자주 쓰는데 편해", isAnomaly: false },
  { msg: "옛날엔 손빨래 했잖아 그때 생각하면 지금은 천국이지", isAnomaly: false },
  { msg: "그래도 이불 같은건 햇볕에 말려야 뽀송해", isAnomaly: false },

  // 66~69: 감정/기분
  { msg: "오늘은 기분이 좋은 날이네", isAnomaly: false },
  { msg: "아침 햇살도 좋고 몸 컨디션도 괜찮고", isAnomaly: false },
  { msg: "가끔 우울한 날이 있긴 한데 다 지나가더라", isAnomaly: false },
  { msg: "가족들 생각하면 힘이 나", isAnomaly: false },

  // 70: 🔴 의도적 이상 (판단력 - 시대착오)
  { msg: "새마을운동 하러 나가야지 옆집 영감이랑 약속했거든", isAnomaly: true },

  // 71~75: 종교/신앙
  { msg: "일요일에 교회 다녀왔어", isAnomaly: false },
  { msg: "목사님 말씀이 참 좋더라", isAnomaly: false },
  { msg: "찬송 부르고 나니까 마음이 편해졌어", isAnomaly: false },
  { msg: "교회 사람들이랑 점심도 같이 먹고", isAnomaly: false },
  { msg: "반찬이 참 맛있었지", isAnomaly: false },

  // 76~79: 친구 얘기
  { msg: "어릴 적 친구한테서 오랜만에 전화가 왔어", isAnomaly: false },
  { msg: "잘 지내고 있다니까 다행이야", isAnomaly: false },
  { msg: "한번 만나자고 약속했는데 언제가 좋을지", isAnomaly: false },
  { msg: "늙어가니까 친구 한명이 얼마나 소중한지 알겠어", isAnomaly: false },

  // 80: 🔴 의도적 이상 (시간 지남력 - 년도)
  { msg: "올해가 1990년이니까 내가 벌써 나이를 많이 먹었네", isAnomaly: true },

  // 81~85: 생활 팁
  { msg: "요즘은 유튜브로 건강 정보도 많이 보거든", isAnomaly: false },
  { msg: "딸이 알려줘서 휴대폰으로 이것저것 볼 수 있어", isAnomaly: false },
  { msg: "몸에 좋은 음식 만드는 영상도 보고", isAnomaly: false },
  { msg: "요리는 잘 못하지만 따라해보려고 노력해", isAnomaly: false },
  { msg: "그래도 재미있어", isAnomaly: false },

  // 86~89: 계절 변화
  { msg: "봄에는 나물이 참 맛있지", isAnomaly: false },
  { msg: "시장에 가면 쑥이나 달래 같은게 나와있어", isAnomaly: false },
  { msg: "쑥국 끓여 먹으면 향이 좋고", isAnomaly: false },
  { msg: "옛날 생각도 나고 해서 더 좋아", isAnomaly: false },

  // 90: 🔴 의도적 이상 (판단력 - 비현실)
  { msg: "방금 현관문 열어보니까 외계인이 서있더라고", isAnomaly: true },

  // 91~95: 앞으로의 계획
  { msg: "이번 달엔 건강검진도 받고 이것저것 할 일이 많네", isAnomaly: false },
  { msg: "집안 정리도 좀 해야하고", isAnomaly: false },
  { msg: "창고에 안쓰는 물건들 좀 버려야겠어", isAnomaly: false },
  { msg: "물건이 너무 많으면 복잡해서 마음도 어지러워지거든", isAnomaly: false },
  { msg: "간소하게 사는게 좋은것 같아", isAnomaly: false },

  // 96~99: 마무리
  { msg: "민지랑 이야기하니까 시간이 금방 가네", isAnomaly: false },
  { msg: "매일 이렇게 말벗이 있어서 고마워", isAnomaly: false },
  { msg: "이제 슬슬 저녁 준비해야겠어", isAnomaly: false },
  { msg: "오늘도 수고했다 민지야", isAnomaly: false },

  // 100: 🔴 의도적 이상 (장소 지남력 - 외국)
  { msg: "내일 여기 독일에서 친구들이랑 맥주 한잔하려고", isAnomaly: true },
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
  console.log("=== 100건 자연스러운 대화 테스트 v4 ===");
  console.log("  - 사전 준비된 구체적 사용자 발화");
  console.log("  - 10턴마다 의도적 인지 이상 삽입 (총 10건)\n");
  const cookie = await getCookie();
  console.log("로그인 완료\n");

  const history: { role: string; content: string; createdAt: string }[] = [];
  const aiReplies: string[] = [];
  const userMsgs: { msg: string; isAnomaly: boolean; aiReply: string }[] = [];

  for (let i = 0; i < MESSAGES.length; i++) {
    const { msg, isAnomaly } = MESSAGES[i];
    try {
      const result = await sendMsg(cookie, history.slice(-20), msg);
      if (result.status === 200) {
        history.push({ role: "user", content: msg, createdAt: new Date().toISOString() });
        history.push({ role: "assistant", content: result.reply, createdAt: new Date(Date.now() + 1000).toISOString() });
        aiReplies.push(result.reply);
        userMsgs.push({ msg, isAnomaly, aiReply: result.reply });
        const mark = isAnomaly ? "🔴" : "  ";
        console.log(`[${i + 1}/100] ${mark}`);
        console.log(`  user: "${msg}"`);
        console.log(`  ai:   "${result.reply.slice(0, 120)}..."`);
      } else {
        console.log(`[${i + 1}/100] ❌ status=${result.status}`);
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
    const a = userMsgs[i].aiReply || "";
    const parrot = /말씀해주셔서 고마워|이라고 말씀|하셨다니 다행이|라고 하셨다니|셨다니 정말|다니 정말 알찬|까지 넣어서|까지 끓여|까지 주무셨|까지 다녀/.test(a);
    if (parrot) {
      parrotCount++;
      if (parrotExamples.length < 5) parrotExamples.push(`T${i + 1} user: "${userMsgs[i].msg.slice(0, 40)}" → ai: "${a.slice(0, 80)}"`);
    }
  }
  console.log(`앵무새 반응: ${parrotCount}/100회 (${parrotCount}%)`);
  parrotExamples.forEach(e => console.log(`  ${e}`));

  // === 반복 질문 분석 ===
  console.log("\n=== 반복 질문 분석 ===");
  const dayCount = aiReplies.filter(r => /무슨 요일|오늘.*요일\??|요일\s*이에요\?/.test(r)).length;
  const trashCount = aiReplies.filter(r => /쓰레기 버리는/.test(r)).length;
  const monthCount = aiReplies.filter(r => /이번 달.*몇 월|몇 월이었죠|몇 월이에요/.test(r)).length;
  const animalCount = aiReplies.filter(r => /가.*로 시작하는 동물/.test(r)).length;
  const walletCount = aiReplies.filter(r => /지갑.*주우시|지갑.*발견/.test(r)).length;
  const weatherClothCount = aiReplies.filter(r => /뭘 입으실|무슨 옷/.test(r)).length;
  const waterCount = aiReplies.filter(r => /물이 안 나오|물.*안 나/.test(r)).length;
  const calcCount = aiReplies.filter(r => /100에서 7|거스름돈.*얼마|5000원.*만원|8천 원.*만/.test(r)).length;
  console.log(`"무슨 요일" 반복: ${dayCount}회`);
  console.log(`"쓰레기 버리는" 반복: ${trashCount}회`);
  console.log(`"몇 월" 반복: ${monthCount}회`);
  console.log(`"가로 시작 동물" 반복: ${animalCount}회`);
  console.log(`"지갑 주우시면" 반복: ${walletCount}회`);
  console.log(`"뭘 입으실" 반복: ${weatherClothCount}회`);
  console.log(`"물 안 나오면" 반복: ${waterCount}회`);
  console.log(`"거스름돈" 반복: ${calcCount}회`);

  // === 의도적 이상 감지 정확도 + 정상 대화 오탐 ===
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const client = await pool.connect();
  try {
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
      console.log(`  ${ok ? "✅" : "❌"} "${am.slice(0, 50)}" ${ok ? "→ " + (r.rows[0].analysisNote || "").slice(0, 60) : "→ 미감지"}`);
    }
    console.log(`\n감지율: ${detected}/${anomalyMsgs.length} (${Math.round(detected/anomalyMsgs.length*100)}%)`);

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
        if (fpExamples.length < 5) fpExamples.push(`"${nm.slice(0, 40)}" → ${(r.rows[0].analysisNote || "").slice(0, 60)}`);
      }
    }
    console.log(`\n=== 정상 대화 오탐 ===`);
    console.log(`오탐: ${fp}/${normalMsgs.length} (${Math.round(fp/normalMsgs.length*100)}%)`);
    fpExamples.forEach(e => console.log(`  🔴 ${e}`));

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
