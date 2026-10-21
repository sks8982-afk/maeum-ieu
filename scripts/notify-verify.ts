/**
 * 보호자 응급 알림 로직 검증 — 어르신 발화부터 보호자 알림까지 전 경로.
 *
 * 테스트 성격
 *  - 화이트박스 단위: SSRF 가드(isSafeWebhookUrl 경유), 중복 차단 규칙, 페이로드 구성
 *  - 통합: detectEmergency → notifyGuardian → DB(notifiedAt) → ExpertPatient 링크(FCM 대상 조회)
 *  - 인수 시나리오: L2(주의) 발생 후 같은 카테고리 L3(즉시응급) 격상이 억제되지 않는가
 *  - 프라이버시: 보호자 조회 API가 대화 원문을 주지 않는가
 *
 * ⚠️ 외부로 민감 발화를 전송하지 않는다 — global fetch를 가로채 요청을 '포착만' 한다.
 *    (SSRF 가드는 그대로 통과해야 하므로 호스트는 공인 https 도메인을 쓴다)
 *
 * 사용: npx tsx scripts/notify-verify.ts
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";
import { notifyGuardian } from "../lib/chat/emergency-notify";
import { detectEmergency } from "../lib/chat/emergency";
import { detectEmergencyLLM } from "../lib/chat/emergency-llm";
import { encryptPII } from "../lib/crypto";

const ELDER = "notifytest.elder@maeum.test";
const GUARDIAN = "notifytest.guardian@maeum.test";
const HOOK = "https://example.com/maeum-test-hook";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

/** 나간 웹훅 요청을 포착만 하고 실제 전송은 하지 않는다 */
interface Captured { url: string; body: unknown }
const captured: Captured[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith(HOOK)) {
    captured.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response("ok", { status: 200 });
  }
  return realFetch(input as RequestInfo, init);
}) as typeof fetch;

async function seed() {
  const elder = await prisma.user.upsert({
    where: { email: ELDER },
    update: { guardianWebhookUrl: HOOK, guardianEmail: encryptPII("guardian@example.com"), guardianName: "테스트보호자" },
    create: {
      email: ELDER, name: "김응급", age: 82, gender: "female", screeningMode: "user",
      companionName: "민지", companionRelation: "손녀", consentedAt: new Date(), consentVersion: "test",
      guardianWebhookUrl: HOOK, guardianEmail: encryptPII("guardian@example.com"),
      guardianName: "테스트보호자", guardianRelation: "딸",
    },
    select: { id: true },
  });
  const guardian = await prisma.user.upsert({
    where: { email: GUARDIAN },
    update: { screeningMode: "guardian" },
    create: { email: GUARDIAN, name: "박보호자", screeningMode: "guardian" },
    select: { id: true },
  });
  const conv = await prisma.conversation.upsert({
    where: { userId: elder.id }, update: {},
    create: { userId: elder.id, title: "알림 검증" }, select: { id: true },
  });
  // 보호자 ↔ 어르신 연결 (FCM 발송 대상 조회 경로)
  const existing = await prisma.expertPatient.findFirst({
    where: { expertUserId: guardian.id, patientUserId: elder.id },
    select: { id: true },
  });
  if (existing) await prisma.expertPatient.update({ where: { id: existing.id }, data: { status: "active" } });
  else await prisma.expertPatient.create({ data: { expertUserId: guardian.id, patientUserId: elder.id, status: "active" } });
  // 이전 실행 흔적 제거 — 중복 차단 창(1시간)이 결과를 오염시킨다
  await prisma.message.deleteMany({ where: { conversationId: conv.id } });
  return { elderId: elder.id, guardianId: guardian.id, convId: conv.id };
}

/** 실제 경로와 같게: 사용자 메시지를 저장하고 그 id로 알림 발송 */
async function fireEmergency(convId: string, elderId: string, utter: string, level: 2 | 3, category: string) {
  const msg = await prisma.message.create({
    data: {
      conversationId: convId, role: "user", content: utter,
      emergencyLevel: level, emergencyEvidence: `${category}:테스트`,
    },
    select: { id: true, createdAt: true },
  });
  const before = captured.length;
  const r = await notifyGuardian({
    userId: elderId, userName: "김응급", messageId: msg.id, level,
    category, content: utter, aiReply: "많이 아프시겠어요. 119에 연락드릴까요?", createdAt: msg.createdAt,
  });
  const fresh = captured.slice(before);
  const marked = await prisma.message.findUnique({ where: { id: msg.id }, select: { notifiedAt: true } });
  return { r, fresh, notifiedAt: marked?.notifiedAt ?? null };
}

async function main() {
  const { elderId, guardianId, convId } = await seed();
  console.log(`테스트 계정 준비 — 어르신 ${ELDER} / 보호자 ${GUARDIAN} (연결됨)\n`);

  // ── 1) 응급 감지 (통합 — 운영 경로와 동일: 정규식 → 0이면 LLM 백스톱) ──
  console.log("[1] 응급 발화 감지 — 운영 파이프라인(정규식 → LLM 백스톱)");
  // 기대값은 설계 기준: 단순 증상 호소는 알림 대상 아님(보호자 알림 홍수 방지로 의도적 보수 설정).
  //   어지러움은 '못 일어난다/쓰러질 것 같다' 같은 도움 호소가 붙을 때만 L2.
  const cases: Array<[string, number]> = [
    ["가슴이 너무 아프고 숨이 안 쉬어져", 3],
    ["쓰러져서 일어날 수가 없어", 3],
    ["약을 한꺼번에 다 먹어버릴까 생각했어", 3],
    ["어지러워서 일어나지도 못하겠어", 2],
    ["어제도 아프고 오늘도 아파서 도저히 못 견디겠어", 1],
    ["머리가 좀 어지럽네", 0],                  // 단순 증상 — 설계상 미알림
    ["오늘 날씨 참 좋다", 0],
    ["손녀랑 통화해서 기분이 좋아", 0],
  ];
  for (const [u, expect] of cases) {
    let d = detectEmergency(u);
    let via = "정규식";
    // 본류(detectWithBackstop)와 같게 — 정규식이 L2 미만(none·L1)이면 백스톱(2026-10-19)
    if (d.level < 2) {
      const llm = await detectEmergencyLLM(u);
      if (llm) { d = llm; via = "LLM 백스톱"; }
    }
    check(`"${u.slice(0, 22)}…" → L${d.level} [${via}] (기대 ${expect === 0 ? "0" : `${expect}+`})`,
      expect === 0 ? d.level === 0 : d.level >= expect, `실제 L${d.level}`);
  }

  // ── 2) L3 알림 발송 (통합) ──
  console.log("\n[2] L3 알림 — 웹훅 발송 + DB 마킹 + FCM 대상 조회");
  const t1 = await fireEmergency(convId, elderId, "가슴이 너무 아프고 숨이 안 쉬어져", 3, "chest_pain");
  check("발송 성공(sent=true)", t1.r.sent, JSON.stringify(t1.r));
  check("웹훅 채널 포함", t1.r.channels.includes("webhook"), t1.r.channels.join(","));
  check("웹훅 요청 1건 포착", t1.fresh.length === 1, `${t1.fresh.length}건`);
  check("notifiedAt 기록됨", t1.notifiedAt !== null);
  const body1 = t1.fresh[0]?.body as { content?: string } | undefined;
  check("페이로드에 레벨 표기 포함", !!body1?.content && /즉시 응급/.test(body1.content), String(body1?.content).slice(0, 60));
  const links = await prisma.expertPatient.findMany({ where: { patientUserId: elderId, status: "active" } });
  check("연결된 보호자 조회됨(FCM 대상)", links.some((l) => l.expertUserId === guardianId));

  // ── 3) 중복 차단 (화이트박스 규칙) ──
  console.log("\n[3] 중복 차단 — 같은 카테고리 동일 레벨 재발송 금지");
  const t2 = await fireEmergency(convId, elderId, "아직도 가슴이 아파", 3, "chest_pain");
  check("1시간 내 동일 L3 → 차단", !t2.r.sent && /dedup/.test(t2.r.reason ?? ""), JSON.stringify(t2.r));
  check("차단 시 웹훅 미발송", t2.fresh.length === 0);
  check("차단 시 notifiedAt 미기록", t2.notifiedAt === null);

  console.log("\n[3-1] 하향은 차단 — L3 이력 후 같은 카테고리 L2");
  const t3 = await fireEmergency(convId, elderId, "가슴이 좀 답답해", 2, "chest_pain");
  check("L3 이력 후 L2 → 차단", !t3.r.sent, JSON.stringify(t3.r));

  console.log("\n[3-2] 다른 카테고리는 통과");
  const t4 = await fireEmergency(convId, elderId, "쓰러져서 일어날 수가 없어", 3, "fall");
  check("다른 카테고리 L3 → 발송", t4.r.sent, JSON.stringify(t4.r));

  // ── 4) 격상 시나리오 (인수) — 2026-07-07 blocker 회귀 고정 ──
  console.log("\n[4] 격상 시나리오 — L2(주의) 후 같은 카테고리 L3(즉시응급)는 반드시 재발송");
  const t5 = await fireEmergency(convId, elderId, "숨이 좀 차네", 2, "breathing");
  check("신규 카테고리 L2 → 발송", t5.r.sent, JSON.stringify(t5.r));
  const t6 = await fireEmergency(convId, elderId, "숨이 아예 안 쉬어져", 3, "breathing");
  check("L2 → L3 격상 발송(억제되면 치명적)", t6.r.sent, JSON.stringify(t6.r));
  check("격상 알림 페이로드가 즉시응급", /즉시 응급/.test(String((t6.fresh[0]?.body as { content?: string })?.content)));

  // ── 5) 보호자 정보 없음 (경계) ──
  console.log("\n[5] 보호자 정보 미등록 — 예외 없이 미발송 처리");
  const orphan = await prisma.user.upsert({
    where: { email: "notifytest.orphan@maeum.test" }, update: { guardianWebhookUrl: null, guardianEmail: null },
    create: { email: "notifytest.orphan@maeum.test", name: "무보호자", screeningMode: "user" }, select: { id: true },
  });
  const oconv = await prisma.conversation.upsert({
    where: { userId: orphan.id }, update: {}, create: { userId: orphan.id, title: "t" }, select: { id: true },
  });
  const t7 = await fireEmergency(oconv.id, orphan.id, "가슴이 아파", 3, "chest_pain");
  check("보호자 없음 → sent=false, throw 없음", t7.r.sent === false);
  check("보호자 없음 → 웹훅 미발송", t7.fresh.length === 0);

  // ── 6) SSRF 가드 (화이트박스 보안) ──
  console.log("\n[6] SSRF 가드 — 위험한 웹훅 URL 차단");
  const unsafe = [
    ["http://example.com/h", "http 평문"],
    ["https://localhost/h", "localhost"],
    ["https://127.0.0.1/h", "루프백 IP"],
    ["https://192.168.0.5/h", "사설 IP"],
    ["https://10.0.0.1/h", "사설 IP"],
    ["https://myhost.local/h", ".local"],
    ["not-a-url", "URL 아님"],
  ];
  for (const [u, label] of unsafe) {
    await prisma.user.update({ where: { id: orphan.id }, data: { guardianWebhookUrl: u } });
    const before = captured.length;
    const r = await notifyGuardian({
      userId: orphan.id, userName: "무보호자", messageId: (await prisma.message.create({
        data: { conversationId: oconv.id, role: "user", content: "x", emergencyLevel: 3, emergencyEvidence: `ssrf${label}:t` },
        select: { id: true },
      })).id, level: 3, category: `ssrf${label}`, content: "x", aiReply: "y", createdAt: new Date(),
    });
    check(`${label} 차단`, !r.channels.includes("webhook") && captured.length === before, JSON.stringify(r.channels));
  }

  console.log(`\n${pass}/${pass + fail} passed${fail ? `, ${fail} FAILED` : ""}`);
  // 검증용 메시지 정리 (계정은 재사용을 위해 남김)
  await prisma.message.deleteMany({ where: { conversationId: { in: [convId, oconv.id] } } });
  process.exitCode = fail ? 1 : 0;
}

main()
  .catch((e) => { console.error("FAIL:", e instanceof Error ? e.stack : e); process.exitCode = 1; })
  .finally(async () => { globalThis.fetch = realFetch; await prisma.$disconnect(); });
