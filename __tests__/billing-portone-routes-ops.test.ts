/**
 * 결제 운영 경로 — 예약 작업(/api/cron/billing) · 연결 해제 전 결제 정리(/api/users/linked-experts DELETE) · 결제 화면 CSP · 배포 설정.
 *
 * 지키는 것:
 *   · 예약 작업은 CRON_SECRET Bearer가 맞을 때만 돈다(미설정 404 · 틀림 401). 돌면 해지 기간이 끝난 이용권을 만료로 바꾼다.
 *   · 보호자-어르신 연결 해제 **전에** 그 보호자가 결제한 이용권을 다음 결제부터 해지한다(예약 취소 → 빌링키 삭제가 연결 해제보다 먼저).
 *     포트원 정리가 실패하면 연결을 끊지 않고 502(응답 문구에 결제 이야기 없음 — 앱 화면). 포트원 설정 전이면 그대로 해제(운영 변화 0).
 *   · CSP는 결제 화면(/subscribe·/subscribe/return)만 넓어지고(포트원 SDK·결제창·이니시스 form), 다른 경로는 기존 그대로다
 *     — Next가 실제로 쓰는 경로 매칭(buildCustomRoute)으로 확인한다.
 *   · vercel.json 크론은 하루 1회 11:00 KST(02:00 UTC), 미들웨어는 /pricing·/terms·웹훅·크론을 인증으로 막지 않는다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile, access } from "node:fs/promises";
import {
  db, pg, mail, apiReq, read, loginAs, setRole, startSubscription, subRow, kst, BASE,
} from "./helpers/billing-portone-route-harness";

const cron = () => import("@/app/api/cron/billing/route");
const linked = () => import("@/app/api/users/linked-experts/route");
const cancelLib = () => import("@/lib/billing/portone-cancel");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(kst("2026-11-02T14:05:00"));
  setRole("guardian-1", "guardian", "보호자");
  setRole("elder-1", "user", "김영자");
  db.expertPatient.rows.push({ id: "link-1", expertUserId: "guardian-1", patientUserId: "elder-1", status: "active", createdAt: new Date() });
});
afterEach(() => vi.useRealTimers());

const cronReq = (authorization?: string) =>
  new Request(`${BASE}/api/cron/billing`, { headers: authorization ? { authorization } : {} });

describe("예약 작업 — CRON_SECRET Bearer", () => {
  it("CRON_SECRET 미설정 → 404(열린 채로 두지 않는다)", async () => {
    delete process.env.CRON_SECRET;
    expect((await (await cron()).GET(cronReq("Bearer anything"))).status).toBe(404);
  });

  it.each([["틀린 값", "Bearer wrong-secret-value"], ["헤더 없음", undefined], ["Bearer 없이 값만", "cron-secret-test-value"]])(
    "%s → 401, 아무것도 하지 않는다", async (_n, header) => {
      process.env.CRON_SECRET = "cron-secret-test-value";
      expect((await (await cron()).GET(cronReq(header))).status).toBe(401);
      expect(db.subscription.findMany).not.toHaveBeenCalled();
    });

  it("맞는 값 → 대사 실행: 해지 기간이 끝난 이용권은 만료로", async () => {
    process.env.CRON_SECRET = "cron-secret-test-value";
    const s = await startSubscription({ seed: false });
    await (await cancelLib()).cancelAtPeriodEnd(s.subscriptionId, { purchaserUserId: "guardian-1" });
    vi.setSystemTime(kst("2026-12-02T11:00:00"));
    const r = await read(await (await cron()).GET(cronReq("Bearer cron-secret-test-value")));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, failed: 0 });
    expect(subRow(s.subscriptionId).status).toBe("expired");
  });
});

describe("연결 해제 전 결제 정리 — 연결부터 끊으면 카드가 계속 결제된다", () => {
  const unlink = async (expertUserId: string) =>
    read(await (await linked()).DELETE(apiReq("/api/users/linked-experts", { method: "DELETE", body: { expertUserId } })));

  it("어르신이 보호자 연결을 해제 → 이용권 다음 결제부터 해지(link_gone) → 그다음에 연결 해제", async () => {
    const s = await startSubscription({ seed: false });
    loginAs("elder-1", "user");
    const seen: string[] = [];
    const original = db.expertPatient.updateMany.getMockImplementation()!;
    db.expertPatient.updateMany.mockImplementationOnce(async (args) => {
      seen.push(subRow(s.subscriptionId).status); // 연결을 끊는 순간 이용권은 이미 해지돼 있어야 한다
      return original(args);
    });
    const r = await unlink("guardian-1");
    expect(r.status).toBe(200);
    expect(seen).toEqual(["canceled"]);
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", cancelType: "link_gone", billingKeyEnc: null });
    expect(pg.log.filter((l) => /^(revoke|deleteKey):/.test(l))).toEqual([`revoke:${s.billingKey}`, `deleteKey:${s.billingKey}`]);
    expect(db.expertPatient.rows[0].status).toBe("revoked");
  });

  it("포트원 정리가 실패해도(API Secret 만료 등) 연결은 해제된다 — 동의 철회는 즉시: 해지 의사는 먼저 기록, 운영 경보(10-22 검토)", async () => {
    const s = await startSubscription({ seed: false });
    loginAs("elder-1", "user");
    pg.failRevokeWith = "UNAUTHORIZED";
    const r = await unlink("guardian-1");
    expect(r.status).toBe(200);
    expect(db.expertPatient.rows[0].status).toBe("revoked");
    expect(subRow(s.subscriptionId)).toMatchObject({ status: "canceled", cancelType: "link_gone", nextChargeAt: null });
    expect(mail.ops.map((o) => o.subject)).toContain("[결제] 빌링키 정리 실패 — 예약 작업이 다시 시도");
  });

  it("빌링키를 풀 수 없어도(ENCRYPTION_KEY 교체) · 첫 결제 중이어도 해제된다 — 몇 번을 다시 해도 502로 막히지 않는다", async () => {
    await startSubscription({ seed: false });
    loginAs("elder-1", "user");
    process.env.ENCRYPTION_KEY = "f".repeat(64);
    try {
      expect((await unlink("guardian-1")).status).toBe(200);
    } finally {
      process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    }
    expect(db.expertPatient.rows[0].status).toBe("revoked");
  });

  it("결제 정리의 DB 쓰기 자체가 실패하면 502, 연결은 그대로 · 응답에 결제 이야기 없음(앱 화면)", async () => {
    await startSubscription({ seed: false });
    loginAs("elder-1", "user");
    db.subscription.findMany.mockRejectedValueOnce(new Error("connection reset"));
    const r = await unlink("guardian-1");
    expect(r.status).toBe(502);
    expect(r.text).not.toMatch(/결제|이용권|포트원/);
    expect(db.expertPatient.rows[0].status).toBe("active");
  });

  it("포트원 설정 전 → 결제 정리 없이 그대로 해제(운영 변화 0)", async () => {
    const s = await startSubscription({ seed: false });
    delete process.env.PORTONE_STORE_ID;
    pg.log.length = 0;
    loginAs("elder-1", "user");
    expect((await unlink("guardian-1")).status).toBe(200);
    expect(pg.log).toEqual([]);
    expect(subRow(s.subscriptionId).status).toBe("active");
    expect(db.expertPatient.rows[0].status).toBe("revoked");
  });

  it("다른 연결(의사 등)을 해제하면 그 보호자의 이용권은 건드리지 않는다", async () => {
    const s = await startSubscription({ seed: false });
    db.expertPatient.rows.push({ id: "link-2", expertUserId: "doctor-1", patientUserId: "elder-1", status: "active", createdAt: new Date() });
    pg.log.length = 0;
    loginAs("elder-1", "user");
    expect((await unlink("doctor-1")).status).toBe(200);
    expect(pg.log).toEqual([]);
    expect(subRow(s.subscriptionId).status).toBe("active");
  });
});

describe("결제 화면 CSP — /subscribe 아래만 넓힌다", () => {
  async function cspFor(pathname: string): Promise<string> {
    const { default: config } = await import("@/next.config");
    const { buildCustomRoute } = await import("next/dist/lib/build-custom-route");
    const routes = await config.headers!();
    let csp = "";
    for (const route of routes) {
      const built = buildCustomRoute("header", route) as { regex: string };
      if (!new RegExp(built.regex).test(pathname)) continue;
      const h = route.headers.find((x) => x.key === "Content-Security-Policy");
      if (h) csp = h.value; // 같은 헤더는 뒤의 것이 이긴다(Next headers.md)
    }
    return csp;
  }
  const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

  it.each([["/subscribe"], ["/subscribe/return"]])("%s: 포트원 SDK·API·결제창·이니시스 form", async (path) => {
    const csp = await cspFor(path);
    expect(directive(csp, "script-src")).toContain("https://cdn.portone.io");
    expect(directive(csp, "connect-src")).toContain("https://checkout-service.prod.iamport.co");
    expect(directive(csp, "connect-src")).toContain("https://generativelanguage.googleapis.com"); // 기존 출처는 그대로
    for (const host of ["https://checkout-service.prod.iamport.co", "https://*.kakao.com", "https://*.naver.com", "https://*.inicis.com"]) {
      expect(directive(csp, "frame-src")).toContain(host);
    }
    expect(directive(csp, "form-action")).toBe("form-action 'self' https://*.inicis.com");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(csp).not.toContain("sentry.io");
  });

  it.each([["/"], ["/chat"], ["/pricing"], ["/subscribed"], ["/api/billing/portone/prepare"], ["/login"]])("%s: 기존 CSP 그대로", async (path) => {
    const csp = await cspFor(path);
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/portone|iamport|frame-src|inicis/);
    expect(directive(csp, "form-action")).toBe("form-action 'self'");
  });
});

describe("배포 설정", () => {
  it("vercel.json — 하루 1회 02:00 UTC(11:00 KST) /api/cron/billing, 지역 설정은 그대로", async () => {
    const v = JSON.parse(await readFile("vercel.json", "utf-8")) as { regions: string[]; crons: { path: string; schedule: string }[] };
    expect(v.regions).toEqual(["icn1"]);
    expect(v.crons).toEqual([{ path: "/api/cron/billing", schedule: "0 2 * * *" }]);
    await expect(access("app/api/cron/billing/route.ts")).resolves.toBeUndefined();
  });

  it("미들웨어는 /pricing·/terms·/subscribe·웹훅·크론을 인증으로 막지 않는다", async () => {
    const src = await readFile("middleware.ts", "utf-8");
    const entries = (src.match(/matcher:\s*\[([\s\S]*?)\]/)?.[1].match(/"[^"]*"/g) ?? []).map((x) => x.slice(1, -1));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) expect(e).not.toMatch(/^\/(pricing|terms|subscribe|api)/);
  });
});
