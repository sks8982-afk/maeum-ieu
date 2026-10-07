/**
 * 위급 알림의 보호자 앱 푸시 — 등록 휴대폰(실명 사본)과 토픽(가린 이름 사본)을 늘 함께 보낸다(sendAppPush 주석).
 *   2026-10-07 7차에 lib/chat/emergency-notify.ts에서 그대로 옮겼다(동작 같음). FCM 발송은 lib/notify/push-fcm, 등록부는 lib/push/devices.
 */
import {
  FCM_NOT_CONFIGURED, sendEmergencyPush, sendEmergencyPushToTokens, thrownFailures,
  type FcmFailure, type PushPayload, type PushResult, type TokenPushResult,
} from "@/lib/notify/push-fcm";
import { deleteTokens, isMissingDeviceTable, isReadyDevice, queryDevices, type PushDevice } from "@/lib/push/devices";
import { withinMs } from "@/lib/within-ms";
import type { NotifyPayload } from "@/lib/chat/emergency-notify-shared";

/** 앱 푸시 결과 — 채널 + 운영자 경보에 실을 규모·실패 */
export interface AppPushOutcome {
  channels: string[];
  devices: number;
  readyDevices: number;
  /**
   * 등록 휴대폰 조회가 (한 번 더 해 봐도) 실패했거나 등록 휴대폰 경로가 시간 상한을 넘겼다(어느 단계든 — devicePathTimedOut) — 실명 사본이
   *   빠졌거나 나갔는지 모른다(조회 단계면 몇 대인지도 모른다). 규칙은 하나다: 운영자 경보(늘) + 앵커 없음(60초 바닥 — 2026-10-08
   *   10차부터 받은 곳이 확인됐어도)
   */
  deviceLookupFailed: boolean;
  /**
   * 그중 시간 상한(DEVICE_PATH_TIMEOUT_MS)을 넘긴 단계 — "lookup"(DB 조회 중이었거나, 조회가 상한을 거의 다 써 발송에 SEND_STAGE_MIN_MS도
   *   남지 않았다 — 10차)·"send"(조회는 일찍 끝났고 FCM 발송이 상한을 넘겼다), 넘기지 않았으면 null.
   *   운영자 경보의 제목·문구가 단계마다 다르다(2026-10-07 9차 — 예전엔 단계를 몰라, DB는 멀쩡하고 FCM이 느렸어도 "조회 실패(DB)"라고 적었다)
   */
  devicePathTimedOut: DevicePathStage | null;
  /**
   * 경로가 시간 상한에 걸렸을 때 조회가 끝나 있었으면 그 조회에 걸린 시간(ms, 경로 시작부터), 아니면 null(2026-10-08 10차).
   *   "lookup"인데 값이 있으면 늦은 조회 + 발송 미완이다 — 경보에 "DB 조회 7.8초 + FCM 발송 미완"처럼 함께 적는다(slowLookupText)
   */
  deviceLookupMs: number | null;
  /** push_device 테이블이 없다(운영 스크립트보다 배포가 먼저) — 0대로 보내고 운영자에게 알린다(alertDeviceTableMissing) */
  deviceTableMissing: boolean;
  /** 등록 휴대폰 **일시** 발송 실패 — 알림 허용·꺼짐 보고 가리지 않고 어느 휴대폰이든(pushToRegisteredDevices 주석, 8차) — 같은 응급이 다시 감지돼 다시 보내면 닿을 수 있다 */
  tokenSendFailed: boolean;
  /**
   * 토픽 **일시** 발송 실패 — **한 보호자의 사본이라도** 일시 오류로 받아들여지지 않았다(발송이 throw한 경우 포함, 2026-10-07 5·6차).
   *   5차 이전엔 하나라도 받아들여지면 실패가 아니라고 봐, 보호자 둘 중 한 명의 토픽 사본이 거절돼도 1시간 dedup이 걸려 그 사람에겐
   *   끝내 안 갔다. 영구 실패(서버 자격증명·권한 등 — push-fcm FcmFailureKind)는 여기 세지 않고 failures에만 싣는다(6차).
   *   토픽 발송이 시간 상한(TOPIC_PATH_TIMEOUT_MS)을 넘긴 것도 모든 보호자의 일시 실패다(코드 "timeout", 8차).
   */
  topicFailed: boolean;
  /**
   * 실패한 앱 푸시 경로와 FCM 오류 코드 — 운영자 경보용. 일시: "fcm(messaging/internal-error)"·"fcm-topic(1/2 messaging/internal-error)"
   *   (= 토픽 사본 2개 중 1개 거절), 영구(6차): "fcm(영구 실패 messaging/registration-token-not-registered)"·"fcm-topic(영구 실패 …)".
   *   이름·토큰은 싣지 않는다
   */
  failures: string[];
}

/** 등록 휴대폰 조회 시도 횟수 — 일시적 끊김(커넥션 재설정 등)은 바로 한 번 더 하면 대개 지나간다 */
const DEVICE_LOOKUP_ATTEMPTS = 2;

/**
 * 등록 휴대폰 경로(조회 + 발송)를 기다리는 상한(2026-10-07 3차) — DB 조회가 멈추거나(커넥션 고갈) FCM 발송이 멈추면
 *   응급 알림 전체가 그 자리에서 기다렸다. 넘기면 조회 실패로 친다(pushToRegisteredDevicesWithin).
 */
export const DEVICE_PATH_TIMEOUT_MS = 8000;

/** 등록 휴대폰 경로의 단계 — 시간 상한이 어느 단계에서 걸렸는지 운영자 경보에 적는다(9차, pushToRegisteredDevicesWithin) */
export type DevicePathStage = "lookup" | "send";

/**
 * 시간 초과를 FCM 발송 탓("send")으로 적으려면 발송 단계가 상한(DEVICE_PATH_TIMEOUT_MS) 안에서 이만큼은 써야 한다(2026-10-08 10차).
 *   왜: 9차는 조회가 끝났기만 하면 "send"로 적었다 — 조회가 7.9초 걸리고 발송엔 0.1초만 남아도 "등록 휴대폰 발송 시간 초과(FCM)"라,
 *   느린 DB를 두고 운영자가 FCM을 보게 됐다. 정상 FCM 발송(접근 토큰 + 메시지 요청)은 대개 1초 안팎이다 — 3초를 받고도 못 끝냈어야
 *   FCM 탓이다. 그보다 적게 남았으면 DB 쪽 문구에 "DB 조회 7.9초 + FCM 발송 미완"을 함께 적는다(slowLookupText).
 */
export const SEND_STAGE_MIN_MS = 3000;

/** 늦은 조회 + 발송 미완을 한 줄로(10차) — "DB 조회 7.9초 + FCM 발송 미완" */
export function slowLookupText(lookupMs: number): string {
  return `DB 조회 ${(lookupMs / 1000).toFixed(1)}초 + FCM 발송 미완`;
}

/**
 * 토픽 사본 발송을 기다리는 상한(2026-10-07 8차) — 예전엔 상한이 없었다. firebase-admin은 메시지 요청마다 15초 상한이 있지만 그 앞의
 *   접근 토큰 요청(토큰 서버 — google-auth-library, 기본 상한 없음·재시도)에는 따로 없어, 토큰 서버가 멈추면 응급 알림 전체(경보·dedup
 *   기록 포함)가 여기서 기다렸다.
 *   넘기면 그 보호자들의 토픽 사본을 **일시** 실패(코드 "timeout")로 센다 — 앵커 없이 끝내고(10차부터 받은 곳이 확인됐어도 — 같은 응급이
 *   다시 감지되면 다시 보낸다) 운영자에게 알린다. 발송은 뒤에서 이어질 수 있다(늦게라도 가면 같은 응급이 다시 감지돼 다시 보낸 사본과
 *   겹쳐 한 번 더 받을 수 있다 — 중복은 누락보다 낫다).
 *   등록 휴대폰 경로(8초 — 그 뒤 토큰 정리 2초를 더해도 10초, TOKEN_CLEANUP_TIMEOUT_MS)와 함께 출발하므로 앱 푸시 전체는 연결 조회(5초)
 *   뒤 최대 10초다(emergency-notify IN_FLIGHT_MS 예산).
 */
export const TOPIC_PATH_TIMEOUT_MS = 10_000;

/** 앱 푸시 제목·본문 — 이름만 경로마다 다르다(등록 휴대폰: 실명 · 토픽: 가린 이름) */
export function appPushPayload(p: NotifyPayload, name: string, label: string, when: string, alertId: string): PushPayload {
  return {
    title: p.level === 3 ? "🚨 즉시 응급 신호" : "⚠️ 주의 신호",
    body:
      p.level === 3
        ? `${name}님 — ${label} (${when}). 지금 바로 연락하시거나 119에 신고해주세요.`
        : `${name}님 — ${label} (${when}). 안부를 확인해주세요.`,
    level: p.level,
    category: p.category,
    createdAt: p.createdAt,
    patientId: p.userId,
    alertId,
  };
}

/**
 * 연결 계정들의 등록 휴대폰 — 실패하면 한 번 더 해 보고, 그래도 실패면 **장애로 보고한다**(lookupFailed).
 *   조회 실패는 "0대"가 아니다(2026-10-07 재검토): 예전엔 빈 목록으로 삼켜 실명 사본이 빠진 발송이 "보냄"으로 끝났다.
 *   토픽 사본은 이 조회와 상관없이 나간다(sendAppPush).
 *   테이블이 없으면(운영 스크립트보다 배포가 먼저) 장애가 아니라 0대다 — 다시 읽지 않고, 운영자 경보는 발송 뒤에 한다
 *   (tableMissing → alertDeviceTableMissing, 2026-10-07 4차 — 예전엔 로그 한 줄뿐이라 실명 사본이 계속 빠져도 몰랐다).
 */
async function loadGuardianDevices(guardianIds: string[]): Promise<{ devices: PushDevice[]; lookupFailed: boolean; tableMissing: boolean }> {
  for (let attempt = 1; attempt <= DEVICE_LOOKUP_ATTEMPTS; attempt++) {
    try {
      return { devices: await queryDevices(guardianIds), lookupFailed: false, tableMissing: false };
    } catch (e) {
      if (isMissingDeviceTable(e)) {
        console.error("[emergency-notify] 🔴 push_device 테이블 없음 — 등록 휴대폰 0대로 보낸다(실명 사본 없음, 토픽 사본은 그대로). scripts/ops-push-device.ts 실행 필요");
        return { devices: [], lookupFailed: false, tableMissing: true };
      }
      console.error(`[emergency-notify] 등록 휴대폰 조회 실패(${attempt}/${DEVICE_LOOKUP_ATTEMPTS}):`, e instanceof Error ? e.message : e);
    }
  }
  return { devices: [], lookupFailed: true, tableMissing: false };
}

/**
 * 등록 휴대폰 발송 결과 → 채널. FCM은 알림을 꺼 둔 휴대폰에도 "성공"을 돌려주므로(표시만 안 된다),
 *   알림을 허용했다고 보고한 휴대폰에 닿았을 때만 "fcm"(확인됨)으로 센다.
 */
function deviceChannel(devices: PushDevice[], r: TokenPushResult): string[] {
  if (r.sent === 0) {
    if (r.failed > 0) console.warn("[emergency-notify] 등록 휴대폰 발송 실패:", { failed: r.failed, invalid: r.invalidTokens.length });
    return [];
  }
  const ready = new Set(devices.filter(isReadyDevice).map((d) => d.token));
  return r.deliveredTokens.some((t) => ready.has(t)) ? ["fcm"] : ["fcm-muted"];
}

/** FCM 실패를 일시·영구로 나눈 것 — 일시만 dedup 앵커를 막고, 둘 다 운영자 경보에 싣는다(push-fcm FcmFailureKind) */
interface SplitFailures {
  transient: FcmFailure[];
  /** 토큰 탓("token" — 없는 기기·다른 프로젝트 토큰)·설정 탓("config" — 서버 자격증명·권한·APNs·메시지 모양) */
  permanent: FcmFailure[];
}

const NO_FAILURES: SplitFailures = { transient: [], permanent: [] };

function splitFailures(failures: FcmFailure[]): SplitFailures {
  return { transient: failures.filter((f) => f.kind === "transient"), permanent: failures.filter((f) => f.kind !== "transient") };
}

/** 앱을 지운 휴대폰 정리 — 실패해도 발송 결과는 그대로(다음 발송 때 다시 걸러진다). reject하지 않는다 */
async function dropInvalidTokens(tokens: string[]): Promise<void> {
  if (tokens.length === 0) return;
  try {
    await deleteTokens(tokens);
  } catch (e) {
    console.error("[emergency-notify] 쓸 수 없는 토큰 삭제 실패:", e instanceof Error ? e.message : e);
  }
}

/** 정리할 것이 없다(휴대폰 0대·시간 상한) — 기다릴 것이 없는 정리 */
const NO_CLEANUP: Promise<void> = Promise.resolve();

/**
 * 쓸 수 없는 토큰 정리를 기다리는 상한(2026-10-07 9차) — 정리(DB 삭제)는 발송 결과와 상관없다. 예전엔 등록 휴대폰 경로(8초 상한) **안에서**
 *   정리를 기다려, 삭제 쿼리가 멈추면(커넥션 고갈·잠금) 이미 받은 휴대폰("fcm")과 영구 실패(없는 기기)까지 버리고 "등록 휴대폰 조회
 *   실패(DB)"로 바뀌었다 — 받은 곳이 확인된 응급이 앵커 없이 다시 나가고, 고칠 것(앱을 지운 휴대폰)은 경보에서 빠졌다.
 *   이제 결과는 FCM 응답으로 먼저 정하고(pushToRegisteredDevices), 정리는 그 경로가 끝난 **뒤에** 이 상한 안에서만 기다린다(awaitTokenCleanup).
 *   기다리는 까닭은 응급 알림 작업(호출부의 after()) 안에서 끝나게 하려는 것뿐이다(부유 프라미스 금지).
 */
const TOKEN_CLEANUP_TIMEOUT_MS = 2000;

/** 토큰 정리를 상한(TOKEN_CLEANUP_TIMEOUT_MS) 안에서 기다린다 — 넘기면 로그만 남기고 그만 기다린다(지우지 못한 토큰은 다음 발송 때 다시 걸러진다) */
async function awaitTokenCleanup(cleanup: Promise<void>): Promise<void> {
  try {
    await withinMs(cleanup, TOKEN_CLEANUP_TIMEOUT_MS);
  } catch {
    // cleanup(dropInvalidTokens)은 reject하지 않는다 — 여기서 걸리는 것은 상한을 넘긴 것뿐이다
    console.error(`[emergency-notify] 쓸 수 없는 토큰 정리가 ${TOKEN_CLEANUP_TIMEOUT_MS / 1000}초 안에 끝나지 않음 — 그만 기다린다(발송 결과는 그대로)`);
  }
}

/**
 * 등록 휴대폰 경로의 결과 — timedOut(단계)이면 lookupFailed도 켠다(같은 규칙: 운영자 경보 + 앵커 없음 — 10차부터 받은 곳이 확인됐어도).
 *   cleanup은 앱을 지운 휴대폰 정리(dropInvalidTokens) — 결과에 넣지 않고 따로 돌려준다(9차, TOKEN_CLEANUP_TIMEOUT_MS 주석).
 */
interface DevicePathOutcome {
  devices: PushDevice[];
  lookupFailed: boolean;
  timedOut: DevicePathStage | null;
  /** 시간 상한에 걸렸을 때 조회에 걸린 시간(조회가 끝나 있었으면 — AppPushOutcome.deviceLookupMs), 아니면 null */
  lookupMs: number | null;
  tableMissing: boolean;
  channels: string[];
  /** 등록 휴대폰 **모두**의 발송 실패 — 일시·영구(pushToRegisteredDevices 주석) */
  failed: SplitFailures;
  cleanup: Promise<void>;
}

/**
 * 등록 휴대폰 사본 — 조회(한 번 더 시도) → 실명으로 발송 → 앱을 지운 휴대폰 정리.
 *   휴대폰마다 그 휴대폰을 등록한 계정을 함께 넘긴다 — 토큰 사본의 data.to(받는 계정 토픽 이름)가 된다(5차, lib/notify/push-fcm).
 *   발송 실패(2026-10-07 4·5·6·8차)는 **모든 휴대폰**의 것을 일시·영구로 나눠 센다(push-fcm FcmFailureKind):
 *   · 일시(FCM 장애·한도·네트워크) — 같은 응급이 다시 감지돼 다시 보내면 닿을 수 있다 → dedup 앵커를 막는다(10차부터 받은 곳이 확인됐어도).
 *   · 영구 — "없는 기기"(앱을 지웠거나 다시 설치했다 — 그 토큰은 이미 지웠다, dropInvalidTokens)·다른 프로젝트 토큰·서버 자격증명·
 *     권한: 다시 보내도 같다 → 앵커는 막지 않고, 받은 곳이 확인됐어도 운영자 경보에 싣는다(6·7차).
 *   (8차) 알림을 꺼 뒀다고 보고한 휴대폰의 실패도, 다른 휴대폰이 받았어도 센다. 예전엔 알림 허용 휴대폰이 하나도 닿지 않았을 때 그
 *   휴대폰들의 실패만 셌다 — 그런데 꺼진 휴대폰도 앱이 FCM 핸들러에서 직접 경보음·화면을 띄우므로(알림 권한·채널과 상관없이 —
 *   MaeumApp index.js) 사실상 받는 휴대폰이고, 한 보호자의 휴대폰이 닿았다고 **다른 보호자**의 죽은 토큰·발송 실패가 묻히면 안 된다.
 *   받은 곳 확인("fcm")은 그대로 알림 허용 휴대폰에 닿았을 때뿐이다(deviceChannel).
 *   발송 자체가 throw했으면 모든 휴대폰이 그 오류 하나의 분류를 받는다(push-fcm thrownFailures — 8차: 예전엔 늘 일시).
 *   (9차) 결과(채널·실패)는 FCM 응답만으로 정하고 바로 돌려준다 — 앱을 지운 휴대폰 정리는 기다리지 않고 cleanup으로 따로 넘긴다
 *   (sendAppPush가 이 경로의 시간 상한 밖에서 기다린다 — TOKEN_CLEANUP_TIMEOUT_MS 주석). 발송에 들어가기 직전 onSend로 읽은 휴대폰을
 *   알린다 — 시간 상한이 걸리면 그 단계를 가른다(pushToRegisteredDevicesWithin).
 */
async function pushToRegisteredDevices(
  guardianIds: string[], full: PushPayload, onSend: (devices: PushDevice[]) => void,
): Promise<DevicePathOutcome> {
  const { devices, lookupFailed, tableMissing } = await loadGuardianDevices(guardianIds);
  const base = { devices, lookupFailed, timedOut: null, lookupMs: null, tableMissing };
  if (devices.length === 0) return { ...base, channels: [], failed: NO_FAILURES, cleanup: NO_CLEANUP };
  onSend(devices);
  const r = await sendEmergencyPushToTokens(devices, full);
  return { ...base, channels: deviceChannel(devices, r), failed: splitFailures(r.failures), cleanup: dropInvalidTokens(r.invalidTokens) };
}

/**
 * 등록 휴대폰 경로에 시간 상한(DEVICE_PATH_TIMEOUT_MS) — 넘기면 끝까지 기다리지 않고 **실패로 친다**: 운영자 경보 + dedup 앵커 없음
 *   (10차부터 받은 곳이 확인됐어도 — 같은 응급이 다시 감지되면 다시 보낸다).
 *   멈췄던 경로가 늦게라도 실명 사본을 보낼 수 있다 — 중복은 누락보다 낫다. 토픽 사본은 이 상한과 무관하게 따로 간다(sendAppPush).
 *   (9차) 어느 단계에서 넘겼는지 적는다 — "lookup"(DB 조회 중 — 몇 대인지 모른다)·"send"(조회는 끝났고 FCM 발송 중 — 읽은 휴대폰을
 *   싣는다). 운영자 경보가 단계마다 다르다(emergency-notify-alerts — 예전엔 FCM이 느려도 "등록 휴대폰 조회 실패(DB)"였다).
 *   (10차) 조회가 끝난 시각을 적어 두고, 발송 단계가 SEND_STAGE_MIN_MS(3초) 이상 썼을 때만 "send"(FCM 탓)다. 조회가 상한을 거의 다
 *   썼으면 "lookup"에 조회 시간(lookupMs)을 함께 넘긴다 — 경보가 FCM만 탓하지 않고 "DB 조회 7.9초 + FCM 발송 미완"으로 적는다.
 */
async function pushToRegisteredDevicesWithin(guardianIds: string[], full: PushPayload): Promise<DevicePathOutcome> {
  const startedAt = Date.now();
  /** 조회가 끝나 FCM 발송에 들어간 휴대폰들과 그 조회에 걸린 시간 — 아직 조회 중이면 null */
  let sending: { devices: PushDevice[]; lookupMs: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<DevicePathOutcome>((resolve) => {
    timer = setTimeout(() => {
      const looked: { devices: PushDevice[]; lookupMs: number } | null = sending;
      const stage: DevicePathStage = looked && DEVICE_PATH_TIMEOUT_MS - looked.lookupMs >= SEND_STAGE_MIN_MS ? "send" : "lookup";
      const where = stage === "send" ? "FCM 발송 중" : looked ? slowLookupText(looked.lookupMs) : "DB 조회 중";
      console.error(`[emergency-notify] 등록 휴대폰 경로가 ${DEVICE_PATH_TIMEOUT_MS / 1000}초 안에 끝나지 않음(${where}) — 실패로 처리`);
      resolve({
        devices: looked?.devices ?? [], lookupFailed: true, timedOut: stage, lookupMs: looked?.lookupMs ?? null, tableMissing: false,
        channels: [], failed: NO_FAILURES, cleanup: NO_CLEANUP,
      });
    }, DEVICE_PATH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      pushToRegisteredDevices(guardianIds, full, (d) => { sending = { devices: d, lookupMs: Date.now() - startedAt }; }),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 연결된 보호자가 있는데 FCM을 쓸 수 없어 앱 알림을 아예 못 보냈다 — 설정 탓 영구 실패의 경보 항목(2026-10-07 7차, sendAppPush).
 *   다시 보내도 같다(고칠 사람은 운영자 — 서버 FCM 자격증명·FCM_PROJECT_ID). 까닭(없음·형식 오류·프로젝트 불일치)은 서버 로그
 *   "[push-fcm] 🔴" 줄에 있다(인스턴스당 한 번).
 */
const FCM_OFF_FAILURE = "fcm(영구 실패 — 서버 FCM 설정 없음·사용 불가)";

/** 운영자 경보에 싣는 FCM 오류 코드(중복 없이) — 실패가 있을 때만 부른다(실패마다 코드가 있다 — 없으면 push-fcm이 "unknown") */
function codesText(failures: FcmFailure[]): string {
  return [...new Set(failures.map((f) => f.code))].join("/");
}

/**
 * 토픽 사본 — 시간 상한(TOPIC_PATH_TIMEOUT_MS, 8차) 안에서. 발송이 throw해도 그 사본만 실패로 센다 — 함께 기다리는 등록 휴대폰·
 *   이메일·메신저 결과까지 버려지지 않게(settleChannel과 같은 이유). throw한 값은 메시지별 실패와 같은 분류다(push-fcm thrownFailures,
 *   8차 — 예전엔 늘 일시 "send-error"라, 거절된 서버 자격증명도 같은 응급이 다시 감지될 때마다(60초 뒤부터) 다시 보냈다).
 *   상한을 넘기면 모든 보호자의 사본이 일시 실패(코드 "timeout")다 — 발송은 뒤에서 이어질 수 있다.
 */
async function sendTopicWithin(guardianIds: string[], masked: PushPayload): Promise<PushResult> {
  const send = sendEmergencyPush(guardianIds, masked).catch((e: unknown): PushResult => {
    console.error("[emergency-notify] 토픽 발송 중 예외 — 토픽 사본만 실패로 센다:", String(e));
    return { sent: 0, failed: guardianIds.length, failures: thrownFailures(guardianIds, e) };
  });
  // send는 reject하지 않는다(위 catch) — 여기서 걸리는 reject는 상한을 넘긴 것뿐이다
  return withinMs(send, TOPIC_PATH_TIMEOUT_MS).catch((): PushResult => {
    console.error(`[emergency-notify] 토픽 발송이 ${TOPIC_PATH_TIMEOUT_MS / 1000}초 안에 끝나지 않음 — 토픽 사본을 일시 실패로 센다(발송은 뒤에서 이어질 수 있다)`);
    return { sent: 0, failed: guardianIds.length, failures: guardianIds.map((target) => ({ target, code: "timeout", kind: "transient" })) };
  });
}

/**
 * 보호자 앱 푸시 — 등록 휴대폰(기기 토큰)과 토픽 **두 사본을 늘 함께** 보낸다(2026-10-07, 조용함보다 중복).
 *   · 토큰: 그 계정이 직접 로그인해 등록한 휴대폰이라 **실명**을 싣는다(lib/push/devices).
 *   · 토픽: 구독 권한 검사가 없어 **가린 이름**(maskName). 모든 앱이 로그인해 있는 동안 토픽 구독을 유지한다
 *     (app/RnBridge 계약) — 등록 경로가 조용히 끊겨도(등록 실패·조회 실패·토큰 유실) 이 사본은 간다.
 *   둘은 같은 alertId를 실어, 두 사본을 다 받는 휴대폰에도 알림이 하나만 남는다.
 *   두 경로는 **함께 출발한다** — 등록 휴대폰 조회가 느리거나 다시 시도하는 동안 토픽 사본이 기다리지 않게.
 *   등록 휴대폰 경로는 8초 상한이다(pushToRegisteredDevicesWithin). 토픽 사본은 10초다(sendTopicWithin — 8차, 예전엔 상한이 없었다).
 *   (9차) 앱을 지운 휴대폰 정리는 등록 휴대폰 경로가 끝난 **뒤에** 2초 상한으로 기다린다(awaitTokenCleanup) — 토픽 사본과 함께 도는
 *   동안이라 앱 푸시 전체 시간은 늘지 않는다(8 + 2 ≤ 10초).
 *   발송 실패(2026-10-07 4·5·6·8차)는 사본마다 따로, 일시·영구로 나눠 센다 — 등록 휴대폰(모든 휴대폰 — pushToRegisteredDevices)·
 *   토픽(한 보호자의 사본이라도 거절됨). 일시 실패만 tokenSendFailed·topicFailed(dedup 앵커를 막는다), 영구 실패는 경보 항목(failures)에만.
 *   (7차) FCM을 쓸 수 없어(서버 자격증명 없음·형식 오류·다른 Firebase 프로젝트 — push-fcm FCM_NOT_CONFIGURED) 연결된 보호자에게
 *   앱 알림을 아예 못 보냈으면 설정 탓 **영구 실패**(FCM_OFF_FAILURE)다. 예전엔 로그 한 줄뿐이라, 이메일이 닿으면 앱 알림이 통째로
 *   꺼져 있어도 운영자는 몰랐다.
 */
export async function sendAppPush(guardianIds: string[], full: PushPayload, masked: PushPayload): Promise<AppPushOutcome> {
  const [byDevice, byTopic] = await Promise.all([
    // 결과는 경로가 끝난(또는 상한에 걸린) 그대로 — 정리는 그 뒤에 따로, 짧은 상한 안에서만 기다린다(9차)
    pushToRegisteredDevicesWithin(guardianIds, full).then(async (d) => { await awaitTokenCleanup(d.cleanup); return d; }),
    sendTopicWithin(guardianIds, masked),
  ]);
  const channels = [...byDevice.channels];
  if (byTopic.sent > 0) channels.push("fcm-topic");
  else if (byTopic.failed > 0) console.warn("[emergency-notify] fcm failed:", byTopic);
  // 자격증명 없음 등으로 **아예 안 보낸** 경우도 남긴다 — 예전엔 연결된 보호자가 있는데도 로그가 없었다
  else if (byTopic.skipped) console.error("[emergency-notify] fcm skipped — 연결 보호자 앱으로 푸시가 나가지 않음:", byTopic.skipped);
  const device = byDevice.failed;
  // 한 보호자의 사본이라도 일시 오류로 거절됐으면 실패(5차) — 받아들여진 사본은 그 보호자 것뿐이다. 경보엔 "거절 수/보낸 수 코드"
  const topic = splitFailures(byTopic.failures);
  const topicFailed = topic.transient.length > 0;
  return {
    channels,
    devices: byDevice.devices.length,
    readyDevices: byDevice.devices.filter(isReadyDevice).length,
    deviceLookupFailed: byDevice.lookupFailed,
    devicePathTimedOut: byDevice.timedOut,
    deviceLookupMs: byDevice.lookupMs,
    deviceTableMissing: byDevice.tableMissing,
    tokenSendFailed: device.transient.length > 0,
    topicFailed,
    failures: [
      // FCM이 꺼져 있으면 두 경로 다 건너뛴다(다른 FCM 실패는 생길 수 없다) — 한 항목만
      ...(byTopic.skipped === FCM_NOT_CONFIGURED ? [FCM_OFF_FAILURE] : []),
      ...(device.transient.length > 0 ? [`fcm(${codesText(device.transient)})`] : []),
      ...(device.permanent.length > 0 ? [`fcm(영구 실패 ${codesText(device.permanent)})`] : []),
      ...(topicFailed ? [`fcm-topic(${topic.transient.length}/${guardianIds.length} ${codesText(topic.transient)})`] : []),
      ...(topic.permanent.length > 0 ? [`fcm-topic(영구 실패 ${codesText(topic.permanent)})`] : []),
    ],
  };
}
