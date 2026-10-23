"use client";

/**
 * 웹 브라우저에서만 그린다 — 앱(WebView) 안에서는 웹 결제(PG) 화면·링크·문구를 보이지 않는다(2026-10-22, Play 결제 정책:
 *   앱 안에서 Google Play 결제가 아닌 결제 수단으로 이끌면 안 된다 — 설계 0·'조사 반영 결정' 10).
 *
 * 앱인지 모르는 때(서버 렌더·하이드레이션 첫 그리기)에는 **아무것도 그리지 않는다** — 앱 웹뷰가 하이드레이션 전 HTML을 그대로 보여 줘
 *   잠깐이라도 결제 링크가 보이면 안 된다(app/login/page의 앱 받기 영역과 같은 이유, 2026-10-08 10차).
 * 판별은 app/subscribe의 기존 inApp과 같다(window.ReactNativeWebView — RN 웹뷰가 페이지 스크립트보다 먼저 넣는다).
 */
import { useSyncExternalStore } from "react";

const subscribeNothing = () => () => {};

/** 브라우저에서 읽는 값 — 앱(RN WebView)이 넣은 브릿지가 있으면 앱 */
export const inAppSnapshot = (): boolean => !!window.ReactNativeWebView;

/** 앱(WebView) 안인가 — null은 아직 모름(서버 렌더·하이드레이션 첫 그리기) */
export function useInApp(): boolean | null {
  return useSyncExternalStore(subscribeNothing, inAppSnapshot, () => null);
}

/** 무엇을 그릴까 — 모름(null)이면 아무것도, 앱이면 대체(inApp), 브라우저면 children */
export function webOnlyContent(inApp: boolean | null, children: React.ReactNode, inAppFallback: React.ReactNode): React.ReactNode {
  if (inApp === null) return null;
  return inApp ? inAppFallback : children;
}

export function WebOnly({ children, inApp: inAppFallback = null }: { children: React.ReactNode; inApp?: React.ReactNode }) {
  return <>{webOnlyContent(useInApp(), children, inAppFallback)}</>;
}
