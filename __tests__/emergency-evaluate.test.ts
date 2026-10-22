/**
 * 응급 평가 1단계(detectWithBackstop) — 정규식이 L2 미만이면 백스톱을 태운다.
 *
 * 결함(2026-10-19 독립 검토): 예전엔 정규식이 none일 때만 백스톱을 불러,
 *   "기운이 하나도 없고 숨이 너무 차"처럼 앞의 L1(관찰) 표현이 잡히면 뒤의 급성 신호가 있어도
 *   백스톱 호출 자체가 없었다(정규식 L1 → 보호자 알림 없음).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const backstop = vi.fn<(text: string) => Promise<{ level: 2 | 3; category: string; evidence: string } | null>>(async () => null);
type Verdict = { kind: "emergency"; result: { level: 2 | 3; category: string; evidence: string } } | { kind: "none" } | { kind: "error" };
// 근거(두 번째 인자)까지 넘긴다 — 긴 발화는 근거 둘레만 재확인하므로, 근거를 버리는 목이면 그 계약을 못 본다
const confirm = vi.fn<(text: string, evidence?: string) => Promise<Verdict>>(async () => ({ kind: "none" }));
vi.mock("@/lib/chat/emergency-llm", () => ({ detectEmergencyLLM: (t: string) => backstop(t), confirmEmergencyLLM: (t: string, e?: string) => confirm(t, e) }));
vi.mock("@/lib/chat/messages", () => ({ countRecentL1Signals: vi.fn(async () => 0) }));

import { detectWithBackstop } from "@/lib/chat/emergency-evaluate";
import { detectEmergencyDetailed } from "@/lib/chat/emergency";

beforeEach(() => {
  backstop.mockReset();
  backstop.mockImplementation(async () => null);
  confirm.mockReset();
  confirm.mockImplementation(async () => ({ kind: "none" }));
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

  it("백스톱이 throw해도 정규식 판정으로 돌아간다 — 최후 안전망도 이 함수를 쓴다", async () => {
    backstop.mockRejectedValue(new Error("gemini down"));
    // 🔒 여기서 예외가 새면 최후 안전망(lastResortEmergency)째 무너진다
    await expect(detectWithBackstop("기운이 하나도 없어")).resolves.toMatchObject({ level: 1 });
  });
});

describe("detectWithBackstop — 맥락 가드 재확인(2026-10-22)", () => {
  // 가족 전언 주어 + '-대' — 맥락 가드가 지우는 꼴. 지우기 전 판정은 L3 뇌졸중이다
  const FAMILY_REPORTED = "딸이 와서 보더니 내 입이 돌아갔대";

  it("가드가 지운 L3는 백스톱에 다시 묻는다 — 사전필터 백스톱은 부르지 않는다(호출 1회)", async () => {
    await detectWithBackstop(FAMILY_REPORTED);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(backstop).not.toHaveBeenCalled();
  });

  it("백스톱이 '아님'이면 내린다 — 이야기·남의 일은 알림이 가지 않는다", async () => {
    const r = await detectWithBackstop("친구가 넘어져서 다쳤대");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(r.level).toBe(0);
  });

  it("백스톱이 위급이라고 하면 정규식 판정(L3·분류)을 지킨다", async () => {
    confirm.mockImplementation(async () => ({ kind: "emergency", result: { level: 2, category: "fall_injury", evidence: "llm:x" } }));
    const r = await detectWithBackstop(FAMILY_REPORTED);
    // 🔒 백스톱이 L2로 봐도 정규식이 찾은 L3를 낮추지 않는다
    expect(r.level).toBe(3);
    expect(r.category).toBe("medical_acute");
  });

  it("백스톱이 정규식보다 높게 보면 그쪽을 쓴다", async () => {
    confirm.mockImplementation(async () => ({ kind: "emergency", result: { level: 3, category: "medical_acute", evidence: "llm:배" } }));
    // 지난 일 표지('작년엔')가 지운 L2(심한 통증)
    const r = await detectWithBackstop("작년엔 배가 너무 아파서 고생했어");
    expect(r.level).toBe(3);
    expect(r.evidence).toMatch(/^llm:/);
  });

  it("백스톱이 모름(장애·시간 초과·파싱 실패)이면 정규식 L3를 지킨다", async () => {
    confirm.mockImplementation(async () => ({ kind: "error" }));
    const r = await detectWithBackstop(FAMILY_REPORTED);
    // 🔒 모름을 '아님'으로 읽으면 장애 중에 진짜 위급이 조용히 사라진다(가드가 지우던 예전 동작이 그랬다)
    expect(r.level).toBe(3);
  });

  it("백스톱이 throw해도 정규식 L3를 지킨다", async () => {
    confirm.mockRejectedValue(new Error("deadline exceeded"));
    await expect(detectWithBackstop(FAMILY_REPORTED)).resolves.toMatchObject({ level: 3, category: "medical_acute" });
  });

  it("가드가 지운 게 없으면 재확인하지 않는다(평범한 대화 지연 0)", async () => {
    await detectWithBackstop("오늘 점심에 칼국수 먹었어");
    expect(confirm).not.toHaveBeenCalled();
  });
});

// 반려동물 주어 가드('강아지가')가 낙상 L3를 지우고 다른 규칙의 L2(심한 통증)만 남기는 꼴 — 넘어진 사람은 어르신이다.
//   ⚠ "강아지 산책시키다 넘어져서 머리가 너무 아파"(조사 없음)는 지금 가드에 안 걸려 바로 L3다 — 이 꼴을 보려면 주격 조사가 있어야 한다.
const L2_LEFT = "강아지가 끌어서 넘어져서 머리가 너무 아파";
// 음식 손질 가드가 출혈 L3를 지우고 L1(기운 없음)만 남기는 꼴 — 본인이 베였다는 말이 생략됐다
const L1_LEFT = "생선 손질하다가 피가 안 멈춰 기운이 하나도 없어";

describe("detectWithBackstop — 가드 켠 결과가 L2여도 가드가 지운 L3는 재확인한다(2026-10-22 저녁)", () => {
  it("전제: 가드 켠 판정은 L2 심한 통증, 가드가 지운 판정은 L3 낙상", () => {
    // 🔒 이 전제가 깨지면(가드·규칙이 바뀌면) 아래 시험은 다른 경로를 본다 — 같은 꼴의 다른 문장으로 바꾼다
    expect(detectEmergencyDetailed(L2_LEFT)).toMatchObject({
      result: { level: 2, category: "severe_pain", evidence: "머리가 너무 아파" },
      suppressed: { level: 3, category: "fall_injury", evidence: "넘어져서 머리가 너무 아파" },
    });
  });

  it("재확인이 '아님'이면 가드 켠 L2를 그대로 — 재확인 1회, 사전필터 백스톱은 부르지 않는다", async () => {
    const r = await detectWithBackstop(L2_LEFT);
    // 🔒 L2에서 먼저 멈추면 재확인이 0회다 — 지워진 L3(119 안내·즉시 알림)가 묻지도 않고 L2로 내려간다
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(backstop).not.toHaveBeenCalled();
    expect(r).toMatchObject({ level: 2, category: "severe_pain", evidence: "머리가 너무 아파" });
  });

  it("재확인이 모름(error)이면 지워진 L3 낙상을 지킨다", async () => {
    confirm.mockImplementation(async () => ({ kind: "error" }));
    const r = await detectWithBackstop(L2_LEFT);
    // 🔒 L2로 남으면 "넘어져서 머리가 아파"에 119 안내가 안 나가고 프롬프트 힌트만 붙는다
    expect(r).toMatchObject({ level: 3, category: "fall_injury" });
  });

  it("재확인이 '위급이지만 L2'여도 지워진 L3(근거·분류)를 쓴다", async () => {
    confirm.mockImplementation(async () => ({ kind: "emergency", result: { level: 2, category: "medical_acute", evidence: "llm:x" } }));
    const r = await detectWithBackstop(L2_LEFT);
    // 🔒 백스톱 등급을 그대로 쓰면 L2 — 정규식이 찾은 L3를 백스톱이 낮추지 못한다
    expect(r).toMatchObject({ level: 3, category: "fall_injury", evidence: "넘어져서 머리가 너무 아파" });
  });

  it("재확인이 throw해도 지워진 L3를 지킨다", async () => {
    confirm.mockRejectedValue(new Error("deadline exceeded"));
    await expect(detectWithBackstop(L2_LEFT)).resolves.toMatchObject({ level: 3, category: "fall_injury" });
  });
});

describe("detectWithBackstop — L1에 남은 재확인 · 재확인에 넘기는 근거 · 가드 없는 L2(2026-10-22 저녁)", () => {
  const PLAIN_L2 = "허리가 너무 아파";

  it("전제: 음식 손질 가드는 출혈 L3를 지우고 L1만 남긴다 · 가드 없는 L2는 지운 게 없다", () => {
    expect(detectEmergencyDetailed(L1_LEFT)).toMatchObject({
      result: { level: 1, category: "weakness_trend" },
      suppressed: { level: 3, category: "bleeding" },
    });
    expect(detectEmergencyDetailed(PLAIN_L2).result).toMatchObject({ level: 2, category: "severe_pain" });
    expect(detectEmergencyDetailed(PLAIN_L2).suppressed).toBeUndefined();
  });

  it("L1 + 지워진 L3 — 재확인이 '아님'이면 L1 그대로(누적 승격 경로), 사전필터 백스톱은 부르지 않는다", async () => {
    const r = await detectWithBackstop(L1_LEFT);
    expect(confirm).toHaveBeenCalledTimes(1);
    // 🔒 재확인이 이미 같은 프롬프트로 물었다 — 사전필터 백스톱까지 태우면 응답 전 블로킹이 두 번이다
    expect(backstop).not.toHaveBeenCalled();
    // 🔒 0으로 내리면 L1 누적 승격(2단계)에서 이 발화가 빠진다
    expect(r).toMatchObject({ level: 1, category: "weakness_trend" });
  });

  it("L1 + 지워진 L3 — 재확인이 모름(error)이면 L3 출혈", async () => {
    confirm.mockImplementation(async () => ({ kind: "error" }));
    const r = await detectWithBackstop(L1_LEFT);
    // 🔒 L1로 남으면 "피가 안 멈춰"에 지혈·119 안내도 보호자 알림도 없다
    expect(r).toMatchObject({ level: 3, category: "bleeding" });
  });

  it.each([L2_LEFT, L1_LEFT])("재확인의 두 번째 인자는 가드가 지운 판정의 근거(suppressed.evidence)다: %s", async (text) => {
    const { result, suppressed } = detectEmergencyDetailed(text);
    expect(suppressed, "전제: 가드가 지운 판정이 있어야 한다").toBeDefined();
    expect(suppressed?.evidence, "전제: 지운 판정의 근거가 가드 켠 판정의 근거와 달라야 둘을 가른다").not.toBe(result.evidence);
    await detectWithBackstop(text);
    // 🔒 근거를 빼거나 가드 켠 판정의 근거를 넘기면, 600자 넘는 발화에서 증상 둘레가 아닌 엉뚱한 곳(또는 모름)을 묻는다
    expect(confirm).toHaveBeenCalledWith(text, suppressed!.evidence);
  });

  it("가드 없는 L2는 재확인도 사전필터 백스톱도 부르지 않고 그대로 L2", async () => {
    const r = await detectWithBackstop(PLAIN_L2);
    // 🔒 이미 잡힌 L2에 LLM을 태우면 응답 전 블로킹 지연만 늘고 결과는 그대로다
    expect(confirm).not.toHaveBeenCalled();
    expect(backstop).not.toHaveBeenCalled();
    expect(r).toMatchObject({ level: 2, category: "severe_pain", evidence: "허리가 너무 아파" });
  });
});
