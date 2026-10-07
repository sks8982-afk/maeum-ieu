import "dotenv/config";
const { Pool } = require("pg");
import { pgTlsOptions } from "../../lib/db-tls";

(async () => {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();
  try {
    // 최근 80분 사용자 발화 (Playwright 100턴 + 사이클간 약간의 마진)
    const r1 = await c.query(`
      SELECT id, content, "isAnomaly", "analysisNote", "emergencyLevel", "emergencyEvidence",
             "speakerLabel", "notifiedAt",
             to_char("createdAt" AT TIME ZONE 'Asia/Seoul','HH24:MI:SS') AS t
      FROM "Message"
      WHERE role='user' AND "createdAt" >= NOW() - INTERVAL '80 minutes'
      ORDER BY "createdAt" ASC
    `);
    // 카운트 집계
    const total = r1.rows.length;
    const anomalyCount = r1.rows.filter((m: any) => m.isAnomaly).length;
    const emergCounts: Record<number, number> = {};
    let notifiedCount = 0;
    let modFalsePos = 0;
    let primaryLabelCount = 0;
    for (const m of r1.rows) {
      if (m.emergencyLevel) emergCounts[m.emergencyLevel] = (emergCounts[m.emergencyLevel] || 0) + 1;
      if (m.notifiedAt) notifiedCount++;
      if (m.speakerLabel === "primary") primaryLabelCount++;
    }
    console.log(`=== 100턴 사이클 요약 ===`);
    console.log(`총 사용자 메시지: ${total}`);
    console.log(`anomaly 마킹: ${anomalyCount}건`);
    console.log(`emergencyLevel 분포: ${JSON.stringify(emergCounts)}`);
    console.log(`보호자 알림 발송: ${notifiedCount}건`);
    console.log(`speakerLabel=primary 자동 부여: ${primaryLabelCount}/${total}`);

    console.log(`\n=== 이상/응급 마킹된 메시지 ===`);
    for (const m of r1.rows) {
      if (!m.isAnomaly && !m.emergencyLevel) continue;
      const flags = [
        m.isAnomaly ? "🔴이상" : "",
        m.emergencyLevel ? "🚨L" + m.emergencyLevel : "",
      ].filter(Boolean).join(" ");
      console.log(`${m.t} ${flags} ${m.content.slice(0, 70)}`);
      if (m.analysisNote) console.log(`  → ${m.analysisNote.slice(0, 130)}`);
      if (m.emergencyEvidence) console.log(`  → ${m.emergencyEvidence.slice(0, 80)}`);
    }

    // cognitive_assessments
    const r2 = await c.query(`
      SELECT domain, score, evidence,
             to_char(created_at AT TIME ZONE 'Asia/Seoul','HH24:MI:SS') AS t
      FROM cognitive_assessments
      WHERE created_at >= NOW() - INTERVAL '80 minutes'
      ORDER BY created_at ASC
    `);
    // 도메인별 score 분포
    const domainStats: Record<string, { c: number; high: number }> = {};
    for (const a of r2.rows) {
      if (!domainStats[a.domain]) domainStats[a.domain] = { c: 0, high: 0 };
      domainStats[a.domain].c++;
      if (a.score >= 2) domainStats[a.domain].high++;
    }
    console.log(`\n=== cognitive_assessments 도메인별 통계 (총 ${r2.rows.length}건) ===`);
    for (const [domain, st] of Object.entries(domainStats)) {
      console.log(`  ${domain.padEnd(22)} 총 ${st.c}건  /  score≥2 ${st.high}건`);
    }

    console.log(`\n=== 고점수(score≥2) 평가 ===`);
    for (const a of r2.rows) {
      if (a.score >= 2) {
        console.log(`${a.t} 🔴 ${a.domain.padEnd(22)} | ${(a.evidence || "").slice(0, 70)}`);
      }
    }
  } finally {
    c.release();
    await pool.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
