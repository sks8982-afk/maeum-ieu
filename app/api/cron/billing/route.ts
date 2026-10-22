/**
 * 결제 예약 작업 — 하루 1회 Vercel Cron이 부른다(vercel.json crons: "0 2 * * *" = 매일 02:00 UTC = 11:00 KST).
 *   대사(웹훅을 놓친 결제 결과 확인)·재시도 예약 다시 걸기·해지 기간 끝난 이용권 만료·남은 빌링키 정리·덜 된 환불 이어 하기·
 *   결제 3일 전 안내 메일(lib/billing/portone-maintenance runBillingMaintenance — 모든 단계가 멱등이라 두 번 돌아도 같다).
 *
 * 왜 11:00 KST인가: 포트원 예약 결제·재시도는 10:00 KST에 실행된다(lib/billing/portone-period). 대사는 예정 시각에서 30분이 지나도
 *   결과가 없는 결제만 보므로, 10시 직후에 돌면 그날 결제는 다음 날에야 확인된다. 11시면 그날 놓친 웹훅을 그날 맞춘다.
 *   결제 3일 전 안내도 이 시각이면 10:00 결제의 약 3일 전에 나간다.
 * ⚠ Vercel 요금제 제한: Hobby는 크론이 하루 1회까지이고 정각을 보장하지 않는다(지정한 시간 안 아무 때 — 02:00~02:59 UTC, 대사에는
 *   지장 없다). 함수 실행 시간도 요금제 상한을 넘지 못한다(maxDuration 60초). Pro는 분 단위 정확도. 크론은 프로덕션 배포에만 돈다.
 *   AWS(ECS)로 옮기면 Vercel Cron이 없다 — EventBridge Scheduler 등으로 같은 시각에 같은 헤더를 붙여 이 주소를 부르게 한다.
 * 인증: Authorization: Bearer <CRON_SECRET>(Vercel Cron이 CRON_SECRET env를 보고 붙인다). 미설정이면 404 — 열린 채로 두지 않는다.
 *   인증 미들웨어 밖이다(middleware matcher에 /api가 없다). 포트원 설정 전(상점 아이디 없음)이면 아무것도 하지 않는다(운영 변화 0).
 *   상점 아이디는 있는데 API Secret이 없으면(운영 중 교체 실수·만료) 운영 경보를 보내고 할 수 있는 일(안내 메일·만료)은 한다.
 * 판매 스위치(BILLING_PG_ENABLED)와 무관하게 돈다 — 이미 결제된 이용권은 스위치를 꺼도 돌봐야 한다(lib/billing/portone-route 머리말).
 */
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runBillingMaintenance } from "@/lib/billing/portone-maintenance";
import { billingOpsAlert } from "@/lib/billing/portone-mail";
import { errorKind, portoneServiceable } from "@/lib/billing/portone-route";

export const maxDuration = 60;

/** Bearer 비밀 비교 — 길이가 달라도 시간 차로 새지 않게 같은 길이 비교만 한다 */
function authorized(req: Request, secret: string): boolean {
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!authorized(req, secret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!portoneServiceable()) return NextResponse.json({ ok: true, skipped: "pg_not_configured" });
  if (!process.env.PORTONE_API_SECRET?.trim()) {
    // 운영 중 Secret이 빠졌다(교체 실수·만료) — 포트원은 예약 결제를 계속 실행하는데 반영·환불·빌링키 정리가 실패한다. 사람이 고쳐야 한다
    await billingOpsAlert("[결제] 포트원 API Secret 없음 — 결제 반영·해지 정리가 멈춰 있다", ["PORTONE_API_SECRET을 다시 넣고 다시 배포하세요(키를 빼서 결제를 끄지 않는다 — 판매만 끄려면 BILLING_PG_ENABLED)."]);
  }
  try {
    const result = await runBillingMaintenance();
    console.warn(`[billing-cron] 점검 ${result.checked} · 실패 ${result.failed} · 결제 예정 안내 ${result.notices}`);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // 대상 조회 자체가 실패(DB 등) — 다음 날 다시 돈다. 구독 하나의 실패는 runBillingMaintenance가 세고 운영 경보를 보낸다
    console.error(`[billing-cron] 예약 작업 실패: ${errorKind(e)}`);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
