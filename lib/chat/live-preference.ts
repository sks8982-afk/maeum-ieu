import { flagOn } from "@/lib/flags";

/**
 * 음성 동선을 Live(/live)로 보낼지 — 베타가 켜져 있어도 `?classic=1`이면 클래식 음성을 쓴다.
 *
 * 왜 따로 뺐나: 판정이 app/chat/page.tsx 안에 있으면 페이지 파일은 임의 함수를 export할 수 없어
 *   테스트가 소스 문자열만 볼 수 있었다. 그 구조 테스트는 반환값의 부호(`!`)를 지워 한도 뒤
 *   응급 통로가 다시 /live로 순환해도 통과했다(2026-10-06 재검토, 변이로 확인). 판정은 여기서
 *   직접 호출해 검증한다. (결함 배경은 app/chat/page.tsx의 preferLive 주석 참조)
 */
export function shouldPreferLive(betaFlag: string | undefined, search: string): boolean {
  // 베타 켜짐/꺼짐은 배포 점검(scripts/check-env.ts)과 같은 함수로(lib/flags — 정확히 "1"만 켠다)
  if (!flagOn(betaFlag)) return false;
  return new URLSearchParams(search).get("classic") !== "1";
}
