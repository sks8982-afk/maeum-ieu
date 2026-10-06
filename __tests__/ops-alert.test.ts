/**
 * 운영자 경보 쓰로틀 — **내가 만든 결함**을 고정한다.
 *
 * 2026-10-02 적대 리뷰가 잡았다: sendOpsAlert를 신설하면서 dedup을 넣지 않았다.
 *   RDS 장애처럼 "모든 보호자 채널 실패"가 지속되면 응급 턴마다 경보 메일이 나가고,
 *   **보호자 알림과 같은 Gmail 계정(GMAIL_USER)을 쓰므로** 일일 발신 한도를 스스로 태운다.
 *   그러면 복구된 뒤 가야 할 보호자 이메일이 못 나간다 — 운영자에게 알리려다 환자의 알림
 *   채널을 죽이는 구조로, 바로 전날 emergency-notify에서 고친 것과 같은 유형이다.
 *
 * 🔒 양방향을 모두 고정한다: 억제가 없으면 쿼터가 타고, 과하게 억제하면 장애를 모른다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendMail = vi.fn(async (_opts: unknown) => ({ messageId: "x" }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail }) } }));

const SAVED = {
  user: process.env.GMAIL_USER,
  pass: process.env.GMAIL_APP_PASSWORD,
  ops: process.env.OPS_ALERT_EMAIL,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();   // 모듈 수준 쓰로틀 맵을 매 테스트 초기화
  sendMail.mockResolvedValue({ messageId: "x" });
  process.env.GMAIL_USER = "ops@example.com";
  process.env.GMAIL_APP_PASSWORD = "app-password";
  process.env.OPS_ALERT_EMAIL = "admin@example.com";
});

afterEach(() => {
  if (SAVED.user === undefined) delete process.env.GMAIL_USER; else process.env.GMAIL_USER = SAVED.user;
  if (SAVED.pass === undefined) delete process.env.GMAIL_APP_PASSWORD; else process.env.GMAIL_APP_PASSWORD = SAVED.pass;
  if (SAVED.ops === undefined) delete process.env.OPS_ALERT_EMAIL; else process.env.OPS_ALERT_EMAIL = SAVED.ops;
});

const load = async () => (await import("@/lib/notify/email")).sendOpsAlert;

describe("쿼터 보호 — 같은 사유는 창당 1회", () => {
  it("첫 경보는 발송된다", async () => {
    const send = await load();
    expect(await send("응급 알림 실패 (L3 medical_acute)", ["사유: DB 장애"])).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("같은 사유 2회차부터는 억제된다", async () => {
    const send = await load();
    await send("응급 알림 실패 (L3 medical_acute)", ["a"]);
    const second = await send("응급 알림 실패 (L3 medical_acute)", ["b"]);
    // 🔒 true가 되면 장애 지속 중 메일이 무제한으로 나가 보호자 이메일 채널까지 죽는다
    expect(second).toBe(false);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("사유가 다르면 각각 1회씩 나간다 (과도 억제 금지)", async () => {
    const send = await load();
    await send("응급 알림 실패 (L3 medical_acute)", ["a"]);
    await send("응급 알림 실패 (L2 fall_injury)", ["b"]);
    // 🔒 전부 묶어 억제하면 다른 유형의 장애를 운영자가 영영 모른다
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
});

describe("규모를 알린다 — 억제 건수", () => {
  it("창이 지난 뒤 첫 메일에 억제 건수를 싣는다", async () => {
    vi.useFakeTimers();
    try {
      const send = await load();
      await send("응급 알림 실패 (L3 x)", ["처음"]);
      await send("응급 알림 실패 (L3 x)", ["억제1"]);
      await send("응급 알림 실패 (L3 x)", ["억제2"]);
      vi.advanceTimersByTime(61 * 60 * 1000);   // 창 경과
      await send("응급 알림 실패 (L3 x)", ["다시"]);
      expect(sendMail).toHaveBeenCalledTimes(2);
      const body = (sendMail.mock.calls[1]?.[0] as { text: string }).text;
      // 🔒 건수가 없으면 1건짜리 사고와 전면 장애가 똑같은 메일로 보인다
      expect(body).toMatch(/2건/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("설정·실패에 강건하다", () => {
  /**
   * 2026-10-06 사용자: "따로 없긴 한데, 그 Gmail로 보내게 되어 있을 텐데" — 운영 경보 전용 주소를 따로 두지 않았다.
   *   예전엔 OPS_ALERT_EMAIL이 없으면 **아무에게도** 안 보냈다(모든 보호자 채널이 실패한 응급을 아무도 모름).
   *   이제는 보내는 Gmail 계정(GMAIL_USER) 자신의 받은편지함으로 보낸다.
   */
  it("OPS_ALERT_EMAIL 미설정이면 보내는 Gmail(GMAIL_USER) 자신에게 보낸다", async () => {
    delete process.env.OPS_ALERT_EMAIL;
    const send = await load();
    expect(await send("제목", ["본문"])).toBe(true);
    expect((sendMail.mock.calls[0]?.[0] as { to?: string })?.to).toBe("ops@example.com");
  });

  it("OPS_ALERT_EMAIL이 있으면 그 주소가 우선", async () => {
    const send = await load();
    await send("제목", ["본문"]);
    expect((sendMail.mock.calls[0]?.[0] as { to?: string })?.to).toBe("admin@example.com");
  });

  it("Gmail 설정 자체가 없으면 조용히 skip (기능을 막지 않는다)", async () => {
    delete process.env.OPS_ALERT_EMAIL;
    delete process.env.GMAIL_USER;
    const send = await load();
    expect(await send("제목", ["본문"])).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("SMTP가 throw해도 false를 돌려줄 뿐 터지지 않는다", async () => {
    sendMail.mockRejectedValue(new Error("smtp down"));
    const send = await load();
    // 🔒 예외가 새면 이미 실패 처리 중인 호출부가 또 무너진다
    await expect(send("제목", ["본문"])).resolves.toBe(false);
  });
});
