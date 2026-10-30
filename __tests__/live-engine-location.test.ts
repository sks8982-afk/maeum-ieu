/**
 * Live 엔진 — 날씨용 위치를 토큰 요청에 싣는다(2026-10-30).
 *
 * 결함: Live 화면은 위치를 묻지 않았고 엔진은 토큰 요청에 conversationId만 실었다. 서버는 좌표 없이 날씨를 물어
 *   Live 대화의 날씨는 언제나 지어낸 "맑음"이었다(lib/chat/weather 주석). 화면이 위치를 묻고, 엔진이 첫 연결과
 *   재연결(15분 상한) 모두에 좌표를 싣는다. 위치를 모르면 싣지 않는다 — 서버가 '확인 안 됨'으로 둔다.
 *
 * 목 체제: @google/genai(live.connect 콜백 포획) + fetch(토큰 발급 — 요청 본문을 모은다). 엔진 코드는 실물.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

type Callbacks = { onclose: (e: unknown) => void; onopen: () => void };
const connects: Callbacks[] = [];
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    live = {
      connect: async ({ callbacks }: { callbacks: Callbacks }) => {
        connects.push(callbacks);
        return { sendRealtimeInput: () => {}, close: () => {} };
      },
    };
  },
}));

const tokenBodies: Record<string, unknown>[] = [];
vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: { body?: string }) => {
  tokenBodies.push(JSON.parse(init?.body ?? "{}"));
  return new Response(JSON.stringify({ token: "t", model: "m" }), { status: 200 });
}));

const { LiveVoiceEngine } = await import("@/app/chat/live-voice");
const quiet = { onState: () => {}, onUserTranscript: () => {}, onAiTranscript: () => {}, onTurnComplete: () => {}, onError: () => {} };

beforeEach(() => {
  tokenBodies.length = 0;
  connects.length = 0;
});

describe("토큰 요청의 위치", () => {
  it("위치를 주면 첫 연결과 재연결 모두 좌표를 싣는다", async () => {
    const engine = new LiveVoiceEngine(quiet);
    await engine.start({ fakeMic: true, conversationId: "c-1", location: { latitude: 37.2, longitude: 127.07 } });
    expect(tokenBodies[0]).toEqual({ conversationId: "c-1", latitude: 37.2, longitude: 127.07 });

    connects[0].onclose({ code: 1000 }); // 15분 상한 → 새 토큰으로 다시 붙는다
    await vi.waitFor(() => expect(tokenBodies.length).toBe(2));
    // 🔒 재연결에서 빠지면 15분 뒤부터 날씨가 '확인 안 됨'으로 바뀐다
    expect(tokenBodies[1]).toEqual({ conversationId: "c-1", latitude: 37.2, longitude: 127.07 });
    engine.stop();
  });

  it("위치를 모르면 좌표 키 자체가 없다(서버가 '확인 안 됨'으로 둔다)", async () => {
    const engine = new LiveVoiceEngine(quiet);
    await engine.start({ fakeMic: true, conversationId: "c-2" });
    expect(tokenBodies[0]).toEqual({ conversationId: "c-2" });
    engine.stop();
  });
});

describe("화면이 위치를 묻고 엔진에 넘긴다", () => {
  const src = readFileSync("app/live/page.tsx", "utf-8");

  it("들어오면 바로 대략적 위치를 묻는다(채팅 화면과 같은 설정)", () => {
    expect(src).toMatch(/navigator\.geolocation\.getCurrentPosition\(/);
    expect(src).toMatch(/enableHighAccuracy: false, timeout: 5000, maximumAge: 300000/);
  });

  it("시작할 때 위치를 1.2초까지만 기다리고 엔진에 넘긴다 — 대화 시작을 늦추지 않는다", () => {
    expect(src).toMatch(/setTimeout\(\(\) => resolve\(undefined\), 1200\)/);
    expect(src).toMatch(/await engine\.start\(\{ fakeMic, conversationId: convRef\.current \?\? undefined, location \}\)/);
  });
});
