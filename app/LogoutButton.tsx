"use client";

import { useSession } from "next-auth/react";
import { LOGOUT_FAILED_ALERT, logoutAndNotifyNative } from "./RnBridge";

/** 문에서 화살표가 나가는 표준 로그아웃 아이콘(SVG — 폰트/이모지 의존 없이 모든 기기에서 렌더). */
export function LogoutIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className ?? "h-5 w-5"} aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" x2="9" y1="12" y2="12" />
    </svg>
  );
}

/**
 * 모든 화면 헤더 공통 로그아웃 버튼. className으로 화면별 톤 맞춤.
 * children 없으면 기본으로 SVG 아이콘 + "로그아웃" 표시(이모지 ⏻가 일부 안드로이드에서 ☒로 깨지던 문제 해결).
 */
export function LogoutButton({ className, children, title, "aria-label": ariaLabel }: { className?: string; children?: React.ReactNode; title?: string; "aria-label"?: string }) {
  const { data: session } = useSession();
  return (
    <button
      type="button"
      onClick={() => logoutAndNotifyNative({ userId: session?.user?.id, redirectTo: "/login" }).catch(() => window.alert(LOGOUT_FAILED_ALERT))}
      title={title ?? "로그아웃"}
      aria-label={ariaLabel ?? title ?? "로그아웃"}
      className={className ?? "inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"}
    >
      {children ?? (<><LogoutIcon className="h-5 w-5" /><span className="text-sm">로그아웃</span></>)}
    </button>
  );
}
