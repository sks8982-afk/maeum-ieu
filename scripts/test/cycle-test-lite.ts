/**
 * Lightweight 사이클 테스트 — 5턴 × 5 사이클 = 25턴.
 * 각 사이클은 다른 시나리오로 새 기능 커버:
 *   C1: 일반 + 시간 오인지
 *   C2: 일반 + 응급 발화 (119)
 *   C3: 약 도메인 (음식 STT 보정·약 보정 트리거)
 *   C4: 장소 오인지 + 사투리
 *   C5: 인지 도메인 질문 답변 (자동 도메인 기록 검증)
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

interface Turn { user: string; tag?: "anomaly" | "emergency" | "normal" }
interface Scenario { name: string; turns: Turn[] }

const SCENARIOS: Scenario[] = [
  {
    name: "C1: 시간 오인지",
    turns: [
      { user: "민지야 안녕 오늘은 좀 피곤해" },
      { user: "어제 손주가 와서 같이 놀았어 즐거웠지" },
      { user: "점심은 김치찌개 먹었어 맛있더라" },
      { user: "오늘 오후에는 산책 가려고" },
      { user: "오늘이 1985년 봄인가 그렇지?", tag: "anomaly" },
    ],
  },
  {
    name: "C2: 응급 발화",
    turns: [
      { user: "민지야 나 오늘 컨디션 별로야" },
      { user: "잠도 잘 못 잤어 새벽에 자꾸 깨더라" },
      { user: "아침은 토스트 한 장만 먹었어" },
      { user: "혈압이 좀 높은가 머리가 어지러워" },
      { user: "지금 가슴이 너무 아파서 못 견디겠어 119에 전화해줘", tag: "emergency" },
    ],
  },
  {
    name: "C3: 약 도메인 (사투리·발음 보정)",
    turns: [
      { user: "민지야 또 왔어 어데 안 갔지" },           // 사투리: 어데→어디
      { user: "오늘 약은 잘 챙겨먹었어" },
      { user: "혈양약은 아침에 먹었어 까먹지 않고" },   // STT 보정: 혈양약→혈압약
      { user: "쪼매 졸리네 낮잠 좀 자야겠어" },         // 사투리: 쪼매→조금
      { user: "할매가 오면 같이 점심 먹어야지" },       // 사투리: 할매→할머니
    ],
  },
  {
    name: "C4: 장소 오인지 + 거시기",
    turns: [
      { user: "민지야 점심 뭐 먹지 고민이야" },
      { user: "거시기 좀 챙겨와 줘" },                  // 사투리: 거시기→그거
      { user: "허벌나게 더워 오늘" },                   // 사투리: 허벌나게→엄청
      { user: "여그서 좀 쉬고 있어" },                  // 사투리: 여그→여기
      { user: "나 지금 부산 해운대에 와있어", tag: "anomaly" },
    ],
  },
  {
    name: "C5: 인지 도메인 답변 (자동 기록 검증)",
    turns: [
      { user: "민지야 오늘은 기분 좋아" },
      { user: "오늘 무슨 요일이지? 까먹어서" },           // AI가 답변 → 자동 시간 도메인 기록
      { user: "오늘 점심은 미여국 먹었어" },              // 음식 STT 보정: 미여국→미역국
      { user: "백문이 불여일견이란 말 알지 직접 보는게 최고지" },
      { user: "10에서 3을 빼면 7이지", tag: "normal" },
    ],
  },
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
  const all = loginRes.headers.getSetCookie?.() || [];
  return [...cookies.split(","), ...all].join("; ");
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
  const data = await res.json() as {
    text?: string;
    emergency?: { level: number; category: string };
    sttFailed?: boolean;
  };
  return { status: res.status, reply: data.text || "", emergency: data.emergency, sttFailed: data.sttFailed };
}

async function main() {
  const cookie = await getCookie();
  const history: { role: string; content: string; createdAt: string }[] = [];

  let cycleCount = 0;
  let anomalyHits = 0, anomalyTotal = 0;
  let emergencyHits = 0, emergencyTotal = 0;
  let honorificDup = 0;

  for (const scen of SCENARIOS) {
    cycleCount++;
    console.log(`\n========= ${scen.name} =========`);
    let turnIdx = 0;
    for (const turn of scen.turns) {
      turnIdx++;
      const r = await sendMsg(cookie, history.slice(-8), turn.user);
      const mark = turn.tag === "anomaly" ? "🔴" : turn.tag === "emergency" ? "🚨" : "  ";
      console.log(`[${turnIdx}/${scen.turns.length}] ${mark}`);
      console.log(`  user: "${turn.user}"`);
      console.log(`  ai:   "${r.reply.slice(0, 110)}"`);
      if (r.emergency) console.log(`  emergency: ${JSON.stringify(r.emergency)}`);

      // 호칭 중복 체크
      if (/할할아버지|할할머니/.test(r.reply)) {
        honorificDup++;
        console.log("  ⚠️ 호칭 중복!");
      }
      if (turn.tag === "anomaly") anomalyTotal++;
      if (turn.tag === "emergency") {
        emergencyTotal++;
        if (r.emergency && r.emergency.level >= 2) emergencyHits++;
      }

      history.push({ role: "user", content: turn.user, createdAt: new Date().toISOString() });
      history.push({ role: "assistant", content: r.reply, createdAt: new Date(Date.now() + 1000).toISOString() });
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // DB 이상 감지 확인
  await new Promise((r) => setTimeout(r, 8000));
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();
  try {
    for (const scen of SCENARIOS) {
      for (const turn of scen.turns) {
        if (turn.tag !== "anomaly") continue;
        const r = await c.query(
          `SELECT "isAnomaly" FROM "Message" WHERE content = $1 AND "isAnomaly" = true ORDER BY "createdAt" DESC LIMIT 1`,
          [turn.user],
        );
        if (r.rows.length > 0) anomalyHits++;
      }
    }
  } finally { c.release(); await pool.end(); }

  console.log(`\n========= 종합 =========`);
  console.log(`사이클: ${cycleCount}/5  |  총 턴: ${history.length / 2}`);
  console.log(`호칭 중복(할할아버지/할할머니): ${honorificDup}`);
  console.log(`의도적 이상 감지: ${anomalyHits}/${anomalyTotal}`);
  console.log(`응급 발화 즉시 분류: ${emergencyHits}/${emergencyTotal}`);
}

main().catch(console.error);
