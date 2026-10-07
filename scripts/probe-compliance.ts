/**
 * 확인 턴(인지 probe) 지시 준수율 측정 — 동반자 모델 선택 근거.
 *
 * 배경: 서버는 5턴마다 '인지 확인 턴'을 지정하고 후보 질문을 주입하지만,
 *   모델이 그 지시를 무시하고 수다 질문으로 대체하면 인지 선별이 0건이 된다(조용한 실패).
 *   동일한 시스템 프롬프트·동일 맥락을 모델만 바꿔 N회 돌려 준수율을 비교한다.
 *
 * 사용: npx tsx scripts/probe-compliance.ts [trials] [model,model,...]
 */
import "dotenv/config";
import { prisma } from "../lib/prisma";
import { buildSystemPrompt } from "../lib/chat/prompt";
import { getTextModel } from "../lib/chat/llm";
import { getTimeContext } from "../lib/chat/time";
import { getGenAI } from "../lib/chat/llm";
import { geminiTuning } from "../lib/ai/gemini-config";

export type Verdict = "MATCH" | "OTHER" | "NONE";

/**
 * 준수 판정 — 프롬프트에 **실제로 주입된 후보 질문**과 대조하고 3단으로 구분한다.
 *
 * 왜 3단인가: 정규식은 질문 풀이 우회 표현이라 미탐이 남고(예: "물놀이 갈까요, 눈사람 만들까요?" = 계절),
 * 영역 라벨만 주는 심판은 오판한다(라벨 "즉시 기억력(방금 한 말)" 때문에 '단어 세 개 외워보세요'를
 * 미포함 처리했음). 또 '다른 영역의 인지 질문'은 완전 미실시와 구분해야 실태가 보인다.
 *   MATCH = 지정된 영역의 과제를 수행 / OTHER = 인지 질문은 했으나 다른 영역 / NONE = 인지 질문 없음
 */
async function judgeProbe(reply: string, domainKo: string, candidates: string[]): Promise<Verdict> {
  const prompt = `노인 돌봄 AI가 어르신에게 한 응답을 분류하세요.

이번 턴에 지정된 확인 영역: ${domainKo}
그 영역의 후보 질문(표현은 바꿔도 됨):
${candidates.map((c, i) => `${i + 1}. ${c}`).join("\n")}

분류
- MATCH: 위 영역을 확인하는 질문·과제를 실제로 했다. 우회 표현도 MATCH(예: "손주들이 오면 물놀이를 갈까요, 눈사람을 만들까요?" → 계절 확인). 단어를 외워달라거나 문장을 따라 말해달라고 **요청**했다면 단어가 후보와 달라도 MATCH.
- OTHER: 인지 기능을 확인하는 질문은 했지만 **지정 영역이 아닌 다른 영역**이다(예: 지정=즉시 기억인데 날짜를 물음).
- NONE: 인지 확인 질문·과제가 전혀 없다. 공감·안부·조언만, 또는 음식·취미·가족 같은 일상 잡담 질문만.

응답:
"""${reply}"""

MATCH, OTHER, NONE 중 한 단어만 출력하세요.`;
  const judgeModel = "gemini-2.5-flash";
  const res = await getGenAI().models.generateContent({
    model: judgeModel,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    // 앱 호출부와 같은 헬퍼 — 심판 모델을 3.9+·4+로 바꿔도 400 없이 thinkingLevel로 간다(lib/ai/gemini-config)
    config: { ...geminiTuning(judgeModel, { temperature: 0, thinkingBudget: 64, thinkingLevel: "low" }), maxOutputTokens: 800 },
  });
  const t = ((res as unknown as { text?: string }).text ?? "").trim().toUpperCase();
  return t.includes("MATCH") ? "MATCH" : t.includes("OTHER") ? "OTHER" : "NONE";
}

/** 프롬프트에 주입된 '확인할 영역' 후보 질문 3개를 뽑아낸다 */
function extractCandidates(systemPrompt: string): string[] {
  const block = /\[이번에 슬쩍 확인할 영역[^\]]*\]\n([\s\S]*?)(?=\n\n|\n\[|$)/.exec(systemPrompt);
  if (!block) return [];
  return block[1].split("\n").map((l) => l.replace(/^·\s*/, "").trim()).filter(Boolean);
}

import { PRICES, costOf, priceLabel } from "./model-prices";

const EMAIL = "modeltest@maeum.test";
const TRIALS = parseInt(process.argv[2] || "5", 10);
/** 기본은 전 후보 — 출시 후 교체 비용이 커서 한 번에 전수 비교한다 */
const ALL = Object.keys(PRICES);
const MODELS = (process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3].split(",") : ALL);

/** 같은 맥락을 모든 시행에 고정 — 모델 차이만 남긴다 */
const HISTORY = [
  { role: "user", parts: [{ text: "민지야 안녕. 아침에 일어나니 허리가 좀 쑤시네" }] },
  { role: "model", parts: [{ text: "할아버지, 아침부터 허리가 쑤시다니 많이 불편하셨겠어요. 따뜻하게 찜질이라도 해보셨어요?" }] },
  { role: "user", parts: [{ text: "어제 밭에서 고추 따다가 무리했나봐. 올해는 고추가 참 잘 됐어" }] },
  { role: "model", parts: [{ text: "고추 따시다가 허리가 아프셨군요. 올해 농사가 잘 됐다니 뿌듯하시겠어요!" }] },
];
const UTTER = "오후엔 마당에 나가서 고추 좀 더 널어놔야지";

/** 확인 턴 인덱스를 만들기 위한 채움 메시지 — userTurnIndex = 사용자 발화 수 + 1 */
async function seedCount(convId: string, userMsgCount: number) {
  await prisma.message.deleteMany({ where: { conversationId: convId } });
  const base = Date.now() - (userMsgCount * 2 + 8) * 60_000;
  const rows: { conversationId: string; role: string; content: string; createdAt: Date }[] = [];
  for (let i = 0; i < userMsgCount; i++) {
    const h = HISTORY[(i * 2) % HISTORY.length], a = HISTORY[(i * 2 + 1) % HISTORY.length];
    rows.push({ conversationId: convId, role: "user", content: h.parts[0].text, createdAt: new Date(base + i * 2 * 60_000) });
    rows.push({ conversationId: convId, role: "assistant", content: a.parts[0].text, createdAt: new Date(base + (i * 2 + 1) * 60_000) });
  }
  if (rows.length) await prisma.message.createMany({ data: rows });
}

const DOMAINS = [
  "orientation_time", "orientation_place", "memory_immediate",
  "memory_delayed", "language", "judgment", "attention_calculation",
];

/**
 * 확인 영역을 강제한다 — 서버는 '오늘 아직 안 본 영역(remaining)'에서 고르므로,
 * 나머지 6개를 오늘 평가 완료로 심어두면 목표 영역 하나만 남아 반드시 그 영역이 출제된다.
 * (이렇게 안 하면 어려운 영역(즉시기억·지연기억)에 시행이 0회가 되어 모델 비교가 성립하지 않음)
 */
async function forceDomain(userId: string, convId: string, target: string) {
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }); // YYYY-MM-DD
  await prisma.$executeRawUnsafe(`DELETE FROM cognitive_assessments WHERE user_id = $1`, userId);
  const others = DOMAINS.filter((d) => d !== target);
  for (const d of others) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO cognitive_assessments (id, user_id, message_id, conversation_id, domain, score, confidence, evidence, note, session_date, created_at)
       VALUES ($1, $2, NULL, $3, $4, 0, 1, 'sweep-seed', 'sweep-seed', $5::date, NOW())`,
      `sweep_${d}_${Date.now()}`, userId, convId, d, today,
    );
  }
}

/**
 * 영역 스윕 — 7개 인지 영역 전부에서, 매 시행마다 질문 후보를 재추첨해 준수율을 본다.
 * 단일 추첨 비교로는 질문 표현 운에 따라 결과가 흔들린다(2.5-flash가 같은 영역에서 4/6과 10/10 모두 나옴).
 */
interface Cell { match: number; other: number; none: number; n: number; lat: number[]; tin: number; tout: number; empty: number }
const newCell = (): Cell => ({ match: 0, other: 0, none: 0, n: 0, lat: [], tin: 0, tout: 0, empty: 0 });

async function sweep(userId: string, convId: string, models: string[], trials: number) {
  const perModel = new Map<string, Map<string, Cell>>();
  const samples: string[] = [];

  for (let ordinal = 0; ordinal < DOMAINS.length; ordinal++) {
    await seedCount(convId, 2);                          // → userTurnIndex = 3 = 확인 턴
    await forceDomain(userId, convId, DOMAINS[ordinal]);  // 이번 라운드에 볼 영역 하나만 남김
    for (const m of models) {
      process.env.COMPANION_MODEL = m;
      process.env.COMPANION_PROBE_MODEL = m;
      for (let t = 0; t < trials; t++) {
        const p = await buildPromptFor(userId, convId);   // 매 시행 재빌드 → 질문 재추첨
        if (!/인지 확인을 슬쩍/.test(p.systemPrompt)) { samples.push(`⚠ ordinal ${ordinal}: 확인 턴 아님`); continue; }
        const domain = /확인할 영역: ([^\n—]+)/.exec(p.systemPrompt)?.[1]?.trim() ?? `ordinal${ordinal}`;
        const cands = extractCandidates(p.systemPrompt);
        const slot = perModel.get(m) ?? new Map<string, Cell>();
        perModel.set(m, slot);
        const cell = slot.get(domain) ?? newCell();
        slot.set(domain, cell);
        try {
          const t0 = Date.now();
          const res = await getTextModel(p.systemPrompt, false, undefined, true)
            .generateContent({ contents: [...HISTORY, { role: "user", parts: [{ text: UTTER }] }] });
          cell.lat.push(Date.now() - t0);
          const reply = ((res as unknown as { text?: string }).text ?? "").trim();
          const u = (res as unknown as { usageMetadata?: Record<string, number> }).usageMetadata ?? {};
          cell.tin += u.promptTokenCount ?? 0;
          cell.tout += (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
          cell.n++;
          if (!reply) { cell.empty++; samples.push(`⚠ ${m} / ${domain}: 빈 응답`); continue; }
          const v = await judgeProbe(reply, domain, cands);
          if (v === "MATCH") cell.match++;
          else if (v === "OTHER") { cell.other++; samples.push(`~ ${m} / ${domain} [다른영역]: ${reply.replace(/\n+/g, " ").slice(0, 95)}`); }
          else { cell.none++; samples.push(`X ${m} / ${domain} [미실시]: ${reply.replace(/\n+/g, " ").slice(0, 95)}`); }
        } catch (e) {
          samples.push(`⚠ ${m} / ${domain}: ${e instanceof Error ? e.message.slice(0, 90) : e}`);
        }
      }
    }
  }

  const domains = [...new Set([...perModel.values()].flatMap((s) => [...s.keys()]))];
  console.log(`\n## 영역별 확인 턴 지시 준수 (영역당 ${trials}회, 매회 질문 재추첨)`);
  console.log(`셀 값 = 지정영역 수행 / 시행 (괄호는 다른영역 인지질문)\n`);
  console.log(`| 모델 | ${domains.map((d) => d.replace(/\s*\(.*/, "")).join(" | ")} | 지정영역 | +다른영역 | 미실시 | 지연(중앙) | 턴당 | 2027 |`);
  console.log(`|---|${domains.map(() => "---").join("|")}|---|---|---|---|---|---|`);
  for (const m of models) {
    const slot = perModel.get(m);
    if (!slot) { console.log(`| ${m} | ${domains.map(() => "-").join(" | ")} | 호출 실패 | - | - | - | - | - |`); continue; }
    let M = 0, O = 0, NO = 0, N = 0, TI = 0, TO = 0; const L: number[] = [];
    const cells = domains.map((d) => {
      const c = slot.get(d);
      if (!c || !c.n) return "-";
      M += c.match; O += c.other; NO += c.none; N += c.n; TI += c.tin; TO += c.tout; L.push(...c.lat);
      return c.other ? `${c.match}/${c.n} (+${c.other})` : `${c.match}/${c.n}`;
    });
    const s = L.sort((a, b) => a - b);
    const med = s.length ? s[Math.floor(s.length / 2)] : 0;
    const per = N ? costOf(m, TI / N, TO / N) : 0;
    const per27 = N ? costOf(m, TI / N, TO / N, true) : 0;
    const pct = N ? Math.round((M / N) * 100) : 0;
    const pctAny = N ? Math.round(((M + O) / N) * 100) : 0;
    console.log(`| ${m} | ${cells.join(" | ")} | **${M}/${N} (${pct}%)** | ${pctAny}% | ${NO} | ${med}ms | $${per.toFixed(5)} | $${per27.toFixed(5)} |`);
  }
  await prisma.$executeRawUnsafe(`DELETE FROM cognitive_assessments WHERE user_id = $1`, userId).catch(() => {});
  if (samples.length) {
    console.log(`\n### 미준수 표본 (${samples.length}건 중 최대 45건)`);
    samples.slice(0, 45).forEach((s) => console.log(`   ${s}`));
  }
}

async function buildPromptFor(userId: string, conversationId: string) {
  return buildSystemPrompt({
    userId, conversationId, timeCtx: getTimeContext(),
    weather: { description: "맑음", location: "동탄", promptText: "현재 위치 동탄, 맑음 22도" } as never,
    mode: "user",
  });
}

async function main() {
  const user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (!user) throw new Error(`${EMAIL} 없음 — chat-turn.ts --reset 먼저 실행`);
  const conv = await prisma.conversation.findUnique({ where: { userId: user.id }, select: { id: true } });
  if (!conv) throw new Error("대화 없음");

  if (process.argv.includes("--sweep")) {
    await sweep(user.id, conv.id, MODELS, TRIALS);
    return;
  }

  // 확인 턴 조건: 사용자 발화 2건 → 다음 인덱스 3 (5n+3 = probe)
  // --chitchat: 사용자 발화 3건 → 다음 인덱스 4 = 수다 턴. 인지 질문이 새면(오염) 실패다.
  const chitchat = process.argv.includes("--chitchat");
  const seed = chitchat ? [...HISTORY, { role: "user", parts: [{ text: "고추장도 담고 김치 담글 때 쓰지" }] }] : HISTORY;
  const before = await prisma.message.count({ where: { conversationId: conv.id } });
  await prisma.message.deleteMany({ where: { conversationId: conv.id } });
  await prisma.message.createMany({
    data: seed.map((h, i) => ({
      conversationId: conv.id,
      role: h.role === "user" ? "user" : "assistant",
      content: h.parts[0].text,
      createdAt: new Date(Date.now() - (seed.length - i) * 60_000),
    })),
  });

  const p = await buildSystemPrompt({
    userId: user.id, conversationId: conv.id, timeCtx: getTimeContext(),
    weather: { description: "맑음", location: "동탄", promptText: "현재 위치 동탄, 맑음 22도" } as never,
    mode: "user",
  });
  const isProbe = /인지 확인을 슬쩍/.test(p.systemPrompt);
  const domainKo = /확인할 영역: ([^\n—]+)/.exec(p.systemPrompt)?.[1]?.trim() ?? "인지 기능";
  console.log(`맥락 ${seed.length}건 · ${chitchat ? "수다 턴(인지 질문 새면 오염)" : "확인 턴"} · 판정영역=${domainKo}`);
  if (chitchat === isProbe) { console.log(`턴 종류 불일치(isProbe=${isProbe}) — 중단`); return; }

  const contents = [...seed, { role: "user", parts: [{ text: UTTER }] }];
  const rows: string[] = [];

  for (const m of MODELS) {
    process.env.COMPANION_MODEL = m;
    process.env.COMPANION_PROBE_MODEL = m;
    let hit = 0, tin = 0, tout = 0, empty = 0;
    const lat: number[] = [];
    const samples: string[] = [];
    for (let i = 0; i < TRIALS; i++) {
      try {
        const t0 = Date.now();
        const res = await getTextModel(p.systemPrompt, false, undefined, !chitchat).generateContent({ contents });
        lat.push(Date.now() - t0);
        const reply = ((res as unknown as { text?: string }).text ?? "").trim();
        const u = (res as unknown as { usageMetadata?: Record<string, number> }).usageMetadata ?? {};
        tin += u.promptTokenCount ?? 0;
        tout += (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
        if (!reply) { empty++; samples.push("⚠ 빈 응답"); continue; }
        // 수다 턴에서는 '어떤 영역이든' 인지 질문이 나오면 누출 — MATCH/OTHER 모두 누출로 집계
        const v = await judgeProbe(reply, domainKo, extractCandidates(p.systemPrompt));
        const asked = chitchat ? v !== "NONE" : v === "MATCH";
        if (asked) hit++;
        samples.push(`${asked ? "O" : "X"} ${reply.replace(/\n+/g, " ").slice(0, 95)}`);
      } catch (e) {
        samples.push(`⚠ ${e instanceof Error ? e.message.slice(0, 80) : e}`);
      }
    }
    const perTurn = costOf(m, tin / TRIALS, tout / TRIALS);
    const perTurn27 = costOf(m, tin / TRIALS, tout / TRIALS, true);
    const sorted = [...lat].sort((a, b) => a - b);
    const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const label = chitchat ? "인지 질문 누출(0이어야 정상)" : "지시 준수";
    console.log(`\n### ${m} — ${label} ${hit}/${TRIALS} · 지연 중앙 ${med}ms(최대 ${sorted.at(-1) ?? 0}ms) · 1회 $${perTurn.toFixed(5)}${perTurn27 !== perTurn ? ` (2027 $${perTurn27.toFixed(5)})` : ""}${empty ? ` · 빈응답 ${empty}건` : ""}`);
    samples.forEach((s) => console.log(`   ${s}`));
    rows.push(`| ${m} | ${hit}/${TRIALS} | ${med}ms | $${perTurn.toFixed(5)} | $${perTurn27.toFixed(5)} | ${empty} | ${Math.round(tout / TRIALS)} |`);
  }

  console.log(`\n| 모델 | ${chitchat ? "인지질문 누출" : "지시 준수"} | 지연(중앙) | 1회 비용 | 2027 단가 | 빈응답 | 평균 출력 |\n|---|---|---|---|---|---|---|\n${rows.join("\n")}`);
  console.log(`\n단가: ${MODELS.map((m) => `${m} ${priceLabel(m)}`).join(" · ")}`);
}

main().catch((e) => { console.error("FAIL:", e instanceof Error ? e.stack : e); process.exit(1); })
  .finally(() => prisma.$disconnect());
