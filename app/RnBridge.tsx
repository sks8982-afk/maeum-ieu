"use client";

import { getSession, signOut, useSession } from "next-auth/react";
import { useCallback, useEffect, useRef } from "react";

/**
 * 마음이음 RN 앱(WebView) ↔ 웹 브릿지.
 *
 * RN WebView 안에서 실행될 때만 동작(window.ReactNativeWebView 존재 시). 일반 브라우저에서는 noop.
 *
 * 웹 → 앱 (window.ReactNativeWebView.postMessage, JSON 문자열)
 *   · { type:"LOGIN_SUCCESS", userId, role }   로그인/세션 활성. role = session.user.screeningMode. 바로 뒤에 REQUEST_PUSH_TOKEN이 따른다
 *       (구버전 앱 1.0.3은 userId만 읽고 maeum_<userId> 토픽을 구독한다)
 *   · { type:"LOGOUT", userId? }               **로그아웃 버튼을 눌러 로그아웃이 확인된 뒤에만**(logoutAndNotifyNative)
 *       (세션 상태가 "unauthenticated"로 보인다는 것만으로는 보내지 않는다 — bridgeMessageFor 주석)
 *   · { type:"PUSH_REGISTERED", reportId? }    서버가 이 보고를 받아들였다 — **상태 표시용**(토픽은 그대로 둔다). 앱은 폐기 토큰
 *                                               목록(retiredTokens)을 비운다. 보호자·의사 계정이면 토큰을 저장했고, 그 밖의 계정은
 *                                               폐기 토큰만 지우고 저장하지 않는다(서버 응답 { ok:true, stored:false } — 5차)
 *   · { type:"PUSH_REGISTER_FAILED", reason, reportId? }  저장 못 했다 — **상태 표시용**(토픽은 그대로 둔다)
 *       reportId(5차): 그 답이 어느 PUSH_TOKEN에 대한 것인지 — PUSH_TOKEN에 실려 온 값을 그대로 돌려준다(없었으면 필드도 없다)
 *   · { type:"REQUEST_PUSH_TOKEN" }            PUSH_TOKEN을 다시 보내 달라 + 저장해 둔 계정의 토픽을 **(다시) 구독**해 달라(멱등)
 *                                               (LOGIN_SUCCESS 직후, 보호자 화면이 열리거나 다시 보일 때, 알림 설정을 연 직후,
 *                                               로그아웃이 확인되지 않았을 때 — logoutAndNotifyNative)
 *   · { type:"OPEN_NOTIFICATION_SETTINGS" }    휴대폰 알림 설정 화면을 열어 달라
 *   · { type:"PURCHASE_VERIFIED", purchaseToken }
 * 앱 → 웹 (window/document의 MessageEvent, data = JSON 문자열)
 *   · { type:"PUSH_TOKEN", userId, token: string|null, permission:"granted"|"denied"|"unknown", channelBlocked, appVersion,
 *       retiredTokens?: string[], reportId?: string, error?: string } (앱 1.2.0+) — retiredTokens = 이 휴대폰이 지난번 등록이 성공한 뒤
 *       deleteToken()으로 폐기한 토큰(아래 LOGOUT·계정 전환). 웹은 등록 본문에 그대로 싣고, 서버가 그 행을 지운다
 *       (lib/push/devices registerDevice). reportId(5차) = 이 보고를 가리키는 앱의 표지 — 64자 이하, 영문·숫자·_·- 만(아니면
 *       없는 것으로 본다). 서버로는 보내지 않고 답(PUSH_REGISTERED·PUSH_REGISTER_FAILED)에 그대로 돌려준다.
 *       error(2026-10-08 10차) = 토큰을 못 받은 까닭(token:null일 때 — 앱 getToken 실패 코드·"timeout"·"empty-token") — 64자 이하,
 *       영문·숫자·_·.·:·/·- 만(아니면 없는 것으로 본다 — 메시지는 버리지 않는다). "/"는 11차부터 — 앱(@react-native-firebase)의 오류 코드는
 *       "messaging/unknown"처럼 이름공간이 붙어 온다. 등록 실패 사유에 붙여 앱 답(PUSH_REGISTER_FAILED)으로 돌려준다("no-token:<error>" —
 *       보호자 화면엔 고정 문구만 보인다, NATIVE_ERROR_RE 주석)
 *   · { type:"PURCHASE_TOKEN", purchaseToken, productId }
 *
 * 앱이 PUSH_TOKEN으로 답하기까지의 상한(2026-10-08 10차 — 보호자 화면이 "앱이 응답하지 않아요"를 띄우기 전에 기다리는 근거):
 *   앱(MaeumApp, 읽기 전용)은 시작 권한 창 응답을 최대 SETUP_WAIT_MS(12초) 기다린 뒤 보고하고, FCM 호출은 하나에 FCM_TIMEOUT_MS(12초)까지
 *   기다린다 — 계정 전환이면 폐기 목록에 적을 토큰 확인(retireLastToken의 getToken), 이전 토큰 폐기(deleteToken), 새 토큰(getToken)이
 *   이어져 최악 12 + 12 + 12 + 12 = 48초(11차 — 10차는 확인 getToken을 빼고 36초로 셌다). 웹은 그 뒤 서버 등록(POST)을 마친 다음에 화면에
 *   알린다. 그래서 보호자 화면은 55초(app/expert/PushStatusBox APP_ANSWER_TIMEOUT_MS — 서버 등록 여유 7초)까지 "확인 중"으로 기다린다 —
 *   앱 쪽 상한을 늘리면 그 값도 함께 늘린다(짧으면 제 할 일을 하는 앱을 "응답하지 않아요"로 보인다).
 *
 * 앱 1.2.0이 지킬 위급 알림 계약(2026-10-07 결정):
 *   · **조용함보다 중복** — 앱은 그 계정으로 로그인해 있는 동안 maeum_<accountId> 토픽 구독을 **끊지 않는다**.
 *     PUSH_REGISTERED는 상태 표시용일 뿐이다. 서버는 보호자·의사마다 **두 사본을 늘 함께** 보낸다 — 등록 휴대폰(토큰,
 *     실명)과 토픽(가린 이름). 등록 경로가 조용히 끊겨도(등록 실패·토큰 유실·조회 실패) 토픽 사본은 받는다.
 *   · 두 사본은 같은 data.alertId를 싣고, android.notification.tag = alertId, data.notificationId = alertId다 — 같은 tag는
 *     OS가 알림창에서 대체하고, 앱은 포그라운드·백그라운드 모두 **data.alertId로 한 번만** 울린다.
 *   · (5차) **토큰 사본**은 data.to = 받는 계정의 토픽 이름("maeum_<accountId>" — 서버 userTopic, 앱이 구독하는 토픽 이름과 같은
 *     문자열)을 싣는다 — 그 사본이 어느 계정 앞으로 왔는지 앱이 안다(토픽 사본은 FCM이 받은 토픽을 알려 준다). 토픽 사본에는 없다.
 *   · **모든** LOGIN_SUCCESS(역할 무관)·REQUEST_PUSH_TOKEN·앱 복귀에 PUSH_TOKEN으로 답한다 — 페이지를 새로 불러오면 웹은
 *     이 휴대폰을 잊는다(lastPushDevice). REQUEST_PUSH_TOKEN은 LOGIN_SUCCESS 바로 뒤에도 오므로, 계정을 바꾸는 중이면
 *     새 토큰으로 답한다.
 *   · 같은 셋(LOGIN_SUCCESS·REQUEST_PUSH_TOKEN·앱 복귀)마다 저장해 둔 계정의 토픽을 **다시 구독한다**(멱등) — 보호자 화면의
 *     휴대폰 삭제(DELETE { handle })가 서버 쪽에서 그 토큰을 토픽에서 뺄 수 있다(아래). 한 번 구독했다고 끝난 것으로 보지 않는다.
 *   · LOGOUT을 받으면, 그리고 LOGIN_SUCCESS의 userId가 저장해 둔 계정과 다르면 messaging().deleteToken()으로 토큰을
 *     폐기한다(계정 전환이면 새 토큰을 받아 새 계정 토픽을 구독하고 PUSH_TOKEN을 보낸다). 웹의 등록 해제(DELETE)가
 *     실패해도 이전 계정의 실명 알림이 이 휴대폰에 가지 않게 하는 마지막 선이다. 폐기한 토큰은 다음 등록이 성공할 때까지
 *     기억해 PUSH_TOKEN.retiredTokens로 보낸다 — 서버가 그 행을 지운다(못 지운 것은 다음 발송 때 FCM 오류로 지운다).
 *   · 서버(app/api/push/device, 2026-10-07 4차): 등록 요청(POST)을 받으면 응답 뒤에 그 토큰을 세션 계정 토픽에 구독시킨다
 *     — 등록 행이 저장되지 않아도(503 포함). 로그아웃의 등록 해제(DELETE { token })는 **토픽을 건드리지 않는다** — 확인된
 *     LOGOUT에서 앱이 deleteToken()으로 그 토큰을 폐기하면 그 토큰의 구독도 함께 끝난다(서버가 해제하던 때는, 로그아웃이
 *     확인되지 않아 되살린 구독과 그 해제가 FCM에서 엇갈려 로그인한 채 토픽이 빠질 수 있었다). 보호자 화면에서 다른 휴대폰을
 *     삭제하면(DELETE { handle }) 그 앱은 모르므로 서버가 그 토큰을 계정 토픽에서 해제한다(끝까지 기다린다, 최대 15초).
 *   · 해제 뒤 로그아웃이 확인되지 않으면(signOut 실패·csrf 거절·세션이 남음) 웹은 등록을 되살리고(서버가 토픽도 다시 붙인다)
 *     REQUEST_PUSH_TOKEN을 보내 앱이 다시 보고·구독하게 한다(logoutAndNotifyNative) — 로그인한 채 실명 사본이 빠진 상태로
 *     두지 않는다(되살리기도 실패할 수 있다).
 *
 * 왜 알림 토큰 등록이 여기 있나: 토픽(maeum_<id>)은 구독 권한 검사가 없고, 서버는 받는 기기가 있는지 모르며,
 *   넘겨받은 휴대폰이 이전 계정 구독을 들고 있을 수 있다. 토큰은 **로그인한 세션이 자기 계정에** 등록해야 그 셋이
 *   풀린다(lib/push/devices). 네이티브 계층에는 로그인 쿠키가 없으므로 세션을 가진 웹이 서버에 등록한다 — 구매 검증과 같은 이유.
 *
 * 왜 구매 검증이 여기 있나: 네이티브 계층에는 로그인 쿠키가 없어 서버가 결제자를 알 수 없다.
 *   그래서 **세션을 가진 웹**이 검증을 호출해야 한다. 그리고 앱은 로그인 직후
 *   미완료 구매를 재전송하므로(검증 전 앱 종료 복구), 어느 화면에 있어도 처리되어야 한다
 *   — /subscribe 화면에만 두면 복구가 유실된다.
 */
declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (message: string) => void };
  }
}

/** 구독 상태가 바뀌었음을 같은 페이지의 다른 컴포넌트에 알리는 이벤트 */
export const BILLING_UPDATED_EVENT = "maeum:billing-updated";

/** 이 휴대폰의 알림 상태(앱 보고 + 서버 등록 결과)를 같은 페이지의 화면에 알리는 이벤트 — detail: PushStatus */
export const PUSH_STATUS_EVENT = "maeum:push-status";

export type NativePushPermission = "granted" | "denied" | "unknown";

/** 앱이 보낸 이 휴대폰의 알림 토큰·권한 상태(PUSH_TOKEN) */
export interface NativePushToken {
  /** 앱이 알고 있는 로그인 계정(LOGIN_SUCCESS로 받은 값) */
  userId?: string;
  token: string | null;
  permission: NativePushPermission;
  channelBlocked: boolean;
  appVersion?: string;
  /** 이 휴대폰이 지난번 등록이 성공한 뒤 폐기한 토큰(위 계약) — 등록 본문에 그대로 싣는다. 없으면 필드도 없다 */
  retiredTokens?: string[];
  /** 이 보고의 표지(위 계약, 5차) — 검사를 통과한 것만 담기고 답에 그대로 돌려준다. 없으면 필드도 없다 */
  reportId?: string;
  /** 토큰을 못 받은 까닭(위 계약, 10차) — 검사를 통과한 것만 담기고 등록 실패 사유("no-token:<error>")에 붙인다. 없으면 필드도 없다 */
  error?: string;
}

/** PUSH_TOKEN.reportId 모양 — 64자 이하, 영문·숫자·_·- 만. 다르면 없는 것으로 본다(메시지는 버리지 않는다) */
const REPORT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * PUSH_TOKEN.error 모양(10차) — 64자 이하, 영문·숫자·_·.·:·/·- 만. 다르면 없는 것으로 본다(메시지는 버리지 않는다).
 *   이 값이 그대로 가는 곳은 앱 답과 로그뿐이다: 등록 실패 사유("no-token:<error>")에 붙어 앱 답(PUSH_REGISTER_FAILED)으로 돌아가고,
 *   앱이 그 답을 로그에 남긴다(MaeumApp push.js markPushRegisterFailed). 서버로는 가지 않는다(registerThisPhone은 토큰이 없으면 등록하지
 *   않는다). 보호자 화면엔 상태 이벤트로 함께 가지만 사유의 앞부분("no-token")으로 고른 고정 한국어 문구만 보인다(app/expert/PushStatusBox
 *   registerFailureText — 코드는 화면에 싣지 않는다).
 *   그래서 모양은 앱 답·로그를 어지럽히지 않을 만큼만 좁힌다 — 공백·한글·꺾쇠·따옴표·역슬래시가 섞인 값은 버리고, 경로처럼 보이는
 *   문자열("/"·"."·":"가 든 값)은 받는다: 이 값은 그 밖의 어디로도 가지 않는다.
 *   (2026-10-08 11차) "/"를 받는다 — 앱이 보내는 오류는 FCM 오류 코드(e.code — "messaging/unknown"·"messaging/service-not-available")라
 *   이름공간 "/"가 붙는다. 예전 모양은 바로 그 코드를 버려, 토큰을 못 받은 가장 흔한 까닭이 "no-token"만 남았다.
 */
const NATIVE_ERROR_RE = /^[A-Za-z0-9_.:/-]{1,64}$/;

/** 화면용 이 휴대폰 상태 — 토큰은 싣지 않는다 */
export interface PushStatus {
  permission: NativePushPermission;
  channelBlocked: boolean;
  appVersion?: string;
  /** 서버가 이 휴대폰을 지금 계정으로 등록했는가 */
  registered: boolean;
  /** 등록 실패 사유(registered=false일 때) */
  reason?: string;
}

/** 서버 등록 본문(app/api/push/device POST) — 로그아웃 때 해제·복구하려고 마지막 값을 기억한다 */
interface DeviceBody {
  token: string;
  appVersion: string | null;
  permission: NativePushPermission;
  channelBlocked: boolean;
  /** 폐기 토큰 — 서버가 검사해 지운다(lib/push/devices). 되살리기 때 다시 보내도 같은 결과다(멱등) */
  retiredTokens?: string[];
}

type RegisterResult = { ok: true } | { ok: false; reason: string };

/**
 * 세션 상태 → 앱에 보낼 메시지. **로그아웃 신호는 여기서 만들지 않는다.**
 *
 * 결함(2026-10-07 보호자 앱 푸시 추적): 상태가 "unauthenticated"면 LOGOUT을 보냈다. 그런데 next-auth는
 *   세션 조회가 **한 번만 실패해도**(앱으로 돌아오는 순간의 네트워크 끊김·5xx·응답 오류) 세션을 null로,
 *   즉 unauthenticated로 본다. 그러면 앱이 보호자 휴대폰의 토픽 구독을 끊어, 다시 로그인하거나 앱을
 *   재시작할 때까지 **위급 알림이 조용히 끊겼다**(화면은 로그인 창으로 갈 뿐 아무 경고도 없다).
 *   위급 알림은 "확실하지 않으면 구독 유지"가 맞다 → LOGOUT은 로그아웃 버튼에서만(logoutAndNotifyNative).
 *   다른 계정으로 로그인하면 앱이 LOGIN_SUCCESS를 받아 이전 구독을 새 계정으로 바꾼다(MaeumApp/App.jsx — 1.2.0은
 *   토큰도 폐기하고 새로 받는다, 위 계약).
 *
 * @param role 계정 역할(screeningMode) — 앱 1.2.0이 보호자·의사에게만 알림 권한·절전 안내를 띄우는 데 쓴다
 * @returns 보낼 메시지와 기억할 값, 보낼 게 없으면 null
 */
export function bridgeMessageFor(
  status: "authenticated" | "unauthenticated" | "loading",
  userId: string | undefined,
  role: string | undefined,
  lastSent: string | null,
): { message: string; sent: string } | null {
  if (status !== "authenticated" || !userId || lastSent === userId) return null;
  return { message: JSON.stringify({ type: "LOGIN_SUCCESS", userId, ...(role ? { role } : {}) }), sent: userId };
}

/** 앱으로 메시지 — 일반 브라우저에선 noop. 브릿지 오류가 화면 동작(로그아웃 등)을 막지 않게 삼킨다 */
function postToNative(message: Record<string, unknown>): void {
  try {
    window.ReactNativeWebView?.postMessage(JSON.stringify(message));
  } catch {
    /* 웹뷰 브릿지 오류 */
  }
}

/**
 * 앱이 이 기기의 위급 알림 구독을 끊게 한다 — **로그아웃이 확인된 뒤에만**(logoutAndNotifyNative 안에서) 부른다.
 *
 * ⚠ 먼저 보내면(2026-10-07 재검토), 네트워크가 끊기거나 로그아웃 요청이 실패했을 때 웹은 여전히 로그인 상태인데
 *   앱만 구독을 끊어 — 고치려던 "로그인한 채 알림이 조용히 끊김"이 다시 생긴다.
 * @param userId 로그아웃하는 계정 — 앱이 저장해 둔 계정을 잃었어도 이 계정의 구독을 정확히 끊을 수 있게(앱 1.2.0+)
 */
export function notifyNativeLogout(userId?: string): void {
  postToNative({ type: "LOGOUT", ...(userId ? { userId } : {}) });
}

/** 앱에 이 휴대폰의 PUSH_TOKEN을 다시 보내 달라고 한다(앱 1.2.0+. 구버전 앱은 무시한다) */
export function requestNativePushToken(): void {
  postToNative({ type: "REQUEST_PUSH_TOKEN" });
}

/** 앱에 휴대폰 알림 설정 화면을 열어 달라고 한다(앱 1.2.0+) */
export function openNativeNotificationSettings(): void {
  postToNative({ type: "OPEN_NOTIFICATION_SETTINGS" });
}

/** 알림 설정을 열고 곧바로 상태를 다시 묻는다 — 돌아왔을 때도 다시 묻는다(watchNativePushStatus). 앱 1.2.0+ 안에서만 */
export function openNotificationSettingsAndRecheck(): void {
  openNativeNotificationSettings();
  requestNativePushToken();
}

/**
 * 이 휴대폰의 알림 상태를 지켜본다(보호자 화면, 앱 1.2.0+ 안에서만) — 지금 PUSH_TOKEN을 요청하고, 화면이 다시 보일
 *   때마다(알림 설정에서 돌아오는 등) 다시 요청한다. 앱이 답해 상태가 오면 onStatus. 돌려준 함수를 부르면 그만 본다.
 *   왜 다시 보일 때인가: 처음 한 번만 물으면 설정에서 알림을 켜고 돌아와도 화면이 "꺼져 있어요"에 머문다 — 앱의 복귀
 *   보고(PUSH_TOKEN)에만 기대지 않는다.
 */
export function watchNativePushStatus(onStatus: (s: PushStatus) => void): () => void {
  const onEvent = (e: Event) => onStatus((e as CustomEvent<PushStatus>).detail);
  const onVisible = () => { if (document.visibilityState === "visible") requestNativePushToken(); };
  window.addEventListener(PUSH_STATUS_EVENT, onEvent);
  document.addEventListener("visibilitychange", onVisible);
  requestNativePushToken();
  return () => {
    window.removeEventListener(PUSH_STATUS_EVENT, onEvent);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/**
 * 앱이 넣은 메시지인가. 앱(sendToWeb)은 웹뷰 안에서 MessageEvent를 직접 만들어 넣으므로 보낸 창(source)이 없다
 *   (react-native-webview의 구형 경로는 자기 창을 source로 단다).
 * 왜 거르나: 다른 창(iframe·window.open으로 이 페이지를 연 창)이 postMessage로 PUSH_TOKEN을 흉내 내면,
 *   **그 사람의 휴대폰 토큰이 이 계정에 등록돼** 이 계정의 위급 알림(실명)을 가져간다.
 */
export function isFromNativeApp(e: Pick<MessageEvent, "origin" | "source">, self: Window): boolean {
  return (e.source === null || e.source === self) && (e.origin === "" || e.origin === self.location.origin);
}

/** 앱 메시지(JSON 문자열) → PUSH_TOKEN. 다른 메시지거나 모양이 계약과 다르면 null(응답하지 않는다 — 앱은 토픽을 유지한다) */
export function parseNativePushToken(data: unknown): NativePushToken | null {
  if (typeof data !== "string" || !data.includes("PUSH_TOKEN")) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(data); } catch { return null; }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  if (m.type !== "PUSH_TOKEN") return null;
  if (m.token !== null && typeof m.token !== "string") return null;
  if (m.permission !== "granted" && m.permission !== "denied" && m.permission !== "unknown") return null;
  // 알림 채널 차단 여부를 느슨하게 받으면 꺼진 휴대폰이 "받는 중"으로 보인다
  if (typeof m.channelBlocked !== "boolean") return null;
  // 폐기 토큰은 정리용 덧붙임이라 모양이 틀려도 메시지를 버리지 않는다(문자열만 넘기고, 토큰 모양·개수는 서버가 본다)
  const retired = Array.isArray(m.retiredTokens) ? m.retiredTokens.filter((t): t is string => typeof t === "string") : [];
  // 표지도 덧붙임 — 모양이 틀리면 답에 싣지 않을 뿐 등록은 그대로 한다(앱 화면으로 돌아가는 값이라 모양을 좁힌다)
  const reportId = typeof m.reportId === "string" && REPORT_ID_RE.test(m.reportId) ? m.reportId : undefined;
  // 토큰을 못 받은 까닭도 덧붙임(10차) — 모양이 틀리면 사유에 붙이지 않을 뿐 메시지는 그대로 받는다(NATIVE_ERROR_RE 주석)
  const error = typeof m.error === "string" && NATIVE_ERROR_RE.test(m.error) ? m.error : undefined;
  return {
    userId: typeof m.userId === "string" ? m.userId : undefined,
    token: typeof m.token === "string" && m.token !== "" ? m.token : null,
    permission: m.permission,
    channelBlocked: m.channelBlocked,
    appVersion: typeof m.appVersion === "string" ? m.appVersion : undefined,
    ...(retired.length > 0 ? { retiredTokens: retired } : {}),
    ...(reportId ? { reportId } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * 이 페이지가 마지막으로 앱에서 받은 이 휴대폰(지금 계정 것) — 로그아웃 때 서버 등록을 지우고, 로그아웃이 실패하면 되살린다.
 *   ⚠ 페이지를 새로 불러오면 비어 있다. 그래서 앱(1.2.0)은 LOGIN_SUCCESS를 받을 때마다 PUSH_TOKEN을 다시 보내야 한다.
 */
let lastPushDevice: DeviceBody | null = null;

/**
 * 로그아웃 중 — 이 사이에 온 PUSH_TOKEN은 등록하지도, 앱에 답하지도 않는다(2026-10-07 재검토).
 *   왜: 해제(DELETE) 뒤에 늦게 온 PUSH_TOKEN을 등록하면 방금 지운 등록이 되살아나, 로그아웃한 휴대폰이 그 계정의
 *   실명 알림을 계속 받는다. LOGOUT 뒤에 PUSH_REGISTERED가 가면 앱의 상태 표시가 로그아웃한 계정을 "등록됨"으로 보인다.
 *   로그아웃이 확인되지 않으면(여전히 로그인 상태) 푼다 — 그 뒤의 PUSH_TOKEN은 평소처럼 등록한다.
 */
let loggingOut = false;

/**
 * 진행 중인 등록 요청 **전부**(2026-10-07 3차) — 로그아웃은 이게 다 끝난 뒤에 해제를 보낸다(먼저 나간 등록이
 *   해제보다 늦게 도착해 되살리지 않게). 예전엔 마지막 요청 하나만 기억해, PUSH_TOKEN이 연달아 오면 앞 요청이 해제 뒤에
 *   도착해 로그아웃한 휴대폰의 등록을 되살릴 수 있었다. (로그아웃 실패 뒤의 되살리기는 여기 올리지 않는다 — 그 로그아웃이
 *   되살리기를 끝까지 기다리고, 그동안 다시 누른 로그아웃은 같은 로그아웃을 기다린다: logoutAndNotifyNative, 4차)
 */
const registrations = new Set<Promise<RegisterResult>>();
/** 그 등록들을 기다리는 상한 — 응답이 끝내 안 와도 로그아웃이 멈추지 않게 */
const REGISTER_WAIT_MS = 3000;

/** 등록 요청을 진행 중 목록에 올리고, 끝나면(어떻게 끝나든) 내린다 */
function trackRegistration(request: Promise<RegisterResult>): Promise<RegisterResult> {
  registrations.add(request);
  const done = () => { registrations.delete(request); };
  void request.then(done, done);
  return request;
}

async function waitForRegistrations(): Promise<void> {
  if (registrations.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...registrations]),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, REGISTER_WAIT_MS); }),
  ]);
  clearTimeout(timer);
}

/**
 * 이 휴대폰의 handle — 토큰 sha256의 앞 16자(hex), 서버 lib/push/devices deviceHandle과 같은 규칙.
 *   보호자 화면이 목록에서 "이 휴대폰"을 가리키는 데 쓴다 — 토큰 자체는 화면에 내보내지 않는다.
 *   아직 PUSH_TOKEN을 못 받았거나(구버전 앱 등) crypto.subtle이 없으면 null — "이 휴대폰" 표시만 빠진다.
 */
export async function thisPhoneHandle(): Promise<string | null> {
  const token = lastPushDevice?.token;
  if (!token) return null;
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  } catch {
    return null;
  }
}

async function postDeviceRegistration(device: DeviceBody): Promise<RegisterResult> {
  try {
    const res = await fetch("/api/push/device", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(device),
    });
    if (res.ok) return { ok: true };
    const j = (await res.json().catch(() => null)) as { notReady?: boolean } | null;
    return { ok: false, reason: j?.notReady ? "not-ready" : `http-${res.status}` };
  } catch {
    return { ok: false, reason: "network" };
  }
}

/** 등록 해제 요청 한 번 — 실패면 사유와, 바로 한 번 더 해 볼 만한지(5xx·네트워크 = 일시 장애. 429·4xx는 다시 해도 같다) */
async function tryDeleteDevice(token: string): Promise<{ ok: true } | { ok: false; reason: string; retry: boolean }> {
  try {
    const res = await fetch("/api/push/device", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.ok) return { ok: true };
    return { ok: false, reason: `http-${res.status}`, retry: res.status >= 500 };
  } catch {
    return { ok: false, reason: "network", retry: true };
  }
}

/**
 * 이 휴대폰 등록 해제 — 5xx·네트워크면 **한 번 더** 해 본다(2026-10-07 4차: 해제가 실패하면 그 행은 그 휴대폰이 다시 로그인해
 *   등록하거나 다음 알림 발송 때 무효로 확인될 때까지 남는다 — 개인정보처리방침 7항). 그래도 실패하면 로그아웃은 진행한다 —
 *   남은 등록은 앱이 LOGOUT에서 토큰을 폐기하면(위 계약) 그 휴대폰의 다음 등록(retiredTokens)이나 다음 발송 때 서버가 지운다.
 *   다만 실패를 해제로 치지 않고 남긴다(429·5xx는 등록이 그대로다).
 */
async function deleteDeviceRegistration(token: string): Promise<void> {
  let r = await tryDeleteDevice(token);
  if (!r.ok && r.retry) r = await tryDeleteDevice(token);
  if (!r.ok) console.warn(`[RnBridge] 이 휴대폰 등록 해제 실패(${r.reason}) — 로그아웃은 계속한다(앱이 LOGOUT에서 토큰을 폐기한다)`);
}

/** PUSH_TOKEN → 서버 등록. 계정은 서버가 세션에서 정한다 — 여기서는 앱과 웹이 같은 계정을 보고 있는지만 확인 */
async function registerThisPhone(msg: NativePushToken, sessionUserId: string | undefined): Promise<RegisterResult> {
  if (loggingOut) return { ok: false, reason: "logging-out" };   // 위 loggingOut 주석 — 기억(lastPushDevice)도 바꾸지 않는다
  // 앱이 알려 준 까닭을 붙인다(10차 — "no-token:SERVICE_NOT_AVAILABLE") — 보호자 화면은 앞부분으로 문구를 고르고(registerFailureText),
  //   뒷부분은 앱 답·운영 확인용이다
  if (!msg.token) return { ok: false, reason: msg.error ? `no-token:${msg.error}` : "no-token" };
  if (!sessionUserId) return { ok: false, reason: "not-logged-in" };
  // 앱이 아는 계정과 웹 세션이 다르면(계정 전환 중) 등록하지 않는다 — LOGIN_SUCCESS를 받은 앱이 새 계정으로 다시 보낸다
  if (msg.userId && msg.userId !== sessionUserId) return { ok: false, reason: "account-mismatch" };
  const device: DeviceBody = {
    token: msg.token, appVersion: msg.appVersion ?? null, permission: msg.permission, channelBlocked: msg.channelBlocked,
    ...(msg.retiredTokens ? { retiredTokens: msg.retiredTokens } : {}),
  };
  // 등록 결과와 무관하게 기억한다 — 이번 요청이 실패해도 이전에 등록됐을 수 있고, 로그아웃 때 지울 대상을 알아야 한다
  lastPushDevice = device;
  return trackRegistration(postDeviceRegistration(device));
}

/**
 * 앱이 보낸 PUSH_TOKEN 처리 — 서버 등록 → 앱에 결과(PUSH_REGISTERED / PUSH_REGISTER_FAILED, 표시용) → 화면에 상태 이벤트.
 *   로그아웃이 시작됐으면(등록 전이든 등록 요청이 도는 사이든) 앱에도 화면에도 알리지 않는다(loggingOut 주석).
 *   앱에 보내는 답에는 PUSH_TOKEN의 reportId를 그대로 싣는다(5차 — 없으면 필드도 없다): 앱이 어느 보고에 대한 답인지 안다.
 * @param sessionUserId 지금 웹 세션 계정(없으면 로그인 전 — 등록하지 않는다)
 */
export async function relayNativePushToken(msg: NativePushToken, sessionUserId: string | undefined): Promise<PushStatus> {
  const result = await registerThisPhone(msg, sessionUserId);
  const status: PushStatus = {
    permission: msg.permission,
    channelBlocked: msg.channelBlocked,
    appVersion: msg.appVersion,
    registered: result.ok,
    ...(result.ok ? {} : { reason: result.reason }),
  };
  if (loggingOut) return status;
  const report = msg.reportId ? { reportId: msg.reportId } : {};
  postToNative(result.ok ? { type: "PUSH_REGISTERED", ...report } : { type: "PUSH_REGISTER_FAILED", reason: result.reason, ...report });
  window.dispatchEvent(new CustomEvent<PushStatus>(PUSH_STATUS_EVENT, { detail: status }));
  return status;
}

/** 로그아웃이 확인되지 않았을 때 모든 로그아웃 버튼이 띄우는 안내(logoutAndNotifyNative가 reject하면) */
export const LOGOUT_FAILED_ALERT = "로그아웃하지 못했어요. 인터넷 연결을 확인한 뒤 다시 눌러 주세요.";

/**
 * 로그아웃 한 번(logoutAndNotifyNative가 하나만 돌린다). 순서가 계약이다: **기기 등록 해제 → signOut(확인) → 앱에 LOGOUT → 이동.**
 *   · 해제가 먼저인 이유: 해제는 세션이 있어야 된다(남의 휴대폰 등록을 지우지 못하게). signOut 뒤에는 할 수 없다.
 *   · 해제 전에 로그아웃 중 표시를 켜고(그 뒤 PUSH_TOKEN 무시), 이미 나간 등록 요청은 **전부** 끝나기를 기다린다(최대 3초) —
 *     늦게 도착한 등록이 해제를 덮으면 로그아웃한 휴대폰이 그 계정의 실명 알림을 계속 받는다.
 *   · 해제가 실패해도(5xx·네트워크면 한 번 더 해 본 뒤) 로그아웃은 계속한다 — 앱이 LOGOUT에서 토큰을 폐기하는 게 마지막 선이다.
 *   · **signOut이 resolve했다고 로그아웃된 게 아니다**(2026-10-07 3차): next-auth 4.24는 CSRF 토큰을 못 받으면(그 요청의
 *     네트워크 오류 — getCsrfToken이 null) 그대로 POST해 ".../signout?csrf=true"로 resolve하고, 쿠키는 지우지 않는다.
 *     그래서 응답 주소가 있고 csrf=true가 아니며 세션을 다시 물어도 사용자가 없을 때만 로그아웃으로 친다.
 *   · 확인되지 않으면(throw 포함) 여전히 로그인 상태다 — 표시를 풀고, 방금 지운 등록을 되살리고(되살리지도 못하면 앱에
 *     등록 실패를 알린다 — 표시용), **늘** REQUEST_PUSH_TOKEN을 보낸다: 되살리기가 실패했어도 앱이 PUSH_TOKEN을 다시 보고해
 *     등록이 다시 시도되고, 앱은 토픽 구독도 다시 확인한다(멱등 — 위 계약). LOGOUT은 보내지 않고 reject한다 —
 *     호출부가 안내 창(LOGOUT_FAILED_ALERT)을 띄운다. 로그인한 채 이 휴대폰의 위급 알림이 끊기면 안 된다.
 *   · 이동은 전체 새로고침(location.assign) — 화면에 남은 이전 계정 상태를 지운다.
 * @param userId 로그아웃하는 계정(LOGOUT에 실어 앱이 그 계정 구독을 정확히 끊게)
 */
async function runLogout({ userId, redirectTo }: { userId?: string; redirectTo: string }): Promise<void> {
  loggingOut = true;
  await waitForRegistrations();
  const device = lastPushDevice;   // 지금 이 휴대폰 — 로그아웃 중엔 새 PUSH_TOKEN이 기억을 바꾸지 않는다(registerThisPhone)
  if (device) await deleteDeviceRegistration(device.token);
  try {
    const r = await signOut({ redirect: false });
    if (!r?.url || r.url.includes("csrf=true") || (await getSession())?.user) throw new Error("signout-unconfirmed");
  } catch (e) {
    loggingOut = false;
    if (device) {
      // 되살리기가 끝난 뒤에야 이 로그아웃이 끝난다 — 그사이 다시 누른 로그아웃은 새로 돌지 않고 이걸 함께 기다린다
      //   (logoutAndNotifyNative). 그래서 다음 로그아웃의 해제가 되살리기보다 먼저 도착하는 일이 없다
      const restored = await postDeviceRegistration(device);
      if (!restored.ok) postToNative({ type: "PUSH_REGISTER_FAILED", reason: restored.reason });
    }
    requestNativePushToken();
    throw e;
  }
  lastPushDevice = null;
  notifyNativeLogout(userId);
  window.location.assign(redirectTo);
}

/** 진행 중인 로그아웃(2026-10-07 4차) — 끝나면(성공이든 실패든) 비운다 */
let logoutInFlight: Promise<void> | null = null;

/**
 * 로그아웃 — 모든 로그아웃 버튼이 이것만 부른다(순서·확인 규칙은 runLogout). **하나만 돈다**(2026-10-07 4차): 이미 진행 중이면
 *   새로 시작하지 않고 그 로그아웃의 프라미스를 그대로 돌려준다 — 같은 결과(성공·실패)를 함께 받는다.
 *   왜: 버튼을 연달아 누르면(응답이 느린 순간 다시 누르기 쉽다) 해제·signOut·되살리기가 둘씩 돌아, 한쪽이 되살린 등록을 다른
 *   쪽 해제가 덮거나(로그인한 채 실명 사본이 빠진다) 앱에 LOGOUT이 두 번 갔다.
 */
export function logoutAndNotifyNative(opts: { userId?: string; redirectTo: string }): Promise<void> {
  logoutInFlight ??= runLogout(opts).finally(() => { logoutInFlight = null; });
  return logoutInFlight;
}

export function RnBridge() {
  const { data: session, status } = useSession();
  const lastSentRef = useRef<string | null>(null);
  /** 같은 토큰을 중복 검증하지 않게 — 앱이 복구로 여러 번 보낼 수 있다 */
  const verifiedRef = useRef<Set<string>>(new Set());
  /** 앱이 보낸 알림 토큰을 등록할 지금 계정 — 메시지 리스너는 한 번만 붙이므로 최신 세션을 ref로 본다 */
  const sessionUserIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    sessionUserIdRef.current = status === "authenticated" ? session?.user?.id : undefined;
  }, [status, session?.user?.id]);

  useEffect(() => {
    const rn = typeof window !== "undefined" ? window.ReactNativeWebView : undefined;
    if (!rn) return;
    // 세션이 끊겨 보이면 기억만 지운다(구독은 유지) — 다시 로그인되면 같은 계정이어도 한 번 더 알린다
    if (status === "unauthenticated") { lastSentRef.current = null; return; }
    const next = bridgeMessageFor(status, session?.user?.id, session?.user?.screeningMode, lastSentRef.current);
    if (!next) return;
    lastSentRef.current = next.sent;
    rn.postMessage(next.message);
    // 이어서 이 휴대폰 토큰을 요청한다 — 앱(1.2.0)도 LOGIN_SUCCESS마다 PUSH_TOKEN을 보내지만, 그 답을 놓쳐도 등록이
    //   빠지지 않게(멱등 — 같은 토큰이면 같은 행을 갱신할 뿐). 구버전 앱은 모르는 메시지라 무시한다.
    requestNativePushToken();
  }, [status, session?.user?.id, session?.user?.screeningMode]);

  const verify = useCallback(async (purchaseToken: string, productId?: string) => {
    if (verifiedRef.current.has(purchaseToken)) return;
    verifiedRef.current.add(purchaseToken);
    try {
      const r = await fetch("/api/billing/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchaseToken, productId }),
      });
      if (!r.ok) {
        // 마감 신호를 보내지 않는다 — 미완료로 남겨 다음 실행에서 다시 검증되게.
        verifiedRef.current.delete(purchaseToken);
        const j = await r.json().catch(() => null) as { error?: string } | null;
        window.dispatchEvent(new CustomEvent(BILLING_UPDATED_EVENT, {
          detail: { ok: false, error: j?.error || "구매를 확인하지 못했습니다." },
        }));
        return;
      }
      window.ReactNativeWebView?.postMessage(JSON.stringify({ type: "PURCHASE_VERIFIED", purchaseToken }));
      window.dispatchEvent(new CustomEvent(BILLING_UPDATED_EVENT, { detail: { ok: true } }));
    } catch {
      verifiedRef.current.delete(purchaseToken);
      window.dispatchEvent(new CustomEvent(BILLING_UPDATED_EVENT, {
        detail: { ok: false, error: "구매 확인 중 오류가 발생했습니다." },
      }));
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || !window.ReactNativeWebView) return;
    const onMsg = (e: MessageEvent) => {
      const d = typeof e.data === "string" ? e.data : "";
      if (!d.includes("PURCHASE_TOKEN")) return;
      try {
        const msg = JSON.parse(d) as { type?: string; purchaseToken?: string; productId?: string };
        if (msg.type === "PURCHASE_TOKEN" && msg.purchaseToken) {
          void verify(msg.purchaseToken, msg.productId);
        }
      } catch { /* 다른 메시지 */ }
    };
    window.addEventListener("message", onMsg);
    document.addEventListener("message", onMsg as EventListener); // 안드로이드 WebView
    return () => {
      window.removeEventListener("message", onMsg);
      document.removeEventListener("message", onMsg as EventListener);
    };
  }, [verify]);

  // 앱(1.2.0+)이 보낸 이 휴대폰의 알림 토큰 → 지금 계정으로 서버 등록(relayNativePushToken — 로그아웃 중이면 아무것도 안 한다)
  useEffect(() => {
    if (typeof window === "undefined" || !window.ReactNativeWebView) return;
    const onPush = (e: MessageEvent) => {
      if (!isFromNativeApp(e, window)) return;
      const msg = parseNativePushToken(e.data);
      if (msg) void relayNativePushToken(msg, sessionUserIdRef.current);
    };
    window.addEventListener("message", onPush);
    document.addEventListener("message", onPush as EventListener); // 안드로이드 WebView
    return () => {
      window.removeEventListener("message", onPush);
      document.removeEventListener("message", onPush as EventListener);
    };
  }, []);

  return null;
}
