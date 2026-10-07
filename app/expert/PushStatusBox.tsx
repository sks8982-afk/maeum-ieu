"use client";

/**
 * 보호자·의사 화면의 "위급 알림을 받는 휴대폰" 상태(2026-10-07).
 *
 * 왜: 예전엔 서버가 받는 휴대폰이 있는지 몰라(토픽은 구독자 0명이어도 발송 성공) 앱에 로그인하지 않은 보호자도
 *   알림을 받는 줄 알았다. 이제 이 계정으로 등록된 휴대폰을 하나씩 보여 주고, 없거나 알림이 꺼져 있으면 경고한다.
 *   · 계정 단위: GET /api/push/device(토큰은 내려오지 않는다 — handle만). 휴대폰마다 "삭제"(DELETE { handle }) —
 *     잃어버리거나 넘겨준 휴대폰으로 실명 알림이 가지 않게. 그 휴대폰에서 앱을 다시 열면 다시 등록된다.
 *   · 이 휴대폰: 앱(1.2.0+) 안이면 앱에 상태를 다시 묻는다 — 처음, 화면이 다시 보일 때, 알림 설정을 연 직후
 *     (RnBridge watchNativePushStatus). 알림 권한·채널이 꺼져 있으면 설정으로 보내고, 목록에선 "이 휴대폰"으로 표시한다.
 *     1.2.0 이전 앱은 휴대폰 등록을 모르므로 묻지 않고 "수신 확인 미지원"만 적는다(위급 알림은 토픽으로 받는다).
 *   · 0대: Play 배포 스위치를 켜기 전(PUSH_TOKENS_LIVE 꺼짐 — 1.2.0 프로덕션 단계적 출시가 100%가 되기 전)엔 정상이다 — 경고 대신
 *     중립 안내(lib/app-version 스위치).
 *     1.2.0 앱 안이면 그 안내 대신 이 휴대폰의 마지막 등록 상태(확인 중 / 등록 못 함 + 다시 시도)를 보여 준다(NoDevices).
 *     (4차) 확인 중이 오래 이어지면 "앱이 응답하지 않아요" + 다시 시도, 실패 사유는 한국어로.
 *     (2026-10-08 10차) 1.2.0 앱 안이면 스위치가 켜져도 이 등록 상태가 먼저다 — "앱에 로그인·업데이트" 경고는 브라우저·구버전 앱에만.
 *     확인 중 상한은 앱이 답하는 최악에 맞춘다(APP_ANSWER_TIMEOUT_MS). 목록에서 "이 휴대폰"을 지우면 "지웠어요" 상태 —
 *     시간 상한도 "다시 시도"도 없다(앱이 다시 보고할 때까지).
 *     (11차) 다른 휴대폰이 목록에 있어도 1.2.0 앱 안인데 이 휴대폰이 목록에 없으면 목록 아래에 같은 등록 상태(ThisPhoneRegistration).
 *   · (4차) 어르신 화면에 무엇이 보이는지 적는다 — 연결된 어르신 화면엔 "앱 알림을 받을 수 있나"만 보인다(대수·기기 정보 없음,
 *     app/api/users/linked-experts · 개인정보처리방침 9항).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  openNotificationSettingsAndRecheck, requestNativePushToken, thisPhoneHandle, watchNativePushStatus, type PushStatus,
} from "../RnBridge";
import { MIN_PUSH_TOKEN_APP_VERSION, PUSH_TOKENS_LIVE, isOlderVersion } from "@/lib/app-version";

export interface DeviceRow {
  handle: string;
  platform: string;
  appVersion: string | null;
  permission: string;
  channelBlocked: boolean;
  updatedAt: string;
}

/** 이 화면이 열린 곳 — 일반 브라우저 / 휴대폰 등록을 모르는 앱(1.2.0 이전·버전 주입 전) / 등록을 아는 앱 */
export type AppKind = "browser" | "old-app" | "app";

export function appKindOf(w: { ReactNativeWebView?: unknown; MAEUM_APP_VERSION?: unknown }): AppKind {
  if (!w.ReactNativeWebView) return "browser";
  const v = w.MAEUM_APP_VERSION;
  return typeof v === "string" && !isOlderVersion(v, MIN_PUSH_TOKEN_APP_VERSION) ? "app" : "old-app";
}

// 앱 종류는 페이지가 떠 있는 동안 바뀌지 않는다(구독할 것 없음). 서버 렌더엔 브릿지가 없다 → "browser"
const noSubscribe = () => () => {};
const appKindHere = (): AppKind => appKindOf(window as unknown as Parameters<typeof appKindOf>[0]);
const appKindOnServer = (): AppKind => "browser";

export const DELETE_CONFIRM = "이 휴대폰으로는 더 이상 위급 알림을 보내지 않습니다. 삭제할까요?\n(그 휴대폰에서 앱을 다시 열면 다시 등록돼요)";

/**
 * 삭제가 안 됐을 때(2026-10-07 5차) — 서버가 그 휴대폰의 토픽 구독을 먼저 끊고, 끊긴 게 확인돼야 목록에서 지운다
 *   (app/api/push/device DELETE { handle } — 실패면 502 { ok:false, reason:"topic" }, 7차: 서버가 FCM을 쓸 수 없어 끊었는지 확인할
 *   수 없으면 503 { ok:false, reason:"unconfigured" }). 둘 다 같은 문구 — 목록은 다시 읽어 그 줄이 남아 있으므로 다시 누를 수 있다.
 */
export const DELETE_FAILED_TEXT = "삭제하지 못했어요. 잠시 후 다시 시도해 주세요.";

/** 보호자 화면에 적는 어르신 쪽 표시 범위(2026-10-07 4차) — 서버도 상태만 보낸다(app/api/users/linked-experts) */
export const ELDER_VISIBILITY_NOTE = "연결된 어르신 화면에는 앱 알림을 받을 수 있는지만 표시돼요.";

/**
 * 이 휴대폰 등록을 확인하는 중(앱에 PUSH_TOKEN을 물었다)이 이만큼 이어지면 "앱이 응답하지 않아요"로 바꾼다.
 *   (2026-10-08 10차) 앱이 답하는 최악에 맞춘다 — 시작 권한 창 대기(SETUP_WAIT_MS 12초) + 폐기 목록에 적을 토큰 확인(retireLastToken의
 *   getToken 12초) + 이전 토큰 폐기(deleteToken 12초) + 새 토큰(getToken 12초 — 셋 다 FCM_TIMEOUT_MS, MaeumApp) = 48초에 웹의 서버 등록
 *   여유 7초를 더해 55초. (11차) 10차의 40초는 확인 getToken을 빼고 36초로 셌다 — 계정을 바꾸는 앱이 제 할 일을 하는 끝에 "앱이 응답하지
 *   않아요"가 뜰 수 있었다. 예전 10초는 그 한참 전에 띄웠다. 앱 쪽 상한을 늘리면 이 값도 함께 늘린다(app/RnBridge 계약 머리 주석).
 */
export const APP_ANSWER_TIMEOUT_MS = 55_000;

/** 확인 중(앱의 답을 기다린다 — 최대 APP_ANSWER_TIMEOUT_MS) 문구 */
export const CHECKING_TEXT = "이 휴대폰 등록을 확인하는 중이에요. 잠시 기다려 주세요.";

/**
 * 목록에서 "이 휴대폰"(앱 안 — 지금 들고 있는 휴대폰)을 지운 뒤의 문구(2026-10-08 10차). 지운 것은 보호자의 뜻이라 등록이 빠진 게
 *   장애가 아니다 — 예전엔 0대가 되면 "확인 중" → 시간 상한 → "앱이 응답하지 않아요" + 다시 시도로 흘러, 방금 지운 걸 고장처럼 보였다.
 *   앱이 다시 보고하면(앱을 다시 열거나 화면이 다시 보일 때 — watchNativePushStatus) 다시 등록되고 이 상태는 풀린다.
 */
export const DELETED_HERE_TEXT = "이 휴대폰을 목록에서 지웠어요. 앱을 다시 열면 다시 등록돼요.";

/** 등록 실패 사유(RnBridge relayNativePushToken의 reason) → 보호자가 읽는 말. 모르는 사유는 코드를 함께 적는다 */
const REGISTER_FAILURE_TEXT = new Map([
  ["not-ready", "서버 준비 중이에요. 잠시 후 다시 시도해 주세요."],
  ["network", "인터넷 연결을 확인해 주세요."],
  ["http-429", "요청이 많아요. 잠시 후 다시 시도해 주세요."],
  ["not-logged-in", "로그인 상태를 확인해 주세요."],
  // (10차) 앱이 토큰을 못 받았다(getToken 실패·12초 초과 — 사유 뒤에 앱의 오류 코드가 붙을 수 있다, RnBridge registerThisPhone)
  ["no-token", "휴대폰이 알림 토큰을 받지 못했어요 — 인터넷·Google Play 서비스를 확인해 주세요"],
  // (10차) 앱이 아는 계정과 웹 세션이 다르다(계정 전환 중) — 앱을 다시 열면 새 계정으로 다시 보고한다
  ["account-mismatch", "다른 계정 정보로 등록하려 했어요 — 앱을 다시 열어 주세요"],
  ["http-401", "로그인이 만료됐어요 — 다시 로그인해 주세요"],
]);

/** 사유 뒤에 붙은 앱의 오류 코드(":" 뒤 — 예: "no-token:SERVICE_NOT_AVAILABLE")는 문구를 고르는 데 쓰지 않는다 */
const reasonKey = (reason: string) => reason.split(":", 1)[0];

export function registerFailureText(reason: string | undefined): string {
  return (reason !== undefined && REGISTER_FAILURE_TEXT.get(reasonKey(reason))) || `알 수 없는 오류예요 (${reason ?? "unknown"})`;
}

const isReady = (d: Pick<DeviceRow, "permission" | "channelBlocked">) => d.permission === "granted" && !d.channelBlocked;

/** 앱이 이 휴대폰 알림이 꺼져 있다고 보고했는가(권한 없음·위급 알림 채널 막음) */
const isPhoneOff = (s: PushStatus | null) => s !== null && (s.permission !== "granted" || s.channelBlocked);

const fmtSeen = (s: string) =>
  new Date(s).toLocaleString("ko-KR", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const platformLabel = (p: string) => (p === "android" ? "안드로이드" : p);

/** 이 계정의 등록 휴대폰 — 못 불러오면 null(상태 표시는 보조 정보라 상자를 숨긴다) */
async function fetchDevices(): Promise<DeviceRow[] | null> {
  try {
    const res = await fetch("/api/push/device");
    if (!res.ok) return null;
    const data = (await res.json()) as { devices?: DeviceRow[] };
    return data.devices ?? [];
  } catch {
    return null;
  }
}

/**
 * 목록의 휴대폰 삭제 — 확인 창 → DELETE { handle }(세션 계정 휴대폰 중 그것만 — app/api/push/device).
 * @returns "cancelled"(확인 창에서 취소) · "deleted" · "failed"(응답 오류 — 토픽 해제 실패 502·FCM 설정 없음 503 포함 — ·네트워크)
 */
export async function deleteListedDevice(handle: string): Promise<"cancelled" | "deleted" | "failed"> {
  if (!window.confirm(DELETE_CONFIRM)) return "cancelled";
  try {
    const res = await fetch("/api/push/device", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle }),
    });
    return res.ok ? "deleted" : "failed";
  } catch {
    return "failed";
  }
}

export function PushStatusBox() {
  const app = useSyncExternalStore(noSubscribe, appKindHere, appKindOnServer);
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [thisHandle, setThisHandle] = useState<string | null>(null);
  const [phone, setPhone] = useState<PushStatus | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);   // 삭제 중인 휴대폰 handle
  const [deleteFailed, setDeleteFailed] = useState(false);
  // 앱에 묻는 회차 — 앱이 답하거나 "다시 시도"를 누를 때마다 +1. 확인 중 시간(APP_ANSWER_TIMEOUT_MS)은 회차마다 새로 잰다
  const [ask, setAsk] = useState(0);
  const [noAnswerAt, setNoAnswerAt] = useState<number | null>(null);   // 상한 동안 답이 없었던 회차
  // 목록에서 "이 휴대폰"을 지웠다(10차 — DELETED_HERE_TEXT) — 앱이 다시 보고할 때까지
  const [deletedHere, setDeletedHere] = useState(false);

  // 계정 목록 — 처음, 이 휴대폰이 방금 등록·갱신됐을 때, 삭제한 뒤 다시 읽는다
  useEffect(() => {
    let alive = true;
    void Promise.all([fetchDevices(), thisPhoneHandle()]).then(([d, handle]) => {
      if (!alive) return;
      if (d) setDevices(d);
      setThisHandle(handle);
    });
    return () => { alive = false; };
  }, [reload]);

  // 앱(1.2.0+) 안 — 이 휴대폰 상태를 묻고 지켜본다(처음·화면이 다시 보일 때). 등록됐다는 답이면 목록을 다시 읽는다
  useEffect(() => {
    if (app !== "app") return;
    return watchNativePushStatus((s) => {
      setPhone(s);
      setAsk((n) => n + 1);
      // 앱이 새로 보고했다 — "지웠어요"를 풀고 그 결과를 보여 준다(등록됐으면 목록을 다시 읽어 이 휴대폰 줄이 돌아온다)
      setDeletedHere(false);
      if (s.registered) setReload((n) => n + 1);
    });
  }, [app]);

  /**
   * 확인 중(1.2.0 앱 안 · 목록에 이 휴대폰 없음 · 실패 보고 없음)이 상한(APP_ANSWER_TIMEOUT_MS)을 넘기면 "앱이 응답하지 않아요"(2026-10-07
   *   4차) — 예전엔 앱이 답하지 않으면(앱이 멈춤·브릿지 끊김) "확인하는 중"에 끝없이 머물러, 보호자가 등록이 빠진 걸 알 수 없었다.
   *   "이 휴대폰"을 방금 지웠으면 기다리지 않는다(10차) — 기다릴 답이 없다(지운 것은 보호자의 뜻이다).
   *   (11차) 0대일 때만이 아니다 — 다른 휴대폰이 목록에 있어도 이 휴대폰이 없으면 기다린다(AccountDevices가 목록 아래에 같은 상태를 그린다).
   *   예전엔 다른 보호자·다른 휴대폰이 등록된 계정에선 이 휴대폰 등록이 빠져도(실패·응답 없음) 화면에 아무것도 없었다.
   */
  const thisListed = devices?.some((d) => d.handle === thisHandle) ?? false;
  const waiting = app === "app" && devices !== null && !thisListed && !(phone !== null && !phone.registered) && !deletedHere;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setNoAnswerAt(ask), APP_ANSWER_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [waiting, ask]);

  async function remove(handle: string) {
    setBusy(handle);
    const r = await deleteListedDevice(handle);
    setBusy(null);
    if (r === "cancelled") return;
    setDeleteFailed(r === "failed");
    // 지운 줄이 지금 들고 있는 휴대폰이면(thisHandle은 앱 안에서만 안다) "지웠어요" 상태로 — 0대가 돼도 확인 중·시간 상한으로 흐르지 않게
    if (r === "deleted" && handle === thisHandle) setDeletedHere(true);
    setReload((n) => n + 1);
  }

  // 이 휴대폰 경고는 계정 목록을 못 불러와도 보인다 — 지금 들고 있는 휴대폰이 꺼져 있다는 게 가장 직접적인 신호다
  if (devices === null && !isPhoneOff(phone) && app !== "old-app") return null;

  return (
    <div className="mt-4 space-y-2 text-xs leading-relaxed">
      {devices !== null && (
        <>
          <AccountDevices
            devices={devices} thisHandle={thisHandle} app={app} phone={phone} busy={busy} onDelete={remove}
            noAnswer={noAnswerAt === ask} deletedHere={deletedHere} onRetry={() => setAsk((n) => n + 1)}
          />
          <p className="px-1 text-[11px] text-zinc-500 dark:text-zinc-400">{ELDER_VISIBILITY_NOTE}</p>
        </>
      )}
      {deleteFailed && <p className="px-1 text-red-700 dark:text-red-300">{DELETE_FAILED_TEXT}</p>}
      <ThisPhone app={app} phone={phone} />
    </div>
  );
}

interface AccountDevicesProps {
  devices: DeviceRow[];
  /** 이 휴대폰의 handle(앱 안에서만 안다) — 목록에서 "이 휴대폰"으로 표시 */
  thisHandle: string | null;
  /** 이 화면이 열린 곳 — 0대 안내가 다르다(NoDevices) */
  app: AppKind;
  /** 앱(1.2.0+)이 보고한 이 휴대폰 상태(아직 답이 없으면 null) — 목록에 이 휴대폰이 없을 때 그 등록 상태를 보여 준다 */
  phone: PushStatus | null;
  /** 삭제 중인 휴대폰 handle(그동안 삭제 버튼을 막는다) */
  busy: string | null;
  onDelete: (handle: string) => void;
  /** 이 휴대폰 확인 중이 상한(APP_ANSWER_TIMEOUT_MS)을 넘겼다(ThisPhoneRegistration) */
  noAnswer?: boolean;
  /** 목록에서 "이 휴대폰"을 지웠다(10차 — 앱이 다시 보고할 때까지) */
  deletedHere?: boolean;
  /** 이 휴대폰 등록 상태의 "다시 시도" — 확인 중 시간을 새로 잰다(ThisPhoneRegistration) */
  onRetry?: () => void;
}

/**
 * 계정 단위 — 받는 휴대폰 요약 + 휴대폰마다 한 줄(삭제). 0대 안내는 열린 곳과 스위치(PUSH_TOKENS_LIVE)에 따라 다르다.
 *   (2026-10-08 11차) 1.2.0 앱 안인데 목록에 이 휴대폰이 없으면 — 다른 휴대폰이 있어도 — 목록 아래에 이 휴대폰의 등록 상태(확인 중 /
 *   실패 사유 + 다시 시도 / 응답 없음 + 다시 시도). 예전엔 0대일 때만 보여 줘, 다른 보호자·다른 휴대폰이 등록된 계정에선 지금 들고 있는
 *   휴대폰의 등록이 빠져도 아무 표시가 없었다. 방금 지운 경우("지웠어요")는 그대로다.
 */
export function AccountDevices({ devices, thisHandle, app, phone, busy, onDelete, noAnswer, deletedHere, onRetry }: AccountDevicesProps) {
  if (devices.length === 0) return <NoDevices app={app} phone={phone} noAnswer={noAnswer} deletedHere={deletedHere} onRetry={onRetry} />;
  const ready = devices.filter(isReady);   // 서버가 최근 확인 순으로 준다 — ready[0]이 마지막 확인
  const thisListed = devices.some((d) => d.handle === thisHandle);
  // 다른 휴대폰이 남아 있어도 "이 휴대폰"을 지운 사실은 적는다 — 그 줄이 (다시 등록돼) 목록에 돌아왔으면 적지 않는다
  const thisDeleted = deletedHere === true && !thisListed;
  // 지운 게 아닌데 목록에 없다 — 이 휴대폰 등록이 아직이거나(확인 중) 실패했다(11차)
  const thisMissing = app === "app" && !thisListed && !thisDeleted;
  return (
    <>
      {ready.length > 0 ? (
        <p className="rounded-xl bg-white/70 px-4 py-3 text-teal-900 dark:bg-zinc-900/60 dark:text-teal-100">
          📱 이 계정으로 위급 알림을 받는 휴대폰: <b>{ready.length}대</b> (마지막 확인 {fmtSeen(ready[0].updatedAt)})
        </p>
      ) : (
        <p className="rounded-xl bg-amber-50 px-4 py-3 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
          ⚠ 이 계정에 등록된 휴대폰 {devices.length}대가 모두 위급 알림이 꺼져 있어요 — 휴대폰 설정 → 애플리케이션 → 마음이음 → 알림에서 켜 주세요.
        </p>
      )}
      <ul className="space-y-1">
        {devices.map((d) => (
          <li key={d.handle} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/70 px-3 py-2 text-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-200">
            <span>
              {d.handle === thisHandle && <b className="text-teal-700 dark:text-teal-300">이 휴대폰 · </b>}
              {platformLabel(d.platform)}{d.appVersion ? ` · 앱 v${d.appVersion}` : ""} · {isReady(d) ? "알림 켜짐" : "알림 꺼짐"} · 마지막 확인 {fmtSeen(d.updatedAt)}
            </span>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => onDelete(d.handle)}
              className="shrink-0 rounded-md border border-red-300 px-2 py-0.5 text-[11px] font-semibold text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/30"
            >
              {busy === d.handle ? "삭제 중…" : "삭제"}
            </button>
          </li>
        ))}
      </ul>
      {thisDeleted && <DeletedHere />}
      {thisMissing && <ThisPhoneRegistration phone={phone} noAnswer={noAnswer} onRetry={onRetry} />}
    </>
  );
}

/** "이 휴대폰"을 목록에서 지웠다(10차 — DELETED_HERE_TEXT). 시간 상한·"다시 시도"가 없다 */
function DeletedHere() {
  return (
    <p className="rounded-xl bg-white/70 px-4 py-3 text-teal-900 dark:bg-zinc-900/60 dark:text-teal-100">{DELETED_HERE_TEXT}</p>
  );
}

interface NoDevicesProps {
  app: AppKind;
  phone: PushStatus | null;
  noAnswer?: boolean;
  /** 목록에서 "이 휴대폰"을 지웠다(10차) — 확인 중·실패·응답 없음 대신 "지웠어요" */
  deletedHere?: boolean;
  onRetry?: () => void;
}

/**
 * 등록 휴대폰 0대 — 열린 곳에 따라(2026-10-07 3차, 2026-10-08 10차에 순서를 바꿨다):
 *   · 1.2.0+ 앱 안: **스위치와 상관없이 먼저** 이 휴대폰의 마지막 등록 상태 — 이 휴대폰은 등록을 아는 앱인데 목록이 0대라는 건
 *     등록이 아직 안 끝났거나(확인 중) 실패했다는 뜻이다. 실패면 사유(한국어 — registerFailureText)와 "다시 시도"(앱에
 *     PUSH_TOKEN을 다시 요청). 등록됐다는 답이 왔는데 목록이 아직 0대면 목록을 다시 읽는 중이다(PushStatusBox) — 확인 중으로
 *     둔다. 확인 중이 상한(APP_ANSWER_TIMEOUT_MS)을 넘기면(noAnswer, 4차) "앱이 응답하지 않아요" + "다시 시도"(누르면 다시 확인 중).
 *     "이 휴대폰"을 방금 지웠으면(deletedHere) 그 셋 대신 "지웠어요"(DELETED_HERE_TEXT) — 시간 상한·"다시 시도" 없음.
 *     (10차) 예전엔 스위치가 켜지면 앱 안에서도 "앱에서 로그인·업데이트해 주세요"만 떴다 — 이미 그 앱 안에서 로그인해 있는 보호자에겐
 *     할 수 없는 안내였고, 정작 이 휴대폰 등록이 왜 빠졌는지(실패 사유·응답 없음)는 가려졌다.
 *     (11차) 그 상태 상자는 ThisPhoneRegistration — 다른 휴대폰만 목록에 있을 때도 목록 아래에 같은 상자가 나온다(AccountDevices).
 *   · 일반 브라우저·1.2.0 이전 앱: Play 배포 스위치를 켠 뒤(PUSH_TOKENS_LIVE — 1.2.0 프로덕션 단계적 출시가 100%가 된 뒤)에만 "휴대폰
 *     없음 — 앱에 로그인·업데이트" 경고(그 전엔 1.0.3이 토픽으로 받는 게 정상이다). 그 전엔 브라우저는 "앱에 로그인해 둔 휴대폰은 지금
 *     앱으로도 받는다"는 중립 안내, 1.2.0 이전 앱은 없음(아래 ThisPhone의 "이 앱 버전은 수신 확인을 지원하지 않아요"가 같은 말을 한다).
 */
export function NoDevices({ app, phone, noAnswer, deletedHere, onRetry }: NoDevicesProps) {
  if (app === "app") {
    if (deletedHere) return <DeletedHere />;
    return <ThisPhoneRegistration phone={phone} noAnswer={noAnswer} onRetry={onRetry} />;
  }
  if (PUSH_TOKENS_LIVE) {
    return (
      <div className="rounded-xl bg-amber-50 px-4 py-3 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
        <p className="font-semibold">⚠ 아직 알림을 받을 휴대폰이 없어요 — 안드로이드 마음이음 앱에서 이 계정으로 로그인해 주세요.</p>
        <p className="mt-0.5">이미 로그인해 두셨다면 앱을 최신 버전으로 업데이트해 주세요 — 이전 버전은 알림을 받는지 확인되지 않아요.</p>
      </div>
    );
  }
  if (app === "old-app") return null;
  return (
    <p className="rounded-xl bg-white/70 px-4 py-3 text-teal-900 dark:bg-zinc-900/60 dark:text-teal-100">
      안드로이드 앱에 이 계정으로 로그인해 둔 휴대폰은 지금 앱으로도 위급 알림을 받습니다. 휴대폰별 수신 확인은 새 앱(1.2.0)부터 표시돼요.
    </p>
  );
}

interface ThisPhoneRegistrationProps {
  phone: PushStatus | null;
  noAnswer?: boolean;
  onRetry?: () => void;
}

/**
 * 1.2.0 앱 안인데 목록에 이 휴대폰이 없을 때 그 등록 상태(2026-10-08 11차에 NoDevices에서 떼어 냈다 — 0대일 때와 다른 휴대폰만 목록에
 *   있을 때 같은 상자다): 실패 보고면 사유(한국어 — registerFailureText)와 "다시 시도"(앱에 PUSH_TOKEN을 다시 요청 + 확인 중 시간을
 *   새로 잰다), 확인 중이 상한(APP_ANSWER_TIMEOUT_MS)을 넘겼으면(noAnswer) "앱이 응답하지 않아요" + "다시 시도", 아니면 확인 중.
 *   등록됐다는 답이 왔는데 아직 목록에 없으면 목록을 다시 읽는 중이다(PushStatusBox) — 확인 중으로 둔다.
 */
export function ThisPhoneRegistration({ phone, noAnswer, onRetry }: ThisPhoneRegistrationProps) {
  const failed = phone !== null && !phone.registered;
  if (failed || noAnswer) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-50 px-4 py-3 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">
        {failed ? (
          <p>이 휴대폰을 알림 받을 기기로 등록하지 못했어요<span className="block">{registerFailureText(phone.reason)}</span></p>
        ) : (
          <p>앱이 응답하지 않아요. 앱을 다시 열어 주세요.</p>
        )}
        <button
          type="button"
          onClick={() => { requestNativePushToken(); onRetry?.(); }}
          className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
        >
          다시 시도
        </button>
      </div>
    );
  }
  return (
    <p className="rounded-xl bg-white/70 px-4 py-3 text-teal-900 dark:bg-zinc-900/60 dark:text-teal-100">{CHECKING_TEXT}</p>
  );
}

/** 이 휴대폰 — 1.2.0 이전 앱이면 "수신 확인 미지원"(묻지도, 설정 버튼도 없다), 알림이 꺼졌다고 보고하면 설정으로 */
export function ThisPhone({ app, phone }: { app: AppKind; phone: PushStatus | null }) {
  if (app === "old-app") {
    return (
      <p className="rounded-xl bg-zinc-100 px-4 py-3 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
        이 앱 버전은 수신 확인을 지원하지 않아요 (위급 알림은 받습니다)
      </p>
    );
  }
  if (!isPhoneOff(phone)) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-red-50 px-4 py-3 text-red-800 dark:bg-red-900/30 dark:text-red-200">
      <p className="font-semibold">🔕 이 휴대폰은 위급 알림이 꺼져 있어요</p>
      <button
        type="button"
        onClick={openNotificationSettingsAndRecheck}
        className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
      >
        알림 설정 열기
      </button>
    </div>
  );
}
