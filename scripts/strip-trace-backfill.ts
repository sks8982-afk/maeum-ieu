/**
 * 과거 저장된 AI 메시지 중 reasoning trace가 선두에 노출된 건을 stripReasoningTrace로 정리.
 */
import "dotenv/config";
import { Pool } from "pg";
import { pgTlsOptions } from "../lib/db-tls";
function stripReasoningTrace(text: string): string {
  if (!text) return text;
  let t = text.trim();
  if (!t) return t;
  t = t.replace(/^\s*(?:```(?:thinking|thought)?\s*)?(?:thought|thinking|reasoning|analysis|plan|scratchpad)\s*:?\s*/i, "");
  t = t.replace(/^\s*\*{2,}\s*(?:thought|thinking|reasoning|analysis)[^*\n]*\*{2,}\s*/gi, "");
  const segments = t.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 0);
  if (segments.length === 0) return t;
  const hasHangul = (s: string) => /[가-힣]/.test(s);
  const hangulRatio = (s: string) => {
    const han = (s.match(/[가-힣]/g) || []).length;
    const letters = (s.match(/[a-zA-Z가-힣]/g) || []).length;
    return letters === 0 ? 0 : han / letters;
  };
  if (!hasHangul(t)) return t;
  let startIdx = 0;
  for (let i = 0; i < segments.length; i++) {
    if (hangulRatio(segments[i]) >= 0.4) { startIdx = i; break; }
    if (i === segments.length - 1) startIdx = 0;
  }
  return segments.slice(startIdx).join(" ").trim();
}

async function main() {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();
  let changed = 0, scanned = 0;
  try {
    const r = await c.query(`
      SELECT id, content FROM "Message"
      WHERE role='assistant'
        AND (content ~* '^\\s*(thought|thinking|reasoning|analysis|plan|scratchpad)\\s'
          OR content ~* '^\\s*\\*\\*(thought|thinking|reasoning|analysis)')
    `);
    for (const row of r.rows) {
      scanned++;
      const cleaned = stripReasoningTrace(row.content);
      if (cleaned && cleaned !== row.content) {
        await c.query(`UPDATE "Message" SET content=$1 WHERE id=$2`, [cleaned, row.id]);
        changed++;
        console.log(`  fixed ${row.id}: "${cleaned.slice(0, 80)}"`);
      }
    }
    console.log(`\n✓ ${scanned}건 스캔, ${changed}건 정리`);
  } finally {
    c.release(); await pool.end();
  }
}
main().catch(console.error);
