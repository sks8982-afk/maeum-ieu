/**
 * 결제창 복귀 화면의 문구 신뢰(lib/billing/portone-return isOwnRecentIssue) — 2026-10-22 검토(/subscribe/return 문구 주입).
 *
 * 지키는 것:
 *   · 쿼리의 실패 문구(message)는 그 issueId가 **지금 로그인한 사람의 최근 발급 시도**일 때만 그대로 보인다 — 남이 만든 링크로
 *     공식 결제 화면에 피싱 문구("이중 결제… 고객센터 070-…")를 띄우지 못하게.
 *   · 남의 발급 시도·없는 issueId·꼴이 틀린 값·발급 준비 시간(PENDING_TTL)이 지난 시도·로그인 없음 → 믿지 않는다.
 *   · 포트원 설정 전에는 DB를 보지 않는다(운영 변화 0) · 조회가 실패해도 화면은 고정 안내로 그려진다(throw 하지 않는다).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { db, seedFamily, kst, PLAN_DAY30, CONSENT } from "./helpers/billing-portone-harness";

const load = () => import("@/lib/billing/portone-return");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(kst("2026-11-02T14:05:00"));
});
afterEach(() => vi.useRealTimers());

async function pendingIssue(): Promise<string> {
  seedFamily({ guardian: "guardian-1", elder: "elder-1" });
  const { createPendingSubscription } = await import("@/lib/billing/portone-activate");
  const r = await createPendingSubscription({ purchaserUserId: "guardian-1", beneficiaryUserId: "elder-1", plan: PLAN_DAY30, method: "CARD", consent: CONSENT });
  if (!r.ok) throw new Error(r.code);
  return r.issueId;
}

describe("복귀 화면 문구 — 내 최근 발급 시도일 때만 믿는다", () => {
  it("내가 방금 준비한 발급 → 믿는다", async () => {
    const issueId = await pendingIssue();
    const { isOwnRecentIssue } = await load();
    expect(await isOwnRecentIssue(issueId, "guardian-1")).toBe(true);
  });

  it("남의 발급 시도 · 로그인 없음 · 없는 issueId · 꼴이 틀린 값 → 믿지 않는다", async () => {
    const issueId = await pendingIssue();
    const { isOwnRecentIssue } = await load();
    expect(await isOwnRecentIssue(issueId, "someone-else")).toBe(false);
    expect(await isOwnRecentIssue(issueId, null)).toBe(false);
    expect(await isOwnRecentIssue(`bk${"f".repeat(32)}`, "guardian-1")).toBe(false);
    expect(await isOwnRecentIssue("결제 오류로 이중 결제", "guardian-1")).toBe(false);
    expect(await isOwnRecentIssue(null, "guardian-1")).toBe(false);
  });

  it("발급 준비 시간(1시간)이 지난 시도 → 믿지 않는다(오래된 링크를 다시 쓰지 못하게)", async () => {
    const issueId = await pendingIssue();
    const { isOwnRecentIssue } = await load();
    vi.setSystemTime(kst("2026-11-02T15:06:00"));
    expect(await isOwnRecentIssue(issueId, "guardian-1")).toBe(false);
  });

  it("포트원 설정 전이면 DB를 보지 않고 믿지 않는다 · 조회 실패도 throw 없이 믿지 않는다", async () => {
    const issueId = await pendingIssue();
    const { isOwnRecentIssue } = await load();
    const { prisma } = await import("@/lib/prisma");
    const spy = vi.spyOn(prisma.subscription, "findUnique");
    delete process.env.PORTONE_STORE_ID;
    expect(await isOwnRecentIssue(issueId, "guardian-1")).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    process.env.PORTONE_STORE_ID = "store-test";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    spy.mockRejectedValueOnce(new Error("db down"));
    expect(await isOwnRecentIssue(issueId, "guardian-1")).toBe(false);
    expect(db.subscription.rows).toHaveLength(1);
  });
});
