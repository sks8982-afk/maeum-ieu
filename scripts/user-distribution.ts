import "dotenv/config";
import { Pool } from "pg";
import { pgTlsOptions } from "../lib/db-tls";
async function main() {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const client = await pool.connect();
  try {
    const r = await client.query(`
      SELECT
        u.email,
        u.age,
        u.gender,
        u.name,
        COUNT(DISTINCT c.id) AS conv_count,
        COUNT(m.id) FILTER (WHERE m.role='user') AS user_msgs,
        COUNT(m.id) FILTER (WHERE m.role='assistant') AS ai_msgs,
        COUNT(m.id) FILTER (WHERE m.role='user' AND m."isAnomaly"=true) AS anomaly_count,
        MIN(m."createdAt") AS first_msg,
        MAX(m."createdAt") AS last_msg
      FROM "User" u
      LEFT JOIN "Conversation" c ON c."userId"=u.id
      LEFT JOIN "Message" m ON m."conversationId"=c.id
      GROUP BY u.id, u.email, u.age, u.gender, u.name
      HAVING COUNT(m.id) > 0
      ORDER BY user_msgs DESC
    `);
    console.log("=== 사용자별 대화 분포 ===\n");
    console.log("email                          age gen conv  user_msg  ai_msg  anomaly  ratio  last_msg");
    console.log("-".repeat(120));
    for (const row of r.rows) {
      const ratio = row.user_msgs > 0 ? (row.anomaly_count / row.user_msgs * 100).toFixed(1) : "0.0";
      const last = row.last_msg ? new Date(row.last_msg).toISOString().slice(0, 10) : "-";
      console.log(
        `${(row.email || "-").padEnd(30)} ${String(row.age || "-").padEnd(3)} ${(row.gender || "-").padEnd(3)} ${String(row.conv_count).padEnd(5)} ${String(row.user_msgs).padEnd(9)} ${String(row.ai_msgs).padEnd(7)} ${String(row.anomaly_count).padEnd(8)} ${ratio.padEnd(6)} ${last}`
      );
    }

    // 전체 요약
    const total = await client.query(`
      SELECT
        COUNT(DISTINCT c."userId") AS users,
        COUNT(m.id) FILTER (WHERE m.role='user') AS total_user,
        COUNT(m.id) FILTER (WHERE m.role='assistant') AS total_ai,
        COUNT(m.id) FILTER (WHERE m.role='user' AND m."isAnomaly"=true) AS total_anomaly
      FROM "Message" m
      JOIN "Conversation" c ON c.id=m."conversationId"
    `);
    const t = total.rows[0];
    console.log("\n=== 전체 ===");
    console.log(`사용자: ${t.users}명 / user msg: ${t.total_user} / ai msg: ${t.total_ai} / 이상: ${t.total_anomaly} (${(t.total_anomaly/t.total_user*100).toFixed(1)}%)`);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(console.error);
