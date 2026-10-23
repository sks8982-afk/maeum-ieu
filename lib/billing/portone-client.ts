/**
 * 포트원 서버 SDK(@portone/server-sdk 0.19.0) 접점 — **서버 전용**(API Secret을 쓴다). 클라이언트 컴포넌트에서 import 금지.
 *
 * SDK 함정(research B 6·8 — SDK 원본 타입으로 확인):
 *   · 클라이언트는 PortOneClient({ secret }) **객체 인자**로 만든다 — 문자열로 넘기면 secret이 비어 401이 난다.
 *   · 오류는 e.data.type으로 가른다(RestError 하위 클래스). getPayment는 결제가 없으면 null이 아니라 PAYMENT_NOT_FOUND를 던진다.
 *   · 예약이 남은 빌링키는 지울 수 없다(409 PAYMENT_SCHEDULE_ALREADY_EXISTS) — **예약 취소 → 빌링키 삭제** 순서를 지킨다.
 *   · SDK 0.19.0은 Idempotency-Key 헤더를 지원하지 않는다 — 회차별로 정해진 paymentId와 currentCancellableAmount로 대신한다.
 * 시험은 vi.mock("@portone/server-sdk")로 PortOneClient만 바꾼다(오류 클래스는 진짜를 쓴다).
 */
import { createHash } from "node:crypto";
import { PortOneClient, RestError } from "@portone/server-sdk";
import { decryptPII, isEncryptedPII } from "@/lib/crypto";
import { expectedChannelType } from "@/lib/billing/portone-plans";

let cached: { secret: string; client: PortOneClient } | null = null;

/** 포트원 클라이언트 — secret이 바뀌면(키 교체) 새로 만든다 */
export function portone(): PortOneClient {
  const secret = process.env.PORTONE_API_SECRET?.trim() ?? "";
  if (!cached || cached.secret !== secret) cached = { secret, client: PortOneClient({ secret }) };
  return cached.client;
}

/** 포트원 오류의 종류(e.data.type) — SDK 오류가 아니면(네트워크·시간 초과 등) null */
export function portoneErrorType(e: unknown): string | null {
  if (!(e instanceof RestError)) return null;
  const type = (e.data as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

/** PG가 준 실패 메시지(PG_PROVIDER) — 네이버페이는 가공하지 말고 그대로 보여 줘야 한다(research B10) */
export function pgMessageOf(e: unknown): string | null {
  if (portoneErrorType(e) !== "PG_PROVIDER") return null;
  const msg = ((e as RestError).data as { pgMessage?: unknown }).pgMessage;
  return typeof msg === "string" && msg.trim() ? msg : null;
}

/** 빌링키 지문 — 원장에는 원문 대신 이것만 둔다(포트원 조회 결과의 billingKey와 대조용) */
export function billingKeyFingerprint(billingKey: string): string {
  return createHash("sha256").update(billingKey).digest("hex").slice(0, 32);
}

/**
 * 저장된 빌링키 암호문 → 원문. 없으면 null.
 *   ⚠ 복호에 실패하면(ENCRYPTION_KEY 교체 등) 암호문이 그대로 돌아온다(lib/crypto) — 그 값으로 포트원을 부르면 엉뚱한 오류가 나므로
 *   여기서 막고 크게 알린다. 키를 되돌리기 전에는 그 구독의 결제·해지를 포트원에서 할 수 없다.
 */
export function readBillingKey(billingKeyEnc: string | null): string | null {
  if (!billingKeyEnc) return null;
  const plain = decryptPII(billingKeyEnc);
  if (!plain || isEncryptedPII(plain)) throw new Error("빌링키 복호 실패 — ENCRYPTION_KEY 확인 필요");
  return plain;
}

const DAY_MS = 86_400_000;

/**
 * 이 빌링키로 건 결제 id의 예약 상태(포트원 기준 — SCHEDULED·STARTED·PENDING·SUCCEEDED·FAILED·REVOKED…), 예약이 없으면 null.
 *   결제 예정 시각이 지났는데 결제가 없을 때 "예약이 늦게 실행되는 중"·"콘솔·결제사에서 취소됨"·"예약이 아예 없음(생성 유실)"을 가른다
 *   (lib/billing/portone-maintenance settleOverdue — 취소된 예약을 지금 결제로 되살리지 않게, 2026-10-22 검토).
 *   다건 조회의 기본 범위는 '지난 90일'이라 예정 시각 앞뒤로 범위를 준다. 시험·실연동은 모드에 맞춘다(isForTest).
 */
export async function scheduleStatusFor(billingKey: string, paymentId: string, dueAt: Date, now = new Date()): Promise<string | null> {
  const { items } = await portone().payment.paymentSchedule.getPaymentSchedules({
    filter: {
      billingKey, from: new Date(dueAt.getTime() - 2 * DAY_MS).toISOString(), until: new Date(now.getTime() + DAY_MS).toISOString(),
      isForTest: expectedChannelType() === "TEST",
    },
    page: { number: 0, size: 50 },
  });
  const mine = items.flatMap((s) => ("paymentId" in s && s.paymentId === paymentId ? [s] : []))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // 같은 결제 id로 다시 건 예약이 있으면 마지막 것
  return mine.length > 0 ? String(mine[0].status) : null;
}

/** 예약 결제 취소 결과 — 이미 실행된 예약이 있으면(already_processed) 그 회차를 확인한 뒤 환불 규정을 적용해야 한다 */
export type RevokeResult = "revoked" | "none" | "already_processed";

/** 이 빌링키의 예약 결제를 모두 취소 — 빌링키를 지우기 **전에** 반드시 먼저(research B15) */
export async function revokeAll(billingKey: string): Promise<RevokeResult> {
  try {
    await portone().payment.paymentSchedule.revokePaymentSchedules({ billingKey });
    return "revoked";
  } catch (e) {
    const t = portoneErrorType(e);
    if (t === "PAYMENT_SCHEDULE_NOT_FOUND" || t === "PAYMENT_SCHEDULE_ALREADY_REVOKED"
      || t === "BILLING_KEY_ALREADY_DELETED" || t === "BILLING_KEY_NOT_FOUND") return "none";
    if (t === "PAYMENT_SCHEDULE_ALREADY_PROCESSED") return "already_processed";
    throw e;
  }
}

/**
 * 빌링키 삭제 — 이미 지워졌으면 성공으로 본다.
 *   네이버페이는 reason·requester가 필수다. reason에 전화번호 같은 개인정보를 넣지 않는다.
 */
export async function deleteKey(billingKey: string, requester: "CUSTOMER" | "ADMIN" = "CUSTOMER"): Promise<void> {
  try {
    await portone().payment.billingKey.deleteBillingKey({ billingKey, reason: "정기결제 해지", requester });
  } catch (e) {
    const t = portoneErrorType(e);
    if (t === "BILLING_KEY_ALREADY_DELETED" || t === "BILLING_KEY_NOT_FOUND" || t === "BILLING_KEY_NOT_ISSUED") return;
    throw e;
  }
}

/**
 * 예약 취소 → 빌링키 삭제(이 순서로만). 예약이 방금 실행됐으면(already_processed) onAlreadyProcessed로 그 결제를 먼저
 *   확인한다(해지 뒤 결제된 회차는 lib/billing/portone-sync markPaid가 전액 취소한다) — 그 뒤 남은 예약을 한 번 더 취소한다.
 */
export async function revokeThenDeleteKey(
  billingKey: string, onAlreadyProcessed: () => Promise<void>, requester: "CUSTOMER" | "ADMIN" = "CUSTOMER",
): Promise<void> {
  if ((await revokeAll(billingKey)) === "already_processed") {
    await onAlreadyProcessed();
    await revokeAll(billingKey);
  }
  await deleteKey(billingKey, requester);
}
