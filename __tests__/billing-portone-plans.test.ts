/**
 * 웹 PG 요금제·결제수단·기능 스위치(lib/billing/portone-plans) + Play 쪽 isProProduct의 PG 요금제 인정(lib/billing/plans).
 *
 * 지키는 것:
 *   · BILLING_PLANS가 **없으면** 임시 기본 3개, **형식이 틀리면 유료를 아예 노출하지 않는다**(fail-closed) + 경고 한 번.
 *     일부만 노출하면 약관·화면의 요금표와 어긋난다 — 하나라도 틀리면 전부 버린다.
 *   · 무료 한도 이하인 유료 요금제는 돈을 받고 아무것도 주지 않는다 — 틀린 설정으로 본다.
 *   · 기능 스위치는 정확히 "1" + 필수 설정이 다 있어야 켜진다(키를 넣기 전 운영 변화 0).
 *   · 결제수단은 채널 키가 있는 것만.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

/** 사업자 정보 — 시험용 값(실제 정보 아님) */
const BIZ: Record<string, string> = {
  BIZ_NAME: "주식회사 시험", BIZ_OWNER: "홍길동", BIZ_ADDRESS: "경기도 화성시 시험로 1", BIZ_PHONE: "031-000-0000",
  BIZ_EMAIL: "help@example.com", BIZ_REG_NO: "220-81-62517", BIZ_MAIL_ORDER_NO: "제2026-화성-0000호", BIZ_MAIL_ORDER_AUTHORITY: "화성시",
};
const KEYS = [
  "DAILY_TURN_LIMIT", "BILLING_PLANS", "BILLING_PG_ENABLED", "PORTONE_STORE_ID", "PORTONE_API_SECRET", "PORTONE_WEBHOOK_SECRET",
  "ENCRYPTION_KEY", "PORTONE_CHANNEL_KEY_CARD", "PORTONE_CHANNEL_KEY_KAKAOPAY", "PORTONE_CHANNEL_KEY_NAVERPAY", "PORTONE_MODE",
  "BILLING_PRO_PRODUCT_IDS", "CRON_SECRET", "GMAIL_USER", "GMAIL_APP_PASSWORD", "SERVICE_GMAIL_USER", "SERVICE_GMAIL_APP_PASSWORD",
  "PORTONE_TEST_USER_IDS", ...Object.keys(BIZ),
] as const;
const saved: Record<string, string | undefined> = {};
const READY: Record<string, string> = {
  DAILY_TURN_LIMIT: "10", BILLING_PG_ENABLED: "1", PORTONE_STORE_ID: "store", PORTONE_API_SECRET: "secret",
  PORTONE_WEBHOOK_SECRET: "whsec", ENCRYPTION_KEY: "k".repeat(64), PORTONE_CHANNEL_KEY_CARD: "card-key", PORTONE_MODE: "test",
  CRON_SECRET: "cron-secret", GMAIL_USER: "alert@example.com", GMAIL_APP_PASSWORD: "pw-emergency",
  SERVICE_GMAIL_USER: "billing@example.com", SERVICE_GMAIL_APP_PASSWORD: "pw-billing", ...BIZ,
};

async function load(env: Record<string, string | undefined> = READY) {
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  vi.resetModules();
  return { pg: await import("@/lib/billing/portone-plans"), plans: await import("@/lib/billing/plans") };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; }
});

describe("요금제 — 없으면 기본 3개, 틀리면 노출 안 함", () => {
  it("BILLING_PLANS가 없으면 임시 기본 3개(하루 20·30·60회, 14,900·19,900·39,900원) — 이름은 '월 이용권(하루 대화 N회)'", async () => {
    const { pg } = await load();
    expect(pg.getPgPlans()).toEqual([
      { id: "day20", name: "월 이용권(하루 대화 20회)", dailyTurnLimit: 20, priceKrw: 14_900 },
      { id: "day30", name: "월 이용권(하루 대화 30회)", dailyTurnLimit: 30, priceKrw: 19_900 },
      { id: "day60", name: "월 이용권(하루 대화 60회)", dailyTurnLimit: 60, priceKrw: 39_900 },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("설정한 요금제를 쓴다 — 이름은 설정에서 받지 않는다('충전·크레딧·횟수권' 같은 표현이 끼어들지 않게)", async () => {
    const { pg } = await load({ ...READY, BILLING_PLANS: JSON.stringify([{ id: "day40", name: "대화 충전 40", dailyTurnLimit: 40, priceKrw: 24_900 }]) });
    expect(pg.getPgPlans()).toEqual([{ id: "day40", name: "월 이용권(하루 대화 40회)", dailyTurnLimit: 40, priceKrw: 24_900 }]);
    expect(pg.findPlan("day40")?.priceKrw).toBe(24_900);
    expect(pg.findPlan("day30")).toBeUndefined(); // 기본값과 섞이지 않는다
  });

  it.each([
    ["JSON이 깨짐", "[{id:"],
    ["배열이 아님", JSON.stringify({ id: "day30", dailyTurnLimit: 30, priceKrw: 19_900 })],
    ["빈 배열", "[]"],
    ["음수 가격", JSON.stringify([{ id: "day30", dailyTurnLimit: 30, priceKrw: -1 }])],
    ["100원 미만(네이버페이 최소 결제)", JSON.stringify([{ id: "day30", dailyTurnLimit: 30, priceKrw: 99 }])],
    ["100만 원 초과(자릿수 오타)", JSON.stringify([{ id: "day30", dailyTurnLimit: 30, priceKrw: 1_990_000 }])],
    ["소수 가격", JSON.stringify([{ id: "day30", dailyTurnLimit: 30, priceKrw: 19_900.5 }])],
    ["한도가 정수가 아님", JSON.stringify([{ id: "day30", dailyTurnLimit: "30", priceKrw: 19_900 }])],
    ["id에 대문자", JSON.stringify([{ id: "Day30", dailyTurnLimit: 30, priceKrw: 19_900 }])],
    ["id 중복", JSON.stringify([{ id: "day30", dailyTurnLimit: 30, priceKrw: 19_900 }, { id: "day30", dailyTurnLimit: 60, priceKrw: 39_900 }])],
    ["무료 한도(10회) 이하", JSON.stringify([{ id: "day10", dailyTurnLimit: 10, priceKrw: 9_900 }])],
    ["11개 이상", JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ id: `day${20 + i}`, dailyTurnLimit: 20 + i, priceKrw: 10_000 + i })))],
  ])("%s → 하나라도 틀리면 전부 버린다(유료 노출 안 함) + 경고", async (_label, raw) => {
    // 요금제 배열이면 올바른 요금제(day60)를 하나 덧붙인다 — 틀린 것 하나 때문에 올바른 것까지 버리는지 본다
    const ok = JSON.stringify({ id: "day60", dailyTurnLimit: 60, priceKrw: 39_900 });
    const { pg } = await load({ ...READY, BILLING_PLANS: raw.startsWith("[{") && !raw.includes("{id:") ? raw.replace(/\]$/, `,${ok}]`) : raw });
    expect(pg.getPgPlans()).toEqual([]);
    expect(pg.findPlan("day60")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("BILLING_PLANS 형식 오류"));
  });

  it("같은 틀린 값은 경고를 한 번만 — 요청마다 로그가 쌓이지 않게. 값이 바뀌면 다시 읽는다(재시작 없이)", async () => {
    const { pg } = await load({ ...READY, BILLING_PLANS: "not json" });
    pg.getPgPlans(); pg.getPgPlans(); pg.findPlan("day30");
    expect(warn).toHaveBeenCalledTimes(1);
    process.env.BILLING_PLANS = JSON.stringify([{ id: "day30", dailyTurnLimit: 30, priceKrw: 19_900 }]);
    expect(pg.getPgPlans().map((p) => p.id)).toEqual(["day30"]);
  });

  it("무료 한도가 기본값(100)이면 기본 요금제 셋 다 무료 이하 → 노출 안 함(돈 받고 줄 게 없다)", async () => {
    const { pg } = await load({ ...READY, DAILY_TURN_LIMIT: undefined });
    expect(pg.getPgPlans()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("무료 한도(100회) 이하"));
  });

  it("무료 한도를 끈 운영(0)에서는 한도 비교를 하지 않는다", async () => {
    const { pg } = await load({ ...READY, DAILY_TURN_LIMIT: "0" });
    expect(pg.getPgPlans()).toHaveLength(3);
  });
});

describe("결제수단 — 채널 키가 있는 것만", () => {
  it("카드만 설정 → 카드만, 공백뿐인 키는 없는 것", async () => {
    const { pg } = await load({ ...READY, PORTONE_CHANNEL_KEY_NAVERPAY: "   " });
    expect(pg.availablePayMethods()).toEqual(["CARD"]);
    expect(pg.channelKeyFor("CARD")).toBe("card-key");
    expect(pg.channelKeyFor("NAVERPAY")).toBeUndefined();
  });

  it("셋 다 설정 → 셋 다(카드·카카오페이·네이버페이 순)", async () => {
    const { pg } = await load({ ...READY, PORTONE_CHANNEL_KEY_KAKAOPAY: "kakao-key", PORTONE_CHANNEL_KEY_NAVERPAY: "naver-key" });
    expect(pg.availablePayMethods()).toEqual(["CARD", "KAKAOPAY", "NAVERPAY"]);
    expect(pg.channelKeyFor("KAKAOPAY")).toBe("kakao-key");
  });

  it("결제수단 값 검사", async () => {
    const { pg } = await load();
    expect(pg.isPayMethod("KAKAOPAY")).toBe(true);
    expect(pg.isPayMethod("kakaopay")).toBe(false);
    expect(pg.isPayMethod(undefined)).toBe(false);
  });
});

describe("기능 스위치 — 정확히 '1' + 필수 설정", () => {
  it("다 있으면 켜진다", async () => {
    const { pg } = await load();
    expect(pg.isPgEnabled()).toBe(true);
    expect(pg.pgConfigProblems()).toEqual([]);
  });

  it.each([["미설정", undefined], ["true", "true"], ["0", "0"], [" 1", " 1"]])("스위치 %s → 꺼짐", async (_l, v) => {
    const { pg } = await load({ ...READY, BILLING_PG_ENABLED: v });
    expect(pg.isPgEnabled()).toBe(false);
  });

  it.each(["PORTONE_STORE_ID", "PORTONE_API_SECRET", "PORTONE_WEBHOOK_SECRET", "ENCRYPTION_KEY"])("%s가 없으면 꺼짐 — 문제 목록에 이름만", async (k) => {
    const { pg } = await load({ ...READY, [k]: undefined });
    expect(pg.isPgEnabled()).toBe(false);
    expect(pg.pgConfigProblems()).toEqual([k]);
  });

  it("결제수단이 하나도 없으면 꺼짐", async () => {
    const { pg } = await load({ ...READY, PORTONE_CHANNEL_KEY_CARD: undefined });
    expect(pg.isPgEnabled()).toBe(false);
    expect(pg.pgConfigProblems()).toEqual(["PORTONE_CHANNEL_KEY_*(하나 이상)"]);
  });

  it("팔 수 있는 요금제가 없으면 꺼짐", async () => {
    const { pg } = await load({ ...READY, BILLING_PLANS: "[]" });
    expect(pg.isPgEnabled()).toBe(false);
    expect(pg.pgConfigProblems()[0]).toContain("BILLING_PLANS");
  });

  it("PORTONE_MODE가 test|live가 아니면 꺼짐, live면 LIVE 채널만 인정", async () => {
    const bad = await load({ ...READY, PORTONE_MODE: "prod" });
    expect(bad.pg.isPgEnabled()).toBe(false);
    expect(bad.pg.expectedChannelType()).toBe("TEST");
    const live = await load({ ...READY, PORTONE_MODE: "live" });
    expect(live.pg.isPgEnabled()).toBe(true);
    expect(live.pg.expectedChannelType()).toBe("LIVE");
  });

  it("PORTONE_MODE를 비우면 꺼짐 — 운영에서 빠지면 시험 모드로 조용히 떨어져 시험 결제가 혜택이 되거나 실결제가 대조에 걸린다", async () => {
    const unset = await load({ ...READY, PORTONE_MODE: undefined });
    expect(unset.pg.isPgEnabled()).toBe(false);
    expect(unset.pg.pgConfigProblems()).toEqual(["PORTONE_MODE(test|live)"]);
    expect(unset.pg.expectedChannelType()).toBe("TEST"); // 이미 가입한 이용권 쪽 판정은 실서비스 채널을 기본으로 믿지 않는다
  });

  it("CRON_SECRET이 없으면 꺼짐 — 예약 작업(3일 전 안내·대사·만료·환불 이어 하기)이 조용히 멈춘다", async () => {
    const { pg } = await load({ ...READY, CRON_SECRET: undefined });
    expect(pg.pgConfigProblems()).toEqual(["CRON_SECRET"]);
  });

  it("결제 안내 메일 발신 계정이 없으면 꺼짐 — 자동결제마다 알려야 한다(전자상거래법 제8조③)", async () => {
    const { pg } = await load({ ...READY, SERVICE_GMAIL_APP_PASSWORD: undefined });
    expect(pg.isPgEnabled()).toBe(false);
    expect(pg.pgConfigProblems()).toEqual(["SERVICE_GMAIL_USER·SERVICE_GMAIL_APP_PASSWORD"]);
  });

  it("결제 안내 메일이 위급 메일과 같은 계정이면 꺼짐 — Gmail 하루 한도를 같이 쓰면 결제 메일이 보호자 위급 메일을 막는다", async () => {
    const { pg } = await load({ ...READY, SERVICE_GMAIL_USER: "Alert@Example.com" });
    expect(pg.isPgEnabled()).toBe(false);
    expect(pg.pgConfigProblems()[0]).toContain("GMAIL_USER와 달라야");
  });

  it.each(Object.keys(BIZ))("사업자 정보 %s가 없으면 꺼짐 — 결제 화면 고지와 하단 표시가 비게 된다(전자상거래법 제10조①·제13조①)", async (k) => {
    const { pg } = await load({ ...READY, [k]: undefined });
    expect(pg.isPgEnabled()).toBe(false);
    expect(pg.pgConfigProblems()).toEqual([k]);
  });
});

describe("시험(TEST) 모드 결제 — 정한 계정만", () => {
  it("PORTONE_TEST_USER_IDS에 적힌 계정만 시험 결제 — 비어 있으면 아무도(시험 결제로 실제 유료 혜택이 생기지 않게)", async () => {
    const none = await load();
    expect(none.pg.testModeAllows("guardian-1")).toBe(false);
    const listed = await load({ ...READY, PORTONE_TEST_USER_IDS: " tester-1 , guardian-9 " });
    expect(listed.pg.testModeAllows("guardian-9")).toBe(true);
    expect(listed.pg.testModeAllows("guardian-1")).toBe(false);
    expect((await load({ ...READY, PORTONE_TEST_USER_IDS: "*" })).pg.testModeAllows("anyone")).toBe(true);
  });

  it("실연동(live)에서는 계정을 가리지 않는다", async () => {
    const { pg } = await load({ ...READY, PORTONE_MODE: "live" });
    expect(pg.testModeAllows("guardian-1")).toBe(true);
  });
});

describe("포트원 설정 여부(portoneConfigured) — 상점 아이디가 있으면 설정을 시작한 것", () => {
  it("상점 아이디만 본다 — API Secret이 빠져도(교체 중 실수) 이미 있는 이용권의 해지·관리 화면은 열려 있어야 한다", async () => {
    expect((await load({ ...READY, PORTONE_API_SECRET: undefined })).pg.portoneConfigured()).toBe(true);
    expect((await load({ ...READY, PORTONE_STORE_ID: " " })).pg.portoneConfigured()).toBe(false);
  });
});

describe("Play 쪽 유료 상품 판정 — PG 요금제 id도 유료로 인정", () => {
  it("BILLING_PRO_PRODUCT_IDS가 Play 상품만 적어도 PG 요금제 id는 유료", async () => {
    const { plans } = await load({ ...READY, BILLING_PRO_PRODUCT_IDS: "maeum_pro_monthly" });
    expect(plans.isProProduct("maeum_pro_monthly")).toBe(true);
    expect(plans.isProProduct("day30")).toBe(true);
    expect(plans.isProProduct("day999")).toBe(false);
  });

  it("요금제 설정이 깨지면 PG id도 인정하지 않는다(Play 목록만)", async () => {
    const { plans } = await load({ ...READY, BILLING_PRO_PRODUCT_IDS: "maeum_pro_monthly", BILLING_PLANS: "broken" });
    expect(plans.isProProduct("day30")).toBe(false);
    expect(plans.isProProduct("maeum_pro_monthly")).toBe(true);
  });
});
