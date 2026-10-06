/**
 * 성문 저장 암호화(lib/voiceprint/seal) — 생체인식정보는 암호화 저장이 의무다(안전성 확보조치 기준 제7조②7호).
 *
 * 2026-10-06 이전: 대표 성문과 모든 표본이 평문 JSONB였다. 연락처 암호화(lib/crypto)는 키가 없으면
 *   원문을 그대로 통과시키는데, 성문에 그대로 쓰면 "암호화해 저장합니다"라는 고지가 거짓이 된다.
 *   → 키가 없으면 저장 자체를 거부한다(throw).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const SAVED = process.env.ENCRYPTION_KEY;

const vec = (seed = 1) => Array.from({ length: 256 }, (_, i) => Math.sin(i + seed));

async function load() {
  vi.resetModules();   // 키를 바꿔 가며 쓰므로 모듈 상태를 새로
  return import("@/lib/voiceprint/seal");
}

beforeEach(() => { process.env.ENCRYPTION_KEY = KEY_A; });
afterEach(() => {
  if (SAVED === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = SAVED;
});

describe("암호화 저장", () => {
  it("저장값은 암호문이고, 벡터 숫자가 그대로 드러나지 않는다", async () => {
    const { sealEmbedding } = await load();
    const v = vec();
    const sealed = sealEmbedding(v);
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    // 🔒 평문 JSON이 들어가면 첫 숫자가 그대로 보인다
    expect(sealed).not.toContain(String(v[0]).slice(0, 8));
  });

  it("같은 키로 열면 원래 벡터가 나온다", async () => {
    const { sealEmbedding, openEmbedding } = await load();
    const v = vec(3);
    expect(openEmbedding(sealEmbedding(v))).toEqual(v);
  });

  it("키가 없으면 저장을 거부한다 — 평문 통과 금지", async () => {
    delete process.env.ENCRYPTION_KEY;
    const { sealEmbedding } = await load();
    // 🔒 encryptPII는 키가 없으면 원문을 돌려준다. 그대로 쓰면 고지와 달리 평문이 저장된다
    expect(() => sealEmbedding(vec())).toThrow(/ENCRYPTION_KEY/);
  });
});

describe("읽기", () => {
  it("예전 평문(배열)도 읽는다 — 정리 스크립트가 지우기 전까지의 호환", async () => {
    const { openEmbedding } = await load();
    const v = vec(5);
    expect(openEmbedding(v)).toEqual(v);
  });

  it("다른 키로 암호화된 값은 null — 엉뚱한 벡터로 대조하지 않는다", async () => {
    const { sealEmbedding } = await load();
    const sealed = sealEmbedding(vec());
    process.env.ENCRYPTION_KEY = KEY_B;
    const { openEmbedding } = await load();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(openEmbedding(sealed)).toBeNull();
  });

  it("복호화는 됐지만 벡터 형식이 아니면 null — 차원이 다른 값으로 대조하지 않는다", async () => {
    const { sealEmbedding, openEmbedding } = await load();
    expect(openEmbedding(sealEmbedding(Array.from({ length: 192 }, () => 0.1)))).toBeNull();
  });

  it.each([
    ["차원이 다른 배열", Array.from({ length: 192 }, () => 0.1)],
    ["숫자가 아닌 원소", Array.from({ length: 256 }, () => "x")],
    ["암호문이 아닌 문자열", "[0.1,0.2]"],
    ["null", null],
  ])("형식이 틀리면 null: %s", async (_label, raw) => {
    const { openEmbedding } = await load();
    expect(openEmbedding(raw)).toBeNull();
  });
});
