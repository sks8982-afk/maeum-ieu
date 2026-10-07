/**
 * 적응형 대화 검증용 점수 조회 헬퍼.
 * 사용: node scripts/_check-scores.mjs <email> [limitMessages]
 * 출력: 최근 사용자 메시지 + 그 메시지에 붙은 cognitive_assessments(domain:score),
 *       그리고 전체 도메인 평균(overallAvg) 기반 종합등급 추정.
 */
import pg from "pg";
import { pgTlsOptions } from "./db-tls.mjs";
import "dotenv/config";

const email = process.argv[2];
const LIMIT = Number(process.argv[3] || 20);
if (!email) {
  console.error("usage: node scripts/_check-scores.mjs <email> [limit]");
  process.exit(1);
}

function pgPool() {
  // TLS는 앱과 같은 정책(scripts/db-tls.mjs → lib/db-tls, 2026-10-07 8차) — 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL);
  return new pg.Pool({ connectionString, ...(ssl ? { ssl } : {}) });
}

// severity 임계값(lib/health/severity.ts와 동기): <0.3 정상 / <0.8 경증 / <1.5 중증 / >=1.5 고위험
function tier(avg) {
  if (avg < 0.3) return "🟢 정상";
  if (avg < 0.8) return "🟡 경증";
  if (avg < 1.5) return "🟠 중증";
  return "🔴 고위험";
}

const pool = pgPool();
const c = await pool.connect();
try {
  const u = await c.query(`SELECT id FROM "User" WHERE email=$1`, [email]);
  if (!u.rows[0]) { console.log("no user:", email); process.exit(0); }
  const uid = u.rows[0].id;

  // 최근 사용자 메시지 + assessments
  const rows = await c.query(
    `SELECT m.id, m.role, LEFT(m.content, 70) AS content, m."createdAt",
            COALESCE(json_agg(json_build_object('d', ca.domain, 's', ca.score))
                     FILTER (WHERE ca.domain IS NOT NULL), '[]') AS assess
     FROM "Message" m
     LEFT JOIN cognitive_assessments ca ON ca.message_id = m.id
     WHERE m."conversationId" IN (SELECT id FROM "Conversation" WHERE "userId"=$1)
       AND m.role='user'
     GROUP BY m.id, m.role, m.content, m."createdAt"
     ORDER BY m."createdAt" DESC
     LIMIT $2`,
    [uid, LIMIT]
  );

  console.log(`\n=== ${email} (uid=${uid}) 최근 ${rows.rows.length}개 사용자 발화 ===`);
  for (const r of rows.rows.reverse()) {
    const a = r.assess.map((x) => `${x.d}:${x.s}`).join(" ") || "(분석없음)";
    const t = new Date(r.createdAt).toLocaleTimeString("ko-KR");
    console.log(`[${t}] "${r.content}"  → ${a}`);
  }

  // 전체 평균(종합등급 추정) — 모든 assessment score 평균
  const avg = await c.query(
    `SELECT AVG(ca.score)::float AS avg, COUNT(*) AS n
     FROM cognitive_assessments ca
     JOIN "Message" m ON ca.message_id = m.id
     WHERE m."conversationId" IN (SELECT id FROM "Conversation" WHERE "userId"=$1)`,
    [uid]
  );
  const a = avg.rows[0].avg ?? -1;
  console.log(`\n전체 assessment ${avg.rows[0].n}건, overallAvg=${a == null ? "N/A" : a.toFixed(3)} → ${a < 0 ? "평가전" : tier(a)}`);
} finally {
  c.release();
  await pool.end();
}
