/**
 * 위급 알림(lib/chat/emergency-notify*) 테스트의 공용 목·도우미 — 2026-10-07 8차에 __tests__/emergency-notify.test.ts(2,141줄)를 주제별
 *   파일 다섯으로 나누면서 **그대로 옮겼다**(목·기본값·도우미 동작 같음 — export만 붙였다).
 *   목 체제는 하나다(prisma · push-fcm 발송 · push_device 조회 · email · crypto · dns) — "목 체제 하나당 파일 하나" 규칙
 *   (__tests__/emergency-notify-decrypt.test.ts 주석)은 그대로다: 이 모듈을 쓰는 파일은 모두 같은 목 체제다.
 *   vitest는 테스트 파일마다 모듈을 새로 읽는다 — 아래 beforeEach·notifySeq와 대상 모듈의 메모리 상한(recentSends)도 파일마다 새로 시작한다.
 *   ⚠ 테스트는 대상(@/lib/chat/emergency-notify)을 테스트 안에서 동적으로 import한다(notify()) — 이 모듈의 vi.mock이 그보다 먼저 걸린다.
 */
import { vi, beforeEach } from "vitest";

export const db = {
  message: { findFirst: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  expertPatient: { findMany: vi.fn() },
};
vi.mock("@/lib/prisma", () => ({ prisma: db }));

/** FCM 실패 한 건(6차 — lib/notify/push-fcm FcmFailure): 토큰 탓·설정 탓(영구) · 일시 */
export type Failure = { target: string; code: string; kind: "token" | "config" | "transient" };
/** 실패 한 건 — 분류는 기본 일시 */
export const fcmFail = (target: string, code: string, kind: Failure["kind"] = "transient"): Failure => ({ target, code, kind });
/** 토픽 발송 결과(lib/notify/push-fcm PushResult) — 실패마다 받는 계정·코드·분류(6차) */
export type TopicPush = { sent: number; failed: number; skipped?: string; failures: Failure[] };
export const pushMock = vi.fn<(ids: string[], payload?: unknown) => Promise<TopicPush>>(async () => ({ sent: 1, failed: 0, failures: [] }));
/** 위급 메일 한 통의 결과(6차 — lib/notify/email EmailSendResult) */
export const emailMock = vi.fn<(...a: unknown[]) => Promise<"ok" | "transient" | "permanent">>(async () => "ok");

/** 등록 휴대폰(기기 토큰) 경로 — 2026-10-07. 기본은 "등록 휴대폰 없음"(구버전 앱만 쓰는 보호자) */
export type Device = { token: string; userId: string; platform: string; appVersion: string | null; permission: string; channelBlocked: boolean; updatedAt: Date };
export type TokenPush = {
  sent: number; failed: number; invalidTokens: string[]; deliveredTokens: string[];
  /** 6차 — 실패마다 토큰·코드·분류(lib/notify/push-fcm TokenPushResult). 8차부터 throw도 따로 표시하지 않는다 — 분류가 그 실패에 실린다 */
  failures: Failure[];
};
export const defaultTokenPush = async (tokens: string[]): Promise<TokenPush> => ({ sent: tokens.length, failed: 0, failures: [], invalidTokens: [], deliveredTokens: tokens });
/** 등록 휴대폰 발송 — 토큰(첫 인자)으로 결과를 정하고, 셋째 인자로 받은 휴대폰→계정 대응(5차 data.to의 근거)을 본다 */
export type Target = { token: string; userId: string };
export const tokenPushMock = vi.fn<(tokens: string[], payload?: unknown, targets?: Target[]) => Promise<TokenPush>>(defaultTokenPush);
export const devicesMock = vi.fn<(ids: string[]) => Promise<Device[]>>(async () => []);
export const deleteTokensMock = vi.fn<(tokens: string[]) => Promise<number>>(async () => 0);
// importOriginal을 펼친다 — 부분 목은 대상 모듈의 import가 늘면 조용히 깨진다
vi.mock("@/lib/notify/push-fcm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/push-fcm")>()),
  sendEmergencyPush: (...a: unknown[]) => pushMock(...(a as [string[], unknown])),
  sendEmergencyPushToTokens: (targets: Target[], payload: unknown) => tokenPushMock(targets.map((t) => t.token), payload, targets),
}));
// 위급 알림 경로는 queryDevices(테이블 없음도 throw — 4차)를 쓴다. 화면용 getDevices는 이 파일과 상관없다
vi.mock("@/lib/push/devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/push/devices")>()),
  queryDevices: (ids: string[]) => devicesMock(ids),
  deleteTokens: (tokens: string[]) => deleteTokensMock(tokens),
}));
export const opsAlertMock = vi.fn(async () => true);
/** 보내는 Gmail 자격증명이 설정돼 있나(5차 — 없으면 이메일은 "none": 설정 문제지 발송 실패가 아니다). 기본은 설정됨 */
export const emailConfiguredMock = vi.fn(() => true);
// importOriginal을 펼친다 — 주소 형식 검사(isValidEmailAddress)는 실제 규칙을 쓴다
vi.mock("@/lib/notify/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/email")>()),
  sendEmergencyEmail: (...a: unknown[]) => emailMock(...(a as [])),
  sendOpsAlert: (...a: unknown[]) => opsAlertMock(...(a as [])),
  isEmailConfigured: () => emailConfiguredMock(),
}));
vi.mock("@/lib/crypto", () => ({ decryptPII: (s: string | null | undefined) => s ?? null, encryptPII: (s: string) => s }));
/**
 * 웹훅 SSRF 가드의 DNS 조회 — 실제 DNS에 기대면 테스트 결과가 네트워크에 따라 갈린다(2026-10-07 3차에 고정).
 *   기본은 공인 주소(통과), "private.example"만 사설 주소(차단) — 차단 경로는 __tests__/webhook-ssrf.test.ts가 자세히 본다.
 *   5차: 조회 실패(EAI_AGAIN 등)를 테스트가 정할 수 있게 vi.fn으로 둔다(beforeEach가 기본 구현으로 되돌린다).
 */
export type Lookup = (host: string) => Promise<{ address: string; family: number }[]>;
export const defaultLookup: Lookup = async (host) => [{ address: host.startsWith("private.") ? "10.0.0.5" : "93.184.216.34", family: 4 }];
export const dnsLookup = vi.fn<Lookup>(defaultLookup);
vi.mock("node:dns/promises", () => ({ default: { lookup: (host: string) => dnsLookup(host) } }));

export const P = {
  userId: "u1", userName: "김응급", level: 3 as const, category: "medical_acute",
  content: "숨이 안 쉬어져", aiReply: "119에 전화해주세요", createdAt: new Date("2026-10-01T12:00:00Z"),
};

/**
 * ⚠ 매 호출에 **고유 userId**를 쓴다(2026-10-02 적대 리뷰 지적).
 *   emergency-notify는 모듈 수준 Map(recentSends)으로 fan-out 상한을 거는데, 그 상태는
 *   테스트 간에 리셋되지 않는다. 같은 userId를 재사용하면 두 번째 호출부터 조용히 skip돼
 *   **테스트가 순서에 의존하고, 뒤 테스트가 거짓 통과한다**(실제로 이 파일에서 발생했다).
 *   dedup 자체를 보려는 테스트는 fanoutKey를 명시적으로 고정해 쓴다.
 */
let notifySeq = 0;
export async function notify(extra: Record<string, unknown> = {}) {
  const { notifyGuardian } = await import("@/lib/chat/emergency-notify");
  return notifyGuardian({ ...P, userId: `u-${++notifySeq}`, messageId: "m1", ...extra } as Parameters<typeof notifyGuardian>[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // 기본값: 중복 아님 · 보호자 이메일 있음 · 연결 보호자 1명 · 마킹 성공
  db.message.findFirst.mockResolvedValue(null);
  db.message.update.mockResolvedValue({});
  db.user.findUnique.mockResolvedValue({ guardianWebhookUrl: null, guardianEmail: "g@example.com", guardianName: "보호자" });
  db.expertPatient.findMany.mockResolvedValue([{ expertUserId: "g1" }]);
  // 앱 푸시 기본값: 토픽 수락 · 등록 휴대폰 없음 (clearAllMocks는 구현을 되돌리지 않는다 — 앞 테스트가 바꾼 값을 여기서 되돌린다)
  emailMock.mockResolvedValue("ok");
  pushMock.mockResolvedValue({ sent: 1, failed: 0, failures: [] });
  tokenPushMock.mockImplementation(defaultTokenPush);
  devicesMock.mockResolvedValue([]);
  deleteTokensMock.mockResolvedValue(0);
  opsAlertMock.mockResolvedValue(true);
  emailConfiguredMock.mockReturnValue(true);
  dnsLookup.mockImplementation(defaultLookup);
});

export const TOK_READY = "ready_" + "r".repeat(40);
export const TOK_MUTED = "muted_" + "m".repeat(40);
export const device = (userId: string, token: string, over: Partial<Device> = {}): Device => ({
  token, userId, platform: "android", appVersion: "1.2.0", permission: "granted", channelBlocked: false,
  updatedAt: new Date("2026-10-07T00:00:00Z"), ...over,
});

/** 운영자 경보 호출 — [제목, 본문 줄] */
export const opsCalls = () => opsAlertMock.mock.calls as unknown as [string, string[]][];
export const noContact = { name: "김영자", guardianWebhookUrl: null, guardianEmail: null, guardianName: null };

/**
 * 서버 자격증명이 거절된 FCM 오류(2026-10-07 8차) — firebase-admin 14가 접근 토큰 거절(서비스 계정 키 폐기 — invalid_grant)을 싸는 모양
 *   (code app/invalid-credential + 원래 오류를 따옴표 안에 실은 문구 — 뒤에 붙는 안내 문장은 줄였다). 그 모양은 __tests__/push-fcm.test.ts가
 *   실제 SDK로 만들어 본다.
 *   분류는 테스트마다 push-fcm의 실제 함수(thrownFailures — 메시지별 실패와 같은 classifyFcmError)로 붙인다.
 */
export const INVALID_GRANT = Object.assign(
  new Error(
    'Credential implementation provided to initializeApp() via the "credential" property failed to fetch a valid Google OAuth2 access ' +
    'token with the following error: "invalid_grant: Invalid JWT Signature.".',
  ),
  { code: "app/invalid-credential" },
);
