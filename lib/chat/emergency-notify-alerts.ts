/**
 * 위급 알림의 운영자 경보(sendOpsAlert — SMTP만 쓰므로 DB가 죽어도 닿는다) — 2026-10-07 7차에 lib/chat/emergency-notify.ts에서 그대로
 *   옮겼다(동작 같음). 어느 경보를 언제 보내는지(같은 응급에 비슷한 경보 두 통 금지)는 notifyGuardian(emergency-notify)이 정한다.
 *   보호자에게 한 건도 못 보낸 응급의 "응급 알림 실패" 경보는 사유·대상 판단과 붙어 있어 notifyGuardian 끝에 그대로 있다.
 */
import { sendOpsAlert as sendOpsAlertMail } from "@/lib/notify/email";
import { withinMs } from "@/lib/within-ms";
import { DEDUP_LOOKUP_TIMEOUT_MS, TARGET_LOOKUP_TIMEOUT_MS, type NotifyPayload } from "@/lib/chat/emergency-notify-shared";
import { DEVICE_PATH_TIMEOUT_MS, slowLookupText, type AppPushOutcome } from "@/lib/chat/emergency-notify-app-push";

/**
 * 운영자 경보 한 통을 기다리는 상한(2026-10-07 8차) — 경보는 앵커를 남긴 **뒤에** 보내 발송·dedup에는 영향이 없지만, 응급 알림 작업
 *   (호출부의 after())이 그동안 끝나지 않는다. Gmail SMTP의 시간 상한(lib/notify/email — 연결 8 + 인사 8 + 소켓 15초)은 그 앞의 DNS
 *   조회(nodemailer 자체 리졸버 — 기본 30초, 재시도)를 덮지 않아, 리졸버가 멈추면 경보 하나가 몇 분씩 붙잡았다(같은 응급에 경보가
 *   여럿이면 차례로). 넘기면 그 경보는 실패로 친다(호출부마다 .catch(() => false) — 메일은 뒤에서 이어질 수 있다).
 *   (9차) 넘겨도 같은 제목이 1시간 묶이지 않는다 — lib/notify/email은 sendMail이 성공한 뒤에만 1시간을 건다(그 전엔 60초 바닥이라,
 *   끝내 나가지 않은 경보는 다음 응급에서 다시 보낸다).
 */
const OPS_ALERT_TIMEOUT_MS = 35_000;

/** 위급 알림 경로의 운영자 경보 — lib/notify/email sendOpsAlert(같은 제목 1시간 묶음)를 시간 상한(OPS_ALERT_TIMEOUT_MS) 안에서 */
export function sendOpsAlert(subject: string, lines: string[]): Promise<boolean> {
  return withinMs(sendOpsAlertMail(subject, lines), OPS_ALERT_TIMEOUT_MS);
}

/**
 * 다시 보내는 때(2026-10-08 12차) — 재시도 큐는 없다: notifyGuardian은 **같은 응급이 다시 감지될 때만** 다시 보낸다(앵커가 없으면 60초
 *   바닥 뒤부터). 예전 경보는 다음 대화 턴에 다시 보낸다고만 적어, 다시 감지되지 않으면(대화가 끝나는 등) 빠진 사본이 끝내 가지
 *   않는다는 사실이 운영자에게 보이지 않았다. 앵커를 걸지 않았다고 적는 경보는 모두 이 말을 쓴다(__tests__/emergency-notify-lookups가
 *   이 파일과 emergency-notify.ts의 경보 문장(존댓말 "…보냅니다")이 모두 "다시 감지되면" 뒤에 오는지 본다 — 주석엔 그 문장을 그대로 쓰지 않는다).
 */
const RESEND_IF_DETECTED_AGAIN = "같은 응급이 다음 대화 턴(60초 뒤부터)에 다시 감지되면 다시 보냅니다";

/**
 * 앵커를 걸지 않은 발송의 한 줄(12차) — "위급 알림 발송 실패"·"받은 곳 미확인"·중복 확인 조회 실패 경보와 "응급 알림 실패"
 *   (notifyGuardian 끝)가 같은 말을 쓴다.
 */
export const NOT_ANCHORED_LINE = `중복 방지 기록을 남기지 않았습니다 — ${RESEND_IF_DETECTED_AGAIN}.`;

/**
 * 조회 실패·등록 휴대폰 경로 시간 초과 경보의 앵커 줄(2026-10-08 10차) — 이런 실패가 있으면 받은 곳이 확인돼도 앵커를 걸지 않는다
 *   (notifyGuardian 6 — 빠진 사본의 받는 사람도 다시 받아야 한다). 그래서 문구는 늘 "남기지 않았다"이고, 이미 받은 곳이 있었는지만 다르다.
 *   예전(9차까지)엔 받은 곳이 확인되면 "중복 방지 기록은 남겼습니다"였다 — 빠진 사본은 그 응급에 다시 가지 않았다.
 *   (12차) 다시 보내는 것은 같은 응급이 다시 감지될 때뿐이다(RESEND_IF_DETECTED_AGAIN) — 받은 곳이 있었으면 빠진 경로로 받는 보호자에게
 *   직접 확인하라고 적는다. 받은 곳이 없었을 때의 까닭도 "받은 곳이 확인되지 않아"가 아니라 빠졌거나 나갔는지 모르는 사본이다 — 앵커를
 *   막는 것은 받은 곳이 없어서가 아니라 그 사본 때문이다(받은 곳이 확인된 다른 경보와 같은 규칙). FCM 발송 시간 초과도 이 줄을 쓰므로
 *   "조회 실패"만 적지 않는다(9차 — FCM이 느렸는데 DB를 보게 하지 않는다).
 * @param whyWhenReceived 받은 곳이 확인됐을 때의 앞 절 — 어디로 갔고 무엇이 빠졌나(예: "이메일·메신저로는 전달됐지만 등록 휴대폰 사본이 빠져")
 * @param more 다시 보낼 때의 덧붙임(예: "연락처를 읽으면 이메일·메신저도 갑니다") — 없으면 생략
 * @param missing 받은 곳이 확인됐을 때 직접 확인을 부탁할 경로를 꾸미는 말 — 기본 "빠진", 등록 휴대폰 경로 시간 초과면
 *   "나갔는지 모르는"(LATE_DEVICE_MISSING — 11차: "빠져"는 등록 휴대폰을 실제로 읽지 못했을 때만)
 */
function notAnchoredLine(confirmed: boolean, whyWhenReceived: string, more = "", missing = "빠진"): string {
  return confirmed
    ? `${whyWhenReceived} 중복 방지 기록을 남기지 않았습니다 — ${RESEND_IF_DETECTED_AGAIN}(${more ? `${more}. ` : ""}이미 받은 곳은 한 번 더 받습니다). ` +
      `${missing} 경로로 받는 보호자에게는 직접 확인해 주세요.`
    : "받은 곳이 확인되지 않았고, 조회 실패(또는 등록 휴대폰 경로 시간 초과)로 빠졌거나 나갔는지 모르는 사본이 있어 중복 방지 기록을 " +
      `남기지 않았습니다 — ${RESEND_IF_DETECTED_AGAIN}${more ? `(${more})` : ""}. 보호자에게 직접 확인해 주세요.`;
}

/**
 * 등록 휴대폰 경로가 시간 상한에 걸렸을 때(조회 단계 — 2026-10-08 11차, FCM 발송 단계 — 9차)의 앵커 줄 앞 절·덧붙임(notAnchoredLine).
 *   그 경로는 뒤에서 이어져 실명 사본이 늦게라도 나갔을 수 있다 — 그래서 "빠져"가 아니라 "나갔는지 몰라"이고, 같은 응급이 다시 감지돼
 *   (60초 뒤부터) 다시 보내면 그 휴대폰에 같은 알림이 한 번 더 뜰 수 있다고 적는다. "빠져"는 등록 휴대폰을 실제로 읽지 못했을 때(조회
 *   오류 — 시간 초과 아님)만 쓴다.
 *   (12차) 직접 확인을 부탁하는 경로도 "빠진"이 아니라 "나갔는지 모르는"이다(LATE_DEVICE_MISSING).
 */
const LATE_DEVICE_WHY = "이메일·메신저로는 전달됐지만 등록 휴대폰 사본이 나갔는지 몰라";
const LATE_DEVICE_MORE = "늦게라도 나갔다면 등록 휴대폰에는 같은 알림이 두 번 갑니다";
const LATE_DEVICE_MISSING = "나갔는지 모르는";

/** 등록 휴대폰 조회 실패 경보의 까닭 줄 — 읽지 못함 / 조회가 상한 안에 안 끝남 / 조회가 상한을 거의 다 써 발송 미완(10차) */
function deviceLookupProblem(app: AppPushOutcome): string {
  if (app.devicePathTimedOut !== "lookup") {
    return "연결 계정의 등록 휴대폰을 DB에서 읽지 못했습니다(한 번 더 시도한 뒤) — 등록 휴대폰으로 가는 실명 알림은 보내지 못했습니다.";
  }
  if (app.deviceLookupMs === null) {
    return `등록 휴대폰 조회(DB)가 ${DEVICE_PATH_TIMEOUT_MS / 1000}초 안에 끝나지 않아 기다리지 않았습니다 — 등록 휴대폰으로 가는 실명 알림이 나갔는지 확인하지 못했습니다.`;
  }
  return `등록 휴대폰 조회(DB)가 ${DEVICE_PATH_TIMEOUT_MS / 1000}초 상한을 거의 다 써(${slowLookupText(app.deviceLookupMs)}) 기다리지 않았습니다 — 등록 휴대폰 ${app.devices}대로 가는 실명 알림이 나갔는지 확인하지 못했습니다(발송은 뒤에서 이어질 수 있습니다).`;
}

/**
 * 운영자 경보 — 등록 휴대폰 조회 실패(DB — 한 번 더 시도한 뒤)(2026-10-07 재검토).
 *   조회가 실패하면 실명 사본(등록 휴대폰)이 통째로 빠지고 토픽 사본만 나간다. 예전엔 로그 한 줄로 끝나 "보냄"으로 보였다 —
 *   DB 장애 하나가 등록 휴대폰 알림을 조용히 끊었다. 그래서 다른 채널 결과와 **무관하게 늘** 알린다(PUSH_TOKENS_LIVE와도 무관).
 *   제목에 레벨·분류·어르신 userId를 넣는다(5차) — sendOpsAlert는 같은 제목을 1시간 창으로 묶으므로, 빠지면 한 어르신의 경보가
 *   같은 시간대 다른 어르신의 경보를, 같은 어르신의 다른 분류·레벨 응급 경보를 삼킨다. 본문에 이름은 싣지 않는다(userId만).
 *   등록 휴대폰 경로가 **조회 단계에서** 시간 상한을 넘긴 경우(timedOut)도 같은 경보다 — 문구만 "끝나지 않아 기다리지 않았다"로 다르다.
 *   조회가 끝났어도 상한을 거의 다 써 FCM 발송에 3초도 못 남겼으면(10차 — app-push SEND_STAGE_MIN_MS) 이 경보에 "DB 조회 7.9초 + FCM
 *   발송 미완"으로 함께 적는다 — FCM만 탓하지 않는다. 발송에 3초 이상을 쓰고도 넘긴 경우는 이 경보가 아니다(alertDeviceSendTimedOut — 9차).
 *   (10차) 받은 곳이 확인돼도 앵커는 걸지 않는다 — 문구는 notAnchoredLine.
 *   (11차) 조회 단계의 시간 초과(늦은 조회 + 발송 미완 포함)면 "등록 휴대폰 사본이 빠져"라고 적지 않는다 — 경로가 뒤에서 이어져 늦게라도
 *   나갔을 수 있다(LATE_DEVICE_WHY — 같은 응급이 다시 감지돼 다시 보내면 그 휴대폰엔 두 번째 알림일 수 있다). "빠져"는 DB에서 읽지 못한 경우만.
 *   ⚠ 부유 프라미스 금지 — 호출부가 after()로 감싸 실행을 보장하는 블록 안에서 await한다.
 */
async function alertDeviceLookupFailed(p: NotifyPayload, channels: string[], confirmed: boolean, app: AppPushOutcome): Promise<void> {
  await sendOpsAlert(
    `L${p.level} 등록 휴대폰 조회 실패(DB) ${p.category} ${p.userId}`,
    [
      `레벨: L${p.level} / 분류: ${p.category}`,
      `대상 userId: ${p.userId}`,
      `보낸 경로: ${channels.join(", ") || "없음"}`,
      `메시지 기록: ${p.messageId ? p.messageId : "없음(저장 실패 또는 안전망 경로)"}`,
      `발생 시각: ${p.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
      "",
      deviceLookupProblem(app),
      "토픽 사본(가린 이름)은 조회와 상관없이 시도했습니다 — 결과는 위 '보낸 경로'(fcm-topic이면 FCM이 받아들였다).",
      app.devicePathTimedOut === "lookup"
        ? notAnchoredLine(confirmed, LATE_DEVICE_WHY, LATE_DEVICE_MORE, LATE_DEVICE_MISSING)
        : notAnchoredLine(confirmed, "이메일·메신저로는 전달됐지만 등록 휴대폰 사본이 빠져"),
      "push_device 조회(DB 연결) 상태를 확인해 주세요.",
    ],
  ).catch(() => false);   // 경보 실패가 호출부를 무너뜨리지 않게
}

/**
 * 운영자 경보 — 등록 휴대폰 **FCM 발송**이 시간 상한(DEVICE_PATH_TIMEOUT_MS)을 넘김(2026-10-07 9차).
 *   예전엔 등록 휴대폰 경로의 시간 초과를 단계와 상관없이 "등록 휴대폰 조회 실패(DB)"로 알려, DB는 멀쩡하고 FCM(접근 토큰 요청·FCM 응답)이
 *   느렸어도 운영자는 DB를 보게 됐다. 조회는 끝났으니 몇 대인지는 안다(deviceLine) — 실명 사본이 나갔는지만 모른다(발송은 뒤에서
 *   이어질 수 있다). 규칙은 조회 실패와 같다: 다른 채널 결과와 **무관하게 늘** 알리고, 앵커 없이 끝낸다 — 같은 응급이 다시 감지되면 다시
 *   보낸다(10차 — 받은 곳이 확인됐어도: 실명 사본이 나갔는지 모른다).
 *   (10차) 발송 단계가 3초 이상(app-push SEND_STAGE_MIN_MS)을 쓰고도 못 끝냈을 때만 이 경보다 — 조회가 상한을 거의 다 썼으면 조회 실패 경보.
 *   제목에 레벨·분류·어르신 userId(1시간 묶음 창이 응급마다 따로 — alertDeviceLookupFailed와 같은 이유). 본문엔 이름을 싣지 않는다.
 *   ⚠ 부유 프라미스 금지 — 호출부가 after()로 감싸 실행을 보장하는 블록 안에서 await한다.
 */
async function alertDeviceSendTimedOut(p: NotifyPayload, channels: string[], confirmed: boolean, app: AppPushOutcome): Promise<void> {
  await sendOpsAlert(
    `L${p.level} 등록 휴대폰 발송 시간 초과(FCM) ${p.category} ${p.userId}`,
    [
      `레벨: L${p.level} / 분류: ${p.category}`,
      `대상 userId: ${p.userId}`,
      `보낸 경로: ${channels.join(", ") || "없음"}`,
      deviceLine(app),
      `메시지 기록: ${p.messageId ? p.messageId : "없음(저장 실패 또는 안전망 경로)"}`,
      `발생 시각: ${p.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
      "",
      `등록 휴대폰은 읽었지만 FCM 발송이 ${DEVICE_PATH_TIMEOUT_MS / 1000}초 안에 끝나지 않아 기다리지 않았습니다 — 등록 휴대폰으로 가는 실명 알림이 나갔는지 확인하지 못했습니다(발송은 뒤에서 이어질 수 있습니다).`,
      "토픽 사본(가린 이름)은 등록 휴대폰 발송과 상관없이 따로 시도했습니다 — 결과는 위 '보낸 경로'(fcm-topic이면 FCM이 받아들였다).",
      notAnchoredLine(confirmed, LATE_DEVICE_WHY, LATE_DEVICE_MORE, LATE_DEVICE_MISSING),
      "서버의 FCM 발송(접근 토큰 요청·FCM 응답) 상태를 확인해 주세요.",
    ],
  ).catch(() => false);   // 경보 실패가 호출부를 무너뜨리지 않게
}

/**
 * 운영자 경보 — 보호자 연락처 조회 실패(DB)(2026-10-07 3차).
 *   연락처(이메일·메신저 주소)를 못 읽으면 그 두 채널이 통째로 빠진다. 예전엔 로그 한 줄로 끝났고, 토픽 사본만 나간 발송이
 *   1시간 dedup까지 걸어 DB가 돌아와도 이메일이 끝내 안 갔다. 앱 알림(토픽 사본·등록 휴대폰)은 연락처와 상관없이 나간다
 *   (연결 조회는 따로다). 그래서 다른 채널 결과와 **무관하게 늘** 알린다(PUSH_TOKENS_LIVE와도 무관).
 *   (10차) 등록 휴대폰으로 전달이 확인됐어도 앵커는 걸지 않는다 — 같은 응급이 다시 감지되면 이메일·메신저까지 다시 간다(notAnchoredLine).
 *   (2026-10-08) 앱 알림을 "그대로 보냈다"고 적지 않는다 — 보호자 연결 조회도 함께 실패했으면(linkFailed) 앱 알림도 보내지 못했다고,
 *   아니면 연락처와 상관없이 시도했다고만 적고 결과는 '보낸 경로'에 맡긴다. 예전 문구는 두 조회가 함께 실패한 응급에서 함께 간 연결
 *   조회 실패 경보("앱 알림은 보내지 못했습니다")와 엇갈렸다.
 *   제목에 레벨·분류·어르신 userId(1시간 묶음 창이 응급마다 따로 — alertDeviceLookupFailed와 같은 이유). 본문엔 이름을 싣지 않는다.
 *   ⚠ 부유 프라미스 금지 — 호출부가 after()로 감싸 실행을 보장하는 블록 안에서 await한다.
 */
async function alertContactLookupFailed(p: NotifyPayload, channels: string[], confirmed: boolean, linkFailed: boolean): Promise<void> {
  await sendOpsAlert(
    `L${p.level} 보호자 연락처 조회 실패(DB) ${p.category} ${p.userId}`,
    [
      `레벨: L${p.level} / 분류: ${p.category}`,
      `대상 userId: ${p.userId}`,
      `보낸 경로: ${channels.join(", ") || "없음"}`,
      `메시지 기록: ${p.messageId ? p.messageId : "없음(저장 실패 또는 안전망 경로)"}`,
      `발생 시각: ${p.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
      "",
      `보호자 연락처(이메일·메신저 주소)를 DB에서 읽지 못해(오류 또는 ${TARGET_LOOKUP_TIMEOUT_MS / 1000}초 안에 답 없음) 이메일·메신저(webhook) 발송은 건너뛰었습니다.`,
      linkFailed
        ? "앱 알림(토픽 사본·등록 휴대폰)도 보내지 못했습니다 — 보호자 연결 조회도 실패해 보낼 계정을 모릅니다(따로 보낸 '보호자 연결 조회 실패' 참고)."
        : "앱 알림 토픽 사본(가린 이름)과 등록 휴대폰 알림은 연락처와 상관없이 시도했습니다 — 결과는 위 '보낸 경로'(fcm-topic이면 FCM이 받아들였다).",
      notAnchoredLine(confirmed, "알림을 허용한 등록 휴대폰으로는 전달됐지만 이메일·메신저가 빠져", "연락처를 읽으면 이메일·메신저도 갑니다"),
      "users 조회(DB 연결) 상태를 확인해 주세요.",
    ],
  ).catch(() => false);   // 경보 실패가 호출부를 무너뜨리지 않게
}

/**
 * 운영자 경보 — 보호자 연결 조회 실패(DB)(2026-10-07 6차).
 *   연결(ExpertPatient)을 못 읽으면 앱 알림(등록 휴대폰 실명 사본·토픽 사본)이 통째로 빠진다 — 누구에게 보낼지 모른다. 예전엔 로그
 *   한 줄로 끝나, 이메일만 나간 발송이 그냥 "보냄"으로 보였다. 그래서 다른 채널 결과와 **무관하게 늘** 알린다(PUSH_TOKENS_LIVE와도 무관).
 *   (10차) 이메일·메신저로 전달이 확인됐어도 앵커는 걸지 않는다 — 같은 응급이 다시 감지되면 앱 알림까지 다시 간다(notAnchoredLine).
 *   (2026-10-08) 이메일·메신저를 "그대로 보냈다"고 적지 않는다 — 보호자 연락처 조회도 함께 실패했으면(contactFailed) 이메일·메신저도
 *   보내지 못했다고, 아니면 연결과 상관없이 시도했다고만 적는다(결과는 '보낸 경로' — 주소가 없거나 발송이 실패했을 수 있다).
 *   제목에 레벨·분류·어르신 userId(1시간 묶음 창이 응급마다 따로 — alertDeviceLookupFailed와 같은 이유). 본문엔 이름을 싣지 않는다.
 *   ⚠ 부유 프라미스 금지 — 호출부가 after()로 감싸 실행을 보장하는 블록 안에서 await한다.
 */
async function alertLinkLookupFailed(p: NotifyPayload, channels: string[], confirmed: boolean, contactFailed: boolean): Promise<void> {
  await sendOpsAlert(
    `L${p.level} 보호자 연결 조회 실패(DB) ${p.category} ${p.userId}`,
    [
      `레벨: L${p.level} / 분류: ${p.category}`,
      `대상 userId: ${p.userId}`,
      `보낸 경로: ${channels.join(", ") || "없음"}`,
      `메시지 기록: ${p.messageId ? p.messageId : "없음(저장 실패 또는 안전망 경로)"}`,
      `발생 시각: ${p.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
      "",
      `연결된 보호자·의사 계정을 DB에서 읽지 못해(오류 또는 ${TARGET_LOOKUP_TIMEOUT_MS / 1000}초 안에 답 없음) 앱 알림(등록 휴대폰 실명 사본·토픽 사본)은 보내지 못했습니다 — 보낼 계정을 모릅니다.`,
      contactFailed
        ? "이메일·메신저(webhook)도 보내지 못했습니다 — 보호자 연락처 조회도 실패해 주소를 모릅니다(따로 보낸 '보호자 연락처 조회 실패' 참고)."
        : "이메일·메신저(webhook)는 연결과 상관없이 시도했습니다 — 결과는 위 '보낸 경로'.",
      notAnchoredLine(confirmed, "이메일·메신저로는 전달됐지만 앱 알림이 빠져", "연결을 읽으면 앱 알림도 갑니다"),
      "ExpertPatient 조회(DB 연결) 상태를 확인해 주세요.",
    ],
  ).catch(() => false);   // 경보 실패가 호출부를 무너뜨리지 않게
}

/**
 * 운영자 경보 — 중복 확인 조회 실패(DB)(2026-10-07 8차).
 *   중복 확인(같은 응급을 1시간 안에 이미 보냈나 — message 조회)이 실패하거나 3초(DEDUP_LOOKUP_TIMEOUT_MS) 안에 답하지 않으면 중복 위험을
 *   감수하고 보낸다(fail-open — 누락보다 낫다, notifyGuardian 1). 예전엔 경고 로그 한 줄뿐이라, DB 장애 동안 중복 방지가 서버 메모리
 *   상한(인스턴스마다 따로)에만 기대고 있다는 사실을 운영자가 몰랐다. 그래서 다른 채널 결과와 **무관하게 늘** 알린다(받은 곳이 확인돼도,
 *   PUSH_TOKENS_LIVE와도 무관). 앵커 규칙은 건드리지 않는다 — 발송은 이미 나갔고 다시 보내도 전달 결과가 달라지지 않는다
 *   (notifyGuardian retryMayHelp 주석).
 *   (2026-10-08 12차) 본문은 실제 결과를 적는다(dedupOutcomeLines) — 예전엔 보낸 곳이 없어도 "보냈습니다 — 이미 보낸 응급이었다면 보호자는
 *   한 번 더 받았습니다"였고, 앵커를 걸었는지는 적지 않았다. 보낸 곳이 있어도 받았다고 단정하지 않는다("한 번 더 나갔을 수 있습니다") —
 *   토픽 사본·알림을 꺼 둔 휴대폰은 누가 받았는지 모른다.
 *   제목에 레벨·분류·어르신 userId(1시간 묶음 창이 응급마다 따로 — alertDeviceLookupFailed와 같은 이유). 본문엔 이름을 싣지 않는다.
 *   ⚠ 부유 프라미스 금지 — 호출부가 after()로 감싸 실행을 보장하는 블록 안에서 await한다.
 */
async function alertDedupLookupFailed(p: NotifyPayload, channels: string[], anchored: boolean, noTargets: boolean): Promise<void> {
  await sendOpsAlert(
    `L${p.level} 중복 확인 조회 실패(DB) ${p.category} ${p.userId}`,
    [
      `레벨: L${p.level} / 분류: ${p.category}`,
      `대상 userId: ${p.userId}`,
      `보낸 경로: ${channels.join(", ") || "없음"}`,
      `메시지 기록: ${p.messageId ? p.messageId : "없음(저장 실패 또는 안전망 경로)"}`,
      `발생 시각: ${p.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
      "",
      ...dedupOutcomeLines(channels, anchored, noTargets),
      "DB 장애가 이어지는 동안 중복 방지는 서버 메모리 상한(인스턴스마다 따로)에만 기댑니다 — 서버 인스턴스가 여럿이면 같은 응급이 그 수만큼 갈 수 있습니다.",
      "message 조회(DB 연결) 상태를 확인해 주세요.",
    ],
  ).catch(() => false);   // 경보 실패가 호출부를 무너뜨리지 않게
}

/**
 * 중복 확인 조회 실패 경보의 결과 줄(2026-10-08 12차) — 무엇을 했고, 앵커는 어떻게 됐나(한 줄). 앵커 값은 notifyGuardian이 실제로 정한
 *   것이다(보낸 곳이 있으면 6의 anchor, 없으면 끝의 onlyPermanent).
 *   · 보낸 곳 있음 — "보냈습니다 … 한 번 더 나갔을 수 있습니다"(받았다고 적지 않는다) + 1시간 창(빠진 사본 없음·영구 실패뿐) 또는 60초
 *     바닥(NOT_ANCHORED_LINE)
 *   · 보낸 곳 없음 — 모든 경로가 실패했다("응급 알림 실패"가 따로 간다) + 영구 실패뿐이면 1시간 창, 아니면 60초 바닥
 *   · 보낼 곳 없음(noTargets — 보호자 미연결·연락처 미등록, "응급 알림 대상 없음") — 앵커 줄은 적지 않는다: 그 경보처럼, 다시 보낼
 *     곳이 없다
 */
function dedupOutcomeLines(channels: string[], anchored: boolean, noTargets: boolean): string[] {
  const head = `같은 응급을 이미 보냈는지 DB에서 확인하지 못해(오류 또는 ${DEDUP_LOOKUP_TIMEOUT_MS / 1000}초 안에 답 없음) 중복 위험을 감수하고`;
  if (noTargets) return [`${head} 보내려 했지만 보낼 곳이 없었습니다(따로 보낸 '응급 알림 대상 없음' 참고).`];
  if (channels.length === 0) {
    return [
      `${head} 보내려 했지만 모든 경로가 실패했습니다(따로 보낸 '응급 알림 실패' 참고).`,
      anchored ? "실패가 모두 영구 실패라(다시 보내도 같다) 같은 응급을 1시간 동안 다시 보내지 않습니다." : NOT_ANCHORED_LINE,
    ];
  }
  return [
    `${head} 보냈습니다 — 이미 보낸 응급이었다면 같은 알림이 한 번 더 나갔을 수 있습니다.`,
    anchored ? "중복 방지 기록은 남겼습니다 — 같은 응급을 1시간 동안 다시 보내지 않습니다." : NOT_ANCHORED_LINE,
  ];
}

/** 테이블 없음 경보의 제목 — **하나로 고정**(어르신 userId 없음): sendOpsAlert가 같은 제목을 1시간에 한 번으로 묶는다 */
const DEVICE_TABLE_MISSING_SUBJECT = "push_device 테이블 없음 — scripts/ops-push-device.ts 실행 필요";

/**
 * 운영자 경보 — 위급 알림 경로에서 push_device 테이블이 없음(2026-10-07 4차).
 *   운영 스크립트보다 배포가 먼저 나가면 등록 휴대폰이 0대로 처리돼 **실명 사본이 모든 응급에서 빠진다**. 예전엔 로그 한 줄뿐이었다.
 *   어느 어르신의 일이 아니라 배포 상태라 제목을 고정한다 — 응급마다 메일이 쌓이지 않게(같은 제목은 1시간에 한 번).
 *   userId·이름은 싣지 않는다. 화면 조회(보호자 목록·연결 목록)는 계속 빈 목록으로 보인다(lib/push/devices getDevices).
 *   ⚠ 부유 프라미스 금지 — 호출부가 after()로 감싸 실행을 보장하는 블록 안에서 await한다.
 */
async function alertDeviceTableMissing(): Promise<void> {
  await sendOpsAlert(DEVICE_TABLE_MISSING_SUBJECT, [
    "위급 알림을 보내다가 등록 휴대폰 테이블(push_device)이 없는 것을 확인했습니다.",
    "등록 휴대폰 0대로 처리해 실명 알림(등록 휴대폰 사본)이 나가지 않습니다 — 토픽 사본(가린 이름)·이메일·메신저는 그대로 보냅니다.",
    "휴대폰 등록 요청도 503(준비 중)으로 거절되고 있습니다.",
    "scripts/ops-push-device.ts를 실행해 테이블을 만들어 주세요(멱등). 같은 제목의 경보는 1시간에 한 번만 보냅니다.",
  ]).catch(() => false);   // 경보 실패가 호출부를 무너뜨리지 않게
}

/**
 * 운영자 경보의 등록 휴대폰 줄 — 조회가 실패했으면 "0대"라고 적지 않는다(몇 대인지 모른다).
 *   FCM 발송에서 시간 상한을 넘겼으면(9차) 조회는 끝났다 — 읽은 대수를 적고 DB 탓으로 적지 않는다.
 *   조회가 상한을 거의 다 써 발송이 못 끝났으면(10차) 읽은 대수와 "DB 조회 7.9초 + FCM 발송 미완" — 어느 한쪽만 탓하지 않는다.
 */
function deviceLine(app: AppPushOutcome): string {
  if (app.devicePathTimedOut === "send") {
    return `연결 계정의 등록 휴대폰: ${app.devices}대(알림 허용 보고 ${app.readyDevices}대) — FCM 발송이 ${DEVICE_PATH_TIMEOUT_MS / 1000}초 안에 끝나지 않음`;
  }
  if (app.devicePathTimedOut === "lookup" && app.deviceLookupMs !== null) {
    return `연결 계정의 등록 휴대폰: ${app.devices}대(알림 허용 보고 ${app.readyDevices}대) — ${slowLookupText(app.deviceLookupMs)}(${DEVICE_PATH_TIMEOUT_MS / 1000}초 상한)`;
  }
  return app.deviceLookupFailed
    ? "연결 계정의 등록 휴대폰: 등록 휴대폰 조회 실패(DB)"
    : `연결 계정의 등록 휴대폰: ${app.devices}대(알림 허용 보고 ${app.readyDevices}대)`;
}

/**
 * "받은 곳 미확인" 경보의 까닭 줄 — 등록 휴대폰 경로가 끝나지 못했으면 그 단계(조회 실패(DB)·늦은 조회·FCM 발송 시간 초과, 9·10차 — 조회
 *   시간 초과, 11차), 아니면 앱 쪽 까닭. 조회가 상한 안에 끝나지 않았으면 "나가지 않았다"고 적지 않는다(11차 — 늦게라도 나갔을 수 있다:
 *   같은 응급의 조회 실패 경보와 같은 말이어야 한다).
 */
function unconfirmedWhy(app: AppPushOutcome): string[] {
  // 12차 — 다시 보내는 것은 같은 응급이 다시 감지될 때뿐이다(예전 줄은 다음 대화 턴에 다시 보낸다고만 적어 그 조건을 빠뜨렸다)
  const retry = NOT_ANCHORED_LINE;
  if (app.devicePathTimedOut === "send") {
    return [`등록 휴대폰 FCM 발송이 ${DEVICE_PATH_TIMEOUT_MS / 1000}초 안에 끝나지 않아 실명 알림(등록 휴대폰)이 나갔는지 확인하지 못했습니다.`, retry];
  }
  if (app.devicePathTimedOut === "lookup" && app.deviceLookupMs !== null) {
    return [`등록 휴대폰 조회(DB)가 늦어(${slowLookupText(app.deviceLookupMs)}) 실명 알림(등록 휴대폰)이 나갔는지 확인하지 못했습니다.`, retry];
  }
  if (app.devicePathTimedOut === "lookup") {
    return [`등록 휴대폰 조회(DB)가 ${DEVICE_PATH_TIMEOUT_MS / 1000}초 안에 끝나지 않아 실명 알림(등록 휴대폰)이 나갔는지 확인하지 못했습니다.`, retry];
  }
  if (app.deviceLookupFailed) {
    return ["등록 휴대폰 조회 실패(DB)로 실명 알림(등록 휴대폰)은 나가지 않았고, 받을 휴대폰이 있는지도 확인하지 못했습니다.", retry];
  }
  return [
    "보호자가 앱에서 그 계정으로 로그인한 적이 없으면 토픽 발송은 성공으로 나와도 아무도 받지 못합니다. 구버전 앱(1.0.3)은 받더라도 서버가 확인할 수 없습니다.",
    "등록 휴대폰이 있는데 알림 허용이 0대면 그 휴대폰들이 알림을 꺼 두었다고 보고한 것입니다.",
  ];
}

/**
 * 운영자 경보 — 보내긴 했지만 **받은 곳이 하나도 확인되지 않은** 응급(2026-10-07).
 *   토픽은 구독자가 0명이어도 FCM이 받아들인다. 보호자가 앱에 로그인한 적이 없으면 아무도 못 받았는데 "보냄"으로
 *   끝나고, 위의 "전 채널 실패" 경보도 울리지 않는다.
 *   ⚠ Play 배포 스위치를 켠 뒤(PUSH_TOKENS_LIVE — 1.2.0 프로덕션 단계적 출시가 100%가 된 뒤)에만 부른다 — 그 전엔 현장 앱(1.0.3)이
 *   휴대폰 등록을 몰라 모든 응급이 "미확인"이다.
 *   발송 실패가 섞였으면(일시·영구 모두) 이 경보 대신 alertSendFailed 하나만 간다(같은 응급에 비슷한 경보 두 통 금지).
 *   제목에 레벨·분류·어르신 userId(1시간 묶음 창이 응급마다 따로 — alertDeviceLookupFailed와 같은 이유). 본문엔 이름을 싣지 않는다.
 *   등록 휴대폰 조회가 실패했으면 "0대"라고 적지 않는다 — 몇 대인지 모른다. FCM 발송이 시간 상한을 넘겼으면 DB 탓으로 적지 않는다(9차).
 *   ⚠ 부유 프라미스 금지 — 호출부가 after()로 감싸 실행을 보장하는 블록 안에서 await한다.
 */
export async function alertUnconfirmedDelivery(p: NotifyPayload, channels: string[], app: AppPushOutcome): Promise<void> {
  const why = unconfirmedWhy(app);
  await sendOpsAlert(
    `L${p.level} 앱 알림 수신 기기 미확인 ${p.category} ${p.userId}`,
    [
      `레벨: L${p.level} / 분류: ${p.category}`,
      `대상 userId: ${p.userId}`,
      `보낸 경로: ${channels.join(", ")}`,
      deviceLine(app),
      `메시지 기록: ${p.messageId ? p.messageId : "없음(저장 실패 또는 안전망 경로)"}`,
      `발생 시각: ${p.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
      "",
      "앱 알림은 나갔지만 받은 휴대폰이 확인되지 않았습니다. 이메일·메신저 연락처도 없거나 보내지 못했습니다.",
      ...why,
      "보호자에게 직접 확인해 주세요.",
    ],
  ).catch(() => false);   // 경보 실패가 호출부를 무너뜨리지 않게
}

/** 영구 실패("…(영구 실패…)" — contactFailures·sendAppPush)가 섞인 경보에 붙이는 설명 — 다시 보내도 같은 결과라 고칠 곳을 알려 준다 */
const PERMANENT_NOTE =
  "'영구 실패'는 다시 보내도 같은 결과입니다 — 메신저(웹훅 4xx 응답·리다이렉트·차단된 주소·없는 도메인)·이메일(주소 형식 오류·복호화 실패·" +
  "SMTP 인증 거절·5xx 거절)은 보호자 연락처·서버 설정을, 앱 알림은 FCM 서버 자격증명·권한·APNs 설정을 확인해 주세요" +
  "(앱을 지운 휴대폰(registration-token-not-registered)은 등록에서 지웠습니다 — 보호자가 앱에 다시 로그인하면 다시 등록됩니다. " +
  "'서버 FCM 설정 없음'은 서버 로그의 [push-fcm] 🔴 줄이 까닭입니다 — 자격증명 없음·형식 오류·앱과 다른 Firebase 프로젝트).";

/** 영구 실패 항목인가 — contactFailures·sendAppPush가 "…(영구 실패…)"로 표시한다 */
export function isPermanentFailure(f: string): boolean {
  return f.includes("(영구 실패");
}

/** 실패 경로에 영구 실패가 있으면 설명 줄을 붙인다 */
export function permanentNote(failures: string[]): string[] {
  return failures.some(isPermanentFailure) ? [PERMANENT_NOTE] : [];
}

/**
 * 운영자 경보 — 보낸 곳은 있지만 받은 곳이 하나도 확인되지 않았고 **발송 실패**가 섞인 응급(2026-10-07 4·5차).
 *   예전엔 이메일이 SMTP에서 거절되거나 등록 휴대폰 발송이 일시 오류로 실패해도, 토픽 사본(받는 기기를 모른다)이나 알림 꺼진
 *   휴대폰만 받아들여지면 "보냄"으로 끝나 1시간 dedup이 걸렸다 — 실패한 사본은 그 응급에 다시 가지 않았고 아무도 몰랐다.
 *   일시 실패가 있으면 앵커 없이(60초 바닥만 — 같은 응급이 다시 감지되면(60초 뒤부터) 다시 간다) 끝내고, 영구 실패뿐이면 앵커는
 *   건다(5차 — 다시 보내도 같다). 어느 쪽이든 **늘**
 *   알린다(PUSH_TOKENS_LIVE와 무관 — 발송 실패는 앱 버전과 상관없는 사실이다). 본문은 앵커를 걸었는지(anchored)에 맞춘다.
 *   실패한 경로와 FCM 오류 코드만 싣는다 — 이름·주소·토큰은 싣지 않는다. 제목에 레벨·분류·userId(1시간 묶음 창이 응급마다 따로).
 *   "받은 곳 미확인" 경보(alertUnconfirmedDelivery)는 같은 응급에 따로 보내지 않는다 — 등록 휴대폰 줄까지 이 경보에 싣는다.
 *   보낸 곳이 아예 없으면 이 경보 대신 "응급 알림 실패" 경보 하나에 실패 경로를 싣는다(notifyGuardian 끝).
 *   ⚠ 부유 프라미스 금지 — 호출부가 after()로 감싸 실행을 보장하는 블록 안에서 await한다.
 */
export async function alertSendFailed(
  p: NotifyPayload, channels: string[], failures: string[], app: AppPushOutcome, anchored: boolean,
): Promise<void> {
  await sendOpsAlert(
    `L${p.level} 위급 알림 발송 실패 ${p.category} ${p.userId}`,
    [
      `레벨: L${p.level} / 분류: ${p.category}`,
      `대상 userId: ${p.userId}`,
      `보낸 경로: ${channels.join(", ")}`,
      `실패한 경로: ${failures.join(", ")}`,
      deviceLine(app),
      `메시지 기록: ${p.messageId ? p.messageId : "없음(저장 실패 또는 안전망 경로)"}`,
      `발생 시각: ${p.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
      "",
      "받은 곳이 확인되는 경로(알림을 허용한 등록 휴대폰·이메일·메신저)가 하나도 없고, 일부 경로는 발송에 실패했습니다.",
      anchored
        ? "실패가 모두 영구 실패라(다시 보내도 같다) 중복 방지 기록은 남겼습니다 — 같은 응급을 1시간 동안 다시 보내지 않습니다."
        : NOT_ANCHORED_LINE,
      ...permanentNote(failures),
      "보호자에게 직접 확인해 주세요.",
    ],
  ).catch(() => false);   // 경보 실패가 호출부를 무너뜨리지 않게
}

/**
 * 운영자 경보 — 받은 곳은 확인됐지만 **일시 실패**가 섞인 응급(2026-10-08 10차).
 *   예전엔 받은 곳(이메일·알림 허용 휴대폰·메신저)이 하나라도 확인되면 1시간 앵커를 걸고 경보도 없었다 — 다른 보호자의 토픽 사본·
 *   등록 휴대폰 실명 사본·이메일·메신저가 일시 오류(FCM 장애·SMTP 연결·웹훅 5xx·DNS 흔들림)로 빠져도, 그 사람에겐 그 응급이 끝내
 *   다시 가지 않았고 아무도 몰랐다. 누가 받았다고 못 받은 사람의 재시도를 막으면 안 된다(조용함보다 중복).
 *   그래서 앵커 없이(60초 바닥만 — notifiedAt도 쓰지 않는다) 마치고 운영자에게 알린다 — 같은 응급이 다시 감지되면(60초 뒤부터) 다시
 *   간다(재시도 큐는 없다 — 다시 감지되지 않으면 다시 가지 않는다). 다시 보내면 이미 받은 곳도
 *   한 번 더 받는다(다음 발송은 새 alertId라 알림이 하나 더 뜬다 — 한 발송 안의 토큰·토픽 사본만 같은 alertId로 하나가 된다).
 *   영구 실패가 함께 섞였으면 이 경보에 함께 싣는다 — 같은 응급에 "일부 경로 영구 실패"를 따로 보내지 않는다(비슷한 경보 두 통 금지).
 *   실패한 경로·FCM 오류 코드만 싣는다 — 이름·주소·토큰은 싣지 않는다. 제목에 레벨·분류·userId(1시간 묶음 창이 응급마다 따로).
 *   ⚠ 부유 프라미스 금지 — 호출부가 after()로 감싸 실행을 보장하는 블록 안에서 await한다.
 */
export async function alertTransientFailures(p: NotifyPayload, channels: string[], failures: string[], app: AppPushOutcome): Promise<void> {
  await sendOpsAlert(
    `L${p.level} 위급 알림 일부 경로 일시 실패 ${p.category} ${p.userId}`,
    [
      `레벨: L${p.level} / 분류: ${p.category}`,
      `대상 userId: ${p.userId}`,
      `보낸 경로: ${channels.join(", ")}`,
      `실패한 경로: ${failures.join(", ")}`,
      deviceLine(app),
      `메시지 기록: ${p.messageId ? p.messageId : "없음(저장 실패 또는 안전망 경로)"}`,
      `발생 시각: ${p.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
      "",
      "받은 곳이 확인되는 경로(알림을 허용한 등록 휴대폰·이메일·메신저)로는 전달됐지만, 일부 경로는 일시적으로 실패했습니다.",
      "실패한 경로로 받을 분에게도 가도록 중복 방지 기록을 남기지 않았습니다 — 같은 응급이 다음 대화 턴(60초 뒤부터)에 다시 감지되면 모든 경로로 다시 보냅니다(이미 받은 곳은 한 번 더 받습니다).",
      ...permanentNote(failures),
      "실패한 경로로 받는 보호자에게는 직접 확인해 주세요.",
    ],
  ).catch(() => false);   // 경보 실패가 호출부를 무너뜨리지 않게
}

/**
 * 운영자 경보 — 받은 곳은 확인됐지만 **영구 실패**가 섞인 응급(2026-10-07 7차).
 *   예전엔 받은 곳(이메일·알림 허용 휴대폰·메신저)이 하나라도 확인되면 경보가 없었다 — 메신저 주소가 404·차단된 주소이거나, FCM 서버
 *   자격증명·권한이 틀렸거나(설정 탓 — 앱 알림이 통째로 꺼진 경우 포함), 알림을 받겠다던 휴대폰이 앱을 지웠어도, 다시 보내도 같은
 *   결과인 고장이 응급마다 조용히 되풀이됐다. 고칠 사람은 운영자다.
 *   영구 실패는 앵커를 막지 않는다(받은 곳이 확인됐다 — 1시간 창·notifiedAt). 일시 실패가 섞였으면 이 경보 대신 "일부 경로 일시 실패"
 *   하나에 영구 실패까지 싣는다(alertTransientFailures, 10차 — 그때는 앵커도 걸지 않는다).
 *   (2026-10-08 11차) 본문은 앵커를 실제로 걸었는지(anchored — notifyGuardian 6)에 맞춘다. 같은 응급에 조회 실패(등록 휴대폰·보호자
 *   연락처·연결)나 등록 휴대폰 경로 시간 초과가 있으면 그것 때문에 앵커가 없다(같은 응급이 다시 감지되면 60초 뒤부터 다시 간다). 예전엔 늘 "중복 방지 기록은
 *   남겼습니다"라, 함께 간 조회 실패 경보("남기지 않았습니다")와 엇갈렸다.
 *   제목에 레벨·분류·어르신 userId — 같은 고장은 sendOpsAlert의 1시간 묶음으로 한 통이 되고, 받은 곳이 없는 "위급 알림 발송 실패"와
 *   제목이 달라 그 더 급한 경보의 1시간 창을 차지하지 않는다. 실패한 경로·FCM 오류 코드만 싣는다 — 이름·주소·토큰은 싣지 않는다.
 *   ⚠ 부유 프라미스 금지 — 호출부가 after()로 감싸 실행을 보장하는 블록 안에서 await한다.
 */
export async function alertPermanentFailures(
  p: NotifyPayload, channels: string[], failures: string[], app: AppPushOutcome, anchored: boolean,
): Promise<void> {
  await sendOpsAlert(
    `L${p.level} 위급 알림 일부 경로 영구 실패 ${p.category} ${p.userId}`,
    [
      `레벨: L${p.level} / 분류: ${p.category}`,
      `대상 userId: ${p.userId}`,
      `보낸 경로: ${channels.join(", ")}`,
      `실패한 경로: ${failures.join(", ")}`,
      deviceLine(app),
      `메시지 기록: ${p.messageId ? p.messageId : "없음(저장 실패 또는 안전망 경로)"}`,
      `발생 시각: ${p.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
      "",
      anchored
        ? "받은 곳이 확인되는 경로(알림을 허용한 등록 휴대폰·이메일·메신저)로 전달돼 중복 방지 기록은 남겼습니다."
        : "받은 곳이 확인되는 경로(알림을 허용한 등록 휴대폰·이메일·메신저)로는 전달됐지만, 조회 실패(또는 등록 휴대폰 경로 시간 초과 — " +
          "따로 보낸 경보)로 빠졌거나 나갔는지 모르는 사본이 있어 중복 방지 기록을 남기지 않았습니다 — 같은 응급이 다음 대화 턴(60초 뒤부터)에 " +
          "다시 감지되면 다시 보냅니다(이미 받은 곳은 한 번 더 받습니다).",
      "다만 일부 경로가 다시 보내도 같은 이유로 실패했습니다 — 고치기 전까지 다음 응급에서도 그 경로로는 가지 않습니다.",
      ...permanentNote(failures),
    ],
  ).catch(() => false);   // 경보 실패가 호출부를 무너뜨리지 않게
}

/** notifyGuardian이 직접 한 조회 중 실패한 것(오류 또는 시간 상한) — 등록 휴대폰 조회는 AppPushOutcome에 따로 있다 */
export interface LookupFailures {
  /** 중복 확인(message — 3초 상한, 8차) */
  dedup: boolean;
  /** 보호자 연락처(users — 5초 상한) */
  contact: boolean;
  /** 보호자 연결(ExpertPatient — 5초 상한) */
  link: boolean;
}

/**
 * 조회 쪽 장애 경보 — 다른 채널 결과와 무관하게 늘(중복 확인 조회 실패·등록 휴대폰 조회 실패(또는 등록 휴대폰 FCM 발송 시간 초과 — 9차)·
 *   보호자 연락처 조회 실패·보호자 연결 조회 실패·테이블 없음).
 * @param anchored notifyGuardian이 실제로 1시간 창을 걸었나(보낸 곳이 있으면 6의 anchor, 없으면 끝의 onlyPermanent) — 중복 확인 조회
 *   실패 경보가 앵커 결과를 적는다(12차). 다른 조회 실패는 늘 앵커가 없다(notAnchoredLine)
 * @param noTargets 보낸 곳도 보낼 곳도 없었다("응급 알림 대상 없음" — notifyGuardian 끝) — 중복 확인 조회 실패 경보가 "모든 경로가
 *   실패했습니다"라고 적지 않게(12차)
 */
export async function alertLookupProblems(
  p: NotifyPayload, channels: string[], confirmed: boolean, app: AppPushOutcome, lookups: LookupFailures, anchored: boolean, noTargets = false,
): Promise<void> {
  if (lookups.dedup) await alertDedupLookupFailed(p, channels, anchored, noTargets);
  if (app.devicePathTimedOut === "send") await alertDeviceSendTimedOut(p, channels, confirmed, app);
  else if (app.deviceLookupFailed) await alertDeviceLookupFailed(p, channels, confirmed, app);
  if (lookups.contact) await alertContactLookupFailed(p, channels, confirmed, lookups.link);
  if (lookups.link) await alertLinkLookupFailed(p, channels, confirmed, lookups.contact);
  if (app.deviceTableMissing) await alertDeviceTableMissing();
}
