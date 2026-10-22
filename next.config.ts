import type { NextConfig } from "next";

// CSP — Next.js 호환(인라인/eval 허용)이라 보호력은 제한적이나 외부 스크립트 주입은 차단.
//   외부 리소스(Gemini·날씨)는 서버측 호출이라 connect-src 'self'로 충분. 클라이언트 외부 리소스 추가 시 갱신 필요.
//   ⚠️ next.config 변경은 dev 서버 재시작 후 적용 — 배포/재시작 시 화면 로드 검증 권장.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // 화자식별(voiceprint): 모델·ORT WASM 런타임 모두 self-host(/models/, /ort/) — 외부 CDN 미사용.
  "connect-src 'self' wss://generativelanguage.googleapis.com https://generativelanguage.googleapis.com",
  "worker-src 'self' blob:",
  "media-src 'self' blob: data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
];
const CSP = CSP_DIRECTIVES.join("; ");

/** 지시어에 출처를 덧붙인다(없는 지시어는 새로 만든다) — 문자열 치환이 조용히 빗나가 결제창만 막히는 일이 없게 */
function withSources(directives: readonly string[], extra: Readonly<Record<string, string>>): string {
  const names = directives.map((d) => d.split(" ")[0]);
  const widened = directives.map((d, i) => (extra[names[i]] ? `${d} ${extra[names[i]]}` : d));
  const added = Object.entries(extra).filter(([name]) => !names.includes(name)).map(([name, src]) => `${name} ${src}`);
  return [...widened, ...added].join("; ");
}

/**
 * 웹 결제 화면(/subscribe·/subscribe/return 등)에만 넓히는 CSP — 포트원 브라우저 SDK와 PG 결제창이 동작하게(research B 13).
 *   공식 도메인 목록은 없다. 2026-10-22 CDN SDK 원본(https://cdn.portone.io/v2/browser-sdk.js — SDK_VERSION 1.36.1)과 그 SDK가
 *   불러오는 빌링키 발급 드라이버(cdn.portone.io/drivers/pg/{inicis-v2,kakaopay,naverpay}/issue-billing-key/*)에서 직접 뽑았다.
 *   · script-src  cdn.portone.io — SDK 본체와 결제 드라이버(script 태그로 붙인다)
 *   · connect-src SDK 상수 CHECKOUT_SERVER(checkout-service — 발급 준비·결과 확인 fetch)·TGS_PUBLIC_URI(tx-gateway-service)·
 *                 CORETELEMETRY_SERVER·CORE_SERVER(service.iamport.kr)·cdn.portone.io. SDK 안의 Sentry(오류 수집, sendDefaultPii)는
 *                 넣지 않는다 — 결제 동작과 무관하고, 결제 화면의 고객 정보가 제3자 오류 수집기로 나가지 않게.
 *   · frame-src   PC 결제창은 CHECKOUT_SERVER/driver-host를 iframe으로 띄우고(payment-bridge는 SDK의 PAYMENT_BRIDGE_URL), 카카오페이는
 *                 그 iframe이 카카오 결제 페이지로 스스로 이동한다 — 그 이동도 부모 문서(이 페이지)의 frame-src로 막힐 수 있어 PG 결제창
 *                 도메인을 함께 넣는다. 정해진 목록이 없어 와일드카드 호스트로 둔다(카카오·카카오페이·네이버페이·이니시스).
 *   · form-action 이니시스 모바일은 이 페이지에서 PG 주소로 form POST를 한다(드라이버 redirection — action은 포트원 응답).
 *   모바일 리디렉션(카카오페이·네이버페이 — location.href)과 네이버페이 PC 팝업은 최상위 창이라 이 CSP와 관계없다.
 *   ⚠ 실측 필요(research uncertain 28): 테스트 채널로 카드·카카오페이·네이버페이를 PC·모바일에서 한 번씩 발급해 보고 브라우저
 *     콘솔에 "Refused to … Content Security Policy" 위반이 없는지 본다(SDK가 CDN 최신본으로 바뀌면 도메인이 늘 수 있다).
 *   다른 경로는 기존 CSP 그대로 — 같은 경로에 같은 헤더가 두 번 걸리면 뒤의 값이 이긴다(Next 16 headers.md 'Header Overriding Behavior').
 */
const PG_WINDOW_HOSTS = "https://*.kakao.com https://*.kakaopay.com https://*.naver.com https://*.inicis.com";
const PAYMENT_CSP = withSources(CSP_DIRECTIVES, {
  "script-src": "https://cdn.portone.io",
  "connect-src": "https://checkout-service.prod.iamport.co https://tx-gateway-service.prod.iamport.co "
    + "https://coretelemetry.prod.iamport.co https://service.iamport.kr https://cdn.portone.io",
  "frame-src": `'self' https://checkout-service.prod.iamport.co https://payment-bridge.prod.iamport.co ${PG_WINDOW_HOSTS}`,
  "form-action": "https://*.inicis.com",
});

// 보안 헤더 — 민감 건강데이터 서비스 기본 방어.
const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },                     // 클릭재킹 방어
  { key: "X-Content-Type-Options", value: "nosniff" },           // MIME 스니핑 방어
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "geolocation=(self), microphone=(self), camera=()" },
];

const nextConfig: NextConfig = {
  /**
   * self-host(Docker/ECS) 배포용 standalone 출력 (2026-10-02, AWS 이전 준비).
   *
   * 무엇이 달라지나: .next/standalone/ 아래에 **추적된 의존성만** 복사된 server.js가 나온다.
   *   node_modules 1.6G를 통째로 싣지 않아도 되므로 이미지가 수백 MB 줄고 콜드스타트가 빨라진다.
   *   Vercel 배포에는 영향이 없다(플랫폼이 자체 번들링을 한다).
   *
   * ⚠ standalone은 public/ 과 .next/static 을 **자동으로 복사하지 않는다.** Dockerfile에서
   *   따로 COPY해야 한다 — 빠뜨리면 화자식별 모델(32M)·ORT WASM(35M)·APK(51M)·정적 자산이
   *   전부 404가 되고, 증상이 "일부 화면만 깨짐"으로 나타나 원인 찾기가 어렵다.
   *
   * ⚠ prisma client는 generated/prisma/client(커스텀 output)에 생성된다. standalone 추적이
   *   잡아내지만, Docker 빌더 단계에서 `prisma generate`가 **반드시 먼저** 돌아야 한다.
   *
   * 참고: standalone server.js는 process.env.KEEP_ALIVE_TIMEOUT을 읽는다
   *   (next/dist/build/utils.js). ALB idle timeout보다 크게 잡아야 502가 안 난다 — Dockerfile 주석 참조.
   */
  /**
   * ⚠ **조건부**로 켠다. 지금 프로덕션은 아직 Vercel에 떠 있다.
   *   Vercel이 standalone 출력을 어떻게 다루는지 이 환경에서 검증할 수 없고, 추측으로 켰다가
   *   **살아 있는 서비스의 배포를 깨뜨리는 위험**을 감수할 이유가 없다.
   *   Docker 빌드만 BUILD_STANDALONE=1을 주입한다(Dockerfile 참조). 이전이 끝나고 Vercel을
   *   내린 뒤에는 이 분기를 지우고 무조건 standalone으로 바꾸면 된다.
   */
  ...(process.env.BUILD_STANDALONE === "1" ? { output: "standalone" as const } : {}),

  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // 결제 화면만 CSP를 넓힌다(PAYMENT_CSP 주석) — "/subscribe/:path*"는 /subscribe 자체도 잡는다(:path*는 0개 이상)
      { source: "/subscribe/:path*", headers: [{ key: "Content-Security-Policy", value: PAYMENT_CSP }] },
    ];
  },
};

export default nextConfig;
