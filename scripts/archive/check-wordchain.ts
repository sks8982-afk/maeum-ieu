/**
 * 끝말잇기 관련 AI 응답에서 "끝글자 시작 단어" 지시가 잘못된 케이스 검출.
 *
 * 정상: "북한" → "한국" (한으로 시작) → "국가" (국으로 시작) ...
 * 이상: "위성" 다음에 "위로 시작하는 단어" 식으로 시작글자 = 직전 단어 첫글자 반복
 */
import "dotenv/config";
const { Pool } = require("pg");
import { pgTlsOptions } from "../../lib/db-tls";

interface MsgRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: Date;
}

const STARTS_PATTERN = /'([가-힣])'(?:로|으로)\s*시작하는\s*단어/g;
const AI_PROPOSED = /민지가\s*이번엔\s*'([가-힣]{1,4})'(?:이?라고|라고)/;

async function main() {
  // TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const c = await pool.connect();
  try {
    // 끝말잇기 진행 중인 대화 (assistant content에 "시작하는 단어" 키워드 포함) 찾기
    const r = await c.query(`
      SELECT "conversationId" AS conv, COUNT(*) AS hits
      FROM "Message"
      WHERE role='assistant' AND content ~ '시작하는 단어'
      GROUP BY "conversationId"
      ORDER BY MAX("createdAt") DESC
      LIMIT 20
    `);
    if (r.rows.length === 0) {
      console.log("끝말잇기 응답 없음");
      return;
    }
    console.log(`끝말잇기 진행 대화: ${r.rows.length}개\n`);
    for (const row of r.rows) console.log(`  ${row.conv} (${row.hits}건)`);

    // 첫 번째 대화 상세 분석
    const targetConv = r.rows[0].conv;
    console.log(`\n=== 분석 대상 대화: ${targetConv} ===\n`);

    const msgs = (await c.query(
      `SELECT id, "conversationId", role, content, "createdAt"
       FROM "Message"
       WHERE "conversationId"=$1
       ORDER BY "createdAt" ASC`,
      [targetConv]
    )).rows as MsgRow[];

    // 끝말잇기 시퀀스만 추출 (앞뒤 5턴씩)
    let firstWordChainIdx = -1;
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === "assistant" && /시작하는 단어/.test(msgs[i].content)) {
        firstWordChainIdx = Math.max(0, i - 2);
        break;
      }
    }
    if (firstWordChainIdx === -1) return;

    let prevAiWord: string | null = null;
    let issueCount = 0;
    for (let i = firstWordChainIdx; i < Math.min(msgs.length, firstWordChainIdx + 30); i++) {
      const m = msgs[i];
      const ts = new Date(m.createdAt).toISOString().slice(11, 19);
      const tag = m.role === "user" ? "👤" : "🤖";

      if (m.role === "assistant") {
        const proposedMatch = m.content.match(AI_PROPOSED);
        const startsMatches = Array.from(m.content.matchAll(STARTS_PATTERN));
        if (proposedMatch && startsMatches.length > 0) {
          const aiWord = proposedMatch[1];
          const lastChar = aiWord[aiWord.length - 1];
          for (const sm of startsMatches) {
            const askedStart = sm[1];
            const ok = askedStart === lastChar;
            const flag = ok ? "  " : "❌";
            if (!ok) issueCount++;
            console.log(`${ts} ${tag} ${flag} AI제시="${aiWord}" → 사용자에게 '${askedStart}'로 시작 요청 (정답: '${lastChar}')`);
          }
          prevAiWord = aiWord;
        } else {
          // 사용자 단어 인정 + 다음 제시 없는 경우
          const sm = m.content.match(STARTS_PATTERN);
          if (sm) {
            const allMatches = Array.from(m.content.matchAll(STARTS_PATTERN));
            for (const x of allMatches) {
              console.log(`${ts} ${tag}    "${m.content.slice(0, 80)}" — 시작글자 '${x[1]}'`);
            }
          } else if (prevAiWord) {
            // skip
          }
        }
      } else {
        // user 발화
        console.log(`${ts} ${tag} "${m.content.slice(0, 60)}"`);
      }
    }

    console.log(`\n총 검출된 잘못된 시작글자 지시: ${issueCount}건`);
  } finally {
    c.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
