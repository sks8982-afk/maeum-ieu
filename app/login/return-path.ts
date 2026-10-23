/**
 * 로그인 뒤 갈 곳 — callbackUrl 중 같은 사이트의 구독 화면(/subscribe)만 따른다(2026-10-22 검토 — 메일·요금 안내로 들어와 로그인하면
 *   구독 관리로 돌아와야 한다. 해지 길이 가입보다 어려우면 해지 방해다).
 *   그 밖은 예전처럼 홈("/") — 홈이 역할별 첫 화면을 서버에서 정한다. 바깥 주소(//host·\host·다른 오리진)로는 보내지 않는다(열린 리디렉션).
 */
const RETURN_PATHS = new Set(["/subscribe"]);

export function loginReturnPath(raw: string | null, origin: string): string {
  if (!raw) return "/";
  try {
    const url = new URL(raw, origin);
    return url.origin === origin && RETURN_PATHS.has(url.pathname) ? url.pathname : "/";
  } catch {
    return "/";
  }
}
