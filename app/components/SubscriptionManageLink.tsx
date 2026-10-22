"use client";

/**
 * '구독 관리' 링크(/subscribe) — /expert 머리·/mypage에 둔다(2026-10-22 검토: 약관·결제 안내가 "웹의 [구독 관리]에서 언제든 해지"라고
 *   하는데 화면 어디에도 가는 길이 없었다. 해지 길이 가입보다 어려우면 해지 방해다 — 전자상거래법 제21조의2①4호).
 *
 * 그리는 때: 브라우저로 확인됐고(앱 안·모를 때는 부르지도 그리지도 않는다 — Play 결제 정책, WebOnly와 같은 판별)
 *   웹 결제 이용권이나 결제 내역이 있을 때만(/api/billing/status pg — 포트원 설정 전이면 null이라 운영 변화 0).
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useInApp } from "@/app/components/WebOnly";
import { hasPgRecords, requestJson, type BillingStatus } from "@/app/subscribe/pg-client";

/** 링크를 그릴까 — 브라우저(false)이고 관리할 것이 있을 때만 */
export function manageLinkVisible(inApp: boolean | null, st: BillingStatus | null): boolean {
  return inApp === false && hasPgRecords(st);
}

export function SubscriptionManageLink({ className }: { className: string }) {
  const inApp = useInApp();
  const [st, setSt] = useState<BillingStatus | null>(null);
  useEffect(() => {
    if (inApp !== false) return;
    let alive = true;
    (async () => {
      const r = await requestJson<BillingStatus>("/api/billing/status");
      if (alive && r.ok) setSt(r.data);
    })();
    return () => { alive = false; };
  }, [inApp]);
  if (!manageLinkVisible(inApp, st)) return null;
  return <Link href="/subscribe" className={className}>구독 관리</Link>;
}
