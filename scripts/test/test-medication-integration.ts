/**
 * 복약 알림 API 통합 검증.
 * - POST 생성 → GET 조회 → PUT 수정 → 시간 조작으로 due 만들기 → /check 발견 → /trigger 발화 → /check 중복 차단 → DELETE
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

async function jsonFetch(cookie: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { ok: r.ok, status: r.status, body: parsed };
}

function nowKstHHMM(): string {
  const d = new Date(Date.now() + 9 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

async function rawUpdateLastTriggered(scheduleId: string, value: string | null) {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();
  try {
    if (value === null) {
      await c.query(`UPDATE "MedicationSchedule" SET "lastTriggeredAt" = NULL WHERE id = $1`, [scheduleId]);
    } else {
      await c.query(`UPDATE "MedicationSchedule" SET "lastTriggeredAt" = $1 WHERE id = $2`, [value, scheduleId]);
    }
  } finally { c.release(); await pool.end(); }
}

async function main() {
  let pass = 0, fail = 0;
  function assert(cond: boolean, label: string, ctx?: unknown) {
    if (cond) { console.log(`✓ ${label}`); pass++; }
    else { console.log(`✗ ${label}`); if (ctx) console.log("  ctx:", JSON.stringify(ctx)); fail++; }
  }

  const cookie = await getCookie();

  // 1) 생성 — 현재 시각의 분에 맞춰 due 발생 만들기
  const nowSlot = nowKstHHMM();
  const c1 = await jsonFetch(cookie, "POST", "/api/medications", {
    label: "통합테스트 약",
    times: [nowSlot],
  });
  assert(c1.ok && c1.status === 201, "POST 스케줄 생성 성공", c1);
  const created = c1.body as { id?: string; label?: string; times?: string[]; enabled?: boolean };
  assert(typeof created.id === "string", "id 반환");
  assert(Array.isArray(created.times) && created.times.includes(nowSlot), "times 저장 확인");

  const scheduleId = created.id!;

  // 2) GET 조회
  const g1 = await jsonFetch(cookie, "GET", "/api/medications");
  const items = (g1.body as { items?: Array<{ id: string }> }).items ?? [];
  assert(items.some((x) => x.id === scheduleId), "GET 목록에 새 스케줄 포함");

  // 3) PUT 수정 — 라벨 변경
  const u1 = await jsonFetch(cookie, "PUT", `/api/medications/${scheduleId}`, { label: "통합테스트 약(수정)" });
  assert(u1.ok, "PUT 수정 성공");
  assert((u1.body as { label?: string }).label === "통합테스트 약(수정)", "라벨 변경 반영");

  // 4) 잘못된 입력 거부
  const inv = await jsonFetch(cookie, "POST", "/api/medications", { label: "", times: [] });
  assert(!inv.ok && inv.status === 400, "빈 label 400 거부");

  // 5) /check — lastTriggeredAt null이면 due
  await rawUpdateLastTriggered(scheduleId, null);
  const ch1 = await jsonFetch(cookie, "GET", "/api/medications/check");
  const due1 = (ch1.body as { due?: Array<{ scheduleId: string }> }).due ?? [];
  assert(due1.some((d) => d.scheduleId === scheduleId), "/check에서 due 발견", { due1 });

  // 6) /trigger — 알림 발화 + DB 저장
  const tr = await jsonFetch(cookie, "POST", "/api/medications/trigger", { scheduleId, conversationId: CONV_ID });
  assert(tr.ok, "/trigger 성공", tr);
  const trBody = tr.body as { text?: string; slotTime?: string; skipped?: boolean };
  assert(typeof trBody.text === "string" && trBody.text!.includes("통합테스트"), "trigger 응답에 멘트 포함", trBody);

  // 7) 중복 호출 — lastTriggeredAt 갱신됐으므로 skipped
  const tr2 = await jsonFetch(cookie, "POST", "/api/medications/trigger", { scheduleId, conversationId: CONV_ID });
  assert((tr2.body as { skipped?: boolean }).skipped === true, "중복 trigger 호출 skip");

  // 8) /check 재호출 — due 비어있어야 함
  const ch2 = await jsonFetch(cookie, "GET", "/api/medications/check");
  const due2 = (ch2.body as { due?: Array<{ scheduleId: string }> }).due ?? [];
  assert(!due2.some((d) => d.scheduleId === scheduleId), "trigger 후 /check에서 사라짐");

  // 9) DELETE
  const del = await jsonFetch(cookie, "DELETE", `/api/medications/${scheduleId}`);
  assert(del.ok, "DELETE 성공");

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
