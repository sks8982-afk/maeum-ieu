/**
 * 두 가지 문맥 인식 오류 케이스 탐색:
 * 1) 이름 응답을 일반 단어로 오인 (예: "재미" → "재미있으시다니")
 * 2) AI가 직전 응답을 다음 턴에서 다시 통째로 반복
 */
import "dotenv/config";
const { Pool } = require("pg");
import { pgTlsOptions } from "../../lib/db-tls";

async function main() {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();
  try {
    // 1) 이름 케이스: 사용자 "재미" + AI "재미있"
    console.log("=== 케이스 1: 이름 답변 오인 ===\n");
    const r1 = await c.query(`
      SELECT m1.id AS u_id, m1."conversationId" AS conv, m1.content AS user_msg, m1."createdAt" AS u_t,
             m2.content AS ai_msg, m2."createdAt" AS a_t
      FROM "Message" m1
      JOIN "Message" m2 ON m2."conversationId" = m1."conversationId"
        AND m2.role = 'assistant'
        AND m2."createdAt" > m1."createdAt"
        AND m2."createdAt" < m1."createdAt" + interval '60 seconds'
      WHERE m1.role = 'user' AND m1.content ~ '^\\s*재미\\s*$'
      ORDER BY m1."createdAt" DESC LIMIT 5
    `);
    for (const row of r1.rows) {
      console.log(`conv: ${row.conv.slice(0,20)}`);
      console.log(`  user: "${row.user_msg}"`);
      console.log(`  ai:   "${row.ai_msg.slice(0, 200)}"`);
      console.log();
    }

    // 1b) 더 일반화: AI가 "큰아들 이름" 등을 묻고 다음 user 답변이 짧으면 이름일 가능성
    console.log("=== 케이스 1b: 이름 묻는 AI 응답 직후 짧은 user 답변 ===\n");
    const r1b = await c.query(`
      WITH ai_name_ask AS (
        SELECT id, "conversationId" AS conv, content, "createdAt" AS t
        FROM "Message"
        WHERE role = 'assistant' AND content ~ '이름이? 어떻게|성함이? 어떻게|이름이 뭐|성함이 뭐'
      )
      SELECT a.conv,
             a.content AS ai_ask,
             u.content AS user_reply,
             ai2.content AS ai_next
      FROM ai_name_ask a
      JOIN "Message" u ON u."conversationId" = a.conv
        AND u.role = 'user'
        AND u."createdAt" > a.t AND u."createdAt" < a.t + interval '90 seconds'
      JOIN "Message" ai2 ON ai2."conversationId" = a.conv
        AND ai2.role = 'assistant'
        AND ai2."createdAt" > u."createdAt" AND ai2."createdAt" < u."createdAt" + interval '60 seconds'
      ORDER BY a.t DESC LIMIT 5
    `);
    for (const row of r1b.rows) {
      console.log(`conv: ${row.conv.slice(0,20)}`);
      console.log(`  AI ask:  "${row.ai_ask.slice(0, 120)}"`);
      console.log(`  user:    "${row.user_reply.slice(0, 60)}"`);
      console.log(`  AI next: "${row.ai_next.slice(0, 200)}"`);
      console.log();
    }

    // 2) AI 응답 반복 케이스: 직전 AI 응답과 동일한 첫 문장이 다음 AI 응답에도 등장
    console.log("=== 케이스 2: AI 응답이 다음 턴에서 반복 ===\n");
    const r2 = await c.query(`
      SELECT m.content, m."createdAt", m."conversationId" AS conv
      FROM "Message" m
      WHERE m.role = 'assistant' AND m.content ~ '바나나' AND m."createdAt" > now() - interval '14 days'
      ORDER BY m."createdAt" DESC LIMIT 10
    `);
    for (const row of r2.rows) {
      console.log(`${row.conv.slice(0,16)} ${new Date(row.createdAt).toISOString().slice(11,19)}: "${row.content.slice(0, 200)}"`);
    }
  } finally {
    c.release(); await pool.end();
  }
}
main().catch(console.error);
