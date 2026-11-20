/**
 * 야간 누출 검사(scripts/check-prompt-leak.ts)를 **공개 저장소의 GitHub Actions**에서 돌릴 때 로그에 찍히는 값을 가린다(2026-11-20).
 *   공개 저장소의 Actions 로그는 누구나 본다 — 누출이 발견되면 찍히는 값이 실제 사용자의 가족 이름·배우자 이름·고향이고,
 *   DB 연결 오류 메시지에는 DB 서버 주소가 들어간다(공개 저장소에 서버 주소를 적지 않는다 — lib/db-tls 주석).
 *   로컬에서 돌릴 때는 고치려면 값을 봐야 하니 가리지 않는다.
 */

/** GitHub Actions에서 도는가 */
export function inCi(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.GITHUB_ACTIONS === "true";
}

/** 값을 첫 글자만 남기고 가린다 — "영수" → "영○", 한 글자는 통째로 */
export function maskValue(value: string): string {
  const chars = [...value];
  return chars.length <= 1 ? "○" : chars[0] + "○".repeat(chars.length - 1);
}

/** 문장 속의 그 값을 모두 가린다(걸린 코드 줄을 보여 줄 때) */
export function maskIn(text: string, value: string): string {
  return value ? text.split(value).join(maskValue(value)) : text;
}

/** 오류 메시지 속 IPv4 주소(포트 포함)와 DB 접속 문자열을 가린다 */
export function scrubHosts(text: string): string {
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "[접속 문자열 가림]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "[주소 가림]");
}
