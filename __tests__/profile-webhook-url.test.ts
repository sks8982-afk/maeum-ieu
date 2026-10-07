/**
 * 보호자 메신저(webhook) 주소 저장 검사 — app/api/users/profile PATCH(2026-10-07 8차).
 *
 * 고정하는 것: 주소에 아이디·비밀번호(https://아이디:비밀번호@호스트)가 있으면 저장하지 않는다(400, 한국어 안내).
 *   왜: fetch는 그 값을 Authorization 헤더로 바꿔 보내고, 주소를 다루는 곳(로그·오류 메시지)마다 비밀이 따라다닌다. 위급 알림의 발송
 *   쪽도 같은 주소를 "막은 주소"(영구 실패 — 운영자 경보)로 다룬다(lib/chat/emergency-notify-webhook isSafeWebhookUrl) — 저장 때 막지 않으면
 *   보호자는 등록했다고 믿는데 메신저 사본이 응급마다 빠진다.
 *   기존 검사(https 전용·내부/사설 주소 차단)와 정상 주소 저장은 그대로인지 함께 본다.
 *
 * 목 체제: 세션·레이트리밋·prisma·crypto만 바꾼다(라우트 본문은 실제 코드).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const update = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "u1", name: "김영자", guardianPhone: null, ...args.data }));
vi.mock("next-auth", () => ({ getServerSession: vi.fn(async () => ({ user: { id: "u1" } })) }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ ok: true, retryAfterSec: 0 })) }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { update: (args: { data: Record<string, unknown> }) => update(args), findUnique: vi.fn() } } }));
vi.mock("@/lib/crypto", () => ({ encryptPII: (s: string | null) => s, decryptPII: (s: string | null) => s }));

async function patchWebhook(url: string): Promise<{ status: number; body: { error?: string } }> {
  const { PATCH } = await import("@/app/api/users/profile/route");
  const res = await PATCH(new Request("http://localhost/api/users/profile", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ guardianWebhookUrl: url }),
  }));
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

beforeEach(() => { update.mockClear(); });

describe("보호자 메신저 주소 저장 — 아이디·비밀번호가 든 주소는 거절한다(8차)", () => {
  it.each([
    ["아이디·비밀번호", "https://user:pass@hooks.example.com/services/x"],
    ["아이디만", "https://user@hooks.example.com/services/x"],
    ["비밀번호만", "https://:pass@hooks.example.com/services/x"],
  ])("%s가 든 주소 → 400(한국어 안내) · 저장하지 않는다", async (_, url) => {
    const { status, body } = await patchWebhook(url);
    expect(status).toBe(400);
    // 🔒 저장되면 위급 알림 때마다 그 주소가 "막은 주소"로 빠지고, 비밀이 주소와 함께 다닌다
    expect(body.error).toBe("Webhook URL에 아이디·비밀번호를 넣을 수 없습니다(https://아이디:비밀번호@… 형식 불가). 메신저가 준 웹훅 주소를 그대로 넣어 주세요.");
    expect(update).not.toHaveBeenCalled();
  });

  it("기존 검사는 그대로 — http·사설 주소는 같은 안내로 거절, 정상 https 주소는 저장한다", async () => {
    for (const bad of ["http://hooks.example.com/x", "https://192.168.0.10/x", "not a url"]) {
      const { status, body } = await patchWebhook(bad);
      expect(status, bad).toBe(400);
      expect(body.error).toBe("Webhook URL은 공개된 https 주소여야 합니다(http·내부·사설 주소 불가).");
    }
    expect(update).not.toHaveBeenCalled();
    const ok = await patchWebhook("https://discord.com/api/webhooks/123/token");
    expect(ok.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data.guardianWebhookUrl).toBe("https://discord.com/api/webhooks/123/token");
  });
});
