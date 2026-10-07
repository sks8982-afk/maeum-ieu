/**
 * 응급 신호 발생 시 보호자에게 알림 전송.
 *
 * Phase 2: Webhook(Discord/Slack/IFTTT/Zapier 등 호환) POST + 옵션 이메일.
 *   SMS/카카오 알림톡은 외부 유료 서비스 연동 필요하므로 추후.
 *
 * 보호자가 Webhook URL을 등록하면 그 endpoint로 JSON POST.
 * 등록 없으면 콘솔 로그만 남기고 noop.
 *
 * 중복 방지:
 * - 같은 사용자의 같은 카테고리는 1시간 내 1회만 발송.
 * - notifiedAt이 이미 찍힌 메시지는 재발송 안 함.
 */

import { prisma } from "@/lib/prisma";
import { sendEmergencyPush } from "@/lib/notify/push-fcm";
import { sendEmergencyEmail, sendOpsAlert } from "@/lib/notify/email";
import { decryptPII } from "@/lib/crypto";
import { emergencyCategoryKo } from "@/lib/chat/emergency-labels";
import dns from "node:dns/promises";

export interface NotifyPayload {
  userId: string;
  userName: string;
  /** 발송 시각 마킹 대상. DB 저장이 실패한 응급 턴에서는 없을 수 있고, 그래도 발송은 진행한다 */
  messageId?: string;
  level: 2 | 3;
  category: string;
  content: string;          // 사용자 발화 원문 (요약본)
  aiReply: string;          // AI 응답 (요약본)
  createdAt: Date;
  /**
   * false면 알림에 실명 대신 호출부가 준 userName(호칭)을 쓴다. 기본은 실명(있으면).
   *   인지 변화 추세(C2)는 "실명 미사용"이 설계 규칙이다(lib/health/cognitive-alert).
   */
  realName?: boolean;
}

/**
 * 토픽 푸시용 이름 가림 — 김영자→김*자, 이수→이*, 남궁민수→남**수.
 *
 * 왜(2026-10-07 재검토): FCM **토픽**은 구독 권한 검사가 없다. 토픽 이름(maeum_<계정 id>)을 아는 기기는
 *   누구든 구독할 수 있어, 실명·건강 분류가 잠금화면에 그대로 뜨는 메시지를 토픽에 싣는 건 위험하다.
 *   실명은 수신자가 특정되는 채널(보호자 이메일·메신저 주소)에만 쓰고, 토픽에는 가린 이름을 싣는다.
 */
export function maskName(name: string): string {
  const chars = [...name.trim()];
  if (chars.length === 0) return "어르신";
  if (chars.length === 1) return chars[0];
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${"*".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

export interface NotifyResult {
  sent: boolean;
  channels: string[];       // ["webhook", "email"]
  reason?: string;          // 미발송 사유
}

const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1시간

function levelLabel(level: number): string {
  return level === 3 ? "🚨 즉시 응급" : level === 2 ? "⚠️ 주의 필요" : "관찰";
}

/**
 * @param who   알림에 쓸 어르신 호칭 — 실명이 있으면 실명(notifyGuardian이 정한다)
 * @param label 카테고리 한글 라벨. 코드도 괄호로 남긴다(메신저 자동화가 코드를 쓸 수 있어서)
 */
function buildWebhookBody(payload: NotifyPayload, who: string, label: string): unknown {
  // Discord-compatible 형식 — Slack/IFTTT/n8n도 content 필드는 공통 처리.
  const lvl = levelLabel(payload.level);
  const title = payload.level === 3
    ? `[마음이음] 즉시 응급 신호 감지`
    : `[마음이음] 주의 신호 감지`;
  const body = [
    `${lvl}`,
    `사용자: ${who}`,
    `카테고리: ${label} (${payload.category})`,
    `사용자 발화: "${payload.content.slice(0, 200)}"`,
    `AI 응답: "${payload.aiReply.slice(0, 200)}"`,
    `시각: ${payload.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
    payload.level === 3 ? `\n👉 지금 바로 ${who}님께 연락하시거나 119에 신고해주세요.` : `\n👉 시간 되실 때 ${who}님 안부 확인 부탁드립니다.`,
  ].join("\n");

  return {
    content: `**${title}**\n${body}`,                  // Discord/Slack content
    text: `${title}\n${body}`,                          // 일부 webhook 시스템용
    embeds: [{                                          // Discord embed
      title,
      description: body,
      color: payload.level === 3 ? 0xff0000 : 0xff9500,
      timestamp: payload.createdAt.toISOString(),
    }],
  };
}

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
 * SSRF 방어 — 보호자 웹훅 URL이 내부/사설/메타데이터로 향하지 않는지 검증.
 * 호스트네임을 실제 IP로 해석해 사설 대역이면 차단. 해석 실패·빈 응답은 차단(fail-closed).
 *
 * ⚠ **DNS rebinding은 막지 못한다**(2026-10-02 정정 — 이전 주석이 "DNS rebinding 방어"라고
 *   적고 있었으나 사실이 아니었다). 여기서 lookup한 뒤 아래 fetch가 **독립적으로 다시** 해석하므로,
 *   TTL 0 레코드로 두 해석 사이에 IP를 바꾸면 우회된다. 실제로 막으려면 해석된 IP로 직접 접속하고
 *   Host 헤더를 붙여야 한다.
 *   현재 위험도 평가: 공격자는 보호자 계정이어야 하고, 응답 본문이 호출부로 돌아가지 않는
 *   blind SSRF다. 그래서 즉시 치명은 아니나, AWS 메타데이터가 사정권이라 방치할 것도 아니다.
 *   (회귀 고정: __tests__/webhook-ssrf.test.ts — 이 함수는 2026-10-02까지 테스트가 0건이었다)
 */
async function isSafeWebhookUrl(rawUrl: string): Promise<boolean> {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== "https:") return false; // 민감 발화 평문 전송 방지 — https만 허용(Discord/Slack 등 모두 https)
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
  try {
    const addrs = await dns.lookup(host, { all: true });
    if (!addrs.length) return false;
    for (const { address, family } of addrs) {
      if (family === 4 && isPrivateIPv4(address)) return false;
      const a = address.toLowerCase();
      if (family === 6 && (a === "::1" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80"))) return false;
      if (family === 6 && a.startsWith("::ffff:") && isPrivateIPv4(a.replace("::ffff:", ""))) return false;
    }
  } catch { return false; }
  return true;
}

async function sendWebhook(url: string, body: unknown): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!(await isSafeWebhookUrl(url))) {
    console.warn("[emergency-notify] 안전하지 않은 웹훅 URL 차단(SSRF 방어)");
    return { ok: false, error: "unsafe webhook url blocked" };
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
       * 아래 res.ok가 false가 되어 "webhook failed"로 기록될 뿐이다.
       */
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400) {
      console.warn(`[emergency-notify] 웹훅이 리다이렉트 응답(${res.status}) — 따라가지 않음(SSRF 우회 차단)`);
      return { ok: false, status: res.status, error: "redirect blocked" };
    }
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * 중복 발송 차단 — 같은 사용자 + 같은 카테고리 + 1시간 내 "같거나 높은 레벨" 발송 이력이 있으면 skip.
 * ⚠ 레벨 비교 필수(2026-07-07 감사 blocker): 비교 없이 카테고리만 보면 L2(주의) 알림 후 1시간 내
 *   같은 카테고리 L3(즉시응급) 격상 — 요양원에서 가장 개연성 높은 "경증 호소 → 악화" 경로 — 가 통째로 억제됨.
 *   L2→L3 격상은 반드시 재발송, L3→L2 하향·동일 레벨 반복만 dedup.
 */
async function isDuplicate(userId: string, category: string, level: 2 | 3): Promise<boolean> {
  const cutoff = new Date(Date.now() - DEDUP_WINDOW_MS);
  const recent = await prisma.message.findFirst({
    where: {
      conversation: { userId },
      emergencyLevel: { gte: level }, // 이번 레벨 이상으로 이미 알렸을 때만 중복 — 격상은 통과
      notifiedAt: { gte: cutoff },
      emergencyEvidence: { startsWith: `${category}:` },
    },
    select: { id: true },
  });
  return recent !== null;
}

/**
 * 발송 팬아웃 상한 — dedup을 fail-open으로 바꾼 대가를 메우는 2차 방어선.
 *
 * DB 쓰기가 지속 실패하면 notifiedAt 앵커가 안 남아 **같은 응급이 매 턴 재발송**된다.
 * 1차 방어(DB dedup)가 바로 그 상황에서 무력하므로, 프로세스 메모리에 마지막 발송 시각을
 * 남겨 "DB로 중복을 확인할 수 없었던 경우"에만 참조한다.
 *
 * ⚠ 서버리스라 인스턴스별이다 — 완전한 억제가 아니라 **"무한"을 "인스턴스당 1회"로** 낮추는 장치다.
 *   그래도 의미가 큰 이유: 공용 Gmail 단일 발신 계정(무료 ~500통/일)이라
 *   한 사람의 폭주가 **다른 환자의 알림까지** 끊는다.
 */
const recentSends = new Map<string, { at: number; windowMs: number }>();
const FANOUT_KEY = (p: { userId: string; category: string; level: number }) => `${p.userId}:${p.category}:${p.level}`;

/**
 * 전 채널 실패 후의 **재시도 바닥** — 성공 창(1시간)보다 훨씬 짧다.
 *
 * 왜 둘을 나누나: 아무것도 전달되지 않았는데 1시간을 막으면 일시 장애가 지나간 뒤에도
 *   그 응급은 영영 전달되지 않는다(위음성). 반대로 바닥이 없으면 SMTP 거절 같은 실패를
 *   매 턴 재시도하며 공용 Gmail 쿼터를 태운다. 60초는 "다음 턴엔 다시 시도하되
 *   폭주는 아니다"의 균형점이다.
 */
const RETRY_FLOOR_MS = 60 * 1000;

/**
 * 메모리 팬아웃 상한 — 발송 직전 **항상** 확인하는 공통 게이트.
 *
 * ⚠ 2026-10-02 수정(AWS 이전 감사 blocker): 이전에는 `isDuplicate()`가 **throw한 catch
 *   안에서만** 이 함수를 불렀다. 그래서 가장 흔한 장애 유형에서 상한이 통째로 무력했다:
 *     · **읽기는 되고 쓰기만 실패**(디스크 풀·읽기복제 전환·커넥션 고갈): isDuplicate는
 *       정상적으로 "중복 아님"을 돌려준다(notifiedAt 쓰기가 실패해 앵커가 안 남았으니).
 *       예외가 없으니 catch도 안 타고 → 같은 L3가 **매 턴** 푸시+이메일+웹훅으로 재발송된다.
 *     · **messageId가 없는 경로**(최후 안전망 lastResortEmergency): 마킹 자체를 건너뛰므로
 *       notifiedAt이 영영 안 찍힌다 → 같은 증상. 안전망을 추가하면서 이 경로가 늘었다.
 *   공용 Gmail 단일 발신 계정(무료 ~500통/일)이라, 한 사람의 폭주가 같은 날
 *   **다른 환자의 응급 이메일까지 차단**한다 — 사람 안전에 직결된다.
 *
 * ⚠ 키에 level이 들어가므로 L2→L3 격상은 막히지 않는다(별개 키).
 * ⚠ 프로세스 메모리라 멀티 인스턴스에서는 태스크 수만큼 샌다. 완전한 해법은 Upstash
 *   SETNX+TTL이고(이미 프로비저닝됨), AWS 이전 때 3단(DB → Redis → 메모리)으로 올리는 게 맞다.
 */
function tooSoonSinceLastSend(key: string): boolean {
  const last = recentSends.get(key);
  if (last === undefined) return false;
  if (Date.now() - last.at < last.windowMs) return true;
  recentSends.delete(key);
  return false;
}

/** 발송 앵커 기록. 성공은 전체 dedup 창, 전 채널 실패는 짧은 재시도 바닥. */
function markSent(key: string, delivered: boolean): void {
  pruneRecentSends();
  recentSends.set(key, { at: Date.now(), windowMs: delivered ? DEDUP_WINDOW_MS : RETRY_FLOOR_MS });
}

/** 맵이 무한히 자라지 않게 — 만료분 정리(호출 빈도가 낮아 전수 순회로 충분) */
function pruneRecentSends(): void {
  const now = Date.now();
  for (const [k, v] of recentSends) if (now - v.at >= v.windowMs) recentSends.delete(k);
}

/**
 * 응급 알림 발송.
 * Returns 결과 + 발송한 채널 목록. 실패해도 throw 안 함 (LLM 응답에 영향 X).
 */
export async function notifyGuardian(payload: NotifyPayload): Promise<NotifyResult> {
  const channels: string[] = [];

  // 1) 중복 차단 (같은 카테고리·같거나 높은 레벨만 — L2→L3 격상은 통과)
  //    ⚠ 조회 실패 시 **발송 쪽으로 열린다**(2026-10-01). 이 함수의 첫 await가 DB 읽기라,
  //    예외가 그대로 전파되면 DB 일시 장애 하나로 푸시·이메일·웹훅이 **전부 0건**이 됐다.
  //    중복 알림은 보호자가 한 번 더 확인하면 끝이지만, 누락은 되돌릴 수 없다.
  const fanoutKey = FANOUT_KEY(payload);

  /**
   * 0) 메모리 팬아웃 상한 — **DB dedup보다 먼저, 그리고 항상** 확인한다.
   *    DB dedup은 notifiedAt(쓰기)에 의존하므로 "읽기는 되고 쓰기만 실패"하거나
   *    messageId가 없는 경로(최후 안전망)에서는 영원히 "중복 아님"을 돌려준다.
   *    그 구멍을 메우는 게 이 게이트다(상세는 tooSoonSinceLastSend 주석).
   */
  if (tooSoonSinceLastSend(fanoutKey)) {
    console.warn("[emergency-notify] 최근 발송 이력(메모리 상한) — 폭주 방지로 skip");
    return { sent: false, channels: [], reason: "메모리 상한 — 최근 동일 응급 발송 이력" };
  }

  try {
    if (await isDuplicate(payload.userId, payload.category, payload.level)) {
      return { sent: false, channels: [], reason: `dedup window (${DEDUP_WINDOW_MS / 60000}분 내 동일 카테고리 L${payload.level}+ 발송 이력)` };
    }
  } catch (e) {
    // DB로 중복을 확인할 수 없어도 위 메모리 게이트는 이미 통과했다 — 발송을 진행한다.
    //   (중복 알림은 보호자가 한 번 더 확인하면 끝이지만, 누락은 되돌릴 수 없다)
    console.warn("[emergency-notify] dedup 조회 실패 — 중복 위험을 감수하고 발송 진행:", e instanceof Error ? e.message : e);
  }

  // 2) 사용자 보호자 정보 조회
  //    조회 실패를 치명으로 다루지 않는다 — webhook·email은 못 쓰더라도 아래 FCM 경로는
  //    별도 쿼리(ExpertPatient)라 살아 있을 수 있다. 한 쿼리 실패로 전 채널을 버리지 않는다.
  let user: { name: string | null; guardianWebhookUrl: string | null; guardianEmail: string | null; guardianName: string | null } | null = null;
  let lookupFailed = false;   // 조회 실패와 "대상 없음"을 구별하기 위한 플래그
  try {
    user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { name: true, guardianWebhookUrl: true, guardianEmail: true, guardianName: true },
    });
  } catch (e) {
    lookupFailed = true;
    console.error("[emergency-notify] 보호자 연락처 조회 실패 — webhook/email 건너뛰고 FCM만 시도:", e instanceof Error ? e.message : e);
  }

  /**
   * 알림 문구(2026-10-07): **누구에게 무슨 일인지**가 알림 한 줄에 보여야 한다.
   *   · 이름 — 호출부가 넘기는 userName은 경로마다 다르다(대화 L3는 동반자가 부르는 호칭 "할머니", 최후 안전망은
   *     "선생님" → "선생님님"). 의사는 환자가 여럿이라 호칭으론 누군지 모른다. 어르신 실명이 있으면 실명.
   *   · 분류 — 코드("fall_injury")를 그대로 보냈다. 한글 라벨(단일 출처 lib/chat/emergency-labels).
   *   · 시각 — 폰이 꺼져 있다 늦게 받으면 방금 일처럼 보였다. 본문에 감지 시각.
   */
  const realName = payload.realName !== false ? user?.name?.trim() : undefined;
  const who = realName || payload.userName;
  // 토픽 푸시: 실명은 가리고(maskName 주석), 실명을 모르면 호칭 대신 "어르신" — 호칭("할머니")·"선생님"은 누군지 못 가린다
  const pushWho = payload.realName === false ? payload.userName : realName ? maskName(realName) : "어르신";
  const label = emergencyCategoryKo(payload.category);
  const when = payload.createdAt.toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "numeric", minute: "2-digit" });

  // 3) Webhook 발송 (보호자가 URL을 등록한 경우)
  if (user?.guardianWebhookUrl) {
    const r = await sendWebhook(user.guardianWebhookUrl, buildWebhookBody(payload, who, label));
    if (r.ok) channels.push("webhook");
    else console.warn("[emergency-notify] webhook failed:", r);
  }

  // 4) FCM 푸시 — 환자와 연결된 보호자(전문가) 계정의 앱 토픽으로 발송.
  //    보호자가 마음이음 앱에 로그인하면 maeum_<보호자id> 토픽을 구독함.
  let guardianIds: string[] = [];
  try {
    const links = await prisma.expertPatient.findMany({
      where: { patientUserId: payload.userId, status: "active" },
      select: { expertUserId: true },
    });
    guardianIds = links.map((l) => l.expertUserId);
  } catch (e) {
    // 여기서 throw되면 **뒤에 오는 이메일 발송까지 통째로 날아간다**. 격리한다.
    lookupFailed = true;
    console.error("[emergency-notify] 보호자 연결 조회 실패 — FCM 건너뜀:", e instanceof Error ? e.message : e);
  }
  if (guardianIds.length > 0) {
    const push = await sendEmergencyPush(guardianIds, {
      title: payload.level === 3 ? "🚨 즉시 응급 신호" : "⚠️ 주의 신호",
      body:
        payload.level === 3
          ? `${pushWho}님 — ${label} (${when}). 지금 바로 연락하시거나 119에 신고해주세요.`
          : `${pushWho}님 — ${label} (${when}). 안부를 확인해주세요.`,
      level: payload.level,
      category: payload.category,
      createdAt: payload.createdAt,
      patientId: payload.userId,
    });
    if (push.sent > 0) channels.push("fcm");
    else if (push.failed > 0) console.warn("[emergency-notify] fcm failed:", push);
    // 자격증명 없음 등으로 **아예 안 보낸** 경우도 남긴다 — 예전엔 연결된 보호자가 있는데도 로그가 없었다
    else if (push.skipped) console.error("[emergency-notify] fcm skipped — 연결 보호자 앱으로 푸시가 나가지 않음:", push.skipped);
  }

  // 5) 이메일 — 보호자 이메일(암호화 저장)로 Gmail SMTP 발송. GMAIL_USER·GMAIL_APP_PASSWORD 없으면 skip(lib/notify/email).
  if (user?.guardianEmail) {
    const email = decryptPII(user.guardianEmail);
    /**
     * ⚠ 복호 실패를 **조용히 넘기지 않는다**(2026-10-02). 실패하면 decryptPII가 암호문을
     *   그대로 돌려주고, sendEmergencyEmail의 수신자 형식 검사가 그걸 버려 **이메일 채널이
     *   말없이 사라졌다**. ENCRYPTION_KEY 교체 때 전 보호자에게 동시에 일어난다.
     */
    if (email && email.startsWith("enc:")) {
      console.error("[emergency-notify] 🔴 보호자 이메일 복호화 실패 — ENCRYPTION_KEY 확인 필요. 이메일 채널 사용 불가");
    } else if (email) {
      const ok = await sendEmergencyEmail(email, {
        userName: who,
        level: payload.level,
        category: label,          // 메일 본문 "종류" 칸 — 코드 대신 한글 라벨
        createdAt: payload.createdAt,
      });
      if (ok) channels.push("email");
    }
  }

  // 6) 발송 시각 마킹 (어느 채널이든 1건 이상 성공 시)
  if (channels.length > 0) {
    // DB 마킹과 **별개로** 메모리 앵커를 남긴다 — 마킹이 실패해도 폭주 상한은 살아 있어야 한다.
    markSent(fanoutKey, true);
    // 마킹 실패가 **이미 성공한 발송을 실패로 둔갑**시키지 않게 격리.
    //   (실패하면 dedup이 안 걸려 다음 턴에 한 번 더 갈 수 있는데, 누락보다 낫다)
    if (payload.messageId) {
      try {
        await prisma.message.update({
          where: { id: payload.messageId },
          data: { notifiedAt: new Date() },
        });
      } catch (e) {
        console.error("[emergency-notify] notifiedAt 마킹 실패(발송은 성공):", e instanceof Error ? e.message : e);
      }
    } else {
      console.warn("[emergency-notify] messageId 없음 — 발송은 했으나 dedup 기록 불가(저장 실패 턴)");
    }
    return { sent: true, channels };
  }
  // 전 채널 실패/미설정 — 사유를 남겨 호출부 로그('skipped: undefined')가 원인 불명이 되지 않게
  const hadTargets = Boolean(user?.guardianWebhookUrl) || guardianIds.length > 0 || Boolean(user?.guardianEmail);
  // ⚠ 조회가 실패한 경우를 "보호자 미연결"로 적으면 **운영자가 원인을 영원히 못 찾는다**.
  //   대상이 없는 것과 대상을 못 읽은 것은 조치가 완전히 다르다(전자는 설정, 후자는 장애).
  /**
   * 전 채널 실패 — **짧은 재시도 바닥**만 남긴다(성공 창을 쓰면 안 된다).
   *   아무것도 전달되지 않았는데 1시간을 막으면 일시 장애가 지나간 뒤에도 그 응급이
   *   영영 전달되지 않는다(위음성). 반대로 바닥이 없으면 SMTP 거절 같은 실패를 매 턴
   *   재시도하며 공용 Gmail 쿼터를 태운다.
   */
  markSent(fanoutKey, false);

  const reason = lookupFailed && !hadTargets
    ? "보호자 조회 실패 — 발송 대상 확인 불가(DB 장애 의심)"
    : hadTargets ? "모든 채널 발송 실패(위 warn 로그 참조)" : "알림 대상 없음(보호자 미연결·webhook/email 미등록)";
  if (lookupFailed && !hadTargets) {
    console.error("[emergency-notify] 발송 0건 — 보호자 조회 실패로 대상 확인 불가(DB 장애 의심)");
  }

  /**
   * 운영자 경보 — 보호자에게 한 건도 못 보낸 응급을 **사람에게 알리는 마지막 경로**.
   *
   * 결함(2026-10-02 적대 리뷰): 여기서 sent:false를 돌려줘도 호출부 5곳이 전부 console.warn으로
   *   끝냈고, 영속 기록도 통보도 없었다. 유일한 사후 탐지인 scripts/pilot-daily-check.ts는
   *   `Message.notifiedAt IS NULL`을 보는데, **알림이 실패하는 전형적 상황(RDS 장애)에서는
   *   Message 행 자체가 안 만들어진다.** 탐지 사각이 이중으로 겹쳐 "그날 응급 0건"으로 보였다.
   *   이 경로는 SMTP만 쓰므로 RDS가 죽어도 닿는다. env OPS_ALERT_EMAIL 미설정이면 조용히 skip.
   *   ⚠ 부유 프라미스 금지 — 호출부가 after()로 감싸 실행을 보장하는 블록 안에서 await한다.
   */
  await sendOpsAlert(
    `응급 알림 실패 (L${payload.level} ${payload.category})`,
    [
      `사유: ${reason}`,
      `레벨: L${payload.level} / 분류: ${payload.category}`,
      `대상 userId: ${payload.userId}`,
      `메시지 기록: ${payload.messageId ? payload.messageId : "없음(저장 실패 또는 안전망 경로)"}`,
      `발생 시각: ${payload.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
      "",
      "보호자에게 한 건도 전달되지 않았습니다. 수동 확인이 필요합니다.",
    ],
  ).catch(() => false);   // 경보 실패가 호출부를 무너뜨리지 않게

  return { sent: false, channels, reason };
}
