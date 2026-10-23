/**
 * 유료 혜택 사용 판정(lib/billing/paid-benefit usedPaidBenefit) — 청약철회 환불액(전액 / 이용일수 공제)을 가른다.
 *
 * 정의: 이용기간 중 혜택 대상의 **KST 하루** 사용자 발화 수가 무료 한도를 넘은 날이 있는가 — 일일 한도
 *   (lib/usage/daily-limit)와 같은 기준(그 계정 대화의 role=user, 상시 감시 기록 제외, KST 자정).
 * 지키는 것:
 *   · 결제 전에 무료로 한도에 닿아 저장된 발화(마무리 인사를 받은 턴)는 '썼다'가 아니다.
 *   · 결제 뒤 그날의 11번째 발화는 '썼다'다.
 *   · KST로 하루를 가른다 — UTC로 묶으면 KST 23시대와 다음 날 0시대가 한 날이 된다.
 */
import { describe, it, expect } from "vitest";
import { db, fakeId, kst } from "./helpers/billing-portone-harness";
import { OBSERVATION_PREFIX } from "@/lib/chat/observation";

const benefit = async () => (await import("@/lib/billing/paid-benefit")).usedPaidBenefit;
const period = { start: kst("2026-11-02T14:00:00"), end: kst("2026-11-20T00:00:00") };

function say(userId: string, at: Date, opts: { role?: string; content?: string } = {}) {
  const convId = `conv-${userId}`;
  if (!db.conversation.rows.some((c) => c.id === convId)) db.conversation.rows.push({ id: convId, userId });
  db.message.rows.push({ id: fakeId(), conversationId: convId, role: opts.role ?? "user", content: opts.content ?? "안녕", createdAt: at });
}
/** at부터 1분 간격으로 n번 */
function sayMany(userId: string, from: Date, n: number, opts: { role?: string; content?: string } = {}) {
  for (let i = 0; i < n; i++) say(userId, new Date(from.getTime() + i * 60_000), opts);
}

describe("무료 한도(10회)를 넘은 날이 있는가", () => {
  it("대화가 없으면 false · 하루 10회는 false · 11회면 true", async () => {
    const used = await benefit();
    expect(await used("elder-1", period)).toBe(false);
    sayMany("elder-1", kst("2026-11-05T09:00:00"), 10);
    expect(await used("elder-1", period)).toBe(false);
    say("elder-1", kst("2026-11-05T12:00:00"));
    expect(await used("elder-1", period)).toBe(true);
  });

  it("결제 전에 무료로 한도에 닿아 저장된 발화(10회 + 마무리 인사 받은 3회)만 있으면 false", async () => {
    sayMany("elder-1", kst("2026-11-02T09:00:00"), 13); // 14:00 결제 전
    expect(await (await benefit())("elder-1", period)).toBe(false);
  });

  it("결제 전 10회 + 결제 뒤 1회(그날의 11번째) → true", async () => {
    sayMany("elder-1", kst("2026-11-02T09:00:00"), 10);
    say("elder-1", kst("2026-11-02T15:00:00"));
    expect(await (await benefit())("elder-1", period)).toBe(true);
  });

  it("이용기간이 끝난 뒤의 대화는 세지 않는다", async () => {
    sayMany("elder-1", kst("2026-11-21T09:00:00"), 20);
    expect(await (await benefit())("elder-1", period)).toBe(false);
  });
});

describe("세는 기준 = 일일 한도와 같다", () => {
  it("상시 감시 기록([관찰])은 대화가 아니다 — 9회 + 관찰 5개는 false", async () => {
    sayMany("elder-1", kst("2026-11-05T09:00:00"), 9);
    sayMany("elder-1", kst("2026-11-05T11:00:00"), 5, { content: `${OBSERVATION_PREFIX} 혼잣말` });
    expect(await (await benefit())("elder-1", period)).toBe(false);
  });

  it("동반자(assistant) 발화는 세지 않는다", async () => {
    sayMany("elder-1", kst("2026-11-05T09:00:00"), 10);
    sayMany("elder-1", kst("2026-11-05T11:00:00"), 10, { role: "assistant" });
    expect(await (await benefit())("elder-1", period)).toBe(false);
  });

  it("다른 사람의 대화는 세지 않는다", async () => {
    sayMany("elder-2", kst("2026-11-05T09:00:00"), 30);
    expect(await (await benefit())("elder-1", period)).toBe(false);
  });

  it("KST로 하루를 가른다 — 23:30부터 6회 + 다음 날 00:30부터 5회는 각각 10회 이하(false). UTC로는 같은 날이다", async () => {
    sayMany("elder-1", kst("2026-11-05T23:30:00"), 6);
    sayMany("elder-1", kst("2026-11-06T00:30:00"), 5);
    expect(kst("2026-11-05T23:30:00").getUTCDate()).toBe(kst("2026-11-06T00:30:00").getUTCDate());
    expect(await (await benefit())("elder-1", period)).toBe(false);
  });

  it("조회 조건 — 그 계정 대화의 user 발화, 관찰 제외, 첫날 KST 자정부터 이용기간 끝 전까지", async () => {
    await (await benefit())("elder-1", period);
    const where = db.message.findMany.mock.calls.at(-1)?.[0]?.where as Record<string, unknown>;
    expect(where).toMatchObject({
      conversation: { userId: "elder-1" }, role: "user",
      createdAt: { gte: kst("2026-11-02T00:00:00"), lt: period.end },
      NOT: { content: { startsWith: OBSERVATION_PREFIX } },
    });
  });
});

describe("판정할 것이 없는 경우", () => {
  it("무료 한도가 꺼져 있으면(0) 유료 혜택이라는 게 없다 — false, 조회도 하지 않는다", async () => {
    sayMany("elder-1", kst("2026-11-05T09:00:00"), 50);
    expect(await (await benefit())("elder-1", period, 0)).toBe(false);
    expect(db.message.findMany).not.toHaveBeenCalled();
  });

  it("빈 기간(끝 ≤ 시작)은 false", async () => {
    expect(await (await benefit())("elder-1", { start: period.end, end: period.start })).toBe(false);
  });
});
