/**
 * 보호자 위급 메일 — 사용자가 정하는 값(이름)은 HTML의 **모든** 자리에서 이스케이프한다.
 *
 * 2026-10-07 재검토: 본문 첫 줄은 esc(이름)였는데 "👉 지금 바로 OOO님께…" 행동 안내 줄만 이스케이프가 빠져,
 *   이름에 링크 태그를 넣으면 공식 발송 계정 메일에 임의 링크가 실렸다(피싱). 같은 날 알림 이름을 실명으로
 *   바꾸면서 이 경로가 모든 대화 응급에서 쓰이게 됐다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendMail = vi.fn<(opts: unknown) => Promise<{ messageId: string }>>(async () => ({ messageId: "x" }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail }) } }));

const SAVED = { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD };
beforeEach(() => {
  vi.resetModules();
  sendMail.mockClear();
  process.env.GMAIL_USER = "ops@example.com";
  process.env.GMAIL_APP_PASSWORD = "app-password";
});
afterEach(() => {
  if (SAVED.user === undefined) delete process.env.GMAIL_USER; else process.env.GMAIL_USER = SAVED.user;
  if (SAVED.pass === undefined) delete process.env.GMAIL_APP_PASSWORD; else process.env.GMAIL_APP_PASSWORD = SAVED.pass;
});

/**
 * 보내는 Gmail 자격증명 없음(2026-10-07 5차) — 위급 알림은 이걸 "설정 문제"로 보고 이메일을 발송 실패로 세지 않는다
 *   (lib/chat/emergency-notify sendGuardianEmail → "none"). 대신 **인스턴스당 한 번** 크게 로그를 남긴다(예전엔 흔적이 없었다).
 *   주소 형식 검사(isValidEmailAddress)는 발송(sendEmergencyEmail)과 같은 규칙 — 걸리면 위급 알림의 영구 실패다.
 */
describe("자격증명 설정 여부 · 주소 형식", () => {
  const P = { userName: "김영자", level: 3 as const, category: "낙상·부상", createdAt: new Date() };

  it.each([["GMAIL_USER"], ["GMAIL_APP_PASSWORD"]])("%s가 없으면 설정 안 됨 — console.error는 인스턴스당 한 번(발송·운영 경보를 거쳐도)", async (missing) => {
    delete process.env[missing];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const mail = await import("@/lib/notify/email");
      expect(mail.isEmailConfigured()).toBe(false);
      expect(mail.isEmailConfigured()).toBe(false);
      // 설정 문제는 다시 보내도 같다(6차 — 위급 알림은 isEmailConfigured로 먼저 걸러 "보낼 곳 없음"으로 센다)
      expect(await mail.sendEmergencyEmail("g@example.com", P)).toBe("permanent");
      expect(await mail.sendOpsAlert("경보", ["본문"])).toBe(false);
      expect(sendMail).not.toHaveBeenCalled();
      // 🔒 없으면 보호자 이메일·운영 경보가 통째로 꺼져 있어도 모른다 / 매번 찍으면 응급마다 로그가 쌓인다
      expect(err.mock.calls.filter((c) => String(c[0]).includes("Gmail SMTP 자격증명 없음"))).toHaveLength(1);
    } finally { err.mockRestore(); }
  });

  it("둘 다 있으면 설정됨 — 로그 없음", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const mail = await import("@/lib/notify/email");
      expect(mail.isEmailConfigured()).toBe(true);
      expect(err).not.toHaveBeenCalled();
    } finally { err.mockRestore(); }
  });

  it.each([
    ["g@example.com", true], ["a.b+c@sub.example.co.kr", true],
    ["not-an-email", false], ["enc:v1:broken", false], ["a@b", false], ["a b@example.com", false], ["", false],
  ])("isValidEmailAddress(%j) → %s — 발송과 같은 규칙", async (to, ok) => {
    const mail = await import("@/lib/notify/email");
    expect(mail.isValidEmailAddress(to)).toBe(ok);
    // 틀린 주소는 다시 보내도 같다(영구) — 보내지도 않는다
    expect(await mail.sendEmergencyEmail(to, P)).toBe(ok ? "ok" : "permanent");
  });
});

/**
 * SMTP 실패 분류(2026-10-07 6차) — 위급 알림이 다시 보낼지(일시) 경보만 할지(영구) 가른다(lib/chat/emergency-notify sendGuardianEmail).
 *   SMTP 응답 코드가 있으면 그것이 먼저다(5xx 영구 · 4xx 일시 — EAUTH여도 454 "잠시 뒤 다시"는 일시), 없으면 EAUTH만 영구,
 *   연결·시간 초과·소켓·DNS와 모르는 오류는 일시. 예전엔 true/false뿐이라 앱 비밀번호가 틀린 것도 60초마다 다시 보냈다.
 */
describe("SMTP 실패 분류 — 영구(다시 보내도 같다)·일시(다시 보낸다)", () => {
  const P = { userName: "김영자", level: 3 as const, category: "낙상·부상", createdAt: new Date() };
  const smtpError = (fields: Record<string, unknown>) => Object.assign(new Error(String(fields.response ?? fields.code ?? "boom")), fields);

  it.each([
    ["EAUTH 535(앱 비밀번호 거절)", { code: "EAUTH", responseCode: 535, response: "535-5.7.8 Username and Password not accepted" }, "permanent"],
    ["EAUTH 응답 코드 없음(자격증명 누락)", { code: "EAUTH" }, "permanent"],
    ["받는 주소 거절 550", { code: "EENVELOPE", responseCode: 550, response: "550 5.1.1 The email account that you tried to reach does not exist" }, "permanent"],
    ["일일 발송 한도 550 5.4.5", { code: "EMESSAGE", responseCode: 550, response: "550 5.4.5 Daily user sending limit exceeded" }, "permanent"],
    ["연결 실패", { code: "ECONNECTION" }, "transient"],
    ["시간 초과", { code: "ETIMEDOUT" }, "transient"],
    ["소켓 오류", { code: "ESOCKET" }, "transient"],
    ["DNS 오류", { code: "EDNS" }, "transient"],
    ["421 잠시 뒤 다시", { code: "EENVELOPE", responseCode: 421, response: "421 4.7.0 Try again later" }, "transient"],
    ["EAUTH여도 454 잠시 뒤 다시", { code: "EAUTH", responseCode: 454, response: "454 4.7.0 Too many login attempts, please try again later" }, "transient"],
    ["모르는 오류", {}, "transient"],
  ] as const)("%s → %s", async (_, fields, kind) => {
    sendMail.mockRejectedValueOnce(smtpError(fields));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mail = await import("@/lib/notify/email");
      // 🔒 영구를 일시로 세면 고칠 때까지 모든 응급이 60초마다 다시 나가고 경보가 쌓인다 / 일시를 영구로 세면 1시간 동안 다시 안 간다
      expect(await mail.sendEmergencyEmail("g@example.com", P)).toBe(kind);
      expect(sendMail).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes(kind === "permanent" ? "Gmail 발송 실패(영구)" : "Gmail 발송 실패(일시)"))).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it.each([["문자열", "smtp exploded"], ["null", null]])("throw된 값이 객체가 아니어도(%s) 일시 실패로 끝난다 — 호출부로 예외가 새지 않는다", async (_, thrown) => {
    sendMail.mockImplementationOnce(() => Promise.reject(thrown));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mail = await import("@/lib/notify/email");
      await expect(mail.sendEmergencyEmail("g@example.com", P)).resolves.toBe("transient");
    } finally { warn.mockRestore(); }
  });
});

/**
 * SMTP 실패 로그에 받는 주소를 남기지 않는다(2026-10-07 7차) — nodemailer는 서버의 거절 응답을 err.message에 붙인다
 *   ("Can't send mail - all recipients were rejected: 550 5.1.1 <g@…>: Recipient address rejected"). 예전엔 그 메시지를 그대로 찍어
 *   보호자 이메일 주소가 서버 로그에 남았다. 이제 code·responseCode·command만 찍는다(분류에 쓰는 값과 같다).
 */
describe("SMTP 실패 로그 — 받는 주소를 싣지 않는다", () => {
  const P = { userName: "김영자", level: 3 as const, category: "낙상·부상", createdAt: new Date() };
  /** nodemailer가 실제로 만드는 모양 — 메시지·응답·거절 목록에 주소가 있다(lib/smtp-connection _formatError·_actionRCPT) */
  const rejected = (addr: string) => Object.assign(
    new Error(`Can't send mail - all recipients were rejected: 550 5.1.1 <${addr}>: Recipient address rejected`),
    { code: "EENVELOPE", response: `550 5.1.1 <${addr}>: Recipient address rejected`, responseCode: 550, command: "RCPT TO", rejected: [addr] },
  );

  it("보호자 위급 메일 실패 — 로그엔 code·responseCode·command만, 주소·응답 원문은 없다", async () => {
    sendMail.mockRejectedValueOnce(rejected("guardian.kim@example.com"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mail = await import("@/lib/notify/email");
      expect(await mail.sendEmergencyEmail("guardian.kim@example.com", P)).toBe("permanent");
      expect(warn).toHaveBeenCalledTimes(1);
      const [label, fields] = warn.mock.calls[0];
      expect(String(label)).toContain("Gmail 발송 실패(영구)");
      expect(fields).toEqual({ code: "EENVELOPE", responseCode: 550, command: "RCPT TO" });
      // 🔒 메시지·응답을 찍으면 보호자 이메일 주소가 서버 로그에 남는다
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/guardian\.kim|example\.com|Recipient address/);
    } finally { warn.mockRestore(); }
  });

  it("운영 경보 메일 실패도 같다 — 받는 주소(운영자)·응답 원문을 싣지 않는다", async () => {
    sendMail.mockRejectedValueOnce(rejected("ops@example.com"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const mail = await import("@/lib/notify/email");
      expect(await mail.sendOpsAlert("경보", ["본문"])).toBe(false);
      expect(sendMail).toHaveBeenCalledTimes(1);   // 실제로 보내려다 실패했다(시도조차 없으면 아래 단언이 공허하다)
      const failure = err.mock.calls.find((c) => String(c[0]).includes("[ops-alert] 발송 실패"));
      expect(failure?.[1]).toEqual({ code: "EENVELOPE", responseCode: 550, command: "RCPT TO" });
      expect(JSON.stringify(err.mock.calls)).not.toMatch(/ops@example\.com|Recipient address/);
    } finally { err.mockRestore(); }
  });
});

describe("이름 이스케이프", () => {
  it.each([3, 2] as const)("L%i — 행동 안내 줄을 포함해 HTML 어디에도 태그가 그대로 들어가지 않는다", async (level) => {
    const { sendEmergencyEmail } = await import("@/lib/notify/email");
    const evil = `<a href="//ev.il">보호자 확인</a>`;
    expect(await sendEmergencyEmail("g@example.com", { userName: evil, level, category: "낙상·부상", createdAt: new Date() })).toBe("ok");
    const { html } = sendMail.mock.calls[0][0] as { html: string };
    // 🔒 예전엔 "👉 지금 바로 <a href=…>…님께" — 공식 메일에 임의 링크
    expect(html).not.toContain("<a href");
    expect(html).toContain("&lt;a href=&quot;//ev.il&quot;&gt;");
  });
});
