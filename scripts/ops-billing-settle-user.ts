/**
 * 계정 삭제 **전에** 웹 이용권(포트원) 정리 — 운영자가 계정 삭제 요청(/account-deletion 안내 — 이메일 요청 → 수동 삭제)을 처리할 때
 *   계정을 지우기 전에 반드시 실행한다(설계 '조사 반영 결정' 9).
 *
 * 왜: Subscription은 User 삭제에 Cascade라, 먼저 정리하지 않고 지우면 포트원에 예약 결제가 남아 카드가 계속 결제된다.
 * 하는 일(lib/billing/portone-cancel — 이미 한 일은 건너뛴다, 멱등):
 *   ① 이 사람이 **결제회원**인 이용권 — 지금 해지 기준 환불 + 예약 취소 + 빌링키 삭제(cancelForPurchaserDeletion — 약관 '회원 탈퇴')
 *   ② 이 사람이 **혜택 받는 분(어르신)**인 이용권 — 위약금 없는 지금 해지(cancelForBeneficiaryGone beneficiary_deleted) + 결제회원 메일
 *   결제·환불·동의 기록(BillingPayment·BillingConsent)은 지우지 않는다(5년 보존 — 전자상거래법 시행령 제6조, FK 없음).
 * 실패하면 종료 코드 1 — **그때는 계정을 지우지 말고** 원인을 고친 뒤 다시 실행한다.
 *
 * 사용: npx tsx scripts/ops-billing-settle-user.ts <userId 또는 이메일>         # 대상 이용권만 보여 준다(바꾸지 않음)
 *       npx tsx scripts/ops-billing-settle-user.ts <userId 또는 이메일> --yes   # 실제로 해지·환불한다
 *   ⚠ --yes는 운영 DB와 실제 결제(포트원 결제 취소·빌링키 삭제)에 닿는다. 운영 env(DATABASE_URL·PORTONE_*·ENCRYPTION_KEY)가 필요하다.
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";
import { cancelForBeneficiaryGone, cancelForPurchaserDeletion } from "../lib/billing/portone-cancel";

async function findUserId(arg: string): Promise<string | null> {
  const where = arg.includes("@") ? { email: arg.toLowerCase() } : { id: arg };
  const u = await prisma.user.findUnique({ where, select: { id: true } });
  return u?.id ?? null;
}

async function listTargets(userId: string): Promise<number> {
  const subs = await prisma.subscription.findMany({
    where: { provider: "portone", OR: [{ purchaserUserId: userId }, { beneficiaryUserId: userId }] },
    select: { id: true, status: true, purchaserUserId: true, beneficiaryUserId: true, expiresAt: true, billingKeyEnc: true },
  });
  for (const s of subs) {
    const role = s.purchaserUserId === userId ? (s.beneficiaryUserId === userId ? "본인 결제" : "결제회원") : "혜택 받는 분";
    console.log(`  ${s.id.slice(0, 8)}… ${role} · 상태 ${s.status} · 만료 ${s.expiresAt?.toISOString() ?? "-"} · 빌링키 ${s.billingKeyEnc ? "있음" : "없음"}`);
  }
  return subs.length;
}

async function main() {
  const [arg, flag] = process.argv.slice(2);
  if (!arg) throw new Error("사용: npx tsx scripts/ops-billing-settle-user.ts <userId 또는 이메일> [--yes]");
  const userId = await findUserId(arg.trim());
  if (!userId) throw new Error("사용자를 찾지 못했습니다");
  console.log(`포트원 이용권(${userId.slice(0, 8)}…):`);
  const count = await listTargets(userId);
  if (count === 0) { console.log("  없음 — 결제 정리 없이 계정을 삭제해도 됩니다."); return; }
  if (flag !== "--yes") { console.log("\n바꾸지 않았습니다. 해지·환불하려면 같은 명령 끝에 --yes를 붙이세요."); return; }

  const asPurchaser = await cancelForPurchaserDeletion(userId);
  console.log(`① 결제회원 이용권: ${asPurchaser.subscriptions}건 정리 · 환불 ${asPurchaser.refundedKrw}원`);
  const asBeneficiary = await cancelForBeneficiaryGone(userId, { reason: "beneficiary_deleted" });
  console.log(`② 혜택 받는 이용권: ${asBeneficiary.subscriptions}건 정리 · 환불 ${asBeneficiary.refundedKrw}원`);
  console.log("\n완료 — 이제 계정을 삭제해도 됩니다(결제·환불 기록은 남습니다).");
}

main()
  .catch((e) => {
    console.error("실패 — 계정을 삭제하지 마세요. 원인을 고친 뒤 다시 실행하면 남은 일만 이어서 합니다:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
