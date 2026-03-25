/** KST 시간 관련 유틸리티 */

import type { TimeContext } from "./types";
import { DATE_TIME_PATTERNS } from "./constants";

/** 클라이언트 시간 또는 서버 시간 기준으로 시간대 레이블 생성 */
export function getTimeContext(clientTimeIso?: string): TimeContext {
  const now = clientTimeIso ? new Date(clientTimeIso) : new Date();
  const kr = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const hour = kr.getHours();
  const minute = kr.getMinutes();

  // "2026년 3월 25일 수요일 오후 3시 30분" 형태로 구체적으로 전달
  const dateStr = now.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  });

  let timeLabel = "오후";
  if (hour >= 5 && hour < 10) timeLabel = "아침";
  else if (hour >= 10 && hour < 14) timeLabel = "오전";
  else if (hour >= 14 && hour < 17) timeLabel = "점심 시간대";
  else if (hour >= 17 && hour < 21) timeLabel = "저녁";

  return { timeLabel, hour, dateStr };
}

/** 한국 시각 전체 문자열 (날짜/시간 질문에 답할 때 사용) */
export function getCurrentKstDateTimeString(clientTimeIso?: string): string {
  const now = clientTimeIso ? new Date(clientTimeIso) : new Date();
  return now.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** KST 기준 현재 시각을 DB 저장용 Date로 반환 */
export function getNowKst(): Date {
  const s = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" });
  return new Date(s.replace(" ", "T") + "+09:00");
}

/** Date를 한국 날짜 문자열로 (YYYY-MM-DD) */
export function toKstDateString(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

/** 사용자가 현재 날짜/시간을 물어보는지 여부 */
export function isDateTimeQuestion(text: string): boolean {
  const t = text.trim().replace(/\s+/g, " ");
  return DATE_TIME_PATTERNS.some((p) => p.test(t));
}
