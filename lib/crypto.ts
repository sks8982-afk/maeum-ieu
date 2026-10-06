/**
 * 민감 식별정보(연락처 PII) 앱 레벨 암호화 — AES-256-GCM.
 *
 * - 키: env ENCRYPTION_KEY (64자리 hex = 32바이트, 또는 임의 패스프레이즈 → SHA-256으로 32바이트 파생).
 * - 형식: "enc:v1:" + base64(iv(12) + tag(16) + ciphertext).
 * - 레거시 평문 호환: prefix 없는 값은 평문으로 보고 그대로 반환(기존 데이터·미설정 환경 방어).
 * - 키 미설정 시: 암호화/복호화 모두 원본 통과(개발 편의). ⚠️ 운영에선 ENCRYPTION_KEY 필수.
 *
 * 적용 대상: guardianPhone, guardianEmail 등 분석에 쓰지 않는 연락처 식별정보.
 *   (대화·인지검사 데이터는 분석에 평문 필요 → 인프라 저장암호화 + 접근통제로 보호)
 */
import crypto from "node:crypto";

const PREFIX = "enc:v1:";

/** 이 값이 암호문 형식인가 — 평문 통과(키 없음)·복호 실패(원문 반환)를 호출부가 가려낼 때 쓴다 */
export function isEncryptedPII(value: string): boolean {
  return value.startsWith(PREFIX);
}

let warnedNoKey = false;
function getKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === "production" && !warnedNoKey) {
      warnedNoKey = true;
      console.error("[crypto] ⚠️ ENCRYPTION_KEY 미설정 — 운영 환경에서 연락처 PII가 평문으로 저장됩니다. env 설정 필요.");
    }
    return null;
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  return crypto.createHash("sha256").update(raw).digest(); // 패스프레이즈 → 32바이트
}

/** 평문 → 암호문("enc:v1:..."). null/빈값/키없음은 원본 통과. */
export function encryptPII(plain: string | null | undefined): string | null {
  if (plain == null || plain === "") return plain ?? null;
  if (plain.startsWith(PREFIX)) return plain; // 이미 암호화됨(중복 암호화 방지)
  const key = getKey();
  if (!key) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

/** 암호문 → 평문. prefix 없으면 레거시 평문으로 보고 그대로 반환. 키없음/실패 시 원본 반환. */
export function decryptPII(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (!value.startsWith(PREFIX)) return value; // 레거시 평문
  const key = getKey();
  if (!key) return value;
  try {
    const buf = Buffer.from(value.slice(PREFIX.length), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    /**
     * ⚠ 복호 실패는 **조용히 넘어가면 안 된다**(2026-10-02 AWS 이전 감사 #10).
     *
     * 가장 흔한 원인은 ENCRYPTION_KEY 교체다. 그러면 저장된 보호자 연락처가 전부 복호 실패하고,
     * lib/notify/email.ts의 EMAIL_RE 가드가 "enc:v1:…" 문자열을 걸러 **응급 이메일이
     * 조용히 false로 끝난다**. 보호자는 아무 알림도 못 받고, 로그에도 원인이 안 남았다.
     *
     * 반환값은 **원본(암호문) 그대로 둔다** — null로 바꾸면 프로필 화면이 빈칸으로 보이고,
     * 사용자가 그 상태로 저장하면 **보호자 연락처가 지워진다**(조용한 데이터 손실).
     * 암호문이 보이면 최소한 "뭔가 잘못됐다"가 드러나고 재입력 유도가 된다.
     * 대신 여기서 **크게 로그를 남겨** 운영자가 원인을 찾을 수 있게 한다.
     */
    decryptFailures++;
    if (decryptFailures === 1 || decryptFailures % 50 === 0) {
      console.error(
        `[crypto] 🔴 PII 복호화 실패 ${decryptFailures}건 — ENCRYPTION_KEY가 바뀌었을 가능성이 높다. ` +
        `이 상태면 **보호자 응급 이메일이 조용히 발송되지 않는다**(수신자 형식 검사에서 버려짐). ` +
        `키를 되돌리거나, 교체가 의도였다면 기존 데이터 재암호화 마이그레이션이 필요하다.`,
      );
    }
    return value;
  }
}

/** 복호 실패 누적 — 로그 폭주 없이 "계속 실패 중"을 알리기 위한 카운터 */
let decryptFailures = 0;

/** 운영 점검용 — 복호 실패가 누적되고 있는지(0이면 정상) */
export function getDecryptFailureCount(): number {
  return decryptFailures;
}
