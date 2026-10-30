/**
 * 날씨 맥락(lib/chat/weather) — 모르면 "모른다"고 넣는다(2026-10-30 AWS 검증에서 발견).
 *
 * 결함: 위치를 모르거나(위치 권한 거부·PC 브라우저·Live 음성 대화는 좌표를 아예 안 보냈다) 날씨 API가 실패하면
 *   "현재 날씨: 맑음 (위치 미제공 시 기본값)"이 "[현재 환경 정보 — 실시간 서버 데이터, 반드시 신뢰하세요]" 아래에 들어갔다.
 *   어르신이 "오늘 날씨 어떠니? 밖에 나가볼까" 하자 AI가 "하늘도 맑고 바깥공기 쐬기 딱 좋은 날씨예요"라고 지어냈다.
 *   대화 지침에는 "사용자가 날씨와 반대로 말하면 부드럽게 정정"하라는 지시도 있어, 비 오는 날 "비가 오네"를 틀리게 고칠 수 있었다.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { getWeatherContext, coordsFrom, UNKNOWN_WEATHER } from "@/lib/chat/weather";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 날씨 API·역지오코딩 응답을 흉내 낸다(네트워크 없음). code: null = 날씨 값이 빈 응답 */
function stubFetch({ weatherOk = true, code = 0 as number | null, temp = 12.3, place = true } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.includes("open-meteo")) {
      return weatherOk
        ? new Response(JSON.stringify({ current: code === null ? {} : { weather_code: code, temperature_2m: temp } }))
        : new Response("err", { status: 503 });
    }
    return place
      ? new Response(JSON.stringify({ address: { state: "경기도", city: "화성시", suburb: "동탄" } }))
      : new Response("err", { status: 503 });
  }));
}

describe("모르는 날씨를 지어내지 않는다", () => {
  it("위치가 없으면 '확인 안 됨' — '맑음'을 넣지 않고, 지어내지 말고 정정하지 말라고 적는다", async () => {
    const w = await getWeatherContext();
    expect(w.description).toBe(UNKNOWN_WEATHER);
    // 🔒 "반드시 신뢰하세요" 아래에 들어가는 줄이다 — 여기 '맑음'이 있으면 AI가 그대로 말한다
    expect(w.promptText).not.toContain("맑음");
    expect(w.promptText).toContain("현재 날씨: 확인 안 됨");
    expect(w.promptText).toContain("지어내지");
    // 🔒 사용자가 말하는 날씨를 고치지 말 것 — 모르는 날씨로 "지금은 맑은데요"라고 정정하면 안 된다
    expect(w.promptText).toContain("정정하지");
  });

  it("좌표가 숫자가 아니어도 같은 '확인 안 됨'", async () => {
    const w = await getWeatherContext(Number.NaN, 127);
    expect(w.description).toBe(UNKNOWN_WEATHER);
    expect(w.promptText).not.toContain("맑음");
  });

  it("날씨 API가 실패하면 '확인 안 됨' — 위치는 알면 그대로 적는다", async () => {
    stubFetch({ weatherOk: false });
    const w = await getWeatherContext(37.21, 127.07);
    expect(w.description).toBe(UNKNOWN_WEATHER);
    expect(w.promptText).not.toContain("맑음");
    expect(w.promptText).toContain("지어내지");
    expect(w.promptText).toContain("\n- 사용자 현재 위치: 경기도 화성시 동탄");
  });

  it("날씨 API가 성공했는데 날씨 값이 비어 있어도 '확인 안 됨'(예전엔 코드 0 = 맑음으로 읽었다)", async () => {
    stubFetch({ code: null });
    const w = await getWeatherContext(37.41, 127.27);
    expect(w.description).toBe(UNKNOWN_WEATHER);
    expect(w.promptText).not.toContain("맑음");
  });

  it("호출 자체가 던지면(네트워크 끊김) '확인 안 됨'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const w = await getWeatherContext(37.31, 127.17);
    expect(w.description).toBe(UNKNOWN_WEATHER);
    expect(w.promptText).not.toContain("맑음");
  });

  it("모를 때는 캐시하지 않는다 — 같은 위치로 다시 물으면 다시 조회해 알게 되면 그 값을 쓴다", async () => {
    stubFetch({ weatherOk: false });
    expect((await getWeatherContext(36.51, 126.51)).description).toBe(UNKNOWN_WEATHER);
    stubFetch({ code: 80, temp: 9 });
    expect((await getWeatherContext(36.51, 126.51)).description).toBe("비 또는 눈");
  });
});

describe("아는 날씨는 지금처럼 그대로 넣는다", () => {
  it.each([
    [0, "맑음"],
    [2, "대체로 맑음/흐림"],
    [61, "구름"],
    [80, "비 또는 눈"],
    [95, "천둥/폭풍"],
  ])("날씨 코드 %i → %s, 기온·위치 포함", async (code, desc) => {
    stubFetch({ code, temp: 8.5 });
    // 좌표를 0.1도 넘게 띄운다 — 캐시 키가 소수 둘째 자리라 가까우면 앞 경우의 값을 돌려받는다
    const w = await getWeatherContext(35 + code / 10, 128 + code / 10);
    expect(w.description).toBe(desc);
    expect(w.promptText).toBe(`현재 날씨: ${desc}, 8.5°C\n- 사용자 현재 위치: 경기도 화성시 동탄`);
  });
});

describe("coordsFrom — 화면이 보낸 좌표(Live 토큰 요청 본문)", () => {
  it("숫자이고 범위 안이면 그대로", () => {
    expect(coordsFrom({ latitude: 37.2, longitude: 127.07 })).toEqual({ latitude: 37.2, longitude: 127.07 });
    expect(coordsFrom({ latitude: -90, longitude: 180, conversationId: "c" })).toEqual({ latitude: -90, longitude: 180 });
  });

  it.each([
    ["없음", {}],
    ["null 본문", null],
    ["문자열", { latitude: "37.2", longitude: "127" }],
    ["하나만", { latitude: 37.2 }],
    ["위도 범위 밖", { latitude: 91, longitude: 127 }],
    ["경도 범위 밖", { latitude: 37, longitude: -181 }],
    ["무한대", { latitude: Infinity, longitude: 127 }],
    ["null 값(JSON의 NaN)", { latitude: null, longitude: 127 }],
  ])("%s → 좌표 없음", (_, body) => {
    expect(coordsFrom(body)).toEqual({});
  });
});
