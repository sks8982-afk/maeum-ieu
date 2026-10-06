/**
 * 성문(목소리 특징값) 저장 암호화 — 서버 전용(node:crypto).
 *
 * 왜: 성문은 생체인식정보(민감정보)다. 「개인정보의 안전성 확보조치 기준」 제7조②7호는 이용자의
 *   생체인식정보를 **안전한 암호 알고리즘으로 암호화해 저장**하도록 한다. 2026-10-06까지 대표 성문과
 *   모든 표본이 평문 JSONB로 저장돼 있었다(조사로 확인). 연락처 암호화(lib/crypto.ts, AES-256-GCM,
 *   ENCRYPTION_KEY)를 그대로 쓴다 — 키는 Vercel Production·Preview에 이미 있다.
 *
 * 저장 형식: JSONB 칸에 **JSON 문자열** "enc:v1:…"(벡터 JSON을 암호화한 것). 칸 타입은 그대로 둔다.
 * 읽기: 문자열이면 복호화, 배열이면 예전 평문(호환 — 운영 정리 스크립트가 지우기 전까지).
 */
import { encryptPII, decryptPII, isEncryptedPII } from "@/lib/crypto";
import { VOICEPRINT_DIM } from "@/lib/voiceprint/constants";

function isVector(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === VOICEPRINT_DIM && v.every((x) => typeof x === "number" && Number.isFinite(x));
}

/**
 * 벡터 → 암호문. 키가 없으면 **throw** — 연락처와 달리 평문 통과를 허용하지 않는다.
 *   (encryptPII는 키가 없으면 원문을 그대로 돌려준다. 그대로 쓰면 고지와 달리 평문이 저장된다.)
 */
export function sealEmbedding(vec: number[]): string {
  const sealed = encryptPII(JSON.stringify(vec));
  if (!sealed || !isEncryptedPII(sealed)) {
    throw new Error("ENCRYPTION_KEY 미설정 — 성문을 평문으로 저장하지 않는다");
  }
  return sealed;
}

/** 저장값 → 벡터. 복호 실패·형식 오류면 null(호출부가 "읽을 수 없음"으로 처리) */
export function openEmbedding(raw: unknown): number[] | null {
  if (isVector(raw)) return raw;                       // 예전 평문
  if (typeof raw !== "string" || !isEncryptedPII(raw)) return null;
  const plain = decryptPII(raw);
  if (!plain || isEncryptedPII(plain)) return null;     // 키 없음·키 불일치(decryptPII는 실패 시 원문을 돌려준다)
  try {
    const v: unknown = JSON.parse(plain);
    return isVector(v) ? v : null;
  } catch {
    return null;
  }
}
