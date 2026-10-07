/** abc 계정에서 "재미" 누수 출처 추적 — Message, conversation_summary, embeddings 모두 검색 */
import "dotenv/config";
const { Pool } = require("pg");
import { pgTlsOptions } from "../../lib/db-tls";

async function main() {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();
  try {
    const u = await c.query(`SELECT id FROM "User" WHERE email = 'abc@abc.com'`);
    const uid = u.rows[0].id;
    console.log(`abc user.id = ${uid}\n`);

    // 1) Message scan
    try {
      const m = await c.query(
        `SELECT m.id, m.role, m."conversationId", LEFT(m.content, 100) AS snippet, m."createdAt"
         FROM "Message" m JOIN "Conversation" c ON m."conversationId" = c.id
         WHERE c."userId" = $1 AND m.content ILIKE '%재미%'
         ORDER BY m."createdAt" DESC LIMIT 20`, [uid]);
      console.log(`[Message] ${m.rowCount} rows containing "재미":`);
      for (const r of m.rows) console.log(`  ${r.createdAt.toISOString().slice(0,16)} [${r.role}] conv=${r.conversationId.slice(0,12)} ${r.snippet}`);
    } catch (e: any) { console.log("Message scan err:", e.message); }

    // 2) conversation_summary scan
    try {
      const cols = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='conversation_summary' ORDER BY ordinal_position`);
      console.log(`\n[conversation_summary cols] ${cols.rows.map(r => r.column_name).join(", ")}`);
      const s = await c.query(`SELECT * FROM conversation_summary WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`, [uid]);
      console.log(`\n[conversation_summary] ${s.rowCount} rows:`);
      for (const r of s.rows) {
        const text = JSON.stringify(r);
        if (text.includes("재미")) {
          console.log(`  🔴 ${JSON.stringify(r).slice(0, 200)}...`);
        } else {
          console.log(`  ${r.level || "?"} created=${r.created_at?.toISOString?.()?.slice(0,16)} (no leak)`);
        }
      }
    } catch (e: any) { console.log("summary err:", e.message); }

    // 3) embeddings scan (RAG)
    try {
      const cols = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name LIKE '%embed%' ORDER BY ordinal_position`);
      console.log(`\n[embedding tables cols] ${cols.rows.map(r => r.column_name).join(", ")}`);
      const tables = await c.query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE '%embed%'`);
      console.log(`[embedding tables] ${tables.rows.map(r => r.table_name).join(", ")}`);
      for (const t of tables.rows) {
        const tname = t.table_name;
        try {
          const e = await c.query(`SELECT id, LEFT(content_text, 100) AS snippet FROM "${tname}" WHERE user_id = $1 AND content_text ILIKE '%재미%' LIMIT 10`, [uid]);
          console.log(`  [${tname}] ${e.rowCount} hits`);
          for (const r of e.rows) console.log(`    ${r.snippet}`);
        } catch (err: any) {
          // try different column name
          try {
            const e2 = await c.query(`SELECT id, LEFT(text, 100) AS snippet FROM "${tname}" WHERE user_id = $1 AND text ILIKE '%재미%' LIMIT 10`, [uid]);
            console.log(`  [${tname}/text] ${e2.rowCount} hits`);
          } catch {}
        }
      }
    } catch (e: any) { console.log("embed err:", e.message); }

    // 4) user_fact / user_profile scan
    try {
      const f = await c.query(`SELECT * FROM user_fact WHERE user_id = $1`, [uid]);
      console.log(`\n[user_fact] ${f.rowCount}:`);
      for (const r of f.rows) {
        const t = JSON.stringify(r);
        if (t.includes("재미")) console.log(`  🔴 ${t.slice(0, 200)}`);
        else console.log(`  ${t.slice(0, 80)}`);
      }
      const p = await c.query(`SELECT * FROM user_profile WHERE user_id = $1`, [uid]);
      console.log(`\n[user_profile] ${p.rowCount}:`);
      for (const r of p.rows) {
        const t = JSON.stringify(r);
        if (t.includes("재미")) console.log(`  🔴 ${t.slice(0, 300)}`);
        else console.log(`  notes=${r.notes} health=${r.health_notes} (clean)`);
      }
    } catch (e: any) { console.log("fact/profile err:", e.message); }
  } finally { c.release(); await pool.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
