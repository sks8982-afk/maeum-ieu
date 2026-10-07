import "dotenv/config";
const { Pool } = require("pg");
import { pgTlsOptions } from "../../lib/db-tls";

async function main() {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();
  try {
    const r = await c.query(`
      SELECT
        SUBSTRING("conversationId", 1, 12) AS conv,
        SUM(CASE WHEN content ~ '할아버지' THEN 1 ELSE 0 END) AS grandpa,
        SUM(CASE WHEN content ~ '할머니' THEN 1 ELSE 0 END) AS grandma,
        SUM(CASE WHEN content ~ '엄마' THEN 1 ELSE 0 END) AS mom,
        SUM(CASE WHEN content ~ '아빠' THEN 1 ELSE 0 END) AS dad,
        SUM(CASE WHEN content ~ '회원님' THEN 1 ELSE 0 END) AS member,
        SUM(CASE WHEN content ~ '고객님' THEN 1 ELSE 0 END) AS customer,
        SUM(CASE WHEN content ~ '선생님' THEN 1 ELSE 0 END) AS teacher,
        SUM(CASE WHEN content ~ '어르신' THEN 1 ELSE 0 END) AS elder
      FROM "Message"
      WHERE role = 'assistant'
      GROUP BY "conversationId"
      ORDER BY MAX("createdAt") DESC
      LIMIT 10
    `);
    console.log("=== 대화별 호칭 사용 빈도 (assistant 메시지 기준) ===\n");
    console.log("conv         할아버지 할머니 엄마 아빠 회원님 고객님 선생님 어르신");
    for (const row of r.rows) {
      console.log(
        `${row.conv}  ${String(row.grandpa).padStart(6)}  ${String(row.grandma).padStart(5)}  ${String(row.mom).padStart(3)}  ${String(row.dad).padStart(3)}  ${String(row.member).padStart(5)}  ${String(row.customer).padStart(5)}  ${String(row.teacher).padStart(5)}  ${String(row.elder).padStart(5)}`
      );
    }

    // 한 대화 내 혼용 사례
    const mix = await c.query(`
      SELECT
        SUBSTRING("conversationId", 1, 12) AS conv,
        COUNT(*) AS total
      FROM "Message"
      WHERE role = 'assistant'
        AND (
          (content ~ '할아버지' AND content ~ '할머니') OR
          (content ~ '할아버지' AND content ~ '회원님') OR
          (content ~ '할머니' AND content ~ '회원님') OR
          (content ~ '엄마' AND content ~ '아빠') OR
          (content ~ '엄마' AND content ~ '회원님') OR
          (content ~ '아빠' AND content ~ '회원님')
        )
      GROUP BY "conversationId"
      ORDER BY total DESC
      LIMIT 5
    `);
    console.log("\n=== 한 메시지 내 혼용 발생 ===");
    for (const row of mix.rows) console.log(`  ${row.conv}: ${row.total}건`);

    // 사용자별 현재 설정
    const u = await c.query(`SELECT email, age, gender, "userHonorific", "companionRelation" FROM "User" ORDER BY email`);
    console.log("\n=== User 호칭 설정 ===");
    for (const row of u.rows) {
      console.log(`  ${row.email.padEnd(28)} age=${row.age || '-'} gender=${row.gender || '-'} honorific=${row.userHonorific || '(자동)'} relation=${row.companionRelation || '-'}`);
    }
  } finally {
    c.release(); await pool.end();
  }
}
main().catch(console.error);
