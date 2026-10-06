/**
 * 민감정보 별도 동의(선택) — 목소리 등록(성문)·상시 감시. 규칙은 lib/sensitive-consent.ts.
 *
 * GET                       → { voiceprint, observe }   (observe = 음성·건강정보 처리 + 보호자·의사 제공 둘 다)
 * POST { grant: Kind[] }    → 동의 기록 — 어르신 본인 계정이 건강정보 동의를 마친 경우만
 * DELETE ?kind=voiceprint   → 철회 + 성문(대표·표본) 즉시 파기
 * DELETE ?kind=observe      → 철회(처리·제공) + 상시 감시 기록 즉시 파기
 *
 * 동의는 **본인만** 한다(대리 없음). 연결된 전문가의 대리 등록(api/voiceprint targetUserId)도 이 동의를 본다.
 * 철회·파기는 **언제나** 된다 — 건강정보 동의·역할과 무관하게, 지울 권리는 막지 않는다.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { OBSERVATION_PREFIX } from "@/lib/chat/observation";
import {
  OBSERVE_KINDS, getActiveSensitiveConsents, grantSensitiveConsentStatement, isMissingConsentTable,
  isSensitiveKind, withdrawSensitiveConsentStatement, type SensitiveKind,
} from "@/lib/sensitive-consent";

const NOT_READY = { error: "목소리 등록·상시 감시는 아직 준비 중이에요. 잠시 후 다시 시도해 주세요.", notReady: true };

type TxStatement = ReturnType<typeof prisma.$executeRawUnsafe> | ReturnType<typeof prisma.message.deleteMany>;

/** 성문(표본·대표) 파기 문 — 트랜잭션에 넣는다. PrismaPromise는 한 번 쓰면 다시 못 쓰므로 매번 새로 만든다 */
const purgeVoiceprint = (userId: string): TxStatement[] => [
  prisma.$executeRawUnsafe(`DELETE FROM speaker_voiceprint_sample WHERE user_id = $1`, userId),
  prisma.$executeRawUnsafe(`DELETE FROM speaker_voiceprint WHERE user_id = $1`, userId),
];

/** 상시 감시 기록 파기 문 — 표지는 단일 출처(lib/chat/observation)로 고른다 */
const purgeObservation = (userId: string): TxStatement[] => [
  prisma.message.deleteMany({ where: { conversation: { userId }, content: { startsWith: OBSERVATION_PREFIX } } }),
];

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const active = await getActiveSensitiveConsents(session.user.id);
  return NextResponse.json({
    voiceprint: active.has("voiceprint"),
    observe: OBSERVE_KINDS.every((k) => active.has(k)),
  });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const userId = session.user.id;
  const rl = await checkRateLimit(`sensitive-consent:${userId}`, 20, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const raw: unknown[] = Array.isArray(body?.grant) ? body.grant : [];
  const kinds = [...new Set(raw)].filter(isSensitiveKind);
  if (kinds.length === 0 || kinds.length !== raw.length) {
    return NextResponse.json({ error: "동의 항목 형식 오류" }, { status: 400 });
  }
  // 상시 감시는 처리·제공을 **각각** 체크받되, 둘 다 있어야 켤 수 있다(알릴 수 없으면 감시의 목적이 없다).
  //   하나만 기록되면 화면은 동의한 것처럼 보이는데 게이트는 막는 반쪽 상태가 된다.
  const observeCount = kinds.filter((k) => OBSERVE_KINDS.includes(k)).length;
  if (observeCount !== 0 && observeCount !== OBSERVE_KINDS.length) {
    return NextResponse.json({ error: "상시 감시는 두 항목에 모두 동의해야 켤 수 있어요." }, { status: 400 });
  }

  const me = await prisma.user.findUnique({ where: { id: userId }, select: { consentedAt: true, screeningMode: true } });
  if (me?.screeningMode !== "user") {
    return NextResponse.json({ error: "목소리 등록·상시 감시는 어르신 본인 계정에서만 쓸 수 있어요.", wrongRole: true }, { status: 403 });
  }
  if (!me.consentedAt) {
    return NextResponse.json({ error: "건강정보 수집 동의가 필요합니다.", needConsent: true }, { status: 403 });
  }

  try {
    /**
     * 목소리 등록 동의가 **새로** 생기는 경우(첫 동의·철회 뒤·문안 버전 변경 뒤)엔 그 전에 남은 성문을 함께 지운다.
     *   별도 동의 없이 만들어진 성문(2026-10-06 이전 등록분, 평문 저장)이 동의 뒤 대조에 섞이지 않게 —
     *   동의 이후 등록한 목소리만 쓴다. 이미 유효한 동의를 다시 누른 경우엔 지우지 않는다.
     */
    const fresh = kinds.includes("voiceprint") && !(await getActiveSensitiveConsents(userId)).has("voiceprint");
    await prisma.$transaction([
      ...(fresh ? purgeVoiceprint(userId) : []),
      ...kinds.map((k) => grantSensitiveConsentStatement(userId, k)),
    ]);
  } catch (e) {
    if (isMissingConsentTable(e)) return NextResponse.json(NOT_READY, { status: 503 });
    throw e;
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const userId = session.user.id;
  const rl = await checkRateLimit(`sensitive-consent:${userId}`, 20, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  const kind = new URL(req.url).searchParams.get("kind");
  let purge: () => TxStatement[];
  let withdrawKinds: readonly SensitiveKind[];
  if (kind === "voiceprint") {
    purge = () => purgeVoiceprint(userId);
    withdrawKinds = ["voiceprint"];
  } else if (kind === "observe") {
    purge = () => purgeObservation(userId);
    withdrawKinds = OBSERVE_KINDS;
  } else {
    return NextResponse.json({ error: "알 수 없는 항목" }, { status: 400 });
  }

  // 파기와 철회 표시는 한 트랜잭션 — "철회됐는데 기록은 남음"을 만들지 않는다
  try {
    await prisma.$transaction([...purge(), ...withdrawKinds.map((k) => withdrawSensitiveConsentStatement(userId, k))]);
  } catch (e) {
    if (!isMissingConsentTable(e)) throw e;
    // 동의 테이블이 아직 없으면(배포 직후) 철회할 동의도 없다 — 파기는 그대로 한다
    await prisma.$transaction(purge());
  }
  return NextResponse.json({ ok: true });
}
