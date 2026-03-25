/** KST 시간 관련 유틸리티 */

import type { TimeContext } from "./types";
import { DATE_TIME_PATTERNS } from "./constants";

export function getTimeContext(clientTimeIso?: string): TimeContext {
  const now = clientTimeIso ? new Date(clientTimeIso) : new Date();
  const kr = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  const hour = kr.getHours();

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

export function getNowKst(): Date {
  const s = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" });
  return new Date(s.replace(" ", "T") + "+09:00");
}

export function toKstDateString(d: Date): string {
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
}

export function isDateTimeQuestion(text: string): boolean {
  const t = text.trim().replace(/\s+/g, " ");
  return DATE_TIME_PATTERNS.some((p) => p.test(t));
}
