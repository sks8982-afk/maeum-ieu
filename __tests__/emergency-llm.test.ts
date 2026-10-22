/**
 * 응급 LLM 백스톱(detectEmergencyLLM) 단위 테스트.
 *
 * 왜 지금 쓰는가 — 2026-10-02 커버리지 도입으로 드러난 사실:
 *   이 모듈은 **분기 커버리지 0%**였다(0/18). 정규식이 놓친 응급을 잡는 마지막 그물인데
 *   함수 본체를 지나는 테스트가 하나도 없었다. SOFT_SIGNAL 정규식만 safety-regression이
 *   훑고 있었고, 그래서 "응급 백스톱은 검증됨"이라는 인식이 사실과 달랐다.
 *
 * 설계상 이 모듈의 계약은 두 방향이다. 둘 다 고정해야 의미가 있다:
 *   (A) 놓치지 않는다 — 유효 카테고리 + level≥2면 반드시 EmergencyResult를 돌려준다.
 *   (B) 더 나빠지지 않는다 — 키 없음·장애·파싱실패·판정불가에서 **반드시 null**을 돌려
 *       정규식 단독 동작으로 되돌아간다. 여기서 throw하면 응답 경로 전체가 500이 된다.
 *
 * 그리고 비용 계약이 하나 더 있다:
 *   (C) SOFT_SIGNAL에 안 걸리면 **LLM을 호출하지 않는다.** 이건 성능·비용의 핵심이다 —
 *       백스톱은 응답 전 블로킹 호출이라, 필터가 넓어지면 평범한 일상 대화가 전부 느려진다.
 *       호출 횟수 자체를 단언한다(2026-06-26 측정: 발화율 8.4%→1.7%로 정밀화한 이력).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateContent = vi.fn();
const logUsage = vi.fn();

vi.mock("@/lib/chat/llm", () => ({
  getGenAI: () => ({ models: { generateContent } }),
  COMPANION_SAFETY_SETTINGS: [],
  logUsage: (...a: unknown[]) => logUsage(...(a as [])),
  LLM_TIMEOUT_MS: { emergency: 5000 },
  timeoutSignal: () => undefined,
}));

/** Gemini 응답 모양 — text는 JSON 문자열 */
const reply = (obj: unknown) => ({ text: JSON.stringify(obj) });

async function detect(text: string) {
  const { detectEmergencyLLM } = await import("@/lib/chat/emergency-llm");
  return detectEmergencyLLM(text);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GEMINI_API_KEY = "test-key";
});

describe("(C) 비용 계약 — 신호 없으면 LLM을 부르지 않는다", () => {
  it.each([
    "오늘 점심에 칼국수 먹었어",
    "손주가 어제 놀러 왔다네",
    "날씨가 참 좋구먼",
    "",
  ])("일상 발화는 호출 0회: %s", async (t) => {
    const r = await detect(t);
    expect(r).toBeNull();
    // 🔒 이게 깨지면 모든 턴이 블로킹 LLM 호출을 타서 따뜻한 대화가 느려진다
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("1000자 초과는 호출하지 않는다 (비용 상한)", async () => {
    const long = "약을 먹었어 ".repeat(200);   // SOFT_SIGNAL엔 걸리지만 길이 초과
    expect(long.length).toBeGreaterThan(1000);
    const r = await detect(long);
    expect(r).toBeNull();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("신호가 있으면 호출한다 (필터가 과하게 좁아지는 회귀 방지)", async () => {
    generateContent.mockResolvedValue(reply({ category: "none", level: 0 }));
    await detect("수면제를 모아뒀다가 한 번에 먹으면 어떻게 될까");
    // 🔒 0회가 되면 백스톱이 사실상 꺼진 것 — 과소감지 꼬리가 통째로 되살아난다
    expect(generateContent).toHaveBeenCalledTimes(1);
  });
});

describe("(A) 위기를 놓치지 않는다", () => {
  it("suicidal L3 → EmergencyResult", async () => {
    generateContent.mockResolvedValue(reply({ category: "suicidal", level: 3, reason: "과량복용 의도" }));
    const r = await detect("수면제 모아뒀다 먹고 영원히 잠들고 싶어");
    expect(r).not.toBeNull();
    expect(r!.level).toBe(3);
    expect(r!.category).toBe("suicidal");
    expect(r!.evidence).toMatch(/^llm:/);   // 출처가 백스톱임이 드러나야 운영자가 추적 가능
  });

  it("L2도 통과시킨다 (경계값)", async () => {
    generateContent.mockResolvedValue(reply({ category: "medical_acute", level: 2 }));
    const r = await detect("숨이 차고 가슴이 조여");
    expect(r?.level).toBe(2);
  });

  it("level 4 같은 범위 밖 값은 3으로 클램프", async () => {
    generateContent.mockResolvedValue(reply({ category: "bleeding", level: 9 }));
    const r = await detect("피가 멈추질 않아");
    expect(r?.level).toBe(3);
  });

  it("5개 유효 카테고리를 모두 받아들인다", async () => {
    for (const c of ["suicidal", "medical_acute", "medication_error", "fall_injury", "bleeding"]) {
      generateContent.mockResolvedValue(reply({ category: c, level: 2 }));
      const r = await detect("약을 두 번 먹었어");
      // 🔒 카테고리 집합이 축소되면 해당 유형의 백스톱이 통째로 죽는다
      expect(r?.category, c).toBe(c);
    }
  });
});

describe("(B) 더 나빠지지 않는다 — 실패는 전부 null (throw 금지)", () => {
  it("API 키가 없으면 호출 없이 null", async () => {
    delete process.env.GEMINI_API_KEY;
    const r = await detect("수면제 모아뒀다 먹고 영원히 잠들고 싶어");
    expect(r).toBeNull();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("LLM이 throw해도 null (응답 경로를 500으로 만들지 않는다)", async () => {
    generateContent.mockRejectedValue(new Error("deadline exceeded"));
    // 🔒 여기서 예외가 새면 응급 발화를 한 어르신이 500을 본다
    await expect(detect("수면제 모아뒀다 먹고 영원히 잠들고 싶어")).resolves.toBeNull();
  });

  it("JSON이 깨져도 null", async () => {
    generateContent.mockResolvedValue({ text: "이건 JSON이 아닙니다" });
    await expect(detect("약을 한 움큼 삼켰으면 좋겠어")).resolves.toBeNull();
  });

  it("빈 응답(text undefined)도 null", async () => {
    generateContent.mockResolvedValue({});
    await expect(detect("약을 한 움큼 삼켰으면 좋겠어")).resolves.toBeNull();
  });

  it("none 판정은 발동하지 않는다 (과잉경보 금지)", async () => {
    generateContent.mockResolvedValue(reply({ category: "none", level: 0 }));
    expect(await detect("보고 싶어 죽겠네")).toBeNull();
  });

  it("level 1 저신뢰는 발동하지 않는다 (L2 미만 컷)", async () => {
    generateContent.mockResolvedValue(reply({ category: "suicidal", level: 1 }));
    // 🔒 L1까지 올리면 알림 폭주 — 공용 Gmail 한도를 태워 다른 환자 알림까지 끊긴다
    expect(await detect("사라지고 싶은 날이네")).toBeNull();
  });

  it("알 수 없는 카테고리는 발동하지 않는다", async () => {
    generateContent.mockResolvedValue(reply({ category: "depression", level: 3 }));
    expect(await detect("죽고 싶다는 생각이 드네")).toBeNull();
  });

  it("level이 문자열·누락이어도 터지지 않는다", async () => {
    generateContent.mockResolvedValue(reply({ category: "suicidal", level: "셋" }));
    await expect(detect("목을 매고 싶어")).resolves.toBeNull();   // Number("셋")=NaN → 0 → 컷
    generateContent.mockResolvedValue(reply({ category: "suicidal" }));
    await expect(detect("목을 매고 싶어")).resolves.toBeNull();
  });
});

describe("호출 설정 — 비용·정확도에 직결되는 파라미터 고정", () => {
  it("temperature 0 · JSON 스키마 강제 · thinking 예산 제한", async () => {
    generateContent.mockResolvedValue(reply({ category: "none", level: 0 }));
    await detect("수면제를 모아두고 있어");
    const cfg = generateContent.mock.calls[0][0].config;
    expect(cfg.temperature).toBe(0);                    // 안전 분류기에 창의성은 해롭다
    expect(cfg.responseMimeType).toBe("application/json");
    // 🔒 maxOutputTokens는 thinking 합산이다. thinkingBudget보다 충분히 크지 않으면
    //    thinking이 예산을 다 먹어 출력이 잘리고 파싱 실패 → 백스톱이 조용히 전멸한다(2026-06-25).
    expect(cfg.maxOutputTokens).toBeGreaterThan(cfg.thinkingConfig.thinkingBudget * 2);
  });
});

describe("프롬프트 카테고리 정의 — 분류가 L3 안내 문구를 고른다(2026-10-22)", () => {
  async function promptOf(text: string): Promise<string> {
    generateContent.mockResolvedValue(reply({ category: "none", level: 0 }));
    await detect(text);
    return generateContent.mock.calls[0][0].contents as string;
  }

  it("bleeding은 낙상 줄에 붙지 않고 제 줄에 정의된다", async () => {
    const p = await promptOf("피나요");
    // 🔒 "- fall_injury: …. bleeding: 멈추지 않는 출혈."처럼 한 줄에 붙어 있으면 모델이 bleeding을 한 번도 고르지 않았다
    //    (실측 출혈 66회 모두 fall_injury → 어르신 안내가 "움직이지 마시고"로 나가 지혈 안내가 빠졌다)
    expect(p).toMatch(/^- bleeding: /m);
    expect(p).not.toMatch(/^- fall_injury:.*bleeding/m);
    expect(p).toMatch(/^- bleeding: .*맨 "피나요"/m);
  });

  it("낙상이 섞이면 fall_injury, 몸속 출혈 신호는 medical_acute", async () => {
    const p = await promptOf("피나요");
    expect(p).toMatch(/^- fall_injury: .*낙상과 함께 피가 나도 fall_injury/m);   // 정규식도 낙상 규칙이 출혈보다 먼저다
    expect(p).toMatch(/^- medical_acute: .*(?:토혈|각혈|혈변).*medical_acute/m);   // 피를 토한 어르신에게 "수건으로 꾹"은 맞지 않는다
  });

  it("작은 상처·음식의 피는 none — 단 안 멈추거나 본인이 다쳤으면 bleeding", async () => {
    const p = await promptOf("피나요");
    // 🔒 bleeding을 넓힌 뒤 "면도하다 살짝 베여서 피가 났어"·"모기 물린 데 긁었더니 피 났네"가 L2(보호자 알림)로 떴다
    expect(p).toMatch(/^- bleeding: .*작은 상처의 피.*none.*안 멈추면 bleeding/m);
    expect(p).toMatch(/^- bleeding: .*음식의 피.*none.*다쳤다는 말이 있을 때만 bleeding/m);
  });
});

describe("점·쉼표 띄어쓰기 — 사전필터를 정규식과 같은 정규화로 본다(2026-10-19)", () => {
  it("'..'로 띄운 '숨이..너무..차'도 LLM을 부른다", async () => {
    generateContent.mockResolvedValue(reply({ category: "medical_acute", level: 3 }));
    const r = await detect("숨이..너무..차");
    // 🔒 정규화 없이 보면 '.'이 사전필터의 숨 갈래를 끊어 호출 자체가 없다(노인 문자 말투 "숨이..차..")
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(r?.level).toBe(3);
  });
});
