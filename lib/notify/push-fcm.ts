/**
 * FCM(Firebase Cloud Messaging) 푸시 발송 — 보호자 앱(RN WebView)으로 위급 알림.
 *
 * 두 경로(2026-10-07) — 보호자·의사 계정마다 **늘 둘 다** 보낸다(조용함보다 중복):
 *   · **기기 토큰**(sendEmergencyPushToTokens) — 앱 1.2.0+가 로그인한 계정으로 등록한 휴대폰(lib/push/devices).
 *     등록은 그 계정의 세션만 할 수 있어 실명을 실어도 된다. 기기별 오류로 앱을 지운 휴대폰을 알아낸다.
 *   · **토픽**(sendEmergencyPush) — 예비 사본. 모든 앱(1.0.3·1.2.0)이 로그인해 있는 동안 자기 계정 토픽(maeum_<id>)
 *     구독을 유지한다(app/RnBridge 계약) — 등록 경로가 조용히 끊겨도(등록 실패·토큰 유실) 이 사본은 받는다.
 *     서버도 등록 요청 때 그 토큰을 계정 토픽에 구독시키고, 보호자 화면에서 휴대폰을 삭제하거나 등록 요청이 다른 계정의 행을
 *     풀어 내면(6차) 그 계정 토픽에서 해제한다(subscribeToUserTopic·unsubscribeFromUserTopic — 최선 노력). 로그아웃의 해제는
 *     앱의 토큰 폐기가 맡는다(4차).
 *     ⚠ 토픽은 구독 권한 검사가 없고(이름만 알면 누구든 받는다), 서버는 **구독한 기기가 있는지 모른다** — FCM이
 *     토픽 메시지를 받아들이면 sent로 센다(보호자가 앱에 로그인한 적이 없어도). 그래서 실명은 가려서 싣는다.
 *   같은 위급 알림은 두 사본에 **같은 alertId**(data.alertId·data.notificationId·android tag)를 싣는다 — 등록 휴대폰은
 *   두 사본을 다 받지만 알림창에는 하나만 남고(같은 tag는 대체된다) 앱도 alertId로 한 번만 울린다.
 *   토큰 사본에만 data.to = userTopic(받는 계정 id)(토픽 이름과 같은 문자열 "maeum_<id>")를 싣는다(2026-10-07 5차) — 그 사본이
 *   어느 계정 앞으로 온 것인지 앱이 안다(토픽 사본은 FCM이 받은 토픽을 알려 준다). 토픽 사본에는 없다.
 *
 * ⚠ **notification + data** 페이로드다(예전 주석의 "data-only"는 틀렸다 — 2026-10-07 추적으로 확인).
 *   앱이 백그라운드·종료 상태일 때 배너는 **OS(FCM SDK)가 notification 필드로 그린다** — 앱의
 *   백그라운드 핸들러(MaeumApp/index.js)는 소리만 내고 배너를 그리지 않는다. 그래서 notification
 *   필드를 빼서 "data-only로 고치면" 앱이 꺼져 있을 때 **배너가 사라진다**(소리 4초만). 테스트로 고정.
 *   포그라운드에서는 앱이 직접 모달·소리·진동으로 표시한다.
 *
 * 자격증명(FCM_SERVICE_ACCOUNT_B64 / FCM_SERVICE_ACCOUNT)이 없으면 발송하지 않는다 — 이때 **크게 로그**를
 *   남긴다(예전엔 아무 로그 없이 skip해, 운영에서 푸시가 꺼져 있어도 알 길이 없었다).
 *   (7차) 서비스 계정이 앱의 Firebase 프로젝트 것이 아니어도 쓰지 않는다(lib/notify/fcm-project — 자격증명 없음과 같게 다룬다).
 */

import { initializeApp, getApps, getApp, cert, type App, type ServiceAccount } from "firebase-admin/app";
import { getMessaging, type BaseMessage, type BatchResponse, type Message } from "firebase-admin/messaging";
import { expectedFcmProjectId, fcmAppProjectMismatch, fcmProjectMismatch } from "@/lib/notify/fcm-project";
import { withinMs } from "@/lib/within-ms";

/**
 * 발송하지 않은 사유 — FCM을 쓸 수 없다(자격증명 없음·형식 오류·다른 Firebase 프로젝트의 서비스 계정, getFcmApp).
 *   위급 알림은 연결된 보호자가 있는데 이 사유면 설정 탓 영구 실패로 운영자에게 알린다(2026-10-07 7차, lib/chat/emergency-notify).
 */
export const FCM_NOT_CONFIGURED = "FCM not configured";

let cachedApp: App | null | undefined;

/**
 * 서비스 계정 JSON 문자열 로드.
 * FCM_SERVICE_ACCOUNT_B64(base64, 권장 — 줄바꿈·따옴표 문제 없음) 우선,
 * 없으면 FCM_SERVICE_ACCOUNT(raw JSON, 반드시 한 줄).
 */
function loadServiceAccountJson(): string | null {
  const b64 = process.env.FCM_SERVICE_ACCOUNT_B64;
  if (b64) {
    try {
      return Buffer.from(b64, "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  return process.env.FCM_SERVICE_ACCOUNT ?? null;
}

/** 서비스 계정 env로 firebase-admin 1회 초기화. 미설정/파싱 실패/다른 Firebase 프로젝트(서비스 계정 또는 이미 있는 기본 앱 — 9차)면 null(=비활성). */
function getFcmApp(): App | null {
  if (cachedApp !== undefined) return cachedApp;
  const json = loadServiceAccountJson();
  if (!json) {
    // 결과를 캐시하므로 인스턴스당 한 번만 찍힌다(위 cachedApp 확인)
    console.error("[push-fcm] 🔴 FCM 자격증명 없음(FCM_SERVICE_ACCOUNT_B64·FCM_SERVICE_ACCOUNT) — 보호자 앱 위급 푸시가 나가지 않는다");
    cachedApp = null;
    return null;
  }
  try {
    const serviceAccount = JSON.parse(json) as ServiceAccount;
    /**
     * 앱의 Firebase 프로젝트로 고정(2026-10-07 7차, lib/notify/fcm-project) — 다른 프로젝트의 서비스 계정이면 FCM을 끈다.
     *   그 자격증명으로 보내면 모든 등록 토큰이 SENDER_ID_MISMATCH("다른 프로젝트의 토큰" — 지운다, classifyFcmError)로 돌아와
     *   보호자 휴대폰 등록이 모두 지워진다. 끄면 위급 알림은 "FCM 설정 없음"(설정 탓 영구 실패)으로 운영자 경보를 낸다.
     *   결과를 캐시하므로 이 로그도 인스턴스당 한 번이다. 프로젝트 id는 비밀이 아니다 — 키·이메일은 찍지 않는다.
     *   (9차) 기본 앱이 이미 있으면(같은 프로세스의 다른 코드가 먼저 만들었거나, 개발 서버가 이 모듈만 다시 읽었다) 그 앱을 다시 쓰기 전에
     *   그 앱의 프로젝트도 같은 규칙으로 본다(fcm-project fcmAppProjectMismatch) — 예전엔 그대로 써서, 위 검사를 통과한 서비스 계정과
     *   상관없이 그 앱의 프로젝트로 나갔다(다른 프로젝트면 SENDER_ID_MISMATCH가 보호자 휴대폰 등록을 모두 지운다). 다르면 같은 길로 끈다.
     */
    const existing = getApps().length ? getApp() : null;
    const mismatch = fcmProjectMismatch(serviceAccount) ?? (existing ? fcmAppProjectMismatch(existing.options) : null);
    if (mismatch) {
      console.error(`[push-fcm] 🔴 ${mismatch} — FCM을 끈다(보호자 앱 위급 푸시가 나가지 않는다). 그 프로젝트의 서비스 계정으로 바꾸거나 FCM_PROJECT_ID 확인`);
      cachedApp = null;
      return null;
    }
    /**
     * 보내는 주소(FCM 엔드포인트 projects/<id>/messages:send)도 앱의 프로젝트로 고정한다(2026-10-07 8차). firebase-admin은 옵션의
     *   projectId를 먼저 보고, 없으면 자격증명의 프로젝트(projectId → project_id 순)로 주소를 만든다 — 위 검사를 통과해도 주소가
     *   자격증명에서 다시 정해지지 않게 같은 값(expectedFcmProjectId)을 직접 넘긴다.
     */
    cachedApp = existing ?? initializeApp({ credential: cert(serviceAccount), projectId: expectedFcmProjectId() });
  } catch (e) {
    console.warn("[push-fcm] 서비스 계정 파싱 실패 — 푸시 비활성:", (e as Error).message);
    cachedApp = null;
  }
  return cachedApp;
}

const TOPIC_PREFIX = "maeum_";

/** userId → FCM 토픽명. FCM 허용 문자([a-zA-Z0-9-_.~%])만 남김(cuid는 그대로 통과). */
export function userTopic(userId: string): string {
  return TOPIC_PREFIX + userId.replace(/[^a-zA-Z0-9_.~%-]/g, "_");
}

export interface PushPayload {
  title: string;
  body: string;
  level: 2 | 3;
  category: string;
  sound?: string; // 앱 번들 사운드 키 (기본 "alarm")
  /** 감지 시각 — 늦게 도착한 알림도 발생 시각으로 표시되게(eventTimestamp) */
  createdAt?: Date;
  /** 어르신 userId — 앱이 알림 탭 시 해당 어르신 화면으로 열 수 있게(앱 업데이트 후 사용) */
  patientId?: string;
  /**
   * 한 번의 위급 알림을 묶는 id — data.alertId·data.notificationId·android.notification.tag로 싣는다(토큰·토픽 메시지 둘 다).
   *   앱은 로그인해 있는 동안 토픽 구독을 유지하므로(app/RnBridge 계약) 등록 휴대폰에는 **두 사본이 다 온다**.
   *   tag가 같으면 OS가 알림창에서 앞 알림을 대체하고, 앱은 포그라운드·백그라운드 모두 data.alertId로 한 번만 울린다.
   *   없으면 tag를 달지 않고 notificationId는 메시지마다 새로 만든다(알림마다 새로 쌓이는 예전 동작).
   */
  alertId?: string;
}

/**
 * FCM 발송 실패 한 건의 분류(2026-10-07 6차) — 다시 보내면 될 수 있나, 그 토큰을 지워야 하나(classifyFcmError):
 *   · "token" — **그 토큰 탓**(영구): 죽었거나(앱 삭제·재설치) 모양이 틀렸거나 다른 Firebase 프로젝트 것이다 → 등록에서 지운다
 *   · "config" — **서버 설정 탓**(영구): 서비스 계정 권한·APNs 인증·메시지 모양, 거절된 서버 자격증명(invalid_grant 등 — 8차,
 *     credentialFailureKind) → 지우지 않는다(고칠 사람은 운영자다)
 *   · "transient" — **일시**: FCM 장애·한도·네트워크(접근 토큰을 받다가 난 네트워크 오류 포함 — 8차) → 다음 턴에 다시 보내면 닿을 수 있다
 *   호출부(lib/chat/emergency-notify)는 일시 실패만 "다시 보내야 하는 실패"(dedup 앵커를 막는다)로 세고, 영구 실패는 운영자
 *   경보에만 싣는다 — 60초 뒤에 다시 보내도 같은 결과인데 매 턴 재발송·경보만 쌓이지 않게.
 */
export type FcmFailureKind = "token" | "config" | "transient";

/** 받아들여지지 않은 메시지 하나 — target은 기기 경로면 토큰, 토픽 경로면 계정 id. 운영자 경보에는 code만 싣는다 */
export interface FcmFailure {
  target: string;
  code: string;
  kind: FcmFailureKind;
}

export interface PushResult {
  sent: number;
  failed: number;
  skipped?: string; // 발송 안 한 사유 (미설정 등)
  /**
   * 받아들여지지 않은 메시지마다 받는 곳·FCM 오류 코드·분류(2026-10-07 6차 — 4차의 오류 코드 목록을 대신한다). 발송 자체가
   *   throw했으면 모든 대상이 그 오류 하나의 코드·분류다(thrownFailures — 8차부터 메시지별 실패와 같은 분류). 실패가 없으면 [].
   */
  failures: FcmFailure[];
}

export interface TokenPushResult extends PushResult {
  /** 토큰 탓 영구 실패(failures의 "token") — 호출부가 등록부에서 지운다(lib/push/devices deleteTokens) */
  invalidTokens: string[];
  /** FCM이 받아들인 토큰 — 호출부가 "알림을 띄울 수 있다고 보고한 휴대폰"에 닿았는지 가린다 */
  deliveredTokens: string[];
}

/** throw된 오류의 코드(firebase-admin 오류는 code가 있다) — 없으면 "send-error" */
function thrownCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "send-error";
}

/**
 * 발송 자체가 throw했다 — 토큰별 결과가 없어 모든 대상이 **그 오류 하나**로 실패한다. 분류는 메시지별 실패와 **같은 함수**다
 *   (classifyFcmError, 2026-10-07 8차): 예전엔 늘 일시로 셌다 — 서버 자격증명이 거절돼(invalid_grant 등) 발송이 통째로 throw해도 60초마다
 *   다시 보냈고, 받은 곳이 따로 확인되면 경보도 없었다. 네트워크 탓이면 여전히 일시다. 토큰 탓으로 나와도 지우지 않는다 — 어느 토큰
 *   탓인지 모른다(호출부 sendEmergencyPushToTokens는 이때 invalidTokens를 비운다). 토픽 발송이 throw한 경우도 이 함수다(sendEmergencyPush,
 *   lib/chat/emergency-notify-app-push).
 */
export function thrownFailures(targets: readonly string[], e: unknown): FcmFailure[] {
  const code = thrownCode(e);
  const kind = classifyFcmError(e);
  return targets.map((target) => ({ target, code, kind }));
}

/**
 * 토픽·토큰 메시지 공통 본문 — 받는 곳(topic/token)과 data.to만 다르고 나머지는 같아야 한다.
 *   두 경로가 다른 모양이면 같은 tag로 대체돼도 소리·채널이 달라진다.
 * @param fallbackId alertId가 없을 때 쓸 notificationId(메시지마다 새로)
 * @param to 토큰 사본의 받는 계정 토픽 이름(userTopic) — 토픽 사본은 넘기지 않는다(필드도 없다)
 */
function messageBody(payload: PushPayload, fallbackId: string, to?: string): BaseMessage {
  return {
    // notification 페이로드 — 앱이 종료/백그라운드여도 OS가 직접 알림 표시(앱 코드 실행 불필요).
    notification: { title: payload.title, body: payload.body },
    data: {
      title: payload.title,
      body: payload.body,
      level: String(payload.level),
      category: payload.category,
      sound: payload.sound ?? "alarm",
      // 앱 측 중복 표시 차단용 ID — 위급 알림이면 두 사본이 **같은** alertId여야 앱이 한 번만 울린다(사본마다 다르면 두 번)
      notificationId: payload.alertId ?? fallbackId,
      ...(payload.patientId ? { patientId: payload.patientId } : {}),
      ...(payload.alertId ? { alertId: payload.alertId } : {}),
      ...(to ? { to } : {}),
    },
    android: {
      priority: "high",
      notification: {
        channelId: "maeum-emergency", // 앱이 만든 HIGH 채널(소리·진동·bypassDnd). 없으면 기본 채널로 표시
        sound: payload.sound ?? "alarm",
        priority: "max",
        // 기기가 꺼져 있다 몇 시간 뒤 받아도 **발생 시각**으로 보이게 — 없으면 받은 시각이 찍혀 방금 일처럼 보인다
        ...(payload.createdAt ? { eventTimestamp: payload.createdAt } : {}),
        // 토큰·토픽 두 경로로 같은 알림이 와도 알림창에 하나만(같은 tag는 대체)
        ...(payload.alertId ? { tag: payload.alertId } : {}),
      },
    },
  };
}

/** FCM 사용 가능 여부(자격증명 설정됨) — 호출부에서 채널 표기에 활용. */
export function isFcmConfigured(): boolean {
  return getFcmApp() !== null;
}

/**
 * 보호자 userId 목록 → 각자의 토픽으로 위급 알림 발송 — **예비 사본**(가린 이름).
 *   1.0.3은 기기 등록을 모르고 토픽만 구독하고, 1.2.0도 로그인해 있는 동안 토픽 구독을 유지한다(app/RnBridge 계약).
 *   토큰 경로와 함께 늘 보낸다 — 등록이 조용히 끊긴 휴대폰도 이 사본은 받는다.
 * 실패해도 throw 안 함(LLM 응답 흐름에 영향 X).
 */
export async function sendEmergencyPush(userIds: string[], payload: PushPayload): Promise<PushResult> {
  const app = getFcmApp();
  if (!app) return { sent: 0, failed: 0, skipped: FCM_NOT_CONFIGURED, failures: [] };
  if (userIds.length === 0) return { sent: 0, failed: 0, skipped: "no targets", failures: [] };

  const messages: Message[] = userIds.map((uid) => ({
    topic: userTopic(uid),
    ...messageBody(payload, `${Date.now()}_${uid}`),
  }));

  try {
    const res = await getMessaging(app).sendEach(messages);
    if (res.failureCount > 0) {
      const firstErr = res.responses.find((r) => !r.success)?.error?.message;
      console.warn(`[push-fcm] 일부 실패 ${res.failureCount}/${messages.length}:`, firstErr);
    }
    return { sent: res.successCount, failed: res.failureCount, failures: failuresOf(userIds, res) };
  } catch (e) {
    console.warn("[push-fcm] 발송 실패:", (e as Error).message);
    return { sent: 0, failed: userIds.length, failures: thrownFailures(userIds, e) };
  }
}

/** 그 토큰이 죽었다(앱 삭제·재설치·토큰 만료 — UNREGISTERED·NOT_FOUND, 토픽 해제의 IID NOT_FOUND도 이 코드) — 언제나 토큰 탓이다 */
const UNREGISTERED = "messaging/registration-token-not-registered";

/** FCM v1 오류 상세의 형식 이름 — firebase-admin이 서버 오류 코드를 읽는 자리와 같다(messaging-errors-internal getErrorCode) */
const FCM_ERROR_TYPE = "type.googleapis.com/google.firebase.fcm.v1.FcmError";

/**
 * 분류가 보는 오류의 모양 — 메시지별 실패(firebase-admin FirebaseError: code·message·httpResponse)와 발송 자체가 throw한 값
 *   (아무 값이나 올 수 있다 — 8차부터 같은 분류를 쓴다, thrownFailures). 없는 값은 비어 있는 것으로 본다.
 */
type ErrorLike = { code?: unknown; message?: unknown; httpResponse?: { data?: unknown } };

function asErrorLike(e: unknown): ErrorLike {
  return typeof e === "object" && e !== null ? e : {};
}

/**
 * 원 응답의 FCM v1 오류 코드(예: "SENDER_ID_MISMATCH") — firebase-admin은 그걸 클라이언트 코드(mismatched-credential 등)로 바꾸면서
 *   버리지만, 오류의 httpResponse.data(서버가 보낸 JSON)에는 error.details[{ "@type": FcmError, errorCode }]로 남아 있다. 없으면 null.
 */
function fcmErrorCode(err: ErrorLike): string | null {
  const details = (err.httpResponse?.data as { error?: { details?: unknown } } | undefined)?.error?.details;
  if (!Array.isArray(details)) return null;
  for (const d of details as ({ "@type"?: unknown; errorCode?: unknown } | null)[]) {
    if (d?.["@type"] === FCM_ERROR_TYPE && typeof d.errorCode === "string") return d.errorCode;
  }
  return null;
}

/**
 * FCM 발송 오류 한 건 → 분류(FcmFailureKind, 2026-10-07 6차 — firebase-admin 14 매핑). **배치 크기·구성과 상관없이** 그 오류 하나만
 *   보고 정한다(5차의 "같은 배치에 성공이 있으면 토큰 탓"·"모두 같은 오류면 아무것도 안 지움" 추정을 걷어 냈다 — 아래 규칙이 그 경우를
 *   이미 가른다: 권한 거부·메시지 오류는 몇 대가 섞여 있어도 설정 탓이고, 죽은 토큰은 혼자 보내도 죽은 토큰이다).
 *   · 토큰 탓(지운다): registration-token-not-registered · invalid-registration-token · invalid-argument 중 **문구가 등록 토큰을
 *     가리키는 것** · mismatched-credential 중 **SENDER_ID_MISMATCH 증거**(문구 "sender id mismatch" 또는 원 응답의 FcmError
 *     errorCode)가 있는 것(다른 Firebase 프로젝트의 토큰 — 예: 다른 설정으로 빌드한 앱)
 *   · 설정 탓(지우지 않는다): 그 증거가 없는 mismatched-credential(firebase-admin은 서비스 계정 IAM의 PERMISSION_DENIED도 이 코드로
 *     바꾼다 — 5차 이전처럼 지우면 권한이 빠진 하루 동안 위급 알림·목록 점검마다 모든 보호자의 등록이 지워진다) ·
 *     third-party-auth-error(APNs 인증) · 등록 토큰 이야기가 아닌 invalid-argument(메시지 모양)
 *   · 서버 자격증명(8차): app/invalid-credential(접근 토큰을 못 받음)·messaging/authentication-error는 까닭에 따라 —
 *     credentialFailureKind
 *   · 일시(다시 보낸다): 그 밖의 모든 코드 — internal-error · server-unavailable · message-rate-exceeded(한도·QUOTA_EXCEEDED) ·
 *     unknown-error 등. 목록에 없는 코드도 일시로 본다(다시 보내 본다 — 조용함보다 중복)
 *   ⚠ SENDER_ID_MISMATCH는 배치 전체가 그 오류여도 지운다 — 그래도 되는 건 서버 자격증명이 **앱의 Firebase 프로젝트로 고정**돼
 *     있어서다(2026-10-07 7차, lib/notify/fcm-project — 다른 프로젝트의 서비스 계정이면 getFcmApp이 FCM을 끄고, 위급 알림은 설정 탓
 *     영구 실패로 운영자 경보를 낸다). 그래서 이 오류는 "그 토큰이 다른 프로젝트(다른 설정으로 빌드한 앱)의 것"만 뜻한다. 예전엔
 *     자격증명 하나를 잘못 넣으면 이 규칙이 모든 보호자 휴대폰 등록을 지웠다. 지워진 휴대폰도 앱이 로그인·복귀 때마다 다시
 *     등록하므로(app/RnBridge 계약) 돌아온다.
 *   발송 자체가 throw한 값도 이 함수로 가른다(8차 — thrownFailures).
 */
function classifyFcmError(e: unknown): FcmFailureKind {
  const err = asErrorLike(e);
  const code = typeof err.code === "string" ? err.code : "";
  const message = typeof err.message === "string" ? err.message : "";
  if (code === UNREGISTERED || code === "messaging/invalid-registration-token") return "token";
  if (code === "messaging/invalid-argument") return /registration token/i.test(message) ? "token" : "config";
  if (code === "messaging/mismatched-credential") {
    return /sender ?id mismatch/i.test(message) || fcmErrorCode(err) === "SENDER_ID_MISMATCH" ? "token" : "config";
  }
  if (code === "messaging/third-party-auth-error") return "config";
  if (code === "app/invalid-credential" || code === "messaging/authentication-error") return credentialFailureKind(message);
  return "transient";
}

/** 접근 토큰을 받으러 가다 네트워크에서 실패했다 — 토큰 서버(oauth2.googleapis.com)에 닿지 못했다 */
const NETWORK_FAILURE_RE = /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed/i;
/** 토큰 서버가 자격증명을 거절했다 — 키 폐기·서비스 계정 삭제·비활성, 서버 시계 어긋남(JWT) */
const REJECTED_CREDENTIAL_RE = /invalid_grant|invalid_client|unauthorized_client|Invalid JWT|account not found|disabled|deleted/i;

/**
 * 서버 자격증명 오류의 분류(2026-10-07 8차) — app/invalid-credential은 서버가 FCM 접근 토큰(OAuth2)을 받지 못했다는 뜻이다:
 *   firebase-admin 14는 토큰 요청 실패를 이 코드로 싸서 **메시지마다**(sendEach의 각 응답) 돌려준다 — 메시지는 원래 오류의 문구를
 *   따옴표 안에 그대로 싣는다("…failed to fetch a valid Google OAuth2 access token with the following error: \"invalid_grant: Invalid
 *   JWT Signature.\"." — node_modules/firebase-admin/lib/app/firebase-app.js FirebaseAppInternals.refreshToken. 네트워크 오류면 그 문구에
 *   시스템 오류 코드가 들어 있다: "request to https://oauth2.googleapis.com/token failed, reason: getaddrinfo ENOTFOUND …").
 *   messaging/authentication-error는 FCM이 401·403을 JSON 아닌 응답으로 돌려준 경우다. 그래서 메시지로 가른다.
 *   예전엔 둘 다 늘 일시로 셌다 — 키를 폐기했거나 서비스 계정이 지워져 **모든** 앱 알림이 실패해도 60초마다 다시 보냈고, 이메일이
 *   닿으면 경보도 없었다.
 *   · 네트워크(NETWORK_FAILURE_RE) → 일시. **먼저 본다** — 토큰 서버에 닿지 못했으면 자격증명이 거절됐는지 알 수 없다(호스트 이름·
 *     프록시 문구에 "disabled" 같은 말이 섞여도 일시다)
 *   · 거절된 자격증명(REJECTED_CREDENTIAL_RE) → 설정 탓 영구("config"): 다시 보내도 같다 — 고칠 사람은 운영자다(서비스 계정 키 교체)
 *   · 그 밖(토큰 서버 5xx·시간 초과 등) → 일시(목록에 없는 것은 다시 보내 본다 — 조용함보다 중복)
 */
function credentialFailureKind(message: string): FcmFailureKind {
  if (NETWORK_FAILURE_RE.test(message)) return "transient";
  return REJECTED_CREDENTIAL_RE.test(message) ? "config" : "transient";
}

/** 실패한 응답마다 받는 곳·코드·분류 — targets[i]가 i번째 메시지의 받는 곳(토큰 또는 계정 id) */
function failuresOf(targets: readonly string[], res: BatchResponse): FcmFailure[] {
  return res.responses.flatMap((r, i) =>
    r.success ? [] : [{ target: targets[i], code: r.error?.code ?? "unknown", kind: classifyFcmError(r.error) }]);
}

/** 등록 휴대폰 한 대 — 토큰과 그 휴대폰을 등록한 계정(lib/push/devices PushDevice가 그대로 들어온다) */
export interface PushTarget {
  token: string;
  userId: string;
}

/**
 * 등록된 휴대폰(기기 토큰)마다 위급 알림 발송 — 토픽 메시지와 같은 모양(notification·data·android), 받는 곳만 token이고
 *   data.to = userTopic(그 휴대폰을 등록한 계정)을 더한다(5차 — 휴대폰마다 받는 계정이 달라 메시지를 휴대폰마다 만든다).
 * 실패해도 throw 안 함(LLM 응답 흐름에 영향 X). 지울 토큰은 invalidTokens로 돌려준다(지우는 건 호출부).
 */
export async function sendEmergencyPushToTokens(targets: readonly PushTarget[], payload: PushPayload): Promise<TokenPushResult> {
  const none = { failures: [], invalidTokens: [], deliveredTokens: [] };
  const app = getFcmApp();
  if (!app) return { sent: 0, failed: 0, skipped: FCM_NOT_CONFIGURED, ...none };
  if (targets.length === 0) return { sent: 0, failed: 0, skipped: "no targets", ...none };

  const tokens = targets.map((t) => t.token);
  const messages: Message[] = targets.map(({ token, userId }, i) => ({
    token, ...messageBody(payload, `${Date.now()}_d${i}`, userTopic(userId)),
  }));
  try {
    const res = await getMessaging(app).sendEach(messages);
    const failures = failuresOf(tokens, res);
    const invalidTokens = failures.filter((f) => f.kind === "token").map((f) => f.target);
    if (res.failureCount > 0) {
      const firstErr = res.responses.find((r) => !r.success)?.error;
      console.warn(`[push-fcm] 기기 일부 실패 ${res.failureCount}/${messages.length} (지울 토큰 ${invalidTokens.length}):`, firstErr?.code, firstErr?.message);
    }
    return {
      sent: res.successCount,
      failed: res.failureCount,
      failures,
      invalidTokens,
      deliveredTokens: tokens.filter((_, i) => res.responses[i]?.success === true),
    };
  } catch (e) {
    console.warn("[push-fcm] 기기 발송 실패:", (e as Error).message);
    // 지우지 않는다 — 어느 토큰 탓인지 모른다(thrownFailures)
    return { sent: 0, failed: tokens.length, failures: thrownFailures(tokens, e), invalidTokens: [], deliveredTokens: [] };
  }
}

/** 등록 요청 뒤 토픽 구독을 기다리는 최대 시간 — 응답 뒤(after())에 돌지만 그 일도 끝없이 붙잡지 않는다 */
const TOPIC_SUBSCRIBE_TIMEOUT_MS = 5000;
/**
 * 보호자 화면 "삭제"의 토픽 해제를 기다리는 최대 시간 — 넉넉히(2026-10-07 4차). 삭제 응답이 이 해제가 끝난 뒤에 나가야
 *   "삭제됨"을 본 보호자의 그 휴대폰이 토픽 사본까지 실제로 멈춘다. 5초로 자르면 FCM이 잠깐 느릴 때 해제가 끝나지 않은 채
 *   "삭제됨"이 된다.
 */
const TOPIC_REVOKE_TIMEOUT_MS = 15_000;

/**
 * 휴대폰(토큰)을 그 계정의 토픽(maeum_<id>)에 **서버 쪽으로** 구독·해제 — 아래 두 함수의 몸통(자격증명·빈 목록은 그쪽에서 거른다).
 *   토픽 이름은 발송과 **같은 함수**(userTopic)로 만든다 — 다르면 엉뚱한 토픽을 다루고 성공으로 끝난다.
 *   해제에서 토큰별 "없는 기기"(IID NOT_FOUND → registration-token-not-registered)는 **이미 해제된 것**으로 본다(2026-10-07 6차) —
 *   죽은 토큰은 토픽 사본을 받을 수 없다. 예전엔 이것도 실패로 세, 앱을 지운 휴대폰은 보호자 화면에서 끝내 지울 수 없었다(502).
 *   최선 노력: ms 안에 끝나지 않거나 실패하면 로그만 남기고 false(throw 안 함 — 등록·삭제 응답을 막지 않는다).
 */
async function manageUserTopic(app: App, op: "subscribe" | "unsubscribe", tokens: string[], userId: string, ms: number): Promise<boolean> {
  const what = op === "subscribe" ? "구독" : "해제";
  try {
    const messaging = getMessaging(app);
    const topic = userTopic(userId);
    const call = op === "subscribe" ? messaging.subscribeToTopic(tokens, topic) : messaging.unsubscribeFromTopic(tokens, topic);
    const res = await withinMs(call, ms);
    // 해제의 "없는 기기"는 이미 해제된 것(위) — 그만큼은 실패로 세지 않는다
    const gone = op === "unsubscribe" ? res.errors.filter((e) => e.error?.code === UNREGISTERED) : [];
    const failed = res.failureCount - gone.length;
    if (failed > 0) {
      console.warn(`[push-fcm] 토픽 ${what} 일부 실패 ${failed}/${tokens.length}:`, res.errors.find((e) => !gone.includes(e))?.error?.code);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[push-fcm] 토픽 ${what} 실패(무시하고 진행):`, (e as Error).message);
    return false;
  }
}

/**
 * 휴대폰(토큰)을 그 계정의 토픽(maeum_<id>)에 **서버 쪽으로** 구독 — 등록 요청(app/api/push/device POST)마다, 응답 뒤에.
 *   왜(2026-10-07 3·4차): 로그인한 앱 휴대폰은 모두 maeum_<id> 구독을 유지해야 한다(조용함보다 중복 — app/RnBridge 계약).
 *   앱도 LOGIN_SUCCESS·REQUEST_PUSH_TOKEN·복귀마다 다시 구독하지만 어느 한쪽에만 기대지 않는다. 등록 행이 저장되지 않아도
 *   (테이블 없음 503·DB 실패) 구독은 한다 — 토픽 사본은 행과 상관없이 나간다. 멱등. 자격증명이 없거나 토큰이 없으면 false.
 */
export async function subscribeToUserTopic(tokens: string[], userId: string): Promise<boolean> {
  const app = getFcmApp();
  if (!app || tokens.length === 0) return false;
  return manageUserTopic(app, "subscribe", tokens, userId, TOPIC_SUBSCRIBE_TIMEOUT_MS);
}

/**
 * 토픽 해제 결과(2026-10-07 6·7차) — 호출부(app/api/push/device)가 등록 행을 지워도 되는지 가른다:
 *   · "ok" — 해제됐다(토큰별 "없는 기기"는 이미 해제된 것으로 친다 — manageUserTopic). 해제할 토큰이 없어도 "ok"
 *   · "unconfigured" — FCM을 쓸 수 없다(자격증명 없음·형식 오류·다른 Firebase 프로젝트 — getFcmApp, 로그는 인스턴스당 한 번):
 *     해제를 **확인할 수 없다**. 그 휴대폰의 구독은 FCM에 그대로 남아, 자격증명이 고쳐지는 순간(또는 자격증명이 있는 다른 배포에서)
 *     토픽 사본을 다시 받는다 — 호출부는 행을 지우지 않는다(7차: 6차는 "해제할 것도 없다"며 지웠다)
 *   · "failed" — 그 밖의 실패·시간 초과 — 그 휴대폰은 아직 토픽 사본을 받을 수 있다
 */
export type TopicRevokeResult = "ok" | "unconfigured" | "failed";

/**
 * 휴대폰(토큰)을 그 계정의 토픽(maeum_<id>)에서 **서버 쪽으로** 해제 — 보호자 화면의 휴대폰 "삭제"(app/api/push/device
 *   DELETE { handle })와, 등록 요청에서 다른 계정의 행을 풀어 낸 휴대폰(POST — 응답 뒤, 6차)의 짝. 왜: 앱은 로그인해 있는 동안
 *   토픽 구독을 유지한다(app/RnBridge 계약). 목록에서 지운 휴대폰은 그 앱이 해제를 모르므로, 등록만 지우면 그 휴대폰은 이 계정의
 *   토픽 사본(가린 이름)을 계속 받는다. 끝까지 기다린다(최대 15초). FCM을 쓸 수 없으면 "unconfigured" — 호출부는 행을 지우지 않는다(7차).
 *   ⚠ 로그아웃(DELETE { token })에는 쓰지 않는다(4차) — 로그아웃이 확인되지 않아 되살린 구독과 이 해제가 FCM에서 엇갈리면 로그인한
 *   채 토픽 사본이 빠졌다. 로그아웃한 휴대폰의 구독은 확인된 LOGOUT에서 앱이 토큰을 폐기(deleteToken)하면서 끝난다.
 */
export async function unsubscribeFromUserTopic(tokens: string[], userId: string): Promise<TopicRevokeResult> {
  const app = getFcmApp();
  if (!app) return "unconfigured";
  if (tokens.length === 0) return "ok";
  return (await manageUserTopic(app, "unsubscribe", tokens, userId, TOPIC_REVOKE_TIMEOUT_MS)) ? "ok" : "failed";
}

/** 등록 토큰 점검(dry run)을 기다리는 최대 시간 — 보호자 화면의 목록 응답을 붙잡지 않게 */
const TOKEN_CHECK_TIMEOUT_MS = 5000;

/**
 * 등록 토큰 점검(2026-10-07 4차) — FCM에 **보내지 않는 시험 발송**(dry run: sendEach(messages, true))을 해 토큰 탓으로 거절된
 *   토큰을 돌려준다(지울 토큰 판정은 실제 발송과 같은 규칙 — classifyFcmError의 "token", 6차). 보호자 본인 화면의 목록
 *   (app/api/push/device GET)이 쓴다 — 앱을 지운 휴대폰이 다음 위급 알림 때까지 "받는 휴대폰"으로 남아 보이지 않게.
 *   최선 노력: 5초 안에 끝나지 않거나 실패하면 [](아무것도 지우지 않는다 — throw 안 함).
 */
export async function findGoneTokens(tokens: string[]): Promise<string[]> {
  const app = getFcmApp();
  if (!app || tokens.length === 0) return [];
  try {
    // 보내지 않으므로 내용은 최소로 — 알림 모양에 버그가 있어도 토큰 점검이 그 탓으로 흐려지지 않게
    const messages: Message[] = tokens.map((token) => ({ token, data: { check: "1" } }));
    const res = await withinMs(getMessaging(app).sendEach(messages, true), TOKEN_CHECK_TIMEOUT_MS);
    return failuresOf(tokens, res).filter((f) => f.kind === "token").map((f) => f.target);
  } catch (e) {
    console.warn("[push-fcm] 등록 토큰 점검 실패(무시 — 목록은 그대로):", (e as Error).message);
    return [];
  }
}
