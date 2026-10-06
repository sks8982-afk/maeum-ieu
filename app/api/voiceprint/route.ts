/**
 * 화자 성문(voiceprint) — 표본 누적 등록 / 대조 API.
 *
 * POST { action: "enroll", embedding, sampleSecs, targetUserId? }
 *   → 개별 표본(speaker_voiceprint_sample)에 추가 + 전체 표본 평균으로 대표 성문(speaker_voiceprint) 갱신.
 *     지문 다회 등록처럼 표본이 쌓일수록 대표 성문이 안정화됨. 원음성 미저장(벡터만).
 * POST { action: "verify", embedding, targetUserId? }  → 대표 성문과 코사인 유사도 → { score, isSelf }
 * POST { action: "reset",  targetUserId? }              → 표본·대표 성문 전부 삭제(다시 처음부터)
 * GET  → { enrolled, sampleCount, updatedAt?, sampleSecs?, voiceprintConsent }
 *
 * targetUserId(전문가가 환자 대신 등록): pro + active 연결일 때만, 그리고 **환자 본인의 목소리 등록 동의**가 있을 때만.
 *
 * 성문은 생체인식정보(민감정보)다 — 2026-10-06부터:
 *   · 만들기·대조·벡터 조회는 별도 동의(lib/sensitive-consent, kind "voiceprint")가 있어야 한다(제23조①1호)
 *   · 저장은 암호화(lib/voiceprint/seal — 안전성 확보조치 기준 제7조②7호). 예전엔 평문 JSONB였다.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { randomUUID } from "crypto";
import { checkRateLimit } from "@/lib/rate-limit";
import { VOICEPRINT_MODEL_ID, VOICEPRINT_THRESHOLD, VOICEPRINT_DIM } from "@/lib/voiceprint/constants";
import { getActiveSensitiveConsents } from "@/lib/sensitive-consent";
import { sealEmbedding, openEmbedding } from "@/lib/voiceprint/seal";

const EMBED_DIM = VOICEPRINT_DIM;

function l2norm(v: number[]): number[] {
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function resolveTarget(session: { user: { id: string; screeningMode?: string | null } }, targetUserId?: string): Promise<string | null> {
  const self = session.user.id;
  if (!targetUserId || targetUserId === self) return self;
  if (session.user.screeningMode !== "pro") return null;
  const link = await prisma.expertPatient.findUnique({
    where: { expertUserId_patientUserId: { expertUserId: self, patientUserId: targetUserId } },
    select: { status: true },
  });
  return link?.status === "active" ? targetUserId : null;
}

function isEmbedding(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === EMBED_DIM && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const targetUserId = new URL(req.url).searchParams.get("targetUserId") || undefined;
  const uid = await resolveTarget(session as never, targetUserId);
  if (!uid) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });

  // 성문 **벡터**(생체정보)는 본인에게만 — 상시 감시가 본인 기기 안에서 화자 게이팅할 때만 쓴다.
  //   연결된 전문가는 등록 여부·표본 수만 보면 된다. 예전엔 targetUserId로 환자 벡터를 그대로 받을 수
  //   있었다(2026-10-06 재검토 — 쓰는 화면은 없지만 최소 수집·최소 제공 원칙)
  //   ⚠ 별도 동의가 없으면 벡터를 내주지 않는다 — 동의 전에 만들어진 성문(예전 등록분)을 쓰지 않는다.
  const voiceprintConsent = (await getActiveSensitiveConsents(uid)).has("voiceprint");
  const withEmbedding = new URL(req.url).searchParams.get("withEmbedding") === "1" && uid === session.user.id && voiceprintConsent;
  const cols = withEmbedding ? "updated_at, sample_secs, sample_count, embedding" : "updated_at, sample_secs, sample_count";
  const rows = await prisma.$queryRawUnsafe<{ updated_at: Date; sample_secs: number | null; sample_count: number; embedding?: unknown }[]>(
    `SELECT ${cols} FROM speaker_voiceprint WHERE user_id = $1`, uid,
  );
  const r = rows[0];
  const out: Record<string, unknown> = {
    enrolled: !!r, sampleCount: r?.sample_count ?? 0, updatedAt: r?.updated_at ?? null, sampleSecs: r?.sample_secs ?? null,
    threshold: VOICEPRINT_THRESHOLD, voiceprintConsent,
  };
  // 본인 성문 벡터 반환 — 상시 감시가 기기 안에서 화자 게이팅(비환자 오디오 미전송)하도록. 본인 한정(위 withEmbedding).
  if (withEmbedding && r?.embedding) {
    const vec = openEmbedding(r.embedding);
    if (vec) out.embedding = vec;
    else console.error("[voiceprint] 저장된 성문을 읽을 수 없음(복호 실패) — 재등록 필요");
  }
  return NextResponse.json(out);
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: "로그인이 필요합니다." }, { status: 401 });

  const rl = await checkRateLimit(`voiceprint:${session.user.id}`, 40, 60_000);
  if (!rl.ok) return NextResponse.json({ error: "잠시 후 다시 시도해주세요." }, { status: 429 });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const action = body?.action;
  const uid = await resolveTarget(session as never, typeof body?.targetUserId === "string" ? body.targetUserId : undefined);
  if (!uid) return NextResponse.json({ error: "권한이 없습니다." }, { status: 403 });

  if (action === "reset") {
    await prisma.$executeRawUnsafe(`DELETE FROM speaker_voiceprint_sample WHERE user_id = $1`, uid);
    await prisma.$executeRawUnsafe(`DELETE FROM speaker_voiceprint WHERE user_id = $1`, uid);
    return NextResponse.json({ ok: true, enrolled: false, sampleCount: 0 });
  }

  if (!isEmbedding(body?.embedding)) return NextResponse.json({ error: "임베딩 형식 오류" }, { status: 400 });
  const embedding = l2norm(body.embedding as number[]);

  /**
   * 성문을 **만들거나 대조하는** 동작은 대상자가 (1) 어르신 계정이고 (2) 동의했을 때만.
   *   (reset은 막지 않는다 — 지우는 것은 언제든 할 수 있어야 한다)
   *
   * 결함(2026-10-06 적대 감사): 아무 확인 없이 성문을 만들었다. 마이페이지의 등록 링크는 역할·동의와
   *   무관하게 모든 계정에 보여, 동의 화면을 거치지 않는 보호자·전문가 계정이 UI만으로 자기 이름의
   *   성문을 만들 수 있었다(상시 감시는 이제 어르신 계정만 받으므로 쓸 곳도 없다). pro의 대리 등록도
   *   환자 동의를 보지 않았다.
   *
   * 그 위에 2026-10-06: 성문 **별도 동의**(대상자 본인의 것)가 있어야 한다 — 전문가 대리 등록도 환자의
   *   동의를 본다. 동의는 본인만 할 수 있다(app/api/users/sensitive-consent).
   */
  if (action === "enroll" || action === "verify") {
    const target = await prisma.user.findUnique({ where: { id: uid }, select: { consentedAt: true, screeningMode: true } });
    if (!target?.consentedAt) {
      return NextResponse.json({ error: "건강정보 수집 동의가 필요합니다.", needConsent: true }, { status: 403 });
    }
    if (target.screeningMode !== "user") {
      return NextResponse.json({ error: "목소리 등록은 어르신 계정에서만 할 수 있어요.", wrongRole: true }, { status: 403 });
    }
    if (!(await getActiveSensitiveConsents(uid)).has("voiceprint")) {
      return NextResponse.json({ error: "목소리 등록 동의가 필요합니다.", needVoiceprintConsent: true }, { status: 403 });
    }
  }

  if (action === "enroll") {
    const sampleSecs = typeof body?.sampleSecs === "number" ? Math.max(0, Math.min(600, body.sampleSecs)) : null;
    // 암호화부터 — 키가 없으면 아무것도 쓰지 않고 멈춘다(평문 저장 금지, lib/voiceprint/seal)
    let sealedSample: string;
    try { sealedSample = sealEmbedding(embedding); }
    catch (e) {
      console.error("[voiceprint]", e instanceof Error ? e.message : e);
      return NextResponse.json({ error: "보안 설정 문제로 목소리를 저장하지 못했어요. 잠시 후 다시 시도해 주세요." }, { status: 500 });
    }
    // 1) 개별 표본 추가
    await prisma.$executeRawUnsafe(
      `INSERT INTO speaker_voiceprint_sample (id, user_id, embedding, sample_secs) VALUES ($1, $2, $3::jsonb, $4)`,
      randomUUID(), uid, JSON.stringify(sealedSample), sampleSecs,
    );
    // 2) 전체 표본 평균 → 대표 성문 갱신 (읽을 수 없는 표본 — 키 교체 등 — 은 빼고 센다)
    const samples = await prisma.$queryRawUnsafe<{ embedding: unknown }[]>(
      `SELECT embedding FROM speaker_voiceprint_sample WHERE user_id = $1`, uid,
    );
    const vecs = samples.map((s) => openEmbedding(s.embedding)).filter((v): v is number[] => v !== null);
    if (vecs.length === 0) {
      return NextResponse.json({ error: "저장된 목소리를 읽을 수 없어요. 등록을 초기화한 뒤 다시 해 주세요." }, { status: 500 });
    }
    const dim = EMBED_DIM;
    const mean = new Array(dim).fill(0);
    for (const e of vecs) { for (let i = 0; i < dim; i++) mean[i] += e[i]; }
    for (let i = 0; i < dim; i++) mean[i] /= vecs.length;
    const centroid = l2norm(mean);
    await prisma.$executeRawUnsafe(
      `INSERT INTO speaker_voiceprint (user_id, embedding, dim, model, sample_secs, sample_count, updated_at)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, now())
       ON CONFLICT (user_id) DO UPDATE SET embedding = EXCLUDED.embedding, dim = EXCLUDED.dim,
         model = EXCLUDED.model, sample_secs = EXCLUDED.sample_secs, sample_count = EXCLUDED.sample_count, updated_at = now()`,
      uid, JSON.stringify(sealEmbedding(centroid)), dim, VOICEPRINT_MODEL_ID, sampleSecs, vecs.length,
    );
    return NextResponse.json({ ok: true, enrolled: true, sampleCount: vecs.length });
  }

  if (action === "verify") {
    // 대조용으로 받은 특징값은 비교에만 쓰고 저장하지 않는다(확인 테스트의 '다른 사람' 목소리 포함)
    const rows = await prisma.$queryRawUnsafe<{ embedding: unknown }[]>(
      `SELECT embedding FROM speaker_voiceprint WHERE user_id = $1`, uid,
    );
    if (!rows[0]) return NextResponse.json({ error: "등록된 성문이 없습니다." }, { status: 404 });
    const rep = openEmbedding(rows[0].embedding);
    if (!rep) return NextResponse.json({ error: "등록된 목소리를 읽을 수 없어요. 다시 등록해 주세요." }, { status: 500 });
    const score = cosine(embedding, rep);
    return NextResponse.json({ score, isSelf: score >= VOICEPRINT_THRESHOLD, threshold: VOICEPRINT_THRESHOLD });
  }

  return NextResponse.json({ error: "알 수 없는 action" }, { status: 400 });
}
