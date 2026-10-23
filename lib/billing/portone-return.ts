/**
 * 결제창 복귀 화면(/subscribe/return)의 쿼리 문구를 믿을까 — **서버 전용**(2026-10-22 검토: 복귀 화면 문구 주입).
 *   쿼리는 누구나 만들 수 있다 — /subscribe/return?code=X&message=… 링크로 공식 결제 화면(사업자 정보 하단까지)에 "이중 결제…
 *   고객센터 070-…" 같은 문구를 띄울 수 있었다(React가 이스케이프해 XSS는 아니지만 피싱 문구다).
 *   그래서 그 issueId가 **지금 로그인한 사람의 최근 발급 시도**일 때만 문구를 그대로 보인다(아니면 화면은 고정 안내).
 *   issueId는 발급 준비가 만든 추측할 수 없는 값(newIssueId — bk + 32자리)이고 결제회원 본인만 안다.
 * 포트원 설정 전이면 DB를 보지 않는다(운영 변화 0). 조회가 실패하면 믿지 않는다(throw 하지 않는다 — 화면은 그려진다).
 */
import { prisma } from "@/lib/prisma";
import { ISSUE_ID_RE, PENDING_TTL_MS } from "@/lib/billing/portone-activate";
import { portoneConfigured } from "@/lib/billing/portone-plans";

export async function isOwnRecentIssue(issueId: string | null, userId: string | null, now = new Date()): Promise<boolean> {
  if (!issueId || !userId || !ISSUE_ID_RE.test(issueId) || !portoneConfigured()) return false;
  try {
    const sub = await prisma.subscription.findUnique({
      where: { purchaseToken: `portone:${issueId}` }, select: { purchaserUserId: true, createdAt: true },
    });
    // 발급 준비 시간(PENDING_TTL)이 지난 시도는 결제도 하지 않는다 — 오래된 링크의 문구도 믿지 않는다
    return !!sub && sub.purchaserUserId === userId && now.getTime() - sub.createdAt.getTime() <= PENDING_TTL_MS;
  } catch (e) {
    console.warn("[billing-pg] 결제 복귀 확인 실패(고정 안내로 보인다):", e instanceof Error ? e.message.slice(0, 80) : e);
    return false;
  }
}
