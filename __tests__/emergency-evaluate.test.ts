/**
 * 응급 평가 1단계(detectWithBackstop) — 정규식이 L2 미만이면 백스톱을 태운다.
 *
 * 결함(2026-10-19 독립 검토): 예전엔 정규식이 none일 때만 백스톱을 불러,
 *   "기운이 하나도 없고 숨이 너무 차"처럼 앞의 L1(관찰) 표현이 잡히면 뒤의 급성 신호가 있어도
 *   백스톱 호출 자체가 없었다(정규식 L1 → 보호자 알림 없음).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const backstop = vi.fn<(text: string) => Promise<{ level: 2 | 3; category: string; evidence: string } | null>>(async () => null);
vi.mock("@/lib/chat/emergency-llm", () => ({ detectEmergencyLLM: (t: string) => backstop(t) }));
vi.mock("@/lib/chat/messages", () => ({ countRecentL1Signals: vi.fn(async () => 0) }));

import { detectWithBackstop } from "@/lib/chat/emergency-evaluate";

beforeEach(() => {
  backstop.mockReset();
  backstop.mockImplementation(async () => null);
});

describe("detectWithBackstop — 백스톱을 태우는 범위", () => {
  it("정규식 L1이어도 백스톱을 부르고, 백스톱의 L3를 쓴다", async () => {
    backstop.mockImplementation(async () => ({ level: 3, category: "medical_acute", evidence: "llm:숨" }));
    const r = await detectWithBackstop("기운이 하나도 없고 숨이 너무 차");
    // 🔒 L1에서 멈추면 "숨이 너무 차"(급성 호흡곤란 의심)가 관찰 등급에 묻힌다
    expect(backstop).toHaveBeenCalledTimes(1);
    expect(r.level).toBe(3);
    expect(r.category).toBe("medical_acute");
  });

  it("백스톱이 아니라고 하면(null) 정규식 L1을 그대로 둔다 — 누적 승격 경로가 살아 있어야 한다", async () => {
    const r = await detectWithBackstop("기운이 하나도 없어");
    expect(backstop).toHaveBeenCalledTimes(1);
    expect(r.level).toBe(1);
    expect(r.category).toBe("weakness_trend");
  });

  it("정규식 L2 이상이면 백스톱을 부르지 않는다(응답 전 블로킹 호출 — 이미 잡힌 발화는 지연 0)", async () => {
    const r = await detectWithBackstop("숨이 막혀");
    expect(backstop).not.toHaveBeenCalled();
    expect(r.level).toBe(3);
  });

  it("정규식 none이면 백스톱을 부른다(기존 동작 유지)", async () => {
    backstop.mockImplementation(async () => ({ level: 2, category: "bleeding", evidence: "llm:피" }));
    const r = await detectWithBackstop("손에서 피가 나");
    expect(backstop).toHaveBeenCalledTimes(1);
    expect(r.level).toBe(2);
  });
});
