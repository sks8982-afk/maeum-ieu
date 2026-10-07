/**
 * 위급 알림을 받을 휴대폰(FCM 기기 토큰) 등록부 — raw 테이블 push_device.
 *
 * 왜 기기 토큰을 더했나 (2026-10-07 보호자 앱 푸시 추적) — 토픽(maeum_<id>)만으로는:
 *   · FCM 토픽에는 **구독 권한 검사가 없다.** maeum_<id>를 아는 기기는 누구든 그 계정의 위급 알림을 받는다.
 *   · 서버는 토픽에 받는 기기가 있는지 **모른다.** FCM은 구독자가 0명이어도 토픽 메시지를 받아들이고, 우리는
 *     그걸 sent로 셌다 — 앱에 한 번도 로그인하지 않은 보호자도 "알림 보냄"으로 집계됐다.
 *   · 함께 쓰거나 물려준 휴대폰은 **이전 계정의 구독을 계속 들고** 있을 수 있다.
 *   기기 토큰은 셋을 다 고친다:
 *   · 토큰은 **로그인한 세션만 자기 계정에** 등록한다(app/api/push/device — 계정은 본문이 아니라 세션에서 온다).
 *   · 서버가 계정마다 어떤 휴대폰이 있는지 안다(보호자 화면·어르신 마이페이지에 표시).
 *   · 같은 토큰을 다른 계정이 다시 등록하면 그 계정으로 **옮겨 간다** — 한 휴대폰은 지금 로그인한 계정의 알림만 받는다.
 *   · 기기별 발송 오류로 앱을 지운 휴대폰을 알아내 지운다(lib/notify/push-fcm sendEmergencyPushToTokens). 휴대폰이 로그아웃·
 *     계정 전환 때 폐기했다고 알려 온 토큰(retiredTokens)은 그 휴대폰의 다음 등록 때 지운다(registerDevice).
 *   토픽 사본은 없애지 않는다 — 앱은 로그인해 있는 동안 토픽 구독을 유지하고 서버도 매번 함께 보낸다(조용함보다 중복,
 *   app/RnBridge 계약). 등록 경로가 조용히 끊겨도(등록 실패·토큰 유실) 토픽 사본은 간다. 토픽엔 그래서 가린 이름만 싣는다.
 *
 * 저장: raw 테이블 push_device(token PK, user_id, platform, app_version, permission, channel_blocked, created_at, updated_at).
 *   ⚠ prisma db push 금지(raw 테이블을 지운다) — scripts/ops-push-device.ts로 만든다.
 *   테이블이 없으면(운영 스크립트보다 배포가 먼저) 화면 조회(getDevices)는 "등록 기기 없음"으로 돌려준다 — 위급 알림은
 *   queryDevices로 그 사실을 알고 0대로 보내되 운영자에게 알린다(토픽 사본은 그대로 나가 끊기지 않는다 — lib/chat/emergency-notify).
 *   그 밖의 조회 실패는 숨기지 않는다(throw → 운영자 경보).
 * 화면에는 토큰 대신 handle(deviceHandle)을 내보낸다 — 보호자 화면의 "삭제"가 그 휴대폰을 가리키는 데 쓴다.
 * 저장은 보호자·의사(pro) 계정만 한다(2026-10-07 5차, app/api/push/device POST) — 위급 알림을 받는 쪽이 그들뿐이다.
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";

export type PushPermission = "granted" | "denied" | "unknown";

/** 앱이 보고한 이 휴대폰의 상태 — 등록 요청 본문(app/api/push/device POST) */
export interface DeviceRegistration {
  token: string;
  appVersion: string | null;
  permission: PushPermission;
  channelBlocked: boolean;
  /**
   * 이 휴대폰이 지난번 등록이 성공한 뒤 deleteToken()으로 폐기한 토큰(로그아웃·계정 전환 — app/RnBridge 계약).
   *   등록하면서 그 행을 지운다(registerDevice). 검사를 통과한 것만 담기고(parseDeviceRegistration), 없으면 필드도 없다.
   */
  retiredTokens?: string[];
}

export interface PushDevice {
  token: string;
  userId: string;
  platform: string;
  appVersion: string | null;
  permission: string;
  channelBlocked: boolean;
  updatedAt: Date;
}

/** 계정별 집계 — 토큰은 싣지 않는다(화면·다른 계정에 내보내는 값) */
export interface DeviceSummary {
  count: number;
  /** 알림을 허용했고 위급 알림 채널도 막지 않았다고 보고한 휴대폰 수 */
  granted: number;
  lastSeenAt: Date | null;
}

/**
 * 한 계정에 남겨 두는 휴대폰 상한 — 넘으면 오래 확인되지 않은 것부터 지운다.
 *   왜: 등록은 세션만 있으면 되므로, 상한이 없으면 한 계정이 가짜 토큰을 끝없이 쌓을 수 있다. 위급 알림은 연결된
 *   계정들의 토큰을 **한 번에** 보내므로(FCM sendEach는 500건 상한 — 넘으면 통째로 실패) 그 한 계정 때문에 같은
 *   어르신의 **다른 보호자 알림까지** 막힌다. 가족이 한 보호자 계정을 여러 휴대폰에서 같이 쓰는 경우를 생각해 10대.
 */
export const MAX_DEVICES_PER_USER = 10;

/**
 * 등록 한 번에 받아 지우는 폐기 토큰 상한(2026-10-07 3차) — 휴대폰이 등록 사이에 로그아웃·계정 전환을 몇 번 했어도 이만하면
 *   충분하다. 더 온 것은 버린다(지우지 못한 토큰은 다음 발송 때 FCM이 "없는 기기"라고 답해 지워진다 — deleteTokens).
 */
export const MAX_RETIRED_TOKENS = 5;

const TOKEN_RE = /^[A-Za-z0-9:_\-]+$/;
const APP_VERSION_RE = /^[0-9A-Za-z.+_-]{1,32}$/;
const PERMISSIONS: readonly string[] = ["granted", "denied", "unknown"];

/** FCM 등록 토큰 모양 — 문자열, 20~4096자, 영숫자와 : _ - 만 */
export function isValidPushToken(v: unknown): v is string {
  return typeof v === "string" && v.length >= 20 && v.length <= 4096 && TOKEN_RE.test(v);
}

/**
 * 등록 요청 본문 검사 — 하나라도 형식이 틀리면 null(400).
 *   알림 허용 여부를 느슨하게 받으면(예: 문자열 "true"를 막히지 않음으로) 꺼진 휴대폰이 "받는 중"으로 보인다.
 *   틀린 본문을 거절하면 앱은 등록 실패(표시용)를 받는다 — 토픽 구독은 로그인해 있는 동안 늘 유지하므로 알림은 계속 간다.
 *   계정(userId)은 본문에서 받지 않는다 — 세션에서만 온다.
 */
export function parseDeviceRegistration(body: unknown): DeviceRegistration | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!isValidPushToken(b.token)) return null;
  if (typeof b.permission !== "string" || !PERMISSIONS.includes(b.permission)) return null;
  if (typeof b.channelBlocked !== "boolean") return null;
  const retired = retiredTokensOf(b.retiredTokens, b.token);
  return {
    token: b.token,
    // 앱 버전은 표시·점검용일 뿐이라 이상하면 비워 두고 등록은 받는다
    appVersion: typeof b.appVersion === "string" && APP_VERSION_RE.test(b.appVersion) ? b.appVersion : null,
    permission: b.permission as PushPermission,
    channelBlocked: b.channelBlocked,
    ...(retired.length > 0 ? { retiredTokens: retired } : {}),
  };
}

/**
 * 폐기 토큰 목록 검사 — 토큰 모양인 것만, 지금 등록하는 토큰은 빼고(지우면 방금 한 등록이 사라진다), 앞에서부터 상한까지.
 *   형식이 틀린 값이 섞여 있어도 **등록은 거절하지 않는다** — 지우기는 정리일 뿐인데, 등록이 막히면 실명 사본이 빠진다.
 */
function retiredTokensOf(v: unknown, current: string): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is string => isValidPushToken(t) && t !== current).slice(0, MAX_RETIRED_TOKENS);
}

/** 알림을 띄울 수 있다고 보고한 휴대폰인가 — 권한 허용 + 위급 알림 채널 안 막음 */
export function isReadyDevice(d: Pick<PushDevice, "permission" | "channelBlocked">): boolean {
  return d.permission === "granted" && !d.channelBlocked;
}

/** 테이블이 없다 = 운영 스크립트보다 배포가 먼저 나갔다. 장애가 아니라 "등록된 휴대폰 없음"이다(토픽 사본은 그대로 나간다) */
export function isMissingDeviceTable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("42P01") || msg.includes(`relation "push_device" does not exist`);
}

/** 토큰으로 행을 지운다 — 계정과 무관하다(죽은 토큰·이 휴대폰이 폐기한 토큰은 누구 계정에 있든 쓸 수 없다) */
const DELETE_TOKENS_SQL = `DELETE FROM push_device WHERE token = ANY($1::text[])`;

/** 다른 계정에서 풀어 낸 휴대폰 — 그 토큰과 그 행이 있던 계정(그 계정 토픽에서 해제하는 데 쓴다) */
export interface ReleasedDevice {
  token: string;
  userId: string;
}

/**
 * 이 휴대폰의 토큰(지금 토큰·폐기 토큰)을 **다른 계정**이 들고 있던 행을 지우고, 지운 행의 (토큰, 계정)을 돌려준다(2026-10-07 6차).
 *   등록 요청(app/api/push/device POST)이 **역할과 상관없이** 부른다 — 휴대폰은 지금 로그인한 계정의 알림만 받아야 한다.
 *   예전엔 보호자·의사만 같은 토큰을 이 계정으로 옮겼고(upsert), 어르신·일반 계정이 이전 보호자 휴대폰에 로그인하면 그 보호자의 행이
 *   그대로 남아 이 휴대폰이 그 보호자 앞 실명 사본을 계속 받았다. 지운 행의 계정은 호출부가 그 계정 토픽에서 이 토큰을 해제하는 데
 *   쓴다(최선 노력 — 응답 뒤) — 행만 지우면 이 휴대폰은 그 계정의 토픽 사본(가린 이름)을 계속 받는다.
 *   지우기와 계정 읽기는 한 문장이다(DELETE … RETURNING) — 읽은 뒤 지우는 사이에 행이 옮겨 가 엉뚱한 계정을 해제하는 일이 없다.
 *   이 계정의 행은 건드리지 않는다(보호자·의사는 이어서 upsert한다). 테이블이 없으면 [](지울 행도 없다), 그 밖의 실패는 throw.
 */
export async function releaseFromOtherAccounts(userId: string, tokens: string[]): Promise<ReleasedDevice[]> {
  if (tokens.length === 0) return [];
  try {
    const rows = await prisma.$queryRawUnsafe<{ token: string; user_id: string }[]>(
      `DELETE FROM push_device WHERE token = ANY($1::text[]) AND user_id <> $2 RETURNING token, user_id`,
      tokens, userId,
    );
    return rows.map((r) => ({ token: r.token, userId: r.user_id }));
  } catch (e) {
    if (isMissingDeviceTable(e)) return [];
    throw e;
  }
}

/**
 * 세션 계정에 이 휴대폰 등록 — 같은 토큰이 다른 계정에 있었으면 **이 계정으로 옮긴다**(의도된 동작: 휴대폰을
 *   넘겨받은 사람이 로그인하면 이전 계정의 알림이 그 휴대폰으로 가지 않게). 이어서 계정당 상한을 넘는 오래된 휴대폰을 지운다.
 *   테이블이 없으면 throw — 호출부가 isMissingDeviceTable로 503 notReady를 돌려준다(등록됐다고 거짓 응답하지 않는다).
 *
 * 폐기 토큰(retiredTokens, 2026-10-07 3차): 이 휴대폰이 로그아웃·계정 전환 때 deleteToken()으로 버린 토큰의 행을
 *   **어느 계정에 있든** 지운다. 로그아웃의 등록 해제(DELETE)가 연결 문제로 실패하면 그 행이 이전 계정에 남아, 다음
 *   발송 때 FCM이 "없는 기기"라고 답할 때까지 "받는 휴대폰"으로 보였다. 그 토큰을 들고 있다는 것 자체가 이 휴대폰
 *   것이었다는 증거다 — 같은 토큰을 이 계정으로 옮기는 위 upsert와 같은 권한이고, 새 권한은 없다.
 *   맨 먼저 지운다 — 죽은 토큰이 계정당 상한(10대) 자리를 차지해 살아 있는 휴대폰이 밀려나지 않게. 없으면 문장도 없다(예전 그대로).
 */
export async function registerDevice(userId: string, d: DeviceRegistration): Promise<void> {
  const retired = d.retiredTokens ?? [];
  await prisma.$transaction([
    ...(retired.length > 0 ? [prisma.$executeRawUnsafe(DELETE_TOKENS_SQL, retired)] : []),
    prisma.$executeRawUnsafe(
      `INSERT INTO push_device (token, user_id, app_version, permission, channel_blocked, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, app_version = EXCLUDED.app_version,
         permission = EXCLUDED.permission, channel_blocked = EXCLUDED.channel_blocked, updated_at = now()`,
      d.token, userId, d.appVersion, d.permission, d.channelBlocked,
    ),
    // 상한은 코드 상수라 SQL에 직접 넣는다(LIMIT 바인드 값의 형 추론에 기대지 않게)
    prisma.$executeRawUnsafe(
      `DELETE FROM push_device WHERE user_id = $1 AND token NOT IN (
         SELECT token FROM push_device WHERE user_id = $1 ORDER BY updated_at DESC LIMIT ${MAX_DEVICES_PER_USER})`,
      userId,
    ),
  ]);
}

interface DeviceRow {
  token: string;
  user_id: string;
  platform: string;
  app_version: string | null;
  permission: string;
  channel_blocked: boolean;
  updated_at: Date;
}

/**
 * 계정들의 등록 휴대폰(최근 확인 순) — 실패는 **모두** throw한다(테이블 없음 포함).
 *   위급 알림 경로(lib/chat/emergency-notify)가 쓴다 — 테이블 없음을 "0대"로 처리하되 운영자 경보를 내려면 그 사실을 알아야
 *   한다(2026-10-07 4차). 화면 경로는 아래 getDevices(테이블이 없으면 빈 목록)를 쓴다.
 */
export async function queryDevices(userIds: string[]): Promise<PushDevice[]> {
  if (userIds.length === 0) return [];
  const rows = await prisma.$queryRawUnsafe<DeviceRow[]>(
    `SELECT token, user_id, platform, app_version, permission, channel_blocked, updated_at
       FROM push_device WHERE user_id = ANY($1::text[]) ORDER BY updated_at DESC`,
    userIds,
  );
  return rows.map((r) => ({
    token: r.token, userId: r.user_id, platform: r.platform, appVersion: r.app_version,
    permission: r.permission, channelBlocked: r.channel_blocked, updatedAt: r.updated_at,
  }));
}

/** 화면용 계정들의 등록 휴대폰(최근 확인 순) — 테이블이 없으면 빈 목록, 그 밖의 실패는 throw */
export async function getDevices(userIds: string[]): Promise<PushDevice[]> {
  try {
    return await queryDevices(userIds);
  } catch (e) {
    if (isMissingDeviceTable(e)) {
      console.error(
        "[push-device] 🔴 push_device 테이블 없음 — 등록 휴대폰 0대로 처리한다(토픽 사본만 나간다). scripts/ops-push-device.ts 실행 필요",
      );
      return [];
    }
    throw e;
  }
}

const HANDLE_RE = /^[0-9a-f]{16}$/;

/**
 * 화면에 내보내는 휴대폰 식별자 — 토큰 sha256의 앞 16자(hex).
 *   토큰은 그 휴대폰으로 알림을 보낼 수 있는 값이라 화면에 내보내지 않는다. handle은 토큰으로 되돌릴 수 없고, 세션 계정의
 *   휴대폰을 가리킬 때만 쓴다(보호자 화면 "삭제"). 앱 안 화면은 같은 규칙으로 "이 휴대폰"을 찾는다(app/RnBridge thisPhoneHandle).
 */
export function deviceHandle(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

export function isValidDeviceHandle(v: unknown): v is string {
  return typeof v === "string" && HANDLE_RE.test(v);
}

/**
 * 이 계정 휴대폰 중 handle이 가리키는 토큰(보호자 화면 "삭제") — user_id = 세션 계정 안에서만 찾으므로 남의 계정 휴대폰은
 *   handle을 알아도 찾지 못한다. 테이블이 없으면 빈 목록(getDevices).
 *   찾기와 지우기를 나눈 이유(2026-10-07 5차): 호출부가 그 휴대폰을 이 계정 토픽에서 **먼저** 해제하고, 해제가 확인돼야
 *   행을 지운다(app/api/push/device DELETE { handle }) — 해제가 실패했는데 행부터 지우면 목록에선 사라졌는데 그 휴대폰은 토픽
 *   사본(가린 이름)을 계속 받고, 보호자는 다시 지울 방법도 없다.
 */
export async function tokensForHandle(userId: string, handle: string): Promise<string[]> {
  return (await getDevices([userId]))
    .filter((d) => d.userId === userId && deviceHandle(d.token) === handle)
    .map((d) => d.token);
}

/** 이 계정의 그 토큰들만 해제 — 지울 때도 user_id로 묶는다(남의 계정에 옮겨 간 같은 토큰은 건드리지 않는다). 지운 수 */
export async function unregisterDeviceTokens(userId: string, tokens: string[]): Promise<number> {
  if (tokens.length === 0) return 0;
  return prisma.$executeRawUnsafe(`DELETE FROM push_device WHERE user_id = $1 AND token = ANY($2::text[])`, userId, tokens);
}

/** 이 계정의 그 토큰만 해제(로그아웃) — 남의 계정에 등록된 같은 토큰은 건드리지 않는다. 지운 수를 돌려준다 */
export async function unregisterDevice(userId: string, token: string): Promise<number> {
  try {
    return await prisma.$executeRawUnsafe(`DELETE FROM push_device WHERE token = $1 AND user_id = $2`, token, userId);
  } catch (e) {
    if (isMissingDeviceTable(e)) return 0;   // 테이블이 없으면 해제할 등록도 없다
    throw e;
  }
}

/** FCM이 "없는 기기"라고 답한 토큰 삭제(앱 삭제·재설치·토큰 만료) — 계정과 무관하게 그 토큰은 죽었다 */
export async function deleteTokens(tokens: string[]): Promise<number> {
  if (tokens.length === 0) return 0;
  return prisma.$executeRawUnsafe(DELETE_TOKENS_SQL, tokens);
}

/** 계정별 휴대폰 집계 — 요청한 계정은 모두 들어 있다(없으면 0대) */
export async function summarizeDevices(userIds: string[]): Promise<Map<string, DeviceSummary>> {
  const summary = new Map<string, DeviceSummary>(userIds.map((id) => [id, { count: 0, granted: 0, lastSeenAt: null }]));
  for (const d of await getDevices(userIds)) {
    const s = summary.get(d.userId);
    if (!s) continue;
    summary.set(d.userId, {
      count: s.count + 1,
      granted: s.granted + (isReadyDevice(d) ? 1 : 0),
      lastSeenAt: s.lastSeenAt && s.lastSeenAt > d.updatedAt ? s.lastSeenAt : d.updatedAt,
    });
  }
  return summary;
}
