/**
 * 과거 FP(false positive) 수정 스크립트
 * "반복/직전 발화" 판정만으로 isAnomaly=true 된 메시지를 false로 되돌림
 * 단, 시간/장소/판단력 등 실질 이상 포함된 것은 그대로 둠
 */
import "dotenv/config";
const { Pool } = require("pg");
import { pgTlsOptions } from "../../lib/db-tls";

const FP_PATTERNS = [
  /직전 발화와 동일/,
  /직전 턴에서 말한 내용과 동일/,
  /직전 턴에 (?:본인이|자신이) 말했던 문장/,
  /이전 발화를 (?:정확히|그대로|즉시) 반복/,
  /동일한 (?:문장|내용|발화|질문)을 (?:즉시 |다시 )?반복/,
  /직전 발화를 AI 응답 직후 즉시 반복/,
  /AI의 (?:직전 )?질문에 (?:직접적으로 |지속적으로 )?(?:답|응답)(?:하|변하)지 않고/,
  /대화 (?:흐름을|주제를) (?:벗어|전환)/,
  /관련 없는.*발화/,
  /질문에 대한 주의력 부족/,
  /주의 집중.*저하/,
  /대화의 흐름을 유지하거나 질문에 집중/,
  /질문과 무관한/,
  /직전 턴에 했던 발화를 이번 턴에 즉시 반복/,
  /직전 턴에 자신이 말했던/,
  /AI의 (?:직전 )?답변 내용을 기억하지 못하고 동일한 질문/,
  /직전 턴에 했던 발화를 AI의 응답 직후에 다시 반복/,
  /AI의 응답 직후 사용자가 동일한 발화를 즉시 반복/,
  /이미 한 질문을 다시 반복/,
  /주의 집중 및 적절한 응답 능력이 저하/,
];

const REAL_ANOMALY_PATTERNS = [
  /년도를 \d{4}년으로/,
  /실제 위치|장소 지남력|다른 장소/,
  /이미 사망|비현실적 경험|외계인|공룡|도깨비|UFO/,
  /계절|시간 지남력|판단력/,
  /과거의 사건을 현재/,
  /현실 판단력에 심각/,
  /가족 관계.*오인|손녀.*둘째딸/,
  /나이와 맞지 않게|초등학교 입학/,
];

async function main() {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const client = await pool.connect();

  try {
    const r = await client.query(`
      SELECT id, content, "analysisNote"
      FROM "Message"
      WHERE role = 'user'
        AND "isAnomaly" = true
        AND "analysisNote" IS NOT NULL
    `);

    let reset = 0;
    let kept = 0;
    for (const row of r.rows) {
      const note = row.analysisNote || "";
      const hasFP = FP_PATTERNS.some((p) => p.test(note));
      const hasReal = REAL_ANOMALY_PATTERNS.some((p) => p.test(note));

      if (hasFP && !hasReal) {
        await client.query(
          `UPDATE "Message" SET "isAnomaly" = false, "analysisNote" = NULL WHERE id = $1`,
          [row.id]
        );
        reset++;
        console.log(`  RESET: "${row.content.slice(0, 60)}"`);
      } else {
        kept++;
      }
    }

    console.log(`\n총 ${r.rows.length}건 검토`);
    console.log(`  → FP 초기화: ${reset}건`);
    console.log(`  → 실제 이상 유지: ${kept}건`);

    // cognitive_assessments 테이블의 memory_immediate 점수도 정리
    const cog = await client.query(`
      DELETE FROM cognitive_assessments
      WHERE domain = 'memory_immediate'
        AND score >= 1
        AND note ~ '반복|직전 발화|동일한 문장'
      RETURNING id
    `);
    console.log(`  → cognitive_assessments memory_immediate 이상 기록 삭제: ${cog.rowCount}건`);
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch(console.error);
