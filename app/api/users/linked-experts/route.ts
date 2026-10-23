/**
 * 환자 측 전문가 연결 관리 — GET: 내가 연결한 전문가 목록 / DELETE: 연결 해제(revoke).
 * 해제는 환자 본인 권리(동의 철회) — 전문가 측 목록·상세에서 즉시 사라짐(active 필터).
 *
 * GET의 appAlert(2026-10-07): 연결한 분이 휴대폰 앱으로 위급 알림을 받을 수 있는지 — "ready"(알림 허용 휴대폰 있음) ·
 *   "off"(등록 휴대폰이 모두 알림 꺼짐) · "none"(등록 휴대폰 없음) **상태만**. 예전엔 연결만 하고 앱에 로그인하지 않은
 *   보호자도 알림을 받는 것처럼 보였다. 휴대폰 대수·토큰·마지막 확인 시각은 싣지 않는다(4차 — 그분의 휴대폰 정보다.
 *   어르신 화면엔 "받을 수 있나"만 있으면 된다, 개인정보처리방침 9항). 조회가 실패하면 null(목록은 그대로 보인다).
 *
 * DELETE의 결제 정리(2026-10-22): 해제 **전에** 그 보호자가 이 어르신을 위해 결제한 웹 이용권을 다음 결제부터 해지한다
 *   (settleBillingBeforeUnlink). 포트원 정리(예약 취소·빌링키 삭제)가 실패해도 해제는 진행한다 — 연결 해제는 어르신의 정보 열람 동의
 *   철회라 즉시 되어야 하고, 해지 의사를 DB에 먼저 적으면 그 뒤 결제는 전액 취소되며 남은 빌링키는 예약 작업이 지운다(운영 경보).
 *   해지 의사를 적는 DB 쓰기가 실패할 때만 멈춘다. 응답 문구에는 결제 이야기를 넣지 않는다(앱 화면 — Play 정책).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { summarizeDevices, type DeviceSummary } from "@/lib/push/devices";
import type { AppAlertState } from "@/lib/push/app-alert-label";

/** DELETE가 포트원(예약 취소·빌링키 삭제)을 부를 수 있다 — 포트원 권장 읽기 타임아웃 60초 이상(research B 6) */
export const maxDuration = 60;

/**
 * 연결 해제 **전에** 이 보호자가 결제한 웹 이용권을 다음 결제부터 해지한다(설계 '조사 반영 결정' 9) — 연결부터 끊으면 포트원 예약이
 *   남아 카드가 계속 결제된다. 포트원 정리 실패는 해지 함수가 운영 경보로 넘기고 throw하지 않는다(lib/billing/portone-cancel
 *   cancelForBeneficiaryGone — 2026-10-22 검토: 예전엔 API Secret 만료·키 교체만으로 어르신이 연결을 끊을 수 없었다).
 *   throw는 해지 의사를 적는 DB 쓰기 실패뿐이다 → false(해제를 멈추고 다시 시도하게 한다 — 이미 한 일은 다시 하지 않는다).
 *   결제회원에게는 해지 안내 메일이 간다(원하면 위약금 없는 지금 해지).
 *   포트원 설정 전이면 아무것도 하지 않는다(운영 변화 0). 결제 모듈은 여기서만 불러온다(동적 import — 목록 조회는 싣지 않는다).
 */
async function settleBillingBeforeUnlink(patientUserId: string, expertUserId: string): Promise<boolean> {
  const { portoneServiceable } = await import("@/lib/billing/portone-route");
  if (!portoneServiceable()) return true;
  try {
    const { cancelForBeneficiaryGone } = await import("@/lib/billing/portone-cancel");
    await cancelForBeneficiaryGone(patientUserId, { reason: "link_revoked", purchaserUserId: expertUserId });
    return true;
  } catch (e) {
    console.error(`[expert-link] 해제 전 결제 정리 실패 — 해제 보류 patient=${patientUserId.slice(0, 8)}:`, e instanceof Error ? e.message.slice(0, 80) : e);
    return false;
  }
}

/** 연결 계정들의 휴대폰 집계 — 실패해도 연결 목록은 보여야 한다 */
async function deviceSummaries(expertIds: string[]): Promise<Map<string, DeviceSummary> | null> {
  try {
    return await summarizeDevices(expertIds);
  } catch (e) {
    console.error("[linked-experts] 휴대폰 집계 실패:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** 집계 → 어르신 화면에 내보내는 상태(대수는 내보내지 않는다) */
function appAlertState(s: DeviceSummary): AppAlertState {
  if (s.granted > 0) return "ready";
  return s.count > 0 ? "off" : "none";
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const links = await prisma.expertPatient.findMany({
    where: { patientUserId: session.user.id, status: "active" },
    select: { expertUserId: true, createdAt: true, expert: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const devices = await deviceSummaries(links.map((l) => l.expertUserId));
  return NextResponse.json({
    experts: links.map((l) => {
      const s = devices?.get(l.expertUserId);
      return {
        expertUserId: l.expertUserId, name: l.expert.name ?? "전문가", linkedAt: l.createdAt,
        appAlert: s ? appAlertState(s) : null,
      };
    }),
  });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  let expertUserId = "";
  try {
    const body = await req.json();
    expertUserId = String(body?.expertUserId ?? "");
  } catch {
    return NextResponse.json({ error: "잘못된 요청 형식입니다." }, { status: 400 });
  }
  if (!expertUserId) return NextResponse.json({ error: "expertUserId가 필요합니다." }, { status: 400 });

  if (!(await settleBillingBeforeUnlink(session.user.id, expertUserId))) {
    return NextResponse.json({ error: "연결을 해제하지 못했어요. 잠시 후 다시 시도해 주세요." }, { status: 502 });
  }

  const r = await prisma.expertPatient.updateMany({
    where: { expertUserId, patientUserId: session.user.id, status: "active" },
    data: { status: "revoked" },
  });
  if (r.count === 0) return NextResponse.json({ error: "연결을 찾을 수 없습니다." }, { status: 404 });

  console.log("[expert-link] revoked", JSON.stringify({ expert: expertUserId.slice(0, 8), patient: session.user.id.slice(0, 8) }));
  return NextResponse.json({ ok: true });
}
