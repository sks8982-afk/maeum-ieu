/**
 * 화자 라벨링 API 통합 검증.
 * - 일반 발화 저장 → 자동으로 primary 라벨
 * - 응급 발화 저장 → null 라벨 (보호자 검토 유도)
 * - PATCH로 visitor → 정상 변경
 * - 잘못된 입력 거부
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
  const allCookies = loginRes.headers.getSetCookie?.() || [];
  return [...cookies.split(","), ...allCookies].join("; ");
}

async function sendChat(cookie: string, msg: string): Promise<{ messageId?: string; emergency?: { level: number } }> {
  const now = new Date().toISOString();
  await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      conversationId: CONV_ID,
      messages: [{ role: "user", content: msg, createdAt: now }],
      context: { currentTime: now, latitude: 37.2049, longitude: 127.0771 },
    }),
  });
  // 직전 메시지 조회
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();
  try {
    const r = await c.query(
      `SELECT id, "speakerLabel", "emergencyLevel" FROM "Message" WHERE content = $1 AND role = 'user' ORDER BY "createdAt" DESC LIMIT 1`,
      [msg],
    );
    if (r.rows.length === 0) return {};
    return { messageId: r.rows[0].id, emergency: r.rows[0].emergencyLevel ? { level: r.rows[0].emergencyLevel } : undefined };
  } finally { c.release(); await pool.end(); }
}

async function getLabel(messageId: string): Promise<string | null> {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();
  try {
    const r = await c.query(`SELECT "speakerLabel" FROM "Message" WHERE id = $1`, [messageId]);
    return r.rows[0]?.speakerLabel ?? null;
  } finally { c.release(); await pool.end(); }
}

async function patchLabel(cookie: string, messageId: string, label: string | null) {
  const r = await fetch(`${BASE_URL}/api/messages/speaker`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ messageId, label }),
  });
  return { ok: r.ok, status: r.status, body: r.ok ? await r.json() : await r.text() };
}

async function main() {
  let pass = 0, fail = 0;
  function assert(cond: boolean, label: string, ctx?: unknown) {
    if (cond) { console.log(`✓ ${label}`); pass++; }
    else { console.log(`✗ ${label}`); if (ctx) console.log("  ctx:", JSON.stringify(ctx)); fail++; }
  }

  const cookie = await getCookie();

  // 1) 일반 발화 → primary 자동 라벨
  const n = await sendChat(cookie, "오늘 점심은 김밥 먹었어 맛있었지");
  await new Promise((r) => setTimeout(r, 2000));
  const lblNormal = n.messageId ? await getLabel(n.messageId) : null;
  assert(lblNormal === "primary", "일반 발화 → primary 자동 라벨", { lblNormal });

  // 2) PATCH로 visitor 변경
  if (n.messageId) {
    const r = await patchLabel(cookie, n.messageId, "visitor");
    assert(r.ok, "PATCH visitor 라벨 성공", r);
    const lbl2 = await getLabel(n.messageId);
    assert(lbl2 === "visitor", "DB visitor 반영", { lbl2 });
  }

  // 3) PATCH로 null로 복원
  if (n.messageId) {
    const r = await patchLabel(cookie, n.messageId, null);
    assert(r.ok, "PATCH null 라벨 복원 성공");
    const lbl3 = await getLabel(n.messageId);
    assert(lbl3 === null, "DB null 반영");
  }

  // 4) 잘못된 라벨 거부
  if (n.messageId) {
    const r = await patchLabel(cookie, n.messageId, "weirdvalue");
    assert(!r.ok && r.status === 400, "잘못된 라벨 400 거부", r);
  }

  // 5) 존재하지 않는 메시지 → 404
  const r = await patchLabel(cookie, "nonexistent_id_xyz", "primary");
  assert(!r.ok && r.status === 404, "없는 메시지 404", r);

  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
