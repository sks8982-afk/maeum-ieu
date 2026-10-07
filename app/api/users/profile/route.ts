import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { encryptPII, decryptPII } from "@/lib/crypto";
import bcrypt from "bcryptjs";

/** 문자열 길이 상한 — 무제한 입력(프롬프트 인젝션 증폭·비용·DB 남용) 방어. */
const cap = (s: string | null | undefined, n: number): string | null | undefined => (s == null ? s : String(s).slice(0, n));

/** GET: 현재 사용자 프로필 조회 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, name: true, email: true, age: true, gender: true, guardianName: true, guardianPhone: true, guardianRelation: true, guardianEmail: true, guardianWebhookUrl: true, companionName: true, companionRelation: true, userHonorific: true, screeningMode: true, createdAt: true },
  });

  if (!user) {
    return NextResponse.json({ error: "사용자를 찾을 수 없습니다." }, { status: 404 });
  }

  // 연락처 PII 복호화 후 반환 (마이페이지 표시·수정용)
  return NextResponse.json({
    ...user,
    guardianPhone: decryptPII(user.guardianPhone),
    guardianEmail: decryptPII(user.guardianEmail),
  });
}

/** PATCH: 프로필 수정 */
export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }
  // 프로필 수정 폭주 방어 + bcrypt(비밀번호 변경) 반복 호출 CPU 점유 차단
  if (!(await checkRateLimit(`profile:${session.user.id}`, 10, 60_000)).ok) {
    return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });
  }

  const body = await req.json();
  // 계정 유형(screeningMode)은 가입 시에만 결정 — 마이페이지에서 변경 불가(권한 상승·검사 모드 스푸핑 악용 차단)
  const { name, age, gender, guardianName, guardianPhone, guardianRelation, guardianEmail, guardianWebhookUrl, companionName, companionRelation, userHonorific, currentPassword, newPassword } = body as {
    name?: string;
    age?: number | null;
    gender?: string | null;
    guardianName?: string | null;
    guardianPhone?: string | null;
    guardianRelation?: string | null;
    guardianEmail?: string | null;
    guardianWebhookUrl?: string | null;
    companionName?: string | null;
    companionRelation?: string | null;
    userHonorific?: string | null;
    currentPassword?: string;
    newPassword?: string;
  };

  // 비밀번호 변경 요청 시 검증
  if (newPassword) {
    if (!currentPassword) {
      return NextResponse.json({ error: "현재 비밀번호를 입력해주세요." }, { status: 400 });
    }
    // 회원가입 기준(8~128자)과 동일하게 — 짧은 비번 다운그레이드 + 초장문 bcrypt CPU DoS 방지
    if (newPassword.length < 8 || newPassword.length > 128) {
      return NextResponse.json({ error: "새 비밀번호는 8~128자여야 합니다." }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { password: true },
    });

    if (!user?.password) {
      return NextResponse.json({ error: "비밀번호를 확인할 수 없습니다." }, { status: 400 });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return NextResponse.json({ error: "현재 비밀번호가 일치하지 않습니다." }, { status: 400 });
    }
  }

  // gender 유효성 검사
  const validGenders = ["male", "female", "other"];
  if (gender !== undefined && gender !== null && !validGenders.includes(gender)) {
    return NextResponse.json({ error: "올바른 성별을 선택해주세요." }, { status: 400 });
  }

  // age 유효성 검사
  if (age !== undefined && age !== null && (age < 1 || age > 120 || !Number.isInteger(age))) {
    return NextResponse.json({ error: "나이는 1~120 사이의 정수여야 합니다." }, { status: 400 });
  }

  // 업데이트 데이터 구성
  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = cap(name, 40) || null;
  if (age !== undefined) updateData.age = age;
  if (gender !== undefined) updateData.gender = gender;
  if (guardianName !== undefined) updateData.guardianName = cap(guardianName, 40) || null;
  if (guardianPhone !== undefined) updateData.guardianPhone = encryptPII(cap(guardianPhone, 30) || null);
  if (guardianRelation !== undefined) updateData.guardianRelation = cap(guardianRelation, 20) || null;
  if (guardianEmail !== undefined) updateData.guardianEmail = encryptPII(cap(guardianEmail, 254) || null);
  if (guardianWebhookUrl !== undefined) {
    const url = (guardianWebhookUrl ?? "").trim();
    if (url) {
      let parsed: URL | null = null;
      try { parsed = new URL(url); } catch { /* invalid — 아래 host가 비어 isPrivate로 걸린다 */ }
      const host = parsed ? parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "") : "";
      const isHttps = /^https:\/\//i.test(url); // 민감 발화 평문 전송 방지 — https 전용
      // SSRF 방어 — 내부/사설/링크로컬/CGNAT 대역 차단(공개 webhook만 허용)
      const isPrivate = !host
        || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")
        || host === "0.0.0.0" || host === "::1"
        || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)
        || /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(host);
      if (!isHttps || isPrivate) {
        return NextResponse.json({ error: "Webhook URL은 공개된 https 주소여야 합니다(http·내부·사설 주소 불가)." }, { status: 400 });
      }
      // 주소에 아이디·비밀번호(https://아이디:비밀번호@…)를 싣지 못하게 — 발송 때도 막는다(lib/chat/emergency-notify-webhook
      //   isSafeWebhookUrl, 2026-10-07 8차). 저장해 두면 그 비밀이 주소와 함께 다니고, 위급 알림에선 메신저 사본이 영구 실패로 빠진다
      if (parsed && (parsed.username || parsed.password)) {
        return NextResponse.json({ error: "Webhook URL에 아이디·비밀번호를 넣을 수 없습니다(https://아이디:비밀번호@… 형식 불가). 메신저가 준 웹훅 주소를 그대로 넣어 주세요." }, { status: 400 });
      }
    }
    updateData.guardianWebhookUrl = url || null;
  }
  if (companionName !== undefined) updateData.companionName = cap((companionName && companionName.trim()) || "민지", 20);
  if (companionRelation !== undefined) updateData.companionRelation = cap((companionRelation && companionRelation.trim()) || "손녀", 20);
  if (userHonorific !== undefined) updateData.userHonorific = cap((userHonorific && userHonorific.trim()) || null, 20);
  // screeningMode는 의도적으로 업데이트하지 않음 — 가입 시 고정(악용 방지)
  if (newPassword) updateData.password = await bcrypt.hash(newPassword, 10);

  const updated = await prisma.user.update({
    where: { id: session.user.id },
    data: updateData,
    select: { id: true, name: true, email: true, age: true, gender: true, guardianName: true, guardianPhone: true, guardianRelation: true, screeningMode: true },
  });

  return NextResponse.json({ ...updated, guardianPhone: decryptPII(updated.guardianPhone) });
}
