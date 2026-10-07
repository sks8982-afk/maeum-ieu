/**
 * Live API ephemeral token 발급 — 클라이언트가 Gemini Live(WebSocket)에 직결하기 위한 단기 토큰.
 * Vercel 서버리스는 상시 WS 불가 → 공식 패턴(클라 직결 + ephemeral token). API key는 서버에만 존재.
 *
 * 2026-07-20 본선 승격 1차: 페르소나를 한 줄 지시문에서 본선 프롬프트 체계(buildSystemPrompt의
 * stablePrompt = 기본 페르소나 + 호칭 규칙 + 사용자 프로필 + 과거 대화 요약)로 교체.
 * 모델도 3.1-flash-live로 — 입력 전사 품질이 인지분석 가용 수준으로 확인됨(PoC 재측정:
 * "무릎이 좀 시큰거려서" 완벽 전사 · 첫 오디오 1.30s · 79% 단축. 2.5-native-audio는 "무료 피" 오전사).
 *
 * 토큰 제약 크기: liveConnectConstraints.systemInstruction 14,000자까지 발급 검증(2026-07-20).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { GoogleGenAI, Modality } from "@google/genai";
import { geminiTuning } from "@/lib/ai/gemini-config";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { buildSystemPrompt, GENERAL_NO_COGNITIVE_RULE } from "@/lib/chat/prompt";
import { getTimeContext } from "@/lib/chat/time";
import { getWeatherContext } from "@/lib/chat/weather";
import { getDailyUsage, buildDailyLimitReplyForUser } from "@/lib/usage/daily-limit";
import { isLiveBetaEnabledServer } from "@/lib/feature-flags";

const LIVE_MODEL = process.env.LIVE_MODEL || "gemini-3.1-flash-live-preview";
// 발급 검증된 상한(14k)에서 여유를 둔 캡 — 프로필·요약이 비대해도 토큰 발급이 막히지 않게
const MAX_INSTRUCTION_LENGTH = 13000;

export async function POST(req: Request) {
  // 라이브는 재구축 중 경로(2026-07-20 파일럿 일시중단) — 플래그 켠 환경에서만 발급.
  //   ⚠ 서버 인가는 **런타임 제어 가능한** 플래그를 쓴다(2026-10-02). NEXT_PUBLIC_*는
  //     빌드 시 번들에 인라인돼 재빌드 없이는 못 끈다 — 사고 시 즉시 차단이 불가능했다.
  if (!isLiveBetaEnabledServer()) {
    return NextResponse.json({ error: "라이브 베타는 현재 비활성화되어 있습니다." }, { status: 403 });
  }
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const userId = session.user.id;

  /**
   * 보호자(guardian) 계정은 대화 대상이 아니다 — /api/chat과 같은 403.
   *
   * 결함(2026-10-06 발견): /api/chat은 2026-10-01에 guardian을 막았는데 이 경로엔 건너오지
   *   않았다. 아래 mode 판정이 "일반인 외에는 user"라서 보호자가 **어르신 페르소나**
   *   (80/20 + 인지 확인 질문)로 세션을 받았다 — /api/chat에서 고친 것과 똑같은 결함이다.
   *   UI는 guardian을 /expert로 보내므로 직접 API 호출 시에만 발생한다(Live 베타는 현재 off).
   */
  if (session.user.screeningMode === "guardian") {
    return NextResponse.json(
      { error: "보호자 계정은 대화 기능을 사용할 수 없습니다. 환자 관리 화면을 이용해주세요." },
      { status: 403 },
    );
  }
  /**
   * 전문가(pro)도 Live를 쓰지 않는다 — Live엔 대리 귀속(proxyPatientId)이 없다(2026-10-06 적대 감사).
   *   대리 검진 중 "음성 대화로 전환"을 누르면 **검사자 본인 세션**의 Live로 넘어가, 기기 앞의 환자가
   *   하는 말과 응급이 **검사자 계정**에 기록됐다(환자의 가족 이름·건강 사실이 검사자 프로필로,
   *   응급 알림은 검사자의 보호자 설정 기준으로). /chat도 pro 본인 대화는 /expert로 돌려보낸다.
   *   검진은 대리 검진 화면(/api/chat 대리 경로)에서만 한다.
   */
  if (session.user.screeningMode === "pro") {
    return NextResponse.json(
      { error: "전문가 계정은 음성 대화를 쓸 수 없어요. 검진은 대리 검진 화면에서 진행해 주세요." },
      { status: 403 },
    );
  }

  // 토큰 발급 남용 방지 — 계정당 분당 10회(세션 재접속 여유 포함)
  const rl = await checkRateLimit(`live-token:${userId}`, 10, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  /**
   * 건강정보 수집 동의 — /api/chat과 같은 게이트(어르신·일반인). 2026-10-06 적대 감사.
   *   이 게이트가 없어서, 미동의 계정이 정상 동작하는 음성 대화를 하는데 서버엔 아무것도 남지 않았다:
   *   매 턴의 /api/live/turn이 동의 게이트에서 403으로 **응급 판정 전에** 버려져, "가슴이 너무 아파"라고
   *   해도 보호자 알림 0건이었다. 안전망이 작동하는 것처럼 보이면서 실제로는 꺼져 있는 상태다.
   *   세션을 시작하기 전에 막고, 클라는 동의 화면으로 보낸다.
   */
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { consentedAt: true } });
  if (!me?.consentedAt) {
    return NextResponse.json({ error: "건강정보 수집 동의가 필요합니다.", needConsent: true }, { status: 403 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "서버 설정 오류" }, { status: 500 });

  // conversationId(선택) — 소유권 확인 후 프롬프트 빌드에 사용(검진 이력·요약 조회 키)
  const body = await req.json().catch(() => ({} as { conversationId?: string }));
  let conversationId: string | undefined;
  if (typeof body?.conversationId === "string") {
    const conv = await prisma.conversation.findUnique({ where: { id: body.conversationId.slice(0, 100) }, select: { userId: true } });
    if (conv && conv.userId === userId) conversationId = body.conversationId.slice(0, 100);
  }

  // 일일 대화량 제한 — /api/chat과 같은 상한을 적용한다. 세션 단위로 발급되는 경로라
  //   여기서 막지 않으면 Live가 제한 우회로가 된다(Live는 턴당 비용이 더 크다).
  //   세션 시작 시점 판정이다. 세션 **중간**에 한도에 닿는 경우는 /api/live/turn이 맡는다
  //   (그 턴의 저장·응급은 처리하고 유료 후처리만 건너뛴 뒤 클라가 세션을 닫는다, 2026-10-06).
  // ⚠ 대상은 /api/chat과 같다 — **어르신(user)만**. 원래 조건이 `!== "general"`이라
  //   위 주석("/api/chat과 같은 상한")과 달리 pro·guardian까지 막고 있었다(2026-10-06 정정).
  const role = session.user.screeningMode;
  // ⚠ conversationId를 빼고 요청하면 예전엔 한도 판정이 **통째로** 빠졌다(2026-10-06 적대 감사).
  //   어르신은 대화가 계정당 하나이므로(Conversation.userId 유일) 없으면 찾아서 센다.
  const limitConvId = conversationId
    ?? (await prisma.conversation.findUnique({ where: { userId }, select: { id: true } }).catch(() => null))?.id;
  // (pro·guardian은 위에서 이미 막혔다 — 남는 건 user·general이고, 한도는 어르신만)
  if (limitConvId && role !== "general") {
    const usage = await getDailyUsage(limitConvId, userId);
    if (usage.exceeded) {
      // 403이지만 클라이언트는 error 대신 message를 읽어 평소 말풍선으로 띄운다 —
      //   어르신에게 "토큰 발급 실패"를 보여주지 않는다.
      //   문구는 /api/live/turn과 같은 헬퍼로 — 들리는 목소리가 경로마다 다르면 어르신이 혼란스럽다.
      return NextResponse.json({
        error: "오늘 대화를 마쳤습니다.",
        dailyLimitReached: true,
        message: await buildDailyLimitReplyForUser(userId),
      }, { status: 403 });
    }
  }

  try {
    // 본선 프롬프트의 안정 프리픽스(페르소나·호칭 규칙·프로필·요약)를 세션 지시문으로 —
    // 검진(pro) 흐름은 Live 미지원이라 일반인 외에는 사용자 모드로 고정.
    const mode = session.user.screeningMode === "general" ? "general" : "user";
    const timeCtx = getTimeContext();
    const weather = await getWeatherContext(); // 좌표 없음 — 기본 지역 폴백(세션 시작 시점 스냅샷)
    const { stablePrompt } = await buildSystemPrompt({ userId, conversationId, timeCtx, weather, mode });

    /**
     * 인지 확인 지시는 **어르신(user)만**. 일반인은 금지 규칙을 받는다(/api/chat과 같은 문구 — 단일 출처).
     *
     * 결함(2026-10-06 적대 감사): mode를 계산해 buildSystemPrompt에 넘기기만 하고, 실제로 쓰는 stablePrompt는
     *   mode와 무관했다(일반인 가이드는 Live가 버리는 turnBlock에만 있다). 그 위에 아래 지시가 **역할 구분 없이**
     *   붙어, 일반인(정신건강 자가점검 사용자)이 대여섯 턴마다 날짜·요일·기억 확인 질문을 받았다
     *   ('general: 인지 선별 차단' 위반). 기존 테스트는 mode 인자만 확인해 이걸 못 잡았다 — 이제 발급되는
     *   지시문 자체를 검사한다(__tests__/live-token-gates.test.ts).
     */
    const cognitiveGuide = mode === "user"
      ? `- 대여섯 턴에 한 번쯤 날짜·요일·식사·최근 기억 같은 가벼운 확인을 수다에 자연스럽게 섞으세요. 검사하는 느낌 절대 금지.
- 사용자가 외워달라던 단어·계산 답 등 평가성 항목은 사용자가 못 떠올려도 정답을 절대 먼저 말하지 마세요.`
      : GENERAL_NO_COGNITIVE_RULE;

    const liveGuide = `

[라이브 음성 대화 — 세션 지시]
- 현재 한국 시각: ${timeCtx.dateStr} (${timeCtx.timeLabel}). 날씨: ${weather.promptText || weather.description}
- 실시간 음성 대화입니다. 기본 2문장 이내(120자)로 짧게, 질문은 한 번에 하나만.
${cognitiveGuide}
- 위급 신호(가슴 통증·호흡곤란·쓰러짐·자살 암시)가 보이면 공감 후 즉시 119·보호자 연락을 부드럽지만 단호하게 권하세요.`;

    let systemInstruction = `${stablePrompt}${liveGuide}`;
    if (systemInstruction.length > MAX_INSTRUCTION_LENGTH) {
      // 과대 시 안정 프리픽스 뒤쪽(요약부)이 잘리도록 앞에서부터 보존
      systemInstruction = systemInstruction.slice(0, MAX_INSTRUCTION_LENGTH - liveGuide.length) + liveGuide;
    }

    const ai = new GoogleGenAI({ apiKey });
    const token = await ai.authTokens.create({
      config: {
        uses: 1, // 1회 연결용 — 재연결 시 재발급
        expireTime: new Date(Date.now() + 30 * 60_000).toISOString(), // 세션 최대 30분
        newSessionExpireTime: new Date(Date.now() + 2 * 60_000).toISOString(), // 2분 내 연결 시작
        liveConnectConstraints: {
          model: LIVE_MODEL, // 다른 모델로의 남용 차단
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction,
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            // PoC: thinking 미제한 시 첫 오디오 +2.6s — Live 경로에선 0이 정상 작동(3.1에서도 검증)
            //   예산 0은 ≤3.8 모델에만 실린다. 3.9+·4+·별칭은 thinkingBudget을 400으로 거부하므로 헬퍼가
            //   '사고 없음'에 해당하는 thinkingLevel "minimal"로 바꾼다(lib/ai/gemini-config). ⚠ 모델마다 다르다:
            //   3.8 Live는 thinkingLevel 자체를, 3.8 Live Extended Thinking은 minimal을 받지 않는다(문서) —
            //   LIVE_MODEL을 바꿀 땐 그 모델의 지원표부터 확인하고 실기기로 첫 오디오 지연을 재측정할 것.
            ...geminiTuning(LIVE_MODEL, { thinkingBudget: 0, thinkingLevel: "minimal" }),
          },
        },
        httpOptions: { apiVersion: "v1alpha" },
      },
    });
    return NextResponse.json({ token: token.name, model: LIVE_MODEL });
  } catch (e) {
    console.error("[live-token] 발급 실패:", (e as Error).message);
    return NextResponse.json({ error: "토큰 발급에 실패했습니다." }, { status: 502 });
  }
}
