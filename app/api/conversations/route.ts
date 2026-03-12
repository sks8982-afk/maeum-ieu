import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/** GET: 현재 사용자 전용 대화 1개 + 전체 메시지 (사용자당 대화 1개) */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const conv = await prisma.conversation.findUnique({
    where: { userId: session.user.id },
    include: {
      messages: { orderBy: { createdAt: "asc" }, select: { id: true, role: true, content: true } },
    },
  });

  if (!conv) return NextResponse.json({ conversation: null, messages: [] });
  return NextResponse.json({
    conversation: { id: conv.id },
    messages: conv.messages.map((m) => ({ id: m.id, role: m.role, content: m.content })),
  });
}

/** POST: 사용자당 대화 1개 보장. 없으면 생성, 있으면 기존 id 반환 (get-or-create) */
export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  }

  const conv = await prisma.conversation.upsert({
    where: { userId: session.user.id },
    create: { userId: session.user.id },
    update: {},
  });
  return NextResponse.json({ id: conv.id });
}
