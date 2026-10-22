/**
 * 결제 안내 메일 발신 계정 분리(lib/notify/email — sendServiceEmail·sendOpsAlert via "service") — 2026-10-22 검토.
 *
 * 지키는 것:
 *   · 결제 안내 메일은 위급 메일 계정(GMAIL_USER)이 아니라 서비스 메일 계정(SERVICE_GMAIL_USER)으로만 보낸다 — Gmail 하루 발신 한도를
 *     결제 메일이 다 쓰면 그날 보호자 위급 메일·"모든 채널 실패" 운영 경보가 나가지 않는다(안전 기능은 결제와 무관 — 설계 0).
 *   · 서비스 계정이 없거나 위급 계정과 같으면 보내지 않는다 — 위급 계정으로 **대신 보내지 않는다**.
 *   · 결제 쪽 운영 경보(via "service")도 서비스 계정으로. 위급·기본 운영 경보는 예전 그대로 위급 계정.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sent = vi.hoisted(() => [] as { authUser: string; from: string; to: string }[]);
vi.mock("nodemailer", () => ({
  default: {
    createTransport: (opts: { auth: { user: string } }) => ({
      sendMail: vi.fn(async (m: { from: string; to: string }) => { sent.push({ authUser: opts.auth.user, from: m.from, to: m.to }); return { messageId: "x" }; }),
    }),
  },
}));

const KEYS = ["GMAIL_USER", "GMAIL_APP_PASSWORD", "SERVICE_GMAIL_USER", "SERVICE_GMAIL_APP_PASSWORD", "OPS_ALERT_EMAIL"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const MAIL = { subject: "[마음이음] 이용권 결제 완료", html: "<p>x</p>", text: "x" };

beforeEach(() => {
  vi.resetModules();
  sent.length = 0;
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, {
    GMAIL_USER: "alert@example.com", GMAIL_APP_PASSWORD: "pw-emergency",
    SERVICE_GMAIL_USER: "billing@example.com", SERVICE_GMAIL_APP_PASSWORD: "pw billing",
  });
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const load = () => import("@/lib/notify/email");

describe("결제 안내 메일 — 서비스 계정으로만", () => {
  it("서비스 계정(SERVICE_GMAIL_USER)으로 인증·발신 — 위급 메일 계정은 쓰지 않는다", async () => {
    const mail = await load();
    expect(mail.isServiceEmailConfigured()).toBe(true);
    expect(await mail.sendServiceEmail("guardian@example.com", MAIL)).toBe("ok");
    expect(sent).toEqual([{ authUser: "billing@example.com", from: "마음이음 <billing@example.com>", to: "guardian@example.com" }]);
  });

  it.each([["SERVICE_GMAIL_USER"], ["SERVICE_GMAIL_APP_PASSWORD"]])("%s가 없으면 보내지 않는다(permanent) — 위급 계정으로 대신 보내지 않는다", async (k) => {
    delete process.env[k];
    const mail = await load();
    expect(mail.serviceEmailProblem()).toBe("SERVICE_GMAIL_USER·SERVICE_GMAIL_APP_PASSWORD");
    expect(await mail.sendServiceEmail("guardian@example.com", MAIL)).toBe("permanent");
    expect(sent).toEqual([]);
  });

  it("서비스 계정이 위급 계정과 같으면(대소문자 무시) 설정 안 됨 — 한도를 나눠 쓰는 의미가 없다", async () => {
    process.env.SERVICE_GMAIL_USER = " ALERT@example.com ";
    const mail = await load();
    expect(mail.serviceEmailProblem()).toContain("GMAIL_USER와 달라야");
    expect(await mail.sendServiceEmail("guardian@example.com", MAIL)).toBe("permanent");
    expect(sent).toEqual([]);
  });

  it("위급 메일은 그대로 위급 계정 — 서비스 계정이 있어도 섞이지 않는다", async () => {
    const mail = await load();
    await mail.sendEmergencyEmail("guardian@example.com", { userName: "김영자", level: 3, category: "낙상", createdAt: new Date() });
    expect(sent.map((s) => s.authUser)).toEqual(["alert@example.com"]);
  });
});

describe("운영 경보 — 결제 쪽은 서비스 계정, 위급 쪽은 예전 그대로", () => {
  it("via service → 서비스 계정으로, 받는 곳은 OPS_ALERT_EMAIL(없으면 서비스 계정 자신)", async () => {
    const mail = await load();
    expect(await mail.sendOpsAlert("[결제] 시험 경보", ["줄"], { via: "service" })).toBe(true);
    expect(sent.at(-1)).toMatchObject({ authUser: "billing@example.com", to: "billing@example.com" });
    process.env.OPS_ALERT_EMAIL = "ops@example.com";
    expect(await mail.sendOpsAlert("[결제] 다른 경보", ["줄"], { via: "service" })).toBe(true);
    expect(sent.at(-1)).toMatchObject({ authUser: "billing@example.com", to: "ops@example.com" });
  });

  it("via service인데 서비스 계정이 없으면 보내지 않는다(false) — 위급 계정의 한도를 쓰지 않는다", async () => {
    delete process.env.SERVICE_GMAIL_USER;
    const mail = await load();
    expect(await mail.sendOpsAlert("[결제] 시험 경보", ["줄"], { via: "service" })).toBe(false);
    expect(sent).toEqual([]);
  });

  it("기본(위급·운영 경보)은 위급 계정 그대로", async () => {
    const mail = await load();
    expect(await mail.sendOpsAlert("모든 보호자 채널 실패", ["줄"])).toBe(true);
    expect(sent.at(-1)).toMatchObject({ authUser: "alert@example.com", to: "alert@example.com" });
  });
});
