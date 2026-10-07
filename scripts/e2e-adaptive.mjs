/**
 * 적응형 장기 대화 자동 검증 루프 (Playwright).
 *
 * 사이클마다: 신규 계정 생성 → 커스텀 동반자 이름 DB 세팅(이름 누출 fix 검증) →
 *   로그인 → 텍스트 대화 진입 → ~30턴 긴 대화(6영역 정상/이상 혼합) 전송 →
 *   매 AI 응답 자동 이상감지(빈응답/****블랭킹/JSON누출/타인이름누출/호칭오류/회피fallback남용) →
 *   DB cognitive_assessments 점수를 기대값과 대조 → 사이클 리포트.
 *
 * 사용: node scripts/e2e-adaptive.mjs [cycles] [turnsScale] [headed]
 *   cycles:    사이클 수 (기본 10)
 *   turnsScale: 1=약30턴(기본). 실제 턴 수는 플로우 길이에 따름.
 *   headed:    "headed"면 브라우저 표시(직접 관찰용). 기본 headless.
 *
 * 사전: dev 서버(:3100) 실행 중.
 * 산출: docs/리포트_적응형루프_10cycles.md (전 사이클 + 이상 요약), docs/리포트_누적.md 1줄 적재.
 */
import { chromium } from "playwright";
import pg from "pg";
import { pgTlsOptions } from "./db-tls.mjs";
import fs from "fs";
import "dotenv/config";

const BASE = process.env.E2E_BASE || "http://localhost:3100";
const PW = "test1234!";
const CYCLES = parseInt(process.argv[2] || "10", 10);
const HEADED = process.argv[4] === "headed" || process.argv[3] === "headed";
const STAMP = Date.now();
// 리포트 구분용 모델 라벨(실제 사용 모델은 앱 코드 기준). 예: MODEL_LABEL=gemini-3.5-flash
const MODEL_LABEL = process.env.MODEL_LABEL || "gemini-3.5-flash";

// 페르소나: 커스텀 동반자 이름(받침 유/무 섞음) + 호칭 + 성별. 이름 누출 fix를 다양한 이름으로 검증.
const PERSONAS = [
  { companion: "지윤", relation: "손녀", honorific: "할머니", gender: "여성" },
  { companion: "수진", relation: "딸", honorific: "할머니", gender: "여성" },
  { companion: "하늘", relation: "손녀", honorific: "할아버지", gender: "남성" },
  { companion: "민호", relation: "손자", honorific: "할아버지", gender: "남성" },
  { companion: "보람", relation: "손녀", honorific: "할머니", gender: "여성" },
  { companion: "다정", relation: "딸", honorific: "할머니", gender: "여성" },
  { companion: "햇살", relation: "손자", honorific: "할아버지", gender: "남성" },
  { companion: "영주", relation: "손녀", honorific: "할머니", gender: "여성" },
  { companion: "준서", relation: "손자", honorific: "할아버지", gender: "남성" },
  { companion: "봄이", relation: "손녀", honorific: "할머니", gender: "여성" },
];

const pick = (i, arr) => arr[i % arr.length];

/**
 * 사이클별 ~30턴 대화 플로우 생성. 표면 텍스트는 cycle 인덱스로 변주.
 * expect 있는 턴만 DB 점수 strict 채점. soft 턴은 이상감지·로깅만.
 */
function buildFlow(ci, p) {
  const himher = p.gender === "남성" ? "할아버지" : "할머니";
  return [
    // 1) 인사·일상(정상 filler — 오탐 없어야)
    { text: pick(ci, ["오늘 날씨가 참 좋아서 기분이 다 좋구나", "아침에 일어나니 햇살이 좋더라고", "간밤에 푹 자서 그런지 개운하네"]) },
    { text: pick(ci, ["아침은 누룽지 끓여서 간단히 먹었어", "방금 따뜻한 보리차 한잔 마셨지", "마당에 화분에 물 좀 주고 왔어"]) },
    // 2) 시간 지남력 정상
    { text: pick(ci, ["참 오늘이 유월 초인데 벌써 여름이 오려나", "이제 유월이라 낮이 제법 길어졌어", "오늘 유월 초순 맞지, 달력 보니 그렇더라"]), expect: { domain: "orientation_time", score: 0 } },
    // 3) 장소 지남력 정상
    { text: pick(ci, ["나야 늘 그렇듯 동탄 우리 집에 있지", "여기 동탄 아파트에서 십 년 넘게 살고 있어", "집이 제일 편하지, 동탄 우리 동네 말이야"]), expect: { domain: "orientation_place", score: 0 } },
    // 4) 계산 정상 (100-7)
    { text: pick(ci, ["머리 안 굳었나 해서 백에서 칠 빼봤더니 구십삼, 또 빼면 팔십육이더라", "백에서 칠씩 빼면 구십삼 팔십육 칠십구 척척 나오지", "백 빼기 칠은 구십삼, 그 정도 셈은 아직 하지"]), expect: { domain: "attention_calculation", score: 0 } },
    // 5) 판단력 정상
    { text: pick(ci, ["어제 길에 떨어진 지갑을 주워서 파출소에 갖다줬어 주인 찾아야지", "집에 불나면 큰일이니 가스부터 잠그고 119 불러야지", "갑자기 비 오면 빨래부터 걷고 우산 챙겨 나가야지"]), expect: { domain: "judgment", score: 0 } },
    // 6) 언어(의미유창성) 정상 — 동물 많이
    { text: pick(ci, ["심심해서 동물 이름 대봤다, 개 소 돼지 닭 토끼 고양이 호랑이 사자 곰 코끼리", "동물이야 많지 개 고양이 소 말 돼지 양 닭 오리 토끼 사슴", "개 소 돼지 닭 염소 토끼 여우 늑대 사자 호랑이 이만하면 됐지"]), expect: { domain: "language", score: 0 } },
    // 7) 일상 공감 filler
    { text: pick(ci, ["요새 무릎이 좀 시큰거려서 밤에 깰 때가 있어", "허리가 가끔 뻐근한데 그러려니 하고 지내", "눈이 좀 침침해져서 신문 글씨가 작게 보여"]) },
    // 8) 단어게임 등록 (soft — **** 블랭킹/누출 감지용)
    { text: pick(ci, ["머리도 쓸 겸 단어 외우기 한번 해볼까", "기억력 테스트 삼아 단어 세 개만 불러줘 봐", "심심한데 단어 외우기 놀이나 하자"]), react: "wordgame" },
    // 9) 단어게임 부분회상 (soft — memory_delayed:1 기대)
    { text: pick(ci, ["아까 그 단어 두 개는 생각나는데 마지막 하나가 영 안 나네", "외운 것 중에 둘은 알겠는데 나머지 하나가 가물가물해", "두 개까지는 기억나는데 세 번째가 통 떠오르질 않아"]), soft: { domain: "memory_delayed", score: 1 } },
    // 10) 시간 지남력 이상 (확신 연도 오류)
    { text: pick(ci, ["무슨 소리야 올해가 1988년이지, 곧 서울올림픽 한다고 떠들썩하잖아", "지금이 1995년 아니냐, 얼마 전에 삼풍백화점 무너졌다고 난리였는데", "올해가 2002년이지 월드컵 한다고 온 나라가 붉은 옷이야"]), expect: { domain: "orientation_time", score: 2 } },
    // 11) 장소 지남력 이상 (확신 엉뚱한 위치)
    { text: pick(ci, ["나 지금 집 아니고 제주도 호텔에 놀러 왔어 창밖에 바다가 보여", "여기 지금 부산 해운대 바닷가에 나와 있어 갈매기가 많네", "지금 서울 남대문시장 한복판이야 사람이 바글바글해"]), expect: { domain: "orientation_place", score: 2 } },
    // 12) 일상 filler (정상)
    { text: pick(ci, ["점심엔 뭐 시원한 거 먹고 싶은데 콩국수나 할까", "오후엔 동네 노인정에 마실이나 다녀올까 해", "이따 저녁에 자식들한테 전화나 한 통 해야겠어"]) },
    // 13) 판단력 이상 (사망인물 현재 접촉)
    { text: pick(ci, ["내일 박정희 대통령이 우리집에 점심 드시러 오신다고 해서 상 차려야지", "어제 이순신 장군이 마실 와서 차 한잔 하고 갔어", "아까 돌아가신 우리 아버지가 마당에서 나 부르시더라고"]), expect: { domain: "judgment", score: 2 } },
    // 14) 계산 이상 (불가능 거래)
    { text: pick(ci, ["콩나물 삼천원어치 샀는데 만원 내니까 거스름돈을 이만원이나 주더라", "두부 한 모 천원 주고 샀는데 거스름돈을 오만원 받아왔지 뭐야", "사천원짜리 국수 먹고 천원 냈는데 거스름 삼천원 받아 횡재했어"]), expect: { domain: "attention_calculation", score: 2 } },
    // 15) 정상 회복 — 시간(계절) 정상
    { text: pick(ci, ["아무튼 요즘은 초여름이라 아침저녁으로 선선하니 좋아", "유월이라 그런지 해가 길어서 저녁이 환해 좋더라", "장마 오기 전이라 빨래 말리기 딱 좋은 철이야"]), soft: { domain: "orientation_time", score: 0 } },
    // 16) 일상 filler (감정 공감 — 오탐 없어야)
    { text: pick(ci, ["자식들 보고 싶은데 다들 바빠서 자주 못 와 좀 적적해", "영감 먼저 보내고 혼자 지내려니 가끔 허전하긴 해", "손주 녀석들 크는 거 보는 게 사는 낙이지 뭐"]) },
    // 17) 언어(속담 의미) soft
    { text: pick(ci, ["가는 말이 고와야 오는 말이 곱다는 게, 내가 남한테 잘해야 남도 잘해준단 뜻이지", "백문이 불여일견이라잖아, 백번 듣느니 한번 보는 게 낫단 거야", "발 없는 말이 천리 간다더니 소문이 참 빠르더라고"]), soft: { domain: "language", score: 0 } },
    // 18) 장소 지남력 경계 (틀린 곳 + 회상 hedge) soft → 1
    { text: pick(ci, ["여기가 부산인가… 아니 옛날 살던 데가 자꾸 생각나서 헷갈리네", "예전 시골집 생각이 나서 그런지 여기가 어디였더라 가물가물해", "결혼하고 살던 동네가 떠올라서 잠깐 헷갈렸네 여기 어디지"]), soft: { domain: "orientation_place", score: 1 } },
    // 19) 일상 filler
    { text: pick(ci, ["텔레비전 트로트 프로 보는 재미로 저녁을 보내", "라디오에서 옛날 노래 나오면 따라 흥얼거리지", "마당 텃밭에 상추 고추 심어놓고 들여다보는 맛이 좋아"]) },
    // 20) 판단력 정상 (상황대처)
    { text: pick(ci, ["밤에 가슴이 답답하고 식은땀 나면 참지 말고 바로 119 불러야겠지", "약을 깜빡하고 두 번 먹을 뻔했는데 수첩에 적어두기로 했어", "모르는 사람이 돈 부치라고 전화 오면 무조건 끊어야지"]), soft: { domain: "judgment", score: 0 } },
    // 21) 계산 정상 (거스름)
    { text: pick(ci, ["만원짜리 내고 삼천원짜리 두부 사면 칠천원 거슬러 받는 게 맞지", "오천원어치 사고 만원 주면 오천원 받아야 정상이고", "천원짜리 다섯 장이면 오천원, 그 정도 셈이야 하지"]), soft: { domain: "attention_calculation", score: 0 } },
    // 22) 시간 지남력 경계 (틀린 연도 + 불확실 hedge) soft → 1
    { text: pick(ci, ["올해가… 한 2010년쯤 됐나? 자꾸 옛날 생각이 나서 헷갈리네", "지금이 몇 년도더라 이천 몇 년인데 가물가물해서 영 모르겠어", "내가 요새 날짜를 자꾸 까먹어, 올해가 몇 년인지도 헷갈려"]), soft: { domain: "orientation_time", score: 1 } },
    // 23) 일상 filler
    { text: pick(ci, ["오늘은 이만하면 많이 떠들었네 입이 좀 아프다", "자네랑 얘기하니 시간 가는 줄 모르겠어 고마워", "이런저런 얘기 들어줘서 마음이 한결 가볍네"]) },
    // 24) 즉시기억 정상 (따라말하기 soft)
    { text: pick(ci, ["방금 자네가 한 말 따라 해볼게, 알겠어 잘 들었어", "응 그 말 그대로 기억했다가 이따 또 얘기하지", "무슨 말인지 알아들었어 머리에 잘 새겨뒀어"]) },
    // 25) 장소 지남력 정상 (재확인)
    { text: pick(ci, ["그나저나 나 지금 우리 집 안방에 앉아서 자네랑 얘기하는 거야", "여기 우리 동네 동탄이고 집 안에 있으니 편하지", "창밖 보니 우리 아파트 단지 놀이터가 보이네 집이 맞아"]), soft: { domain: "orientation_place", score: 0 } },
    // 26) 일상 마무리 공감
    { text: pick(ci, ["슬슬 저녁 준비해야겠다 오늘 고마웠어", "이만 좀 쉬어야겠어 자네도 수고 많았네", "내일 또 얘기하자고, 잘 있어"]) },
    // 27) 판단력 이상 (비현실 경험)
    { text: pick(ci, ["아 참 아까 마당에 외계인이 내려와서 나랑 한참 얘기하다 갔어", "어제 공룡이 동네를 어슬렁거려서 다들 구경했잖아", "간밤에 용이 하늘을 날아다니길래 절을 했지 뭐야"]), expect: { domain: "judgment", score: 2 } },
    // 28) 정상 마무리 (오탐 없어야)
    { text: pick(ci, ["에이 농담이고, 오늘 자네랑 얘기 많이 해서 즐거웠어", "그냥 해본 소리야 아무튼 오늘 참 좋았네", "허허 장난쳐봤어 자네 덕에 안 심심했어"]) },
  ];
}

function pgPool() {
  // TLS는 앱과 같은 정책(scripts/db-tls.mjs → lib/db-tls, 2026-10-07 8차) — 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL);
  return new pg.Pool({ connectionString, ...(ssl ? { ssl } : {}) });
}

async function signupUI(page, email, persona) {
  await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('input[type="email"]', { timeout: 12000 });
  await page.locator('input[type="email"]').fill(email);
  const pws = page.locator('input[type="password"]');
  await pws.nth(0).fill(PW);
  await pws.nth(1).fill(PW);
  await page.locator('input[type="number"]').first().fill("78").catch(() => {});
  await page.locator("select").first().selectOption({ label: persona.gender }).catch(() => {});
  await page.waitForTimeout(400); // controlled input 상태 커밋 대기
  await page.getByRole("button", { name: "회원가입" }).click();
  await page.waitForURL(/\/login/, { timeout: 20000 }).catch(() => {});
}

async function login(page, email) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.context().clearCookies(); // 가입 후 잔여 CSRF/세션 쿠키 제거 (즉시 로그인 401 race 방지)
      await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('input[type="password"]', { timeout: 10000 });
      await page.waitForTimeout(600); // NextAuth CSRF 토큰 로드 대기
      await page.locator('input[type="email"]').first().fill(email);
      await page.locator('input[type="password"]').first().fill(PW);
      await page.waitForTimeout(400); // controlled input 상태 커밋 대기 (즉시 click 시 401 race)
      // 실제 Playwright 클릭(trusted) — 프로그램적 click은 네이티브 GET submit 되어 signIn 미발동
      await page.getByRole("button", { name: "로그인" }).click();
      await page.waitForURL(/\/chat/, { timeout: 25000 });
      return;
    } catch (e) { if (attempt === 2) throw e; await page.waitForTimeout(1500); }
  }
}

const INPUT_SEL = 'input[placeholder="메시지를 입력하세요."]';
async function enterTextChat(page) {
  await page.waitForSelector('button:has-text("글씨로 대화하기")', { timeout: 12000 }).catch(() => {});
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("글씨로 대화하기"));
    if (btn) btn.click();
  });
  await page.waitForSelector(INPUT_SEL, { timeout: 12000 });
  await page.waitForFunction(() => [...document.querySelectorAll("p")].filter((p) => p.textContent.trim()).length >= 1, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
}

/** 전송 후 직전 사용자 발화 다음에 나온 AI 응답 텍스트를 반환(없으면 ""→빈응답). */
async function sendAndRead(page, text) {
  await page.waitForSelector(INPUT_SEL, { timeout: 8000 });
  const before = await page.evaluate(() => document.querySelectorAll("p").length);
  await page.locator(INPUT_SEL).fill(text);
  const sendBtn = page.getByRole("button", { name: "전송" });
  if (await sendBtn.count()) await sendBtn.first().click().catch(() => page.locator(INPUT_SEL).press("Enter"));
  else await page.locator(INPUT_SEL).press("Enter");
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(900);
    const now = await page.evaluate(() => document.querySelectorAll("p").length);
    if (now >= before + 2) break;
  }
  await page.waitForTimeout(700); // 백그라운드 분석 여유
  return await page.evaluate((sent) => {
    const ps = [...document.querySelectorAll("p")].map((p) => p.textContent);
    let idx = -1;
    for (let i = ps.length - 1; i >= 0; i--) { if (ps[i].trim() === sent.trim()) { idx = i; break; } }
    const after = idx >= 0 ? ps.slice(idx + 1) : [];
    return after.map((s) => s.trim()).filter(Boolean).join(" ").trim();
  }, text);
}

/** AI 응답 자동 이상감지. persona 기준 타인이름/호칭/빈응답 등. */
function detectAnomalies(ai, persona) {
  const flags = [];
  if (!ai || ai.length === 0) { flags.push("EMPTY(빈 응답)"); return flags; }
  if (ai.includes("****") || /\*\*\s*이에요|\*\*\s*예요/.test(ai)) flags.push("BLANK(**** 블랭킹)");
  if (/\{[^}]*"(text|isAnomaly|score|response|analysisNote)"/.test(ai) || /"isAnomaly"\s*:/.test(ai)) flags.push("JSON_LEAK");
  // 실제 누출 신호: 하드코딩 기본 이름 "민지"가 (내 동반자가 아닌데) AI 자기지칭으로 등장.
  // 페르소나 이름이 일반명사(햇살/보람/봄이 등)여도 오탐 안 나도록 "민지"만 검사.
  if (persona.companion !== "민지" && /민지(?:이?(?:가|는|도|예요|에요|이에요)|이|아|야)/.test(ai)) flags.push("NAME_LEAK(민지)");
  // 호칭 오류: 반대 호칭으로 사용자를 직접 부름
  const opp = persona.honorific === "할머니" ? "할아버지" : "할머니";
  if (new RegExp(`${opp}[,!\\s]`).test(ai) && !new RegExp(persona.honorific).test(ai)) flags.push(`HONORIFIC(${opp})`);
  // 회피 fallback 남용
  if (/방금 말씀하신 내용을 좀 더 자세히|다시 한 번 말씀해주실 수 있으세요/.test(ai)) flags.push("FALLBACK(회피)");
  return flags;
}

async function main() {
  const pool = pgPool();
  const report = [];
  const anomalyLog = [];
  let totalStrict = 0, totalStrictHit = 0;
  let totalTurns = 0, totalEmpty = 0, totalLeak = 0;

  const reportPath = `docs/리포트_적응형루프_${CYCLES}cycles_${MODEL_LABEL}.md`;
  report.push(`# 적응형 장기 대화 루프 검증 — ${CYCLES} 사이클 (모델: ${MODEL_LABEL})`);
  report.push("");
  report.push(`- 생성: ${new Date().toISOString()} · **기준 모델: ${MODEL_LABEL}** · 사이클당 ~28턴(6영역 정상/이상 혼합) · 커스텀 동반자 이름 ${CYCLES}종`);
  report.push("");

  const browser = await chromium.launch({ headless: !HEADED, slowMo: HEADED ? 60 : 0 });

  for (let ci = 0; ci < CYCLES; ci++) {
    const persona = PERSONAS[ci % PERSONAS.length];
    const email = `adapt_${STAMP}_${ci}@example.com`;
    const flow = buildFlow(ci, persona);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const cycleAnoms = [];
    const transcript = []; // {who, text, turn?} — 대화 전문(점수 주석은 렌더 시 부여)
    let uid = null;
    console.log(`\n=== Cycle ${ci + 1}/${CYCLES} · 동반자 ${persona.companion}(${persona.relation})/${persona.honorific} · ${email.slice(-20)} ===`);
    try {
      await signupUI(page, email, persona);
      const c0 = await pool.connect();
      try {
        const r = await c0.query(`SELECT id FROM "User" WHERE email=$1`, [email]);
        uid = r.rows[0]?.id;
        if (uid) await c0.query(`UPDATE "User" SET "companionName"=$1, "companionRelation"=$2 WHERE id=$3`, [persona.companion, persona.relation, uid]);
      } finally { c0.release(); }
      if (!uid) throw new Error("signup failed");
      await login(page, email);
      await enterTextChat(page);

      // AI 최초 인사 캡처(어떻게 말문을 여는지)
      const greeting = await page.evaluate(() => [...document.querySelectorAll("p")].map((p) => p.textContent.trim()).filter(Boolean).slice(-1)[0] || "");
      if (greeting) transcript.push({ who: persona.companion, text: greeting });

      for (let ti = 0; ti < flow.length; ti++) {
        const turn = flow[ti];
        const ai = await sendAndRead(page, turn.text);
        totalTurns++;
        transcript.push({ who: "어르신", text: turn.text, turn });
        transcript.push({ who: persona.companion, text: ai });
        const flags = detectAnomalies(ai, persona);
        if (flags.includes("EMPTY(빈 응답)")) totalEmpty++;
        if (flags.some((f) => f.startsWith("NAME_LEAK"))) totalLeak++;
        if (flags.length) {
          cycleAnoms.push({ ti: ti + 1, text: turn.text.slice(0, 30), flags, ai: ai.slice(0, 90) });
          console.log(`  ⚠ turn ${ti + 1} ${flags.join(",")} | AI: ${ai.slice(0, 60) || "(빈)"}`);
        } else {
          process.stdout.write(`\r  turn ${ti + 1}/${flow.length} ok        `);
        }
      }
      console.log("");
    } catch (e) {
      console.log(`  ! drive error: ${e.message.split("\n")[0]}`);
      cycleAnoms.push({ ti: 0, text: "(drive error)", flags: ["DRIVE_ERROR"], ai: e.message.slice(0, 80) });
    } finally {
      await ctx.close();
    }

    // DB 점수 대조
    await new Promise((r) => setTimeout(r, 3000));
    const scoreRows = [];
    let byContent = {};
    let strict = 0, strictHit = 0;
    if (uid) {
      const c = await pool.connect();
      try {
        const r = await c.query(
          `SELECT m.content, ca.domain, ca.score FROM "Message" m
           LEFT JOIN cognitive_assessments ca ON ca.message_id = m.id
           WHERE m."conversationId" IN (SELECT id FROM "Conversation" WHERE "userId"=$1) AND m.role='user'`, [uid]);
        for (const row of r.rows) {
          const k = row.content.trim();
          byContent[k] = byContent[k] || [];
          if (row.domain) byContent[k].push({ domain: row.domain, score: row.score });
        }
        for (const turn of flow) {
          if (!turn.expect) continue;
          strict++; totalStrict++;
          const checks = byContent[turn.text.trim()] || [];
          let ok;
          if (turn.expect.score >= 2) ok = checks.some((c) => c.domain === turn.expect.domain && c.score >= 2);
          else ok = !checks.some((c) => c.score >= 2); // 정상: score2 없어야
          if (ok) { strictHit++; totalStrictHit++; }
          scoreRows.push({ text: turn.text.slice(0, 26), exp: `${turn.expect.domain}=${turn.expect.score}`, got: checks.map((c) => `${c.domain}:${c.score}`).join(" ") || "(없음)", ok });
        }
      } finally { c.release(); }
    }
    // 발화→점수/기대 주석 헬퍼(transcript 렌더용)
    const annotate = (turn) => {
      if (!turn) return "";
      const checks = byContent[turn.text.trim()] || [];
      const got = checks.map((c) => `${c.domain}:${c.score}`).join(" ");
      const spec = turn.expect || turn.soft;
      const expTag = turn.expect ? `기대 ${turn.expect.domain}=${turn.expect.score}` : (turn.soft ? `참고기대 ${turn.soft.domain}=${turn.soft.score}` : "");
      if (!spec && !got) return "";
      let mark = "";
      if (turn.expect) {
        const ok = turn.expect.score >= 2 ? checks.some((c) => c.domain === turn.expect.domain && c.score >= 2) : !checks.some((c) => c.score >= 2);
        mark = ok ? " ✅" : " ❌";
      }
      return `  〔${expTag}${expTag && got ? " / " : ""}${got ? "실제 " + got : (spec ? "실제 (분석없음)" : "")}〕${mark}`;
    };

    // 사이클 리포트 누적
    report.push(`## Cycle ${ci + 1} — 동반자 ${persona.companion}/${persona.honorific}`);
    report.push(`- 계정: ${email} · 턴 ${flow.length} · strict 채점 ${strictHit}/${strict} · 이상감지 ${cycleAnoms.length}건`);
    report.push("");

    // (1) 점수 요약 표 (기대/실제) — 기존 유지
    report.push("### 점수 요약 (기대 vs 실제)");
    report.push("| 발화(정상/이상) | 기대 | 실제 | 판정 |");
    report.push("|------|------|------|------|");
    for (const s of scoreRows) report.push(`| ${s.text}… | ${s.exp} | ${s.got} | ${s.ok ? "O" : "X"} |`);
    report.push("");

    // (2) 대화 전문 — AI가 어떻게 묻고 어르신이 어떻게 답해 그 점수가 나왔는지
    report.push("### 대화 전문 (점수 주석 포함)");
    report.push("> 어르신 발화 옆 〔…〕는 그 발화에 대한 분석기 채점. ✅/❌는 기대 대비 일치 여부.");
    report.push("");
    for (const line of transcript) {
      if (line.who === "어르신") {
        report.push(`- **어르신**: ${line.text}${annotate(line.turn)}`);
      } else {
        report.push(`  - ${line.who}: ${line.text || "*(빈 응답)*"}`);
      }
    }
    report.push("");

    // (3) 이상 응답
    if (cycleAnoms.length) {
      report.push("**이상 응답 감지:**");
      for (const a of cycleAnoms) { report.push(`- turn ${a.ti} [${a.flags.join(", ")}] 발화"${a.text}…" → AI"${a.ai}…"`); anomalyLog.push(`C${ci + 1}.t${a.ti}: ${a.flags.join(",")}`); }
    } else {
      report.push("**이상 응답 감지: 0건** ✅");
    }
    report.push("");
    // 증분 저장 — 중단되어도 완료 사이클 보존
    try { fs.writeFileSync(reportPath, report.join("\n"), "utf-8"); } catch {}
    console.log(`  [cycle ${ci + 1}] strict ${strictHit}/${strict} · 이상 ${cycleAnoms.length} · 저장`);
  }

  await browser.close();
  await pool.end();

  report.splice(3, 0,
    `## 종합 요약`,
    `- strict 점수 정확도(시간/장소/판단/계산 정상·이상): **${totalStrictHit}/${totalStrict} (${totalStrict ? ((totalStrictHit / totalStrict) * 100).toFixed(1) : 0}%)**`,
    `- 총 ${totalTurns}턴 중 빈응답 ${totalEmpty}건 · 타인이름누출 ${totalLeak}건`,
    `- 이상감지 합계: ${anomalyLog.length}건 ${anomalyLog.length ? "→ " + anomalyLog.join(" / ") : "(없음 ✅)"}`,
    "");

  const out = report.join("\n");
  const path = reportPath;
  fs.writeFileSync(path, out, "utf-8");
  const cum = "docs/리포트_누적.md";
  const summary = `| ${new Date().toISOString().slice(0, 19)} | adaptive-loop(${MODEL_LABEL}) | ${CYCLES}cyc | ${totalTurns}턴 | strict ${totalStrictHit}/${totalStrict} · 빈응답${totalEmpty} · 누출${totalLeak} · 이상${anomalyLog.length} |\n`;
  if (!fs.existsSync(cum)) fs.writeFileSync(cum, "# e2e 누적 검증 요약\n\n| 시각(UTC) | 테스트 | 라운드 | 규모 | 정확도 |\n|---|---|---|---|---|\n", "utf-8");
  fs.appendFileSync(cum, summary, "utf-8");

  console.log(`\n\n===== 완료 =====`);
  console.log(`strict 정확도: ${totalStrictHit}/${totalStrict} · 빈응답 ${totalEmpty} · 누출 ${totalLeak} · 이상감지 ${anomalyLog.length}`);
  console.log(`리포트: ${path}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
