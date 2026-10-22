import { connection } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { isOwnRecentIssue } from "@/lib/billing/portone-return";
import { BizInfoFooter } from "@/app/components/BizInfoFooter";
import { ReturnView, type ReturnQuery } from "./ReturnView";

/**
 * 결제창에서 돌아오는 화면 (/subscribe/return) — 빌링키 발급 창이 forceRedirect로 결과를 쿼리에 실어 보낸다(research B 5).
 *   쿼리: issueId(발급 준비가 redirectUrl에 넣은 값) + SDK가 붙이는 billingKey·code·message·pgMessage(이름은 CDN SDK 원본 기준 —
 *   PG 페이지를 거치는 모바일 경로는 실측 필요, research uncertain 25).
 *   code가 있으면 실패 — 그 issueId가 지금 로그인한 사람의 최근 발급 시도일 때만 message를 **가공하지 않고** 그대로 보여 준다
 *   (네이버페이 조건 · 남이 만든 링크의 문구는 보이지 않는다 — lib/billing/portone-return). 없으면 { issueId, billingKey }로 첫 결제를 확정한다.
 *   쿼리 값은 신호일 뿐이다 — 서버가 포트원에서 빌링키를 다시 조회해 대조한다(app/api/billing/portone/activate).
 */
export const metadata = { title: "결제 결과 · 마음이음" };

const first = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] : v) ?? null;

export default async function SubscribeReturnPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const q = await searchParams;
  const query: ReturnQuery = {
    issueId: first(q.issueId), billingKey: first(q.billingKey), code: first(q.code), message: first(q.message), pgMessage: first(q.pgMessage),
  };
  // 실패 문구를 보일 때만 확인한다(성공 갈래는 서버 확정이 따로 대조한다)
  const session = query.code ? await getServerSession(authOptions).catch(() => null) : null;
  const trusted = query.code ? await isOwnRecentIssue(query.issueId, session?.user?.id ?? null) : false;
  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-50 to-[#eef2f7] dark:from-[#0b1220] dark:to-[#0b0d10]">
      <ReturnView query={query} trusted={trusted} />
      <BizInfoFooter />
    </div>
  );
}
