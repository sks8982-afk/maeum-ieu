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
import { detectEmergencyDetailed } from "@/lib/chat/emergency";

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

/** evidence를 빼면 기본값("") — 600자 이하만 물을 수 있다 */
async function confirmVerdict(text: string, evidence?: string) {
  const { confirmEmergencyLLM } = await import("@/lib/chat/emergency-llm");
  return confirmEmergencyLLM(text, evidence);
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

describe("재확인(confirmEmergencyLLM) — 아님과 모름을 가른다(2026-10-22)", () => {
  it("사전필터 없이 묻는다 — 정규식이 이미 신호를 찾은 발화다", async () => {
    generateContent.mockResolvedValue(reply({ category: "none", level: 0 }));
    await confirmVerdict("오늘 점심에 칼국수 먹었어");   // SOFT_SIGNAL에 안 걸리는 말이어도
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it("위급이면 emergency", async () => {
    generateContent.mockResolvedValue(reply({ category: "medical_acute", level: 3 }));
    const v = await confirmVerdict("딸이 와서 보더니 내 입이 돌아갔대");
    expect(v).toMatchObject({ kind: "emergency", result: { level: 3, category: "medical_acute" } });
  });

  it.each([
    [{ category: "none", level: 0 }],
    [{ category: "fall_injury", level: 1 }],
  ])("'아님'은 none — L2 미만이면 분류와 무관: %j", async (out) => {
    generateContent.mockResolvedValue(reply(out));
    expect(await confirmVerdict("친구가 넘어져서 다쳤대")).toEqual({ kind: "none" });
  });

  // 1000자 초과도 이제 근거가 있으면 창으로 묻는다(아래 '재확인 창') — 여기 "가".repeat(1001)이 모름인 까닭은 근거가 없어서다
  it("모름은 error — 장애·빈 응답·깨진 JSON·모르는 분류·키 없음·근거 없는 긴 글", async () => {
    // 🔒 모름을 none으로 읽으면 재확인이 장애 때 진짜 위급을 내린다(호출부는 error면 정규식 L3를 지킨다)
    generateContent.mockRejectedValue(new Error("deadline exceeded"));
    expect(await confirmVerdict("딸이 와서 보더니 내 입이 돌아갔대")).toEqual({ kind: "error" });
    generateContent.mockResolvedValue({});
    expect(await confirmVerdict("딸이 와서 보더니 내 입이 돌아갔대")).toEqual({ kind: "error" });
    generateContent.mockResolvedValue({ text: "JSON 아님" });
    expect(await confirmVerdict("딸이 와서 보더니 내 입이 돌아갔대")).toEqual({ kind: "error" });
    generateContent.mockResolvedValue(reply({ category: "depression", level: 3 }));
    expect(await confirmVerdict("딸이 와서 보더니 내 입이 돌아갔대")).toEqual({ kind: "error" });
    expect(await confirmVerdict("가".repeat(1001))).toEqual({ kind: "error" });
    delete process.env.GEMINI_API_KEY;
    generateContent.mockClear();
    expect(await confirmVerdict("딸이 와서 보더니 내 입이 돌아갔대")).toEqual({ kind: "error" });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("기존 백스톱(detectEmergencyLLM)은 그대로 — 모름도 null", async () => {
    generateContent.mockResolvedValue(reply({ category: "depression", level: 3 }));
    expect(await detect("죽고 싶다는 생각이 드네")).toBeNull();
    generateContent.mockResolvedValue({});
    expect(await detect("약을 한 움큼 삼켰으면 좋겠어")).toBeNull();
  });
});

describe("재확인 창 — 600자를 넘으면 정규식 근거 둘레만 싣는다(2026-10-22 저녁)", () => {
  /** 맨 앞에만 있는 표지 — 창이 근거 둘레로 잘렸는지 본다 */
  const HEAD = "앞머리표지";
  const FILLER = "오늘 점심에 칼국수 먹었어 ";
  /** 맨 끝의 증상 — 정규식 근거('입이 돌아갔')가 여기 있다. 앞의 '드라마'가 맥락 가드다 */
  const TAIL = "근데 지금 갑자기 입이 돌아갔어";
  function longTalk(minLength: number): string {
    let s = `${HEAD} 드라마 이야기 좀 할게 `;
    while (s.length + TAIL.length < minLength) s += FILLER;
    return s + TAIL;
  }
  /** 호출부(detectWithBackstop)가 넘기는 값 그대로 — 정규식이 실제로 돌려준 근거 */
  function evidenceOf(text: string): string {
    const { suppressed } = detectEmergencyDetailed(text);
    expect(suppressed, "전제: 맥락 가드(드라마)가 지운 L3가 있어야 한다").toBeDefined();
    return suppressed!.evidence;
  }
  const promptAt = (i: number) => generateContent.mock.calls[i][0].contents as string;

  it("700자쯤이면 근거 둘레를 싣는다 — 증상은 프롬프트에 있고 맨 앞 표지는 없다", async () => {
    const text = longTalk(700);
    expect(text.length).toBeGreaterThan(600);
    expect(text.length).toBeLessThan(800);
    const ev = evidenceOf(text);
    generateContent.mockResolvedValue(reply({ category: "medical_acute", level: 3 }));
    await confirmVerdict(text, ev);
    const p = promptAt(0);
    // 🔒 예전처럼 앞 600자만 실으면 "드라마 이야기 …(600자 넘게)… 근데 지금 갑자기 입이 돌아갔어"의 증상이 프롬프트에 없어
    //    백스톱의 '아님'에 L3가 내려갔다
    expect(p).toContain(ev);
    expect(p).toContain(TAIL);
    expect(p).not.toContain(HEAD);
  });

  it("1000자를 넘어도 근거가 있으면 묻는다 — 예전엔 묻지도 않고 모름(긴 드라마 이야기도 119 안내)이었다", async () => {
    const text = longTalk(1200);
    expect(text.length).toBeGreaterThanOrEqual(1200);
    const ev = evidenceOf(text);
    generateContent.mockResolvedValue(reply({ category: "medical_acute", level: 3 }));
    const v = await confirmVerdict(text, ev);
    expect(generateContent).toHaveBeenCalledTimes(1);
    expect(v).toMatchObject({ kind: "emergency", result: { level: 3 } });
    expect(promptAt(0)).toContain(ev);
  });

  it("600자를 넘는데 근거가 없거나 글에 없으면 모름(error) — Gemini를 부르지 않는다", async () => {
    const text = longTalk(700);
    generateContent.mockResolvedValue(reply({ category: "none", level: 0 }));
    // 🔒 근거 없이 아무 데나 잘라 물으면 증상이 빠진 창의 '아님'에 L3가 내려간다 — 모름이면 호출부가 정규식 L3를 지킨다
    expect(await confirmVerdict(text)).toEqual({ kind: "error" });
    expect(await confirmVerdict(text, "피가 철철")).toEqual({ kind: "error" });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it("600자 이하는 근거와 무관하게 글 전체를 싣는다(경계 600자)", async () => {
    const END = "끝자리표지";
    const text = (`${HEAD} ` + FILLER.repeat(60)).slice(0, 600 - END.length) + END;
    expect(text.length).toBe(600);
    generateContent.mockResolvedValue(reply({ category: "none", level: 0 }));
    await confirmVerdict(text);
    await confirmVerdict(text, "글에 없는 근거");
    // 🔒 경계를 600 미만으로 잡으면 600자 발화가 창 경로로 가서, 근거가 없을 때 묻지도 못하고 모름이 된다
    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(promptAt(0)).toContain(text);
    expect(promptAt(1)).toContain(text);
  });
});

describe("재확인 응답 해석 — 등급이 숫자가 아니면 모름(2026-10-22 저녁)", () => {
  const STROKE = "딸이 와서 보더니 내 입이 돌아갔대";

  it.each([
    ["level 빠짐", reply({ category: "medical_acute" })],
    ["level null", reply({ category: "medical_acute", level: null })],
    ['level "high"', reply({ category: "medical_acute", level: "high" })],
    ["배열 JSON", reply([{ category: "medical_acute", level: 3 }])],
    ["숫자 JSON", reply(3)],
  ])("%s → 모름(error) — 예전엔 0(아님)으로 읽어 재확인이 정규식 L3를 버렸다", async (_label, res) => {
    generateContent.mockResolvedValue(res);
    // 🔒 아님(none)으로 읽으면 호출부가 가드에 걸린 진짜 위급(뇌졸중)을 내린다 — 모름이어야 정규식 L3를 지킨다
    expect(await confirmVerdict(STROKE)).toEqual({ kind: "error" });
  });

  it('level 문자열 "3" + bleeding → 위급 L3 출혈', async () => {
    generateContent.mockResolvedValue(reply({ category: "bleeding", level: "3" }));
    // 🔒 숫자만 받으면 스키마를 벗어난 "3"이 모름이 된다 — 재확인은 지키지만 사전필터 백스톱은 이 위급을 놓친다
    expect(await confirmVerdict(STROKE)).toEqual({
      kind: "emergency", result: { level: 3, category: "bleeding", evidence: expect.stringMatching(/^llm:/) },
    });
  });

  it("사전필터 백스톱(detectEmergencyLLM)은 level이 빠지면 null", async () => {
    generateContent.mockResolvedValue(reply({ category: "medical_acute" }));
    expect(await detect("피가 멈추질 않아")).toBeNull();
    expect(generateContent).toHaveBeenCalledTimes(1);   // 사전필터를 지나 실제로 물었다 — 응답을 못 읽어 null이다
  });
});

describe("모름 로그 — 까닭만 남기고 발화는 남기지 않는다(2026-10-22 저녁)", () => {
  /** 로그 인자를 글로 — 오류는 이름·메시지까지, 객체는 JSON으로 펼쳐 발화가 숨어 있는지 본다 */
  const asText = (a: unknown) => (typeof a === "string" ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a));

  it("모름이면 console.warn을 부르고, 그 인자에 발화 글이 없다(오류 메시지에 발화가 섞여 와도)", async () => {
    const UTTER = "딸이 와서 보더니 내 입이 돌아갔대";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      generateContent.mockRejectedValueOnce(new Error(`upstream rejected: ${UTTER}`));    // 장애 — 오류 메시지에 발화가 실려 온다
      expect(await confirmVerdict(UTTER)).toEqual({ kind: "error" });
      generateContent.mockResolvedValueOnce(reply({ category: "medical_acute" }));        // 응답 형식(등급 없음)
      expect(await confirmVerdict(UTTER)).toEqual({ kind: "error" });
      generateContent.mockResolvedValueOnce(reply({ category: "depression", level: 3 }));  // 모르는 분류
      expect(await confirmVerdict(UTTER)).toEqual({ kind: "error" });
      delete process.env.GEMINI_API_KEY;                                                    // 키 없음
      expect(await confirmVerdict(UTTER)).toEqual({ kind: "error" });
      // 🔒 모름이 소리 없이 쌓이면 모델이 바뀌어 매번 잘려도(가드에 걸린 이야기가 전부 L3) 아무도 모른다 — 경고는 남긴다
      expect(warn).toHaveBeenCalledTimes(4);
      for (const args of warn.mock.calls) {
        const line = args.map(asText).join(" ");
        expect(line).toContain("백스톱 모름");
        // 🔒 운영 로그에 어르신 발화(건강정보)가 남으면 안 된다 — 까닭(오류 이름·응답 형식·키 없음)만
        expect(line).not.toContain("입이 돌아갔");
        expect(line).not.toContain("딸이 와서");
      }
    } finally {
      warn.mockRestore();
    }
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
