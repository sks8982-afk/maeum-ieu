/**
 * /api/voiceprint 게이트 — **행위** 테스트. 성문(화자 특징 벡터)은 생체인식정보다.
 *
 * 2026-10-06 이전: 대상자의 동의·역할을 전혀 보지 않고 성문을 만들었다(마이페이지 링크는 모든 계정에
 *   보인다). → 만들거나 대조하는 동작은 "동의한 어르신 계정"만. 지우는 동작(reset)은 언제나 허용.
 * 2026-10-06 그 뒤: 성문 **별도 동의**(lib/sensitive-consent, kind "voiceprint")와 **암호화 저장**
 *   (lib/voiceprint/seal)을 더했다 — 동의서·개인정보처리방침의 고지와 짝이다.
 *
 * 목 체제: 세션·레이트리밋·prisma(사용자·연결·raw SQL). 성문 계산·암호화는 실제 코드.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const SAVED_KEY = process.env.ENCRYPTION_KEY;
process.env.ENCRYPTION_KEY = "c".repeat(64);
afterAll(() => { if (SAVED_KEY === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = SAVED_KEY; });

let session: { user: { id: string; screeningMode?: string } } = { user: { id: "u-elder", screeningMode: "user" } };
const users: Record<string, { consentedAt: Date | null; screeningMode: string }> = {};
/** 유효한 별도 동의(사용자 → 종류들) */
let consents: Record<string, string[]> = {};
/** 저장된 성문 — raw SQL 목이 읽고 쓴다(임베딩은 DB에 들어가는 그대로: 암호문 문자열 또는 예전 평문 배열) */
let samples: { user: string; embedding: unknown }[] = [];
let rep: Record<string, unknown> = {};
const writes: { sql: string; params: unknown[] }[] = [];

vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => users[where.id] ?? null) },
    expertPatient: { findUnique: vi.fn(async () => ({ status: "active" })) },
    $executeRawUnsafe: vi.fn(async (sql: string, ...params: unknown[]) => {
      const head = sql.trim().split(/\s+/).slice(0, 3).join(" ");
      writes.push({ sql: head, params });
      // $3::jsonb에는 JSON 텍스트가 들어간다 — DB가 파싱해 저장하는 것처럼 JSON.parse
      if (head === "INSERT INTO speaker_voiceprint_sample") samples.push({ user: params[1] as string, embedding: JSON.parse(params[2] as string) });
      if (head === "INSERT INTO speaker_voiceprint") rep[params[0] as string] = JSON.parse(params[1] as string);
      return 1;
    }),
    $queryRawUnsafe: vi.fn(async (sql: string, uid: string) => {
      if (sql.includes("sensitive_consent")) {
        const { SENSITIVE_CONSENT_VERSION } = await import("@/lib/sensitive-consent");
        return (consents[uid] ?? []).map((kind) => ({ kind, version: SENSITIVE_CONSENT_VERSION[kind as "voiceprint"] }));
      }
      if (sql.includes("speaker_voiceprint_sample")) return samples.filter((s) => s.user === uid).map((s) => ({ embedding: s.embedding }));
      if (sql.includes("speaker_voiceprint")) return uid in rep ? [{ updated_at: new Date(), sample_secs: 30, sample_count: 1, embedding: rep[uid] }] : [];
      return [];
    }),
  },
}));

const { VOICEPRINT_DIM } = await import("@/lib/voiceprint/constants");
const { sealEmbedding } = await import("@/lib/voiceprint/seal");
const { POST, GET } = await import("@/app/api/voiceprint/route");
const EMB = Array.from({ length: VOICEPRINT_DIM }, (_, i) => Math.sin(i + 1));
const unit = (v: number[]) => { const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)); return v.map((x) => x / n); };

async function post(body: Record<string, unknown>) {
  const res = await POST(new Request("http://localhost/api/voiceprint", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
async function get(qs: string) {
  const res = await GET(new Request(`http://localhost/api/voiceprint${qs}`));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

beforeEach(() => {
  writes.length = 0;
  samples = [];
  rep = {};
  for (const k of Object.keys(users)) delete users[k];
  users["u-elder"] = { consentedAt: new Date("2026-01-01"), screeningMode: "user" };
  consents = { "u-elder": ["voiceprint"] };
  session = { user: { id: "u-elder", screeningMode: "user" } };
});

describe("본인 등록", () => {
  it("동의한 어르신은 등록된다", async () => {
    const r = await post({ action: "enroll", embedding: EMB, sampleSecs: 8 });
    expect(r.status).toBe(200);
    expect(writes.some((w) => w.sql === "INSERT INTO speaker_voiceprint_sample")).toBe(true);
  });

  it("미동의 어르신은 403 needConsent — 성문을 만들지 않는다", async () => {
    users["u-elder"].consentedAt = null;
    const r = await post({ action: "enroll", embedding: EMB });
    expect(r.status).toBe(403);
    expect(r.body.needConsent).toBe(true);
    // 🔒 2026-10-06 이전: 아무 확인 없이 생체정보(성문)가 저장됐다
    expect(writes).toEqual([]);
  });

  it.each(["guardian", "pro", "general"])("%s 본인 계정은 403 wrongRole — 쓸 곳도 없는 생체정보를 만들지 않는다", async (role) => {
    session = { user: { id: `u-${role}`, screeningMode: role } };
    users[`u-${role}`] = { consentedAt: new Date("2026-01-01"), screeningMode: role };
    const r = await post({ action: "enroll", embedding: EMB });
    expect(r.status).toBe(403);
    expect(r.body.wrongRole).toBe(true);
    expect(writes).toEqual([]);
  });

  it("대조(verify)도 같은 게이트를 탄다", async () => {
    users["u-elder"].consentedAt = null;
    const r = await post({ action: "verify", embedding: EMB });
    expect(r.status).toBe(403);
  });
});

describe("성문 별도 동의 (2026-10-06)", () => {
  it("건강정보 동의만 있고 목소리 등록 동의가 없으면 403 needVoiceprintConsent — 만들지 않는다", async () => {
    consents = {};
    const r = await post({ action: "enroll", embedding: EMB });
    expect(r.status).toBe(403);
    // 🔒 성문은 생체인식정보 = 민감정보 → 별도 동의(개인정보 보호법 제23조①1호). 건강정보 동의로는 안 된다
    expect(r.body.needVoiceprintConsent).toBe(true);
    expect(writes).toEqual([]);
  });

  it("대조도 목소리 등록 동의를 본다", async () => {
    consents = {};
    rep["u-elder"] = sealEmbedding(unit(EMB));
    const r = await post({ action: "verify", embedding: EMB });
    expect(r.status).toBe(403);
    expect(r.body.needVoiceprintConsent).toBe(true);
  });

  it("동의가 없으면 본인에게도 벡터를 내주지 않는다 — 동의 전 성문을 쓰지 않는다", async () => {
    consents = {};
    rep["u-elder"] = sealEmbedding(unit(EMB));
    const r = await get("?withEmbedding=1");
    expect(r.body.voiceprintConsent).toBe(false);
    expect(r.body.embedding).toBeUndefined();
  });

  it("삭제(reset)는 동의 없이도 된다", async () => {
    consents = {};
    const r = await post({ action: "reset" });
    expect(r.status).toBe(200);
    expect(writes.filter((w) => w.sql.startsWith("DELETE FROM")).length).toBe(2);
  });
});

describe("암호화 저장 (2026-10-06 — 안전성 확보조치 기준 제7조②7호)", () => {
  it("표본·대표 성문이 모두 암호문으로 저장된다", async () => {
    await post({ action: "enroll", embedding: EMB, sampleSecs: 30 });
    // 🔒 2026-10-06 이전: 평문 JSONB(숫자 배열)로 저장됐다
    expect(samples).toHaveLength(1);
    expect(typeof samples[0].embedding).toBe("string");
    expect(String(samples[0].embedding).startsWith("enc:v1:")).toBe(true);
    expect(String(rep["u-elder"]).startsWith("enc:v1:")).toBe(true);
  });

  it("키가 없으면 500 — 아무것도 쓰지 않는다(평문 저장 금지)", async () => {
    const key = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await post({ action: "enroll", embedding: EMB });
      expect(r.status).toBe(500);
      expect(writes).toEqual([]);
    } finally {
      process.env.ENCRYPTION_KEY = key;
    }
  });

  it("두 번째 등록은 암호화된 표본들을 열어 평균한다", async () => {
    await post({ action: "enroll", embedding: EMB });
    const other = Array.from({ length: VOICEPRINT_DIM }, (_, i) => Math.cos(i + 1));
    const r = await post({ action: "enroll", embedding: other });
    expect(r.body.sampleCount).toBe(2);
    // 대표 = 두 정규화 표본 평균의 정규화 — 본인 벡터가 열린 뒤 계산됐는지
    const { openEmbedding } = await import("@/lib/voiceprint/seal");
    const centroid = openEmbedding(rep["u-elder"])!;
    const a = unit(EMB), b = unit(other);
    const expected = unit(a.map((x, i) => (x + b[i]) / 2));
    expect(centroid[0]).toBeCloseTo(expected[0], 10);
    expect(centroid[100]).toBeCloseTo(expected[100], 10);
  });

  it("본인은 withEmbedding=1로 **복호화된** 벡터를 받는다 (상시 감시의 기기 내 화자 게이팅)", async () => {
    rep["u-elder"] = sealEmbedding(unit(EMB));
    const r = await get("?withEmbedding=1");
    expect(r.status).toBe(200);
    expect(r.body.voiceprintConsent).toBe(true);
    // 🔒 암호문 문자열을 그대로 내주면 기기 쪽 Array.isArray 검사에서 "미등록"으로 보여 감시가 안 켜진다
    expect(r.body.embedding).toEqual(unit(EMB));
  });

  it("대조는 암호화된 대표 성문을 열어 비교한다", async () => {
    rep["u-elder"] = sealEmbedding(unit(EMB));
    const r = await post({ action: "verify", embedding: EMB });
    expect(r.status).toBe(200);
    expect(r.body.score as number).toBeCloseTo(1, 6);
    expect(r.body.isSelf).toBe(true);
  });

  it("예전 평문 대표 성문도 읽는다(정리 전 호환)", async () => {
    rep["u-elder"] = unit(EMB);
    const r = await post({ action: "verify", embedding: EMB });
    expect(r.body.isSelf).toBe(true);
  });
});

describe("전문가 대리 등록", () => {
  beforeEach(() => { session = { user: { id: "u-pro", screeningMode: "pro" } }; });

  it("연결된 환자가 미동의면 403 — 환자 동의를 본다", async () => {
    users["u-patient"] = { consentedAt: null, screeningMode: "user" };
    consents["u-patient"] = ["voiceprint"];
    const r = await post({ action: "enroll", embedding: EMB, targetUserId: "u-patient" });
    expect(r.status).toBe(403);
    expect(r.body.needConsent).toBe(true);
    expect(writes).toEqual([]);
  });

  it("연결된 환자가 일반인 계정이면 403", async () => {
    users["u-patient"] = { consentedAt: new Date(), screeningMode: "general" };
    consents["u-patient"] = ["voiceprint"];
    const r = await post({ action: "enroll", embedding: EMB, targetUserId: "u-patient" });
    expect(r.status).toBe(403);
    expect(writes).toEqual([]);
  });

  it("환자 본인의 목소리 등록 동의가 없으면 대신 등록할 수 없다", async () => {
    users["u-patient"] = { consentedAt: new Date(), screeningMode: "user" };
    // 전문가 자신에게 동의가 있어도 소용없다 — 대상자 본인의 동의를 본다
    consents["u-pro"] = ["voiceprint"];
    const r = await post({ action: "enroll", embedding: EMB, targetUserId: "u-patient" });
    expect(r.status).toBe(403);
    expect(r.body.needVoiceprintConsent).toBe(true);
    expect(writes).toEqual([]);
  });

  it("동의한 어르신 환자는 등록된다", async () => {
    users["u-patient"] = { consentedAt: new Date(), screeningMode: "user" };
    consents["u-patient"] = ["voiceprint"];
    const r = await post({ action: "enroll", embedding: EMB, targetUserId: "u-patient" });
    expect(r.status).toBe(200);
  });
});

describe("삭제는 언제나 허용", () => {
  it("미동의여도 reset(전부 삭제)은 된다 — 지울 권리는 동의와 무관하다", async () => {
    users["u-elder"].consentedAt = null;
    const r = await post({ action: "reset" });
    expect(r.status).toBe(200);
    expect(writes.filter((w) => w.sql.startsWith("DELETE FROM")).length).toBe(2);
  });
});

describe("진입 링크 — 서버가 받는 계정에만 보인다", () => {
  it("마이페이지의 /voiceprint 링크는 어르신(user) 계정 조건 안에 있다", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("app/mypage/page.tsx", "utf-8");
    const at = src.indexOf('href="/voiceprint"');
    expect(at).toBeGreaterThan(-1);
    // 🔒 조건이 빠지면 보호자·전문가·일반인이 30초 낭독을 마친 **뒤에** 403을 받는다(위 '본인 등록' 참조)
    const before = src.slice(Math.max(0, at - 400), at);
    expect(before).toMatch(/\{screeningMode === "user" && \(\s*<Link\s*$/);
  });
});

describe("성문 벡터 조회 — 본인에게만 (2026-10-06 재검토)", () => {
  it("연결된 전문가는 환자의 등록 여부만 보고 벡터는 받지 않는다", async () => {
    rep["u-elder"] = sealEmbedding(unit(EMB));
    session = { user: { id: "u-pro", screeningMode: "pro" } };
    const r = await get("?targetUserId=u-elder&withEmbedding=1");
    expect(r.status).toBe(200);
    expect(r.body.enrolled).toBe(true);
    // 🔒 생체정보 최소 제공 — 쓰는 화면이 없는데도 벡터를 그대로 내주던 길
    expect(r.body.embedding).toBeUndefined();
    // 대리 화면은 환자 동의 여부로 안내 문구를 고른다
    expect(r.body.voiceprintConsent).toBe(true);
  });
});
