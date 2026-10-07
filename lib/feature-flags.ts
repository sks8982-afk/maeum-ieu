/**
 * 서버 측 기능 플래그 — **런타임에 바꿀 수 있어야 하는 것**만 여기 둔다.
 *
 * ⚠ 왜 분리했나 (2026-10-02 AWS 이전 감사 #9):
 *   `NEXT_PUBLIC_SHOW_LIVE_BETA` 하나가 UI 노출과 **서버 인가 게이트**를 동시에 맡고 있었다
 *   (app/api/live/token, app/api/live/turn). `NEXT_PUBLIC_*`는 **빌드 시점에 번들로 인라인**되므로
 *   런타임 env를 바꿔도 반영되지 않는다. 결과:
 *     · 사고가 나도 Live 경로를 **재빌드·재배포 없이는 끌 수 없다**
 *     · Docker 빌드 인자와 런타임 env가 갈리면 UI는 열려 있는데 API는 403(또는 그 반대)
 *   Live는 음성 스트리밍이라 사고 시 즉시 차단이 필요한 경로다.
 *
 * 규칙:
 *   · **서버 인가 판단은 이 함수를 쓴다**(런타임 env, 인라인 안 됨).
 *   · UI 노출은 계속 NEXT_PUBLIC_SHOW_LIVE_BETA를 쓴다(빌드 타임이어도 무해 —
 *     버튼이 보이는 것과 요청이 통과하는 것은 다르다).
 *   · 두 값이 갈릴 때의 안전한 방향: **API가 권위**다. UI가 열려 있는데 API가 막으면
 *     사용자는 오류를 보지만 안전하고, 반대는 아무 일도 안 일어난다(아무도 안 부른다).
 */
import { flagOn } from "@/lib/flags";

/**
 * Live(실시간 음성) 베타가 **서버에서** 허용되는가.
 *
 * 우선순위: LIVE_BETA_ENABLED(런타임, 서버 전용) → NEXT_PUBLIC_SHOW_LIVE_BETA(빌드 타임, 하위호환).
 *   둘 다 없으면 off. 끄는 쪽이 기본이다 — 켜는 것은 명시적이어야 한다.
 *
 * ⚠ 긴급 차단: ECS 태스크 정의에서 `LIVE_BETA_ENABLED=0`을 주고 재시작하면
 *   재빌드 없이 즉시 막힌다. 이것이 이 함수를 만든 이유다.
 */
export function isLiveBetaEnabledServer(): boolean {
  const runtime = process.env.LIVE_BETA_ENABLED?.trim();
  if (runtime) return flagOn(runtime);
  // 빌드 타임 값의 켜짐/꺼짐은 배포 점검(scripts/check-env.ts)과 같은 함수로(lib/flags — 정확히 "1"만 켠다)
  return flagOn(process.env.NEXT_PUBLIC_SHOW_LIVE_BETA);
}
