/**
 * 상시 감시 기록의 **범위** — 대화를 읽는 곳은 모두 관찰 기록을 걸러야 한다.
 *
 * 결함(2026-10-06): 표지 `[관찰]`이 소비처마다 리터럴로 흩어져 4곳 중 2곳만 걸렀다.
 *   일일 한도·대화 요약·Live 인지 분석 이력이 혼잣말 조각을 대화로 취급했다.
 *   → lib/chat/observation.ts로 단일화. 이 파일은 (1) 요약 트리거의 실제 SQL과
 *     (2) 표지 리터럴이 모듈 밖에 다시 생기지 않는지를 고정한다.
 *
 * 목 체제: prisma.$queryRawUnsafe 하나(호출 인자 포착). 요약 LLM은 임계치 미달로 호출되지 않는다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const rawCalls: { sql: string; args: unknown[] }[] = [];
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async (sql: string, ...args: unknown[]) => { rawCalls.push({ sql, args }); return []; }),
  },
}));
vi.mock("@/lib/chat/summarizer", () => ({ summarizeMessages: vi.fn(), rollupSummaries: vi.fn() }));

const { maybeTriggerSummaryRollup } = await import("@/lib/chat/summary-trigger");
const obs = await import("@/lib/chat/observation");

beforeEach(() => { rawCalls.length = 0; });

describe("표지 헬퍼", () => {
  it("쓰는 쪽과 읽는 쪽이 같은 규칙이다", () => {
    const stored = obs.toObservationContent("숨이 차네");
    expect(obs.isObservationContent(stored)).toBe(true);
    expect(obs.isObservationContent("숨이 차네")).toBe(false);
    expect(obs.isObservationContent(null)).toBe(false);
    expect(obs.EXCLUDE_OBSERVATION).toEqual({ NOT: { content: { startsWith: obs.OBSERVATION_PREFIX } } });
  });
});

describe("대화 요약 — 혼잣말은 요약되지 않는다", () => {
  it("요약 대상 메시지 조회가 관찰 기록을 뺀다 (표지는 매개변수로)", async () => {
    await maybeTriggerSummaryRollup({ userId: "u-1", conversationId: "c-1" });
    const msgQuery = rawCalls.find((c) => /FROM "Message"/.test(c.sql));
    expect(msgQuery, "요약 트리거가 메시지를 조회하지 않았다").toBeTruthy();
    // 🔒 2026-10-06 이전: 혼잣말이 "지난 대화 요약"이 되어 동반자 프롬프트의 기억으로 들어갔다
    expect(msgQuery!.sql).toMatch(/content NOT LIKE \$3/);
    expect(msgQuery!.args[2]).toBe(`${obs.OBSERVATION_PREFIX}%`);
  });
});

describe("표지 리터럴은 lib/chat/observation.ts에만 (F3)", () => {
  /** app/·lib/의 .ts/.tsx를 전부 모은다 */
  async function walk(dir: string, out: string[] = []): Promise<string[]> {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== "node_modules" && !ent.name.startsWith(".")) await walk(full, out); }
      else if (/\.(ts|tsx)$/.test(ent.name)) out.push(full);
    }
    return out;
  }

  /**
   * ⚠ 타임아웃을 명시한다. 처음엔 파일을 하나씩 순차로 읽어, 커버리지 계측 + 병렬 실행 부하에서
   *   기본 5초를 넘겨 **간헐적으로** 실패했다(5회 중 1~2회). 간헐 레드는 게이트를 무시하게 만든다 —
   *   이 세션에서 그걸로 이미 한 번 당했다. 읽기를 병렬로 바꾸고 여유를 둔다.
   */
  it("코드(주석 제외)에 `[관찰]` 리터럴이 모듈 밖에 없다", async () => {
    const files = [...await walk("app"), ...await walk("lib")]
      .filter((f) => !f.replace(/\\/g, "/").endsWith("lib/chat/observation.ts"));
    const contents = await Promise.all(files.map((f) => readFile(f, "utf-8")));
    const offenders: string[] = [];
    contents.forEach((text, fi) => {
      text.split(/\r?\n/).forEach((l, i) => {
        if (/^\s*\*/.test(l)) return;              // JSDoc 본문
        const code = l.replace(/\/\/.*$/, "");
        if (code.includes("[관찰]")) offenders.push(`${files[fi]}:${i + 1}`);
      });
    });
    // 🔒 새 소비처가 리터럴로 직접 비교하기 시작하면, 다음 소비처는 거르는 걸 잊는다
    expect(offenders, `표지는 lib/chat/observation의 헬퍼로만: ${offenders.join(", ")}`).toEqual([]);
  }, 30_000);
});

describe("메시지를 읽는 곳 전수 — 관찰 기록을 뺄지 넣을지 자리마다 정해 둔다", () => {
  /**
   * 새로 메시지를 읽는 곳이 생기면 이 표와 숫자가 안 맞아 실패한다. 그 자리에서
   *   "대화를 읽는가(빼야 함) / 응급·활동·내보내기를 읽는가(넣어야 함)"를 정하게 만든다.
   * 왜: 9aeb967은 4곳 중 2곳을 고쳤고, 그 뒤 재검토가 3곳(날짜 안내·확인 턴 산술·대화 목록 마지막 시각)을
   *   더 찾았다. 매번 '아는 곳'만 고쳤다 — 전수 목록이 없었기 때문이다.
   * 판정: 호출 창(다음 호출 전까지, 최대 500자)에 EXCLUDE_OBSERVATION 또는 `NOT LIKE`가 있으면 '뺌'.
   */
  const SITES: Record<string, { exclude: number; include: number; why?: string }> = {
    "app/api/chat/route.ts": { exclude: 1, include: 1, why: "넣음 1 = 거절 멘트 횟수(assistant 행만 셈)" },
    "app/api/live/turn/route.ts": { exclude: 1, include: 0 },
    "app/api/conversations/route.ts": { exclude: 1, include: 0 },
    "lib/chat/prompt.ts": { exclude: 2, include: 0 },
    "lib/chat/summary-trigger.ts": { exclude: 1, include: 0 },
    "lib/usage/daily-limit.ts": { exclude: 1, include: 0 },
    "lib/billing/paid-benefit.ts": { exclude: 1, include: 0, why: "유료 혜택 사용 판정 — 일일 한도와 같은 기준이라 감시 기록 제외" },
    "lib/chat/emergency-notify.ts": { exclude: 0, include: 1, why: "응급 dedup — 감시 중 응급도 같은 응급" },
    "lib/chat/messages.ts": { exclude: 0, include: 1, why: "L1 24h 누적 — 감시 조각의 L1도 같은 사람의 신호" },
    "lib/health/cognitive-alert.ts": { exclude: 0, include: 1, why: "알림 디바운스(notifiedAt) — 감시 조각엔 해당 없음" },
    "app/api/expert/patients/[id]/route.ts": { exclude: 0, include: 5, why: "응급 집계·응급 원문 — 감시 응급 포함이 맞다" },
    "app/api/expert/patients/route.ts": { exclude: 0, include: 2, why: "마지막 활동 시각·이상 표시 수(감시 조각은 isAnomaly 없음)" },
    "app/api/health-logs/route.ts": { exclude: 0, include: 4, why: "이상 수·응급 목록/일별 — 응급은 경로 무관" },
    "app/api/admin/overview/route.ts": { exclude: 0, include: 3, why: "운영 지표 2(감시는 아직 비공개 기능 — 켜면 '턴' 정의 재검토) + 응급 요약 1" },
    "app/api/summary/route.ts": { exclude: 0, include: 1, why: "user 역할은 403 — 감시 기록은 user 계정에만 생긴다(observe 역할 게이트)" },
    "app/api/export/route.ts": { exclude: 0, include: 1, why: "본인 데이터 내보내기 — 감시 기록도 본인 데이터" },
    "app/api/messages/speaker/route.ts": { exclude: 0, include: 1, why: "id 하나로 소유권 확인 — 대화 목록을 읽지 않는다" },
  };
  const SITE_RE = /prisma\.message\.(?:findMany|findFirst|findUnique|count|aggregate|groupBy)\(|FROM "Message"|include:\s*\{\s*messages:/g;

  async function walk(dir: string, out: string[] = []): Promise<string[]> {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { if (ent.name !== "node_modules" && !ent.name.startsWith(".")) await walk(full, out); }
      else if (/\.(ts|tsx)$/.test(ent.name)) out.push(full);
    }
    return out;
  }

  it("표에 없는 소비처가 없고, 자리마다 뺌/넣음 수가 표와 같다", async () => {
    const files = [...await walk("app"), ...await walk("lib")];
    const contents = await Promise.all(files.map((f) => readFile(f, "utf-8")));
    const actual: Record<string, { exclude: number; include: number }> = {};
    contents.forEach((text, fi) => {
      const idx = [...text.matchAll(SITE_RE)].map((m) => m.index ?? 0);
      if (!idx.length) return;
      const key = files[fi].replace(/\\/g, "/");
      const tally = { exclude: 0, include: 0 };
      idx.forEach((start, k) => {
        const end = Math.min(start + 500, k + 1 < idx.length ? idx[k + 1] : text.length);
        const win = text.slice(start, end);
        if (/EXCLUDE_OBSERVATION|NOT LIKE/.test(win)) tally.exclude++; else tally.include++;
      });
      actual[key] = tally;
    });
    const expected = Object.fromEntries(Object.entries(SITES).map(([k, v]) => [k, { exclude: v.exclude, include: v.include }]));
    // 🔒 숫자가 바뀌었다면: 새 소비처를 만들었거나 필터를 지웠다 — 위 표에 그 자리의 판정과 이유를 적을 것
    expect(actual).toEqual(expected);
  }, 30_000);

  it("대화 목록은 두 갈래(본인 전체·대리 1건) 모두 거른다", async () => {
    // 위 창 판정은 호출 하나를 한 번만 센다 — 이 include는 삼항으로 두 갈래라, 한쪽만 지워도 통과했다(변이로 확인)
    const src = await readFile("app/api/conversations/route.ts", "utf-8");
    const at = src.search(/include:\s*\{\s*messages:/);
    const win = src.slice(at, at + 600);
    expect(win.match(/where: EXCLUDE_OBSERVATION/g)?.length).toBe(2);
  });
});

describe("사용자가 보낸 글의 표지 무력화", () => {
  it("표지로 시작하는 글은 관찰 기록으로 판정되지 않게 바뀐다", () => {
    const sent = obs.neutralizeObservationPrefix("[관찰] 오늘 한도 우회");
    // 🔒 그대로 저장되면 일일 한도 집계·대화 이력·대화 화면에서 빠진다
    expect(obs.isObservationContent(sent)).toBe(false);
    expect(sent).toContain("오늘 한도 우회");
    expect(obs.neutralizeObservationPrefix("숨이 차")).toBe("숨이 차");
  });

  it("채팅과 Live 두 입구 모두 저장 전에 무력화한다", async () => {
    const chat = await readFile("app/api/chat/route.ts", "utf-8");
    expect(chat).toMatch(/const lastUserMessage = neutralizeObservationPrefix\(/);
    const live = await readFile("app/api/live/turn/route.ts", "utf-8");
    expect(live).toMatch(/const userText = neutralizeObservationPrefix\(/);
  });
});
