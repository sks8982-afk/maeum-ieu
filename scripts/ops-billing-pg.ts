/**
 * 웹 PG 정기결제(포트원) 테이블·컬럼 추가 — 운영 적용용(2026-10-22).
 *
 * 무엇을 하나:
 *   1. "Subscription"에 포트원 컬럼 추가(ADD COLUMN IF NOT EXISTS) — 모두 nullable 또는 기본값이라 기존 Play 행은 그대로다
 *      (provider 기본값 'play').
 *   2. 결제 원장 "BillingPayment"·동의 기록 "BillingConsent"·웹훅 처리 기록 "BillingWebhookEvent" 생성(CREATE TABLE IF NOT EXISTS).
 *      ⚠ 세 표 모두 **FK 없이** id 문자열만 둔다 — User·Subscription 삭제에 연쇄 삭제되면 안 된다
 *      (대금결제·계약·청약철회 기록 5년 보존, 전자상거래법 시행령 제6조). Subscription의 기존 FK(CASCADE)는 건드리지 않는다.
 *   3. 인덱스(멱등) + **어르신 1명당 살아 있는 포트원 이용권 1개**를 DB가 보장하는 부분 유일 인덱스
 *      (동시에 두 결제가 확정되는 경쟁을 막는 마지막 방어선 — lib/billing/portone-activate 참조).
 *
 * 안전성:
 *   - 멱등(IF NOT EXISTS) — 여러 번 실행해도 안전.
 *   - 추가만 하고 아무것도 지우거나 바꾸지 않는다. `prisma db push`는 절대 쓰지 말 것
 *     (raw SQL 테이블 embeddings/cognitive_assessments를 drop한 사고 이력).
 *
 * 사용: npx tsx scripts/ops-billing-pg.ts 후 npx prisma generate
 *   (스키마의 model Subscription·BillingPayment·BillingConsent·BillingWebhookEvent와 동기화)
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";

/** Subscription에 더하는 컬럼 — prisma/schema.prisma model Subscription과 같아야 한다 */
const SUBSCRIPTION_COLUMNS: [string, string][] = [
  ["provider", `TEXT NOT NULL DEFAULT 'play'`],
  ["payMethod", "TEXT"],
  ["priceKrw", "INTEGER"],
  ["dailyTurnLimit", "INTEGER"],
  ["billingKeyEnc", "TEXT"],
  ["anchorDay", "INTEGER"],
  ["cycleNo", "INTEGER NOT NULL DEFAULT 0"],
  ["nextChargeAt", "TIMESTAMP(3)"],
  ["nextScheduleId", "TEXT"],
  ["cancelAtPeriodEnd", "BOOLEAN NOT NULL DEFAULT false"],
  ["failedChargeCount", "INTEGER NOT NULL DEFAULT 0"],
  ["canceledAt", "TIMESTAMP(3)"],
  ["cancelType", "TEXT"],
  ["renewalNoticeFor", "TIMESTAMP(3)"],
  ["freeTurnLimit", "INTEGER"],
];

/**
 * 새 표에 나중에 더한 컬럼(2026-10-22 검토 반영) — 표를 이미 만든 DB에도 붙도록 ADD COLUMN IF NOT EXISTS로 한 번 더 건다.
 *   아래 CREATE TABLE에도 같은 컬럼이 있다(새로 만드는 DB는 거기서 생긴다).
 */
const LATER_COLUMNS: [string, string, string][] = [
  ["BillingPayment", "paidMailAt", "TIMESTAMP(3)"],
  ["BillingPayment", "cancelType", "TEXT"],
  ["BillingPayment", "cancelRequestedAt", "TIMESTAMP(3)"],
  ["BillingConsent", "offer", "JSONB"],
];

const TABLES: [string, string][] = [
  ["BillingPayment", `
    CREATE TABLE IF NOT EXISTS "BillingPayment" (
      "paymentId"       TEXT PRIMARY KEY,
      "subscriptionId"  TEXT NOT NULL,
      "purchaserUserId" TEXT NOT NULL,
      "cycleNo"         INTEGER NOT NULL,
      "kind"            TEXT NOT NULL,
      "attempt"         INTEGER NOT NULL DEFAULT 0,
      "amountKrw"       INTEGER NOT NULL,
      "payMethod"       TEXT,
      "billingKeyHash"  TEXT NOT NULL,
      "status"          TEXT NOT NULL,
      "periodStart"     TIMESTAMP(3),
      "periodEnd"       TIMESTAMP(3),
      "scheduledAt"     TIMESTAMP(3),
      "paidAt"          TIMESTAMP(3),
      "cancelledKrw"    INTEGER NOT NULL DEFAULT 0,
      "refundTargetKrw" INTEGER,
      "failureReason"   TEXT,
      "receiptUrl"      TEXT,
      "paidMailAt"      TIMESTAMP(3),
      "cancelType"      TEXT,
      "cancelRequestedAt" TIMESTAMP(3),
      "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`],
  ["BillingConsent", `
    CREATE TABLE IF NOT EXISTS "BillingConsent" (
      "id"             TEXT PRIMARY KEY,
      "userId"         TEXT NOT NULL,
      "subscriptionId" TEXT,
      "termsVersion"   TEXT NOT NULL,
      "items"          JSONB NOT NULL,
      "offer"          JSONB,
      "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`],
  ["BillingWebhookEvent", `
    CREATE TABLE IF NOT EXISTS "BillingWebhookEvent" (
      "webhookId"  TEXT PRIMARY KEY,
      "type"       TEXT NOT NULL,
      "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`],
];

const INDEXES: [string, string][] = [
  ["Subscription_provider_status_nextChargeAt_idx",
    `CREATE INDEX IF NOT EXISTS "Subscription_provider_status_nextChargeAt_idx" ON "Subscription" ("provider", "status", "nextChargeAt")`],
  /**
   * 살아 있는 포트원 이용권은 어르신당 하나 — 발급 준비(prepare)의 확인을 동시에 통과한 두 결제가 둘 다 확정되는 것을 DB가 막는다.
   *   상태 목록은 lib/billing/portone-activate의 LIVE_PORTONE_STATUSES와 같아야 한다(activating 포함 — 첫 결제 중인 것도 하나로 센다).
   *   Prisma 스키마로는 부분 인덱스를 적을 수 없어 이 스크립트에만 있다.
   */
  ["Subscription_portone_live_beneficiary_key",
    `CREATE UNIQUE INDEX IF NOT EXISTS "Subscription_portone_live_beneficiary_key" ON "Subscription" ("beneficiaryUserId") ` +
    `WHERE "provider" = 'portone' AND "status" IN ('activating', 'active', 'grace', 'canceled')`],
  ["BillingPayment_subscriptionId_cycleNo_idx",
    `CREATE INDEX IF NOT EXISTS "BillingPayment_subscriptionId_cycleNo_idx" ON "BillingPayment" ("subscriptionId", "cycleNo")`],
  ["BillingPayment_purchaserUserId_createdAt_idx",
    `CREATE INDEX IF NOT EXISTS "BillingPayment_purchaserUserId_createdAt_idx" ON "BillingPayment" ("purchaserUserId", "createdAt")`],
  ["BillingConsent_userId_createdAt_idx",
    `CREATE INDEX IF NOT EXISTS "BillingConsent_userId_createdAt_idx" ON "BillingConsent" ("userId", "createdAt")`],
  ["BillingConsent_subscriptionId_idx",
    `CREATE INDEX IF NOT EXISTS "BillingConsent_subscriptionId_idx" ON "BillingConsent" ("subscriptionId")`],
];

async function columnsOf(table: string): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, table);
  return rows.map((r) => r.column_name);
}

async function main() {
  const sub = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='Subscription'`);
  if (sub.length === 0) {
    // 순서가 있다 — 구독 표가 먼저다(scripts/ops-create-subscription.ts)
    throw new Error(`"Subscription" 표가 없습니다 — 먼저 npx tsx scripts/ops-create-subscription.ts`);
  }

  for (const [name, type] of SUBSCRIPTION_COLUMNS) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "Subscription" ADD COLUMN IF NOT EXISTS "${name}" ${type}`);
    console.log(`  컬럼 확인: Subscription.${name}`);
  }
  for (const [name, sql] of TABLES) {
    await prisma.$executeRawUnsafe(sql);
    console.log(`  표 확인: ${name}`);
  }
  for (const [table, name, type] of LATER_COLUMNS) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${name}" ${type}`);
    console.log(`  컬럼 확인: ${table}.${name}`);
  }
  for (const [name, sql] of INDEXES) {
    await prisma.$executeRawUnsafe(sql);
    console.log(`  인덱스 확인: ${name}`);
  }

  for (const table of ["Subscription", "BillingPayment", "BillingConsent", "BillingWebhookEvent"]) {
    const cols = await columnsOf(table);
    console.log(`${table} 컬럼(${cols.length}): ${cols.join(", ")}`);
  }
  console.log("\n다음 단계: npx prisma generate");
}

main()
  .catch((e) => { console.error("실패:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
