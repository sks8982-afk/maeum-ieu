/**
 * 위급 알림 모듈들(lib/chat/emergency-notify*)이 함께 쓰는 모양과 상수 — 2026-10-07 7차에 emergency-notify.ts에서 그대로 옮겼다.
 *   NotifyPayload는 호출부의 공개 모양이라 lib/chat/emergency-notify가 다시 내보낸다(호출부는 그 경로를 쓴다).
 */

export interface NotifyPayload {
  userId: string;
  userName: string;
  /** 발송 시각 마킹 대상. DB 저장이 실패한 응급 턴에서는 없을 수 있고, 그래도 발송은 진행한다 */
  messageId?: string;
  level: 2 | 3;
  category: string;
  content: string;          // 사용자 발화 원문 (요약본)
  aiReply: string;          // AI 응답 (요약본)
  createdAt: Date;
  /**
   * false면 알림에 실명 대신 호출부가 준 userName(호칭)을 쓴다. 기본은 실명(있으면).
   *   인지 변화 추세(C2)는 "실명 미사용"이 설계 규칙이다(lib/health/cognitive-alert).
   */
  realName?: boolean;
}

/**
 * 보호자 연락처 채널(메신저·이메일) 한 번의 결과(2026-10-07 4·5·6차):
 *   · "ok" — 그 주소가 받았다(받은 곳이 확인되는 채널)
 *   · "failed" — **일시 실패**: 주소가 있는데 지금 못 보냈고 다시 보내면 될 수 있다(웹훅 5xx·408·429·네트워크·시간 초과·
 *     DNS 일시 실패(EAI_AGAIN·빈 응답 등), SMTP 연결·시간 초과·4xx·모르는 오류, 발송 중 예외) → dedup 앵커를 걸지 않고(60초
 *     바닥만 — 2026-10-08 10차부터 다른 경로에서 받은 곳이 확인됐어도) 운영자에게 알린다(notifyGuardian 6·7 — sendFailed는 이것만 센다)
 *   · "failed-permanent" — **영구 실패**: 다시 보내도 같다(웹훅 4xx(408·429 제외)·리다이렉트·없는 도메인(DNS ENOTFOUND, 6차),
 *     저장된 이메일 주소가 형식 검사에 걸림 — 복호화 실패로 암호문이 남은 경우 포함, SMTP 인증 거절(EAUTH)·5xx 거절(6차 —
 *     lib/notify/email)) → 운영자 경보에는 싣되 dedup 앵커는 막지 않는다(5차 — 다시 보내도 같은 결과인데 같은 응급이 다시 감지될
 *     때마다(60초 뒤부터) 재발송·경보만 쌓이지 않게. 고칠 사람은 운영자다)
 *   · "blocked" — 영구 실패 중 **막은 웹훅 주소**(SSRF 방어 — https 아님·내부 호스트명·사설/예약 주소·URL 형식 오류, 6차). 영구 실패와
 *     똑같이 다루고(경보에 싣고 앵커는 막지 않는다) 경보에 "차단된 주소"라고 적는다 — 예전엔 "보낼 곳 없음"이라 경보가 없었다
 *   · "none" — 보낼 곳이 없다: 주소 없음, 보내는 Gmail 자격증명 미설정(설정 문제 — 인스턴스당 한 번 console.error,
 *     lib/notify/email). 로그만 남기고 실패로 세지 않는다
 */
export type ContactResult = "ok" | "failed" | "failed-permanent" | "blocked" | "none";

/**
 * 위급 알림 경로의 DB 기다림 상한(2026-10-07 7차) — DB가 멈추면(커넥션 고갈·잠금) 예전엔 그 자리에서 끝없이 기다려, 같은 응급의
 *   이메일·앱 푸시·운영자 경보까지 함께 멈췄다. 넘기면 그 일이 실패한 것과 똑같이 다룬다(lib/within-ms):
 *   · 중복 확인(isDuplicate) 3초 — 중복 아님으로 보고 보낸다(fail-open — 중복은 누락보다 낫다. 폭주는 메모리 상한이 막는다)
 *   · 보호자 연락처·연결 조회 각 5초 — 조회 실패(운영자 경보 + 앵커 없음(60초 바닥) — 10차부터 받은 곳이 확인됐어도, notifyGuardian 6)
 *   · notifiedAt 기록 5초 — 로그만(발송은 이미 끝났고 메모리 앵커는 따로 남았다). 운영자 경보는 이 기록을 기다리지 않는다
 */
export const DEDUP_LOOKUP_TIMEOUT_MS = 3000;
export const TARGET_LOOKUP_TIMEOUT_MS = 5000;
export const MARK_NOTIFIED_TIMEOUT_MS = 5000;
