/**
 * FCM(Firebase Cloud Messaging) 푸시 발송 — 보호자 앱(RN WebView)으로 위급 알림.
 *
 * 토픽 방식: 보호자가 앱 로그인 시 자기 userId 토픽(maeum_<id>)을 구독.
 *   서버는 환자 응급 발생 시 연결된 보호자들의 토픽으로 발송.
 *   → 기기 토큰을 DB에 저장/관리할 필요가 없음.
 *   ⚠ 대가: 서버는 **구독한 기기가 있는지 모른다**. FCM이 토픽 메시지를 받아들이면 sent로 센다
 *   (보호자가 앱에 로그인한 적이 없어도). 기기 수신 확인은 앱 쪽 보고(하트비트·토큰)가 있어야 한다.
 *
 * ⚠ **notification + data** 페이로드다(예전 주석의 "data-only"는 틀렸다 — 2026-10-07 추적으로 확인).
 *   앱이 백그라운드·종료 상태일 때 배너는 **OS(FCM SDK)가 notification 필드로 그린다** — 앱의
 *   백그라운드 핸들러(MaeumApp/index.js)는 소리만 내고 배너를 그리지 않는다. 그래서 notification
 *   필드를 빼서 "data-only로 고치면" 앱이 꺼져 있을 때 **배너가 사라진다**(소리 4초만). 테스트로 고정.
 *   포그라운드에서는 앱이 직접 모달·소리·진동으로 표시한다.
 *
 * 자격증명(FCM_SERVICE_ACCOUNT_B64 / FCM_SERVICE_ACCOUNT)이 없으면 발송하지 않는다 — 이때 **크게 로그**를
 *   남긴다(예전엔 아무 로그 없이 skip해, 운영에서 푸시가 꺼져 있어도 알 길이 없었다).
 */

import { initializeApp, getApps, getApp, cert, type App, type ServiceAccount } from "firebase-admin/app";
import { getMessaging, type Message } from "firebase-admin/messaging";

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

/** 서비스 계정 env로 firebase-admin 1회 초기화. 미설정/파싱 실패 시 null(=비활성). */
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
    cachedApp = getApps().length ? getApp() : initializeApp({ credential: cert(serviceAccount) });
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
}

export interface PushResult {
  sent: number;
  failed: number;
  skipped?: string; // 발송 안 한 사유 (미설정 등)
}

/** FCM 사용 가능 여부(자격증명 설정됨) — 호출부에서 채널 표기에 활용. */
export function isFcmConfigured(): boolean {
  return getFcmApp() !== null;
}

/**
 * 보호자 userId 목록 → 각자의 토픽으로 위급 알림 발송.
 * 실패해도 throw 안 함(LLM 응답 흐름에 영향 X).
 */
export async function sendEmergencyPush(userIds: string[], payload: PushPayload): Promise<PushResult> {
  const app = getFcmApp();
  if (!app) return { sent: 0, failed: 0, skipped: "FCM not configured" };
  if (userIds.length === 0) return { sent: 0, failed: 0, skipped: "no targets" };

  const messages: Message[] = userIds.map((uid) => ({
    topic: userTopic(uid),
    // notification 페이로드 — 앱이 종료/백그라운드여도 OS가 직접 알림 표시(앱 코드 실행 불필요).
    notification: { title: payload.title, body: payload.body },
    data: {
      title: payload.title,
      body: payload.body,
      level: String(payload.level),
      category: payload.category,
      sound: payload.sound ?? "alarm",
      notificationId: `${Date.now()}_${uid}`, // 앱 측 중복 표시 차단용 고유 ID
      ...(payload.patientId ? { patientId: payload.patientId } : {}),
    },
    android: {
      priority: "high",
      notification: {
        channelId: "maeum-emergency", // 앱이 만든 HIGH 채널(소리·진동·bypassDnd). 없으면 기본 채널로 표시
        sound: payload.sound ?? "alarm",
        priority: "max",
        // 기기가 꺼져 있다 몇 시간 뒤 받아도 **발생 시각**으로 보이게 — 없으면 받은 시각이 찍혀 방금 일처럼 보인다
        ...(payload.createdAt ? { eventTimestamp: payload.createdAt } : {}),
      },
    },
  }));

  try {
    const res = await getMessaging(app).sendEach(messages);
    if (res.failureCount > 0) {
      const firstErr = res.responses.find((r) => !r.success)?.error?.message;
      console.warn(`[push-fcm] 일부 실패 ${res.failureCount}/${messages.length}:`, firstErr);
    }
    return { sent: res.successCount, failed: res.failureCount };
  } catch (e) {
    console.warn("[push-fcm] 발송 실패:", (e as Error).message);
    return { sent: 0, failed: userIds.length };
  }
}
