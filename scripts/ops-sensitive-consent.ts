/**
 * 민감정보 별도 동의 테이블(sensitive_consent) 생성 + 별도 동의 없이 남은 성문·상시 감시 기록 점검/파기.
 * ⚠️ prisma db push 금지 — 수동 SQL. 멱등.
 *
 *   npx tsx scripts/ops-sensitive-consent.ts           → 테이블 생성(멱등) + 점검 보고(아무것도 지우지 않음)
 *   npx tsx scripts/ops-sensitive-consent.ts --purge   → 위 + 별도 동의 없는 성문·상시 감시 기록 파기
 *
 * ⚠ 배포 순서: 테이블 생성은 **코드 배포 전**에 한다. 테이블이 없으면 코드는 "동의 없음"으로 보고
 *   목소리 등록·상시 감시를 막는다(lib/sensitive-consent.ts) — 기능이 멈출 뿐 동의 없이 처리하지는 않는다.
 *
 * 왜 파기하나 (2026-10-06): 개인정보처리방침에 "성문은 별도 동의를 받아서만 보관", "위급 신호가 없는
 *   상시 감시 말은 저장하지 않음"이라고 고지한다. 그 이전에 별도 동의 없이 만들어진 기록이 남아 있으면
 *   고지가 사실이 아니게 된다. 파기 대상:
 *   · 성문(대표·표본) — 유효한 목소리 등록 동의가 없는 사용자
 *   · 상시 감시 기록("[관찰]" Message) — 위급 신호가 없는 것 전부 + 상시 감시 동의(처리·제공)가 없는 사용자의 것
 */
import "dotenv/config";
import { Pool } from "pg";

const PURGE = process.argv.includes("--purge");

/** 유효 동의 = 철회 안 됨. (버전 비교는 앱이 한다 — 여기선 "한 번도 동의 안 한 기록"을 찾는 게 목적) */
const NO_CONSENT = (kind: string) =>
  `NOT IN (SELECT user_id FROM sensitive_consent WHERE kind = '${kind}' AND withdrawn_at IS NULL)`;

const mask = (email: string) => {
  const [local, domain] = email.split("@");
  return `${(local ?? "").slice(0, 2)}***@${domain ?? "?"}`;
};

async function main() {
  let connStr = process.env.DATABASE_URL!;
  try { const u = new URL(connStr); u.searchParams.set("sslmode", "no-verify"); connStr = u.toString(); } catch { /* noop */ }
  const pool = new Pool({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS sensitive_consent (
        user_id      TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
        kind         TEXT NOT NULL,                 -- voiceprint | observe | observe_share
        version      TEXT NOT NULL,                 -- 동의한 문안 버전(lib/sensitive-consent.ts)
        consented_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        withdrawn_at TIMESTAMPTZ,                   -- 철회 시각(null=유효)
        PRIMARY KEY (user_id, kind)
      )`);
    console.log("✓ sensitive_consent 테이블 확인(멱등 생성)");

    // ── 점검 보고 — 개인 식별을 줄이려고 이메일은 가린다 ──
    const vp = await client.query<{ user_id: string; email: string; mode: string; samples: string }>(`
      SELECT v.user_id, u.email, u."screeningMode" AS mode,
             (SELECT count(*) FROM speaker_voiceprint_sample s WHERE s.user_id = v.user_id) AS samples
        FROM speaker_voiceprint v JOIN "User" u ON u.id = v.user_id
       WHERE v.user_id ${NO_CONSENT("voiceprint")}`);
    console.log(`\n[성문] 별도 동의 없는 등록 ${vp.rowCount}명`);
    for (const r of vp.rows) console.log(`  - ${r.user_id.slice(0, 8)}… ${mask(r.email)} (${r.mode}) 표본 ${r.samples}`);

    const obs = await client.query<{ user_id: string; email: string; mode: string; total: string; emergency: string; first: Date; last: Date }>(`
      SELECT c."userId" AS user_id, u.email, u."screeningMode" AS mode,
             count(*) AS total,
             count(*) FILTER (WHERE COALESCE(m."emergencyLevel", 0) > 0) AS emergency,
             min(m."createdAt") AS first, max(m."createdAt") AS last
        FROM "Message" m
        JOIN "Conversation" c ON c.id = m."conversationId"
        JOIN "User" u ON u.id = c."userId"
       WHERE m.content LIKE '[관찰]%'
       GROUP BY c."userId", u.email, u."screeningMode"
       ORDER BY total DESC`);
    console.log(`\n[상시 감시 기록] 사용자 ${obs.rowCount}명`);
    for (const r of obs.rows) {
      console.log(`  - ${r.user_id.slice(0, 8)}… ${mask(r.email)} (${r.mode}) 전체 ${r.total} · 위급 ${r.emergency} · ${r.first.toISOString().slice(0, 10)}~${r.last.toISOString().slice(0, 10)}`);
    }

    if (!PURGE) {
      console.log("\n(점검만 했다 — 파기하려면 --purge)");
      return;
    }

    await client.query("BEGIN");
    const s1 = await client.query(`DELETE FROM speaker_voiceprint_sample WHERE user_id ${NO_CONSENT("voiceprint")}`);
    const s2 = await client.query(`DELETE FROM speaker_voiceprint WHERE user_id ${NO_CONSENT("voiceprint")}`);
    const s3 = await client.query(`
      DELETE FROM "Message" m USING "Conversation" c
       WHERE m."conversationId" = c.id AND m.content LIKE '[관찰]%'
         AND (COALESCE(m."emergencyLevel", 0) = 0
              OR c."userId" ${NO_CONSENT("observe")}
              OR c."userId" ${NO_CONSENT("observe_share")})`);
    await client.query("COMMIT");
    console.log(`\n✓ 파기: 성문 표본 ${s1.rowCount} · 대표 ${s2.rowCount} · 상시 감시 기록 ${s3.rowCount}`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
