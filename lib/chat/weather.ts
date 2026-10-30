/** 날씨 + 위치 조회 (Open-Meteo 무료 API + Nominatim 역지오코딩) */

import type { WeatherContext } from "./types";

/** 위도/경도 → 주소 변환 (Nominatim 무료 역지오코딩) */
async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=ko&zoom=14`;
    const res = await fetch(url, {
      headers: { "User-Agent": "maeum-ieu/1.0" },
    });
    if (!res.ok) return "";
    const data = await res.json() as {
      address?: {
        city?: string;
        county?: string;
        borough?: string;
        suburb?: string;
        town?: string;
        village?: string;
        state?: string;
      };
      display_name?: string;
    };
    const addr = data.address;
    if (!addr) return "";
    // 시/도 + 시/군/구 + 동/읍/면
    const parts = [
      addr.state,
      addr.city || addr.county,
      addr.borough || addr.suburb || addr.town || addr.village,
    ].filter(Boolean);
    return parts.join(" ") || "";
  } catch {
    return "";
  }
}

// 날씨·위치 캐시 — 외부 API(open-meteo + Nominatim)가 매 메시지마다 1~4.5s로 응답 지연 주범이라
//   위치별(약 1km 반올림) 20분 인메모리 캐시. 날씨는 자주 안 변하므로 안전.
const weatherCache = new Map<string, { ctx: WeatherContext; expires: number }>();
const WEATHER_TTL_MS = 20 * 60 * 1000;

/**
 * 날씨를 모를 때 — **지어내지 않는다**(2026-10-30 AWS 검증에서 발견).
 *   예전엔 위치가 없거나(위치 권한 거부·PC 브라우저·Live 음성 대화는 좌표를 아예 안 보냈다) 날씨 API가 실패하면
 *   "현재 날씨: 맑음 (위치 미제공 시 기본값)"이 "[현재 환경 정보 — 실시간 서버 데이터, 반드시 신뢰하세요]" 아래에 들어가,
 *   어르신이 "오늘 날씨 어떠니? 밖에 나가볼까" 하자 "하늘도 맑고 바깥공기 쐬기 딱 좋은 날씨예요"라고 지어냈다.
 *   대화 지침의 "사용자가 날씨와 반대로 말하면 부드럽게 정정"과 만나면 비 오는 날 "비가 오네"를 틀리게 고칠 수도 있었다.
 */
export const UNKNOWN_WEATHER = "확인 안 됨";
function unknownWeather(location = ""): WeatherContext {
  const lines = [`현재 날씨: ${UNKNOWN_WEATHER}(위치 정보가 없거나 날씨를 불러오지 못함) — 날씨를 지어내지 마세요. 날씨를 물으시면 지금은 확인이 안 된다고 말씀드리고 창밖을 보시거나 일기예보를 확인해 보시라고 권하세요. 사용자가 말하는 날씨는 정정하지 마세요.`];
  if (location) lines.push(`사용자 현재 위치: ${location}`);
  return { description: UNKNOWN_WEATHER, location, promptText: lines.join("\n- ") };
}

/** 화면이 보낸 좌표 — 숫자이고 범위 안일 때만 쓴다(아니면 둘 다 없음 → '확인 안 됨'). Live 토큰 요청 본문용 */
export function coordsFrom(body: unknown): { latitude?: number; longitude?: number } {
  const { latitude, longitude } = (body ?? {}) as { latitude?: unknown; longitude?: unknown };
  if (typeof latitude !== "number" || typeof longitude !== "number") return {};
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return {};
  return { latitude, longitude };
}

export async function getWeatherContext(lat?: number, lon?: number): Promise<WeatherContext> {
  if (lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon)) {
    const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const cached = weatherCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.ctx;
    try {
      // 날씨 + 위치 동시 조회
      const [weatherRes, location] = await Promise.all([
        fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=weather_code,temperature_2m&timezone=Asia%2FSeoul`),
        reverseGeocode(lat, lon),
      ]);

      const data = weatherRes.ok
        ? ((await weatherRes.json()) as { current?: { weather_code?: number; temperature_2m?: number } })
        : null;
      const code = data?.current?.weather_code;
      // 날씨 값이 없으면 모르는 것이다 — 캐시하지 않고(다음 메시지에 다시 묻는다) '확인 안 됨'
      if (typeof code !== "number") return unknownWeather(location);
      const desc = code === 0 ? "맑음" : code < 4 ? "대체로 맑음/흐림" : code < 70 ? "구름" : code < 90 ? "비 또는 눈" : "천둥/폭풍";
      const temp = data?.current?.temperature_2m != null ? `, ${data.current.temperature_2m}°C` : "";

      const locationText = location || "위치 미확인";
      const ctx: WeatherContext = {
        description: desc,
        location: locationText,
        promptText: `현재 날씨: ${desc}${temp}\n- 사용자 현재 위치: ${locationText}`,
      };
      weatherCache.set(cacheKey, { ctx, expires: Date.now() + WEATHER_TTL_MS });
      return ctx;
    } catch { /* 아래 '확인 안 됨' */ }
  }
  return unknownWeather();
}
