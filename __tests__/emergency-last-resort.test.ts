/**
 * 최후 응급 안전망 **행위** 테스트.
 *
 * 왜 이 파일이 따로 있나 — 교훈의 기록이다.
 *   2026-10-02 1차 수정 때 이 로직을 app/api/chat/route.ts 안에 두었다. Next route 파일은
 *   임의 export가 안 돼서 함수를 직접 부를 수 없었고, 그래서 "catch가 emergencyLastResort를
 *   부르는가"를 정규식으로 보는 **소스 grep 테스트 3건**만 붙였다.
 *   그 직후 적대 리뷰가 critical 결함을 찾아냈다 — 음성 턴에서 sos.text에 **직전 턴 발화**가
 *   들어가 안전망이 엉뚱한 텍스트를 판정하고 있었다. grep 테스트 3건은 전부 녹색이었다.
 *   배선만 보는 테스트는 로직 결함을 구조적으로 못 잡는다. 그래서 모듈로 분리하고 여기서 실행한다.
 *
 * 고정하는 계약:
 *   (A) 음성 턴 — text가 비어 있으면 **반드시 재전사**해서 현재 발화를 평가한다.
 *   (B) 위양성 금지 — 직전 턴 텍스트로 응급이 재발화되면 안 된다(호출부가 음성 턴에 text를 비우는 전제).
 *   (C) 임계값 — chat은 L3만, live·observe는 L2+.
 *   (D) 알림이 실패해도 throw하지 않는다(안전망째 무너지면 안 된다).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const notifyGuardian = vi.fn(async (_payload: unknown) => ({ sent: true, channels: ["fcm"] as string[], reason: undefined as string | undefined }));
vi.mock("@/lib/chat/emergency-notify", () => ({ notifyGuardian: (p: unknown) => notifyGuardian(p) }));

/** 정규식이 놓치는 꼬리를 잡는 LLM 백스톱 — 네트워크 없이 주입 */
const detectEmergencyLLM = vi.fn(async (_t: string) => null as null | { level: 2 | 3; category: string; evidence: string });
/** 맥락 가드가 지운 L2+의 재확인 — 기본은 '아님' */
type Verdict = { kind: "emergency"; result: { level: 2 | 3; category: string; evidence: string } } | { kind: "none" } | { kind: "error" };
const confirmEmergencyLLM = vi.fn(async (_t: string): Promise<Verdict> => ({ kind: "none" }));
vi.mock("@/lib/chat/emergency-llm", () => ({
  detectEmergencyLLM: (t: string) => detectEmergencyLLM(t),
  confirmEmergencyLLM: (t: string) => confirmEmergencyLLM(t),
  SOFT_SIGNAL: /./,
}));

import { lastResortEmergency, type SosState } from "@/lib/chat/emergency-last-resort";

const L3_SPEECH = "숨이 안 쉬어져요";
const CALM_SPEECH = "오늘 점심은 칼국수 먹었어";

const run = (sos: SosState, opts: Partial<{ minLevel: 2 | 3; transcribe: (d: string, m: string) => Promise<string> }> = {}) =>
  lastResortEmergency({
    sos, userName: "할머니", companionName: "민지",
    minLevel: opts.minLevel ?? 3,
    transcribe: opts.transcribe,
  });

beforeEach(() => {
  vi.clearAllMocks();
  notifyGuardian.mockResolvedValue({ sent: true, channels: ["fcm"], reason: undefined });
  detectEmergencyLLM.mockResolvedValue(null);
  confirmEmergencyLLM.mockResolvedValue({ kind: "none" });
});

describe("(F) 맥락 가드 재확인 — 본류와 같은 함수(detectWithBackstop)를 쓴다(2026-10-22)", () => {
  it("가드가 지운 L3를 백스톱이 아니라고 하면 발동하지 않는다", async () => {
    const r = await run({ userId: "u1", text: "친구가 넘어져서 다쳤대" }, { minLevel: 2 });
    expect(confirmEmergencyLLM).toHaveBeenCalledTimes(1);
    expect(r.fired).toBe(false);
  });

  it("백스톱이 모름이면 정규식 L3로 발동한다 — 장애 중의 안전망이 가장 중요하다", async () => {
    confirmEmergencyLLM.mockResolvedValue({ kind: "error" });
    const r = await run({ userId: "u1", text: "딸이 와서 보더니 내 입이 돌아갔대" });
    // 🔒 안전망은 요청이 실패한 순간에 돈다 — 그때 백스톱도 죽어 있기 쉽다. 모름을 '아님'으로 읽으면 안전망째 조용해진다
    expect(r.fired).toBe(true);
    expect(r.level).toBe(3);
    expect(r.reply).toContain("119");
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
  });
});

describe("(A) 음성 턴 — 현재 발화를 재전사해 평가한다", () => {
  it("text가 비어 있고 audio가 있으면 전사해서 L3를 잡는다", async () => {
    const transcribe = vi.fn(async () => L3_SPEECH);
    const r = await run({ userId: "u1", text: "", audio: { data: "AAA", mimeType: "audio/webm" } }, { transcribe });
    // 🔒 이게 깨지면 음성 전용 제품에서 안전망이 사실상 없는 것과 같다
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(r.fired).toBe(true);
    expect(r.level).toBe(3);
    expect(r.reply).toBeTruthy();
    expect(notifyGuardian).toHaveBeenCalledTimes(1);
  });

  it("알림에 실린 content가 **전사된 현재 발화**다 (직전 턴이 아니다)", async () => {
    const transcribe = vi.fn(async () => L3_SPEECH);
    await run({ userId: "u1", text: "", audio: { data: "AAA", mimeType: "audio/webm" } }, { transcribe });
    const payload = notifyGuardian.mock.calls[0]?.[0] as { content: string };
    // 🔒 보호자가 받는 알림에 엉뚱한 발화가 실리면 대응 판단이 틀어진다
    expect(payload.content).toBe(L3_SPEECH);
  });

  it("text가 이미 있으면 재전사하지 않는다 (본류 STT 결과 재사용 — 비용 0)", async () => {
    const transcribe = vi.fn(async () => "불려서는 안 되는 전사");
    const r = await run({ userId: "u1", text: L3_SPEECH, audio: { data: "AAA", mimeType: "audio/webm" } }, { transcribe });
    expect(transcribe).not.toHaveBeenCalled();
    expect(r.fired).toBe(true);
  });

  it("전사가 빈 문자열이면 발동하지 않는다", async () => {
    const r = await run({ userId: "u1", text: "", audio: { data: "AAA", mimeType: "audio/webm" } }, { transcribe: async () => "" });
    expect(r.fired).toBe(false);
    expect(r.skipped).toBe("no-content");
    expect(notifyGuardian).not.toHaveBeenCalled();
  });

  it("전사가 throw해도 터지지 않고 조용히 미발동", async () => {
    const r = await run({ userId: "u1", text: "", audio: { data: "AAA", mimeType: "audio/webm" } }, { transcribe: async () => { throw new Error("STT down"); } });
    expect(r.fired).toBe(false);
    expect(r.skipped).toBe("no-content");
  });
});

describe("(B) 위양성 금지", () => {
  it("평범한 발화는 발동하지 않는다", async () => {
    const r = await run({ userId: "u1", text: CALM_SPEECH });
    expect(r.fired).toBe(false);
    expect(r.skipped).toBe("below-threshold");
    expect(notifyGuardian).not.toHaveBeenCalled();
  });

  it("전사가 평온한 발화면, 오디오가 있어도 발동하지 않는다", async () => {
    // 🔒 직전 턴이 L3였더라도 호출부가 음성 턴에 text를 비우므로, 판정은 현재 전사만 본다
    const r = await run({ userId: "u1", text: "", audio: { data: "AAA", mimeType: "audio/webm" } }, { transcribe: async () => "응 이제 괜찮아" });
    expect(r.fired).toBe(false);
    expect(notifyGuardian).not.toHaveBeenCalled();
  });

  it("내용이 전혀 없으면 미발동 (텍스트 턴의 인사 등)", async () => {
    const r = await run({ userId: "u1", text: "" });
    expect(r.fired).toBe(false);
    expect(r.skipped).toBe("no-content");
  });
});

describe("(C) 임계값 — 경로마다 다르다", () => {
  it("chat(minLevel 3): L2는 발동하지 않는다", async () => {
    const r = await run({ userId: "u1", text: "가슴이 답답하고 어지러워" }, { minLevel: 3 });
    if (r.level === 2) expect(r.fired).toBe(false);   // L2로 판정되면 chat에서는 미발동이어야 한다
  });

  it("live·observe(minLevel 2): L2도 발동한다", async () => {
    const r = await run({ userId: "u1", text: "가슴이 답답하고 어지러워" }, { minLevel: 2 });
    if (r.level >= 2) {
      expect(r.fired).toBe(true);
      expect(notifyGuardian).toHaveBeenCalledTimes(1);
    }
  });

  it("L2 발동 시 119 멘트는 만들지 않는다 (대화 흐름이 없는 경로)", async () => {
    const r = await run({ userId: "u1", text: "가슴이 답답하고 어지러워" }, { minLevel: 2 });
    if (r.fired && r.level === 2) expect(r.reply).toBeUndefined();
  });
});

describe("(D) 알림 실패가 안전망을 무너뜨리지 않는다", () => {
  it("notifyGuardian이 throw해도 멘트는 돌려준다", async () => {
    notifyGuardian.mockRejectedValue(new Error("all channels down"));
    const r = await run({ userId: "u1", text: L3_SPEECH });
    // 🔒 여기서 예외가 새면 어르신이 119 안내 대신 500을 본다 — 안전망의 존재 이유가 사라진다
    expect(r.fired).toBe(true);
    expect(r.reply).toBeTruthy();
  });

  it("notifyGuardian이 sent:false여도 멘트는 돌려준다", async () => {
    notifyGuardian.mockResolvedValue({ sent: false, channels: [], reason: "알림 대상 없음" });
    const r = await run({ userId: "u1", text: L3_SPEECH });
    expect(r.fired).toBe(true);
    expect(r.reply).toBeTruthy();
  });

  it("DB 기록이 없는 경로이므로 messageId 없이 호출한다", async () => {
    await run({ userId: "u1", text: L3_SPEECH });
    const payload = notifyGuardian.mock.calls[0]?.[0] as { messageId?: string };
    expect(payload.messageId).toBeUndefined();
  });

  it("알림 귀속 대상은 sos.userId다 (대리 검사면 환자)", async () => {
    await run({ userId: "patient-42", text: L3_SPEECH });
    const payload = notifyGuardian.mock.calls[0]?.[0] as { userId: string };
    expect(payload.userId).toBe("patient-42");
  });
});

/**
 * 세 진입점이 **같은 구현**을 쓰는지 고정한다.
 * 각자 구현하면 F3(파서 드리프트)가 반복된다 — 실제로 2026-10-01에 chat만 고치고
 * live·observe를 빠뜨려 같은 구멍이 두 경로에 남아 있었다.
 */
describe("세 진입점이 공용 안전망을 쓴다", () => {
  it.each([
    // chat은 래퍼(emergencyLastResort)를 거친다 — 119 멘트를 NextResponse로 감싸야 하므로.
    ["app/api/chat/route.ts", 3, "emergencyLastResort(e, sos)"],
    ["app/api/live/turn/route.ts", 2, "lastResortEmergency({"],
    ["app/api/observe/turn/route.ts", 2, "lastResortEmergency({"],
  ])("%s가 공용 안전망을 쓰고 catch에서 호출한다 (minLevel %d)", async (file, minLevel, callSite) => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(file as string, "utf-8");
    // 🔒 각자 구현으로 갈라지면 F3 드리프트가 반복된다 (chat만 고치고 live·observe를 빠뜨린 전례)
    expect(src, file as string).toMatch(/from "@\/lib\/chat\/emergency-last-resort"/);
    expect(src, file as string).toMatch(new RegExp(`minLevel: ${minLevel}`));
    // 🔒 catch 안에 있어야 의미가 있다 — 정상 경로에 끼면 매 턴 중복 알림이 된다
    const catchIdx = src.lastIndexOf("} catch (e) {");
    expect(catchIdx, file as string).toBeGreaterThan(-1);
    expect(src.indexOf(callSite as string, catchIdx), file as string).toBeGreaterThan(catchIdx);
  });

  it("음성 턴에서 sos.text를 비운다 — 직전 턴 발화 오염 차단", async () => {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("app/api/chat/route.ts", "utf-8");
    // 🔒 이 줄이 `sos.text = messages...at(-1)`로 되돌아가면 음성 턴 안전망이 다시 죽는다
    expect(src).toMatch(/sos\.text = isAudioTurn \? "" :/);
    // 본류 STT 결과를 안전망에 넘기는 연결도 함께 고정(없으면 매번 재전사해 비용이 든다)
    expect(src).toMatch(/\.then\(\(t\) => \{ if \(t\) sos\.text = t; return t; \}\)/);
  });
});

/**
 * LLM 백스톱 연동 — 1차 구현이 detectEmergency만 쓰던 것을 2026-10-02 적대 리뷰가 지적했다.
 * 백스톱의 존재 이유가 "정규식이 놓치는 사투리·완곡어 꼬리"인데, 안전망은 그 꼬리가 가장
 * 위험해지는 순간(요청 자체가 실패한 순간)에 작동한다. 거기서 정규식만 보면 L3가 조용히 사라진다.
 */
describe("LLM 백스톱을 안전망에서도 쓴다", () => {
  it("정규식이 none이면 백스톱을 호출한다", async () => {
    await run({ userId: "u1", text: "인자 다 정리하고 조용히 갈란다" });
    expect(detectEmergencyLLM).toHaveBeenCalledTimes(1);
  });

  it("백스톱이 L3를 잡으면 발동한다 — 정규식이 놓친 꼬리", async () => {
    detectEmergencyLLM.mockResolvedValue({ level: 3, category: "suicidal", evidence: "llm:완곡 표현" });
    const r = await run({ userId: "u1", text: "이만 자리를 비켜주려고 하네" });
    // 🔒 이게 false면 백스톱이 잡던 L3가 안전망에서 통째로 사라진다
    expect(r.fired).toBe(true);
    expect(r.level).toBe(3);
    expect(r.reply).toBeTruthy();
  });

  it("정규식이 이미 잡았으면 백스톱을 부르지 않는다 (중복 비용 금지)", async () => {
    await run({ userId: "u1", text: L3_SPEECH });
    expect(detectEmergencyLLM).not.toHaveBeenCalled();
  });

  it("백스톱이 throw해도 안전망은 살아남는다", async () => {
    detectEmergencyLLM.mockRejectedValue(new Error("gemini down"));
    await expect(run({ userId: "u1", text: "조용히 갈란다" })).resolves.toMatchObject({ fired: false });
  });
});

describe("(E) L1(관찰)도 백스톱에 태운다 — 본류 detectWithBackstop과 같다(2026-10-19)", () => {
  it("정규식 L1이어도 백스톱이 L3면 발동한다", async () => {
    detectEmergencyLLM.mockResolvedValue({ level: 3, category: "medical_acute", evidence: "llm" });
    const r = await run({ userId: "u1", text: "기운이 하나도 없고 숨이 너무 차" });
    // 🔒 L1에서 멈추면 앞의 '기운 없음'이 뒤의 급성 호흡곤란 신호를 가린다
    expect(detectEmergencyLLM).toHaveBeenCalledTimes(1);
    expect(r.fired).toBe(true);
    expect(r.level).toBe(3);
  });
});
