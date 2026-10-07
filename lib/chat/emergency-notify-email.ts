/**
 * 위급 알림의 보호자 이메일 사본 — 2026-10-07 7차에 lib/chat/emergency-notify.ts에서 그대로 옮겼다(동작 같음).
 *   SMTP 전송과 실패 분류는 lib/notify/email, 여기선 저장된 주소(암호화)를 풀어 검사하고 결과를 ContactResult로 바꾼다.
 */
import { isEmailConfigured, isValidEmailAddress, sendEmergencyEmail } from "@/lib/notify/email";
import { decryptPII } from "@/lib/crypto";
import { withinMs } from "@/lib/within-ms";
import type { ContactResult, NotifyPayload } from "@/lib/chat/emergency-notify-shared";

/**
 * 보호자 이메일 한 통을 기다리는 상한(2026-10-07 8차). Gmail SMTP에는 시간 상한이 있지만(lib/notify/email — 연결 8 + 인사 8 + 소켓
 *   15초 ≈ 31초) 그 **앞의** DNS 조회는 덮지 않는다 — nodemailer는 자체 리졸버로 smtp.gmail.com을 찾고(기본 30초, 재시도) 연결 시계는 그
 *   뒤에야 돈다. 리졸버가 멈추면 이메일 채널이 몇 분씩 붙잡혀 응급 알림 전체(앵커·경보)가 기다렸다. 넘기면 일시 실패("failed" — 함께
 *   기다리는 notifyGuardian의 settleChannel이 "35초 안에 응답 없음"으로 남긴다). 메일은 뒤에서 이어질 수 있다(같은 응급이 다시 감지돼
 *   다시 보낸 메일과 겹쳐 한 번 더 갈 수 있다 — 중복은 누락보다 낫다).
 */
export const EMAIL_SEND_TIMEOUT_MS = 35_000;

/**
 * 이메일 사본 — 보호자 이메일(암호화 저장)로 Gmail SMTP 발송(ContactResult 주석, 2026-10-07 5·6차):
 *   보내는 Gmail 자격증명이 없으면 "none"(설정 문제 — 인스턴스당 한 번 console.error, lib/notify/email), 저장된 주소가 형식
 *   검사에 걸리면 "failed-permanent"(다시 보내도 같다). SMTP 실패는 lib/notify/email이 가른 대로(6차) — 인증 거절(EAUTH)·5xx는
 *   "failed-permanent", 연결·시간 초과·4xx·모르는 오류는 "failed"(일시 실패).
 */
export async function sendGuardianEmail(encrypted: string | null | undefined, payload: NotifyPayload, who: string, label: string): Promise<ContactResult> {
  const email = decryptPII(encrypted);
  if (!email) return "none";
  if (!isEmailConfigured()) return "none";
  /**
   * ⚠ 복호 실패를 **조용히 넘기지 않는다**(2026-10-02). 실패하면 decryptPII가 암호문을
   *   그대로 돌려주고, sendEmergencyEmail의 수신자 형식 검사가 그걸 버려 **이메일 채널이
   *   말없이 사라졌다**. ENCRYPTION_KEY 교체 때 전 보호자에게 동시에 일어난다.
   *   주소는 있는데 못 보냈다 — 다만 키가 바뀌지 않는 한 다시 해도 같으므로 영구 실패다(2026-10-07 5차: 운영자 경보에 싣고,
   *   dedup 앵커는 막지 않는다).
   */
  if (email.startsWith("enc:")) {
    console.error("[emergency-notify] 🔴 보호자 이메일 복호화 실패 — ENCRYPTION_KEY 확인 필요. 이메일 채널 사용 불가");
    return "failed-permanent";
  }
  if (!isValidEmailAddress(email)) {
    console.error("[emergency-notify] 🔴 저장된 보호자 이메일 주소 형식 오류 — 보내지 않았다(영구 실패, 보호자 연락처 확인 필요)");
    return "failed-permanent";
  }
  const sent = await withinMs(sendEmergencyEmail(email, {
    userName: who,
    level: payload.level,
    category: label,          // 메일 본문 "종류" 칸 — 코드 대신 한글 라벨
    createdAt: payload.createdAt,
  }), EMAIL_SEND_TIMEOUT_MS);   // 넘기면 reject — 호출부 settleChannel이 일시 실패로 센다(위 주석)
  if (sent === "ok") return "ok";
  return sent === "permanent" ? "failed-permanent" : "failed";
}
