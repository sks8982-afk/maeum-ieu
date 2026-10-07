/**
 * 계정 삭제 안내(/account-deletion) — 삭제 항목이 코드 사실과 맞는지(2026-10-08 10차).
 *   Play 데이터 안전성의 '계정 삭제 URL' 고지다 — "삭제됩니다"라고 적은 것은 실제로 계정과 함께 지워져야 한다(FK ON DELETE CASCADE).
 *   FK를 SetNull·Restrict로 바꾸면 고지가 거짓이 된다 — 그때 이 테스트가 깨져 문안도 함께 고치게 한다.
 *   (11차) 구독 기록의 범위도 스키마 그대로 — 저장하는 것(확인·환불·강제 해지 시각 포함)과 저장하지 않는 것(결제 수단·금액)을 출시 가이드와 같은 말로.
 *   (12차) 휴대폰 등록 정보의 범위도 DDL 그대로(push_device) — 그리고 두 범위를 세 문서(개인정보처리방침 1·7항·삭제 안내·출시 가이드의
 *   데이터 안전성 설명)가 같은 문자열로 적는지 본다(lib/privacy-scopes).
 * 렌더링: react-dom/server로 그린다.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";

const AccountDeletionPage = (await import("@/app/account-deletion/page")).default;
const PrivacyPage = (await import("@/app/privacy/page")).default;
const html = renderToStaticMarkup(createElement(AccountDeletionPage)).replace(/<!-- -->/g, "");
const privacy = renderToStaticMarkup(createElement(PrivacyPage)).replace(/<!-- -->/g, "");
/** "삭제되는 데이터" 절 — 다음 절 제목(<h2) 앞까지 */
const start = html.indexOf("삭제되는 데이터");
const deleted = html.slice(start, html.indexOf("<h2", start));
/** 구독 기록에 실제로 저장하는 것 — 삭제 안내와 출시 가이드(데이터 안전성 "구매 기록")가 같은 문자열로 적는다(11차, 아래 스키마 맞대기) */
const SUBSCRIPTION_SCOPE = "상품·구독 상태·만료일·구매 토큰·마지막 확인 시각·환불·강제 해지 시각, 결제한 계정과 혜택을 받는 계정";
/** 휴대폰 등록(push_device)에 실제로 저장하는 것 — 세 문서가 같은 문자열로 적는다(12차, 아래 DDL 맞대기) */
const PUSH_DEVICE_SCOPE = "알림 토큰·앱 버전·알림 허용·위급 알림 채널 상태·마지막 확인 시각";

describe("계정 삭제 안내 — 삭제 항목과 코드 사실", () => {
  it("휴대폰 등록(알림 토큰·앱 버전·알림 허용·위급 알림 채널 상태·마지막 확인 시각)을 삭제 항목에 적고, 실제로 계정과 함께 지워진다(push_device FK CASCADE)", () => {
    expect(start).toBeGreaterThan(-1);
    // 🔒 보호자·의사 휴대폰의 알림 토큰은 그 휴대폰으로 실명 알림을 보낼 수 있는 값이다 — 삭제 항목에서 빠지면 고지가 틀린다
    expect(deleted).toContain(`<li>위급 알림을 받는 휴대폰 등록 정보(${PUSH_DEVICE_SCOPE} — 보호자·의사 계정)</li>`);
    const ddl = readFileSync("scripts/ops-push-device.ts", "utf-8");
    expect(ddl).toMatch(/user_id\s+TEXT NOT NULL REFERENCES "User"\("id"\) ON DELETE CASCADE/);
  });

  /**
   * 휴대폰 등록 범위 = DDL 그대로(2026-10-08 12차) — 고지에 적은 것과 push_device가 실제로 저장하는 것이 같아야 한다. 컬럼이 늘거나
   *   줄면 이 테스트가 깨져 lib/privacy-scopes(방침·삭제 안내)와 출시 가이드를 함께 고치게 한다.
   */
  it("휴대폰 등록 범위가 push_device DDL(scripts/ops-push-device.ts)과 같다(12차)", () => {
    const ddl = readFileSync("scripts/ops-push-device.ts", "utf-8");
    const at = ddl.indexOf("CREATE TABLE IF NOT EXISTS push_device (");
    expect(at).toBeGreaterThan(-1);
    const block = ddl.slice(at, ddl.indexOf(")`", at));
    const columns = block.split("\n").slice(1).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("--")).map((l) => l.split(/\s+/)[0]);
    // 알림 토큰=token · 앱 버전=app_version · 알림 허용=permission · 위급 알림 채널 상태=channel_blocked · 마지막 확인 시각=updated_at
    //   · 나머지(user_id — 저장한 계정 · platform — 늘 'android' · created_at)는 행 관리용
    expect([...columns].sort()).toEqual([
      "app_version", "channel_blocked", "created_at", "permission", "platform", "token", "updated_at", "user_id",
    ]);
    expect(PUSH_DEVICE_SCOPE.split("·")).toHaveLength(5);
  });

  it("구독 기록 — 결제한 계정·혜택 받는 계정 어느 쪽을 지워도 삭제(두 FK 모두 CASCADE), 결제·환불 처리 기록은 Play — 정기 결제 해지 안내", () => {
    expect(deleted).toContain(`구독 기록(Google Play 구독 확인 결과 — ${SUBSCRIPTION_SCOPE})`);
    expect(deleted).toContain("결제한 계정과 혜택을 받는 계정 중 어느 쪽을 삭제해도 그 구독 기록은 함께 삭제됩니다");
    const schema = readFileSync("prisma/schema.prisma", "utf-8");
    expect(schema).toMatch(/purchaser\s+User\s+@relation\("SubscriptionsPaid", fields: \[purchaserUserId\], references: \[id\], onDelete: Cascade\)/);
    expect(schema).toMatch(/beneficiary\s+User\s+@relation\("SubscriptionsReceived", fields: \[beneficiaryUserId\], references: \[id\], onDelete: Cascade\)/);
    // 운영 테이블은 이 스크립트로 만든다(prisma db push 금지) — 스키마와 같은 규칙이어야 고지가 운영에서도 사실이다
    const ddl = readFileSync("scripts/ops-create-subscription.ts", "utf-8");
    expect(ddl.match(/REFERENCES "User"\("id"\) ON DELETE CASCADE/g)).toHaveLength(2);
    // 🔒 계정을 지워도 Play 정기 결제는 이어진다 — 이 안내가 빠지면 지운 뒤에도 결제가 계속되는 걸 이용자가 모른다
    expect(deleted).toContain("계정을 삭제해도 Google Play 정기 결제는 해지되지 않으니");
    expect(deleted).toContain(
      "서비스는 결제 수단·결제 금액을 저장하지 않습니다 — 결제·환불 처리 기록은 Google Play에 남고, 서비스에는 위 구독 기록(환불·강제 해지 시각 포함)만 남습니다",
    );
    // 🔒 (11차) "결제·환불 내역을 저장하지 않습니다"는 환불·강제 해지 시각(revokedAt)을 저장하는 사실과 어긋난다
    expect(html).not.toContain("결제·환불 내역을 저장하지 않습니다");
  });

  /**
   * 구독 기록 범위 = 스키마 그대로(2026-10-08 11차) — 고지에 적은 것과 model Subscription이 실제로 저장하는 것이 같아야 한다. 필드가 늘거나
   *   줄면(결제 금액·결제 수단을 저장하기 시작하는 등) 이 테스트가 깨져 삭제 안내·출시 가이드(데이터 안전성 "구매 기록")를 함께 고치게 한다.
   */
  it("구독 기록 범위가 스키마(model Subscription)와 같고, 출시 가이드의 데이터 안전성 '구매 기록' 설명도 같은 범위다(11차)", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf-8");
    const at = schema.indexOf("model Subscription {");
    expect(at).toBeGreaterThan(-1);
    const block = schema.slice(at, schema.indexOf("}", at));
    const fields = block.split("\n").slice(1).map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("//") && !l.startsWith("@@")).map((l) => l.split(/\s+/)[0]);
    // 상품=productId · 구독 상태=status · 만료일=expiresAt · 구매 토큰=purchaseToken · 마지막 확인 시각=verifiedAt · 환불·강제 해지 시각=revokedAt
    //   · 결제한 계정=purchaser(UserId) · 혜택을 받는 계정=beneficiary(UserId) — 나머지(id·createdAt·updatedAt)는 행 관리용
    expect([...fields].sort()).toEqual([
      "beneficiary", "beneficiaryUserId", "createdAt", "expiresAt", "id", "productId", "purchaseToken", "purchaser", "purchaserUserId",
      "revokedAt", "status", "updatedAt", "verifiedAt",
    ]);
    // 🔒 결제 수단·결제 금액은 저장하지 않는다고 고지한다 — 그런 필드가 생기면 고지가 거짓이 된다
    expect(block).not.toMatch(/amount|price|payment|card|currency/i);
    const guide = readFileSync("docs/playstore/README_출시가이드.md", "utf-8");
    expect(guide).toContain(`"구매 기록"은 Play 구독 결제를 Google에 확인한 결과(${SUBSCRIPTION_SCOPE})입니다`);
    expect(guide).toContain("결제 수단·결제 금액은 저장하지 않습니다");
    expect(guide).not.toContain("(상품·상태·만료일·구매 토큰)");   // 예전 범위(확인·환불 시각이 빠졌다)
  });

  /**
   * 세 문서가 같은 문자열(2026-10-08 12차) — 개인정보처리방침 1·7항(+ 10월 8일 변경 내역)·계정 삭제 안내·출시 가이드(3절 데이터 안전성 설명)가
   *   휴대폰 등록 정보·구독 기록을 같은 말로 적는다. 예전엔 휴대폰 등록 정보를 "앱 버전·알림 허용 상태"(방침)·"알림 토큰·앱 버전·알림 허용
   *   상태"(삭제 안내)·"앱 버전·알림 허용 상태·위급 알림 채널 상태"(가이드)로 저마다 적었고, 방침에는 구독 기록이 아예 없었다.
   */
  it("휴대폰 등록 정보·구독 기록 — 방침 1·7항·변경 내역, 삭제 안내, 출시 가이드가 같은 문자열이고 방침 7항에 구독 기록의 보관·삭제 기준(12차)", () => {
    const section = (text: string, from: string, to: string) => {
      const a = text.indexOf(from);
      expect(a, from).toBeGreaterThan(-1);
      return text.slice(a, text.indexOf(to, a));
    };
    const guide = readFileSync("docs/playstore/README_출시가이드.md", "utf-8");
    const docs = [
      ["방침 1항", section(privacy, "1. 수집하는 개인정보 항목", "2. 개인정보의 이용 목적")],
      ["방침 7항", section(privacy, "7. 보관 및 파기", "8. 보호 조치")],
      ["방침 변경 내역", section(privacy, "15. 변경 내역", "이전 방침")],
      ["삭제 안내", deleted],
      ["출시 가이드 3절", section(guide, "## 3. 데이터 안전성", "## 4.")],
    ] as const;
    for (const [doc, text] of docs) {
      // 🔒 같은 데이터를 문서마다 달리 적으면 어느 쪽이 사실인지 이용자·심사자가 알 수 없다
      expect(text, `${doc} — 휴대폰 등록 정보`).toContain(`등록 정보(${PUSH_DEVICE_SCOPE}`);
      expect(text, `${doc} — 구독 기록`).toContain(`${SUBSCRIPTION_SCOPE})`);
    }
    // 방침 7항 — 구독 기록의 보관·삭제 기준(두 FK CASCADE — 위 "구독 기록" 테스트)
    expect(docs[1][1]).toContain(
      `<li>구독 기록(${SUBSCRIPTION_SCOPE}): 구독이 끝나거나 해지돼도 보관하며, 결제한 계정과 혜택을 받는 계정 중 어느 쪽이든 회원 탈퇴하면 그 구독 기록을 함께 삭제합니다.</li>`,
    );
    // 방침 1항 — 저장하지 않는 것(결제 수단·금액)도 삭제 안내와 같은 말로
    expect(docs[0][1]).toContain("결제 수단·결제 금액은 저장하지 않으며, 결제·환불 처리 기록은 Google Play에 남습니다");
    // 🔒 예전 문구 — 셋이 저마다 달랐다
    expect(privacy).not.toContain("앱 버전·알림 허용 상태와 함께");
    expect(deleted).not.toContain("알림 토큰·앱 버전·알림 허용 상태 —");
    expect(guide).not.toContain("FCM 등록 토큰을 앱 버전·알림 허용 상태·위급 알림 채널 상태와 함께");
  });
});
