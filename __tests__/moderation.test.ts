import { describe, it, expect } from "vitest";
import { detectInappropriate } from "@/lib/chat/moderation";

describe("detectInappropriate — 일상 발화 false positive 방지", () => {
  it.each([
    "떡을 먹었지 맛있더라", // 음식 '떡' — 속어 활용형(치/쳐)만 매칭해야 함
    "불이 꺼져서 깜깜했어", // 사물 서술 '꺼져' — 욕설 아님
    "TV가 꺼져 있어",
  ])("'%s'는 ok로 통과한다", (text) => {
    expect(detectInappropriate(text).category).toBe("ok");
  });
});

describe("detectInappropriate — 욕설 감지", () => {
  it.each([
    "꺼져", // 발화 시작 '꺼져'는 욕설
    "너 꺼져", // 대상 지칭 '꺼져'
    "닥쳐",
    "씨발",
  ])("'%s'를 profanity로 감지한다", (text) => {
    expect(detectInappropriate(text).category).toBe("profanity");
  });
});

describe("detectInappropriate — 성적 표현 감지", () => {
  it.each([
    "떡치", // 속어 활용형
    "야동 보여줘",
  ])("'%s'를 sexual로 감지한다", (text) => {
    expect(detectInappropriate(text).category).toBe("sexual");
  });
});

describe("detectInappropriate — 자살·자해 감지", () => {
  it("'죽고 싶어'를 self_harm으로 감지한다", () => {
    expect(detectInappropriate("죽고 싶어").category).toBe("self_harm");
  });
});

describe("detectInappropriate — 빈 입력", () => {
  it("빈 문자열은 ok", () => {
    expect(detectInappropriate("").category).toBe("ok");
  });
});

/**
 * B9(2026-10-06 사용자 결정) — 과거의 자살 생각을 "지금은 괜찮다"며 말할 때는 위기 즉답 대신 공감 + 후속 확인 + 상담 번호 한 줄.
 *   직접 운전: "예전엔 죽고 싶었는데, 지금은 친구들이 있어서 괜찮아" → "지금 바로 109" 위기 안내 → 어르신 "아이고 아니야, 걱정 마".
 *   기록(L2 마킹)과 보호자 알림은 그대로 둔다 — 과거 자살 생각도 가족이 알아야 할 위험 신호(라우트 테스트에서 확인).
 */
describe("과거 해소 자살 생각 (B9)", () => {
  it.each([
    "영감 먼저 보내고 한동안은 예전엔 죽고 싶었는데, 지금은 이렇게 친구들이 있어서 괜찮아.",
    "옛날엔 죽고 싶었던 적도 있었지. 이제는 많이 나아졌어",
    "그때는 정말 죽고 싶었어요. 요즘은 손주 보는 재미로 살 만해요",
  ])("해소된 과거로 본다: %s", async (t) => {
    const { isPastResolvedSelfHarm } = await import("@/lib/chat/moderation");
    expect(detectInappropriate(t).category).toBe("self_harm");   // 감지는 그대로(기록·알림 경로 유지)
    expect(isPastResolvedSelfHarm(t)).toBe(true);
  });

  it.each([
    "죽고 싶어",                                                   // 현재형
    "예전에 죽고 싶었던 적이 있어",                                  // 과거지만 '지금은 괜찮다'는 말이 없다 — 판단 보류(위기 안내 유지)
    "예전엔 죽고 싶었는데 지금도 가끔 그래",                         // 지속
    "옛날엔 힘들었는데 지금은 괜찮아. 근데 오늘은 죽고 싶어",         // 해소 진술 뒤 현재형 자살 표현
    "예전엔 괜찮았는데 요즘 자꾸 죽고 싶어",                         // 과거 표지가 '괜찮음'에 붙은 경우
    // ⚠ 아래 둘은 각 조건만이 가르는 반례다 — 위 예들은 다른 조건에서 먼저 걸러져, 과거형 확인·지속 표지
    //   검사를 지워도 녹색이었다(변이로 확인)
    "옛날 생각하면 죽고 싶어. 지금은 괜찮은 척하는 거지",            // 현재형 자살 표현 — 과거형 확인만이 가른다
    "예전엔 죽고 싶었는데 지금은 괜찮다가도 자꾸 그런 생각이 나",     // 재발 — 지속 표지만이 가른다
  ])("해소로 보지 않는다(기존 위기 안내 유지): %s", async (t) => {
    const { isPastResolvedSelfHarm } = await import("@/lib/chat/moderation");
    expect(isPastResolvedSelfHarm(t)).toBe(false);
  });

  it("공감·후속 확인·상담 번호는 있고, '지금 바로 전화' 같은 즉시 위기 지시는 없다", async () => {
    const { buildPastSelfHarmReply } = await import("@/lib/chat/moderation");
    const r = buildPastSelfHarmReply("할머니", "민지");
    expect(r).toMatch(/힘드셨겠어요/);
    expect(r).toMatch(/다시 그런 마음이 드시면/);
    expect(r).toMatch(/109/);
    expect(r).not.toMatch(/바로 전화|지금 바로/);
  });
});
