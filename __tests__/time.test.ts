import { describe, it, expect } from "vitest";
import { isDateTimeQuestion, getTimeContext } from "@/lib/chat/time";

describe("isDateTimeQuestion", () => {
  it.each([
    "몇 시야?",
    "지금 몇 시야",
    "오늘 날짜 알려줘",
    "오늘 며칠이야",
    "현재 시간",
    "한국 시간",
    "몇월 며칠",
    "오늘 몇 시야",
  ])("'%s'를 시간 질문으로 감지한다", (text) => {
    expect(isDateTimeQuestion(text)).toBe(true);
  });

  it.each([
    "밥 먹었어?",
    "오늘 뭐 했어?",
    "날씨 좋네",
    "산책 갈래?",
    "기분이 어때",
  ])("'%s'는 시간 질문이 아니다", (text) => {
    expect(isDateTimeQuestion(text)).toBe(false);
  });
});

describe("getTimeContext", () => {
  it("아침 시간대를 올바르게 판단한다 (7시)", () => {
    // 2026-03-24T07:00:00 KST = 2026-03-23T22:00:00Z
    const ctx = getTimeContext("2026-03-23T22:00:00Z");
    expect(ctx.timeLabel).toBe("아침");
    expect(ctx.hour).toBe(7);
  });

  it("저녁 시간대를 올바르게 판단한다 (19시)", () => {
    // 2026-03-24T19:00:00 KST = 2026-03-24T10:00:00Z
    const ctx = getTimeContext("2026-03-24T10:00:00Z");
    expect(ctx.timeLabel).toBe("저녁");
    expect(ctx.hour).toBe(19);
  });

  it("dateStr에 한국어 날짜와 시각이 포함된다", () => {
    const ctx = getTimeContext("2026-03-24T03:00:00Z");
    // KST 2026-03-24 12:00 → "2026년 3월 24일 화요일 오후 12:00" 형태
    expect(ctx.dateStr).toContain("3월");
    expect(ctx.dateStr).toContain("24일");
    expect(ctx.dateStr).toContain("2026년");
  });
});
