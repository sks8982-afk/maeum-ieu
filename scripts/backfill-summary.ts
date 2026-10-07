/**
 * 누적 메시지에서 계층적 요약본 backfill.
 *
 * 알고리즘:
 *   1. 사용자별 메시지를 주 단위(월요일~일요일)로 그룹화
 *   2. 각 주마다 weekly 요약 1개 생성
 *   3. weekly 4개 모이면 monthly 1개로 rollup
 *   4. monthly 12개 모이면 yearly 1개로 rollup
 *
 * 사용: npx tsx scripts/backfill-summary.ts [email?]
 */
import "dotenv/config";
import { summarizeMessages, rollupSummaries } from "../lib/chat/summarizer";
import { Pool } from "pg";
import { pgTlsOptions } from "../lib/db-tls";
/** 주의 시작(월요일 0시 KST) 반환 */
function weekStart(d: Date): Date {
  const local = new Date(d);
  local.setHours(0, 0, 0, 0);
  const day = local.getDay(); // 0=일, 1=월
  const diff = day === 0 ? -6 : 1 - day;
  local.setDate(local.getDate() + diff);
  return local;
}

async function main() {
  const emailFilter = process.argv[2];

  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();

  try {
    const users = emailFilter
      ? await c.query(`SELECT id, email FROM "User" WHERE email = $1`, [emailFilter])
      : await c.query(`SELECT id, email FROM "User"`);

    console.log(`Processing ${users.rows.length} users (hierarchical weekly→monthly→yearly)...`);

    for (const u of users.rows) {
      const convs = await c.query(`SELECT id FROM "Conversation" WHERE "userId" = $1`, [u.id]);
      let weeklyCount = 0, monthlyCount = 0, yearlyCount = 0;

      for (const cv of convs.rows) {
        const msgs = await c.query(`
          SELECT id, role, content, "createdAt"
          FROM "Message"
          WHERE "conversationId" = $1
          ORDER BY "createdAt" ASC
        `, [cv.id]);

        if (msgs.rows.length < 20) continue; // 너무 짧은 대화는 요약 X

        // 주 단위 그룹
        const weekBuckets = new Map<string, typeof msgs.rows>();
        for (const m of msgs.rows) {
          const key = weekStart(m.createdAt).toISOString();
          if (!weekBuckets.has(key)) weekBuckets.set(key, []);
          weekBuckets.get(key)!.push(m);
        }

        // 각 주별 요약
        const sortedKeys = Array.from(weekBuckets.keys()).sort();
        for (const key of sortedKeys) {
          const batch = weekBuckets.get(key)!;
          if (batch.length < 10) continue; // 한 주에 10턴 미만이면 skip
          const r = await summarizeMessages({ userId: u.id, conversationId: cv.id, messages: batch, level: "weekly" });
          if (r) weeklyCount++;
        }

        // rollup: weekly 4 → monthly
        for (let i = 0; i < 10; i++) {
          const r = await rollupSummaries({ userId: u.id, conversationId: cv.id, childLevel: "weekly" });
          if (!r) break;
          monthlyCount++;
        }
        // rollup: monthly 12 → yearly
        for (let i = 0; i < 3; i++) {
          const r = await rollupSummaries({ userId: u.id, conversationId: cv.id, childLevel: "monthly" });
          if (!r) break;
          yearlyCount++;
        }
      }
      console.log(`  ${u.email}: weekly=${weeklyCount}, monthly=${monthlyCount}, yearly=${yearlyCount}`);
    }

    const sum = await c.query(`
      SELECT u.email, cs.level, COUNT(cs.id) AS cnt, SUM(cs.message_count) AS msgs
      FROM "User" u JOIN conversation_summary cs ON cs.user_id = u.id
      GROUP BY u.email, cs.level ORDER BY u.email, cs.level
    `);
    console.log("\n=== Final summary counts ===");
    for (const r of sum.rows) console.log(`  ${r.email} [${r.level}]: ${r.cnt}건 (${r.msgs} msgs compressed)`);
  } finally { c.release(); await pool.end(); }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
