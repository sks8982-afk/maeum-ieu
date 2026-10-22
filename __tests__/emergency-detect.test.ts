/**
 * 응급 판정·멘트의 **남은 분기** 단위 테스트.
 *
 * scripts/safety-regression.ts(342건)가 detectEmergency의 어휘 커버리지를 대부분 책임지지만,
 * 2026-10-02 커버리지 측정에서 아래 분기들이 **한 번도 실행되지 않은 채** 남아 있었다:
 *   · 빈/공백 입력 가드
 *   · 비유 표현 → L2/L1 강등 경로
 *   · 해소된 과거 자살 사고 → L2 보존 경로
 *   · "짐이 되다/폐를 끼치다"의 자기지칭 요구
 *   · buildEmergencyL3Reply의 **카테고리별 멘트 전부** — 어르신이 응급 때 실제로 듣는 문장인데
 *     한 분기도 실행되지 않고 있었다. 여기가 깨지면 119 안내가 엉뚱한 내용으로 나간다.
 *   · buildEmergencyL2Hint / shouldEscalateL1ToL2 경계
 */
import { describe, it, expect } from "vitest";
import {
  detectEmergency, buildEmergencyL3Reply, buildEmergencyL2Hint, shouldEscalateL1ToL2,
  type EmergencyCategory,
} from "@/lib/chat/emergency";

describe("입력 가드", () => {
  it.each(["", "   ", "\n\t "])("빈/공백 입력은 level 0 (%j)", (t) => {
    const r = detectEmergency(t);
    expect(r.level).toBe(0);
    expect(r.category).toBe("none");
  });
});

describe("비유 표현 — 강등하되 버리지는 않는다", () => {
  it("비유적 L3 어휘는 L2로 내려간다 (자살·복약 제외)", () => {
    // 🔒 비유를 L3로 올리면 119 멘트가 오발화된다. 반대로 0으로 버리면 진짜 신호를 놓친다.
    const r = detectEmergency("손주 재롱에 숨이 넘어가는 줄 알았네 비유하자면 그래");
    expect(r.level).toBeLessThan(3);
  });

  it("자살 어휘는 비유 맥락이어도 L3를 유지한다", () => {
    // 🔒 자살·복약은 강등 예외다 — 농담처럼 말해도 놓치면 사람이 죽는다
    const r = detectEmergency("이제 정말 죽고 싶어");
    expect(r.level).toBe(3);
    expect(r.category).toBe("suicidal");
  });
});

describe("과거·해소 맥락", () => {
  it("완전히 해소된 과거 자살 사고는 응급이 아니다", () => {
    // 조사 변형 '예전엔' — PAST_CONTEXT_GUARD에 '예전에'만 있어 이 문장이 L3로 오발화하던
    //   F2(死 정규식)를 2026-10-02에 수정했다. 🔒 [에엔은도]가 빠지면 다시 과잉경보가 된다.
    expect(detectEmergency("예전엔 죽고 싶었는데 이제는 다 지난 일이라 괜찮아졌어").level).toBe(0);
    expect(detectEmergency("옛날에 죽고 싶었지만 지금은 괜찮아졌어").level).toBe(0);
  });

  /**
   * 🔒 **과거를 언급했다는 이유로 현재 위기를 강등하지 않는다** (2026-10-02 수정한 위음성).
   *   수정 전 실측: "지금도 죽고 싶어"=L3인데 "예전에도 그랬는데 지금도 죽고 싶어"=**L2**였다.
   *   L2는 109(자살예방상담) 즉답이 안 나가고 프롬프트 힌트만 붙는다.
   *   만성(과거부터) + 현재 지속은 오히려 고위험 표현인데 가장 약하게 처리되고 있었다.
   */
  it.each([
    "예전에도 그랬는데 지금도 죽고 싶어",
    "옛날에도 그랬고 아직도 죽고 싶어",
    "예전부터 그랬는데 여전히 죽고 싶어",
    "젊었을 때도 그랬는데 요즘도 죽고 싶어",
  ])("과거 언급 + 현재 지속 → L3 유지: %s", (t) => {
    const r = detectEmergency(t);
    expect(r.level).toBe(3);
    expect(r.category).toBe("suicidal");
  });

  it("과거 언급만 있고 현재 지표가 없으면 L2 보존 (이력은 버리지 않는다)", () => {
    // 설계: suicidal·medication_error는 과거여도 L2로 남긴다(완전 무시하면 추세에서 사라진다)
    const r = detectEmergency("드라마에서 어떤 사람이 옥상에서 뛰어내리는 장면을 봤어");
    expect(r.level).toBe(2);
  });

  it("뉴스·드라마 맥락은 응급이 아니다", () => {
    const r = detectEmergency("드라마에서 어떤 사람이 옥상에서 뛰어내리는 장면을 봤어");
    expect(r.level).toBeLessThan(3);
  });
});

describe("'짐이 되다 / 폐를 끼치다' — 자기지칭이 있어야 위기", () => {
  it("자기지칭이면 위기로 본다", () => {
    const r = detectEmergency("내가 자식들한테 짐만 되는 것 같아 그만 살고 싶어");
    expect(r.level).toBeGreaterThanOrEqual(2);
  });

  it("사물·제3자 맥락은 위기가 아니다", () => {
    // 🔒 "짐"이 들어갔다고 전부 잡으면 일상 대화가 응급으로 오발화된다
    const r = detectEmergency("이삿짐이 너무 많아서 트럭에 폐를 끼치겠더라");
    expect(r.level).toBeLessThan(3);
  });
});

describe("L1 누적 → L2 승격 경계", () => {
  it.each([[0, false], [1, false], [2, false], [3, true], [5, true]])(
    "24h 내 %d회 → 승격 %s", (n, expected) => {
      expect(shouldEscalateL1ToL2(n as number)).toBe(expected);
    });
});

describe("L3 멘트 — 어르신이 실제로 듣는 문장", () => {
  const CATEGORIES: EmergencyCategory[] = ["medical_acute", "fall_injury", "bleeding", "medication_error", "suicidal"];

  it.each(CATEGORIES)("[%s] 멘트가 비어 있지 않고 호칭·동반자 이름을 쓴다", (cat) => {
    const r = buildEmergencyL3Reply("할머니", "민지", cat);
    expect(r.length).toBeGreaterThan(20);
    expect(r).toContain("할머니");
  });

  it.each(["medical_acute", "fall_injury", "bleeding", "medication_error"] as EmergencyCategory[])(
    "[%s]는 119를 안내한다", (cat) => {
      // 🔒 신체 응급에서 119가 빠지면 이 기능의 존재 이유가 사라진다
      expect(buildEmergencyL3Reply("할머니", "민지", cat)).toContain("119");
    });

  it("[bleeding] 119는 조건 없이 맨 앞 — 지혈은 다친 곳·코피일 때만 따로 말한다(몸속 출혈에도 이 멘트가 나간다, 2026-10-22)", () => {
    const r = buildEmergencyL3Reply("할머니", "민지", "bleeding");
    const first = r.slice(0, r.indexOf("."));
    // 🔒 "상처에서 나는 피면 …눌러주시고, 바로 119에"처럼 한 문장에 묶으면 119까지 '상처면' 조건으로 들린다 —
    //    피를 토하거나 혈변인 어르신은 119를 자기 일로 듣지 못한다
    expect(first).toContain("119");
    expect(first.slice(0, first.indexOf("119")), "119 앞에 조건('…면')이 없어야 한다").not.toMatch(/[가-힣]면[\s,]/);
    // 🔒 "깨끗한 수건으로 꾹"만 있으면 피를 토한 어르신에게 맞지 않는 지시가 된다 — 다친 곳일 때만
    expect(r).toContain("다친 곳이면 깨끗한 수건으로 꾹");
    expect(r).toContain("코피면");
    expect(r).toMatch(/가족이나 보호자/);
  });

  it("[suicidal]은 119가 아니라 자살예방상담 109를 안내한다", () => {
    const r = buildEmergencyL3Reply("할머니", "민지", "suicidal");
    // 🔒 자살 위기에 119만 안내하면 적절한 창구로 연결되지 않는다
    expect(r).toContain("109");
  });

  it("알 수 없는 카테고리도 기본 119 멘트를 돌려준다 (빈 응답 금지)", () => {
    const r = buildEmergencyL3Reply("할머니", "민지", "none");
    expect(r).toContain("119");
    expect(r.length).toBeGreaterThan(20);
  });

  it("받침 있는 동반자 이름에 친근체 조사가 붙는다 (수진이는 / 민지는)", () => {
    expect(buildEmergencyL3Reply("할머니", "수진", "medical_acute")).toContain("수진이는");
    expect(buildEmergencyL3Reply("할머니", "민지", "medical_acute")).toContain("민지는");
  });

  it("보호자 연락 안내가 모든 카테고리에 들어간다", () => {
    for (const cat of [...CATEGORIES, "none" as EmergencyCategory]) {
      const r = buildEmergencyL3Reply("할머니", "민지", cat);
      // medication_error만 '토하지 마세요' 지시가 우선이라 가족 문구가 없다 — 그 예외를 고정한다
      if (cat === "medication_error") expect(r).toContain("119");
      else expect(r, cat).toMatch(/가족이나 보호자/);
    }
  });
});

describe("L2 힌트", () => {
  it("카테고리와 단서를 프롬프트에 실어 보낸다", () => {
    const h = buildEmergencyL2Hint("dizziness_help" as EmergencyCategory, "어지러워");
    expect(h).toContain("dizziness_help");
    expect(h).toContain("어지러워");
    // 🔒 "괜찮다고 해도 한 번 더" 지시가 빠지면 L2가 일상 대화로 흘러간다
    expect(h).toMatch(/한 번 더/);
    expect(h).toContain("119");
  });
});
