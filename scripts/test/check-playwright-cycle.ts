import "dotenv/config";
import { Pool } from "pg";
import { pgTlsOptions } from "../../lib/db-tls";
(async () => {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();
  try {
    const r1 = await c.query(`
      SELECT id, content, "isAnomaly", "analysisNote", "emergencyLevel", "emergencyEvidence",
             "speakerLabel", "notifiedAt",
             to_char("createdAt" AT TIME ZONE 'Asia/Seoul','HH24:MI:SS') AS t
      FROM "Message"
      WHERE role='user' AND "createdAt" >= NOW() - INTERVAL '40 minutes'
      ORDER BY "createdAt" ASC
    `);
    console.log("--- 사용자 발화 (Playwright 사이클) ---");
    for (const m of r1.rows) {
      const flags = [
        m.isAnomaly ? "🔴이상" : "",
        m.emergencyLevel ? "🚨L" + m.emergencyLevel : "",
        m.speakerLabel ? "spk=" + m.speakerLabel : "",
        m.notifiedAt ? "📨알림" : "",
      ].filter(Boolean).join(" ");
      console.log(`${m.t} ${flags}`);
      console.log(`  user: ${m.content.slice(0, 80)}`);
      if (m.analysisNote) console.log(`  note: ${m.analysisNote.slice(0, 140)}`);
      if (m.emergencyEvidence) console.log(`  emg: ${m.emergencyEvidence.slice(0, 80)}`);
    }
    const r2 = await c.query(`
      SELECT domain, score, evidence, note,
             to_char(created_at AT TIME ZONE 'Asia/Seoul','HH24:MI:SS') AS t
      FROM cognitive_assessments
      WHERE created_at >= NOW() - INTERVAL '40 minutes'
      ORDER BY created_at ASC
    `);
    console.log(`\n--- cognitive_assessments (${r2.rows.length}건) ---`);
    for (const a of r2.rows) {
      const flag = a.score >= 2 ? "🔴" : a.score === 1 ? "⚠️" : "✓ ";
      console.log(`${a.t} ${flag} ${a.domain.padEnd(22)} s=${a.score} | ${(a.evidence || "").slice(0, 60)}`);
    }
  } finally {
    c.release();
    await pool.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
