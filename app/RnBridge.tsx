"use client";

import { useSession } from "next-auth/react";
import { useCallback, useEffect, useRef } from "react";

/**
 * 마음이음 RN 앱(WebView) ↔ 웹 브릿지.
 *
 * RN WebView 안에서 실행될 때만 동작(window.ReactNativeWebView 존재 시).
 * - 로그인/세션 활성 → { type:"LOGIN_SUCCESS", userId } 전송 → 앱이 maeum_<userId> 토픽 구독
 * - **사용자가 로그아웃 버튼을 눌렀을 때만** → { type:"LOGOUT" } (notifyNativeLogout) → 앱이 토픽 구독 해제
 *   (세션 상태가 "unauthenticated"로 보인다는 것만으로는 보내지 않는다 — bridgeMessageFor 주석)
 * - 앱이 보낸 구매 토큰(PURCHASE_TOKEN)을 서버에 검증 요청 → 완료 시 앱에 마감 신호
 *
 * 왜 구매 검증이 여기 있나: 네이티브 계층에는 로그인 쿠키가 없어 서버가 결제자를 알 수 없다.
 *   그래서 **세션을 가진 웹**이 검증을 호출해야 한다. 그리고 앱은 로그인 직후
 *   미완료 구매를 재전송하므로(검증 전 앱 종료 복구), 어느 화면에 있어도 처리되어야 한다
 *   — /subscribe 화면에만 두면 복구가 유실된다.
 *
 * 일반 브라우저에서는 ReactNativeWebView가 없으므로 noop.
 */
declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

/** 구독 상태가 바뀌었음을 같은 페이지의 다른 컴포넌트에 알리는 이벤트 */
export const BILLING_UPDATED_EVENT = "maeum:billing-updated";

/**
 * 세션 상태 → 앱에 보낼 메시지. **로그아웃 신호는 여기서 만들지 않는다.**
 *
 * 결함(2026-10-07 보호자 앱 푸시 추적): 상태가 "unauthenticated"면 LOGOUT을 보냈다. 그런데 next-auth는
 *   세션 조회가 **한 번만 실패해도**(앱으로 돌아오는 순간의 네트워크 끊김·5xx·응답 오류) 세션을 null로,
 *   즉 unauthenticated로 본다. 그러면 앱이 보호자 휴대폰의 토픽 구독을 끊어, 다시 로그인하거나 앱을
 *   재시작할 때까지 **위급 알림이 조용히 끊겼다**(화면은 로그인 창으로 갈 뿐 아무 경고도 없다).
 *   위급 알림은 "확실하지 않으면 구독 유지"가 맞다 → LOGOUT은 로그아웃 버튼에서만(notifyNativeLogout).
 *   다른 계정으로 로그인하면 앱이 LOGIN_SUCCESS를 받아 이전 구독을 새 계정으로 바꾼다(MaeumApp/App.jsx).
 *
 * @returns 보낼 메시지와 기억할 값, 보낼 게 없으면 null
 */
export function bridgeMessageFor(
  status: "authenticated" | "unauthenticated" | "loading",
  userId: string | undefined,
  lastSent: string | null,
): { message: string; sent: string } | null {
  if (status !== "authenticated" || !userId || lastSent === userId) return null;
  return { message: JSON.stringify({ type: "LOGIN_SUCCESS", userId }), sent: userId };
}

/**
 * 사용자가 **로그아웃 버튼을 눌렀을 때만** 부른다 — 앱이 이 기기의 위급 알림 구독을 끊는다. 일반 브라우저에선 noop.
 *
 * ⚠ **signOut이 성공한 뒤에** 부른다(2026-10-07 재검토). 먼저 보내면, 네트워크가 끊기거나 로그아웃 요청이
 *   실패했을 때 웹은 여전히 로그인 상태인데 앱만 구독을 끊어 — 고치려던 "로그인한 채 알림이 조용히 끊김"이 다시 생긴다.
 * @param userId 로그아웃하는 계정 — 앱이 저장해 둔 계정을 잃었어도 이 계정의 구독을 정확히 끊을 수 있게(앱 1.2.0+)
 */
export function notifyNativeLogout(userId?: string): void {
  try {
    window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "LOGOUT", ...(userId ? { userId } : {}) }));
  } catch {
    /* 웹뷰 브릿지 오류가 로그아웃을 막지 않게 */
  }
}

export function RnBridge() {
  const { data: session, status } = useSession();
  const lastSentRef = useRef<string | null>(null);
  /** 같은 토큰을 중복 검증하지 않게 — 앱이 복구로 여러 번 보낼 수 있다 */
  const verifiedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const rn = typeof window !== "undefined" ? window.ReactNativeWebView : undefined;
    if (!rn) return;
    // 세션이 끊겨 보이면 기억만 지운다(구독은 유지) — 다시 로그인되면 같은 계정이어도 한 번 더 알린다
    if (status === "unauthenticated") { lastSentRef.current = null; return; }
    const next = bridgeMessageFor(status, session?.user?.id, lastSentRef.current);
    if (!next) return;
    lastSentRef.current = next.sent;
    rn.postMessage(next.message);
  }, [status, session?.user?.id]);

  const verify = useCallback(async (purchaseToken: string, productId?: string) => {
    if (verifiedRef.current.has(purchaseToken)) return;
    verifiedRef.current.add(purchaseToken);
    try {
      const r = await fetch("/api/billing/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchaseToken, productId }),
      });
      if (!r.ok) {
        // 마감 신호를 보내지 않는다 — 미완료로 남겨 다음 실행에서 다시 검증되게.
        verifiedRef.current.delete(purchaseToken);
        const j = await r.json().catch(() => null) as { error?: string } | null;
        window.dispatchEvent(new CustomEvent(BILLING_UPDATED_EVENT, {
          detail: { ok: false, error: j?.error || "구매를 확인하지 못했습니다." },
        }));
        return;
      }
      window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "PURCHASE_VERIFIED", purchaseToken }));
      window.dispatchEvent(new CustomEvent(BILLING_UPDATED_EVENT, { detail: { ok: true } }));
    } catch {
      verifiedRef.current.delete(purchaseToken);
      window.dispatchEvent(new CustomEvent(BILLING_UPDATED_EVENT, {
        detail: { ok: false, error: "구매 확인 중 오류가 발생했습니다." },
      }));
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.ReactNativeWebView) return;
    const onMsg = (e: MessageEvent) => {
      const d = typeof e.data === "string" ? e.data : "";
      if (!d.includes("PURCHASE_TOKEN")) return;
      try {
        const msg = JSON.parse(d) as { type?: string; purchaseToken?: string; productId?: string };
        if (msg.type === "PURCHASE_TOKEN" && msg.purchaseToken) {
          void verify(msg.purchaseToken, msg.productId);
        }
      } catch { /* 다른 메시지 */ }
    };
    window.addEventListener("message", onMsg);
    document.addEventListener("message", onMsg as EventListener); // 안드로이드 WebView
    return () => {
      window.removeEventListener("message", onMsg);
      document.removeEventListener("message", onMsg as EventListener);
    };
  }, [verify]);

  return null;
}
