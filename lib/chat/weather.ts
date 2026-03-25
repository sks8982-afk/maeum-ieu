/** 날씨 조회 (Open-Meteo 무료 API) */

import type { WeatherContext } from "./types";

export async function getWeatherContext(lat?: number, lon?: number): Promise<WeatherContext> {
  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=weather_code&timezone=Asia%2FSeoul`;
      const res = await fetch(url);
      if (res.ok) {
        const data = (await res.json()) as { current?: { weather_code?: number } };
        const code = data.current?.weather_code ?? 0;
        const desc = code === 0 ? "맑음" : code < 4 ? "대체로 맑음/흐림" : code < 70 ? "구름" : code < 90 ? "비 또는 눈" : "천둥/폭풍";
        return { description: desc, promptText: `현재 날씨: ${desc}` };
      }
    } catch { /* fallback */ }
  }
  return { description: "맑음", promptText: "현재 날씨: 맑음 (위치 미제공 시 기본값)" };
}
