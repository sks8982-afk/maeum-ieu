/** 프롬프트 조립 */

import type { TimeContext, WeatherContext } from "./types";
import { SYSTEM_PROMPT_BASE, COGNITIVE_SCREENING_PROTOCOL } from "./constants";
import { prisma } from "@/lib/prisma";
import { toKstDateString } from "./time";

export function getHonorific(age: number | null, gender: string | null): string {
  if (age == null || gender == null) return "회원님";
  if (age >= 60) return gender === "male" ? "할아버지" : gender === "female" ? "할머니" : "회원님";
  if (age >= 40) return gender === "male" ? "아빠" : gender === "female" ? "엄마" : "회원님";
  return "회원님";
}

function buildEnvBlock(timeCtx: TimeContext, weather: WeatherContext): string {
  return `[현재 환경 정보 — 실시간 서버 데이터, 반드시 신뢰하세요]
- 현재 한국 시각: ${timeCtx.dateStr}
- 시간대: ${timeCtx.timeLabel}
- ${weather.promptText}

날짜/요일/시각을 말할 때는 반드시 위 정보를 사용하세요. 자체 추측 금지.`;
}

async function getDateAwareBlock(conversationId: string, todayKst: string): Promise<string> {
  const last = await prisma.message.findFirst({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!last) return "";
  const lastDate = toKstDateString(last.createdAt);
  if (lastDate === todayKst) return "";
  return `\n[날짜 안내] 마지막 대화는 ${lastDate}이었고, 오늘은 ${todayKst}입니다. 오늘 기준으로 식사/활동을 물어보세요.`;
}

async function getTodayAssessedDomains(userId: string): Promise<string[]> {
  try {
    const rows = await prisma.$queryRawUnsafe<{ domain: string }[]>(
      `SELECT DISTINCT domain FROM cognitive_assessments WHERE user_id = $1 AND session_date = $2::date`,
      userId, toKstDateString(new Date()),
    );
    return rows.map((r) => r.domain);
  } catch { return []; }
}

export interface PromptParts {
  systemPrompt: string;
  envBlock: string;
  userName: string;
  honorific: string;
}

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

  const userBlock = `[사용자 정보]\n- 이름: ${userName}\n- 호칭: ${honorific}`;
  const envBlock = buildEnvBlock(timeCtx, weather);
  const todayKst = toKstDateString(new Date());
  const dateBlock = conversationId ? await getDateAwareBlock(conversationId, todayKst) : "";

  const assessed = await getTodayAssessedDomains(userId);
  const allDomains = ["orientation_time", "orientation_place", "memory_immediate", "memory_delayed", "language", "judgment"];
  const remaining = allDomains.filter((d) => !assessed.includes(d));
  const guideBlock = remaining.length === 0
    ? "\n[인지 선별] 오늘 6개 영역 모두 확인 완료. 편안한 대화만 이어가세요."
    : `\n[인지 선별] 아직 확인 안 한 영역: ${remaining.join(", ")}. 1~2개를 자연스럽게 확인하세요.`;

  const systemPrompt = [SYSTEM_PROMPT_BASE, userBlock, envBlock, dateBlock, COGNITIVE_SCREENING_PROTOCOL, guideBlock].filter(Boolean).join("\n\n");

  return { systemPrompt, envBlock: `${userBlock}\n${envBlock}`, userName, honorific };
}
