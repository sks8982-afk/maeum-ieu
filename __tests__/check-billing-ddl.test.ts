/**
 * 결제 DB 반영 확인 스크립트(scripts/check-billing-ddl.ts)의 기준 읽기 — DB 없이.
 *   확인 기준을 스키마·DDL 스크립트에서 직접 읽으므로, 그 읽기가 틀리면 빠진 칸이 있어도 "완료"라고 말한다.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { expectedColumns, expectedIndexes, BILLING_MODELS } from "../scripts/check-billing-ddl";

const schema = readFileSync("prisma/schema.prisma", "utf8");
const ops = readFileSync("scripts/ops-billing-pg.ts", "utf8");

describe("결제 DB 반영 확인 — 기준 읽기", () => {
  it("네 모델 모두 칸을 읽는다", () => {
    for (const m of BILLING_MODELS) expect(expectedColumns(schema, m).length, m).toBeGreaterThan(2);
  });

  it("검토 반영으로 나중에 더한 칸까지 기준에 든다(그 칸이 빠진 DB를 '완료'라고 하지 않게)", () => {
    expect(expectedColumns(schema, "Subscription")).toEqual(expect.arrayContaining(["provider", "billingKeyEnc", "freeTurnLimit", "renewalNoticeFor"]));
    expect(expectedColumns(schema, "BillingPayment")).toEqual(expect.arrayContaining(["paidMailAt", "cancelType", "cancelRequestedAt", "billingKeyHash"]));
    expect(expectedColumns(schema, "BillingConsent")).toEqual(expect.arrayContaining(["offer", "items", "termsVersion"]));
  });

  it("관계 필드는 표의 칸이 아니다", () => {
    const cols = expectedColumns(schema, "Subscription");
    expect(cols).not.toContain("purchaser");
    expect(cols).not.toContain("beneficiary");
  });

  it("@map이 있으면 DB 칸 이름으로 읽는다", () => {
    const s = 'model X {\n  id String @id\n  fooBar String @map("foo_bar")\n  @@index([id])\n}';
    expect(expectedColumns(s, "X")).toEqual(["id", "foo_bar"]);
  });

  it("DDL 스크립트가 만드는 인덱스 이름을 읽는다(어르신 1명당 살아 있는 이용권 1개 인덱스 포함)", () => {
    const names = expectedIndexes(ops);
    expect(names.length).toBeGreaterThan(2);
    expect(names).toContain("Subscription_portone_live_beneficiary_key");
  });
});
