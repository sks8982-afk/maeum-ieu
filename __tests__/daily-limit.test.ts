/**
 * 일일 대화량 제한 회귀 테스트.
 *
 * 성격: 단위 테스트(화이트박스 — 카운트 경계·실패 모드 분기 커버)
 *      + 계약 테스트(라우트 소스에서 제외 대상·응급 우선순위 고정)
 *
 * 왜 소스 문자열까지 검사하는가: 제한 게이트는 한 줄만 옮겨도
 *   "응급 발화가 마무리 인사로 덮이는" 안전 결함이 되고, 테스트 없이는 조용히 깨진다.
 *   라우트 전체를 실행하려면 Gemini·DB가 필요해 CI에서 돌릴 수 없으므로 분기 존재를 고정한다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── prisma 스텁 — count에 넘어온 where를 그대로 붙잡아 경계 조건을 검증한다 ──
let countResult: number | Error = 0;
let lastWhere: Record<string, unknown> | null = null;

vi.mock("@/lib/prisma", () => ({
  prisma: {
    message: {
      count: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        lastWhere = args?.where ?? null;
        if (countResult instanceof Error) throw countResult;
        return countResult;
      }),
    },
  },
}));

/** env를 바꿔 모듈 수준 상수(DAILY_TURN_LIMIT)를 다시 평가시킨다 */
async function load(limit?: string) {
  if (limit === undefined) delete process.env.DAILY_TURN_LIMIT;
  else process.env.DAILY_TURN_LIMIT = limit;
  vi.resetModules();
  return import("@/lib/usage/daily-limit");
}

const ORIGINAL_LIMIT = process.env.DAILY_TURN_LIMIT;
beforeEach(() => { countResult = 0; lastWhere = null; });
afterEach(() => {
  if (ORIGINAL_LIMIT === undefined) delete process.env.DAILY_TURN_LIMIT;
  else process.env.DAILY_TURN_LIMIT = ORIGINAL_LIMIT;
});

describe("사용량 카운트 — 경계", () => {
  it("기본 상한은 100턴", async () => {
    const m = await load();
    expect(m.DAILY_TURN_LIMIT).toBe(100);
  });

  it("상한 직전(limit-1)은 통과하고 남은 턴을 보고한다", async () => {
    const m = await load("10");
    countResult = 9;
    const u = await m.getDailyUsage("conv-1");
    expect(u.exceeded).toBe(false);
    expect(u.remaining).toBe(1);
    expect(u.nearLimit).toBe(true);
  });

  it("상한과 같아지는 순간(used === limit) 차단된다 — off-by-one 고정", async () => {
    const m = await load("10");
    countResult = 10;
    const u = await m.getDailyUsage("conv-1");
    expect(u.exceeded).toBe(true);
    expect(u.remaining).toBe(0);
    expect(u.nearLimit).toBe(false); // 이미 넘었으면 '예고'가 아니라 '마무리'다
  });

  it("상한을 넘겨도 remaining은 음수가 되지 않는다", async () => {
    const m = await load("10");
    countResult = 37;
    const u = await m.getDailyUsage("conv-1");
    expect(u.remaining).toBe(0);
    expect(u.exceeded).toBe(true);
  });

  it("여유가 충분하면 예고하지 않는다", async () => {
    const m = await load("100");
    countResult = 50;
    const u = await m.getDailyUsage("conv-1");
    expect(u.nearLimit).toBe(false);
    expect(u.exceeded).toBe(false);
  });

  it("예고 구간은 남은 5턴 이하", async () => {
    const m = await load("100");
    countResult = 95; // remaining 5
    expect((await m.getDailyUsage("c")).nearLimit).toBe(true);
    countResult = 94; // remaining 6
    expect((await m.getDailyUsage("c")).nearLimit).toBe(false);
  });
});

describe("카운트 범위 — KST 자정 기준", () => {
  it("사용자 발화만, 오늘(KST) 것만 센다", async () => {
    const m = await load("10");
    await m.getDailyUsage("conv-42");
    expect(lastWhere).toBeTruthy();
    expect(lastWhere?.conversationId).toBe("conv-42");
    expect(lastWhere?.role).toBe("user"); // 🔒 AI 응답까지 세면 상한이 절반으로 깎인다
    const gte = (lastWhere?.createdAt as { gte: Date }).gte;
    expect(gte).toBeInstanceOf(Date);

    // 경계가 KST 자정(= UTC 15:00 전날)인지: UTC+9 기준 시/분/초가 모두 0이어야 한다
    const kst = new Date(gte.getTime() + 9 * 3600 * 1000);
    expect(kst.getUTCHours()).toBe(0);
    expect(kst.getUTCMinutes()).toBe(0);
    expect(kst.getUTCSeconds()).toBe(0);

    // 지금보다 과거이고, 24시간 이내다 (UTC 자정을 쓰면 KST 오전 9시 전에 이 조건이 깨진다)
    const now = Date.now();
    expect(gte.getTime()).toBeLessThanOrEqual(now);
    expect(now - gte.getTime()).toBeLessThan(24 * 3600 * 1000);
  });

  it("상시 감시 기록(혼잣말 조각)은 세지 않는다", async () => {
    const m = await load("10");
    const { OBSERVATION_PREFIX } = await import("@/lib/chat/observation");
    await m.getDailyUsage("conv-42");
    // 🔒 2026-10-06 이전: 감시 조각이 role=user로 같은 대화에 쌓여 한도를 채웠다 →
    //   감시를 켜 둔 날 어르신이 동반자와 대화하려 하면 마무리 인사만 돌아왔다(인지 선별도 0건)
    expect(lastWhere?.NOT).toEqual({ content: { startsWith: OBSERVATION_PREFIX } });
  });
});

describe("실패 모드 — 열린 방향으로 실패한다", () => {
  it("DB 조회 실패 시 대화를 막지 않는다", async () => {
    const m = await load("10");
    countResult = new Error("connection reset");
    const u = await m.getDailyUsage("conv-1");
    expect(u.exceeded).toBe(false);
    expect(u.nearLimit).toBe(false);
  });

  it("상한 0 이하는 제한 해제 — DB도 조회하지 않는다", async () => {
    const m = await load("0");
    const u = await m.getDailyUsage("conv-1");
    expect(u.exceeded).toBe(false);
    expect(lastWhere).toBeNull();
  });

  it("상한 값이 숫자가 아니면 기본값으로 떨어진다", async () => {
    const m = await load("무제한");
    expect(m.DAILY_TURN_LIMIT).toBe(100);
  });
});

describe("어르신에게 보여줄 문장 — 제재가 아니라 인사", () => {
  it("마무리 인사에 오류·금지 어휘가 없다", async () => {
    const m = await load("10");
    const text = m.buildDailyLimitReply("어르신", "민지");
    for (const bad of ["제한", "초과", "불가", "한도", "오류", "차단", "요금", "결제", "429"]) {
      expect(text).not.toContain(bad);
    }
    expect(text).toContain("어르신");
    expect(text).toContain("민지");
    expect(text).toContain("내일"); // 🔒 다시 올 수 있다는 안내가 없으면 서비스 종료로 오해한다
    expect(text.length).toBeGreaterThan(20);
  });

  it("호칭·동반자 이름이 바뀌면 문장도 따라간다", async () => {
    const m = await load("10");
    const text = m.buildDailyLimitReply("할머니", "손주");
    expect(text).toContain("할머니");
    expect(text).toContain("손주");
  });

  it("예고는 프롬프트 지시로 전달된다 — 응답 문자열에 덧붙이지 않는다", async () => {
    const m = await load("10");
    const hint = m.buildNearLimitPromptHint(3);
    expect(hint).toContain("3");
    expect(hint).toMatch(/^\n\n\[/);           // 시스템 프롬프트에 이어 붙는 블록 형태
    expect(hint).toMatch(/"제한"|"한도"|"초과"/); // 모델에게 금지어를 명시
    expect(hint).toMatch(/사별|통증|공감/);      // 무거운 대화 중에는 예고 금지
  });
});

describe("라우트 게이트 계약", () => {
  let src = "";
  /** 게이트 블록만 떼어낸다 — import 줄이 먼저 매치돼 빈 슬라이스가 되는 걸 막는다 */
  let gate = "";
  beforeEach(async () => {
    if (!src) {
      src = await (await import("node:fs/promises")).readFile("app/api/chat/route.ts", "utf-8");
      const start = src.indexOf("let nearLimitRemaining");
      expect(start).toBeGreaterThan(0);
      gate = src.slice(start, src.indexOf("const historyText = buildHistoryText", start));
      expect(gate.length).toBeGreaterThan(200);
    }
  });

  it("어르신(user) 모드에만 적용된다", () => {
    // 한도 대상 대화 ID는 user 모드에서만 정해지고(그 외엔 undefined), 한도는 그 ID로만 센다.
    //   (2026-10-06: conversationId를 빼고 보내도 계정의 대화를 찾아 세도록 바뀌며 모양이 달라졌다)
    expect(src).toMatch(/const limitConvId = mode === "user" && !isInitialGreeting && !isReturningGreeting && !isReEngage\s*\?/);
    expect(src).toMatch(/if \(limitConvId\) \{\s*const usage = await getDailyUsage\(limitConvId, userId\);/);
  });

  it("인사 턴은 제외된다 — 앱을 열자마자 막히면 고장으로 오해한다", () => {
    const cond = gate.slice(0, gate.indexOf("getDailyUsage"));
    expect(cond).toContain("!isInitialGreeting");
    expect(cond).toContain("!isReturningGreeting");
    expect(cond).toContain("!isReEngage");
  });

  it("응급 발화는 한도보다 우선한다 — 음성은 전사를 기다린 뒤 판정한다", () => {
    // 🔒 실서비스는 음성 전용. 전사 없이 판정하면 "숨이 안 쉬어져"가 마무리 인사로 덮인다.
    expect(gate).toMatch(/usage\.exceeded[\s\S]{0,700}await sttPromise[\s\S]{0,200}detectEmergency/);
    expect(gate).toMatch(/detectEmergencyDetailed\(spoken\)[\s\S]{0,900}if \(!isEmergencyUtterance\)/);
    // 🔒 맥락 가드가 지운 L2+(suppressed)도 응급 후보로 통과 — 본류가 백스톱 재확인으로 가른다(2026-10-22)
    expect(gate).toMatch(/isEmergencyUtterance = [^;]*\.suppressed/);
  });

  it("정규식이 none이면 LLM 백스톱까지 본 뒤에 차단한다", () => {
    // 🔒 2026-10-02 적대 리뷰: 이 게이트가 정규식만 봐서, 백스톱이 잡던 사투리·완곡어 L3가
    //    한도 초과일에 마무리 인사로 덮였다. 백스톱의 존재 이유가 그 과소감지 꼬리다.
    expect(gate).toMatch(/detectEmergencyLLM\(spoken\)/);
    // 백스톱 호출이 차단 판정(!isEmergencyUtterance)보다 **앞**이어야 의미가 있다
    const llmIdx = gate.indexOf("detectEmergencyLLM(spoken)");
    const blockIdx = gate.indexOf("if (!isEmergencyUtterance)");
    expect(llmIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeGreaterThan(llmIdx);
  });

  it("차단 시 429가 아니라 200 + 동반자 발화를 돌려준다", () => {
    const seg = gate.slice(gate.indexOf("buildDailyLimitReply"));
    expect(seg).toContain("NextResponse.json");
    expect(seg).toContain("dailyLimitReached: true");
    expect(gate).not.toMatch(/status:\s*429/);
  });

  it("예고는 시스템 프롬프트에 주입되고 두 핸들러 모두에 전달된다", () => {
    expect(src).toMatch(/systemPrompt \+ buildNearLimitPromptHint/);
    expect(src).toMatch(/handleAudioMessage\(\{[\s\S]{0,80}systemPrompt: sysPrompt/);
    expect(src).toMatch(/handleTextMessage\(\{[\s\S]{0,80}systemPrompt: sysPrompt/);
  });
});
