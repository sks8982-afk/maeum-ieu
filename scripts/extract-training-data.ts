/**
 * 파인튜닝 학습 데이터 추출 스크립트
 *
 * ⛔⛔ 이 스크립트의 출력물은 **어르신의 실제 대화 원문과 실명이 포함된 개인정보**입니다.
 *   - 절대 git에 커밋하지 마세요. 출력 경로 `training-data/`는 .gitignore에 등록돼 있습니다.
 *   - 2026-04-01 커밋 0c424b9로 이 출력물이 공개 GitHub 2곳에 푸시되어 약 6개월간 노출된
 *     사고가 있었습니다(2026-10-01 발견·조치). .gitignore를 절대 되돌리지 마세요.
 *   - 외부(파인튜닝 서비스 등)로 업로드하려면 동의서 §4 위임 범위를 먼저 확인하고,
 *     이름·지명 등 식별정보를 가명처리하세요.
 *
 * DB에서 대화 + 인지 분석 결과를 추출하여 두 가지 JSONL 파일 생성:
 * 1. chat-training.jsonl  — 대화 모델 (민지 캐릭터) 학습용
 * 2. analysis-training.jsonl — 인지 분석 모델 학습용
 *
 * 사용법: npx tsx scripts/extract-training-data.ts
 */

import "dotenv/config";
import { Pool } from "pg";
import { pgTlsOptions } from "../lib/db-tls";
import * as fs from "fs";
import * as path from "path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL이 설정되지 않았습니다. .env 파일을 확인하세요.");
  process.exit(1);
}

// TLS는 앱과 같은 정책(lib/db-tls, 2026-10-07 8차) — RDS면 인증서를 검증하고, 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
//   (예전엔 이 스크립트가 인증서 검증을 끈 채 운영 DB에 붙었다)
const { connectionString, ssl } = pgTlsOptions(DATABASE_URL);
const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });

// ─── 시스템 프롬프트 (학습 데이터에 포함될 것) ─────────────────────────────

const CHAT_SYSTEM_PROMPT = `당신은 '마음이음' 서비스의 AI 손녀 '민지'입니다.
사용자와 자연스럽게 대화하며, 식사 여부나 일상, 기분 등을 편하게 물어봅니다.
의료·진단·처방은 하지 말고, 참고 수준의 대화만 이어가세요.

[답변 규칙]
- 반드시 2~3문장 이내로 짧게 답하세요.
- 사용자의 말에 먼저 반응한 뒤, 자연스럽게 질문 하나를 이어가세요.
- 사용자를 호칭으로 불러주세요 (할아버지, 할머니 등).
- 응답은 자연스러운 한국어 텍스트만 출력하세요. JSON이나 기술 데이터를 절대 포함하지 마세요.`;

const ANALYSIS_SYSTEM_PROMPT = `당신은 고령자 인지 기능 선별 전문가입니다.
아래 대화를 분석하여 결과를 JSON으로 반환하세요.

평가 영역: orientation_time, orientation_place, memory_immediate, memory_delayed, language, judgment
점수: 0(정상), 1(경계), 2(주의)

판단 기준:
- 사용자가 날짜/월/년도/요일을 명백히 틀리게 말했으면 → isAnomaly: true, orientation_time score 2
- 사용자가 현재 날씨와 명백히 다른 말을 했으면 → isAnomaly: true
- 사용자가 AI를 정정한 경우 → isAnomaly: false (AI가 틀렸을 수 있음)
- 근거 없으면 평가하지 마세요

JSON 형식:
{"isAnomaly": false, "analysisNote": "", "cognitiveChecks": []}
cognitiveChecks 항목: {"domain": "영역", "score": 0, "confidence": 0.8, "evidence": "근거", "note": "사유"}`;

// ─── 타입 ────────────────────────────────────────────────────────────────────

interface DbMessage {
  id: string;
  role: string;
  content: string;
  isAnomaly: boolean;
  analysisNote: string | null;
  createdAt: Date;
  conversationId: string;
}

interface DbAssessment {
  message_id: string;
  domain: string;
  score: number;
  confidence: number;
  evidence: string;
  note: string;
}

interface ChatTrainingRow {
  messages: { role: string; content: string }[];
}

interface AnalysisTrainingRow {
  messages: { role: string; content: string }[];
}

// ─── 추출 로직 ──────────────────────────────────────────────────────────────

async function extractData() {
  const client = await pool.connect();

  try {
    // 1) 모든 대화 가져오기
    const convResult = await client.query<{ id: string; userId: string }>(
      `SELECT id, "userId" FROM "Conversation" ORDER BY "createdAt" ASC`
    );
    console.log(`대화 ${convResult.rows.length}개 발견`);

    // 2) 인지 평가 결과 가져오기
    const assessResult = await client.query<DbAssessment>(
      `SELECT message_id, domain, score, confidence, evidence, note FROM cognitive_assessments`
    );
    const assessByMsg = new Map<string, DbAssessment[]>();
    for (const a of assessResult.rows) {
      const list = assessByMsg.get(a.message_id) ?? [];
      list.push(a);
      assessByMsg.set(a.message_id, list);
    }
    console.log(`인지 평가 ${assessResult.rows.length}건 발견`);

    const chatRows: ChatTrainingRow[] = [];
    const analysisRows: AnalysisTrainingRow[] = [];

    for (const conv of convResult.rows) {
      // 3) 대화별 메시지 가져오기
      const msgResult = await client.query<DbMessage>(
        `SELECT id, role, content, "isAnomaly", "analysisNote", "createdAt", "conversationId"
         FROM "Message" WHERE "conversationId" = $1 ORDER BY "createdAt" ASC`,
        [conv.id]
      );
      const messages = msgResult.rows;
      if (messages.length < 2) continue;

      // 4) 대화를 턴 단위로 분할 (user → assistant 쌍)
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role !== "user") continue;

        // 다음 assistant 응답 찾기
        const assistantMsg = messages.slice(i + 1).find((m) => m.role === "assistant");
        if (!assistantMsg) continue;

        // JSON이 섞인 응답은 제외 (학습 데이터 품질 관리)
        if (assistantMsg.content.startsWith("{") || assistantMsg.content.includes('"text"')) continue;

        // 이전 대화 히스토리 (최근 6개 메시지까지)
        const history = messages.slice(Math.max(0, i - 6), i);

        // ── 대화 모델 학습 데이터 ──
        const chatMessages: { role: string; content: string }[] = [
          { role: "system", content: CHAT_SYSTEM_PROMPT },
        ];
        for (const h of history) {
          chatMessages.push({
            role: h.role === "user" ? "user" : "assistant",
            content: h.content,
          });
        }
        chatMessages.push({ role: "user", content: msg.content });
        chatMessages.push({ role: "assistant", content: assistantMsg.content });
        chatRows.push({ messages: chatMessages });

        // ── 인지 분석 학습 데이터 ──
        const assessments = assessByMsg.get(msg.id);
        const historyText = history
          .map((h) => `${h.role === "user" ? "사용자" : "AI"}: ${h.content}`)
          .join("\n");

        // 이상징후가 있든 없든 모두 학습 데이터에 포함 (정상/이상 균형)
        const analysisInput = [
          historyText ? `대화:\n${historyText}\n` : "",
          `[이번 턴]`,
          `사용자: ${msg.content}`,
          `AI: ${assistantMsg.content}`,
        ]
          .filter(Boolean)
          .join("\n");

        const analysisOutput = assessments && assessments.length > 0
          ? JSON.stringify({
              isAnomaly: msg.isAnomaly,
              analysisNote: msg.analysisNote || "",
              cognitiveChecks: assessments.map((a) => ({
                domain: a.domain,
                score: a.score,
                confidence: a.confidence,
                evidence: a.evidence,
                note: a.note,
              })),
            })
          : JSON.stringify({
              isAnomaly: false,
              analysisNote: "",
              cognitiveChecks: [],
            });

        analysisRows.push({
          messages: [
            { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
            { role: "user", content: analysisInput },
            { role: "assistant", content: analysisOutput },
          ],
        });
      }
    }

    // 5) JSONL 파일 저장
    const outDir = path.join(process.cwd(), "training-data");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const chatPath = path.join(outDir, "chat-training.jsonl");
    const analysisPath = path.join(outDir, "analysis-training.jsonl");

    fs.writeFileSync(chatPath, chatRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    fs.writeFileSync(analysisPath, analysisRows.map((r) => JSON.stringify(r)).join("\n") + "\n");

    // 6) 통계 출력
    const anomalyCount = analysisRows.filter((r) => {
      const assistantContent = r.messages[2]?.content ?? "";
      try {
        return JSON.parse(assistantContent).isAnomaly === true;
      } catch {
        return false;
      }
    }).length;

    console.log("\n=== 추출 완료 ===");
    console.log(`대화 학습 데이터: ${chatRows.length}건 → ${chatPath}`);
    console.log(`분석 학습 데이터: ${analysisRows.length}건 → ${analysisPath}`);
    console.log(`  - 이상징후 포함: ${anomalyCount}건`);
    console.log(`  - 정상: ${analysisRows.length - anomalyCount}건`);
    console.log(`  - 이상/정상 비율: ${((anomalyCount / analysisRows.length) * 100).toFixed(1)}%`);

  } finally {
    client.release();
    await pool.end();
  }
}

extractData().catch((e) => {
  console.error("추출 실패:", e);
  process.exit(1);
});
