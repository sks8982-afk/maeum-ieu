/**
 * 포트원 정기결제(lib/billing/portone-*) 테스트 공용 목 — 메모리 DB(prisma 일부) · 가짜 포트원 · 메일 스파이.
 *
 * 왜 메모리 DB인가: 결제 흐름은 상태 기계다(pending → activating → active → grace → expired …). 호출마다 반환값을 목으로 짜면
 *   "다음 호출이 앞 호출의 결과를 본다"를 시험할 수 없다. 여기 DB는 이 모듈들이 쓰는 prisma 연산만(조건·정렬·조건부 갱신) 흉내 낸다.
 *   운영 DB의 부분 유일 인덱스(어르신 1명당 살아 있는 포트원 이용권 하나 — scripts/ops-billing-pg.ts)도 같이 지킨다(P2002).
 * 가짜 포트원은 SDK 0.19.0의 진짜 오류 클래스(Payment.*Error)를 던진다 — 대상 코드의 e.data.type 분기가 실제와 같은 값을 본다.
 * 메일은 lib/notify/email의 sendServiceEmail·sendOpsAlert만 바꾼다(나머지는 원본).
 *
 * 쓰는 법: 이 모듈을 먼저 import하고, 대상은 테스트 안에서 동적으로 import한다(emergency-notify-harness와 같은 규칙).
 *   시각은 vi.useFakeTimers({ toFake: ["Date"] }) + vi.setSystemTime으로 맞춘다 — DB의 createdAt·updatedAt도 그 시각을 쓴다.
 */
import { vi, beforeEach, afterAll } from "vitest";
import type * as Sdk from "@portone/server-sdk";

/** 사업자 정보(BIZ_*) — 판매 스위치가 켜지려면 다 있어야 한다(lib/billing/portone-plans pgConfigProblems). 시험용 값(실제 정보 아님) */
export const BIZ_ENV: Record<string, string> = {
  BIZ_NAME: "주식회사 시험상호", BIZ_OWNER: "홍길동", BIZ_ADDRESS: "경기도 화성시 시험로 1", BIZ_PHONE: "031-000-0000",
  BIZ_EMAIL: "help@example.com", BIZ_REG_NO: "220-81-62517", BIZ_MAIL_ORDER_NO: "제2026-화성-0000호", BIZ_MAIL_ORDER_AUTHORITY: "화성시",
};

/** 이 하네스가 바꾸는 env — 파일이 끝나면 원래 값으로 되돌린다(같은 워커에서 도는 다른 시험 파일로 새지 않게) */
const ENV_KEYS = [
  "DAILY_TURN_LIMIT", "ENCRYPTION_KEY", "BILLING_PG_ENABLED", "PORTONE_STORE_ID", "PORTONE_API_SECRET", "PORTONE_WEBHOOK_SECRET",
  "PORTONE_CHANNEL_KEY_CARD", "PORTONE_CHANNEL_KEY_KAKAOPAY", "PORTONE_CHANNEL_KEY_NAVERPAY", "PORTONE_MODE", "NEXTAUTH_URL",
  "BILLING_PLANS", "CRON_SECRET", "PORTONE_TEST_USER_IDS", ...Object.keys(BIZ_ENV),
];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const [k, v] of Object.entries(ORIGINAL_ENV)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

// 모듈 상수가 import 시점에 읽는 값 — 대상보다 먼저 정한다(시험용 고정 키 — 비밀값 아님)
process.env.DAILY_TURN_LIMIT = "10";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const sdk = await vi.importActual<typeof Sdk>("@portone/server-sdk");
export const { Payment } = sdk;

// ───────────────────────────── 메모리 DB ─────────────────────────────
type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const eq = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b || (a == null && b == null));
const cmp = (a: unknown, b: unknown) => (a instanceof Date ? a.getTime() : (a as number)) - (b instanceof Date ? b.getTime() : (b as number));

/** prisma.<모델>.fields.<칸> 흉내 — 조건 값으로 쓰면 같은 행의 그 칸 값과 비교한다(Prisma 필드 참조, 예: 목표액 > 누적 취소액) */
const FIELD_REF = Symbol("fieldRef");
type FieldRef = { [FIELD_REF]: true; name: string };
const isFieldRef = (x: unknown): x is FieldRef => typeof x === "object" && x !== null && FIELD_REF in x;
const fieldRefs = (names: string[]) => Object.fromEntries(names.map((name) => [name, { [FIELD_REF]: true, name } as FieldRef]));

/** 조건 안의 필드 참조를 그 행의 값으로 바꾼다 */
function resolveRefs(cond: unknown, row: Row): unknown {
  if (cond === null || typeof cond !== "object" || cond instanceof Date || Array.isArray(cond)) return cond;
  return Object.fromEntries(Object.entries(cond as Row).map(([op, x]) => [op, isFieldRef(x) ? row[x.name] : x]));
}

function matchField(v: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== "object" || cond instanceof Date) return eq(v, cond);
  for (const [op, x] of Object.entries(cond as Row)) {
    const ok = (() => {
      switch (op) {
        case "in": return (x as unknown[]).some((y) => eq(v, y));
        case "notIn": return !(x as unknown[]).some((y) => eq(v, y));
        case "not": return x !== null && typeof x === "object" && !(x instanceof Date) ? !matchField(v, x) : !eq(v, x);
        case "gt": return v != null && cmp(v, x) > 0;
        case "gte": return v != null && cmp(v, x) >= 0;
        case "lt": return v != null && cmp(v, x) < 0;
        case "lte": return v != null && cmp(v, x) <= 0;
        case "startsWith": return typeof v === "string" && v.startsWith(x as string);
        default: throw new Error(`메모리 DB: 지원하지 않는 조건 ${op}`);
      }
    })();
    if (!ok) return false;
  }
  return true;
}

type Relations = Record<string, (row: Row) => Row | null>;

function matches(row: Row, where: Where | undefined, rel: Relations): boolean {
  if (!where) return true;
  for (const [k, cond] of Object.entries(where)) {
    if (k === "OR") { if (!(cond as Where[]).some((w) => matches(row, w, rel))) return false; continue; }
    if (k === "AND") { if (!(cond as Where[]).every((w) => matches(row, w, rel))) return false; continue; }
    if (k === "NOT") { if ((Array.isArray(cond) ? cond : [cond]).some((w) => matches(row, w as Where, rel))) return false; continue; }
    if (rel[k]) { const target = rel[k](row); if (!target || !matches(target, cond as Where, {})) return false; continue; }
    if (!matchField(row[k], resolveRefs(cond, row))) return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Record<string, "asc" | "desc">[];
  return [...rows].sort((a, b) => {
    for (const o of keys) {
      const [k, dir] = Object.entries(o)[0];
      const av = a[k]; const bv = b[k];
      if (av == null && bv == null) continue;
      // Postgres: DESC는 NULL 먼저, ASC는 NULL 나중
      if (av == null) return dir === "desc" ? -1 : 1;
      if (bv == null) return dir === "desc" ? 1 : -1;
      const c = cmp(av, bv) || String(av).localeCompare(String(bv));
      if (c !== 0) return dir === "desc" ? -c : c;
    }
    return 0;
  });
}

const uniqueError = (target: string) => Object.assign(new Error(`Unique constraint failed on ${target}`), { code: "P2002" });
const notFoundError = () => Object.assign(new Error("Record to update not found."), { code: "P2025" });

let idSeq = 0;
/** cuid처럼 생긴 25자 영숫자 id */
export const fakeId = () => `c${String(++idSeq).padStart(24, "0")}`;

interface ModelSpec {
  key: string | ((where: Where) => (r: Row) => boolean);
  defaults: () => Row;
  relations?: Relations;
  /** 쓰기 뒤 제약(유일 인덱스 등) */
  check?: (row: Row, all: Row[]) => void;
  /** prisma.<모델>.fields로 꺼내 쓰는 칸(필드 참조 조건용) */
  fields?: string[];
}

function model(spec: ModelSpec) {
  const rows: Row[] = [];
  const rel = spec.relations ?? {};
  const keyMatch = (where: Where) => (typeof spec.key === "function" ? spec.key(where)
    : (r: Row) => Object.entries(where).every(([k, v]) => eq(r[k], v)));
  const findUnique = (where: Where) => rows.find(keyMatch(where)) ?? null;
  const write = (row: Row, data: Row) => {
    const next = { ...row, ...data, updatedAt: new Date() };
    spec.check?.(next, rows.filter((r) => r !== row));
    Object.assign(row, next);
    return { ...row };
  };
  return {
    rows,
    fields: fieldRefs(spec.fields ?? []),
    findUnique: vi.fn(async ({ where }: { where: Where }) => { const r = findUnique(where); return r ? { ...r } : null; }),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: Where }) => { const r = findUnique(where); if (!r) throw notFoundError(); return { ...r }; }),
    findFirst: vi.fn(async ({ where, orderBy }: { where?: Where; orderBy?: unknown } = {}) => {
      const r = sortRows(rows.filter((x) => matches(x, where, rel)), orderBy)[0]; return r ? { ...r } : null;
    }),
    findMany: vi.fn(async ({ where, orderBy, take }: { where?: Where; orderBy?: unknown; take?: number } = {}) =>
      sortRows(rows.filter((x) => matches(x, where, rel)), orderBy).slice(0, take ?? Infinity).map((r) => ({ ...r }))),
    count: vi.fn(async ({ where }: { where?: Where } = {}) => rows.filter((x) => matches(x, where, rel)).length),
    create: vi.fn(async ({ data }: { data: Row }) => {
      const now = new Date();
      const row = { ...spec.defaults(), createdAt: now, updatedAt: now, ...data };
      spec.check?.(row, rows);
      rows.push(row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
      const r = findUnique(where); if (!r) throw notFoundError(); return write(r, data);
    }),
    updateMany: vi.fn(async ({ where, data }: { where?: Where; data: Row }) => {
      const hit = rows.filter((x) => matches(x, where, rel));
      for (const r of hit) write(r, data);
      return { count: hit.length };
    }),
    upsert: vi.fn(async ({ where, create, update }: { where: Where; create: Row; update: Row }) => {
      const r = findUnique(where);
      if (r) return write(r, update);
      const now = new Date();
      const row = { ...spec.defaults(), createdAt: now, updatedAt: now, ...create };
      spec.check?.(row, rows);
      rows.push(row);
      return { ...row };
    }),
  };
}

/** 운영 DB의 부분 유일 인덱스와 같은 목록(scripts/ops-billing-pg.ts · lib/billing/portone-activate LIVE_PORTONE_STATUSES) */
const LIVE = ["activating", "active", "grace", "canceled"];

const subscription = model({
  key: (w) => (r) => (w.id !== undefined ? r.id === w.id : r.purchaseToken === w.purchaseToken),
  defaults: () => ({
    id: fakeId(), status: "active", provider: "play", expiresAt: null, verifiedAt: new Date(), revokedAt: null, payMethod: null,
    priceKrw: null, dailyTurnLimit: null, billingKeyEnc: null, anchorDay: null, cycleNo: 0, nextChargeAt: null, nextScheduleId: null,
    cancelAtPeriodEnd: false, failedChargeCount: 0, canceledAt: null, cancelType: null, renewalNoticeFor: null,
  }),
  check: (row, others) => {
    if (others.some((o) => o.purchaseToken === row.purchaseToken)) throw uniqueError("purchaseToken");
    if (row.provider === "portone" && LIVE.includes(row.status as string)
      && others.some((o) => o.provider === "portone" && o.beneficiaryUserId === row.beneficiaryUserId && LIVE.includes(o.status as string))) {
      throw uniqueError("Subscription_portone_live_beneficiary_key");
    }
  },
});
const billingPayment = model({
  key: (w) => (r) => r.paymentId === w.paymentId,
  defaults: () => ({
    attempt: 0, payMethod: null, periodStart: null, periodEnd: null, scheduledAt: null, paidAt: null, cancelledKrw: 0,
    refundTargetKrw: null, failureReason: null, receiptUrl: null, paidMailAt: null, cancelType: null, cancelRequestedAt: null,
  }),
  check: (row, others) => { if (others.some((o) => o.paymentId === row.paymentId)) throw uniqueError("paymentId"); },
  fields: ["cancelledKrw", "refundTargetKrw", "amountKrw"],
});
const billingConsent = model({ key: (w) => (r) => r.id === w.id, defaults: () => ({ id: fakeId(), subscriptionId: null, offer: null }) });
const user = model({ key: (w) => (r) => r.id === w.id, defaults: () => ({ name: null }) });
const conversation = model({ key: (w) => (r) => (w.id !== undefined ? r.id === w.id : r.userId === w.userId), defaults: () => ({ id: fakeId() }) });
const message = model({
  key: (w) => (r) => r.id === w.id,
  defaults: () => ({ id: fakeId(), role: "user", content: "안녕" }),
  relations: { conversation: (m) => conversation.rows.find((c) => c.id === m.conversationId) ?? null },
});
const expertPatient = model({
  key: (w) => {
    const k = w.expertUserId_patientUserId as { expertUserId: string; patientUserId: string };
    return (r) => r.expertUserId === k.expertUserId && r.patientUserId === k.patientUserId;
  },
  defaults: () => ({ id: fakeId(), status: "active" }),
});

const MODELS = [subscription, billingPayment, billingConsent, user, conversation, message, expertPatient];

/**
 * 트랜잭션 — 안에서 throw하면 그 안의 쓰기를 모두 되돌린다(운영 DB와 같게). 조건부 갱신이 0건일 때 throw해 앞선 쓰기를
 *   되돌리는 코드(lib/billing/portone-sync markPaid 등)가 실제와 같은 결과를 보게 한다.
 */
async function runTransaction(arg: unknown): Promise<unknown> {
  if (typeof arg !== "function") return Promise.all(arg as unknown[]);
  const snapshot = MODELS.map((m) => m.rows.map((r) => ({ ...r })));
  try {
    return await (arg as (tx: unknown) => unknown)(db);
  } catch (e) {
    MODELS.forEach((m, i) => { m.rows.length = 0; m.rows.push(...snapshot[i]); });
    throw e;
  }
}

export const db = {
  subscription, billingPayment, billingConsent, user, conversation, message, expertPatient,
  $transaction: vi.fn(runTransaction),
};
vi.mock("@/lib/prisma", () => ({ prisma: db }));

// ───────────────────────────── 가짜 포트원 ─────────────────────────────
export interface FakePayment {
  id: string; status: string; billingKey?: string; scheduleId?: string; currency: string; paidAt?: string; receiptUrl?: string;
  amount: { total: number; taxFree: number; discount: number; paid: number; cancelled: number; cancelledTaxFree: number };
  channel: { type: string; pgProvider: string; pgMerchantId: string };
  failure?: { reason?: string; pgCode?: string; pgMessage?: string };
}
export interface FakeKey { status: "ISSUED" | "DELETED"; issueId?: string; storeId: string; channels: { type: string }[] }
export interface FakeSchedule {
  id: string; paymentId: string; billingKey: string; amount: number; timeToPay: string; status: string; createdAt: string;
}

export const pg = {
  payments: new Map<string, FakePayment>(),
  keys: new Map<string, FakeKey>(),
  schedules: [] as FakeSchedule[],
  /** 포트원 호출 순서(예약 취소 → 빌링키 삭제 같은 순서 검사용) */
  log: [] as string[],
  /** 다음 빌링키 결제를 PG 거절로 — pgMessage */
  declineNext: null as string | null,
  /** 다음 결제 취소를 이 오류 종류로 실패시킨다 */
  failCancelWith: null as string | null,
  /** 다음 예약 취소를 이 오류 종류로 실패시킨다 */
  failRevokeWith: null as string | null,
};

const rest = (Cls: new (d: never) => Error, type: string, extra: Row = {}) => new Cls({ type, message: type, ...extra } as never);
const channel = (type: string) => ({ type, pgProvider: "INICIS_V2", pgMerchantId: "INIBillTst" });

function newPayment(paymentId: string, billingKey: string, total: number, status: "PAID" | "FAILED", scheduleId?: string): FakePayment {
  const key = pg.keys.get(billingKey);
  const p: FakePayment = {
    id: paymentId, status, billingKey, scheduleId, currency: "KRW", channel: channel(key?.channels[0]?.type ?? "TEST"),
    amount: { total, taxFree: 0, discount: 0, paid: status === "PAID" ? total : 0, cancelled: 0, cancelledTaxFree: 0 },
  };
  if (status === "PAID") { p.paidAt = new Date().toISOString(); p.receiptUrl = `https://receipt.example.com/${paymentId}`; }
  else p.failure = { reason: "잔액 부족", pgCode: "NotEnoughAccountBalance", pgMessage: "잔액이 부족합니다" };
  pg.payments.set(paymentId, p);
  return p;
}

export const fakeClient = {
  payment: {
    getPayment: vi.fn(async ({ paymentId }: { paymentId: string }) => {
      pg.log.push(`get:${paymentId}`);
      const p = pg.payments.get(paymentId);
      if (!p) throw rest(Payment.GetPaymentError, "PAYMENT_NOT_FOUND");
      return structuredClone(p);
    }),
    payWithBillingKey: vi.fn(async (o: { paymentId: string; billingKey: string; amount: { total: number } }) => {
      pg.log.push(`pay:${o.paymentId}`);
      if (pg.payments.get(o.paymentId)?.status === "PAID") throw rest(Payment.PayWithBillingKeyError, "ALREADY_PAID");
      if (pg.schedules.some((s) => s.paymentId === o.paymentId && s.status === "SCHEDULED")) {
        throw rest(Payment.PayWithBillingKeyError, "PAYMENT_SCHEDULE_ALREADY_EXISTS");
      }
      if (pg.keys.get(o.billingKey)?.status !== "ISSUED") throw rest(Payment.PayWithBillingKeyError, "BILLING_KEY_NOT_FOUND");
      if (pg.declineNext !== null) {
        const pgMessage = pg.declineNext; pg.declineNext = null;
        newPayment(o.paymentId, o.billingKey, o.amount.total, "FAILED").failure = { pgMessage, pgCode: "DECLINED" };
        throw rest(Payment.PayWithBillingKeyError, "PG_PROVIDER", { pgCode: "DECLINED", pgMessage });
      }
      const p = newPayment(o.paymentId, o.billingKey, o.amount.total, "PAID");
      return { payment: { pgTxId: "tx", paidAt: p.paidAt } };
    }),
    cancelPayment: vi.fn(async (o: { paymentId: string; amount?: number; currentCancellableAmount?: number }) => {
      pg.log.push(`cancel:${o.paymentId}:${o.amount ?? "all"}`);
      if (pg.failCancelWith) { const t = pg.failCancelWith; pg.failCancelWith = null; throw rest(Payment.CancelPaymentError, t); }
      const p = pg.payments.get(o.paymentId);
      if (!p || (p.status !== "PAID" && p.status !== "PARTIAL_CANCELLED")) throw rest(Payment.CancelPaymentError, "PAYMENT_NOT_PAID");
      const cancellable = p.amount.total - p.amount.cancelled;
      if (o.currentCancellableAmount !== undefined && o.currentCancellableAmount !== cancellable) {
        throw rest(Payment.CancelPaymentError, "CANCELLABLE_AMOUNT_CONSISTENCY_BROKEN");
      }
      const amt = o.amount ?? cancellable;
      if (amt > cancellable) throw rest(Payment.CancelPaymentError, "CANCEL_AMOUNT_EXCEEDS_CANCELLABLE_AMOUNT");
      p.amount.cancelled += amt;
      p.status = p.amount.cancelled >= p.amount.total ? "CANCELLED" : "PARTIAL_CANCELLED";
      return { cancellation: { status: "SUCCEEDED", totalAmount: amt } };
    }),
    billingKey: {
      getBillingKeyInfo: vi.fn(async ({ billingKey }: { billingKey: string }) => {
        const k = pg.keys.get(billingKey);
        if (!k) throw rest(Payment.BillingKey.GetBillingKeyInfoError, "BILLING_KEY_NOT_FOUND");
        return { billingKey, merchantId: "m", customer: {}, issuedAt: new Date().toISOString(), ...structuredClone(k) };
      }),
      deleteBillingKey: vi.fn(async ({ billingKey }: { billingKey: string }) => {
        pg.log.push(`deleteKey:${billingKey}`);
        const k = pg.keys.get(billingKey);
        if (!k) throw rest(Payment.BillingKey.DeleteBillingKeyError, "BILLING_KEY_NOT_FOUND");
        if (k.status === "DELETED") throw rest(Payment.BillingKey.DeleteBillingKeyError, "BILLING_KEY_ALREADY_DELETED");
        // 예약이 남은 빌링키는 지울 수 없다(포트원 409 — research B15)
        if (pg.schedules.some((s) => s.billingKey === billingKey && s.status === "SCHEDULED")) {
          throw rest(Payment.BillingKey.DeleteBillingKeyError, "PAYMENT_SCHEDULE_ALREADY_EXISTS");
        }
        k.status = "DELETED";
        return { deletedAt: new Date().toISOString() };
      }),
    },
    paymentSchedule: {
      createPaymentSchedule: vi.fn(async (o: { paymentId: string; payment: { billingKey: string; amount: { total: number } }; timeToPay: string }) => {
        pg.log.push(`schedule:${o.paymentId}`);
        if (pg.schedules.some((s) => s.paymentId === o.paymentId && s.status === "SCHEDULED")) {
          throw rest(Payment.PaymentSchedule.CreatePaymentScheduleError, "PAYMENT_SCHEDULE_ALREADY_EXISTS");
        }
        if (pg.payments.get(o.paymentId)?.status === "PAID") throw rest(Payment.PaymentSchedule.CreatePaymentScheduleError, "ALREADY_PAID_OR_WAITING");
        const s = { id: `sch_${pg.schedules.length + 1}`, paymentId: o.paymentId, billingKey: o.payment.billingKey,
          amount: o.payment.amount.total, timeToPay: o.timeToPay, status: "SCHEDULED", createdAt: new Date().toISOString() };
        pg.schedules.push(s);
        return { schedule: { id: s.id } };
      }),
      // 예약 다건 조회 — 빌링키·상태로 거른다(기록은 "get:"으로 시작 — 조회는 포트원 쓰기 순서 검사에서 빠진다)
      getPaymentSchedules: vi.fn(async ({ filter }: { filter?: { billingKey?: string; status?: string[] } } = {}) => {
        pg.log.push(`get:schedules:${filter?.billingKey ?? ""}`);
        const items = pg.schedules
          .filter((s) => (!filter?.billingKey || s.billingKey === filter.billingKey) && (!filter?.status || filter.status.includes(s.status)))
          .map((s) => ({ ...s, totalAmount: s.amount }));
        return { items: structuredClone(items), page: { number: 0, size: items.length, totalCount: items.length } };
      }),
      revokePaymentSchedules: vi.fn(async ({ billingKey }: { billingKey?: string }) => {
        pg.log.push(`revoke:${billingKey}`);
        if (pg.failRevokeWith) { const t = pg.failRevokeWith; pg.failRevokeWith = null; throw rest(Payment.PaymentSchedule.RevokePaymentSchedulesError, t); }
        if (pg.keys.get(billingKey ?? "")?.status === "DELETED") throw rest(Payment.PaymentSchedule.RevokePaymentSchedulesError, "BILLING_KEY_ALREADY_DELETED");
        const hit = pg.schedules.filter((s) => s.billingKey === billingKey && s.status === "SCHEDULED");
        for (const s of hit) s.status = "REVOKED";
        return { revokedScheduleIds: hit.map((s) => s.id), revokedAt: new Date().toISOString() };
      }),
    },
  },
};
vi.mock("@portone/server-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  PortOneClient: () => fakeClient,
}));

/** 포트원이 예약 결제를 실행한 것처럼 — 결제 건을 만든다(웹훅은 테스트가 syncPayment로 대신 부른다) */
export function runSchedule(paymentId: string, outcome: "paid" | "failed"): FakePayment {
  const s = pg.schedules.find((x) => x.paymentId === paymentId && x.status === "SCHEDULED");
  if (!s) throw new Error(`예약 없음: ${paymentId}`);
  s.status = outcome === "paid" ? "SUCCEEDED" : "FAILED";
  return newPayment(paymentId, s.billingKey, s.amount, outcome === "paid" ? "PAID" : "FAILED", s.id);
}

/** 발급된 빌링키 — channelType으로 test/live 채널을 흉내 */
export function issueKey(billingKey: string, issueId: string, channelType = "TEST", storeId = "store-test"): void {
  pg.keys.set(billingKey, { status: "ISSUED", issueId, storeId, channels: [{ type: channelType }] });
}

// ───────────────────────────── 메일 스파이 ─────────────────────────────
export const mail = {
  configured: true,
  sent: [] as { to: string; subject: string; html: string; text: string }[],
  /** 운영 경보 — via: 보낸 계정("service" = 결제 안내 발신 계정, "emergency" = 위급 메일과 같은 계정) */
  ops: [] as { subject: string; lines: string[]; via: string }[],
};
export const sendServiceEmailMock = vi.fn(async (to: string, m: { subject: string; html: string; text: string }) => {
  mail.sent.push({ to, ...m });
  return "ok" as const;
});
vi.mock("@/lib/notify/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notify/email")>()),
  isEmailConfigured: () => mail.configured,
  isServiceEmailConfigured: () => mail.configured,
  serviceEmailProblem: () => (mail.configured ? null : "SERVICE_GMAIL_USER·SERVICE_GMAIL_APP_PASSWORD"),
  sendServiceEmail: (to: string, m: { subject: string; html: string; text: string }) => sendServiceEmailMock(to, m),
  sendOpsAlert: vi.fn(async (subject: string, lines: string[], opts?: { via?: string }) => {
    mail.ops.push({ subject, lines, via: opts?.via ?? "emergency" }); return true;
  }),
}));

// ───────────────────────────── 기본 env · 초기화 ─────────────────────────────
export const BASE_ENV: Record<string, string> = {
  BILLING_PG_ENABLED: "1", PORTONE_STORE_ID: "store-test", PORTONE_API_SECRET: "secret-test", PORTONE_WEBHOOK_SECRET: "whsec_test",
  PORTONE_CHANNEL_KEY_CARD: "channel-key-card", PORTONE_MODE: "test", NEXTAUTH_URL: "https://maeum.example.com",
  // 예약 작업 비밀값·시험 모드 결제 허용 계정(*: 모두 — 시험 모드 제한은 그 시험이 따로 정한다)
  CRON_SECRET: "cron-secret-test-value", PORTONE_TEST_USER_IDS: "*", ...BIZ_ENV,
};
const TOUCHED = [...Object.keys(BASE_ENV), "PORTONE_CHANNEL_KEY_KAKAOPAY", "PORTONE_CHANNEL_KEY_NAVERPAY", "BILLING_PLANS"];

beforeEach(() => {
  vi.clearAllMocks(); // 호출 기록만 지운다(구현은 그대로) — 테스트마다 "몇 번 불렸나"를 처음부터 센다
  for (const m of [subscription, billingPayment, billingConsent, user, conversation, message, expertPatient]) m.rows.length = 0;
  pg.payments.clear(); pg.keys.clear(); pg.schedules.length = 0; pg.log.length = 0;
  pg.declineNext = null; pg.failCancelWith = null; pg.failRevokeWith = null;
  mail.configured = true; mail.sent.length = 0; mail.ops.length = 0;
  for (const k of TOUCHED) delete process.env[k];
  Object.assign(process.env, BASE_ENV);
});

// ───────────────────────────── 장면 만들기 ─────────────────────────────
/** 보호자·어르신·연결 */
export function seedFamily(opts: { guardian?: string; elder?: string; linked?: boolean } = {}): { guardian: string; elder: string } {
  const guardian = opts.guardian ?? "guardian-1";
  const elder = opts.elder ?? "elder-1";
  user.rows.push(
    { id: guardian, email: `${guardian}@example.com`, name: "보호자", screeningMode: "guardian" },
    { id: elder, email: `${elder}@example.com`, name: "김영자", screeningMode: "user" },
  );
  expertPatient.rows.push({ id: fakeId(), expertUserId: guardian, patientUserId: elder, status: opts.linked === false ? "revoked" : "active", createdAt: new Date() });
  return { guardian, elder };
}

export const PLAN_DAY30 = { id: "day30", name: "월 이용권(하루 대화 30회)", dailyTurnLimit: 30, priceKrw: 19_900 };
export const CONSENT = { termsVersion: "2026-10-22", items: ["terms", "autoRenew", "privacyEntrust", "refundPolicy"] };

/** KST 벽시계 시각 → Date */
export const kst = (s: string) => new Date(`${s}+09:00`);

/** 발급 준비 → 빌링키 발급(가짜 포트원) → 확정·첫 결제. 기본: 보호자-어르신 연결 + 하루 30회 19,900원 카드 */
export async function startSubscription(opts: { billingKey?: string; guardian?: string; elder?: string; seed?: boolean } = {}) {
  const { createPendingSubscription, activateByBillingKey } = await import("@/lib/billing/portone-activate");
  const guardian = opts.guardian ?? "guardian-1";
  const elder = opts.elder ?? "elder-1";
  if (opts.seed !== false) seedFamily({ guardian, elder });
  const pending = await createPendingSubscription({ purchaserUserId: guardian, beneficiaryUserId: elder, plan: PLAN_DAY30, method: "CARD", consent: CONSENT });
  if (!pending.ok) throw new Error(`발급 준비 실패: ${pending.code}`);
  const billingKey = opts.billingKey ?? `billing-key-${pending.issueId.slice(2, 8)}`;
  issueKey(billingKey, pending.issueId);
  const result = await activateByBillingKey(billingKey, { issueId: pending.issueId, purchaserUserId: guardian });
  return { ...pending, billingKey, result, guardian, elder };
}

/** 구독 행(메모리 DB) */
export const subRow = (id: string) => subscription.rows.find((r) => r.id === id) as Record<string, unknown> & {
  status: string; expiresAt: Date | null; nextChargeAt: Date | null; cycleNo: number; billingKeyEnc: string | null;
};
/** 원장 행(메모리 DB) */
export const ledger = (paymentId: string) => billingPayment.rows.find((r) => r.paymentId === paymentId) as Record<string, unknown> & {
  status: string; cancelledKrw: number; refundTargetKrw: number | null; periodStart: Date | null; periodEnd: Date | null;
};
