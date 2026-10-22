/**
 * 결제 안내 메일(lib/billing/portone-mail) — 결제 완료·3일 전·실패·만료·해지·환불.
 *
 * 지키는 것:
 *   · 결제마다 금액·일시·수단·이용기간·다음 결제·혜택 대상·영수증·해지 링크·판매자 정보(전자상거래법 제8조③ — research D 4).
 *   · 사용자가 정한 값(이름)은 HTML 모든 자리에서 이스케이프, 영수증 주소는 https만 링크로.
 *   · 메일 설정이 없거나 실패해도 throw하지 않는다(결제 처리를 막지 않는다) — 설정 없음 경고는 한 번.
 *   · 금지 표현 없음('치매·진단·검출' 같은 의학적 효능, '충전·크레딧·횟수권').
 *   · 시각은 KST로 — 서버(UTC) 시간대와 무관.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { db, mail, sendServiceEmailMock, kst, BIZ_ENV } from "./helpers/billing-portone-harness";

const load = () => import("@/lib/billing/portone-mail");

function seedSub(over: Record<string, unknown> = {}) {
  db.user.rows.push({ id: "g1", email: "g1@example.com", name: "보호자" }, { id: "e1", email: "e1@example.com", name: "김<b>영자</b>" });
  db.subscription.rows.push({
    id: "sub-1", provider: "portone", purchaserUserId: "g1", beneficiaryUserId: "e1", status: "active", priceKrw: 19_900,
    dailyTurnLimit: 30, payMethod: "KAKAOPAY", expiresAt: kst("2026-12-02T10:00:00"), nextChargeAt: kst("2026-12-02T10:00:00"), ...over,
  });
}

const paid = { amountKrw: 19_900, paidAt: kst("2026-11-02T14:05:00"), periodStart: kst("2026-11-02T14:05:00"),
  periodEnd: kst("2026-12-02T10:00:00"), receiptUrl: "https://receipt.example.com/r1", nextCharge: true };

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => warn.mockRestore());

describe("결제 완료 메일 — 법이 요구하는 항목", () => {
  it("금액·일시·수단·이용기간·다음 결제·혜택 대상·영수증·관리 링크", async () => {
    seedSub();
    const { sendPaymentCompleteMail } = await load();
    expect(await sendPaymentCompleteMail("sub-1", paid)).toBe(true);
    const m = mail.sent[0];
    expect(m.to).toBe("g1@example.com");
    expect(m.subject).toBe("[마음이음] 이용권 결제 완료 — 19,900원");
    for (const s of ["마음이음 월 이용권(하루 대화 30회)", "19,900원(부가세 포함)", "2026-11-02 14:05", "카카오페이",
      "2026-11-02 ~ 2026-12-01", "2026-12-02 19,900원", "영수증 보기: https://receipt.example.com/r1", "구독 관리(해지·환불): https://maeum.example.com/subscribe"]) {
      expect(m.text, s).toContain(s);
    }
  });

  it("해지 예약된 회차는 '다음 결제: 없음'", async () => {
    seedSub();
    const { sendPaymentCompleteMail } = await load();
    await sendPaymentCompleteMail("sub-1", { ...paid, nextCharge: false });
    expect(mail.sent[0].text).toContain("다음 결제: 없음(해지 예약됨)");
  });

  it("이름은 HTML에서 이스케이프 — 태그가 그대로 들어가지 않는다", async () => {
    seedSub();
    const { sendPaymentCompleteMail } = await load();
    await sendPaymentCompleteMail("sub-1", paid);
    expect(mail.sent[0].html).toContain("김&lt;b&gt;영자&lt;/b&gt;");
    expect(mail.sent[0].html).not.toContain("<b>영자</b>");
  });

  it("영수증 주소는 https만 — 아니면 링크를 싣지 않는다", async () => {
    const { safeReceiptUrl } = await load();
    expect(safeReceiptUrl("https://receipt.example.com/r1")).toBe("https://receipt.example.com/r1");
    for (const bad of ["http://receipt.example.com", "javascript:alert(1)", "https://x.com/\"><script>", "", null, undefined]) {
      expect(safeReceiptUrl(bad), String(bad)).toBeNull();
    }
  });

  it("판매자 정보는 설정된 것만 싣고, 없으면 그 줄을 뺀다", async () => {
    seedSub();
    for (const k of Object.keys(BIZ_ENV)) delete process.env[k];
    const { sendPaymentCompleteMail } = await load();
    await sendPaymentCompleteMail("sub-1", paid);
    expect(mail.sent[0].text).not.toContain("판매자");
    Object.assign(process.env, { BIZ_NAME: "마음이음", BIZ_REG_NO: "000-00-00000", BIZ_PHONE: "031-000-0000" });
    await sendPaymentCompleteMail("sub-1", paid);
    expect(mail.sent[1].text).toContain("판매자 마음이음 · 사업자등록번호 000-00-00000 · 고객센터 031-000-0000");
  });

  it("결제 완료 메일은 계약 내용 문서 — 판매자 전부(대표·주소·통신판매업 포함)·약관 두 링크·청약철회 효과·해지 두 방식", async () => {
    seedSub();
    const { sendPaymentCompleteMail } = await load();
    const terms = await import("@/lib/billing/pg-terms");
    await sendPaymentCompleteMail("sub-1", paid);
    const t = mail.sent[0].text;
    expect(t).toContain(
      "판매자 주식회사 시험상호 · 대표 홍길동 · 주소 경기도 화성시 시험로 1 · 사업자등록번호 220-81-62517 · "
      + "통신판매업 신고 제2026-화성-0000호(화성시) · 고객센터 031-000-0000 · help@example.com",
    );
    for (const s of [
      "유료서비스 이용약관: https://maeum.example.com/terms/paid", "환불·청약철회 정책: https://maeum.example.com/terms/refund",
      terms.WITHDRAWAL_SUMMARY, terms.CANCEL_SUMMARY[0], terms.CANCEL_SUMMARY[1],
    ]) expect(t, s).toContain(s);
  });

  it("NEXTAUTH_URL이 없으면 관리 링크를 싣지 않는다(엉뚱한 주소를 만들지 않게)", async () => {
    seedSub();
    delete process.env.NEXTAUTH_URL;
    const { sendPaymentCompleteMail } = await load();
    await sendPaymentCompleteMail("sub-1", paid);
    expect(mail.sent[0].text).not.toContain("구독 관리(해지·환불):");
  });
});

describe("나머지 안내 메일", () => {
  it("3일 전 안내 — 결제 예정일·금액·해지 방법", async () => {
    seedSub();
    const { sendRenewalNoticeMail } = await load();
    await sendRenewalNoticeMail("sub-1", kst("2026-12-02T10:00:00"));
    expect(mail.sent[0].subject).toBe("[마음이음] 2026-12-02 이용권 자동결제 예정 — 19,900원");
    expect(mail.sent[0].text).toContain("결제 예정일 전에 구독 관리 화면에서 해지");
  });

  it("결제 실패 — 다시 시도할 시각(KST)·혜택 유지", async () => {
    seedSub();
    const { sendPaymentFailedMail } = await load();
    await sendPaymentFailedMail("sub-1", { retryAt: kst("2026-12-03T10:00:00") });
    expect(mail.sent[0].text).toContain("다시 시도: 2026-12-03 10:00");
    expect(mail.sent[0].text).toContain("혜택은 그대로");
  });

  it("만료 — 결제 실패로 끝남 / 해지한 기간이 끝남", async () => {
    seedSub();
    const { sendExpiredMail } = await load();
    await sendExpiredMail("sub-1", "payment_failed");
    await sendExpiredMail("sub-1", "period_end");
    expect(mail.sent[0].text).toContain("결제가 되지 않아 이용권이 끝났습니다");
    expect(mail.sent[1].text).toContain("해지하신 이용권의 이용 기간이 끝났습니다");
  });

  it("해지 — 마지막 이용일, 연결 해제면 위약금 없는 지금 해지 안내", async () => {
    seedSub();
    const { sendCanceledMail } = await load();
    await sendCanceledMail("sub-1", { endsAt: kst("2026-12-02T10:00:00") });
    await sendCanceledMail("sub-1", { endsAt: kst("2026-12-02T10:00:00"), linkGone: true });
    expect(mail.sent[0].text).toContain("2026-12-01까지 그대로 이용할 수 있고");
    expect(mail.sent[0].text).not.toContain("위약금");
    expect(mail.sent[1].text).toContain("위약금 없이 지금 해지");
  });

  it("결제 재시도 중 해지(endedNow) — 지난 날짜를 '까지 이용'으로 적지 않고 지금 끝났다고", async () => {
    seedSub({ status: "canceled" });
    const { sendCanceledMail } = await load();
    await sendCanceledMail("sub-1", { endsAt: kst("2026-12-02T12:00:00"), endedNow: true });
    expect(mail.sent[0].text).toContain("이용권은 지금 끝났고");
    expect(mail.sent[0].text).not.toMatch(/\d{4}-\d{2}-\d{2}까지 그대로 이용/);
  });

  it("환불 — 금액·원래 결제수단 취소", async () => {
    seedSub();
    const { sendRefundMail } = await load();
    await sendRefundMail("sub-1", { refundKrw: 10_746, reason: "지금 해지(중도해지)" });
    expect(mail.sent[0].subject).toBe("[마음이음] 이용권 환불 — 10,746원");
    expect(mail.sent[0].text).toContain("환불 방법: 카카오페이 결제 취소");
  });

  it("모든 메일에 금지 표현이 없고, 안전 기능 무료 안내가 있다", async () => {
    seedSub();
    const m = await load();
    await m.sendPaymentCompleteMail("sub-1", paid);
    await m.sendRenewalNoticeMail("sub-1", kst("2026-12-02T10:00:00"));
    await m.sendPaymentFailedMail("sub-1", { retryAt: kst("2026-12-03T10:00:00") });
    await m.sendExpiredMail("sub-1", "payment_failed");
    await m.sendCanceledMail("sub-1", { endsAt: null, linkGone: true });
    await m.sendRefundMail("sub-1", { refundKrw: 1, reason: "청약철회" });
    expect(mail.sent).toHaveLength(6);
    for (const s of mail.sent) {
      expect(`${s.subject}\n${s.text}`, s.subject).not.toMatch(/치매|진단|검출|충전|크레딧|횟수권|회수권/);
      expect(s.text, s.subject).toContain("위급 상황 감지와 보호자 알림은 결제와 관계없이 계속 무료로 제공됩니다.");
    }
  });
});

describe("실패해도 결제 처리를 막지 않는다", () => {
  it("메일 설정이 없으면 보내지 않고 false — 경고는 한 번", async () => {
    seedSub();
    mail.configured = false;
    const { sendPaymentCompleteMail, sendRefundMail } = await load();
    expect(await sendPaymentCompleteMail("sub-1", paid)).toBe(false);
    expect(await sendRefundMail("sub-1", { refundKrw: 1, reason: "x" })).toBe(false);
    expect(sendServiceEmailMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes("메일 설정 없음"))).toHaveLength(1);
  });

  it("발송 실패(일시)·DB 오류·구독/주소 없음 → false, throw 없음", async () => {
    seedSub();
    const { sendPaymentCompleteMail } = await load();
    sendServiceEmailMock.mockResolvedValueOnce("transient" as never);
    expect(await sendPaymentCompleteMail("sub-1", paid)).toBe(false);
    db.subscription.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await sendPaymentCompleteMail("sub-1", paid)).toBe(false);
    expect(await sendPaymentCompleteMail("nope", paid)).toBe(false);
    db.user.rows[0].email = null;
    expect(await sendPaymentCompleteMail("sub-1", paid)).toBe(false);
  });

  it("Play 구독에는 보내지 않는다(포트원 행만)", async () => {
    seedSub({ provider: "play" });
    const { sendPaymentCompleteMail } = await load();
    expect(await sendPaymentCompleteMail("sub-1", paid)).toBe(false);
  });
});

describe("표시 형식", () => {
  it("금액은 천 단위 쉼표, 시각은 KST(서버 UTC와 무관)", async () => {
    const { formatKrw, formatKst } = await load();
    expect(formatKrw(19_900)).toBe("19,900원");
    expect(formatKrw(1_234_567)).toBe("1,234,567원");
    expect(formatKrw(0)).toBe("0원");
    expect(formatKst(new Date("2026-11-01T15:30:00Z"), true)).toBe("2026-11-02 00:30"); // UTC 11/1 → KST 11/2
    expect(formatKst(new Date("2026-11-01T15:30:00Z"))).toBe("2026-11-02");
  });
});
