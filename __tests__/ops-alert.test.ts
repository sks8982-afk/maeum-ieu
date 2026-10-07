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

/**
 * 1시간 창은 **보낸** 경보에만(2026-10-07 9차) — 예전엔 보내기 전에 1시간 기록을 남겨, 메일이 실패하거나 호출부의 상한(위급 알림 35초 —
 *   emergency-notify-alerts OPS_ALERT_TIMEOUT_MS)이 먼저 끝나 아무것도 나가지 않았어도 같은 사유가 1시간 동안 막혔다 — 장애를 알려야 할
 *   그때 운영자는 아무것도 받지 못했다. 보내는 동안·실패한 뒤에는 60초 바닥만(실패는 실패한 시각부터) — Gmail 장애 동안 응급 턴마다
 *   다시 보내며 보호자 이메일과 같은 계정의 일일 한도를 태우지 않을 만큼.
 */
describe("1시간 창은 보낸 경보에만 — 보내는 중·실패한 뒤에는 60초 바닥(9차)", () => {
  const SUBJECT = "응급 알림 실패 L3 medical_acute u-1";
  const textOf = (i: number) => (sendMail.mock.calls[i]?.[0] as { text: string }).text;
  let err: { mockRestore: () => void };
  beforeEach(() => {
    vi.useFakeTimers();
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { err.mockRestore(); vi.useRealTimers(); });

  it("첫 발송이 실패하면 60초 안의 같은 사유는 억제, 61초 뒤에는 다시 보낸다 — 그 메일에 억제 건수를 싣는다", async () => {
    sendMail.mockRejectedValueOnce(new Error("smtp down"));
    const send = await load();
    expect(await send(SUBJECT, ["처음"])).toBe(false);
    vi.advanceTimersByTime(30 * 1000);
    // 🔒 바닥이 없으면 Gmail 장애 동안 응급 턴마다 다시 보내 보호자 이메일과 같은 계정의 일일 한도를 태운다
    expect(await send(SUBJECT, ["30초 뒤"])).toBe(false);
    expect(sendMail).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(31 * 1000);
    // 🔒 보내지 못한 경보가 1시간을 막으면 장애를 알려야 할 그때 운영자는 아무것도 받지 못한다
    expect(await send(SUBJECT, ["61초 뒤"])).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(textOf(1)).toMatch(/같은 사유 1건/);
  });

  it("바닥은 실패한 시각부터 — 40초 걸려 실패한 뒤 30초엔 아직 억제, 61초 뒤에 다시 보낸다", async () => {
    sendMail.mockImplementationOnce(() => new Promise((_, reject) => { setTimeout(() => reject(new Error("smtp timeout")), 40_000); }));
    const send = await load();
    const first = send(SUBJECT, ["처음"]);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await first).toBe(false);
    vi.advanceTimersByTime(30 * 1000);   // 시작부터 70초 · 실패부터 30초
    // 🔒 시작부터 재면 느린 실패(SMTP 상한 ~31초) 뒤 곧바로 다시 보낸다
    expect(await send(SUBJECT, ["실패 30초 뒤"])).toBe(false);
    vi.advanceTimersByTime(31 * 1000);
    expect(await send(SUBJECT, ["실패 61초 뒤"])).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("답이 없는 동안은 60초 바닥으로 억제 — 호출부의 35초 상한이 먼저 끝나도 1시간 기록이 남지 않아 61초 뒤 다시 보낸다", async () => {
    sendMail.mockImplementationOnce(() => new Promise(() => {}));   // 끝내 답하지 않는 SMTP(앞의 DNS 멈춤 등)
    const send = await load();
    const { withinMs } = await import("@/lib/within-ms");
    // 위급 알림의 경보 상한과 같은 감싸기(emergency-notify-alerts sendOpsAlert — withinMs 35초)
    const bounded = withinMs(send(SUBJECT, ["처음"]), 35_000).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    // 🔒 같은 사유가 보내는 중에 몰려도 한 통만
    expect(await send(SUBJECT, ["보내는 중"])).toBe(false);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await bounded).toBeInstanceOf(Error);   // 호출부는 35초에 실패로 쳤다
    await vi.advanceTimersByTimeAsync(26_000);     // 시작부터 61초
    // 🔒 끝내 나가지 않은 경보가 1시간을 막으면 그 사이 같은 사유의 경보가 모두 묻힌다
    expect(await send(SUBJECT, ["61초 뒤"])).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("성공한 경보는 그대로 1시간 — 61초·59분 뒤에도 억제, 61분 뒤에 다시", async () => {
    const send = await load();
    expect(await send(SUBJECT, ["처음"])).toBe(true);
    vi.advanceTimersByTime(61 * 1000);
    // 🔒 성공도 바닥(60초)만 걸면 장애가 이어지는 동안 1분마다 같은 메일이 간다
    expect(await send(SUBJECT, ["61초 뒤"])).toBe(false);
    vi.advanceTimersByTime(58 * 60 * 1000);
    expect(await send(SUBJECT, ["59분 뒤"])).toBe(false);
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(await send(SUBJECT, ["61분 뒤"])).toBe(true);
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it("실패한 메일에 실으려던 억제 건수는 다음 메일로 넘어간다 — 규모를 잃지 않는다", async () => {
    const send = await load();
    expect(await send(SUBJECT, ["처음"])).toBe(true);   // 1시간 창
    await send(SUBJECT, ["억제1"]);
    await send(SUBJECT, ["억제2"]);
    vi.advanceTimersByTime(61 * 60 * 1000);
    sendMail.mockRejectedValueOnce(new Error("smtp down"));
    expect(await send(SUBJECT, ["창 뒤 첫 메일 — 실패"])).toBe(false);
    expect(textOf(1)).toMatch(/같은 사유 2건/);   // 실으려던 건수
    vi.advanceTimersByTime(61 * 1000);
    expect(await send(SUBJECT, ["다시"])).toBe(true);
    // 🔒 실패와 함께 건수를 버리면 복구 뒤 첫 메일이 1건짜리 사고처럼 보인다
    expect(textOf(2)).toMatch(/같은 사유 2건/);
  });
});
