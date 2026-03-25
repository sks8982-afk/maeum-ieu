import { prisma } from "../lib/prisma";

async function main() {
  const msgs = await prisma.message.findMany({
    where: { conversationId: "cmmn2n4pl000004lgq2743cdm" },
    orderBy: { createdAt: "desc" },
    take: 15,
    select: { role: true, content: true, isAnomaly: true, analysisNote: true, createdAt: true },
  });

  console.log("=== 최근 메시지 (isAnomaly 확인) ===");
  msgs.reverse().forEach((m) => {
    const c = m.content.length > 80 ? m.content.slice(0, 80) + "..." : m.content;
    console.log(
      m.role.padEnd(10),
      m.isAnomaly ? "ANOMALY" : "ok     ",
      m.analysisNote ? `[${m.analysisNote.slice(0, 40)}]` : "",
      c,
    );
  });

  try {
    const ca = await prisma.$queryRawUnsafe<{ domain: string; score: number; evidence: string; created_at: Date }[]>(
      "SELECT domain, score, evidence, created_at FROM cognitive_assessments ORDER BY created_at DESC LIMIT 10",
    );
    console.log("\n=== cognitive_assessments (최근 10건) ===");
    ca.forEach((r) => console.log(r.domain.padEnd(20), `score:${r.score}`, r.evidence?.slice(0, 50)));
  } catch {
    console.log("\n=== cognitive_assessments 테이블 조회 실패 ===");
  }

  await prisma.$disconnect();
}

main();
