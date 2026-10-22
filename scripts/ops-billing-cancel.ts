/**
 * 전화·이메일로 받은 웹 이용권(포트원) 해지·청약철회 처리 — 운영자 전용(약관 제7조④·제8조① "고객센터 전화나 이메일로도 신청").
 *
 * **신청 시각 기준**으로 판정한다(lib/billing/portone-ops-cancel) — 6일째 받은 철회 메일을 9일째 처리해도 청약철회다(제17조⑤).
 *   신청 시각은 메일 수신 시각·통화 시각을 그대로 적는다(한국 시간이면 +09:00을 붙인다). 본인 확인(결제회원 본인 — 가입 이메일·결제
 *   내역 대조)을 먼저 한다.
 *
 * 사용: npx tsx scripts/ops-billing-cancel.ts <구독 id> <now|period_end> <신청 시각>          # 미리보기 — 아무것도 바꾸지 않는다
 *       npx tsx scripts/ops-billing-cancel.ts <구독 id> <now|period_end> <신청 시각> --yes    # 실제로 해지·환불한다
 *   예: npx tsx scripts/ops-billing-cancel.ts cmabc123 now 2026-11-08T21:30:00+09:00
 *   now        지금 해지 — 신청 시각이 청약철회 기간 안이면 청약철회(유료 혜택 미사용 전액 / 사용 시 이용일수만 공제), 아니면 중도해지
 *   period_end 다음 결제부터 해지 — 이용기간 끝까지 쓰고 그 뒤 결제 없음, 환불 없음
 *   ⚠ --yes는 운영 DB와 실제 결제(포트원 결제 취소·예약 취소·빌링키 삭제)에 닿는다. 운영 env(DATABASE_URL·PORTONE_*·ENCRYPTION_KEY)가 필요하다.
 *   처리하지 않는 경우(미래·30일보다 오래된 신청 시각, 신청 뒤 결제된 회차가 있음)는 이유를 보여 주고 끝난다 — 개발에 넘긴다.
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";
import { type OpsCancelMode, planOpsCancel, runOpsCancel } from "../lib/billing/portone-ops-cancel";

const USAGE = "사용: npx tsx scripts/ops-billing-cancel.ts <구독 id> <now|period_end> <신청 시각(예: 2026-11-08T21:30:00+09:00)> [--yes]";

function parseMode(v: string | undefined): OpsCancelMode | null {
  return v === "now" || v === "period_end" ? v : null;
}

async function main() {
  const [subscriptionId, modeArg, requestedArg, flag] = process.argv.slice(2);
  const mode = parseMode(modeArg);
  if (!subscriptionId || !mode || !requestedArg) throw new Error(USAGE);
  const plan = await planOpsCancel(subscriptionId.trim(), mode, new Date(requestedArg));
  if (!plan.ok) { console.log(`처리하지 않았습니다: ${plan.reason}`); return; }
  const q = plan.quote;
  console.log(`구독 ${subscriptionId.slice(0, 8)}… · 신청 시각 ${plan.requestedAt.toISOString()} 기준`);
  console.log(mode === "now"
    ? `  지금 해지${q.withinWithdrawal ? "(청약철회)" : ""} — 규칙 ${q.immediate.rule} · 이용 ${q.immediate.usedDays}/${q.immediate.periodDays}일 · 유료 혜택 ${q.usedPaidBenefit ? "있음" : "없음"} · 예상 환불 ${q.immediate.refundKrw}원`
    : `  다음 결제부터 해지 — ${q.periodEnd.endsAt?.toISOString() ?? "-"}까지 이용, 환불 없음`);
  if (flag !== "--yes") { console.log("\n바꾸지 않았습니다. 처리하려면 같은 명령 끝에 --yes를 붙이세요."); return; }
  const r = await runOpsCancel(plan);
  console.log(r.ok ? `\n완료 — 환불 ${r.refundKrw}원(결제회원에게 메일이 갑니다)` : `\n처리하지 못했습니다: ${r.code}`);
}

main()
  .catch((e) => {
    console.error("실패 — 원인을 고친 뒤 같은 명령을 다시 실행하면 남은 일(환불·정리)만 이어서 합니다:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
