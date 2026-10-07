/** abc 계정 DB 잔여 데이터에서 "재미" 누수 출처 추적 */
import "dotenv/config";
const { Pool } = require("pg");
import { pgTlsOptions } from "../../lib/db-tls";

async function main() {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();
  try {
    const u = await c.query(`SELECT id, email, name FROM "User" WHERE email = 'abc@abc.com'`);
    const uid = u.rows[0].id;
    console.log(`abc user.id = ${uid}`);

    const fam = await c.query(`SELECT id, relation, name, updated_at FROM family_member WHERE user_id = $1`, [uid]);
    console.log(`\n[family_member] ${fam.rowCount} rows:`);
    for (const r of fam.rows) console.log(`  id=${r.id} relation=${r.relation} name=${r.name} updated=${r.updated_at}`);

    const fact = await c.query(`SELECT key, value, updated_at FROM user_fact WHERE user_id = $1`, [uid]);
    console.log(`\n[user_fact] ${fact.rowCount} rows:`);
    for (const r of fact.rows) console.log(`  ${r.key} = ${r.value} (updated ${r.updated_at})`);

    // conversation_summary actual columns
    const cols = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='conversation_summary'`);
    console.log(`\n[conversation_summary columns] ${cols.rows.map(r => r.column_name).join(", ")}`);

    const sum = await c.query(`SELECT * FROM conversation_summary WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [uid]);
    console.log(`\n[conversation_summary] ${sum.rowCount} rows:`);
    for (const r of sum.rows) {
      const txt = r.summary || r.content || r.text || "";
      const hasJaemi = txt.includes("재미");
      const flag = hasJaemi ? "🔴" : "  ";
      console.log(`  ${flag} ${r.level || "?"} created=${r.created_at?.toISOString?.()?.slice(0,16)}`);
      if (hasJaemi) {
        const idx = txt.indexOf("재미");
        console.log(`     "${txt.slice(Math.max(0,idx-40), idx+50)}"`);
      }
    }

    // Message scan
    try {
      const m = await c.query(`SELECT id, role, LEFT("content", 80) AS snippet, "createdAt" FROM "Message" WHERE "userId" = $1 AND "content" ILIKE '%재미%' ORDER BY "createdAt" DESC LIMIT 10`, [uid]);
      console.log(`\n[Message: "재미"] ${m.rowCount} rows:`);
      for (const r of m.rows) console.log(`  ${r.createdAt?.toISOString?.()?.slice(0,16)} [${r.role}] ${r.snippet}`);
    } catch (e: any) {
      // Try lowercase
      const m2 = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='Message' OR table_name='messages' ORDER BY table_name`);
      console.log(`\nMessage table cols: ${m2.rows.map(r => r.column_name).join(", ")}`);
    }
  } finally { c.release(); await pool.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
