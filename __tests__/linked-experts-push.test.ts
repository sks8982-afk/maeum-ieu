/**
 * 어르신 마이페이지의 연결 목록 — 연결한 분이 휴대폰 앱으로 위급 알림을 받을 수 있는지(appAlert).
 *
 * 2026-10-07: 연결만 하고 앱에 로그인하지 않은 보호자도 알림을 받는 것처럼 보였다(토픽은 구독자 0명이어도 발송 성공).
 * 고정하는 것: 상태 셋("ready"·"off"·"none")만 내보내고 휴대폰 대수·토큰·마지막 확인 시각은 싣지 않는다(4차 — 그분의 휴대폰
 *   정보다, 개인정보처리방침 9항) / 집계가 실패해도 연결 목록은 보인다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let deviceRows: Record<string, unknown>[] = [];
let deviceError: Error | null = null;

vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => ({ user: { id: "u-elder", screeningMode: "user" } })) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    expertPatient: {
      findMany: vi.fn(async () => [
        { expertUserId: "g-ready", createdAt: new Date("2026-10-01T00:00:00Z"), expert: { name: "김보호" } },
        { expertUserId: "g-muted", createdAt: new Date("2026-10-02T00:00:00Z"), expert: { name: "이보호" } },
        { expertUserId: "g-none", createdAt: new Date("2026-10-03T00:00:00Z"), expert: { name: null } },
      ]),
    },
    $queryRawUnsafe: vi.fn(async () => {
      if (deviceError) throw deviceError;
      return deviceRows;
    }),
  },
}));

const { GET } = await import("@/app/api/users/linked-experts/route");
const SECRET = "secretTokenValue_" + "z".repeat(40);
const row = (token: string, user_id: string, permission: string, channel_blocked: boolean) => ({
  token, user_id, platform: "android", app_version: "1.2.0", permission, channel_blocked, updated_at: new Date("2026-10-07T00:00:00Z"),
});

async function experts() {
  const res = await GET();
  const text = await res.text();
  return { status: res.status, text, experts: (JSON.parse(text) as { experts: Record<string, unknown>[] }).experts };
}

beforeEach(() => {
  deviceRows = [];
  deviceError = null;
});

describe("연결 목록의 앱 알림 상태", () => {
  it("받는 중 / 꺼짐 / 미등록 — 상태만 싣는다(대수 없음)", async () => {
    deviceRows = [
      row(SECRET, "g-ready", "granted", false), row(SECRET + "2", "g-ready", "denied", false), row(SECRET + "3", "g-ready", "granted", false),
      row(SECRET + "4", "g-muted", "granted", true), row(SECRET + "5", "g-muted", "unknown", false),
    ];
    const r = await experts();
    expect(r.status).toBe(200);
    expect(r.experts.map((e) => [e.expertUserId, e.appAlert])).toEqual([
      ["g-ready", "ready"],
      ["g-muted", "off"],
      ["g-none", "none"],
    ]);
    // 🔒 휴대폰 대수·토큰·마지막 확인 시각은 그분의 휴대폰 정보다 — 어르신 화면에는 "받을 수 있나"만
    expect(r.text).not.toContain(SECRET);
    expect(r.text).not.toMatch(/"token"|lastSeenAt|updatedAt|"devices"|"ready":|"count"|"granted"/);
  });

  it("집계가 실패해도 연결 목록은 보인다(appAlert null)", async () => {
    deviceError = new Error("connection refused");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await experts();
    expect(r.status).toBe(200);
    expect(r.experts.map((e) => e.name)).toEqual(["김보호", "이보호", "전문가"]);
    expect(r.experts.every((e) => e.appAlert === null)).toBe(true);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("휴대폰 테이블이 아직 없으면 모두 미등록(0대)으로 보인다", async () => {
    deviceError = new Error(`relation "push_device" does not exist`);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await experts();
    expect(r.experts.map((e) => e.appAlert)).toEqual(["none", "none", "none"]);
    err.mockRestore();
  });
});
