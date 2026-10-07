/**
 * 전문가 대리 검진(pro proxy exam) e2e — API 레벨.
 *
 * 왜 이게 필요한가 (2026-10-02):
 *   이 경로는 **의사가 시행해 결과지에 올라가는 점수**를 만든다. 그런데 end-to-end 검증이 전무했다.
 *   scripts/e2e-roles.mjs의 pro 역할은 제품에 없는 경로(pro 본인 대화)를 두드리고 있었고
 *   — app/chat/page.tsx:683이 proxyPatientId 없는 pro를 /expert로 되돌린다 —
 *   scripts/e2e-screening.mjs는 어르신 자가 대화의 인지 분석을 본다. 둘 다 이 경로가 아니다.
 *
 * 왜 UI가 아니라 API인가:
 *   대리 검진은 **음성 전용**이다(chat/page.tsx의 examMode → '검진 시작' 버튼 → 마이크).
 *   헤드리스 브라우저엔 마이크가 없어 UI로는 한 문항도 못 민다. 검증 대상은 UI 조작이 아니라
 *   "표준 문항이 순서대로 나오고, 답변이 정확히 채점되어 exam_item_score에 남는가"이므로
 *   /api/chat을 직접 호출하는 편이 더 정확하고 결정적이다.
 *
 * 흐름: pro 계정 생성 → 환자 계정 생성 → 초대코드로 연결 → 검진 start →
 *       isInitialGreeting으로 첫 문항 → 정답/오답 섞어 응답 → DB의 exam_item_score 대조
 *
 * 사용: node scripts/e2e-pro-exam.mjs
 * 사전: dev 서버(:3100) 실행 중. DATABASE_URL 설정.
 */
import pg from "pg";
import { pgTlsOptions } from "./db-tls.mjs";
import "dotenv/config";

const BASE = process.env.E2E_BASE || "http://localhost:3100";
const PW = "test1234!";
const STAMP = Date.now();
const PRO_EMAIL = `role_proexam_${STAMP}@example.com`;
const PATIENT_EMAIL = `role_proexam_pt_${STAMP}@example.com`;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

function pool() {
  // TLS는 앱과 같은 정책(scripts/db-tls.mjs → lib/db-tls, 2026-10-07 8차) — 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL);
  return new pg.Pool({ connectionString, ...(ssl ? { ssl } : {}), max: 2 });
}

/** 쿠키를 들고 다니는 최소 fetch 래퍼 — next-auth 세션 유지용 */
function session() {
  const jar = new Map();
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  return {
    async req(path, init = {}) {
      const res = await fetch(`${BASE}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init.headers || {}), ...(jar.size ? { cookie: cookieHeader() } : {}) },
        redirect: "manual",
      });
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [pair] = c.split(";");
        const i = pair.indexOf("=");
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
      return res;
    },
    cookieHeader,
  };
}

async function signup(s, email, role) {
  const res = await s.req("/api/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password: PW, passwordConfirm: PW, name: role === "pro" ? "김전문" : "박환자", screeningMode: role, age: role === "pro" ? 45 : 79, gender: role === "pro" ? "male" : "female" }),
  });
  return res.status;
}

/** next-auth credentials 로그인 — CSRF 토큰을 받아 form 인코딩으로 POST */
async function login(s, email) {
  const csrfRes = await s.req("/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const body = new URLSearchParams({ csrfToken, email, password: PW, json: "true" });
  const res = await s.req("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return res.status;
}

async function main() {
  console.log(`\n🩺 전문가 대리 검진 e2e — ${BASE}\n`);
  const db = pool();

  const pro = session();
  const pt = session();

  // ── 1) 계정 생성 ──────────────────────────────────────────────────────────
  console.log("[1] 계정 생성·로그인");
  check("pro 가입", [200, 201].includes(await signup(pro, PRO_EMAIL, "pro")));
  check("환자 가입", [200, 201].includes(await signup(pt, PATIENT_EMAIL, "user")));
  await login(pro, PRO_EMAIL);
  await login(pt, PATIENT_EMAIL);

  const c = await db.connect();
  try {
    const r = await c.query(`SELECT id, "screeningMode" FROM "User" WHERE email = ANY($1)`, [[PRO_EMAIL, PATIENT_EMAIL]]);
    check("DB 계정 2건", r.rows.length === 2, `${r.rows.length}건`);
    var proId = r.rows.find((x) => x.screeningMode === "pro")?.id;
    var ptId = r.rows.find((x) => x.screeningMode === "user")?.id;
    check("역할 정합(pro/user)", !!proId && !!ptId);
    // 환자 동의 — 미동의면 대리 검진 데이터 생성이 차단된다
    await c.query(`UPDATE "User" SET "consentedAt" = now() WHERE id = $1`, [ptId]);
  } finally { c.release(); }

  // ── 2) 초대코드로 연결 ────────────────────────────────────────────────────
  console.log("\n[2] 전문가–환자 연결");
  const codeRes = await pro.req("/api/expert/code");
  const code = (await codeRes.json())?.code;
  check("초대코드 발급", !!code, String(code));
  const linkRes = await pt.req("/api/users/link-expert", { method: "POST", body: JSON.stringify({ code }) });
  check("환자가 코드로 연결", linkRes.ok, `HTTP ${linkRes.status}`);

  // ── 3) 검진 세션 시작 ─────────────────────────────────────────────────────
  console.log("\n[3] 검진 시작");
  const convRes = await pro.req("/api/conversations", { method: "POST", body: JSON.stringify({ proxyPatientId: ptId }) });
  const conversationId = (await convRes.json())?.id ?? (await convRes.json())?.conversationId;
  check("대화 생성", !!conversationId, `HTTP ${convRes.status}`);

  const startRes = await pro.req("/api/expert/exam", {
    method: "POST",
    body: JSON.stringify({ action: "start", patientId: ptId, conversationId, patientConsent: true }),
  });
  check("exam start", startRes.ok, `HTTP ${startRes.status}`);

  /**
   * 🔒 2026-10-02 추가 회귀: 인사 **이전**(item_order NULL) 상태의 비인사 턴은 409로 막혀야 한다.
   *   이전에는 일반 대화 경로로 폴스루해 **환자의 RAG 기억 + 최근 대화 50건이 LLM 컨텍스트에
   *   주입**됐다(동의서 §4 위반). 여기서 200이 나오면 그 구멍이 되살아난 것이다.
   */
  const preRes = await pro.req("/api/chat", {
    method: "POST",
    body: JSON.stringify({ conversationId, proxyPatientId: ptId, messages: [{ role: "user", content: "안녕하세요" }] }),
  });
  check("문항 배정 전 비인사 턴 → 409 차단", preRes.status === 409, `HTTP ${preRes.status}`);

  // ── 4) 첫 문항(인사 턴) ───────────────────────────────────────────────────
  console.log("\n[4] 표준 문항 시행");
  const greetRes = await pro.req("/api/chat", {
    method: "POST",
    body: JSON.stringify({ conversationId, proxyPatientId: ptId, isInitialGreeting: true }),
  });
  const greet = await greetRes.json();
  check("첫 문항 수신", greetRes.ok && !!greet?.text, `HTTP ${greetRes.status}`);
  if (greet?.text) console.log(`    Q1: ${String(greet.text).slice(0, 70)}`);

  const c2 = await db.connect();
  let order = [];
  try {
    const r = await c2.query(`SELECT id, item_order, current_item FROM exam_session WHERE patient_user_id = $1 ORDER BY started_at DESC LIMIT 1`, [ptId]);
    var sessionId = r.rows[0]?.id;
    order = JSON.parse(r.rows[0]?.item_order || "[]");
    check("item_order 배정됨", order.length > 0, `${order.length}개 영역`);
  } finally { c2.release(); }

  // ── 5) 답변 전송 ──────────────────────────────────────────────────────────
  //   정답을 모르는 상태에서 채점 정확도를 단정할 수 없으므로, 여기서는
  //   "답변이 채점되어 행이 쌓이는가 + 문항이 진행되는가"를 본다(상태머신 검증).
  const ANSWERS = ["2026년입니다", "오늘은 금요일이에요", "여기는 병원입니다", "나무, 자동차, 모자", "93입니다", "모르겠어요"];
  let lastText = greet?.text ?? "";
  for (let i = 0; i < Math.min(ANSWERS.length, order.length); i++) {
    const res = await pro.req("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId, proxyPatientId: ptId, messages: [{ role: "user", content: ANSWERS[i] }] }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { check(`답변 ${i + 1} 전송`, false, `HTTP ${res.status} ${JSON.stringify(j).slice(0, 80)}`); break; }
    const next = j?.text ?? "";
    check(`답변 ${i + 1} → 다음 응답 수신`, !!next);
    check(`답변 ${i + 1} → 같은 질문 반복 아님`, next !== lastText, next.slice(0, 40));
    lastText = next;
  }

  // ── 6) DB 채점 결과 ───────────────────────────────────────────────────────
  console.log("\n[5] 채점 결과(DB)");
  const c3 = await db.connect();
  try {
    const sc = await c3.query(
      `SELECT domain, item_id, score, max_points, answer FROM exam_item_score WHERE session_id = $1 ORDER BY created_at`,
      [sessionId],
    );
    check("exam_item_score 적재", sc.rows.length > 0, `${sc.rows.length}행`);
    /**
     * 채점 범위: 0 ≤ score ≤ max_points.
     * ⚠ max_points === 0인 행은 **정상이다**(처음엔 결함으로 오판했다).
     *   ac_digitspan 같은 보조 문항은 의도적으로 0점이고(cist-bank.ts:36 "보조 문항 … 참고"),
     *   의사 결과 화면이 `max_points > 0`으로 걸러 채점표에 노출하지 않는다
     *   (app/api/expert/patients/[id]/route.ts:283). 즉 기록은 남기되 점수에는 안 들어간다.
     *   그 필터가 사라지면 결과지에 "0/0"이 뜨므로, 아래에서 필터 자체를 고정한다.
     */
    let aux = 0;
    for (const row of sc.rows) {
      const ok = row.score >= 0 && row.max_points >= 0 && row.score <= row.max_points;
      if (row.max_points === 0) aux++;
      check(`  채점 범위 정상 [${row.domain}] ${row.score}/${row.max_points}${row.max_points === 0 ? " (보조문항)" : ""}`, ok);
    }
    if (aux) console.log(`    · 보조(0점) 문항 ${aux}건 — 결과지에서 필터됨`);
    // 🔒 대리 검진 점수는 **환자 계정**에 귀속돼야 한다 — 전문가 계정에 쌓이면 기록이 뒤섞인다
    const wrong = await c3.query(
      `SELECT COUNT(*)::int n FROM exam_session WHERE id = $1 AND patient_user_id = $2`, [sessionId, ptId]);
    check("세션이 환자에게 귀속", wrong.rows[0].n === 1);

    // 🔒 일상 대화 인지분석(cognitive_assessments)이 검진 턴에서 생기면 안 된다 — 경로 분리
    const ca = await c3.query(
      `SELECT COUNT(*)::int n FROM cognitive_assessments WHERE user_id = $1`, [ptId]);
    check("검진 턴이 일상 인지분석을 만들지 않음", ca.rows[0].n === 0, `${ca.rows[0].n}행`);

    // 🔒 의사 결과 화면이 0점 보조 문항을 걸러내는 계약 — 이게 사라지면 결과지에 "0/0"이 뜬다
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/api/expert/patients/[id]/route.ts", "utf-8");
    check("결과 화면이 0점 보조 문항을 필터", /itemRows\.filter\(\(it\) => it\.max_points > 0\)/.test(src));
  } finally { c3.release(); }

  /**
   * [6] 의사 결과 화면 — **실제 API**로 문답 기록을 확인한다(2026-10-06).
   *
   * 예전엔 이 단계가 소스 grep뿐이라, 문답 기록 출처를 바꾼 코드가 실서버에서 한 번도 돌지 않았다.
   * 그리고 실제 누출 시나리오를 재현한다: 검진 진행 중 환자 대화에 **일상 대화 한 줄**을 끼워 넣고,
   * 그 줄이 문답 기록에 나오지 않아야 한다. 예전 구현(시간 창 안의 모든 메시지)은 이걸 그대로 보여줬다 —
   * 실데이터 대조에서 두 세션에 검진 외 메시지 27건이 실제로 노출돼 있었다.
   */
  console.log("\n[6] 의사 결과 화면(실제 API) — 일상 대화가 문답 기록에 섞이지 않는다");
  const LEAK_MARK = `[e2e] 일상 대화 누출 확인용 ${Date.now()}`;
  const c4 = await db.connect();
  try {
    await c4.query(
      `INSERT INTO "Message" (id, "conversationId", role, content, "createdAt") VALUES ($1, $2, 'user', $3, now())`,
      [`e2e_leak_${Date.now()}`, conversationId, LEAK_MARK]);
    const det = await pro.req(`/api/expert/patients/${ptId}`);
    check("상세 API 200", det.status === 200, `status=${det.status}`);
    const dj = await det.json().catch(() => ({}));
    const ex = (dj.examSessions || []).find((e) => e.id === sessionId);
    check("이번 세션이 결과 화면에 있다", !!ex);
    const qa = ex?.qa || [];
    check("문답 기록이 비어 있지 않다", qa.length > 0, `qa=${qa.length}`);
    // 🔒 핵심: 검진 중에 생긴 일상 대화가 전문가 화면에 나오면 동의서 §4 위반이다
    check("검진 중 일상 대화가 문답 기록에 없다", !qa.some((m) => String(m.content).includes(LEAK_MARK)));
    check("상시 감시 혼잣말이 문답 기록에 없다", !qa.some((m) => String(m.content).startsWith("[관찰]")));
    check("문답이 질문·답 쌍으로 번갈아 나온다", qa.every((m, i) => i === 0 || m.role !== qa[i - 1].role || m.role === "user"));
  } finally {
    await c4.query(`DELETE FROM "Message" WHERE content = $1`, [LEAK_MARK]).catch(() => {});
    c4.release();
  }

  await pro.req("/api/expert/exam", { method: "POST", body: JSON.stringify({ action: "end", sessionId }) }).catch(() => {});
  await db.end();

  console.log(`\n${pass}/${pass + fail} passed${fail ? `, ${fail} FAILED` : ""}`);
  console.log(`계정: pro=${PRO_EMAIL} / 환자=${PATIENT_EMAIL}\n`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.error("\n! 실행 오류:", e.message.split("\n")[0]);
  // ⚠ 중단도 실패다 — e2e-roles.mjs가 턴 0개 실행에도 ✅를 내던 거짓 녹색을 반복하지 않는다.
  process.exitCode = 1;
});
