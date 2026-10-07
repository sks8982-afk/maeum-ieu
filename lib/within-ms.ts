/**
 * 기다림에 상한을 건다 — ms 안에 끝나지 않으면 "N초 안에 응답 없음"으로 reject한다.
 *   원래 호출(FCM·DB)은 취소되지 않고 뒤에서 계속될 수 있다 — 결과를 더 기다리지 않을 뿐이다(늦게 온 실패도 race가 받아 삼킨다).
 *
 * 쓰는 곳(2026-10-07 7차에 lib/notify/push-fcm에서 옮겼다 — 같은 규칙을 두 군데에 두지 않게):
 *   · FCM 토픽 구독·해제·등록 토큰 점검(lib/notify/push-fcm) — FCM이 멈춰도 등록·삭제·목록 응답이 끝없이 붙잡히지 않게
 *   · 위급 알림의 DB 조회·기록(lib/chat/emergency-notify) — DB 하나가 멈춰도 같은 응급의 이메일·앱 푸시·운영자 경보가 묶이지 않게
 */
export async function withinMs<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${ms / 1000}초 안에 응답 없음`)), ms);
  });
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
