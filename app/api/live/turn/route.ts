/**
 * Live 음성 턴 저장 — 클라가 Gemini Live에 직결해 나눈 한 턴(사용자 전사 + AI 전사)을
 * 서버에 회송: Message 저장 + 인지 분석(사용자/전문가만) 연결.
 * Live 경로 v1 제약: 검진(mental flow)·응급 즉답 게이트는 클라 측 안전망과 별개로 미지원 —
 * 응급 어휘 감지 시 isEmergency 플래그를 반환해 클라가 안내 모드로 전환하게 한다.
 */
import { NextResponse, after } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { saveMessages } from "@/lib/chat/messages";
import { runCognitiveAnalysis } from "@/lib/chat/cognitive-run";
import { buildHistoryText } from "@/lib/chat/history-text";
import { getTimeContext } from "@/lib/chat/time";
import { evaluateEmergency } from "@/lib/chat/emergency-evaluate";
import { notifyGuardian } from "@/lib/chat/emergency-notify";
import { lastResortEmergency } from "@/lib/chat/emergency-last-resort";
import { checkRateLimit } from "@/lib/rate-limit";
import { extractAndSaveProfile } from "@/lib/chat/profile-extractor";
import { maybeTriggerSummaryRollup } from "@/lib/chat/summary-trigger";
import { isLiveBetaEnabledServer } from "@/lib/feature-flags";
import { getDailyUsage, buildDailyLimitReplyForUser } from "@/lib/usage/daily-limit";
import { EXCLUDE_OBSERVATION, neutralizeObservationPrefix } from "@/lib/chat/observation";

export async function POST(req: Request) {
  // 라이브 베타 서버 게이트(2026-07-07 감사) — UI 링크 숨김과 짝. 플래그 없으면 저장 경로도 차단.
  //   ⚠ 서버 인가는 **런타임 제어 가능한** 플래그를 쓴다(2026-10-02) — 상세는 lib/feature-flags.ts.
  if (!isLiveBetaEnabledServer()) {
    return NextResponse.json({ error: "라이브 베타는 현재 비활성화되어 있습니다." }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const userId = session.user.id;

  // 역할 판정은 맨 위에서 한 번만 — 아래 게이트(보호자 차단·일일 한도·인지 분석)가 같은 값을 본다
  const rawMode = session.user.screeningMode;
  const mode = rawMode === "pro" ? "pro" : rawMode === "general" ? "general" : rawMode === "guardian" ? "guardian" : "user";

  /**
   * 보호자(guardian) 계정은 대화 대상이 아니다 — /api/chat과 같은 403.
   *
   * 결함(2026-10-06 발견): /api/chat은 2026-10-01에 guardian을 403으로 막았는데 Live 경로엔
   *   그 수정이 건너오지 않았다. 여기선 인지 분석만 빼고 **보호자 발화를 저장**하고 있었다.
   *   한 경로만 고치면 F3·F9(역할 간 누수)가 남는다 — 가이드 §4 역할 행렬.
   */
  if (mode === "guardian") {
    return NextResponse.json(
      { error: "보호자 계정은 대화 기능을 사용할 수 없습니다. 환자 관리 화면을 이용해주세요." },
      { status: 403 },
    );
  }
  // 전문가(pro)도 막는다 — Live엔 대리 귀속이 없어, 기기 앞 환자의 발화·응급이 **검사자 계정**에
  //   기록된다(2026-10-06 적대 감사). 토큰 발급(/api/live/token)과 같은 규칙.
  if (mode === "pro") {
    return NextResponse.json(
      { error: "전문가 계정은 음성 대화를 쓸 수 없어요. 검진은 대리 검진 화면에서 진행해 주세요." },
      { status: 403 },
    );
  }

  const rl = await checkRateLimit(`live-turn:${userId}`, 60, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  const body = await req.json().catch(() => ({}));
  // 관찰 표지로 시작하는 전사는 무력화 — 그대로 저장되면 한도 집계·대화 이력에서 빠진다(lib/chat/observation)
  const userText = neutralizeObservationPrefix(String(body?.userText || "").slice(0, 2000).trim());
  /**
   * AI 전사는 **없어도 된다** — 사용자 발화만 있으면 처리한다(2026-10-06 적대 감사).
   *   예전엔 aiText가 비면 400이었고 클라도 `if (u && a)`일 때만 보냈다. Gemini Live가 출력 전사를
   *   내지 않는 턴(빈 응답·안전 차단·누출 정리 후 빈 텍스트)이면 어르신의 응급 발화가 판정·마킹·알림
   *   없이 사라졌다. /api/chat은 모델이 실패해도 응급 처리를 따로 한다 — 응급 판정의 입력은 사용자 발화다.
   */
  const aiTextRaw = String(body?.aiText || "").slice(0, 4000).trim();
  const aiText = aiTextRaw || "(음성 응답 — 전사 없음)";
  const conversationId = typeof body?.conversationId === "string" ? body.conversationId.slice(0, 100) : undefined;
  if (!userText || !conversationId) {
    return NextResponse.json({ error: "userText/conversationId 필수" }, { status: 400 });
  }
  try {
    // 대화 소유권 검증 — 타인 대화에 끼워넣기 차단
    const conv = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { userId: true } });
    if (!conv || conv.userId !== userId) return NextResponse.json({ error: "대화를 찾을 수 없습니다." }, { status: 404 });

    // 건강정보 수집 동의 게이트 — /api/chat에는 있는데 이 경로에는 없어서
    //   미동의 어르신이 Live로 건강데이터(인지 평가·응급 이력)를 생성할 수 있었다(2026-10-01 감사).
    const consent = await prisma.user.findUnique({ where: { id: userId }, select: { consentedAt: true } });
    if (!consent?.consentedAt) {
      return NextResponse.json({ error: "건강정보 수집 동의가 필요합니다.", needConsent: true }, { status: 403 });
    }

    // 응급 감지 — 저장 전에 판정해 마킹까지(위급 이력·보호자 알림의 전제). 정규식이 L2 미만이면 LLM 백스톱.
    //   이 라우트는 음성 응답 이후의 회송이라 백스톱 지연이 대화 턴테이킹을 막지 않음.
    // ⚠ L1 24시간 누적 → L2 승격까지 /api/chat과 같은 함수로(2026-10-06). 예전엔 정규식·백스톱만
    //   복사해 두고 승격을 빠뜨려, Live가 기본 음성 경로가 되면 추세 알림이 소리 없이 사라질 상태였다.
    const ev = await evaluateEmergency({ userContent: userText, conversationId });
    const emergency = ev.result;        // 카테고리·근거
    const level = ev.effectiveLevel;    // 저장·알림·응답에 쓰는 실효 등급(승격 반영)

    /**
     * 일일 사용량 한도 — /api/live/token은 **세션 시작**만 막는다. 세션이 열린 뒤에는 턴마다
     *   인지 분석·프로필 추출·요약 롤업(전부 유료 Gemini 호출)이 무제한이었다
     *   (가이드 §4 행렬 '일일 사용량 제한 / live = ❌', 2026-10-02 감사 #24).
     *
     * 여기서 **저장과 응급은 막지 않는다**:
     *   · 이 턴은 이미 클라에서 일어났다(어르신이 말했고 대답을 들었다). 저장을 거부하면
     *     대화 기록과 응급 마킹이 사라진다 — 거부할 대상이 아니다.
     *   · 안전 기능은 한도와 무관하게 무료다(제품 원칙).
     *   유료 후처리만 건너뛰고, 클라에 dailyLimitReached를 돌려 세션을 마무리 인사로 닫는다.
     *
     * ⚠ 저장 **전에** 센다. 저장 뒤에 세면 현재 턴이 포함돼 /api/chat보다 한 턴 일찍 끊긴다
     *   (/api/chat은 생성 전에 세므로 1..limit턴이 전부 정상 처리된다 — 같은 상한이 경로마다
     *   다르게 동작하면 그게 F3다). 조회 실패는 getDailyUsage가 내부에서 통과로 처리한다.
     * ⚠ 대상도 /api/chat과 같다 — **어르신(user)만**. pro·general은 목적·과금 주체가 다르다.
     * ⚠ **응급 발화(L1 이상, 백스톱 포함)는 한도와 무관하게 통과**시킨다 — /api/chat과 같은 정책
     *   (chat/route.ts `isEmergencyUtterance = detectEmergency(spoken).level > 0` + 백스톱).
     *   처음 구현에서 이 예외를 빼먹어, 한도에 닿은 날 "어지러워서 못 일어나겠어"(L2)라고 하면
     *   통화가 끊겼다 — 악화돼 L3가 돼도 들어 줄 채널이 없었다(2026-10-06 적대 감사가 잡음).
     *   위 응급 판정(정규식 → LLM 백스톱)이 이 줄보다 **먼저** 끝나 있으므로 그 결과를 그대로 쓴다.
     */
    const usage = mode === "user" ? await getDailyUsage(conversationId, userId) : null;
    const limitReached = !!usage?.exceeded && level === 0;

    // 저장 실패가 보호자 알림을 삼키지 않게 분리(2026-10-02, /api/chat과 동일 처방).
    //   이전엔 await가 throw하면 500으로 끝나 **응급인데 알림 0건**이었다.
    let userMsgId: string | undefined;
    try {
      ({ userMsgId } = await saveMessages({
        conversationId, userId, userContent: userText, assistantContent: aiText,
        emergencyLevel: level > 0 ? level : undefined,
        emergencyEvidence: level > 0 ? `${emergency.category}:${emergency.evidence}` : undefined,
      }));
    } catch (e) {
      console.error("[live-turn] 저장 실패 — 응급 알림은 계속 진행:", e instanceof Error ? e.message : e);
    }

    // 보호자 알림(L2+) — 메인 /api/chat 경로와 동등한 안전망(2026-07-07 감사: Live 경로가 알림을 전부 우회했음).
    //   ⚠ `&& userMsgId` 제거: 저장이 실패해도 FCM·이메일은 메시지 행 없이 나간다. 마킹만 생략된다.
    if (level >= 2) {
      const notifyLevel = level as 2 | 3;
      const sendLiveNotify = async () => {
        try {
          const r = await notifyGuardian({
            userId, userName: session.user.name || "사용자", messageId: userMsgId, level: notifyLevel,
            category: emergency.category, content: userText, aiReply: aiText, createdAt: new Date(),
          });
          if (r.sent) console.log("[emergency-notify] live sent:", r.channels);
          else console.warn("[emergency-notify] live not sent:", r.reason);
        } catch (e) { console.error("[emergency-notify] live error:", e); }
      };
      try { after(sendLiveNotify); } catch { await sendLiveNotify(); }
    }

    // 인지 분석 — 일반인(general)은 목적 분리 원칙대로 미실행
    // 인지 분석은 어르신(user) 계정에만 — general(목적 분리)·pro(검사자)·guardian(보호자) 제외.
    //   기존에는 general만 제외해 guardian 발화가 보호자 본인의 cognitive_assessments로
    //   기록되고 C2 알림 평가 대상이 됐다(2026-10-01 감사).
    if (mode === "user" && userMsgId && !limitReached) {
      // 상시 감시 혼잣말은 채점 맥락이 아니다 — /api/chat의 대화 컨텍스트와 같은 범위(2026-10-06)
      const rows = await prisma.message.findMany({
        where: { conversationId, ...EXCLUDE_OBSERVATION }, orderBy: { createdAt: "desc" }, take: 20,
        select: { role: true, content: true, createdAt: true },
      });
      const historyText = buildHistoryText(rows.reverse().map((m) => ({ role: m.role, content: m.content, createdAt: m.createdAt.toISOString() })));
      const t = getTimeContext();
      const envBlock = `[현재 환경 정보 — 실시간 서버 데이터, 반드시 신뢰하세요]\n- 현재 한국 시각: ${t.dateStr}\n- 시간대: ${t.timeLabel}`;
      runCognitiveAnalysis({ userId, conversationId, userMsgId, userMessage: userText, assistantResponse: aiText, historyText, envBlock })
        .catch((e) => console.error("[live-turn:cognitive]", e));
    }

    // 기억 축적 — 프로필 추출(가족·취미 등 신규 사실) + 계층 요약 롤업. classic 경로(route.ts)와 동등.
    //   라이브가 기본 음성경로가 된 뒤 이 연결이 없으면 새로 들은 정보가 다음 세션 페르소나에 반영되지 않음(2026-07-20).
    if (userMsgId && !limitReached) {
      const runMemory = async () => {
        await extractAndSaveProfile({ userId, userMessage: userText, userMessageId: userMsgId }).catch((e) => console.error("[live-turn:profile]", e));
        await maybeTriggerSummaryRollup({ userId, conversationId }).catch((e) => console.error("[live-turn:summary]", e));
      };
      try { after(runMemory); } catch { runMemory().catch(() => {}); }
    }

    // Live 경로는 서버 즉답 게이트가 없으므로 클라에 응급 신호 전달(안내 모드 전환용)
    if (limitReached && usage) {
      console.log(`[daily-limit] live 한도 도달 — userId=${userId.slice(0, 8)} used=${usage.used}/${usage.limit} (저장·응급은 처리, 유료 분석 생략)`);
      // 필드 이름은 /api/live/token과 같게 — 클라가 한 가지 형태만 알면 된다
      return NextResponse.json({
        ok: true, emergencyLevel: level,
        dailyLimitReached: true, message: await buildDailyLimitReplyForUser(userId),
      });
    }
    return NextResponse.json({ ok: true, emergencyLevel: level });
  } catch (e) {
    console.error("[live-turn]", e);
    /**
     * 최후 응급 안전망 — /api/chat과 동일 처방(2026-10-02). 이 경로도 응급 판정 **전에**
     *   DB를 두 번 친다(대화 소유권 검증 / 동의 게이트). 거기서 터지면 그냥 500이었고,
     *   응급 발화였어도 보호자 알림이 0건이었다. 한 경로만 고치면 F3 드리프트가 남는다.
     * 이 경로는 클라가 전사된 userText를 보내므로 재전사가 필요 없다(transcribe 미주입).
     */
    const sos = await lastResortEmergency({
      sos: { userId, text: userText },
      userName: session.user.name || "사용자",
      companionName: "민지",
      minLevel: 2,   // 이 경로는 대화 흐름이 없고 원래 L2+에서 알림을 보낸다
    }).catch((err) => { console.error("[live-turn] 최후 안전망 실패:", err); return null; });
    /**
     * 안전망이 응급을 잡았으면 **등급을 클라에 돌려준다** — 클라는 emergencyLevel 3을 보고 119 안내 배너를
     *   띄운다(app/live/page.tsx). 예전엔 판정·알림은 해 놓고 응답엔 등급 없이 500만 줘서, RDS 장애
     *   (이 안전망이 존재하는 바로 그 상황) 중에 "숨이 안 쉬어져"라고 하면 보호자 알림은 시도되지만
     *   어르신 화면엔 119 안내가 뜨지 않았다(2026-10-06 적대 감사). 상태 코드는 500 그대로 둔다(저장은 실패했다).
     */
    return NextResponse.json(
      { error: "저장 중 오류가 발생했습니다.", ...(sos?.fired ? { emergencyLevel: sos.level } : {}) },
      { status: 500 },
    );
  }
}
