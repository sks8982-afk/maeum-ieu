/**
 * 대화 요약 — 계층적 압축 (weekly → monthly → yearly).
 *
 * 구조:
 *   L1 raw messages       : Message 테이블 그대로
 *   L2 weekly summary     : 1주 단위 (월요일~일요일)
 *   L3 monthly summary    : 4개 weekly 합치기
 *   L4 yearly summary     : 12개 monthly 합치기
 *
 * prompt 주입: 최근 raw N턴 + 최근 weekly 2개 + 최근 monthly 1개 + 최근 yearly 1개
 *
 * 사용자 격리: 모든 쿼리 user_id 필터 강제.
 */

import { Type as SchemaType, type Schema } from "@google/genai";
import { COMPANION_SAFETY_SETTINGS, logUsage, getGenAI, LLM_TIMEOUT_MS, timeoutSignal } from "@/lib/chat/llm";
import { geminiTuning } from "@/lib/ai/gemini-config";
import { prisma } from "@/lib/prisma";

// 아래 두 호출의 thinking 예산(512)은 ≤3.8 모델에만 실린다. 3.9+·4+·별칭으로 바꾸면 lib/ai/gemini-config가
//   thinkingLevel "low"로 보내는데, 수준은 토큰 상한이 아니므로 그때 JSON 잘림(maxOutputTokens 3072)을 실측할 것.
const SUMMARY_MODEL = "gemini-2.5-flash"; // 비용 최적화: 요약은 단순 압축 — 3.5 불필요
export type SummaryLevel = "weekly" | "monthly" | "yearly";

const SUMMARY_PROMPT = `당신은 노인 인지 케어 시스템의 대화 요약가입니다. 아래 대화에서 사용자(어르신) 발화만 분석해 summary와 facts를 채우세요. AI 응답은 무시.
- summary: 어르신이 말한 핵심(가족·일상·건강·취미·고향·정서)을 자연스러운 한국어 200~400자로.
- facts: 명확한 정보만. 추측·확장 금지. 없으면 빈 배열/생략.`;

const META_SUMMARY_PROMPT = `당신은 대화 요약본을 다시 압축하는 메타 요약가입니다. 아래 시기별 요약본을 통합해 더 긴 기간의 요약으로 압축하세요.
- summary: 일관된 패턴(자주 등장하는 주제·감정·관심사) 중심, 시기별 변화가 있으면 명시. 300~500자.
- facts: 하위 요약들의 facts 통합(중복 제거, 모순 시 최근 우선).`;

// 구조화 출력 스키마 — 마커·자가검토·잘림 없이 깨끗한 JSON 강제(3.5 thinking 누출 차단).
const S = SchemaType;
const SUMMARY_SCHEMA: Schema = {
  type: S.OBJECT,
  properties: {
    summary: { type: S.STRING, description: "어르신 발화 중심 자연어 요약" },
    facts: {
      type: S.OBJECT,
      properties: {
        family: { type: S.ARRAY, items: { type: S.OBJECT, properties: { relation: { type: S.STRING }, name: { type: S.STRING }, note: { type: S.STRING } } } },
        hometown: { type: S.STRING },
        residence: { type: S.STRING },
        hobbies: { type: S.ARRAY, items: { type: S.STRING } },
        health: { type: S.ARRAY, items: { type: S.STRING } },
        favorites: { type: S.ARRAY, items: { type: S.STRING } },
        events: { type: S.ARRAY, items: { type: S.OBJECT, properties: { when: { type: S.STRING }, what: { type: S.STRING } } } },
      },
    },
  },
  required: ["summary"],
};

export interface SummaryRow {
  id: string;
  summary: string;
  keyFacts: string | null;
  periodStart: Date;
  periodEnd: Date;
  level: SummaryLevel;
  messageCount: number;
}

interface MsgRow {
  id: string;
  role: string;
  content: string;
  createdAt: Date;
}

function parseLLMOutput(raw: string): { summary: string; keyFacts: string } {
  // responseSchema(JSON) 강제 출력 → 깨끗한 JSON 파싱. (이전 마커 파싱은 3.5 thinking 누출로 실패하던 문제 제거)
  try {
    const obj = JSON.parse(raw);
    const summary = typeof obj?.summary === "string" ? obj.summary.trim() : "";
    const facts = obj?.facts && typeof obj.facts === "object" ? obj.facts : {};
    return { summary, keyFacts: JSON.stringify(facts) };
  } catch {
    return { summary: "", keyFacts: "{}" };
  }
}

/** raw 메시지를 weekly 요약으로 압축. */
export async function summarizeMessages(params: {
  userId: string;
  conversationId: string;
  messages: MsgRow[];
  level?: SummaryLevel;
}): Promise<SummaryRow | null> {
  const { userId, conversationId, messages, level = "weekly" } = params;
  if (messages.length === 0) return null;

  const periodStart = messages[0].createdAt;
  const periodEnd = messages[messages.length - 1].createdAt;

  // idempotent: 같은 사용자·대화·기간·레벨 요약 있으면 skip
  const existing = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `SELECT id FROM conversation_summary
     WHERE user_id = $1 AND conversation_id = $2 AND level = $3
       AND period_start = $4::timestamptz AND period_end = $5::timestamptz`,
    userId, conversationId, level, periodStart, periodEnd,
  );
  if (existing.length > 0) return null;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.warn("[summarizer] no GEMINI_API_KEY"); return null; }

  const transcript = messages.map((m) => {
    const t = m.role === "user" ? "사용자" : "AI";
    return `[${t}] ${m.content.replace(/\s+/g, " ").slice(0, 300)}`;
  }).join("\n");

  try {
    const res = await getGenAI().models.generateContent({
      model: SUMMARY_MODEL,
      contents: `${SUMMARY_PROMPT}\n\n[대화]\n${transcript}`,
      // thinkingConfig로 thinking 예산 제한 — 안 하면 thinking(~2900)이 maxOutputTokens를 먹어 JSON이 잘림.
      config: { ...geminiTuning(SUMMARY_MODEL, { temperature: 0.2, thinkingBudget: 512, thinkingLevel: "low" }), maxOutputTokens: 3072, responseMimeType: "application/json", responseSchema: SUMMARY_SCHEMA, safetySettings: COMPANION_SAFETY_SETTINGS, abortSignal: timeoutSignal(LLM_TIMEOUT_MS.background) },
    });
    logUsage("summarizer", res);
    const raw = (res.text ?? "").trim();
    const { summary, keyFacts } = parseLLMOutput(raw);
    if (!summary || summary.length < 20) {
      console.warn("[summarizer] empty summary, raw preview:", raw.slice(0, 200));
      return null;
    }
    const id = `cs_${userId.slice(0, 8)}_${level}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO conversation_summary (id, user_id, conversation_id, period_start, period_end, summary, key_facts, message_count, level)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9)`,
      id, userId, conversationId, periodStart, periodEnd, summary, keyFacts, messages.length, level,
    );
    console.log("[summarizer] saved", JSON.stringify({
      userId: userId.slice(0, 8), level, msgs: messages.length, summaryLen: summary.length,
    }));
    return { id, summary, keyFacts, periodStart, periodEnd, level, messageCount: messages.length };
  } catch (e) {
    console.warn("[summarizer] error:", (e as Error).message);
    return null;
  }
}

/** 하위 레벨 요약 N개를 상위 레벨로 압축 (weekly 4개 → monthly 1개). */
export async function rollupSummaries(params: {
  userId: string;
  conversationId: string;
  childLevel: "weekly" | "monthly";
}): Promise<SummaryRow | null> {
  const { userId, conversationId, childLevel } = params;
  const parentLevel = childLevel === "weekly" ? "monthly" : "yearly";
  const minCount = childLevel === "weekly" ? 4 : 12;

  // 아직 parent로 압축되지 않은 active child 요약들 조회
  const children = await prisma.$queryRawUnsafe<SummaryRow[]>(
    `SELECT id, summary, key_facts AS "keyFacts", period_start AS "periodStart", period_end AS "periodEnd", message_count AS "messageCount", level
     FROM conversation_summary
     WHERE user_id = $1 AND conversation_id = $2 AND level = $3 AND is_active = true AND parent_id IS NULL
     ORDER BY period_start ASC`,
    userId, conversationId, childLevel,
  );
  if (children.length < minCount) return null;

  const targets = children.slice(0, minCount);
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const transcript = targets.map((s, i) => {
    return `[#${i+1} ${s.periodStart.toISOString().slice(0,10)} ~ ${s.periodEnd.toISOString().slice(0,10)}]\n${s.summary}`;
  }).join("\n\n");

  try {
    const res = await getGenAI().models.generateContent({
      model: SUMMARY_MODEL,
      contents: `${META_SUMMARY_PROMPT}\n\n[하위 요약들]\n${transcript}`,
      // thinkingConfig로 thinking 예산 제한 — 안 하면 thinking(~2900)이 maxOutputTokens를 먹어 JSON이 잘림.
      config: { ...geminiTuning(SUMMARY_MODEL, { temperature: 0.2, thinkingBudget: 512, thinkingLevel: "low" }), maxOutputTokens: 3072, responseMimeType: "application/json", responseSchema: SUMMARY_SCHEMA, safetySettings: COMPANION_SAFETY_SETTINGS, abortSignal: timeoutSignal(LLM_TIMEOUT_MS.background) },
    });
    logUsage("summarizer-rollup", res);
    const { summary, keyFacts } = parseLLMOutput((res.text ?? "").trim());
    if (!summary || summary.length < 30) return null;

    const id = `cs_${userId.slice(0, 8)}_${parentLevel}_${Date.now()}`;
    const periodStart = targets[0].periodStart;
    const periodEnd = targets[targets.length - 1].periodEnd;
    const totalMsgs = targets.reduce((a, b) => a + b.messageCount, 0);

    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `INSERT INTO conversation_summary (id, user_id, conversation_id, period_start, period_end, summary, key_facts, message_count, level)
         VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, $8, $9)`,
        id, userId, conversationId, periodStart, periodEnd, summary, keyFacts, totalMsgs, parentLevel,
      ),
      // 하위 요약은 비활성화(prompt에서 제외) + parent 링크
      prisma.$executeRawUnsafe(
        `UPDATE conversation_summary SET parent_id = $1, is_active = false WHERE id = ANY($2::text[])`,
        id, targets.map((t) => t.id),
      ),
    ]);

    console.log("[summarizer] rollup", JSON.stringify({
      userId: userId.slice(0, 8), parentLevel, childCount: targets.length, totalMsgs,
    }));
    return { id, summary, keyFacts, periodStart, periodEnd, level: parentLevel as SummaryLevel, messageCount: totalMsgs };
  } catch (e) {
    console.warn("[summarizer] rollup error:", (e as Error).message);
    return null;
  }
}

/**
 * 사용자 prompt에 주입할 요약본 조회 — 계층별 최근 N개.
 * 권장: weekly 2개 (최근 2주) + monthly 1개 (지난 달) + yearly 1개 (이전 해)
 */
export async function getRecentSummaries(userId: string, limits = { weekly: 2, monthly: 1, yearly: 1 }): Promise<SummaryRow[]> {
  const rows = await prisma.$queryRawUnsafe<SummaryRow[]>(
    `(SELECT id, summary, key_facts AS "keyFacts", period_start AS "periodStart", period_end AS "periodEnd", level, message_count AS "messageCount"
      FROM conversation_summary
      WHERE user_id = $1 AND level = 'weekly' AND is_active = true
      ORDER BY period_end DESC LIMIT $2)
     UNION ALL
     (SELECT id, summary, key_facts AS "keyFacts", period_start AS "periodStart", period_end AS "periodEnd", level, message_count AS "messageCount"
      FROM conversation_summary
      WHERE user_id = $1 AND level = 'monthly' AND is_active = true
      ORDER BY period_end DESC LIMIT $3)
     UNION ALL
     (SELECT id, summary, key_facts AS "keyFacts", period_start AS "periodStart", period_end AS "periodEnd", level, message_count AS "messageCount"
      FROM conversation_summary
      WHERE user_id = $1 AND level = 'yearly' AND is_active = true
      ORDER BY period_end DESC LIMIT $4)`,
    userId, limits.weekly, limits.monthly, limits.yearly,
  );
  return rows;
}

interface KeyFacts {
  family?: { relation?: string; name?: string; note?: string }[];
  hometown?: string; residence?: string;
  hobbies?: string[]; health?: string[]; favorites?: string[];
  events?: { when?: string; what?: string }[];
}

/**
 * 요약기가 추출·저장한 keyFacts(구조화 사실)를 프롬프트용 한 줄로 렌더. export: 회귀 테스트용.
 * 기존엔 summary 자연어만 주입하고 keyFacts를 버려, 개별 사물명·이벤트가 압축 과정에서 소실됐음(회상 견고성 갭).
 */
export function renderKeyFacts(json: string | null): string {
  if (!json) return "";
  let f: KeyFacts;
  try { f = JSON.parse(json) as KeyFacts; } catch { return ""; }
  if (!f || typeof f !== "object") return "";
  const parts: string[] = [];
  const fam = (f.family ?? []).map((m) => `${m.relation ?? ""} ${m.name ?? ""}`.trim()).filter(Boolean);
  if (fam.length) parts.push(`가족 ${fam.join(", ")}`);
  if (f.hometown) parts.push(`고향 ${f.hometown}`);
  if (f.residence) parts.push(`거주 ${f.residence}`);
  if (f.favorites?.length) parts.push(`좋아함 ${f.favorites.join(", ")}`);
  if (f.hobbies?.length) parts.push(`취미 ${f.hobbies.join(", ")}`);
  if (f.health?.length) parts.push(`건강 ${f.health.join(", ")}`);
  const ev = (f.events ?? []).map((e) => `${e.when ? e.when + " " : ""}${e.what ?? ""}`.trim()).filter(Boolean);
  if (ev.length) parts.push(`일 ${ev.join(", ")}`);
  return parts.join(" · ");
}

export function renderSummariesForPrompt(summaries: SummaryRow[]): string {
  if (summaries.length === 0) return "";
  const now = Date.now();
  const LEVEL_KO: Record<SummaryLevel, string> = { weekly: "주간", monthly: "월간", yearly: "연간" };
  // 시점이 오래된 것부터 정렬
  const sorted = summaries.slice().sort((a, b) => new Date(a.periodEnd).getTime() - new Date(b.periodEnd).getTime());
  const lines = sorted.map((s) => {
    const days = Math.floor((now - new Date(s.periodEnd).getTime()) / (24 * 60 * 60 * 1000));
    const tag = days <= 7 ? "최근" : days <= 30 ? `${Math.floor(days/7)}주 전` : days <= 365 ? `${Math.floor(days/30)}달 전` : `${Math.floor(days/365)}년 전`;
    const kf = renderKeyFacts(s.keyFacts);
    return `[${LEVEL_KO[s.level]} 요약 / ${tag}] ${s.summary}${kf ? `\n  · 핵심 사실: ${kf}` : ""}`;
  });
  return `[과거 대화 요약 — 사실 확인 보조]\n${lines.join("\n\n")}`;
}
