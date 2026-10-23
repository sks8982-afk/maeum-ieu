/**
 * 포트원 결제 API 라우트(app/api/billing/portone/* · cron · status · 연결 해제) 시험 공용 — 핵심 하네스(메모리 DB·가짜 포트원·메일
 *   스파이, ./billing-portone-harness) 위에 로그인 세션·요청 빈도·웹훅 처리 기록 표·요청 만들기·웹훅 서명을 더한다.
 *
 * 쓰는 법: 이 모듈을 먼저 import하고, 라우트는 테스트 안에서 동적으로 import한다(핵심 하네스와 같은 규칙).
 *   역할은 DB(User.screeningMode)를 본다 — setRole로 메모리 DB의 사용자 행에 넣는다. 세션(JWT)의 역할은 일부러 따로 둔다.
 * 웹훅 서명은 포트원과 같은 방식(Standard Webhooks — HMAC-SHA256(`${id}.${timestamp}.${본문}`), 시크릿은 whsec_ 뒤 base64)으로
 *   만들어 진짜 SDK(Webhook.verify)가 검증하게 한다 — 서명 검증을 목으로 바꾸지 않는다.
 */
import { vi, beforeEach, afterAll } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { db, fakeId } from "./billing-portone-harness";

export * from "./billing-portone-harness";

/** 이 하네스가 더 바꾸는 env — 파일이 끝나면 원래 값으로 되돌린다(CRON_SECRET·BIZ_*는 핵심 하네스의 기본 env가 시험마다 다시 넣는다) */
const EXTRA_ENV = ["BILLING_PLAY_ENABLED", "BIZ_HOSTING"];
const ORIGINAL = Object.fromEntries(EXTRA_ENV.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const [k, v] of Object.entries(ORIGINAL)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

// ───────────────────────────── 로그인·요청 빈도 ─────────────────────────────
export const auth = { session: null as null | { user: { id: string; screeningMode?: string } } };
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => auth.session) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));

/** next/server의 after — 맡긴 일을 모아 두었다가 시험이 runAfter()로 돌린다(진짜 after는 요청 스코프 밖에서 throw — push-device와 같은 방식) */
export const afterTasks: (() => unknown)[] = [];
vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>();
  return { ...mod, after: (fn: () => unknown) => { afterTasks.push(fn); } };
});
/** 응답 뒤에 맡긴 일을 지금 돌린다(맡긴 순서대로) */
export async function runAfter(): Promise<void> {
  while (afterTasks.length) await afterTasks.shift()!();
}

export const rate = { ok: true, keys: [] as string[] };
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async (key: string) => { rate.keys.push(key); return { ok: rate.ok, retryAfterSec: rate.ok ? 0 : 30 }; }),
}));

/** 로그인 — 세션의 역할(JWT)은 DB와 다를 수 있다(바뀐 뒤 남은 토큰) */
export function loginAs(id: string, sessionRole = "guardian"): void {
  auth.session = { user: { id, screeningMode: sessionRole } };
}

/** 메모리 DB 사용자 행에 역할(DB 값)을 넣는다 — 없으면 만든다 */
export function setRole(id: string, screeningMode: string, name?: string): void {
  const row = db.user.rows.find((u) => u.id === id);
  if (row) Object.assign(row, { screeningMode, ...(name ? { name } : {}) });
  else db.user.rows.push({ id, email: `${id}@example.com`, name: name ?? null, screeningMode });
}

// ───────────────────────────── 웹훅 처리 기록 표 ─────────────────────────────
export const webhookEvents: { webhookId: string; type: string }[] = [];
const webhookTable = {
  findUnique: vi.fn(async ({ where }: { where: { webhookId: string } }) => webhookEvents.find((e) => e.webhookId === where.webhookId) ?? null),
  upsert: vi.fn(async ({ where, create }: { where: { webhookId: string }; create: { webhookId: string; type: string } }) => {
    const hit = webhookEvents.find((e) => e.webhookId === where.webhookId);
    if (hit) return hit;
    webhookEvents.push({ ...create });
    return create;
  }),
};
(db as unknown as Record<string, unknown>).billingWebhookEvent = webhookTable;

beforeEach(() => {
  auth.session = null;
  rate.ok = true; rate.keys.length = 0;
  webhookEvents.length = 0;
  afterTasks.length = 0;
  for (const k of EXTRA_ENV) delete process.env[k];
});

// ───────────────────────────── 요청 만들기 ─────────────────────────────
export const BASE = "https://maeum.example.com";
export const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
/** 우리 앱(MaeumApp) WebView의 기본 UA 꼴 — Android System WebView("; wv)"), 앱 표지 없음 */
export const APP_UA = "Mozilla/5.0 (Linux; Android 14; SM-S921N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) "
  + "Version/4.0 Chrome/129.0.6668.100 Mobile Safari/537.36";

interface ReqOpts { method?: string; body?: unknown; ua?: string; origin?: string | null; headers?: Record<string, string> }

/** API 요청 — 기본: 데스크톱 크롬, 같은 오리진(POST), JSON 본문 */
export function apiReq(path: string, opts: ReqOpts = {}): Request {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { "user-agent": opts.ua ?? CHROME_UA, ...opts.headers };
  if (method !== "GET" && opts.origin !== null) headers.origin = opts.origin ?? BASE;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const body = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  return new Request(`${BASE}${path}`, { method, headers, body });
}

/** 응답 → { status, body(JSON), text } */
export async function read(res: Response): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* 본문이 JSON이 아님(웹훅 ok 등) */ }
  return { status: res.status, body, text };
}

// ───────────────────────────── 웹훅 서명 ─────────────────────────────
/** 시험용 웹훅 시크릿(무작위 — 비밀값 아님) */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

/** 포트원처럼 서명한 웹훅 요청 — body는 이미 직렬화된 원문(띄어쓰기까지 서명된다) */
export function signedWebhook(body: string, opts: { id?: string; timestamp?: number; secret?: string } = {}): Request {
  const id = opts.id ?? `msg_${fakeId()}`;
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const secret = opts.secret ?? process.env.PORTONE_WEBHOOK_SECRET ?? "";
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return new Request(`${BASE}/api/billing/portone/webhook`, {
    method: "POST", body,
    headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": `v1,${signature}` },
  });
}

/** 포트원 웹훅 본문(2024-04-25) — 결제 */
export function paymentWebhookBody(type: string, paymentId: string, storeId = "store-test", pretty = false): string {
  const payload = { type, timestamp: new Date().toISOString(), data: { storeId, paymentId, transactionId: `tx_${paymentId}` } };
  return pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);
}

/** 포트원 웹훅 본문 — 빌링키 */
export function billingKeyWebhookBody(type: string, billingKey: string, storeId = "store-test"): string {
  return JSON.stringify({ type, timestamp: new Date().toISOString(), data: { storeId, billingKey } });
}
