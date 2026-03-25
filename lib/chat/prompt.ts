/** 프롬프트 조립 관련 함수 */

import type { TimeContext, WeatherContext } from "./types";
import { SYSTEM_PROMPT_BASE, COGNITIVE_SCREENING_PROTOCOL, COGNITIVE_DETECTION_RULE } from "./constants";
import { prisma } from "@/lib/prisma";
import { toKstDateString } from "./time";

/** 연령·성별로 호칭 추론 */
export function getHonorific(age: number | null, gender: string | null): string {
  if (age == null || gender == null) return "회원님";
  if (age >= 60) return gender === "male" ? "할아버지" : gender === "female" ? "할머니" : "회원님";
  if (age >= 40) return gender === "male" ? "아빠" : gender === "female" ? "엄마" : "회원님";
  return "회원님";
}

/** 환경 컨텍스트 블록 (프롬프트 삽입용) */
function buildContextBlock(timeCtx: TimeContext, weather: WeatherContext): string {
  return `[현재 환경 정보]
- 현재 시각대: ${timeCtx.timeLabel} (${timeCtx.dateStr})
- ${weather.promptText}

위 정보를 활용해 "점심 드셨나요?", "오늘 날씨가 좋은데 산책 어떠세요?"처럼 구체적인 선제적 질문을 해 주세요.`;
}

/** 마지막 대화가 오늘과 다른 날이면 날짜 안내 블록 반환 */
async function getDateAwareBlock(conversationId: string, todayKst: string): Promise<string> {
  const last = await prisma.message.findFirst({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!last) return "";
  const lastDateStr = toKstDateString(last.createdAt);
  if (lastDateStr === todayKst) return "";

  return `

[날짜 안내]
마지막 대화는 ${lastDateStr}이었고, 오늘은 ${todayKst}입니다. 새로운 날이므로 **오늘의** 식사(아침/점심/저녁), 산책·외부 활동 등을 새로 여쭤보세요. 어제 이전 대화는 기억하되, 식사·활동은 반드시 '오늘' 기준으로만 물어보세요.`;
}

/** 오늘 이미 평가된 인지 영역 조회 (중복 평가 방지) */
async function getTodayAssessedDomains(userId: string): Promise<string[]> {
  const todayKst = toKstDateString(new Date());
  try {
    const rows = await prisma.$queryRawUnsafe<{ domain: string }[]>(
      `SELECT DISTINCT domain FROM cognitive_assessments WHERE user_id = $1 AND session_date = $2::date`,
      userId,
      todayKst,
    );
    return rows.map((r) => r.domain);
  } catch {
    // 테이블이 아직 없을 수 있음
    return [];
  }
}

/** 오늘 평가 안 된 영역을 프롬프트에 안내 */
function buildCognitiveGuideBlock(assessedDomains: string[]): string {
  const allDomains = [
    "orientation_time", "orientation_place",
    "memory_immediate", "memory_delayed",
    "language", "judgment",
  ];
  const remaining = allDomains.filter((d) => !assessedDomains.includes(d));

  if (remaining.length === 0) {
    return `

[인지 선별 안내]
오늘은 6개 영역 모두 확인 완료했습니다. 추가 인지 질문은 하지 말고, 편안한 일상 대화만 이어가세요.
cognitiveChecks는 빈 배열로 두세요.`;
  }

  const domainLabels: Record<string, string> = {
    orientation_time: "시간 지남력 (오늘 날짜/요일 질문)",
    orientation_place: "장소 지남력 (현재 위치 질문)",
    memory_immediate: "즉시 기억력 (방금 대화 확인)",
    memory_delayed: "지연 기억력 (이전 대화 확인)",
    language: "언어 유창성 (대화 중 관찰)",
    judgment: "판단력 (상황 판단 질문)",
  };

  const list = remaining.map((d) => `  - ${domainLabels[d] ?? d}`).join("\n");

  return `

[인지 선별 안내]
오늘 아직 확인하지 않은 영역:
${list}

위 영역 중 1~2개를 이번 대화에서 자연스럽게 확인하세요. 시험처럼 연달아 묻지 마세요.
이미 확인된 영역: ${assessedDomains.length > 0 ? assessedDomains.join(", ") : "없음"}`;
}

export interface PromptParts {
  systemPrompt: string;
  userName: string;
  honorific: string;
}

/** 전체 시스템 프롬프트를 조립하여 반환 */
export async function buildSystemPrompt(params: {
  userId: string;
  conversationId?: string;
  timeCtx: TimeContext;
  weather: WeatherContext;
}): Promise<PromptParts> {
  const { userId, conversationId, timeCtx, weather } = params;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, age: true, gender: true },
  });
  const userName = user?.name?.trim() || "사용자";
  const honorific = getHonorific(user?.age ?? null, user?.gender ?? null);

  const userBlock = `[사용자 정보]
- 이름: ${userName}
- 호칭: ${honorific} (대화할 때 반드시 이 호칭으로 부르세요. 예: "할아버지", "할머니", "엄마", "아빠", "회원님")`;

  const contextBlock = buildContextBlock(timeCtx, weather);
  const todayKst = toKstDateString(new Date());
  const dateAwareBlock = conversationId
    ? await getDateAwareBlock(conversationId, todayKst)
    : "";

  const assessedDomains = await getTodayAssessedDomains(userId);
  const cognitiveGuideBlock = buildCognitiveGuideBlock(assessedDomains);

  const systemPrompt = [
    SYSTEM_PROMPT_BASE,
    userBlock,
    contextBlock,
    dateAwareBlock,
    COGNITIVE_SCREENING_PROTOCOL,
    cognitiveGuideBlock,
    COGNITIVE_DETECTION_RULE,
  ].filter(Boolean).join("\n\n");

  return { systemPrompt, userName, honorific };
}
