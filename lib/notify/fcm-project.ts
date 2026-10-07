/**
 * 서버 FCM 자격증명을 보호자 앱의 Firebase 프로젝트로 고정한다(2026-10-07 7차).
 *
 * 왜: 앱(MaeumApp)의 FCM 등록 토큰은 그 앱을 빌드한 Firebase 프로젝트에 묶여 있다. 서버가 **다른 프로젝트의** 서비스 계정으로
 *   보내면 FCM은 모든 토큰에 SENDER_ID_MISMATCH를 돌려주는데, 그 오류는 "그 토큰은 다른 프로젝트 것"이라는 뜻이라 등록에서
 *   지운다(lib/notify/push-fcm classifyFcmError) — 자격증명 하나를 잘못 넣으면 위급 알림·목록 점검마다 모든 보호자 휴대폰 등록이
 *   지워졌다. 서버가 기대 프로젝트가 아닌 서비스 계정을 아예 쓰지 않으면(FCM을 끈다 — 위급 알림은 설정 탓 영구 실패로 운영자
 *   경보, lib/chat/emergency-notify) SENDER_ID_MISMATCH는 다시 "그 토큰이 다른 설정으로 빌드한 앱의 것"만 뜻한다.
 * 값의 출처: MaeumApp/android/app/google-services.json의 project_info.project_id — **id만** 옮겼다(API 키 등은 옮기지 않는다).
 *   앱을 다른 Firebase 프로젝트로 다시 빌드하면 이 값을 바꾸거나 배포 env FCM_PROJECT_ID로 덮는다.
 * 배포 점검(scripts/check-env.ts)도 같은 함수로 일치·불일치를 찍는다 — 서버와 점검이 갈리지 않게.
 * (8차) 보내는 주소(FCM 엔드포인트 projects/<id>/messages:send)도 같은 id로 고정한다 — lib/notify/push-fcm getFcmApp이 initializeApp에
 *   projectId로 넘긴다(firebase-admin은 그 값을 자격증명의 프로젝트보다 먼저 쓴다).
 */
export const EXPECTED_FCM_PROJECT_ID = "maeum-ieu-b6693";

/** 기대 프로젝트 id — env FCM_PROJECT_ID(앞뒤 공백 무시)가 있으면 그것, 없으면 EXPECTED_FCM_PROJECT_ID */
export function expectedFcmProjectId(): string {
  return process.env.FCM_PROJECT_ID?.trim() || EXPECTED_FCM_PROJECT_ID;
}

/**
 * 서비스 계정(JSON을 파싱한 값)의 프로젝트가 기대 프로젝트와 다르면 그 사유 한 줄, 같으면 null.
 *   (8차) 두 이름을 다 본다 — project_id(구글이 내려 주는 JSON)와 projectId: firebase-admin(cert)은 projectId를 **먼저** 읽고 없을 때만
 *   project_id를 쓴다. 예전엔 project_id만 봐서, 같은 JSON에 다른 projectId가 섞여 있으면 검사는 통과하고 자격증명은 다른 프로젝트
 *   것으로 돌았다. 둘 중 **하나라도 있으면**(빈 값·문자열 아닌 값 포함) 있는 값이 모두 기대와 같아야 하고, 둘 다 없어도 불일치다
 *   (어느 프로젝트인지 모른다). 다르면 다른 쪽 값(projectId 먼저)을 적는다.
 *   project_id는 비밀이 아니다(앱 번들·콘솔 주소에 보이는 식별자) — 두 id를 그대로 적는다. 키·이메일은 읽지도 않는다.
 */
export function fcmProjectMismatch(account: unknown): string | null {
  const a = typeof account === "object" && account !== null ? (account as { projectId?: unknown; project_id?: unknown }) : {};
  return projectMismatch([a.projectId, a.project_id], "서비스 계정의 Firebase 프로젝트");
}

/**
 * 이미 초기화된 firebase-admin 기본 앱의 프로젝트가 기대 프로젝트와 다르면 그 사유 한 줄, 같으면 null(2026-10-07 9차 — lib/notify/push-fcm
 *   getFcmApp이 그 앱을 다시 쓰기 전에 본다). firebase-admin이 FCM 엔드포인트의 프로젝트를 정할 때 보는 두 값 — 앱 옵션의 projectId,
 *   서비스 계정 자격증명의 projectId(utils getExplicitProjectId 순서) — 를 서비스 계정과 같은 규칙으로 본다: 있는 값이 모두 기대와 같아야
 *   하고, 둘 다 없으면 불일치다(환경 변수·메타데이터 서버로 정해질 수 있어 어느 프로젝트인지 모른다).
 */
export function fcmAppProjectMismatch(options: { projectId?: unknown; credential?: unknown }): string | null {
  const credential = typeof options.credential === "object" && options.credential !== null ? (options.credential as { projectId?: unknown }) : {};
  return projectMismatch([options.projectId, credential.projectId], "이미 초기화된 Firebase 기본 앱의 프로젝트");
}

/** 있는 id(undefined 아님)가 하나 이상이고 모두 기대 프로젝트면 null, 아니면 다른 값(projectId 쪽 먼저 — 없으면 "없음")을 적은 사유 */
function projectMismatch(candidates: unknown[], what: string): string | null {
  const ids = candidates.filter((id) => id !== undefined);
  const expected = expectedFcmProjectId();
  const wrong = ids.find((id) => id !== expected);
  if (ids.length > 0 && wrong === undefined) return null;
  return `${what}(${typeof wrong === "string" && wrong ? wrong : "없음"})가 앱의 프로젝트(${expected})와 다르다`;
}
