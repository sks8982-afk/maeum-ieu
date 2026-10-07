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

describe("이름 이스케이프", () => {
  it.each([3, 2] as const)("L%i — 행동 안내 줄을 포함해 HTML 어디에도 태그가 그대로 들어가지 않는다", async (level) => {
    const { sendEmergencyEmail } = await import("@/lib/notify/email");
    const evil = `<a href="//ev.il">보호자 확인</a>`;
    expect(await sendEmergencyEmail("g@example.com", { userName: evil, level, category: "낙상·부상", createdAt: new Date() })).toBe(true);
    const { html } = sendMail.mock.calls[0][0] as { html: string };
    // 🔒 예전엔 "👉 지금 바로 <a href=…>…님께" — 공식 메일에 임의 링크
    expect(html).not.toContain("<a href");
    expect(html).toContain("&lt;a href=&quot;//ev.il&quot;&gt;");
  });
});
