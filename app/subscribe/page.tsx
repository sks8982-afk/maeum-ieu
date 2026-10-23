import { connection } from "next/server";
import { BizInfoFooter } from "@/app/components/BizInfoFooter";
import { SubscribeView } from "./SubscribeView";

/**
 * 구독 (/subscribe) — 앱에서는 구독 상태(+ 스위치가 켜지면 Play 구매), 웹 브라우저에서는 웹 결제(포트원 정기결제) 신청·관리.
 *   화면 본체는 SubscribeView(클라이언트 — 앱/브라우저 판별), 하단은 사업자 정보(서버 env — BizInfoFooter).
 *   (2026-10-22) 예전엔 이 파일 하나가 클라이언트 화면이었다 — 하단 사업자 정보가 서버 env라 서버 컴포넌트로 감쌌다.
 *   CSP는 이 경로(/subscribe/:path*)만 포트원 SDK·결제창 도메인으로 넓힌다(next.config.ts PAYMENT_CSP).
 *   사업자 정보·스위치는 런타임 env라 요청마다 그린다(connection).
 */
export const metadata = { title: "구독 · 마음이음" };

export default async function SubscribePage() {
  await connection();
  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-50 to-[#eef2f7] dark:from-[#0b1220] dark:to-[#0b0d10]">
      <SubscribeView />
      <BizInfoFooter />
    </div>
  );
}
