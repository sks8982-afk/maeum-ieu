/**
 * 웹 결제 DB 반영 확인 — **읽기 전용**(information_schema·pg_indexes만 조회한다. 아무것도 만들거나 바꾸지 않는다).
 *
 * scripts/ops-billing-pg.ts를 운영 DB에 실행한 뒤, 결제 코드가 읽는 칸·표·인덱스가 모두 있는지 본다.
 *   기준은 따로 적지 않고 원본에서 읽는다 — prisma/schema.prisma의 네 모델(Subscription·BillingPayment·
 *   BillingConsent·BillingWebhookEvent)의 스칼라 칸, ops-billing-pg.ts가 만드는 인덱스 이름. 그래야 칸이 늘어도
 *   이 확인이 낡지 않는다. 하나라도 없으면 그 이름을 찍고 종료 코드 1.
 *
 * 사용: npx tsx scripts/check-billing-ddl.ts   (.env의 DATABASE_URL이 가리키는 DB)
 */
import "dotenv/config";
import { readFileSync } from "node:fs";

export const BILLING_MODELS = ["Subscription", "BillingPayment", "BillingConsent", "BillingWebhookEvent"] as const;
const SCALARS = new Set(["String", "Int", "Boolean", "DateTime", "Json", "Float", "Decimal", "BigInt", "Bytes"]);

/** schema.prisma에서 모델의 표 칸(스칼라 필드, @map 반영) — 관계·목록 필드는 표의 칸이 아니다 */
export function expectedColumns(schema: string, model: string): string[] {
  const block = new RegExp(String.raw`(?:^|\n)model\s+${model}\s*\{([\s\S]*?)\n\}`).exec(schema)?.[1] ?? "";
  const cols: string[] = [];
  for (const line of block.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("//") || t.startsWith("@@")) continue;
    const m = /^(\w+)\s+(\w+)(\[\])?\??(.*)$/.exec(t);
    if (!m || !SCALARS.has(m[2]) || m[3]) continue;
    cols.push(/@map\("([^"]+)"\)/.exec(m[4])?.[1] ?? m[1]);
  }
  return cols;
}

/** ops-billing-pg.ts가 만드는 인덱스 이름 */
export function expectedIndexes(opsScript: string): string[] {
  return [...opsScript.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"/g)].map((m) => m[1]);
}

async function main(): Promise<void> {
  const { prisma } = await import("../lib/prisma");
  try {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const problems: string[] = [];
    for (const model of BILLING_MODELS) {
      const want = expectedColumns(schema, model);
      const rows = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, model);
      if (rows.length === 0) { console.log(`✗ ${model}: 표 없음`); problems.push(`표 ${model}`); continue; }
      const have = new Set(rows.map((r) => r.column_name));
      const missing = want.filter((c) => !have.has(c));
      console.log(`${missing.length ? "✗" : "✓"} ${model}: 칸 ${want.length - missing.length}/${want.length}${missing.length ? ` — 없음: ${missing.join(", ")}` : ""}`);
      problems.push(...missing.map((c) => `${model}.${c}`));
    }
    const indexes = expectedIndexes(readFileSync("scripts/ops-billing-pg.ts", "utf8"));
    const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname = ANY($1::text[])`, indexes);
    const have = new Set(rows.map((r) => r.indexname));
    const missingIdx = indexes.filter((n) => !have.has(n));
    console.log(`${missingIdx.length ? "✗" : "✓"} 인덱스 ${indexes.length - missingIdx.length}/${indexes.length}${missingIdx.length ? ` — 없음: ${missingIdx.join(", ")}` : ""}`);
    problems.push(...missingIdx.map((n) => `인덱스 ${n}`));
    console.log(problems.length
      ? `\n✗ 빠진 것 ${problems.length}개 — npx tsx scripts/ops-billing-pg.ts 를 다시 실행하세요`
      : "\n✓ 결제 DB 반영 완료 — 결제 코드가 읽는 칸·표·인덱스가 모두 있습니다");
    process.exitCode = problems.length ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

// 시험(vitest)에서 import할 때는 DB에 붙지 않는다 — 직접 실행할 때만 조회
if (!process.env.VITEST) {
  main().catch((e) => { console.error("확인 실패:", e instanceof Error ? e.message : e); process.exitCode = 1; });
}
