/**
 * 환자 측 전문가 연결 관리 — GET: 내가 연결한 전문가 목록 / DELETE: 연결 해제(revoke).
 * 해제는 환자 본인 권리(동의 철회) — 전문가 측 목록·상세에서 즉시 사라짐(active 필터).
 *
 * GET의 appAlert(2026-10-07): 연결한 분이 휴대폰 앱으로 위급 알림을 받을 수 있는지 — "ready"(알림 허용 휴대폰 있음) ·
 *   "off"(등록 휴대폰이 모두 알림 꺼짐) · "none"(등록 휴대폰 없음) **상태만**. 예전엔 연결만 하고 앱에 로그인하지 않은
 *   보호자도 알림을 받는 것처럼 보였다. 휴대폰 대수·토큰·마지막 확인 시각은 싣지 않는다(4차 — 그분의 휴대폰 정보다.
 *   어르신 화면엔 "받을 수 있나"만 있으면 된다, 개인정보처리방침 9항). 조회가 실패하면 null(목록은 그대로 보인다).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { summarizeDevices, type DeviceSummary } from "@/lib/push/devices";
import type { AppAlertState } from "@/lib/push/app-alert-label";

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

  const r = await prisma.expertPatient.updateMany({
    where: { expertUserId, patientUserId: session.user.id, status: "active" },
    data: { status: "revoked" },
  });
  if (r.count === 0) return NextResponse.json({ error: "연결을 찾을 수 없습니다." }, { status: 404 });

  console.log("[expert-link] revoked", JSON.stringify({ expert: expertUserId.slice(0, 8), patient: session.user.id.slice(0, 8) }));
  return NextResponse.json({ ok: true });
}
