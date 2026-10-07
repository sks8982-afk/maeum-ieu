/**
 * 위급 알림의 메신저(webhook) 전송 + SSRF 가드 — 2026-10-07 7차에 lib/chat/emergency-notify.ts에서 그대로 옮겼다(동작 같음).
 *   보낼 본문(buildWebhookBody)과 주소가 있는지는 emergency-notify(sendGuardianWebhook)가 정하고, 여기선 주소 검사·전송·결과 분류
 *   (ContactResult — lib/chat/emergency-notify-shared)만 한다. 회귀 고정: __tests__/webhook-ssrf.test.ts · __tests__/emergency-notify*.test.ts.
 */
import dns from "node:dns/promises";
import { withinMs } from "@/lib/within-ms";
import type { ContactResult } from "@/lib/chat/emergency-notify-shared";

/**
 * 웹훅 주소 DNS 조회를 기다리는 상한(2026-10-07 8차) — dns.lookup(getaddrinfo)에는 상한이 없다. 리졸버가 멈추면 메신저 사본이
 *   그 자리에서 기다렸고(응급 알림은 셋을 다 기다린다), 넘기면 "주소를 확인하지 못함"(일시 실패 — 같은 응급이 다시 감지되면 60초 뒤부터
 *   다시)과 같다.
 */
const WEBHOOK_DNS_TIMEOUT_MS = 3000;

/** IPv4가 사설·예약·메타데이터 대역인지 */
function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true; // 비정상 → 차단
  const [a, b] = p;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;            // link-local + 클라우드 메타데이터(169.254.169.254)
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16/12
  if (a === 192 && b === 168) return true;            // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT
  return false;
}

/**
 * 웹훅 주소 검사 결과(2026-10-07 5·6차):
 *   · "safe" — 보내도 된다
 *   · "unsafe" — 다시 해도 막힌다(https 아님·내부 호스트명·사설/예약 주소·URL 형식 오류·주소에 아이디/비밀번호(8차)) → 보내지 않는다,
 *     **영구 실패**("blocked" — 6차: 예전엔 "보낼 곳 없음"으로 세 경보도 없이, 보호자가 등록한 메신저 사본이 영영 빠졌는데 아무도 몰랐다)
 *   · "nonexistent" — 그런 도메인이 없다(DNS ENOTFOUND — NXDOMAIN·주소 레코드 없음) → 보내지 않는다, **영구 실패**(6차)
 *   · "unresolved" — 지금 주소를 확인하지 못했다(EAI_AGAIN — 시간 초과·SERVFAIL 포함, 빈 응답, 그 밖의 조회 오류, 3초 상한 넘김(8차 —
 *     WEBHOOK_DNS_TIMEOUT_MS)) → 보내지 않는다(fail-closed), **일시 실패**("failed") — 5차 이전엔 구별하지 않아, DNS가 잠깐 흔들린
 *     응급의 메신저 사본이 "막힌 주소"로 조용히 빠지고 1시간 dedup까지 걸렸다.
 */
type WebhookUrlCheck = "safe" | "unsafe" | "nonexistent" | "unresolved";

/**
 * SSRF 방어 — 보호자 웹훅 URL이 내부/사설/메타데이터로 향하지 않는지 검증.
 * 호스트네임을 실제 IP로 해석해 사설 대역이면 차단. 해석 실패·빈 응답도 보내지 않는다(fail-closed — "unresolved"·"nonexistent").
 *
 * ⚠ **DNS rebinding은 막지 못한다**(2026-10-02 정정 — 이전 주석이 "DNS rebinding 방어"라고
 *   적고 있었으나 사실이 아니었다). 여기서 lookup한 뒤 아래 fetch가 **독립적으로 다시** 해석하므로,
 *   TTL 0 레코드로 두 해석 사이에 IP를 바꾸면 우회된다. 실제로 막으려면 해석된 IP로 직접 접속하고
 *   Host 헤더를 붙여야 한다.
 *   현재 위험도 평가: 공격자는 보호자 계정이어야 하고, 응답 본문이 호출부로 돌아가지 않는
 *   blind SSRF다. 그래서 즉시 치명은 아니나, AWS 메타데이터가 사정권이라 방치할 것도 아니다.
 *   (회귀 고정: __tests__/webhook-ssrf.test.ts — 이 함수는 2026-10-02까지 테스트가 0건이었다)
 */
async function isSafeWebhookUrl(rawUrl: string): Promise<WebhookUrlCheck> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return "unsafe"; }
  if (u.protocol !== "https:") return "unsafe"; // 민감 발화 평문 전송 방지 — https만 허용(Discord/Slack 등 모두 https)
  /**
   * 주소에 아이디·비밀번호(https://아이디:비밀번호@호스트)가 있으면 막는다(2026-10-07 8차). fetch는 그 값을 Authorization 헤더로
   *   바꿔 보내고, 주소를 다루는 곳(로그·오류 메시지)마다 비밀이 따라다닌다. 정상 메신저 웹훅(Discord·Slack·IFTTT·n8n)은 쓰지 않는다 —
   *   보호자 화면 저장도 같은 이유로 거절한다(app/api/users/profile PATCH). 이미 저장된 주소는 영구 실패("blocked" — 경보)로 드러난다.
   */
  if (u.username || u.password) return "unsafe";
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return "unsafe";
  let addrs: { address: string; family: number }[];
  try {
    // 3초 상한(8차) — 넘기면 아래 catch에서 "unresolved"(코드 없음 → 일시 실패). 조회는 뒤에서 이어질 수 있다(결과는 버린다)
    addrs = await withinMs(dns.lookup(host, { all: true }), WEBHOOK_DNS_TIMEOUT_MS);
  } catch (e) {
    // 그런 이름이 없다(NXDOMAIN) — 다시 물어도 같다. Node는 getaddrinfo의 "이름 없음"·"주소 없음"을 ENOTFOUND로 바꾼다.
    //   그 밖(EAI_AGAIN — 시간 초과·SERVFAIL, 그 밖의 조회 오류, 3초 상한)은 잠시 뒤면 될 수 있다
    return (e as { code?: unknown } | null)?.code === "ENOTFOUND" ? "nonexistent" : "unresolved";
  }
  if (!addrs.length) return "unresolved";
  for (const { address, family } of addrs) {
    if (family === 4 && isPrivateIPv4(address)) return "unsafe";
    const a = address.toLowerCase();
    if (family === 6 && (a === "::1" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80"))) return "unsafe";
    if (family === 6 && a.startsWith("::ffff:") && isPrivateIPv4(a.replace("::ffff:", ""))) return "unsafe";
  }
  return "safe";
}

/**
 * 웹훅 응답 상태 → 결과(2026-10-07 5차, ContactResult 주석). 4xx는 주소·형식 문제라 다시 보내도 같다("failed-permanent") —
 *   단 408(요청 시간 초과)·429(한도)는 잠시 뒤면 될 수 있어 일시 실패. 5xx와 그 밖의 비정상 상태도 일시 실패.
 */
function webhookStatusResult(status: number): ContactResult {
  return status >= 400 && status < 500 && status !== 408 && status !== 429 ? "failed-permanent" : "failed";
}

/** 메신저(webhook) 한 번 보내기 — 결과를 ContactResult로(분류는 ContactResult 주석). 로그는 여기서 남긴다(주소·본문은 싣지 않는다) */
export async function sendWebhook(url: string, body: unknown): Promise<ContactResult> {
  const check = await isSafeWebhookUrl(url);
  if (check === "unsafe") {
    console.warn("[emergency-notify] 안전하지 않은 웹훅 URL 차단(SSRF 방어) — 영구 실패(다시 보내도 막힌다, 보호자 연락처 확인 필요)");
    return "blocked";
  }
  if (check === "nonexistent") {
    console.warn("[emergency-notify] 웹훅 주소의 도메인이 없다(DNS ENOTFOUND) — 보내지 않았다(영구 실패, 보호자 연락처 확인 필요)");
    return "failed-permanent";
  }
  if (check === "unresolved") {
    console.warn("[emergency-notify] webhook failed — 주소(DNS)를 확인하지 못해 보내지 않았다(일시 실패 — 같은 응급이 다시 감지되면 60초 뒤부터 다시)");
    return "failed";
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
      /**
       * ⚠ **리다이렉트를 따라가지 않는다** (2026-10-02 발견).
       *
       * fetch의 기본값은 `follow`다. 즉 위 isSafeWebhookUrl을 통과한 호스트가
       * `302 Location: http://169.254.169.254/latest/meta-data/`를 돌려주면
       * **SSRF 가드를 완전히 우회해** 내부망·인스턴스 메타데이터로 요청이 나간다.
       * 가드는 처음 URL만 검사하고, 리다이렉트 대상은 아무도 검사하지 않았다.
       * DNS rebinding(두 해석 사이의 경쟁)보다 **훨씬 쉽고 확실한** 우회 경로였다.
       *
       * `manual`이면 3xx를 그대로 돌려받고 따라가지 않는다. 정상 웹훅(Discord·Slack·
       * IFTTT·n8n)은 POST에 3xx를 쓰지 않으므로 기능 영향이 없다 —
       * 아래에서 영구 실패("failed-permanent" — 다시 보내도 같은 주소로 돌려보낸다)로 기록될 뿐이다.
       */
      redirect: "manual",
    });
    if (res.ok) return "ok";
    if (res.status >= 300 && res.status < 400) {
      console.warn(`[emergency-notify] 웹훅이 리다이렉트 응답(${res.status}) — 따라가지 않음(SSRF 우회 차단, 영구 실패)`);
      return "failed-permanent";
    }
    const result = webhookStatusResult(res.status);
    console.warn("[emergency-notify] webhook failed:", { status: res.status, result });
    return result;
  } catch (e) {
    // 네트워크 오류·8초 시간 초과(AbortSignal.timeout) — 잠시 뒤면 될 수 있다.
    //   로그엔 오류 이름과 원인 코드만 싣는다(8차) — 메시지·주소는 싣지 않는다: 웹훅 주소 자체가 비밀이고(Discord·Slack은 경로에 토큰을
    //   싣는다), fetch(undici) 오류의 메시지·원인 메시지에는 호스트·주소가 섞일 수 있다(예: "getaddrinfo ENOTFOUND <호스트>").
    //   원인 코드(ENOTFOUND·ECONNREFUSED·UND_ERR_CONNECT_TIMEOUT 등)면 까닭을 가리기에 충분하다.
    const err = e as { name?: unknown; cause?: { code?: unknown } } | null | undefined;
    console.warn("[emergency-notify] webhook failed:", { error: err?.name, cause: err?.cause?.code, result: "failed" });
    return "failed";
  }
}
