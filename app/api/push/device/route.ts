/**
 * 이 휴대폰을 위급 알림 수신 기기로 등록·해제·조회 — 규칙은 lib/push/devices.ts.
 *
 * POST   { token, appVersion, permission, channelBlocked, retiredTokens? } → **세션 계정**에 등록(같은 토큰이 다른 계정에 있었으면
 *          이 계정으로 옮긴다). retiredTokens = 이 휴대폰이 폐기한 토큰 — 그 행은 어느 계정에 있든 지운다(lib/push/devices registerDevice).
 *          응답 뒤(after()) 이 휴대폰을 세션 계정 토픽(maeum_<id>)에도 서버 쪽으로 구독시킨다 — 등록 행과 상관없이(503·DB 실패여도).
 *          **보호자·의사(pro) 계정만** 저장·구독한다(2026-10-07 5차). 다른 역할은 폐기 토큰 행만 지우고 { ok:true, stored:false }.
 *          (6차) 역할과 상관없이 먼저, 지금 토큰·폐기 토큰을 **다른 계정**이 들고 있던 행을 지우고 응답 뒤 그 계정 토픽에서도 뺀다
 *          (lib/push/devices releaseFromOtherAccounts — 휴대폰은 지금 로그인한 계정의 알림만 받는다).
 * DELETE { token }                                        → 세션 계정의 그 토큰만 해제(로그아웃 직전 — app/RnBridge logoutAndNotifyNative).
 *                                                            **토픽은 건드리지 않는다**(2026-10-07 4차) — 로그아웃이 확인되면 앱이 토큰을
 *                                                            폐기해(deleteToken) 그 토큰의 구독도 끝난다.
 * DELETE { handle }                                         → 세션 계정 휴대폰 중 그 handle만 해제(보호자 화면 "삭제" — app/expert/PushStatusBox).
 *                                                            그 휴대폰을 세션 계정 토픽에서 **먼저** 해제하고(최대 15초) 확인돼야 행을
 *                                                            지운다(5차). 해제가 실패하면 행은 그대로 — 502 { ok:false, reason:"topic" }.
 *                                                            (6차) "없는 기기"(앱을 지운 휴대폰)는 해제된 것으로 친다.
 *                                                            (7차) FCM을 쓸 수 없으면(자격증명 없음·형식 오류·다른 Firebase 프로젝트)
 *                                                            해제를 확인할 수 없다 — 행은 그대로, 503 { ok:false, reason:"unconfigured" }.
 *   둘 다 멱등({ ok:true, removed:n }).
 * GET                                                       → { devices: [{ handle, platform, appVersion, permission, channelBlocked, updatedAt }] }
 *                                                            보내기 전에 FCM 시험 발송(dry run)으로 앱을 지운 휴대폰을 걸러 지운다
 *                                                            (계정당 10분에 한 번·5초 상한 — 실패하면 목록 그대로).
 *
 * 왜 세션이 있어야만 등록하나: 토픽(maeum_<id>)은 이름만 알면 누구든 구독해 남의 위급 알림을 받을 수 있었다. 토큰은
 *   **로그인한 세션이 자기 계정에만** 붙인다 — 계정은 본문이 아니라 세션에서 온다(본문의 userId는 읽지 않는다).
 * 토큰은 응답으로 **절대 돌려주지 않는다** — 토큰이 있으면 그 휴대폰으로 알림을 보낼 수 있다. 대신 handle(토큰 sha256 앞
 *   16자 — 되돌릴 수 없다)을 준다. 지울 때 handle은 세션 계정의 휴대폰 안에서만 찾는다.
 * 등록이 실패하면(503 notReady 포함) 앱은 PUSH_REGISTER_FAILED를 받는다 — 표시용이다. 앱은 로그인해 있는 동안 토픽 구독을
 *   늘 유지하므로(app/RnBridge 계약) 토픽 사본은 계속 받는다.
 */
import { NextResponse, after } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { findGoneTokens, subscribeToUserTopic, unsubscribeFromUserTopic } from "@/lib/notify/push-fcm";
import {
  deleteTokens, deviceHandle, getDevices, isMissingDeviceTable, isValidDeviceHandle, isValidPushToken, parseDeviceRegistration,
  registerDevice, releaseFromOtherAccounts, tokensForHandle, unregisterDevice, unregisterDeviceTokens, type PushDevice,
  type ReleasedDevice,
} from "@/lib/push/devices";
import { resolveViewerRole } from "@/lib/roles";

const NOT_READY = { error: "위급 알림 휴대폰 등록은 아직 준비 중이에요. 잠시 후 다시 시도해 주세요.", notReady: true };
const UNAUTHORIZED = { error: "로그인이 필요합니다." };
const TOO_MANY = { error: "잠시 후 다시 시도해주세요." };
const BAD_DEVICE = { error: "알림 기기 정보 형식 오류" };

/** 화면에 내보내는 모양 — 토큰·계정 id를 뺀다(handle은 삭제 요청이 이 휴대폰을 가리키는 데 쓴다) */
function publicDevice(d: PushDevice) {
  return {
    handle: deviceHandle(d.token),
    platform: d.platform, appVersion: d.appVersion, permission: d.permission, channelBlocked: d.channelBlocked, updatedAt: d.updatedAt,
  };
}

/** 해제 대상 — { token }(이 휴대폰, 로그아웃) 또는 { handle }(목록의 휴대폰). 둘 다 형식이 틀리면 null(400) */
function deleteTarget(body: unknown): { token: string } | { handle: string } | null {
  const b = (typeof body === "object" && body !== null ? body : {}) as { token?: unknown; handle?: unknown };
  if (isValidPushToken(b.token)) return { token: b.token };
  if (isValidDeviceHandle(b.handle)) return { handle: b.handle };
  return null;
}

/** 보호자 목록(GET)의 등록 토큰 점검 간격 — 계정당 10분에 한 번(이 인스턴스 메모리). 목록을 열 때마다 FCM을 부르지 않게 */
const TOKEN_CHECK_EVERY_MS = 10 * 60 * 1000;
/** 계정 → 마지막 점검 시각 */
const lastTokenCheck = new Map<string, number>();

/**
 * 보호자 본인 목록에서 앱을 지운 휴대폰을 걸러 지운다(2026-10-07 4차) — FCM 시험 발송(dry run, lib/notify/push-fcm findGoneTokens).
 *   왜: 예전엔 다음 위급 알림을 보낼 때에야 "없는 기기"를 알아냈다. 그때까지 보호자 화면은 앱을 지운 휴대폰을 "받는 휴대폰"으로
 *   보여 줬다 — 보호자가 받는 줄 알고 넘어간다. 계정당 10분에 한 번만, 5초 상한. 실패는 무시하고 목록을 그대로 돌려준다
 *   (점검은 보조다 — 목록이 안 보이면 더 나쁘다).
 */
async function withoutGoneTokens(userId: string, devices: PushDevice[]): Promise<PushDevice[]> {
  const now = Date.now();
  for (const [id, at] of lastTokenCheck) if (now - at >= TOKEN_CHECK_EVERY_MS) lastTokenCheck.delete(id);
  if (devices.length === 0 || lastTokenCheck.has(userId)) return devices;
  lastTokenCheck.set(userId, now);
  const gone = new Set(await findGoneTokens(devices.map((d) => d.token)));
  if (gone.size === 0) return devices;
  try {
    await deleteTokens([...gone]);
  } catch (e) {
    console.warn("[push-device] 앱을 지운 휴대폰 삭제 실패(목록은 그대로):", e instanceof Error ? e.message : e);
    return devices;
  }
  return devices.filter((d) => !gone.has(d.token));
}

/**
 * 저장하지 않는 역할의 폐기 토큰 정리 — 테이블이 없으면 지울 행도 없다(성공으로 본다). 그 밖의 실패는 throw(500) — 앱은
 *   등록 실패를 받고 폐기 목록을 들고 있다가 다음 PUSH_TOKEN에 다시 보낸다.
 */
async function deleteRetiredTokens(tokens: string[]): Promise<void> {
  try {
    await deleteTokens(tokens);
  } catch (e) {
    if (!isMissingDeviceTable(e)) throw e;
  }
}

/**
 * 다른 계정에서 풀어 낸 휴대폰을 **그 계정** 토픽에서 해제(2026-10-07 6차) — 응답 뒤(after), 최선 노력(실패는 push-fcm이 로그).
 *   계정마다 한 번에. 행만 지우면 그 휴대폰은 이전 계정의 토픽 사본(가린 이름)을 계속 받는다(앱이 계정을 바꾸며 토큰을 폐기했다면
 *   그 토큰은 이미 죽어 "없는 기기"로 끝난다 — 그것도 해제로 친다, lib/notify/push-fcm).
 */
async function unsubscribeReleased(released: ReleasedDevice[]): Promise<void> {
  const byOwner = new Map<string, string[]>();
  for (const r of released) byOwner.set(r.userId, [...(byOwner.get(r.userId) ?? []), r.token]);
  for (const [owner, tokens] of byOwner) await unsubscribeFromUserTopic(tokens, owner);
}

/** FCM을 쓸 수 없어 휴대폰 삭제를 미룬다는 안내를 이 인스턴스에서 한 번만 — 삭제 시도마다 찍지 않는다(DELETE { handle }) */
let warnedNoFcm = false;

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(UNAUTHORIZED, { status: 401 });
  const devices = await withoutGoneTokens(session.user.id, await getDevices([session.user.id]));
  return NextResponse.json({ devices: devices.map(publicDevice) });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(UNAUTHORIZED, { status: 401 });
  const userId = session.user.id;
  const rl = await checkRateLimit(`push-device:${userId}`, 20, 60_000);
  if (!rl.ok) return NextResponse.json(TOO_MANY, { status: 429 });

  const reg = parseDeviceRegistration(await req.json().catch(() => null));
  if (!reg) return NextResponse.json(BAD_DEVICE, { status: 400 });
  /**
   * 보호자·의사(pro) 계정만 저장한다(2026-10-07 5차) — 위급 알림을 받는 쪽이 그들뿐이다. 역할은 세션의 screeningMode(가입 때
   *   정해지고 바꿀 수 없다 — app/api/users/profile, lib/roles resolveViewerRole). 다른 역할(어르신·일반인)은 휴대폰 행도
   *   서버 쪽 토픽 구독도 만들지 않는다(개인정보처리방침 1·7항).
   */
  const stores = Boolean(resolveViewerRole(session.user.screeningMode));
  /**
   * 토픽 사본도 붙인다(저장하는 역할만) — 응답을 보낸 **뒤에**(after), **등록 행과 상관없이**(2026-10-07 3·4차). 그래서 DB를
   *   건드리기 전에 맡긴다.
   *   · 로그인한 앱 휴대폰은 모두 maeum_<세션 id> 구독을 유지해야 한다(조용함보다 중복 — app/RnBridge 계약). 행이 저장되지
   *     않아도(테이블이 없어 503, DB 실패) 토픽 사본은 그 행과 무관하게 나가므로 구독은 한다.
   *   · 응답 뒤라 FCM이 느려도 등록 응답(로그아웃이 기다리는 등록 포함)을 붙잡지 않는다. after는 응답이 오류로 끝나도 돈다.
   *   최선 노력(5초 — subscribeToUserTopic). 멱등이고, 토픽 이름은 발송과 같은 규칙이다. 앱도 다시 구독한다(계약).
   */
  if (stores) after(() => subscribeToUserTopic([reg.token], userId));
  /**
   * 이 휴대폰의 토큰(지금 토큰·폐기 토큰)을 **다른 계정**이 들고 있던 행은 **역할과 상관없이** 지운다(2026-10-07 6차) — 휴대폰은
   *   지금 로그인한 계정의 알림만 받아야 한다. 예전엔 어르신·일반 계정이 이전 보호자 휴대폰에 로그인해도 그 보호자의 행이 남아,
   *   이 휴대폰이 그 보호자 앞 실명 사본을 계속 받았다. 지운 행의 계정 토픽에서도 이 토큰을 뺀다 — 응답 뒤(after), 최선 노력
   *   (unsubscribeReleased). 테이블이 없으면 지울 행도 없다. 그 밖의 DB 실패는 throw(500) — 앱은 등록 실패를 받고 다음
   *   PUSH_TOKEN에 다시 보낸다(폐기 토큰 정리와 같은 규칙).
   */
  const released = await releaseFromOtherAccounts(userId, [reg.token, ...(reg.retiredTokens ?? [])]);
  if (released.length > 0) after(() => unsubscribeReleased(released));
  /**
   * 저장하지 않는 역할 — 남은 폐기 토큰(retiredTokens) 행도 지운다(이 계정에 남은 옛 행일 수 있다). 응답은 { ok:true, stored:false }
   *   — 앱에 PUSH_REGISTERED가 가 폐기 목록을 비운다(app/RnBridge).
   */
  if (!stores) {
    await deleteRetiredTokens(reg.retiredTokens ?? []);
    return NextResponse.json({ ok: true, stored: false });
  }
  try {
    await registerDevice(userId, reg);
  } catch (e) {
    // 테이블이 없으면 등록됐다고 거짓 응답하지 않는다 — 앱·화면이 "등록됨"으로 보이면 실명 사본이 안 나가는 걸 아무도 모른다
    if (isMissingDeviceTable(e)) return NextResponse.json(NOT_READY, { status: 503 });
    throw e;
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json(UNAUTHORIZED, { status: 401 });
  const userId = session.user.id;
  // 등록(POST)과 다른 버킷 — 앱이 PUSH_TOKEN을 몰아 보내 등록 한도를 채워도 로그아웃·삭제는 막히지 않게
  const rl = await checkRateLimit(`push-device-del:${userId}`, 30, 60_000);
  if (!rl.ok) return NextResponse.json(TOO_MANY, { status: 429 });

  const target = deleteTarget(await req.json().catch(() => null));
  if (!target) return NextResponse.json(BAD_DEVICE, { status: 400 });
  // 이 계정에 등록된 것만 — 남의 계정에 옮겨 간 같은 토큰·남의 휴대폰 handle은 지우지 않는다
  if ("token" in target) {
    /**
     * 로그아웃 — 등록만 지운다. **토픽은 건드리지 않는다**(2026-10-07 4차). 예전엔 여기서 서버가 토픽에서도 뺐는데, 로그아웃이
     *   확인되지 않으면(signOut 실패·csrf 거절) 웹이 등록을 되살리고 다시 구독시킨다 — 그 구독과 이 해제가 FCM에서 엇갈려
     *   로그인한 채 토픽 사본이 빠질 수 있었다. 로그아웃이 확인되면 앱이 이 토큰을 폐기해(deleteToken) 그 구독도 끝난다.
     */
    return NextResponse.json({ ok: true, removed: await unregisterDevice(userId, target.token) });
  }
  const tokens = await tokensForHandle(userId, target.handle);
  if (tokens.length === 0) return NextResponse.json({ ok: true, removed: 0 });
  /**
   * 목록에서 지운 휴대폰 — 그 앱은 해제를 모르고 로그인해 있는 동안 토픽 구독을 유지한다(app/RnBridge 계약). 서버가 이 계정
   *   토픽에서 빼야 토픽 사본(가린 이름)까지 멈춘다. **해제를 먼저**, 끝까지 기다린다(최대 15초 — unsubscribeFromUserTopic).
   *   해제가 확인돼야 행을 지운다(2026-10-07 5차) — 예전엔 행부터 지우고 해제가 실패해도 "삭제됨"이라, 목록에선 사라졌는데 그
   *   휴대폰은 토픽 사본을 계속 받았고 보호자는 다시 지울 방법도 없었다. 실패하면 행은 그대로 두고 502 { ok:false, reason:"topic" }
   *   — 보호자 화면은 "삭제하지 못했어요"를 보여 주고 줄이 남아 다시 시도할 수 있다(app/expert/PushStatusBox).
   *   해제로 치는 것(6차): FCM이 그 토큰을 "없는 기기"(IID NOT_FOUND)라고 답한 것 — 앱을 지운 휴대폰이라 토픽 사본을 받을 수 없다
   *   (예전엔 이것도 실패라 그 줄은 끝내 지울 수 없었다).
   *   FCM을 쓸 수 없으면(7차 — 자격증명 없음·형식 오류·다른 Firebase 프로젝트, push-fcm "unconfigured") 해제를 확인할 수 없다 —
   *   행은 그대로 두고 503 { ok:false, reason:"unconfigured" }. 6차는 "이 서버는 토픽 사본을 보내지 않으니 해제할 것도 없다"며 행을
   *   지우고 200을 줬지만, 그 휴대폰의 FCM 구독은 그대로라 자격증명이 고쳐지는 순간(또는 자격증명이 있는 다른 배포에서) 토픽
   *   사본을 다시 받는다 — "삭제됨"이 거짓이었다. 보호자 화면은 다른 실패와 같은 "다시 시도" 문구를 보여 준다(app/expert/PushStatusBox).
   *   안내 로그는 인스턴스당 한 번(FCM을 못 쓰는 까닭은 push-fcm이 따로 한 번 찍는다).
   */
  const revoked = await unsubscribeFromUserTopic(tokens, userId);
  if (revoked === "failed") return NextResponse.json({ ok: false, reason: "topic" }, { status: 502 });
  if (revoked === "unconfigured") {
    if (!warnedNoFcm) {
      warnedNoFcm = true;
      console.warn("[push-device] FCM을 쓸 수 없음 — 휴대폰 삭제를 미룬다(토픽 해제를 확인할 수 없어 행은 그대로, 503)");
    }
    return NextResponse.json({ ok: false, reason: "unconfigured" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, removed: await unregisterDeviceTokens(userId, tokens) });
}
