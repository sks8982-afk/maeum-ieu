/**
 * "응급이 다른 게이트에 삼켜지는" 경로의 회귀 고정.
 *
 * 이 라우트에는 응급 판정 뒤에 여러 단락(short-circuit) 게이트가 있다 — STT 신뢰도,
 * 모더레이션 거절, 일일 한도, 시간 즉답. 각 게이트는 "응급이면 비켜난다"를 전제로 쓰였지만,
 * 2026-10-02 적대 리뷰에서 **그 전제가 코드에 없는 곳이 둘** 발견됐다.
 * 공통 증상: 발화가 저장되긴 하는데 emergencyLevel 없이 저장돼
 *   (1) L1 누적 앵커가 안 남아 24h 3회 → L2 승격이 영구히 안 걸리고
 *   (2) L2였다면 보호자 알림이 0건이며
 *   (3) 그 턴의 인지 분석까지 함께 사라진다.
 * 전부 **에러 없이 조용히** 일어난다.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "node:fs/promises";

let src = "";
beforeAll(async () => { src = await readFile("app/api/chat/route.ts", "utf-8"); });

describe("STT 저신뢰 게이트가 응급을 삼키지 않는다", () => {
  it("응급 레벨이 0일 때만 단락한다", () => {
    // 🔒 `if (!sttConf.pass) {`로 되돌아가면 보속증 L1("먹기 싫어"×4)이 통째로 사라진다
    //    — 그 반복 발화는 vocabulary collapse로 저신뢰 판정되는데 동시에 L1 응급이다.
    expect(src).toMatch(/if \(!sttConf\.pass && emergency\.effectiveLevel === 0\) \{/);
  });

  it("우회 시 사유를 로그에 남긴다 (조용한 우회 금지)", () => {
    expect(src).toMatch(/저신뢰이나 응급 신호 동반 — 게이트 우회/);
  });
});

describe("모더레이션 거절이 응급을 삼키지 않는다", () => {
  it("handleInappropriateMessage가 emergency를 인자로 받는다", () => {
    const start = src.indexOf("async function handleInappropriateMessage(");
    expect(start).toBeGreaterThan(-1);
    const sig = src.slice(start, start + 1400);
    // 🔒 인자가 빠지면 "아무나 도와줘, 이 씨X 놈들아"(L2 + profanity)에서 L2가 사라진다
    expect(sig).toMatch(/emergency\?: \{ effectiveLevel/);
  });

  it("두 호출부 모두 emergency를 넘긴다 (한쪽만 고치면 비대칭이 남는다)", () => {
    const calls = [...src.matchAll(/handleInappropriateMessage\(\{[\s\S]{0,400}?\}\)/g)].map((m) => m[0]);
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c).toMatch(/emergency,/);
  });

  it("거절 경로가 응급을 마킹하고 L2면 알림을 보낸다", () => {
    const start = src.indexOf("async function handleInappropriateMessage(");
    const body = src.slice(start, src.indexOf("/** 5) 텍스트 요청", start));
    expect(body).toMatch(/emergencyLevel: lvl > 0 \? lvl : undefined/);
    expect(body).toMatch(/if \(lvl === 2 && emergency\)/);
    expect(body).toMatch(/notifyGuardian\(/);
  });
});

describe("일일 한도 게이트가 응급을 삼키지 않는다", () => {
  it("정규식 + LLM 백스톱 둘 다 본 뒤에 차단한다", () => {
    const gate = src.slice(src.indexOf("usage.exceeded"), src.indexOf("dailyLimitReached"));
    expect(gate).toMatch(/detectEmergencyDetailed\(spoken\)/);
    expect(gate).toMatch(/detectEmergencyLLM\(spoken\)/);
  });
});

describe("저장 실패가 L2 알림을 삼키지 않는다 (네 경로 전부)", () => {
  it("saveMessages 호출이 전부 try/catch로 격리돼 있다", () => {
    // 🔒 `const { userMsgId } = await saveMessages(` 형태가 되살아나면 그 경로의 L2가
    //    DB 실패 한 번에 사라진다. 구조 분해 대입은 try 안에서 `({ userMsgId } = ...)` 형태여야 한다.
    expect(src).not.toMatch(/const \{ userMsgId \} = await saveMessages\(/);
    const guarded = [...src.matchAll(/\(\{ userMsgId \} = await saveMessages\(/g)];
    expect(guarded.length).toBeGreaterThanOrEqual(4);
  });
});
