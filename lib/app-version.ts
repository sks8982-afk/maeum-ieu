/**
 * 안드로이드 앱 버전·배포 경로 — **스위치 하나**(NEXT_PUBLIC_APP_ON_PLAY=1)가 두 가지를 함께 바꾼다(2026-10-07).
 *   · 로그인 화면의 앱 받기 버튼: 꺼짐 = 웹에 올린 APK(public/maeum-app.apk, 1.0.3) / 켜짐 = Play 스토어(1.2.0)
 *   · 기기 토큰 시대의 경고: 꺼짐 = 등록 휴대폰 0대를 정상으로 본다 — 지금 현장의 앱 1.0.3은 휴대폰 등록을 모르고 토픽으로
 *     받는다. 그래서 "휴대폰 없음·업데이트" 안내도, 운영자 "앱 알림 수신 기기 미확인" 경보도 내지 않는다
 *     / 켜짐 = 0대면 경고한다(1.2.0은 로그인하면 그 휴대폰을 등록한다).
 * ⚠ **1.2.0 프로덕션 단계적 출시가 100%가 된 뒤에만** Vercel에 NEXT_PUBLIC_APP_ON_PLAY=1을 넣고 재배포한다(2026-10-08 — Play Console에
 *   "공개"됐다는 것만으로는 아니다: 단계적 출시 중엔 일부 사용자만 1.2.0을 받는다). 먼저 켜면 1.0.3 사용자에게 받을 수도 없는 업데이트를
 *   하라고 하고, 토픽으로 잘 받고 있는 보호자까지 "휴대폰 없음"으로 보인다.
 *   빌드 타임 값이라(번들에 박힌다) env만 바꾸고 재배포하지 않으면 아무것도 바뀌지 않는다(scripts/check-env.ts BUILD_TIME_VARS).
 * ⚠ public/maeum-app.apk는 1.0.3 그대로 둔다 — 스위치를 켜기 전의 다운로드 경로다(__tests__/dockerfile-contract).
 *   RN 앱 버전(MaeumApp/App.jsx의 APP_VERSION + android/app/build.gradle versionName)을 올리면 아래 값도 함께 맞출 것.
 */
import { flagOn } from "@/lib/flags";

export const PLAY_STORE_URL = "https://play.google.com/store/apps/details?id=com.maeumapp";

// 켜짐/꺼짐은 배포 점검(scripts/check-env.ts)과 같은 함수로 정한다(lib/flags — 정확히 "1"만 켠다)
export const APP_ON_PLAY = flagOn(process.env.NEXT_PUBLIC_APP_ON_PLAY);

/** 받을 수 있는 최신 앱 버전 — 설치된 앱이 이보다 낮으면 로그인 화면에서 "업데이트" 안내가 표시됨 */
export const LATEST_APP_VERSION = APP_ON_PLAY ? "1.2.0" : "1.0.3";

/**
 * 구독 결제(Play Billing)를 지원하는 최소 앱 버전.
 *
 * 왜 따로 두나: 이전 버전 앱은 PURCHASE_SUBSCRIPTION 메시지를 처리하지 못해 결제 버튼이
 *   아무 반응 없이 멈춘 것처럼 보인다. 구매 버튼은 이 버전 이상에서만 노출한다.
 *   ⚠️ 결제 기능이 포함된 APK/AAB를 올릴 때 이 값을 그 버전으로 맞출 것.
 */
export const MIN_BILLING_APP_VERSION = "1.1.0";

/** 휴대폰 등록(PUSH_TOKEN)을 아는 최소 앱 버전 — 이보다 낮은 앱은 토픽만 구독하고, 서버는 그 휴대폰이 있는지 모른다 */
export const MIN_PUSH_TOKEN_APP_VERSION = "1.2.0";

/** a < b 인지(semver 단순 비교). 설치된 앱이 최신보다 낮을 때만 업데이트 안내. */
export function isOlderVersion(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

/** 기기 토큰 시대의 경고를 켤 때인가 — 받을 수 있는 최신 앱이 휴대폰 등록을 알 때만(= 위 스위치를 켰을 때) */
export const PUSH_TOKENS_LIVE = !isOlderVersion(LATEST_APP_VERSION, MIN_PUSH_TOKEN_APP_VERSION);
