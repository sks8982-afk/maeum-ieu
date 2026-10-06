import { NextResponse, after } from "next/server";
import { getServerSession } from "next-auth";
import type { Part } from "@google/genai";
import { authOptions } from "@/lib/auth";
import { searchMemories } from "@/lib/rag";
import { extractAndSaveProfile } from "@/lib/chat/profile-extractor";
import { factCheckResponse } from "@/lib/chat/fact-checker";
import type { FullProfile } from "@/lib/chat/profile";
import { maybeTriggerSummaryRollup } from "@/lib/chat/summary-trigger";
import { normalizeImnida } from "@/lib/chat/korean-particle";
import { postProcessReply } from "@/lib/chat/postprocess";
import { classifyIntent, buildIntentHint } from "@/lib/chat/intent-classifier";
import type { ChatRequestBody } from "@/lib/chat/types";
import { ChatRequestSchema } from "@/lib/chat/validation";
import { getTimeContext, getCurrentKstDateTimeString, isDateTimeQuestion, getRelativeTimeLabel } from "@/lib/chat/time";
import { getWeatherContext } from "@/lib/chat/weather";
import { buildSystemPrompt } from "@/lib/chat/prompt";
import { getPrefixCache } from "@/lib/chat/prompt-cache";
import { EXCLUDE_OBSERVATION, neutralizeObservationPrefix } from "@/lib/chat/observation";
import { getGenAI, getTextModel, buildFallbackMessage, generateWithFallback, extractText, COMPANION_SAFETY_SETTINGS, logUsage, LLM_TIMEOUT_MS, timeoutSignal } from "@/lib/chat/llm";
import { buildHistoryText, extractLastAiMessage } from "@/lib/chat/history-text";
import { buildWordGameHint, buildNameAnswerHint, buildRepetitionHint, buildAnomalyCorrectionHint, buildFamilyQueryGuard, buildRecallVerificationHint, buildInfoRequestHint, buildProbeHoldHint, buildParentReferentHint, buildMentalCheckOfferHint } from "@/lib/chat/hints";
import { detectLowEngagement, buildEngagementHint } from "@/lib/chat/engagement";
import { saveMessages, saveGreetingMessage, saveCognitiveAssessments, markAnomaly } from "@/lib/chat/messages";
import { getDailyUsage, buildDailyLimitReply, buildNearLimitPromptHint } from "@/lib/usage/daily-limit";
import { runCognitiveAnalysis } from "@/lib/chat/cognitive-run";
import { randomUUID } from "crypto";
import { buildExamPlan, renderDomainBattery, scoreDomainAnswer, isNonResponse, renderDomainReask, itemsForDomain } from "@/lib/screening/exam-runner";
import { classifyProvisional, assessCoverage } from "@/lib/screening/exam-eval";
import { detectInappropriate, buildModerationReply, isPastResolvedSelfHarm, buildPastSelfHarmReply } from "@/lib/chat/moderation";
import { detectEmergency, buildEmergencyL3Reply, type EmergencyResult } from "@/lib/chat/emergency";
import { detectEmergencyLLM } from "@/lib/chat/emergency-llm";
import { evaluateEmergency, detectWithBackstop } from "@/lib/chat/emergency-evaluate";
import { evaluateSttConfidence, buildClarificationReply } from "@/lib/chat/stt-confidence";
import { buildSttHints } from "@/lib/chat/stt-hints";
import { correctTranscriptionByContext } from "@/lib/chat/stt-context-correction";
import { notifyGuardian } from "@/lib/chat/emergency-notify";
import { lastResortEmergency } from "@/lib/chat/emergency-last-resort";
import { getHonorific } from "@/lib/chat/prompt";
import { COMPANION_DEFAULTS } from "@/lib/chat/constants";
import { maybeNotifyCognitiveDecline } from "@/lib/health/cognitive-alert";
import { handleMentalFlow } from "@/lib/health/mental-flow";
import { getMentalFollowupHint } from "@/lib/health/mental-followup";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";

// 모델·응답추출 유틸은 lib/chat/llm.ts로 분리(getApiKey/getTextModel/buildFallbackMessage/generateWithFallback/extractText/stripReasoningTrace).

// 프롬프트 hint 빌더는 lib/chat/hints.ts로 분리(buildWordGameHint/buildNameAnswerHint/buildRepetitionHint/buildAnomalyCorrectionHint/buildFamilyQueryGuard/buildRecallVerificationHint/buildInfoRequestHint).
// 응답 후처리(removeParrot/removeTimeLabels/normalizeHonorific/fixChildGenderHonorific/normalizeFamilyChildHonorific/removeUngroundedClaims/fixWordChainStart/removeRepeatedOpening/trimIncomplete/postProcessReply)는 lib/chat/postprocess.ts로 분리(2026-06-10).

// ─── 공통 유틸 ──────────────────────────────────────────────────────────────

type GeminiTurn = { role: "user" | "model"; parts: { text: string }[] };

/**
 * 대화 이력을 Gemini multi-turn `contents` 배열로 변환.
 *
 * 텍스트로 history를 통째 stuff하는 방식 → 모델이 턴 순서/Q-A 페어를 자주 놓침.
 * Gemini가 내부적으로 사용자/모델 턴을 구분하도록 구조화된 contents로 전달한다.
 *
 * 규칙:
 * - Gemini contents는 user/model이 번갈아 와야 하므로 연속된 같은 role은 합친다
 * - 첫 turn은 반드시 user → model로 시작하면 dummy user를 앞에 추가
 * - `currentUserMessage`가 messages 끝 user 메시지와 동일하면 prior에서 제외
 * - 최종 turn은 항상 user (현재 발화) — 가이드 블록(memories/hints)을 함께 주입
 * - 직전 AI 발화가 있으면 final user 텍스트 앞에 "[직전 AI 질문에 대한 답입니다]" 마커 추가
 */
function buildChatContents(params: {
  messages: { role: string; content: string; createdAt?: string }[];
  currentUserMessage: string;
  memories: string;
  hintBlock: string;
  now?: Date;
  maxRecent?: number;
}): GeminiTurn[] {
  // maxRecent 20→24: DB 이력 도입과 함께 컨텍스트 창 소폭 확대 (세션 내 재질문 감소, 토큰 +α 수용)
  const { messages, currentUserMessage, memories, hintBlock, now = new Date(), maxRecent = 24 } = params;

  // 컨텍스트 창(24) 밖 25~80번째 메시지는 사용자 발화만 압축해 다이제스트로 주입 —
  //   "30~60메시지 전 이야기를 기억 못 하는" 세션 중기 기억 공백 해소 (RAG는 랭킹 운에 좌우되어 불충분, 2026-06-11).
  //   사용자 발화만(상대 발화가 기억의 앵커) + 60자 클립 + 최대 40줄 ≈ 1k 토큰 이내.
  const older = messages.slice(0, -maxRecent);
  const olderDigest = older
    .filter((m) => m.role === "user")
    .slice(-40)
    .map((m) => {
      const label = m.createdAt ? `[${getRelativeTimeLabel(m.createdAt, now)}] ` : "";
      const body = m.content.replace(/\s+/g, " ").trim().slice(0, 60);
      return `· ${label}${body}`;
    })
    .join("\n");

  const recent = messages.slice(-maxRecent);
  // 마지막이 user이고 currentUserMessage와 동일하면 prior에서 제외 (텍스트 모드)
  let prior = recent;
  const lastMsg = recent[recent.length - 1];
  if (lastMsg && lastMsg.role === "user" && lastMsg.content.trim() === (currentUserMessage || "").trim()) {
    prior = recent.slice(0, -1);
  }

  const turns: GeminiTurn[] = [];
  for (const m of prior) {
    const role: "user" | "model" = m.role === "user" ? "user" : "model";
    const timeLabel = m.createdAt ? `[${getRelativeTimeLabel(m.createdAt, now)}] ` : "";
    const cleaned = m.content.replace(/\s*<!--\s*__mod:[^>]*-->\s*$/g, "").trim();
    if (!cleaned) continue;
    const text = `${timeLabel}${cleaned}`;
    const lastTurn = turns[turns.length - 1];
    if (lastTurn && lastTurn.role === role) {
      lastTurn.parts[0].text += `\n${text}`;
    } else {
      turns.push({ role, parts: [{ text }] });
    }
  }

  // Gemini는 첫 contents가 user여야 함 — model로 시작하면 dummy user 끼워넣기
  if (turns.length > 0 && turns[0].role === "model") {
    turns.unshift({ role: "user", parts: [{ text: "(대화 시작)" }] });
  }

  // 직전 AI 발화 확인 → 명시적 Q-A 페어링 마커
  const lastPrior = prior[prior.length - 1];
  const lastWasAi = lastPrior && lastPrior.role !== "user";
  const qaMarker = lastWasAi
    ? `[지금 사용자의 답변은 바로 위 AI의 마지막 발화에 대한 응답입니다. 새 주제가 아니라 그 흐름을 이어받으세요.]\n`
    : "";

  const cleanedHints = (hintBlock || "").trim();
  const finalText = [
    olderDigest ? `[이번 세션 앞부분 — 사용자 발화 요약 (위 대화 직전 흐름, 질문받으면 참고)]\n${olderDigest}` : "",
    memories ? `[참고 — 과거 메모리]\n${memories}` : "",
    cleanedHints,
    `${qaMarker}[현재 사용자 발화]\n${currentUserMessage || "(빈 메시지)"}`,
  ].filter(Boolean).join("\n\n");

  // 마지막 prior turn이 user면 합치고, 아니면 새 user turn 추가
  const tail = turns[turns.length - 1];
  if (tail && tail.role === "user") {
    tail.parts[0].text += `\n\n${finalText}`;
  } else {
    turns.push({ role: "user", parts: [{ text: finalText }] });
  }
  return turns;
}

/**
 * RAG 메모리 조회 — searchMemories에 DISTINCT ON dedup + limit 15.
 *
 * 진단 결과(2026-05-26): "마당 청소 좀 했어" 같은 발화가 4번 중복 임베딩되어 top 차지,
 *   다양성 있는 다른 메시지(제라늄/백일홍)가 밀려남. dedup으로 해결.
 * enriched query(recent 3 join)는 가족/명절 토픽이 너무 강해져 마당/화분이 희석되는 부작용 있어 미사용.
 */
async function fetchMemories(userId: string, query: string): Promise<string> {
  try { return await searchMemories(userId, query, 15); }
  catch { return ""; }
}

/**
 * 대화 이력을 DB에서 직접 로드 (최근 80개) — 클라이언트 slice(50)·컨텍스트 윈도우(20) 너머의
 * 세션 내 기억 공백("아까 외운 단어를 외운 적 없다", 화투 재질문) 해소.
 * DB가 ground truth이므로 클라이언트 페이로드 의존도 제거. 실패 시 빈 배열(호출부가 클라이언트 이력으로 폴백).
 */
async function fetchRecentHistory(conversationId: string): Promise<{ role: string; content: string; createdAt?: string }[]> {
  try {
    const rows = await prisma.message.findMany({
      where: { conversationId, ...EXCLUDE_OBSERVATION }, // 상시 감시 로그는 대화 컨텍스트에서 제외(표지는 lib/chat/observation 단일 출처)
      orderBy: { createdAt: "desc" },
      take: 80,
      select: { role: true, content: true, createdAt: true },
    });
    return rows.reverse().map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt.toISOString() }));
  } catch (e) {
    console.warn("[history] DB fetch failed — falling back to client messages:", (e as Error).message);
    return [];
  }
}

function toSafeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : "";
  const isQuota = /429|Too Many|quota|Quota exceeded|rate|GoogleGenerativeAI/.test(raw);
  return isQuota ? "오늘은 사용할 수 없습니다. 잠시 후 다시 시도해 주세요." : "답변 생성 중 오류가 발생했습니다.";
}

// 인지 분석 실행부는 lib/chat/cognitive-run.ts로 추출 (Live 음성 경로 /api/live/turn과 공유, 2026-06-12)

// ─── 핸들러 ─────────────────────────────────────────────────────────────────

/** 1) 최초 인사 */
async function handleFirstGreeting(systemPrompt: string, userName: string, honorific: string, companionName: string, companionRelation: string, conversationId?: string) {
  const model = getTextModel(systemPrompt, false); // 인사엔 googleSearch 불필요(지연·비용 절감)
  const { text: raw } = await generateWithFallback(
    model,
    `지금 ${userName}님이 대화를 시작합니다. ${companionRelation} '${companionName}'으로서 ${honorific}을 부르며 시간대에 맞는 인사 한 마디만 짧게 해주세요. (본인 소개 포함)`,
    `${honorific}, 안녕하세요! ${companionName}예요. 오늘 하루 어떻게 보내고 계세요?`,
  );
  const text = normalizeImnida(raw);  // "수지이에요" → "수지예요"
  if (conversationId) await saveGreetingMessage(conversationId, text);
  return NextResponse.json({ text, role: "assistant" });
}

/** 2) 재접속 인사 — AI가 먼저 인지 질문을 자연스럽게 포함 */
async function handleReturningGreeting(systemPrompt: string, userName: string, honorific: string, conversationId?: string, userId?: string, mode?: string) {
  const model = getTextModel(systemPrompt, false); // 인사엔 googleSearch 불필요(지연·비용 절감)
  // T3 후속: 위기 체크인(7일 내) / 2주 경과 재검 권유 — 일반인(general) 전용, 실패는 null 무해화
  const mentalHint = userId && mode === "general" ? await getMentalFollowupHint(userId) : null;
  const { text } = await generateWithFallback(
    model,
    `${userName}(${honorific})님이 다시 돌아왔습니다. 자기소개 반복하지 말고, "다시 오셨네요" 스타일로 따뜻하게 반겨주세요.${mentalHint ?? ""}

[중요 — 시간대에 맞는 인사·식사 질문]
위 [현재 환경 정보]의 "시간대" 라벨(새벽/아침/오전/점심/오후/저녁/밤)을 **반드시 확인**해서 시간대에 맞는 식사 질문을 하세요:
- 새벽/아침 (~10시): "아침은 드셨어요?" / "잘 주무셨어요?"
- 오전 (10~11시): "오전은 어떻게 보내고 계세요?"
- 점심 (11~14시): "점심 맛있게 드셨어요?"
- 오후 (14~17시): "점심 뭐 드셨어요?" 또는 "오후엔 뭐 하고 계세요?"
- 저녁 (17~20시): "저녁 준비하셨어요?" 또는 "오늘 하루 어떠셨어요?"
- 밤 (20시 이후): "오늘 하루 잘 보내셨어요?"
**시간대와 다른 식사 질문(아침인데 "점심 드셨어요?")은 절대 금지**.

또는 아래 중 하나로 대체 가능:
- 오늘의 기분/컨디션 질문${mode !== "general" ? "\n- 인지 선별 프로토콜에서 아직 확인 안 한 영역의 질문 하나 (시험이 아닌 자연스러운 대화 형식으로)" : ""}

2~3문장 이내. 절대 자기소개 반복하지 마세요.`,
    `${honorific}, 다시 오셨네요! 오늘 하루 어떻게 보내고 계세요?`,
  );
  const cleaned = normalizeImnida(text);
  if (conversationId) await saveGreetingMessage(conversationId, cleaned);
  return NextResponse.json({ text: cleaned, role: "assistant" });
}

/** 2.5) 능동 재참여 — 세션 중 사용자가 한동안 침묵하면 동반자가 먼저 부드럽게 한 문장. attempt 2는 후퇴(압박 0). */
async function handleReEngageGreeting(
  systemPrompt: string, honorific: string, companionName: string,
  history: { role: string; content: string }[], conversationId?: string, attempt = 1,
) {
  const model = getTextModel(systemPrompt, false);
  const lastAi = [...history].reverse().find((m) => m.role === "assistant")?.content?.slice(0, 60) || "";
  // 폴백은 companionName+조사 회피(자음받침 이름의 조사 오류 방지) — 호칭만 사용
  const fallback = attempt >= 2
    ? `${honorific}, 천천히 하셔도 괜찮아요. 여기 같이 있을게요.`
    : `${honorific}, 괜찮으세요? 천천히 말씀하셔도 돼요.`;
  const prompt = attempt >= 2
    ? `${honorific}이 한동안 말씀이 없으세요. 부담 드리지 말고, "천천히 하셔도 괜찮아요, 같이 있을게요"는 느낌으로 **아주 짧게 1~2문장**만. 질문하지 마세요.`
    : `${honorific}이 한동안 말씀이 없으세요. ${lastAi ? `직전에 '${lastAi}' 이야기를 나눴어요. 그 주제를 가볍게 한 번 더 권하거나, ` : ""}편하게 다시 말 걸어 대화를 잇는 **아주 짧게 1~2문장**만(길게 늘어놓지 말 것). 절대 재촉·압박하지 말고, 답을 강요하지 마세요.`;
  const { text } = await generateWithFallback(model, prompt, fallback);
  // 재참여는 '짧은 nudge'가 핵심(과다발화 방지) — LLM이 길게 뱉어도 첫 2문장으로 하드 캡
  const cleaned = normalizeImnida(text).split(/(?<=[.!?~])\s+/).slice(0, 2).join(" ").trim();
  if (conversationId) await saveGreetingMessage(conversationId, cleaned);
  return NextResponse.json({ text: cleaned, role: "assistant" });
}

// ─── 전문가 검진 상태머신 (Phase 2) ───────────────────────────────────────
interface ExamSessionRow { id: string; item_order: string | null; current_item: number; reask_count: number; answered_domains: number }

const MAX_REASK = 2; // 무응답 영역당 재질문 최대 횟수(이후 무응답 처리·다음 영역)

/** 진행 중(미종료) 검진 세션 조회 — 전문가(actor)↔환자 기준. */
async function lookupOpenExam(expertId: string, patientId: string): Promise<ExamSessionRow | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<ExamSessionRow[]>(
      `SELECT id, item_order, current_item, COALESCE(reask_count,0) AS reask_count, COALESCE(answered_domains,0) AS answered_domains FROM exam_session WHERE expert_user_id = $1 AND patient_user_id = $2 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      expertId, patientId);
    return rows[0] ?? null;
  } catch { return null; }
}

/** 채점용 환경(오늘 날짜·요일·계절) — 시간 지남력 정답 판정에 필요. */
function examEnv(): string {
  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const wd = ["일", "월", "화", "수", "목", "금", "토"][kst.getUTCDay()];
  const mo = kst.getUTCMonth() + 1;
  const season = mo === 12 || mo <= 2 ? "겨울" : mo <= 5 ? "봄" : mo <= 8 ? "여름" : "가을";
  return `오늘은 ${kst.getUTCFullYear()}년 ${mo}월 ${kst.getUTCDate()}일 ${wd}요일, 계절은 ${season}.`;
}

/** 검진 시작 — 영역 순서 확정 + 첫 영역 문항 제시(자동 인사 대체). */
async function handleExamGreeting(examSession: ExamSessionRow, conversationId: string | undefined, dateSeed: string) {
  // 멱등: 이미 시작된(item_order 있는) 세션이면 리셋·재채점하지 말고 현재 영역만 재안내(재접속/재인사 중복 방지)
  if (examSession.item_order) {
    const cur: string[] = (() => { try { return JSON.parse(examSession.item_order || "[]"); } catch { return []; } })();
    const at = Math.min(Math.max(0, examSession.current_item ?? 0), Math.max(0, cur.length - 1));
    const text = cur.length ? `검사를 이어서 진행하겠습니다. ${renderDomainBattery(cur[at])}` : "잠시만요, 검사를 준비하고 있어요.";
    if (conversationId) await saveGreetingMessage(conversationId, text);
    return NextResponse.json({ text, role: "assistant" });
  }
  const order = buildExamPlan(`${conversationId ?? "x"}:${dateSeed}`);
  await prisma.$executeRawUnsafe(`UPDATE exam_session SET item_order = $2, current_item = 0, reask_count = 0, answered_domains = 0, total_domains = $3 WHERE id = $1`, examSession.id, JSON.stringify(order), order.length);
  const text = `안녕하세요. 지금부터 기억력과 사고력을 알아보는 간단한 검사를 시작하겠습니다. 편하게 답해 주시면 돼요. ${renderDomainBattery(order[0])}`;
  if (conversationId) await saveGreetingMessage(conversationId, text);
  return NextResponse.json({ text, role: "assistant" });
}

/** 검진 한 턴 — 현재 영역 답변을 항목별 채점 → 다음 영역 문항(또는 종료). */
async function handleExamTurn(params: {
  examSession: ExamSessionRow; answer: string; conversationId?: string; userId: string; transcription?: string;
  /**
   * 호출 전에 평가한 응급 결과 — 검진 경로도 응급 마킹·L2 알림을 수행하기 위해 받는다.
   *
   * 결함(2026-10-01): 검진 분기가 응급 평가 자체를 우회해 L3는 물론 L2 마킹·알림도
   *   발생하지 않았다. L3는 호출 전에 즉답으로 분기하고, L2 이하는 여기서 마킹·알림한다.
   */
  emergency?: { effectiveLevel: 0 | 1 | 2 | 3; result: EmergencyResult };
  honorific?: string;
}) {
  const { examSession, answer, conversationId, userId, transcription, emergency, honorific } = params;
  const order: string[] = (() => { try { return JSON.parse(examSession.item_order || "[]"); } catch { return []; } })();
  const idx = examSession.current_item;
  const ans = (answer || "").trim();

  if (!order.length || idx >= order.length) {
    // 비정상 상태(ended_at만 NULL) 자가 복구 — 반복 메시지 루프 방지
    await prisma.$executeRawUnsafe(`UPDATE exam_session SET ended_at = now() WHERE id = $1 AND ended_at IS NULL`, examSession.id).catch(() => {});
    const text = "오늘 검사는 모두 끝났습니다. 수고 많으셨어요.";
    if (conversationId) await saveMessages({ conversationId, userId, userContent: ans || "(응답)", assistantContent: text, skipUserEmbedding: true, skipAssistantEmbedding: true });
    return NextResponse.json({ text, role: "assistant", transcription });
  }

  const domain = order[idx];
  const reask = examSession.reask_count ?? 0;

  // 무응답(빈 응답·거부)이고 재질문 여유가 있으면 — 더 쉬운 표현으로 같은 영역 재질문(채점·진행 보류)
  if (isNonResponse(ans) && reask < MAX_REASK) {
    await prisma.$executeRawUnsafe(`UPDATE exam_session SET reask_count = $2 WHERE id = $1`, examSession.id, reask + 1);
    const lead = reask === 0 ? "괜찮아요, 조금 더 쉽게 여쭤볼게요. " : "한 번만 더 여쭤볼게요. ";
    const text = lead + renderDomainReask(domain);
    if (conversationId) await saveMessages({ conversationId, userId, userContent: ans || "(무응답)", assistantContent: text, skipUserEmbedding: true, skipAssistantEmbedding: true });
    return NextResponse.json({ text, role: "assistant", transcription });
  }

  // 영역 마감 — 무응답이면 0점/무응답으로 기록(채점 호출 안 함), 응답이면 항목별 채점
  const domainAnswered = !isNonResponse(ans);
  // 이 영역의 채점이 시스템 사유로 수행되지 못했는가(0점과 구별) — 커버리지 산정에 쓴다.
  let unscoredDomain = false;
  if (domainAnswered) {
    const scores = await scoreDomainAnswer(domain, ans, examEnv());
    // 미채점(시스템 채점 실패) 항목은 저장하지 않는다 — 저장하면 0점으로 집계되어
    //   환자 기록에 가짜 인지장애 근거가 남고 total/max·등급이 실제보다 낮아진다.
    const scoredRows = scores.filter((s) => !s.unscored);
    const unscoredCount = scores.length - scoredRows.length;
    if (unscoredCount > 0) {
      unscoredDomain = true;
      console.warn(`[exam] ${domain} 미채점 ${unscoredCount}항목 — 집계 제외, 커버리지 하향`);
    }
    for (const s of scoredRows) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO exam_item_score (id, session_id, item_id, domain, prompt, answer, score, max_points, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (session_id, item_id) DO UPDATE SET prompt=EXCLUDED.prompt, answer=EXCLUDED.answer, score=EXCLUDED.score, max_points=EXCLUDED.max_points, reason=EXCLUDED.reason`,
        `eis_${randomUUID()}`, examSession.id, s.itemId, s.domain, s.prompt, s.answer, s.score, s.max, s.reason).catch(() => {});
    }
    /**
     * 미채점 항목도 **문답 기록용으로** 남긴다 — 점수·만점을 0으로 넣어 합계(SUM)와 의사 채점표(max_points>0)
     *   에서는 자동으로 빠진다(배점 0 보조 문항과 같은 취급). 가짜 0점이 되지 않는다는 위 원칙은 그대로다.
     * 왜(2026-10-06 재검토): 문답 기록을 이 테이블에서 만들게 바꾼 뒤(lib/screening/exam-qa.ts), 채점이 시스템
     *   사유로 실패한 영역은 행이 없어 **환자의 실제 답이 의사 화면에서 통째로 사라졌다** — 의사가 직접 볼 곳이 없어짐.
     */
    for (const s of scores.filter((x) => x.unscored)) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO exam_item_score (id, session_id, item_id, domain, prompt, answer, score, max_points, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (session_id, item_id) DO UPDATE SET prompt=EXCLUDED.prompt, answer=EXCLUDED.answer, score=EXCLUDED.score, max_points=EXCLUDED.max_points, reason=EXCLUDED.reason`,
        `eis_${randomUUID()}`, examSession.id, s.itemId, s.domain, s.prompt, s.answer, 0, 0, "미채점(시스템 채점 실패 — 점수 미반영, 의사 확인 필요)").catch(() => {});
    }
  } else {
    for (const it of itemsForDomain(domain)) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO exam_item_score (id, session_id, item_id, domain, prompt, answer, score, max_points, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (session_id, item_id) DO UPDATE SET prompt=EXCLUDED.prompt, answer=EXCLUDED.answer, score=EXCLUDED.score, max_points=EXCLUDED.max_points, reason=EXCLUDED.reason`,
        `eis_${randomUUID()}`, examSession.id, it.id, domain, it.prompt, ans || "", 0, it.points, "무응답").catch(() => {});
    }
  }

  // 채점이 수행되지 않은 영역은 '응답한 영역'으로 세지 않는다 → assessCoverage가 자료부족으로 판정.
  //   이렇게 해야 coverage_status='ok'인데 실제로는 채점이 빠진 상태(가짜 충분)를 막는다.
  const domainScored = domainAnswered && unscoredDomain === false;
  const answered = (examSession.answered_domains ?? 0) + (domainScored ? 1 : 0);
  const nextIdx = idx + 1;
  let text: string;
  if (nextIdx >= order.length) {
    const rows = await prisma.$queryRawUnsafe<{ t: number; m: number }[]>(
      `SELECT COALESCE(SUM(score),0)::int t, COALESCE(SUM(max_points),0)::int m FROM exam_item_score WHERE session_id = $1`, examSession.id);
    const total = rows[0]?.t ?? 0, max = rows[0]?.m ?? 0;
    const coverage = assessCoverage(answered, order.length);
    const evalRes = classifyProvisional(total, max, coverage.sufficient);
    await prisma.$executeRawUnsafe(
      `UPDATE exam_session SET current_item = $2, total_score = $3, max_score = $4, answered_domains = $5, reask_count = 0, eval_band = $6, coverage_status = $7, ended_at = now() WHERE id = $1`,
      examSession.id, nextIdx, total, max, answered, evalRes.band, coverage.sufficient ? "ok" : "insufficient");
    // 점수·등급은 환자에게 비노출(검사자만 열람). 자료부족이면 추가 문진 권유만.
    text = coverage.sufficient
      ? "이제 검사가 모두 끝났습니다. 끝까지 잘 해주셔서 감사합니다. 수고 많으셨어요."
      : "오늘은 여기까지 하겠습니다. 답하기 어려우셨던 부분이 있어, 다음에 한 번 더 도와드리며 진행하면 좋겠어요. 수고 많으셨습니다.";
  } else {
    await prisma.$executeRawUnsafe(`UPDATE exam_session SET current_item = $2, answered_domains = $3, reask_count = 0 WHERE id = $1`, examSession.id, nextIdx, answered);
    text = `네, 답변 감사합니다. 다음 질문이에요. ${renderDomainBattery(order[nextIdx])}`;
  }
  if (conversationId) {
    const lvl = emergency?.effectiveLevel ?? 0;
    // ⚠ 저장 실패가 L2 알림을 삼키지 않게 격리 — 검진 경로도 동일(2026-10-02).
    let userMsgId: string | undefined;
    try {
      ({ userMsgId } = await saveMessages({
        conversationId, userId, userContent: ans || "(무응답)", assistantContent: text,
        skipUserEmbedding: true, skipAssistantEmbedding: true,
        // 검진 답변에도 응급 신호가 섞일 수 있다 — 마킹해야 추세·보호자 화면 건수에 반영된다.
        emergencyLevel: lvl > 0 ? lvl : undefined,
        emergencyEvidence: emergency && emergency.result.level > 0
          ? `${emergency.result.category}:${emergency.result.evidence}` : undefined,
      }));
    } catch (e) {
      console.error("[exam] 저장 실패 — L2 알림은 계속:", e instanceof Error ? e.message : e);
    }
    // L2(주의) 알림 — L3는 호출부에서 이미 즉답 분기했으므로 여기 오지 않는다.
    if (lvl === 2 && emergency) {
      const sendL2 = async () => {
        try {
          const r = await notifyGuardian({
            userId, userName: honorific ?? "사용자", messageId: userMsgId, level: 2,
            category: emergency.result.category, content: ans, aiReply: text, createdAt: new Date(),
          });
          if (r.sent) console.log("[emergency-notify] exam L2 sent:", r.channels);
          else console.warn("[emergency-notify] exam L2 not sent:", r.reason);
        } catch (e) { console.error("[emergency-notify] exam L2 error:", e); }
      };
      try { after(sendL2); } catch { await sendL2(); }
    }
  }
  return NextResponse.json({ text, role: "assistant", transcription });
}

/** 3) 날짜/시간 질문 직접 응답 — 음성 경로에서 오면 transcription을 payload에 실어 클라이언트가 사용자 발화를 표시 */
async function handleDateTimeQuestion(userMessage: string, honorific: string, conversationId: string | undefined, userId: string, clientTimeIso?: string, transcription?: string) {
  const timeStr = getCurrentKstDateTimeString(clientTimeIso);
  // honorific 자체가 "할아버지"/"할머니"/"어머니"처럼 이미 친족 호칭이므로
  // "님" 접미 없이 그대로 사용. ("할아버지님" 같은 어색한 호명 방지)
  const replyText = `${honorific}, 지금은 한국 시각으로 ${timeStr}이에요.`;
  if (conversationId) {
    await saveMessages({ conversationId, userId, userContent: userMessage, assistantContent: replyText });
  }
  const payload: Record<string, unknown> = { text: replyText, role: "assistant" };
  if (transcription !== undefined) payload.transcription = transcription;
  return NextResponse.json(payload);
}

/** 음성 → 텍스트 변환 (STT 전용). hintsPromise: 사용자 어휘 힌트(이름 표기) — 병렬 조회 후 여기서 합류 */
async function transcribeAudio(audioData: string, audioMimeType: string, hintsPromise?: Promise<string>): Promise<string> {
  // 힌트 조회(DB ~수십 ms)는 STT(수 초)에 묻히므로 여기서 await해도 병목 아님. 실패는 힌트 생략.
  const hints = hintsPromise ? await hintsPromise.catch(() => "") : "";
  const parts: Part[] = [
    {
      text:
        "이 음성을 한국어로 정확하게 받아쓰기하세요. 받아쓰기한 텍스트만 출력하세요. 다른 설명이나 주석은 절대 포함하지 마세요." +
        // 반복환각 가드(2026-07-10 실사례: 침묵 구간에서 "지금" ×47 생성) — 침묵은 빈 출력으로.
        " 음성이 침묵이거나 알아들을 수 없는 잡음뿐이면 아무것도 출력하지 마세요. 들리지 않은 말을 지어내거나 같은 단어를 반복해 채우지 마세요." +
        // 힌트는 "실제 들린 경우에만" — 무음에서 힌트 어휘를 받아쓰기로 뱉는 혼입 방지
        (hints ? ` 다음 어휘가 실제로 들린 경우에만 이 표기를 쓰세요: ${hints}.` : ""),
    },
    { inlineData: { mimeType: audioMimeType, data: audioData } },
  ];

  const res = await getGenAI().models.generateContent({
    model: process.env.STT_MODEL || "gemini-2.5-flash", // 비용 최적화: 음성 전사 — 3.5 불필요
    contents: [{ role: "user", parts }],
    // STT가 음성 왕복의 56%(평균 3.7s) 병목 — 전사엔 추론 불필요해 thinking 최소화(0은 빈응답 유발 금지, 64 클램프)
    config: { temperature: 0, maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 64 }, safetySettings: COMPANION_SAFETY_SETTINGS, abortSignal: timeoutSignal(LLM_TIMEOUT_MS.stt) },
  });
  logUsage("stt", res);
  // isUserSpeech: STT 결과는 사용자 발화 — 동반자 출력용 보고체 필터(KO_REPORTIVE)를 적용하면
  // 어르신 간접화법("의사가 약 바꾸라고 한다") 문장이 전사에서 소실됨.
  return extractText(res, { isUserSpeech: true }).trim();
}

/** 4) 음성 요청 — 2단계: STT → 대화 모델 */

/**
 * 스트리밍 응답 — LLM을 generateContentStream으로 받아 문장이 완성될 때마다 SSE로 내보내
 * 클라이언트가 첫 문장부터 바로 말하게 한다(체감 지연 최소화).
 *
 * 안전망: 말해지는(spoken) 문장은 문장단위 postProcessReply로 누출 차단(빈 결과 문장은 skip),
 *        저장·분석되는 canonical 전체 텍스트는 전체 postProcessReply + factCheck로 처리.
 *        (factCheck의 환각-이름 grounding은 전체 기준이라 음성엔 narrow한 잔여 위험 — Stage 2 트레이드오프)
 */
function streamCompanionReply(opts: {
  model: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateContentStream: (p: any) => Promise<{ stream: AsyncIterable<{ text: () => string }>; response?: unknown }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generateContent?: (p: any) => Promise<unknown>;
  };
  contents: unknown;
  fallback: string;
  post: { userText: string; companionName: string; ctx: string; honorific: string; family: FullProfile["family"]; prevAi: string; answeringProbe?: boolean };
  fact: { profile: FullProfile; recentUserText: string; memories: string; honorific: string; companionName: string; currentUserText: string };
  extra?: Record<string, unknown>;
  timings?: Record<string, number>; // 계측(있으면 done에 실어 보냄)
  onComplete: (fullText: string, fallbackUsed: boolean) => Promise<void>;
}): Response {
  const SENTENCE_RE = /[^.!?…。\n]*[.!?…。\n]+/g;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: unknown) => { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`)); } catch { /* closed */ } };
      // 메타(예: transcription)를 먼저 보내 클라이언트가 사용자 발화를 즉시 표시하게 함
      if (opts.extra && Object.keys(opts.extra).length > 0) send({ type: "meta", ...opts.extra });
      if (opts.timings) opts.timings.genStartMs = Math.round(performance.now() - opts.timings.start);
      let raw = "";
      let buffer = "";
      let spokenAny = false;
      const emitSafe = (sentence: string) => {
        const s = sentence.trim();
        if (!s) return;
        const safe = postProcessReply(s, opts.post).trim();
        if (safe) {
          if (opts.timings && !opts.timings.ttfChunkMs) opts.timings.ttfChunkMs = Math.round(performance.now() - opts.timings.start);
          send({ type: "chunk", text: safe }); spokenAny = true;
        }
      };
      const flush = (final: boolean) => {
        SENTENCE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        let lastEnd = 0;
        while ((m = SENTENCE_RE.exec(buffer)) !== null) { emitSafe(m[0]); lastEnd = SENTENCE_RE.lastIndex; }
        buffer = buffer.slice(lastEnd);
        if (final && buffer.trim()) { emitSafe(buffer); buffer = ""; }
      };
      try {
        let streamErrored = false;
        try {
          const result = await opts.model.generateContentStream(opts.contents);
          for await (const chunk of result.stream) {
            let piece = "";
            try { piece = (typeof chunk.text === "function" ? chunk.text() : "") || ""; } catch { piece = ""; } // 차단/빈 청크에서 throw 방지
            if (!piece) continue;
            raw += piece; buffer += piece;
            flush(false);
          }
          flush(true);
          try { logUsage("companion", await result.response); } catch { /* usage 로깅 best-effort */ }
        } catch (e) {
          streamErrored = true;
          console.warn("[stream] generate error:", (e as Error).message);
        }

        // 스트림이 중도에 끊겼으면 raw를 마지막 완전 문장까지 절단 — 미완 조각("…그런데 오늘")이
        // canonical로 저장·분석되는 것 방지. 완전 문장이 하나도 없으면 빈 문자열 → 아래 재시도로 진입.
        if (streamErrored && raw.trim()) {
          const lastEnd = Math.max(...[...raw.matchAll(/[.!?…。]/g)].map((m) => m.index ?? -1), -1);
          raw = lastEnd >= 0 ? raw.slice(0, lastEnd + 1) : "";
        }

        // 스트림이 비었으면(간헐 빈응답·일시 503) 비스트리밍 1회 재시도 — 폴백률의 직접 원인.
        //   비스트리밍 경로(generateWithFallback)는 원래 2회 시도하는데 스트림 경로만 무재시도였음.
        if (!raw.trim() && typeof opts.model.generateContent === "function") {
          try {
            const retryRes = await opts.model.generateContent(opts.contents);
            logUsage("companion-retry", retryRes);
            raw = extractText(retryRes);
            if (raw.trim()) { buffer = raw; flush(true); } // 재시도 응답도 문장 단위로 발화
          } catch (e2) {
            console.warn("[stream] non-stream retry failed:", (e2 as Error).message);
          }
        }

        // 저장·분석용 canonical 전체 텍스트 — 전체 안전망 + factCheck
        let fullText = raw.trim() ? postProcessReply(raw, opts.post) : "";
        if (fullText.trim()) {
          const fc = factCheckResponse({ aiText: fullText, ...opts.fact });
          if (fc.cleaned !== fullText) { console.warn("[fact-checker:stream] cleaned. removed:", fc.removed.length); fullText = fc.cleaned || fullText; }
        }
        // 폴백 여부를 onComplete에 정확히 전달 — 폴백 멘트가 인지분석·RAG에 들어가 오염되는 것 방지
        let fallbackUsed = false;
        if (!fullText || !fullText.trim()) { fullText = opts.fallback; fallbackUsed = true; }
        if (!spokenAny) send({ type: "chunk", text: fullText }); // 스트림에 아무것도 못 내보냈으면 fallback이라도 말함
        if (opts.timings) opts.timings.totalMs = Math.round(performance.now() - opts.timings.start);
        const includeTiming = opts.timings && process.env.DEBUG_TIMING === "1"; // 측정용(기본 off)
        send({ type: "done", text: fullText, ...(opts.extra || {}), ...(includeTiming ? { timing: opts.timings } : {}) });
        await opts.onComplete(fullText, fallbackUsed).catch((e) => console.error("[stream:onComplete]", e));
      } catch (e) {
        // 후처리·factCheck 등 파이프라인 예외의 마지막 안전망
        console.warn("[stream] pipeline error:", (e as Error).message);
        if (!spokenAny) send({ type: "chunk", text: opts.fallback });
        send({ type: "done", text: opts.fallback, ...(opts.extra || {}) });
        await opts.onComplete(opts.fallback, true).catch((err) => console.error("[stream:onComplete:fallback]", err));
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}

async function handleAudioMessage(params: {
  systemPrompt: string; stablePrompt: string; turnBlock: string; envBlock: string; honorific: string; userName: string;
  companionName: string; companionRelation: string;
  userId: string; conversationId?: string;
  sttPromise: Promise<string>; historyText: string;
  messages: { role: string; content: string; createdAt?: string }[];
  profile: FullProfile;
  clientTimeIso?: string;
  timings?: Record<string, number>;
  mode: "user" | "pro" | "general";
  /** 이번 턴에 인지 질문을 던져야 하는가 — 동반자 모델 상향 판단용 */
  probeTurn: boolean;
  /** 이번 턴 또는 직전 턴이 확인 턴인가 — 분석기 정밀 채점 라우팅용 */
  probeContext: boolean;
  /** 직전 턴이 확인 턴 — 즉시기억 과제 채점 보존용 */
  answeringProbe: boolean;
}) {
  const { systemPrompt, stablePrompt, turnBlock, envBlock, honorific, companionName, userId, conversationId, sttPromise, historyText, messages, profile, clientTimeIso, timings, mode, probeTurn, probeContext, answeringProbe } = params;

  // 1단계: 음성 → 텍스트 변환 — POST 초입에서 이미 시작됨(프롬프트 빌드와 병렬). 여기선 대기만.
  const transcription0 = await sttPromise;
  if (timings) timings.sttMs = Math.round(performance.now() - timings.start);
  let transcription = transcription0 || "";

  // 1.4단계: 응급 발화 감지 — moderation·STT 게이트보다 먼저 (안전 우선)
  const emergency = await evaluateEmergency({ userContent: transcription, conversationId });
  if (emergency.effectiveLevel === 3) {
    return handleEmergencyL3({
      result: emergency.result, userContent: transcription,
      conversationId, userId, honorific, companionName, transcription,
      replyOverride: await mentalCrisisReply(mode, userId, transcription, honorific, companionName),
    });
  }

  // 1.45단계: STT 신뢰도 게이트 — 인식 결과가 잡음/짧음/오인식이면 LLM 우회하고 재질문
  //   응급/모더레이션 매칭이 없는 경우에만 실행. 신뢰도 통과한 발화만 인지 분석에 들어가도록.
  /**
   * ⚠ 주석은 "응급 매칭이 없는 경우에만"이라고 선언했지만 **코드에 그 조건이 없었다**
   *   (2026-10-02 적대 리뷰). 위에서 L3만 단락시키고 L1·L2는 그대로 이 게이트에 들어왔다.
   *
   *   왜 치명적인가: 치매의 전형적 보속증("먹기 싫어"×4)은 evaluateSttConfidence가
   *   `vocabulary collapse`로 떨어뜨리는데, 바로 그 발화를 detectEmergency가 L1로 잡는다.
   *   게이트가 발동하면 emergencyLevel 없이 `(STT 저신뢰: …)` 태그로만 저장돼
   *     (1) L1 누적 앵커가 안 남아 24h 3회 → L2 승격이 영구히 안 걸리고
   *     (2) L2였다면 보호자 알림 0건이며
   *     (3) 반복 발화 자체가 인지 증상인데 인지 분석까지 함께 건너뛰어진다.
   *   stt-confidence.ts 헤더의 "응급 감지는 STT 신뢰도와 무관하게 먼저"라는 불변식과도 반대였다.
   */
  const sttConf = evaluateSttConfidence(transcription);
  if (!sttConf.pass && emergency.effectiveLevel > 0) {
    console.log("[stt-confidence] 저신뢰이나 응급 신호 동반 — 게이트 우회(마킹·알림·분석 보존):",
      sttConf.reason, "L" + emergency.effectiveLevel);
  }
  if (!sttConf.pass && emergency.effectiveLevel === 0) {
    console.log("[stt-confidence] failed:", sttConf.reason, "txLen:", transcription.length); // PII(발화 원문) 미로깅
    const clarification = buildClarificationReply(honorific, companionName);
    if (conversationId) {
      // 사용자 발화는 잡음/오인식이므로 따로 마커를 붙여 저장 (디버깅용)
      const userTag = transcription && transcription.trim().length > 0
        ? `(STT 저신뢰: ${transcription.trim().slice(0, 60)})`
        : "(음성 메시지 — 인식 실패)";
      await saveMessages({
        conversationId, userId,
        userContent: userTag,
        assistantContent: clarification,
      });
    }
    return NextResponse.json({
      text: clarification, transcription, role: "assistant",
      sttFailed: true, sttReason: sttConf.reason,
    });
  }

  // 1.48단계: 맥락 기반 STT 보정 — 직전 AI 발화 도메인에 맞춰 어휘 교정
  //   "미빈밥" → "비빔밥", "혈양약" → "혈압약" 같은 오인식을 인지 분석기 도달 전에 차단.
  const lastAi = extractLastAiMessage(historyText);
  const correction = correctTranscriptionByContext(transcription, lastAi);
  if (correction.changes.length > 0) {
    if ((process.env.DEBUG_INPUT === "1" && process.env.NODE_ENV !== "production")) {
      // PII(발화 원문) 포함 — DEBUG_INPUT일 때만 출력
      console.log("[stt-context-correction]", JSON.stringify({
        original: transcription,
        corrected: correction.corrected,
        changes: correction.changes,
      }));
    } else {
      console.log("[stt-context-correction]", JSON.stringify({ changeCount: correction.changes.length })); // PII(발화 원문) 미로깅
    }
    transcription = correction.corrected;
  }

  // 1.49단계: T3 마음 건강 체크 — 일반인(general) 전용 (모드 간 플로우 비혼합 원칙: 사용자/전문가=인지 선별, 일반인=정신건강)
  const mentalVoice = mode === "general"
    ? await handleMentalFlow({ userId, userContent: transcription, honorific, companionName })
    : null;
  if (mentalVoice) {
    if (conversationId) {
      await saveMessages({ conversationId, userId, userContent: transcription || "(음성 메시지)", assistantContent: mentalVoice.reply, skipAssistantEmbedding: true, skipUserEmbedding: true });
    }
    return NextResponse.json({ text: mentalVoice.reply, role: "assistant", transcription, mental: mentalVoice.status });
  }

  // 1.5단계: 부적절 발언 감지 + RAG 검색 병렬 실행.
  //   RAG는 transcription(현재 발화) 기준 — 이전엔 STT 전의 직전 턴 텍스트로 검색해 무관한 메모리가 주입됐음.
  const [moderated, memories] = await Promise.all([
    handleInappropriateMessage({
      userContent: transcription,
      conversationId,
      userId,
      honorific,
      companionName,
      transcription,
      emergency,   // 응급+부적절 동시 발화에서 응급 마킹·L2 알림이 사라지지 않게(2026-10-02)
    }),
    fetchMemories(userId, transcription),
  ]);
  if (moderated) return moderated as NextResponse;

  // 1.55단계: 날짜/시간 질문 단락 — LLM 우회 (음성 "지금 몇 시야" 풀콜 방지).
  //   moderation 뒤에 위치(욕설+시간질문이 거절 카운트를 우회하는 것 방지) +
  //   L1/L2 응급 신호 동반 시("며칠째 잠을 못 자… 지금 몇 시야?") 단락하지 않고 일반 경로로
  //   — emergencyLevel 마킹·L2 보호자 알림·hint 주입이 단락에 삼켜지지 않도록.
  if (transcription && emergency.effectiveLevel === 0 && isDateTimeQuestion(transcription)) {
    return handleDateTimeQuestion(transcription, honorific, conversationId, userId, clientTimeIso, transcription);
  }

  // 2단계: 변환된 텍스트로 대화 모델 호출. info_request만 googleSearch 활성(그 외 비활성, 비용·지연 절감)
  const intent = classifyIntent(transcription);
  const useSearch = intent.intents.includes("info_request");
  // 명시적 프롬프트 캐시(env PROMPT_CACHE=1): 안정 프리픽스를 캐시로, 동적 turnBlock은 contents로. 실패·비활성 시 비캐시 폴백.
  //   확인 턴은 캐시 우회 — Gemini 캐시는 생성 모델(2.5)에 종속이라 상향 모델과 함께 쓸 수 없음.
  const prefixCache = useSearch || probeTurn ? null : await getPrefixCache(userId, stablePrompt);
  // ⚠ 캐시 경로에도 probeTurn을 **반드시** 넘긴다. 빠지면 기본값 false가 되어 확인 턴이
  //   COMPANION_MODEL(2.5-flash)로 조용히 강등된다 — 2026-09-30에 "지시 준수가 깨져
  //   인지 선별이 소리 없이 멈춘" 사고와 같은 유형이다. 지금은 위 가드(probeTurn이면 캐시 미사용)
  //   덕에 발현되지 않지만, 그 가드를 누가 지우는 순간 터진다. 인자로 못박아 둔다.
  const model = prefixCache ? getTextModel("", useSearch, prefixCache, probeTurn) : getTextModel(systemPrompt, useSearch, undefined, probeTurn);
  const repetitionHint = buildRepetitionHint(transcription);
  const wordGameHint = buildWordGameHint(historyText, transcription);
  const nameAnswerHint = buildNameAnswerHint(historyText, transcription);
  const recallVerifyHint = buildRecallVerificationHint(historyText, transcription, companionName);
  const anomalyHint = buildAnomalyCorrectionHint(transcription);
  const familyQueryGuard = buildFamilyQueryGuard(transcription, profile.family);
  const infoRequestHint = buildInfoRequestHint(transcription, companionName);
  const intentHint = buildIntentHint(intent, honorific);
  if (intent.primary !== "daily") {
    console.log("[intent:audio]", JSON.stringify({ primary: intent.primary, all: intent.intents }));
  }
  const recentUserTexts = messages.filter((m) => m.role === "user").slice(-3).map((m) => m.content);
  const hintBlock = [
    intentHint, repetitionHint, wordGameHint, nameAnswerHint, recallVerifyHint, anomalyHint, familyQueryGuard, infoRequestHint, emergency.hint,
    buildProbeHoldHint(probeTurn, emergency.effectiveLevel),
    buildParentReferentHint(transcription, honorific),
    buildMentalCheckOfferHint(mode, transcription, historyText),
    buildEngagementHint(detectLowEngagement(transcription, recentUserTexts)),
  ].filter((s) => s && s.trim()).join("\n\n");
  const currentUserMsg = transcription || "(음성을 인식하지 못했습니다)";
  // 캐시 사용 시 systemInstruction에서 빠진 turnBlock(동적 지시)을 contents 앞에 실어 모델에 전달
  const effectiveHint = prefixCache ? [turnBlock, hintBlock].filter(Boolean).join("\n\n") : hintBlock;
  const contents = buildChatContents({ messages, currentUserMessage: currentUserMsg, memories, hintBlock: effectiveHint });

  const fallback = buildFallbackMessage(honorific, companionName);
  const ctx = `${memories || ""}\n${historyText || ""}\n${transcription || ""}`;
  const prevAi = extractLastAiMessage(historyText);
  const recentUserText = messages.filter((m) => m.role === "user").slice(-6).map((m) => m.content).join(" ");

  // 스트리밍 응답 — 음성도 첫 문장부터 SSE로. transcription은 done 이벤트(extra)로 전달.
  return streamCompanionReply({
    model,
    contents: { contents },
    fallback,
    post: { userText: transcription, companionName, ctx, honorific, family: profile.family, prevAi, answeringProbe },
    fact: { profile, recentUserText, memories: memories || "", honorific, companionName, currentUserText: transcription },
    extra: { transcription, ...(emergency.effectiveLevel > 0 ? { emergency: { level: emergency.effectiveLevel, category: emergency.result.category } } : {}) },
    timings,
    onComplete: async (answerText, fallbackUsed) => {
      if (!conversationId) return;
      /**
       * ⚠ 저장 실패가 **L2 보호자 알림까지 삼키면 안 된다**(2026-10-02 적대 리뷰).
       *   L3는 2026-10-01에 격리했는데 L2 경로 셋은 그대로였다. await가 throw하면
       *   아래 알림 블록과 배경 작업이 통째로 건너뛰어져, "주의 신호인데 보호자가 모른다"가 된다.
       *   FCM·이메일은 Message 행 없이도 나간다 — 마킹만 생략될 뿐이다.
       */
      let userMsgId: string | undefined;
      try {
        ({ userMsgId } = await saveMessages({
          conversationId, userId,
          userContent: transcription || "(음성 메시지)",
          assistantContent: answerText,
          emergencyLevel: emergency.effectiveLevel > 0 ? emergency.effectiveLevel : undefined,
          emergencyEvidence: emergency.result.level > 0 ? `${emergency.result.category}:${emergency.result.evidence}` : undefined,
          skipAssistantEmbedding: fallbackUsed, // 폴백 멘트는 RAG 오염 방지 위해 임베딩 제외
        }));
      } catch (e) {
        console.error("[chat/audio] 저장 실패 — 알림·배경작업은 계속:", e instanceof Error ? e.message : e);
      }
      if (emergency.effectiveLevel === 2) {
        // 부유 프라미스 금지(2026-07-07 감사) — after()로 실행 보장, 컨텍스트 밖이면 여기서 await.
        //   onComplete는 스트림 close 전에 await되고 'done' 이벤트는 이미 전송됐으므로 체감 지연 없음.
        const sendL2Notify = async () => {
          try {
            const r = await notifyGuardian({
              userId, userName: honorific, messageId: userMsgId, level: 2,
              category: emergency.result.category, content: transcription, aiReply: answerText, createdAt: new Date(),
            });
            if (r.sent) console.log("[emergency-notify] L2 sent:", r.channels);
            else console.warn("[emergency-notify] L2 not sent:", r.reason);
          } catch (e) { console.error("[emergency-notify] L2 error:", e); }
        };
        try { after(sendL2Notify); } catch { await sendL2Notify(); }
      }
      // 배경 작업 — 응답 스트림이 닫힌 뒤 수 초간 실행되므로 부유 프라미스로 두면
      //   서버리스(Vercel)가 인스턴스를 freeze할 때 **조용히 유실**된다.
      //   그러면 그 턴의 cognitive_assessments가 저장되지 않고, "이상 없음"과 "분석 안 됨"이
      //   DB에서 구별되지 않아 의사 리포트에 조용한 공백이 생긴다.
      //   같은 파일의 응급 알림(2026-07-07 감사)과 /api/live/turn은 이미 after()를 쓰는데
      //   메인 대화 경로만 빠져 있었다(2026-10-01 감사). 동일 패턴으로 통일한다.
      const bgTasks = async () => {
        // 폴백 턴에도 인지분석은 수행 — 분석 대상은 사용자 발화이므로 폴백과 무관하게 유효.
        // 단 AI 발화로 폴백 멘트를 넘기면 probe 감지·도메인 자동기록이 오염되므로 빈 문자열로 대체.
        // 일반인(general)은 인지 선별 대상이 아님 — 분석 미수행(목적 분리 + 비용 절감)
        // 저장 실패로 userMsgId가 없으면 인지 분석을 건너뛴다 — cognitive_assessments가
        //   message_id를 참조하므로 저장할 곳이 없다. 알림은 위에서 이미 독립적으로 나갔다.
        if (mode !== "general" && userMsgId) {
          await runCognitiveAnalysis({ userId, conversationId, userMsgId, userMessage: transcription, assistantResponse: fallbackUsed ? "" : answerText, historyText, envBlock, honorific, probeContext, answeringProbe }).catch((e) => console.error("[bg-cognitive]", e));
        }
        if (transcription) {
          await extractAndSaveProfile({ userId, userMessage: transcription, userMessageId: userMsgId }).catch((e) => console.error("[bg-profile-extract:audio]", e));
          await maybeTriggerSummaryRollup({ userId, conversationId }).catch((e) => console.error("[bg-summary-trigger:audio]", e));
        }
      };
      try { after(bgTasks); } catch { bgTasks().catch(() => {}); }
    },
  });
}

/*
 * 응급 발화 감지(evaluateEmergency)는 lib/chat/emergency-evaluate.ts로 옮겼다(2026-10-06).
 *   - L3: LLM 우회 즉시 응급 안내 반환 + Message에 마킹
 *   - L2: hint를 호출자에게 반환(LLM 프롬프트에 주입) + Message에 마킹
 *   - L1: 24h 누적 ≥3이면 L2로 승격하여 hint 반환, 아니면 마킹만
 *   - 0: noop
 * 옮긴 이유: 상시 감시·Live가 이 3단계 중 **승격 단계만 빠뜨린 복사본**을 쓰고 있었다 — 같은 L1
 *   신호가 경로에 따라 보호자 알림이 되기도 하고 영원히 묻히기도 했다. 이제 세 경로가 한 함수를 쓴다.
 */

/**
 * 일반인 정신건강 점검 중 **위기 문항(PHQ-9 9번)**의 양성 답이면, 그 답을 기록하고 점검 흐름의 응답을 돌려준다.
 *   L3 위기 대응(응급 마킹·보호자 알림)은 호출부의 handleEmergencyL3가 그대로 한다 — 말만 바뀐다.
 * 결함(2026-10-06 직접 운전): L3 즉답이 먼저 나가 9번 답이 버려졌고, 다음 턴에 같은 자살 사고 문항을 다시 물었다.
 * 실패하면 undefined — 기본 L3 안내로 간다(위기 대응이 점검 기록보다 우선).
 */
async function mentalCrisisReply(mode: "user" | "pro" | "general", userId: string, userContent: string, honorific: string, companionName: string): Promise<string | undefined> {
  if (mode !== "general") return undefined;
  const r = await handleMentalFlow({ userId, userContent, honorific, companionName, onlyCrisisAnswer: true }).catch((e) => {
    console.error("[mental] 위기 문항 답 기록 실패 — 기본 L3 안내로:", e instanceof Error ? e.message : e);
    return null;
  });
  return r?.crisis ? r.reply : undefined;
}

async function handleEmergencyL3(params: {
  result: EmergencyResult;
  userContent: string;
  conversationId: string | undefined;
  userId: string;
  honorific: string;
  companionName: string;
  transcription?: string;
  /** 위기 대응(응급 마킹·보호자 알림)은 그대로 하고 말만 바꿀 때 — 일반인 점검의 위기 문항 답 */
  replyOverride?: string;
}): Promise<NextResponse> {
  const { result, userContent, conversationId, userId, honorific, companionName, transcription } = params;
  // 일반인 정신건강 점검의 위기 문항 양성 답이면 점검 흐름의 응답(위기 상담 안내 + 결과·돌봄)을 쓴다 — 아래 저장·알림은 동일
  const reply = params.replyOverride ?? buildEmergencyL3Reply(honorific, companionName, result.category);

  /**
   * 저장 실패가 '119 안내'와 '보호자 알림'을 함께 삼키지 않게 분리한다(2026-10-01).
   *   이전 구조는 (a) 알림 전체가 `if (conversationId)` 안에 있어 대화 ID가 없는 턴이면
   *   어르신에게 119 안내만 뜨고 **보호자 알림 0건·기록 0건**이었고,
   *   (b) `saveMessages`가 await라 쓰기 실패 시 예외가 전파돼 119 안내까지 못 보고 500이 됐다.
   *
   * ⚠ **보장 범위를 정확히 알 것.** 여기서 막는 건 "L3 판정 이후의 쓰기 실패"뿐이다.
   *   이 함수에 **도달하기 전에** DB를 치는 지점이 넷 남아 있다(동의 게이트 / 대리검사 링크·환자 조회 /
   *   conversationId 소유권 검증 / buildSystemPrompt 내부 Promise.all). 거기서 터지면 이 함수는
   *   아예 실행되지 않는다 — 대신 POST의 catch가 `emergencyLastResort`로 흘러
   *   119 안내 + 보호자 알림을 DB 없이 재시도한다(2026-10-02).
   *   따라서 "RDS가 죽어도 119 안내는 나간다"는 이제 참이지만, **그 턴은 DB에 기록되지 않는다**
   *   (응답의 degraded:true가 그 사실을 알린다). 기록 공백은 dedup 앵커도 없다는 뜻이라,
   *   같은 응급이 다음 턴에 다시 발송될 수 있다 — emergency-notify의 메모리 fan-out 상한이 그 선을 잡는다.
   */
  let userMsgId: string | undefined;
  if (conversationId) {
    try {
      ({ userMsgId } = await saveMessages({
        conversationId,
        userId,
        userContent: transcription !== undefined ? (transcription || "(음성 메시지)") : userContent,
        assistantContent: reply,
        emergencyLevel: 3,
        emergencyEvidence: `${result.category}:${result.evidence}`,
      }));
    } catch (e) {
      console.error("[emergency] L3 저장 실패 — 119 안내·보호자 알림은 계속 진행:", e instanceof Error ? e.message : e);
    }
  } else {
    console.warn("[emergency] L3인데 conversationId 없음 — 기록 없이 알림만 발송");
  }

  // 보호자 알림 — 저장 성공 여부와 무관하게 시도한다(FCM·이메일은 메시지 행이 없어도 나간다).
  //   after()로 응답 후 실행을 "보장"하며 발송(응답 지연 없음).
  //   ⚠ 부유 프라미스 금지(2026-07-07 감사 blocker): .then()으로 떠 있으면 Vercel이 응답 반환 직후
  //   함수를 suspend할 때 알림이 무기록 유실될 수 있음. after()는 waitUntil로 함수 수명을 연장함.
  const sendL3Notify = async () => {
    try {
      const r = await notifyGuardian({
        userId,
        userName: honorific,
        messageId: userMsgId,
        level: 3,
        category: result.category,
        content: (transcription ?? userContent) || "",
        aiReply: reply,
        createdAt: new Date(),
      });
      if (r.sent) console.log("[emergency-notify] L3 sent:", r.channels);
      else console.warn("[emergency-notify] L3 not sent:", r.reason);
    } catch (e) {
      console.error("[emergency-notify] L3 error:", e);
    }
  };
  try {
    after(sendL3Notify);
  } catch {
    await sendL3Notify(); // 요청 컨텍스트 밖(예: 테스트 하네스) — 응답 전에 직접 완료 보장
  }
  const payload: Record<string, unknown> = { text: reply, role: "assistant", emergency: { level: 3, category: result.category } };
  if (transcription !== undefined) payload.transcription = transcription;
  return NextResponse.json(payload);
}

/**
 * 부적절 발언 감지 시 LLM 우회. 같은 세션 내 같은 카테고리 발생 횟수를 조회해
 * 단계적 거절 멘트를 반환하고 저장한다.
 *
 * @returns 처리된 경우 NextResponse, 정상 발화면 null
 */
async function handleInappropriateMessage(params: {
  userContent: string;
  conversationId: string | undefined;
  userId: string;
  honorific: string;
  companionName: string;
  transcription?: string;
  /**
   * 호출 전에 평가한 응급 결과 — 거절 멘트 경로도 **마킹·L2 알림을 수행해야 한다**.
   *
   * 결함(2026-10-02 적대 리뷰): 이 함수가 emergency를 아예 받지 않아, 응급과 부적절 발언이
   *   한 발화에 겹치면 응급 쪽이 통째로 사라졌다. 치매의 초조(agitation)에서 욕설 동반은
   *   드문 조합이 아니다 — 예: "아무나 도와줘, 이 씨X 놈들아"는 L2 dizziness_help + profanity다.
   *   그 턴은 거절 멘트만 저장되고 emergencyLevel 없이 끝나 보호자 알림 0건·위급 이력 0건이었다.
   *   같은 라우트의 handleExamTurn은 emergency를 받아 마킹까지 하므로 경로 간 비대칭이기도 했다.
   */
  emergency?: { effectiveLevel: 0 | 1 | 2 | 3; result: EmergencyResult };
}): Promise<Response | null> {
  const { userContent, conversationId, userId, honorific, companionName, transcription, emergency } = params;
  const moderation = detectInappropriate(userContent);
  if (moderation.category === "ok") return null;

  // 같은 세션에서 이전에 같은 카테고리 거절 멘트가 얼마나 발생했는지 카운트
  let occurrence = 1;
  if (conversationId) {
    const signature = `__mod:${moderation.category}__`;
    const prev = await prisma.message.count({
      where: { conversationId, role: "assistant", content: { contains: signature } },
    });
    occurrence = prev + 1;
  }

  // 과거의 자살 생각을 "지금은 괜찮다"며 말한 경우 — 위기 즉답 대신 공감·후속 확인·상담 번호(B9, 2026-10-06 사용자 결정).
  //   기록(L2 마킹)과 보호자 알림은 아래에서 그대로 한다 — 과거 자살 생각도 가족이 알아야 할 위험 신호다.
  const reply = moderation.category === "self_harm" && isPastResolvedSelfHarm(userContent)
    ? buildPastSelfHarmReply(honorific, companionName)
    : buildModerationReply(moderation.category, occurrence, honorific, companionName);
  // 저장본은 표시 안 보이는 메타 시그니처를 끝에 붙여 향후 카운트에 사용
  const stored = `${reply}\n<!-- __mod:${moderation.category}__ -->`;

  const lvl = emergency?.effectiveLevel ?? 0;
  let userMsgId: string | undefined;
  if (conversationId) {
    // ⚠ 저장 실패가 아래 L2 알림을 삼키지 않게 격리(다른 경로와 동일 처방).
    try {
      ({ userMsgId } = await saveMessages({
        conversationId,
        userId,
        userContent: transcription !== undefined ? (transcription || "(음성 메시지)") : userContent,
        assistantContent: stored,
        // 응급 신호가 섞인 발화는 거절 멘트로 끝나더라도 마킹해야 추세·L1 누적·보호자 화면에 반영된다.
        emergencyLevel: lvl > 0 ? lvl : undefined,
        emergencyEvidence: emergency && emergency.result.level > 0
          ? `${emergency.result.category}:${emergency.result.evidence}` : undefined,
      }));
    } catch (e) {
      console.error("[moderation] 저장 실패 — L2 알림은 계속:", e instanceof Error ? e.message : e);
    }
  }
  if (lvl === 2 && emergency) {
    const sendL2 = async () => {
      try {
        const r = await notifyGuardian({
          userId, userName: honorific, messageId: userMsgId, level: 2,
          category: emergency.result.category,
          content: transcription ?? userContent, aiReply: reply, createdAt: new Date(),
        });
        if (r.sent) console.log("[emergency-notify] L2(moderated) sent:", r.channels);
        else console.warn("[emergency-notify] L2(moderated) not sent:", r.reason);
      } catch (e) { console.error("[emergency-notify] L2(moderated) error:", e); }
    };
    try { after(sendL2); } catch { await sendL2(); }
  }
  const payload: Record<string, unknown> = { text: reply, role: "assistant", moderated: moderation.category };
  if (transcription !== undefined) payload.transcription = transcription;
  return NextResponse.json(payload);
}

/** 5) 텍스트 요청 (텍스트 모델 — 순수 텍스트 응답) */
async function handleTextMessage(params: {
  systemPrompt: string; stablePrompt: string; turnBlock: string; envBlock: string;
  userId: string; conversationId?: string;
  userContent: string; historyText: string; memories: string;
  messages: { role: string; content: string; createdAt?: string }[];
  companionName: string; companionRelation: string; honorific: string;
  profile: FullProfile;
  timings?: Record<string, number>;
  mode: "user" | "pro" | "general";
  probeTurn: boolean;
  probeContext: boolean;
  /** 직전 턴이 확인 턴 — 즉시기억 과제 채점 보존용 */
  answeringProbe: boolean;
}) {
  const { systemPrompt, stablePrompt, turnBlock, envBlock, userId, conversationId, userContent, historyText, memories, messages, companionName, honorific, profile, timings, mode, probeTurn, probeContext, answeringProbe } = params;

  // 응급 발화 감지 — moderation보다 먼저
  const emergency = await evaluateEmergency({ userContent, conversationId });
  if (emergency.effectiveLevel === 3) {
    return handleEmergencyL3({
      result: emergency.result, userContent,
      conversationId, userId, honorific, companionName,
      replyOverride: await mentalCrisisReply(mode, userId, userContent, honorific, companionName),
    });
  }

  // T3 마음 건강 체크(PHQ-9 등) — 일반인(general) 전용. 응급(L3) 이후·모더레이션 이전:
  //   9번 문항 답변("죽고 싶다는 생각이 며칠…")이 self_harm 모더레이션에 가로채여 검진이 끊기지 않도록.
  //   검진 턴은 LLM 우회 즉답(JSON) — 정형 문항이라 RAG 임베딩도 제외.
  //   사용자/전문가 모드에선 미작동 — 모드 간 플로우 비혼합 원칙(사용자·전문가=인지 선별, 일반인=정신건강).
  const mental = mode === "general"
    ? await handleMentalFlow({ userId, userContent, honorific, companionName })
    : null;
  if (mental) {
    if (conversationId) {
      await saveMessages({ conversationId, userId, userContent, assistantContent: mental.reply, skipAssistantEmbedding: true, skipUserEmbedding: true });
    }
    return NextResponse.json({ text: mental.reply, role: "assistant", mental: mental.status });
  }

  // 부적절 발언 감지 시 LLM 우회 + 단계적 거절
  const moderated = await handleInappropriateMessage({
    userContent,
    conversationId,
    userId,
    honorific,
    companionName,
    emergency,   // 응급+부적절 동시 발화에서 응급 마킹·L2 알림이 사라지지 않게(2026-10-02)
  });
  if (moderated) return moderated as NextResponse;

  // 의도 분류 먼저 — info_request(실시간 정보)만 googleSearch 활성, 그 외엔 비활성(비용·지연 절감)
  const intent = classifyIntent(userContent);
  const useSearch = intent.intents.includes("info_request");
  // 명시적 프롬프트 캐시(env PROMPT_CACHE=1): 안정 프리픽스를 캐시로, 동적 turnBlock은 contents로. 실패·비활성 시 비캐시 폴백.
  //   확인 턴은 캐시 우회 — Gemini 캐시는 생성 모델(2.5)에 종속이라 상향 모델과 함께 쓸 수 없음.
  const prefixCache = useSearch || probeTurn ? null : await getPrefixCache(userId, stablePrompt);
  // ⚠ 캐시 경로에도 probeTurn을 **반드시** 넘긴다. 빠지면 기본값 false가 되어 확인 턴이
  //   COMPANION_MODEL(2.5-flash)로 조용히 강등된다 — 2026-09-30에 "지시 준수가 깨져
  //   인지 선별이 소리 없이 멈춘" 사고와 같은 유형이다. 지금은 위 가드(probeTurn이면 캐시 미사용)
  //   덕에 발현되지 않지만, 그 가드를 누가 지우는 순간 터진다. 인자로 못박아 둔다.
  const model = prefixCache ? getTextModel("", useSearch, prefixCache, probeTurn) : getTextModel(systemPrompt, useSearch, undefined, probeTurn);

  const repetitionHint = buildRepetitionHint(userContent);
  const wordGameHint = buildWordGameHint(historyText, userContent);
  const nameAnswerHint = buildNameAnswerHint(historyText, userContent);
  const recallVerifyHint = buildRecallVerificationHint(historyText, userContent, companionName);
  const anomalyHint = buildAnomalyCorrectionHint(userContent);
  const familyQueryGuard = buildFamilyQueryGuard(userContent, profile.family);
  const infoRequestHint = buildInfoRequestHint(userContent, companionName);
  // Phase C: 의도 분류기 — 발화 유형에 따라 prompt 분기 강제 (intent는 위에서 분류)
  const intentHint = buildIntentHint(intent, honorific);
  if (intent.primary !== "daily") {
    console.log("[intent]", JSON.stringify({ primary: intent.primary, all: intent.intents }));
  }
  const recentUserTexts = messages.filter((m) => m.role === "user").slice(-3).map((m) => m.content);
  const hintBlock = [
    intentHint, repetitionHint, wordGameHint, nameAnswerHint, recallVerifyHint, anomalyHint, familyQueryGuard, infoRequestHint, emergency.hint,
    buildProbeHoldHint(probeTurn, emergency.effectiveLevel),
    buildParentReferentHint(userContent, honorific),
    buildMentalCheckOfferHint(mode, userContent, historyText),
    buildEngagementHint(detectLowEngagement(userContent, recentUserTexts)),
  ].filter((s) => s && s.trim()).join("\n\n");

  // 캐시 사용 시 systemInstruction에서 빠진 turnBlock(동적 지시)을 contents 앞에 실어 모델에 전달
  const effectiveHint = prefixCache ? [turnBlock, hintBlock].filter(Boolean).join("\n\n") : hintBlock;
  const contents = buildChatContents({ messages, currentUserMessage: userContent, memories, hintBlock: effectiveHint });

  // DEBUG: 환경변수 DEBUG_INPUT=1 설정 시 입력 dump (사용자 간 데이터 누수 진단용).
  //   2026-05-26 abc→rudtjrch 누수 root cause 추적에 사용됨. 평소엔 off.
  if ((process.env.DEBUG_INPUT === "1" && process.env.NODE_ENV !== "production")) {
    console.log("[DEBUG-INPUT]", JSON.stringify({
      userId: userId.slice(0, 12),
      conversationId: conversationId?.slice(0, 12),
      userContent: userContent.slice(0, 200),
      messagesCount: messages.length,
      memoriesPreview: (memories || "").slice(0, 300),
      systemPromptLen: systemPrompt.length,
      profileFamily: profile.family.map((f) => `${f.relation}#${f.orderIdx ?? '-'} ${f.name}`),
    }, null, 2));
  }

  const fallback = buildFallbackMessage(honorific, companionName);
  const ctx = `${memories || ""}\n${historyText || ""}\n${userContent || ""}`;
  const prevAi = extractLastAiMessage(historyText);
  const recentUserText = messages.filter((m) => m.role === "user").slice(-6).map((m) => m.content).join(" ");

  // 스트리밍 응답 — 첫 문장부터 SSE로 내보내 클라이언트가 바로 말하게 함. 저장·분석은 onComplete(전체 안전망 후).
  return streamCompanionReply({
    model,
    contents: { contents },
    fallback,
    post: { userText: userContent, companionName, ctx, honorific, family: profile.family, prevAi, answeringProbe },
    fact: { profile, recentUserText, memories: memories || "", honorific, companionName, currentUserText: userContent },
    extra: emergency.effectiveLevel > 0 ? { emergency: { level: emergency.effectiveLevel, category: emergency.result.category } } : undefined,
    timings,
    onComplete: async (text, fallbackUsed) => {
      if (!conversationId || !userContent) return;
      /**
       * ⚠ 저장 실패가 **L2 보호자 알림까지 삼키면 안 된다**(2026-10-02 적대 리뷰).
       *   L3는 2026-10-01에 격리했는데 L2 경로 셋은 그대로였다. await가 throw하면
       *   아래 알림 블록과 배경 작업이 통째로 건너뛰어져, "주의 신호인데 보호자가 모른다"가 된다.
       *   FCM·이메일은 Message 행 없이도 나간다 — 마킹만 생략될 뿐이다.
       */
      let userMsgId: string | undefined;
      try {
        ({ userMsgId } = await saveMessages({
          conversationId, userId, userContent, assistantContent: text,
          emergencyLevel: emergency.effectiveLevel > 0 ? emergency.effectiveLevel : undefined,
          emergencyEvidence: emergency.result.level > 0 ? `${emergency.result.category}:${emergency.result.evidence}` : undefined,
          skipAssistantEmbedding: fallbackUsed, // 폴백 멘트는 RAG 오염 방지 위해 임베딩 제외
        }));
      } catch (e) {
        console.error("[chat/text] 저장 실패 — 알림·배경작업은 계속:", e instanceof Error ? e.message : e);
      }
      if (emergency.effectiveLevel === 2) {
        // 부유 프라미스 금지(2026-07-07 감사) — after()로 실행 보장, 컨텍스트 밖이면 여기서 await.
        const sendL2Notify = async () => {
          try {
            const r = await notifyGuardian({
              userId, userName: honorific, messageId: userMsgId, level: 2,
              category: emergency.result.category, content: userContent, aiReply: text, createdAt: new Date(),
            });
            if (r.sent) console.log("[emergency-notify] L2 sent:", r.channels);
            else console.warn("[emergency-notify] L2 not sent:", r.reason);
          } catch (e) { console.error("[emergency-notify] L2 error:", e); }
        };
        try { after(sendL2Notify); } catch { await sendL2Notify(); }
      }
      // 배경 작업 — 부유 프라미스로 두면 서버리스가 인스턴스를 freeze할 때 조용히 유실된다.
      //   (오디오 경로·응급 알림·/api/live/turn과 동일한 after() 패턴으로 통일, 2026-10-01)
      const bgTasks = async () => {
        // 폴백 턴에도 인지분석은 수행 — 분석 대상은 사용자 발화이므로 폴백과 무관하게 유효.
        // 단 AI 발화로 폴백 멘트를 넘기면 probe 감지·도메인 자동기록이 오염되므로 빈 문자열로 대체.
        // 일반인(general)은 인지 선별 대상이 아님 — 분석 미수행(목적 분리 + 비용 절감)
        // 저장 실패로 userMsgId가 없으면 인지 분석을 건너뛴다 — cognitive_assessments가
        //   message_id를 참조하므로 저장할 곳이 없다. 알림은 위에서 이미 독립적으로 나갔다.
        if (mode !== "general" && userMsgId) {
          await runCognitiveAnalysis({ userId, conversationId, userMsgId, userMessage: userContent, assistantResponse: fallbackUsed ? "" : text, historyText, envBlock, honorific, probeContext, answeringProbe }).catch((e) => console.error("[bg-cognitive]", e));
        }
        await extractAndSaveProfile({ userId, userMessage: userContent, userMessageId: userMsgId }).catch((e) => console.error("[bg-profile-extract]", e));
        await maybeTriggerSummaryRollup({ userId, conversationId }).catch((e) => console.error("[bg-summary-trigger]", e));
      };
      try { after(bgTasks); } catch { bgTasks().catch(() => {}); }
    },
  });
}

// ─── POST ───────────────────────────────────────────────────────────────────

/**
 * 요청 처리가 통째로 실패했을 때의 **최후 응급 안전망**.
 *
 * 무엇을 보장하나: RDS가 죽어 /api/chat이 500으로 끝나는 상황에서도, 그 발화가 L3 응급이면
 *   (1) 어르신에게 119 안내 멘트가 나가고 (2) 보호자 알림이 시도된다.
 *   이전에는 둘 다 0이었다 — 어르신은 빈 화면을, 보호자는 아무 소식도 받지 못했다.
 *
 * ⚠ 이 함수는 **DB를 한 번도 치지 않는다.** 호칭·동반자 이름도 조회하지 않고 기본값을 쓴다
 *   (그 조회가 터져서 여기로 왔을 수 있다). notifyGuardian 내부의 dedup 조회·보호자 연락처
 *   조회도 실패하면 fail-open으로 FCM 토픽 발송까지는 간다 — 그게 이 경로의 최소 보장선이다.
 *
 * 비용: 음성 턴은 여기서 STT를 **다시** 돌린다. 예외 경로에서만 실행되므로 평시 비용은 0이고,
 *   음성 전용 제품에서 전사 없이는 응급을 볼 방법 자체가 없어 감수할 가치가 있다
 *   (일일 사용량 게이트에서 같은 판단을 했다).
 */
async function emergencyLastResort(
  error: unknown,
  sos: { userId: string; text: string; audio?: { data: string; mimeType: string } },
): Promise<NextResponse> {
  const fail = () => NextResponse.json({ error: toSafeError(error) }, { status: 500 });
  try {
    // 판정·발송은 공용 모듈이 담당한다(live·observe와 같은 구현을 쓰게 해 F3 드리프트 차단).
    //   여기 route.ts에 두면 Next route 파일 제약으로 export가 안 돼 **행위 테스트를 못 쓴다** —
    //   실제로 그 때문에 소스 grep 테스트만 붙였고, 음성 턴 stale 텍스트 결함을 전부 놓쳤다.
    const r = await lastResortEmergency({
      sos, userName: getHonorific(null, null), companionName: COMPANION_DEFAULTS.name,
      minLevel: 3,   // L1·L2는 대화 흐름 안에서 다뤄야 의미가 있다
      transcribe: (d, m) => transcribeAudio(d, m),
    });
    if (!r.fired || !r.reply) return fail();

    console.error("[emergency] 요청 실패 중 L3 감지 — 최후 안전망 발동:", r.category);
    // degraded: true — 클라이언트가 "기록은 남지 않았다"를 구분할 수 있게 한다(멘트는 정상 노출).
    return NextResponse.json({
      text: r.reply, role: "assistant",
      emergency: { level: 3, category: r.category }, degraded: true,
    });
  } catch (e) {
    console.error("[emergency] 최후 안전망 자체가 실패:", e);
    return fail();
  }
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  /**
   * 최후 응급 안전망용 상태 — try 블록 **밖**에 둔다.
   *
   * 왜: handleEmergencyL3에 도달하기 전에 DB를 치는 지점이 넷이다(동의 게이트 / 대리검사 조회 /
   *   conversationId 소유권 검증 / buildSystemPrompt 내부 Promise.all). 거기서 터지면 지금까지는
   *   그냥 500이었고, 그 결과 응급 발화를 한 어르신은 **119 안내도 못 듣고 보호자 알림도 0건**이었다.
   *   RDS가 흔들리면 바로 발생하는 경로지 가설이 아니다. 아래 catch에서 마지막으로 한 번 더 본다.
   */
  const sos: { userId: string; text: string; audio?: { data: string; mimeType: string } } = {
    userId: session.user.id, text: "",
  };

  try {
    const parsed = ChatRequestSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "잘못된 요청 형식입니다." }, { status: 400 });
    }
    const body = parsed.data as ChatRequestBody;
    const { messages, conversationId, isInitialGreeting, isReturningGreeting, isReEngage, reEngageAttempt, audio, context: ctx, proxyPatientId } = body;
    const actorId = session.user.id;
    // 안전망에 원문 확보 — 이 아래 어디서 터지든 catch가 응급을 다시 평가할 수 있게.
    /**
     * ⚠ 음성 턴에서는 sos.text를 **채우지 않는다**(2026-10-02 적대 리뷰에서 확증된 결함 수정).
     *
     * 클라이언트의 두 경로가 비대칭이다:
     *   · 텍스트 (page.tsx:908): `[...messagesRef.current, userMessage]` — 현재 발화 **포함**
     *   · 음성   (page.tsx:1171): `messagesRef.current.slice(-50)`      — 현재 발화 **미포함**
     *                             (아직 전사 전이라 클라도 텍스트를 모른다. 오디오에만 있다.)
     *
     * 그래서 음성 턴에 이 줄을 그대로 쓰면 sos.text에 **직전 턴 발화**가 들어간다. 그러면
     * 아래 안전망의 `if (!content && sos.audio)` 가드가 거짓이 되어 STT 재시도가 영원히 안 돌고,
     *   (A) 위음성 — 지금 "숨이 안 쉬어져"라고 말해도 직전 발화("점심 먹었어")로 판정해 L0 → 500.
     *       즉 이 안전망이 고치려던 사고가 **음성 턴에서는 그대로 남는다**(음성 전용 제품이다).
     *   (B) 위양성 — 직전 턴이 L3였고 지금은 "괜찮아"인데, 스테일 텍스트로 119 멘트를 재생하고
     *       **틀린 발화 원문**으로 보호자 알림을 또 보낸다.
     * 음성 턴의 진실은 오디오뿐이므로, 텍스트는 비워 두고 전사에만 의존한다(아래 sttPromise가 채운다).
     */
    const isAudioTurn = !!(audio?.data && audio?.mimeType);
    sos.text = isAudioTurn ? "" : (messages?.filter((m) => m.role === "user").at(-1)?.content ?? "");
    if (isAudioTurn && audio) sos.audio = { data: audio.data, mimeType: audio.mimeType };
    // 모드는 세션의 계정 역할(screeningMode)에서 서버가 결정 — 클라이언트 body.mode는 신뢰하지 않음
    // (user 계정이 mode:"pro"를 보내 표준화 검사 모드를 스푸핑하는 것 차단)
    const mode: "user" | "pro" | "general" =
      session.user.screeningMode === "pro" ? "pro"
      : session.user.screeningMode === "general" ? "general"
      : "user";

    /**
     * 보호자(guardian) 계정은 대화 대상이 아니다 — 403.
     *
     * 결함(2026-10-01 감사): mode 유니온에 guardian이 없어 `else → "user"`로 강등됐다.
     *   guardian 계정이 /api/users/consent로 동의만 세우고 /api/chat을 직접 호출하면
     *   어르신 전용 80/20 프롬프트가 돌고 5턴마다 인지 확인 질문을 받으며,
     *   그 채점이 **보호자 본인의 cognitive_assessments로 기록**되어 C2 알림 평가 대상이 됐다.
     *   UI는 guardian을 /expert로 리다이렉트하므로 직접 API 호출 시에만 발생했다.
     */
    if (session.user.screeningMode === "guardian") {
      return NextResponse.json(
        { error: "보호자 계정은 대화 기능을 사용할 수 없습니다. 환자 관리 화면을 이용해주세요." },
        { status: 403 },
      );
    }

    /**
     * 건강정보 수집 동의 게이트(API 레벨) — 본인이 자기 건강데이터를 생성하는 경우 동의 필수.
     *   UI(app/page.tsx)에서 미동의 시 /consent로 보내지만, /api/chat 직접 호출로 우회되지 않도록 서버에서도 차단.
     *
     * general(일반인)도 포함한다(2026-10-01 사용량 조사 중 발견): 게이트가 user에만 걸려 있어
     *   일반인 계정이 **동의 없이** PHQ-9·GAD-7 응답·점수(mental_assessments)와 대화 원문을
     *   저장하고 있었다. 우울·불안 점수는 민감정보이고, 이 경로도 응급 감지·보호자 알림이
     *   동작하므로 동의 범위가 어르신과 다르지 않다.
     *   (pro는 본인 데이터를 만들지 않고, 대리 검사는 환자 본인이 이미 동의한 계정에 귀속된다.)
     */
    if (mode === "user" || mode === "general") {
      const me = await prisma.user.findUnique({ where: { id: actorId }, select: { consentedAt: true } });
      if (!me?.consentedAt) {
        return NextResponse.json({ error: "건강정보 수집 동의가 필요합니다.", needConsent: true }, { status: 403 });
      }
    }

    // 전문가 대리 검사 — pro가 연결된 환자를 선택해 검사하면 이력·인지·저장을 환자 계정에 귀속.
    //   보안: pro 계정만, ExpertPatient active 연결 검증. 그 외엔 본인(actor)에 귀속.
    let userId = actorId;
    if (proxyPatientId && proxyPatientId !== actorId) {
      if (mode !== "pro") {
        return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });
      }
      const link = await prisma.expertPatient.findUnique({
        where: { expertUserId_patientUserId: { expertUserId: actorId, patientUserId: proxyPatientId } },
        select: { status: true },
      });
      if (!link || link.status !== "active") {
        return NextResponse.json({ error: "연결되지 않은 환자입니다." }, { status: 403 });
      }
      // 일반인(general) 환자는 인지선별 비대상 — 대리 경로로 인지 데이터가 기록되지 않도록 차단(목적 분리)
      const pat = await prisma.user.findUnique({ where: { id: proxyPatientId }, select: { screeningMode: true } });
      if (pat?.screeningMode === "general") {
        return NextResponse.json({ error: "일반인 계정은 대리 검사 대상이 아닙니다." }, { status: 400 });
      }
      userId = proxyPatientId;
      sos.userId = proxyPatientId;   // 알림은 환자의 보호자에게 가야 한다
    }

    // 전문가 검진 상태머신 — 대리 검사 중 진행 세션이 있으면 항목단위 검진으로 라우팅
    const examSession = (proxyPatientId && mode === "pro") ? await lookupOpenExam(actorId, proxyPatientId) : null;
    // 대리(proxy) 접근은 "열린 검진 세션"이 있을 때만 허용(2026-07-07 diff 리뷰 high).
    //   세션 없이 통과시키면 일반 대화 경로로 폴스루 — 환자 최근 대화 이력 50건 + RAG 기억이 LLM 컨텍스트에
    //   주입되어 전문가가 프롬프트로 일상 대화 원문을 추출 가능(동의서 §4 위반). 인지분석도 환자 계정에 오염 귀속.
    if (userId !== actorId && !examSession) {
      return NextResponse.json({ error: "진행 중인 검진 세션이 없습니다. 검진 시작 후 이용해주세요." }, { status: 403 });
    }

    // 고비용 엔드포인트 폭주 방어 — 행위 주체(전문가/본인) 기준 분당 40회 (대리 검사 다환자 남용도 차단)
    const rl = await checkRateLimit(`chat:${actorId}`, 40, 60_000);
    if (!rl.ok) {
      return NextResponse.json(
        { error: "잠시 후 다시 시도해주세요." },
        { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
      );
    }

    // conversationId 소유권 검증 — 타 사용자 대화 ID로 이력 열람·메시지 주입 차단(명시적 authz)
    if (conversationId) {
      const owned = await prisma.conversation.findFirst({ where: { id: conversationId, userId }, select: { id: true } });
      if (!owned) {
        return NextResponse.json({ error: "잘못된 대화입니다." }, { status: 403 });
      }
    }

    const _t: Record<string, number> = { start: performance.now() };
    const timeCtx = getTimeContext(ctx?.currentTime);
    const isAudio = !!(audio?.data && audio?.mimeType);
    const userMessages = messages?.filter((m) => m.role === "user").map((m) => m.content) ?? [];
    // 사용자가 보낸 글이 관찰 표지로 시작하면 무력화 — 그대로 저장되면 한도 집계·대화 이력에서 빠진다
    const lastUserMessage = neutralizeObservationPrefix(userMessages[userMessages.length - 1] ?? "");

    // 음성 STT를 가장 먼저 시작 — weather/프롬프트/이력 조회와 병렬로 진행해 음성 왕복 지연 단축.
    //   (STT는 시스템 프롬프트와 무관하므로 직렬일 이유가 없음. 실패는 핸들러에서 빈 전사로 처리)
    //   어휘 힌트(이름 표기 바이어스)도 병렬 시작 — transcribeAudio 내부에서 합류.
    //   단 검진(exam) 턴은 힌트 제외 — 회상/이름대기 답안이 힌트로 '보정'되면 채점 오염.
    const sttPromise = isAudio && audio
      ? transcribeAudio(audio.data, audio.mimeType, examSession ? undefined : buildSttHints(userId))
          // 전사가 나오는 즉시 안전망에도 넘겨 둔다 — 이 아래 어디서 터지든 catch가
          //   **현재 발화**를 보게 된다. 이미 돌고 있는 STT를 재사용하므로 추가 비용 0이고,
          //   안전망의 재전사 경로는 "STT가 아직 안 끝난 시점에 터진 경우"만 담당하게 된다.
          .then((t) => { if (t) sos.text = t; return t; })
          .catch((e) => { console.warn("[STT] transcription failed:", e); return ""; })
      : null;

    // weather · RAG(임베딩 HTTP) · DB 이력은 상호 독립 — 병렬화로 LLM 호출 전 선행 지연 절감.
    //   인사 턴은 RAG 불필요, 음성 턴은 STT 후 transcription 기준으로 핸들러가 직접 검색.
    const skipMemories = isInitialGreeting || isReturningGreeting || isReEngage || isAudio || !lastUserMessage;
    let _m = performance.now();
    const [weatherCtx, memories, dbHistory] = await Promise.all([
      getWeatherContext(ctx?.latitude, ctx?.longitude),
      skipMemories ? Promise.resolve("") : fetchMemories(userId, lastUserMessage),
      conversationId && !isInitialGreeting ? fetchRecentHistory(conversationId) : Promise.resolve([]),
    ]);
    _t.weatherMs = Math.round(performance.now() - _m);
    // DB 이력이 있으면 그것이 ground truth (클라이언트 slice 50·미저장 경합 시에만 폴백)
    const history = dbHistory.length > 0 ? dbHistory : (messages ?? []);
    _m = performance.now();
    const { systemPrompt, stablePrompt, turnBlock, envBlock, probeTurn, prevProbeTurn, userName, honorific, companionName, companionRelation, profile } = await buildSystemPrompt({
      userId, conversationId, timeCtx, weather: weatherCtx, mode,
    });
    // 이번 턴에 인지 질문을 던지거나, 직전 턴 질문에 지금 답하는 턴 → 분석기 정밀 채점(lite 우회)
    const probeContext = probeTurn || prevProbeTurn;
    const answeringProbe = prevProbeTurn;
    _t.promptMs = Math.round(performance.now() - _m);

    // 검진 시작(대리 검사) — 자동 인사 대신 표준 문항 시행 시작
    if (isInitialGreeting && examSession) {
      return handleExamGreeting(examSession, conversationId, new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10));
    }
    // 🔒 대리 신원으로 일반 인사(첫·재방문·재참여)를 만들면 안 된다 — 셋 다 **환자의 시스템 프롬프트**
    //   (프로필·요약·이력)로 LLM을 불러 그 응답을 돌려준다. 검진 세션이 열려 있으면 위 1325행 가드를
    //   통과하므로, 여기서 막지 않으면 전문가가 isReturningGreeting/isReEngage 플래그 하나로 환자의
    //   일상 맥락이 녹은 응답을 받는다(2026-10-06, 아래 '대리 신원은 여기서 끝난다'와 같은 불변식).
    // 단, 대리 검진 중 20초 침묵 재참여는 **현재 문항의 쉬운 재질문 문구(정적 텍스트)**로 답한다 — LLM도
    //   환자 맥락도 쓰지 않는다. 409로만 막으면 조용한 진료실에서 검진이 안내 없이 멈췄다(2026-10-06 재검토).
    //   검진 상태는 전진·저장하지 않는다(재참여는 답이 아니다 — 재질문 횟수·채점은 실제 답 턴에서만).
    if (userId !== actorId && isReEngage && examSession?.item_order) {
      const order: string[] = (() => { try { return JSON.parse(examSession.item_order || "[]"); } catch { return []; } })();
      const domain = order[examSession.current_item];
      if (domain) return NextResponse.json({ text: `천천히 생각하셔도 괜찮아요. ${renderDomainReask(domain)}`, role: "assistant" });
    }
    if (userId !== actorId && (isInitialGreeting || isReturningGreeting || isReEngage)) {
      return NextResponse.json({ error: "대리 접근은 검진 시행에만 쓸 수 있습니다." }, { status: 409 });
    }
    if (isInitialGreeting) return handleFirstGreeting(systemPrompt, userName, honorific, companionName, companionRelation, conversationId);
    if (isReturningGreeting) return handleReturningGreeting(systemPrompt, userName, honorific, conversationId, userId, mode);
    if (isReEngage) return handleReEngageGreeting(systemPrompt, honorific, companionName, history, conversationId, reEngageAttempt ?? 1);

    /**
     * 검진 세션은 열렸는데 아직 문항이 배정되지 않은 상태(item_order NULL)에서의 대리 턴을 막는다.
     *
     * 결함(2026-10-02 적대 리뷰): exam_session은 item_order 없이 INSERT되고
     *   (app/api/expert/exam/route.ts:44), 그 값은 handleExamGreeting에서만 채워진다.
     *   그래서 전문가가 isInitialGreeting 없이 /api/chat을 호출하면
     *     · 1237의 403 가드는 examSession이 truthy라 통과하고
     *     · userId는 환자로 승격되는데
     *     · 아래 `examSession.item_order` 가드에서 falsy라 **일반 대화 경로로 떨어졌다.**
     *   결과: 환자의 RAG 기억 + 최근 대화 50건이 LLM 컨텍스트에 주입되어, 전문가가
     *   프롬프트로 환자의 일상 대화 원문을 끌어낼 수 있다(동의서 §4 위반). 1234행 주석이
     *   막으려던 바로 그 경로가 이 틈으로 되살아나 있었다.
     *   게다가 2026-10-02 pro 수정 이후로는 이 턴이 scoringTurn=true가 되어, 자유 대화에서 나온
     *   점수가 환자 기록에 **'정밀 채점' 품질로** 남고 악화 알림 평가까지 탄다.
     * 정답은 폴스루가 아니라 차단이다 — 대리 경로의 유일한 정당한 용도는 검진 시행이다.
     */
    if (examSession && !examSession.item_order && userId !== actorId) {
      return NextResponse.json(
        { error: "검진이 아직 시작되지 않았습니다. 검진 시작을 먼저 진행해주세요." },
        { status: 409 },
      );
    }

    // 검진 진행 턴 — 진행 중 검진 세션이 있으면 항목단위 채점 경로로(일상 대화·인지분석 우회)
    if (examSession && examSession.item_order) {
      const examAnswer = isAudio && sttPromise
        ? ((await sttPromise.catch(() => "")) || "")
        : (lastUserMessage ?? "");

      /**
       * ⛔ 검진 중에도 응급이 최우선이다 — 검진 진행보다 안전이 먼저다.
       *
       * 결함(2026-10-01 확증): 검진 분기가 evaluateEmergency보다 **먼저 return**해서,
       *   대리 검진 중 환자가 "가슴이 찢어질 것 같고 숨이 안 쉬어져"라고 답하면
       *   그 문장을 문항 답안으로 채점하고 "네, 답변 감사합니다. 다음 질문이에요"로 진행했다.
       *   L3 즉답·보호자 알림·Message.emergencyLevel 마킹이 전부 발생하지 않았다.
       * L3면 즉답하고 검진 상태는 전진시키지 않는다(같은 문항을 다시 물을 수 있게 유지).
       */
      const examEmg = examAnswer.trim()
        ? await evaluateEmergency({ userContent: examAnswer, conversationId })
        : undefined;
      if (examEmg?.effectiveLevel === 3) {
        return handleEmergencyL3({
          result: examEmg.result, userContent: examAnswer,
          conversationId, userId, honorific, companionName,
          transcription: isAudio ? (examAnswer || "(음성 응답)") : undefined,
        });
      }

      // L2 이하는 검진을 계속 진행하되, 마킹·알림은 handleExamTurn이 수행한다.
      if (isAudio && sttPromise) {
        return handleExamTurn({ examSession, answer: examAnswer, conversationId, userId, transcription: examAnswer || "(음성 응답)", emergency: examEmg, honorific });
      }
      // ⚠ 빈 답도 검진 턴이다(무응답 → handleExamTurn이 재질문). 예전엔 `if (lastUserMessage)`라
      //   빈 문자열이면 이 분기를 **빠져나가** 일반 대화 경로로 갔다 — 아래 가드 참조(2026-10-06).
      return handleExamTurn({ examSession, answer: lastUserMessage ?? "", conversationId, userId, emergency: examEmg, honorific });
    }

    /**
     * 🔒 대리 신원은 **여기서 끝난다** — 이 줄 아래(동반자 LLM 일반 대화)로 내려가면 안 된다.
     *
     * 결함(2026-10-06 적대 감사, 재현 확인): 텍스트 대리 턴의 마지막 user content가 비면 위 검진 분기의
     *   `if (lastUserMessage)`를 통과하지 못해 **일반 대화 경로로 떨어졌다**. userId는 이미 환자로
     *   승격된 상태라, 환자의 프로필·주간/월간 요약·최근 대화가 맥락으로 들어간 LLM 응답이 전문가에게
     *   반환됐다(동의서 §4 "일상 대화 비공개" 위반). 10-02에 item_order NULL 변형을 막았는데 같은
     *   폴스루가 다른 조건으로 남아 있었다 — 변형을 하나씩 막으면 다음 변형이 남는다.
     *   그래서 조건이 아니라 **불변식**으로 막는다: 대리(userId ≠ actorId)는 검진 분기에서만 응답한다.
     */
    if (userId !== actorId) {
      return NextResponse.json(
        { error: "대리 접근은 검진 시행에만 쓸 수 있습니다." },
        { status: 409 },
      );
    }

    /**
     * 일일 대화량 제한 — 어르신(user) 모드의 일상 대화에만 적용.
     *
     * 턴당 LLM 비용이 약 10원이고 전부 입력 토큰이 매 턴 재전송되는 구조라, 무제한이면
     * 1인 월 비용이 사용량에 선형으로 늘어난다(하루 100턴 ≈ 월 31,000원). 가격 정책의 전제다.
     *
     * 제외 대상
     *  - 검진(exam) 턴: 위에서 이미 분기해 여기 도달하지 않는다(대리 검사는 비용 주체가 다름)
     *  - pro·general: 목적·과금 주체가 다르다
     *  - 인사 턴: 앱을 열자마자 막히면 어르신이 고장으로 오해한다
     *  - 응급 발화: 한도와 무관하게 항상 통과시킨다 — 안전이 비용보다 우선이다
     */
    let nearLimitRemaining = 0;
    // ⚠ conversationId를 빼고 보내면 예전엔 한도 판정이 **통째로** 빠졌다(2026-10-06 재검토 — /api/live/token은
    //   같은 날 고쳤는데 여기엔 옮기지 않았다). 어르신은 대화가 계정당 하나(Conversation.userId 유일) — 없으면 찾아서 센다.
    const limitConvId = mode === "user" && !isInitialGreeting && !isReturningGreeting && !isReEngage
      ? conversationId ?? (await prisma.conversation.findUnique({ where: { userId }, select: { id: true } }).catch(() => null))?.id
      : undefined;
    if (limitConvId) {
      const usage = await getDailyUsage(limitConvId, userId);
      if (usage.nearLimit) nearLimitRemaining = usage.remaining;
      if (usage.exceeded) {
        // 응급 발화는 한도와 무관하게 통과시킨다 — 안전이 비용보다 우선.
        //   실서비스는 음성 전용이라 이 지점에서 발화 내용을 모른다. 전사를 먼저 기다려야
        //   "숨이 안 쉬어져"가 마무리 인사로 덮이지 않는다(이미 진행 중인 promise이고,
        //   handleAudioMessage가 같은 promise를 다시 await해도 즉시 resolve된다).
        const spoken = isAudio && sttPromise ? await sttPromise.catch(() => "") : (lastUserMessage ?? "");
        /**
         * ⚠ 정규식만 보면 안 된다(2026-10-02 적대 리뷰). 본류 평가(evaluateEmergency)는
         *   정규식이 none일 때 LLM 백스톱(detectEmergencyLLM)을 한 번 더 태우는데, 이 게이트는
         *   정규식만 봐서 **백스톱이 잡아내던 사투리·완곡어 L3가 여기서 마무리 인사로 덮였다.**
         *   백스톱이 존재하는 이유가 바로 "정규식이 놓치는 과소감지 꼬리"인데, 하필 그 꼬리가
         *   한도 초과일에 묵살되면 가장 조용한 위음성이 된다.
         *   비용: SOFT_SIGNAL 사전필터가 평범한 발화를 걸러 호출 자체가 드물고,
         *   한도 초과 턴에만 돈다. 안전 기능은 비용 최적화 대상이 아니다(가이드 §3).
         */
        let isEmergencyUtterance = spoken ? detectEmergency(spoken).level > 0 : false;
        if (spoken && !isEmergencyUtterance) {
          const llm = await detectEmergencyLLM(spoken).catch(() => null);
          if (llm) {
            isEmergencyUtterance = true;
            console.log("[daily-limit] 정규식 none → LLM 백스톱이 응급 포착:", llm.category);
          }
        }
        if (!isEmergencyUtterance) {
          // 오류(429)가 아니라 **동반자가 말하는 마무리 인사**를 200으로 — 화면엔 평소 말풍선이 뜨고
          //   TTS로 읽히므로 어르신이 "오늘은 그만"이라고 자연히 이해한다.
          const text = buildDailyLimitReply(honorific, companionName);
          await saveMessages({
            conversationId: limitConvId, userId,
            userContent: spoken || (isAudio ? "(음성 메시지)" : ""),
            assistantContent: text, skipUserEmbedding: true, skipAssistantEmbedding: true,
          }).catch((e) => console.warn("[daily-limit] 저장 실패:", e));
          console.log(`[daily-limit] 한도 도달 — userId=${userId.slice(0, 8)} used=${usage.used}/${usage.limit}`);
          return NextResponse.json({ text, role: "assistant", dailyLimitReached: true });
        }
        console.log(`[daily-limit] 한도 도달이지만 응급 발화 — 통과 userId=${userId.slice(0, 8)}`);
      }
    }

    // 마무리 예고를 시스템 프롬프트에 주입 — 모델이 자기 말투로 녹인다(응답 후 문자열 결합 금지:
    //   TTS 문장 분할·후처리 파이프라인과 어긋난다).
    const sysPrompt = nearLimitRemaining > 0 ? systemPrompt + buildNearLimitPromptHint(nearLimitRemaining) : systemPrompt;

    const historyText = buildHistoryText(history);

    // 응급 신호(L1 이상)나 부적절 발언이 섞인 발화는 단락하지 않고 일반 경로로 —
    // 시간 즉답이 응급 마킹/누적·모더레이션 카운트를 삼키는 것 방지(음성 1.55단계와 동일 정책).
    //   ⚠ 응급은 **백스톱 포함**으로 본다(2026-10-06 재검토, 재현 확인). 정규식만 보던 시절엔
    //   "지금 몇 시야? 모아둔 약 오늘 다 털어 넣을 거야"(정규식 none · 백스톱 L3)가 시각 안내 한 줄로
    //   끝났다 — 음성 경로는 이미 effectiveLevel(백스톱 포함)을 봐서 두 경로가 어긋나 있었다.
    //   비용: 백스톱은 SOFT_SIGNAL 사전필터를 통과한 발화에서만 LLM을 부른다(평범한 시간 질문은 0).
    if (!isAudio && lastUserMessage && isDateTimeQuestion(lastUserMessage)
      && detectInappropriate(lastUserMessage).category === "ok"
      && (await detectWithBackstop(lastUserMessage)).level === 0) {
      return handleDateTimeQuestion(lastUserMessage, honorific, conversationId, userId, ctx?.currentTime);
    }

    if (isAudio && sttPromise) {
      return handleAudioMessage({
        systemPrompt: sysPrompt, stablePrompt, turnBlock, envBlock, honorific, userName, companionName, companionRelation, userId, conversationId,
        sttPromise, historyText, messages: history, profile,
        clientTimeIso: ctx?.currentTime, timings: _t, mode, probeTurn, probeContext, answeringProbe,
      });
    }

    return handleTextMessage({ systemPrompt: sysPrompt, stablePrompt, turnBlock, envBlock, userId, conversationId, userContent: lastUserMessage, historyText, memories, messages: history, companionName, companionRelation, honorific, profile, timings: _t, mode, probeTurn, probeContext, answeringProbe });
  } catch (e) {
    console.error("chat api error", e);
    return emergencyLastResort(e, sos);
  }
}
