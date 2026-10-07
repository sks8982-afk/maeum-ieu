/**
 * 응급 신호 발생 시 보호자에게 알림 전송.
 *
 * Phase 2: Webhook(Discord/Slack/IFTTT/Zapier 등 호환) POST + 옵션 이메일.
 *   SMS/카카오 알림톡은 외부 유료 서비스 연동 필요하므로 추후.
 *
 * 보호자가 Webhook URL을 등록하면 그 endpoint로 JSON POST.
 * 등록 없으면 콘솔 로그만 남기고 noop.
 *
 * 중복 방지(최종 규칙 — 2026-10-08):
 * - 1시간 창: 같은 사용자·같은 카테고리를 같거나 높은 레벨로 1시간 안에 이미 알렸으면(notifiedAt) 보내지 않는다(L2→L3 격상은 보낸다).
 *   이 창은 그 발송에 일시 발송 실패·조회 실패(등록 휴대폰·보호자 연락처·연결 — 중복 확인 조회는 빼고)가 하나도 없을 때만 건다
 *   (영구 실패뿐이어도 건다 — 다시 보내도 같다. 보낸 곳이 하나도 없으면 메모리 앵커만 — notifiedAt은 쓰지 않는다).
 * - 그런 실패가 있었으면 — 받은 곳이 확인됐어도 — 60초 바닥만 남긴다(보낼 곳이 없었을 때도): 같은 응급이 다시 감지되면(60초 뒤부터)
 *   다시 간다. 재시도 큐는 없다 — 다시 감지되지 않으면 다시 가지 않는다(markSent·아래 6의 앵커 주석).
 *
 * 모듈 나눔(2026-10-07 7차 — 1,100줄을 넘어 한 파일에서 경로를 따라가기 어려웠다. **그대로 옮겼다** — 동작은 같다):
 *   · 이 파일 — 진입점(notifyGuardian)·알림 문구·중복 방지(DB dedup·메모리 앵커)·채널 집계와 앵커 규칙·"응급 알림 실패" 경보
 *   · emergency-notify-shared — 함께 쓰는 모양(NotifyPayload·ContactResult)과 DB 기다림 상한
 *   · emergency-notify-webhook — 메신저(webhook) 전송 + SSRF 가드
 *   · emergency-notify-email — 보호자 이메일 사본
 *   · emergency-notify-app-push — 앱 푸시(등록 휴대폰 실명 사본 + 토픽 가린 이름 사본)
 *   · emergency-notify-alerts — 운영자 경보(조회 실패·발송 실패·영구 실패·받은 곳 미확인·테이블 없음)
 *   공개 API(notifyGuardian·maskName·NotifyPayload·NotifyResult)는 그대로 이 경로에서 가져다 쓴다.
 */

import { prisma } from "@/lib/prisma";
import { PUSH_TOKENS_LIVE } from "@/lib/app-version";
import { emergencyCategoryKo } from "@/lib/chat/emergency-labels";
import { withinMs } from "@/lib/within-ms";
import {
  DEDUP_LOOKUP_TIMEOUT_MS, MARK_NOTIFIED_TIMEOUT_MS, TARGET_LOOKUP_TIMEOUT_MS, type ContactResult, type NotifyPayload,
} from "@/lib/chat/emergency-notify-shared";
import { sendWebhook } from "@/lib/chat/emergency-notify-webhook";
import { sendGuardianEmail } from "@/lib/chat/emergency-notify-email";
import { appPushPayload, sendAppPush, type AppPushOutcome } from "@/lib/chat/emergency-notify-app-push";
import {
  alertLookupProblems, alertPermanentFailures, alertSendFailed, alertTransientFailures, alertUnconfirmedDelivery, isPermanentFailure,
  NOT_ANCHORED_LINE, permanentNote, sendOpsAlert, type LookupFailures,
} from "@/lib/chat/emergency-notify-alerts";
import { randomUUID } from "node:crypto";

// 호출부의 공개 모양 — 옮긴 뒤에도 이 경로에서 가져다 쓴다
export type { NotifyPayload } from "@/lib/chat/emergency-notify-shared";

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
  /** "webhook" · "email" · "fcm"(알림 허용을 보고한 등록 휴대폰) · "fcm-muted"(등록 휴대폰이 알림 꺼짐 보고) · "fcm-topic"(토픽 사본 — 받은 기기는 모름) */
  channels: string[];
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
 * 앵커를 걸지 않은 발송의 **재시도 바닥** — 1시간 창보다 훨씬 짧다. 쓰는 때(최종 규칙): 일시 발송 실패·조회 실패가 있었을 때
 *   (2026-10-08 10차부터 받은 곳이 확인됐어도 — 전 채널 실패만이 아니다)와 보낼 곳이 없었을 때. 1시간 창은 그런 실패가 하나도
 *   없을 때만 건다(영구 실패뿐이어도 — markSent).
 *
 * 왜 둘을 나누나: 빠진 사본이 있는데 1시간을 막으면 일시 장애가 지나간 뒤에도
 *   그 사본은 그 응급에 영영 가지 않는다(위음성). 반대로 바닥이 없으면 SMTP 거절 같은 실패를
 *   같은 응급이 다시 감지될 때마다 재시도하며 공용 Gmail 쿼터를 태운다. 재시도 큐는 없다 — 바닥은 다시 보낼 수 있게 되는 때일
 *   뿐이고, 같은 응급이 다시 감지되면(60초 뒤부터) 다시 간다. 60초는 "다시 감지되면 다시 가되 폭주는 아니다"의 균형점이다.
 */
const RETRY_FLOOR_MS = 60 * 1000;

/**
 * 진행 중 표시의 수명(2026-10-07 4차) — 같은 응급(사용자·분류·레벨)을 보내는 **동안** 같은 키의 두 번째 호출을 막는다.
 *   왜: 앵커(markSent)는 발송이 끝난 뒤에야 남는다. 그 사이(등록 휴대폰 경로 최대 8초, SMTP 최대 ~31초)에 같은 응급이 다시
 *   들어오면(음성 턴이 연달아 오는 등) 이메일·메신저·앱 푸시가 한 번 더 나갔다. 발송이 끝나면 markSent가 이 표시를 덮는다
 *   (빠진 사본 없음 = 1시간 창, 일시 실패·조회 실패가 있으면 = 60초 바닥 — 10차부터 받은 곳이 확인돼도).
 *   예산(8차 — 앵커 전의 **모든** 기다림에 상한이 있다. 차례로 도는 것은 더하고, 함께 도는 것은 가장 긴 것만 센다):
 *     중복 확인 3초(DEDUP_LOOKUP_TIMEOUT_MS) → 연락처 조회 5초(TARGET_LOOKUP_TIMEOUT_MS) → 아래 셋이 함께 돈다:
 *       · 메신저: DNS 3초(webhook WEBHOOK_DNS_TIMEOUT_MS) + POST 8초(AbortSignal.timeout) = 11초
 *       · 이메일: 35초(email EMAIL_SEND_TIMEOUT_MS — SMTP 상한 31초 앞의 DNS까지 덮는다)
 *       · 앱 푸시: 연결 조회 5초 + 등록 휴대폰 경로 8초(+ 그 뒤 토큰 정리 2초 — 9차)·토픽 사본 10초(둘은 함께 — app-push
 *         DEVICE_PATH_TIMEOUT_MS·TOKEN_CLEANUP_TIMEOUT_MS·TOPIC_PATH_TIMEOUT_MS) = 15초
 *     최악 = 3 + 5 + 35 = 43초 → 여유를 두고 50초(7차까지 45초 — 이메일 앞의 DNS와 토픽 사본에 상한이 없어 예산이 성립하지 않았다).
 *   그보다 오래 멈출 수는 없지만, 표시가 풀린 뒤 같은 응급이 다시 감지되면 다시 간다(중복은 누락보다 낫다). 경보와 notifiedAt 기록은
 *   앵커 뒤라 예산 밖이다.
 */
const IN_FLIGHT_MS = 50 * 1000;

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

/** 진행 중 표시(IN_FLIGHT_MS) — 발송이 끝나면 markSent가 덮는다 */
function markInFlight(key: string): void {
  pruneRecentSends();
  recentSends.set(key, { at: Date.now(), windowMs: IN_FLIGHT_MS });
}

/**
 * 발송 앵커 기록 — 진행 중 표시를 덮는다. 빠진 것 없이 보냈으면(영구 실패뿐이어도) 전체 dedup 창, 조회 실패(등록 휴대폰·보호자
 *   연락처·연결)·일시 발송 실패가 있으면 — **받은 곳이 확인됐어도**(2026-10-08 10차) — 짧은 재시도 바닥. 전 채널 실패여도 실패가 모두
 *   영구 실패면 전체 창이다(2026-10-07 7차 — notifyGuardian 끝).
 */
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
 * 받은 곳이 **확인되는** 채널 — 보호자 메신저 주소·이메일 주소, 그리고 로그인한 계정이 직접 등록했고 알림을 허용했다고
 *   보고한 휴대폰("fcm"). "fcm-topic"(토픽은 구독자가 0명이어도 수락된다)과 "fcm-muted"(등록 휴대폰이 알림을 꺼 뒀다고
 *   보고함)는 보내긴 했지만 누가 받았는지 모른다(2026-10-07).
 */
const CONFIRMED_CHANNELS = new Set(["fcm", "email", "webhook"]);

/** 운영자 경보의 "실패한 경로" 항목 — 일시 실패는 채널 이름, 영구 실패는 그렇다고 붙인다(주소·이름은 싣지 않는다) */
function contactFailures(channel: "webhook" | "email", r: ContactResult): string[] {
  if (r === "failed") return [channel];
  if (r === "failed-permanent") return [`${channel}(영구 실패)`];
  return r === "blocked" ? [`${channel}(영구 실패 — 차단된 주소)`] : [];
}

/**
 * 메신저(webhook) 사본 — 보호자가 주소를 등록한 경우만(ContactResult 주석). 분류·로그는 sendWebhook이 한다:
 *   막은 주소(SSRF 방어)는 "blocked"(영구 실패 — 다시 보내도 막힌다), 없는 도메인(DNS ENOTFOUND)·4xx·리다이렉트는 영구 실패,
 *   그 밖의 DNS 확인 실패·5xx·네트워크·시간 초과는 일시 실패.
 */
async function sendGuardianWebhook(url: string | null | undefined, payload: NotifyPayload, who: string, label: string): Promise<ContactResult> {
  if (!url) return "none";
  return sendWebhook(url, buildWebhookBody(payload, who, label));
}

/**
 * 함께 출발한 채널 하나가 throw해도 그 채널만 실패("failed")로 센다(2026-10-07 3차) — 셋(webhook·앱 푸시·email)을 함께 기다리므로,
 *   하나가 reject하면 이미 나간 다른 채널 결과까지 버려지고 호출부(after())가 일찍 끝나 아직 도는 발송이 잘릴 수 있다.
 *   예전처럼 차례로 보낼 때보다 닿는 채널이 줄면 안 된다.
 */
function settleChannel(channel: string, send: Promise<ContactResult>): Promise<ContactResult> {
  return send.catch((e: unknown): ContactResult => {
    console.error(`[emergency-notify] ${channel} 발송 중 예외 — 그 채널만 실패로 센다:`, String(e));
    return "failed";
  });
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
  //    (7차) 조회가 멈춰도 같다 — 3초(DEDUP_LOOKUP_TIMEOUT_MS)를 넘기면 실패로 보고 발송한다(예전엔 그 자리에서 끝없이 기다렸다).
  const fanoutKey = FANOUT_KEY(payload);

  /**
   * 0) 메모리 팬아웃 상한 — **DB dedup보다 먼저, 그리고 항상** 확인한다.
   *    DB dedup은 notifiedAt(쓰기)에 의존하므로 "읽기는 되고 쓰기만 실패"하거나
   *    messageId가 없는 경로(최후 안전망)에서는 영원히 "중복 아님"을 돌려준다.
   *    그 구멍을 메우는 게 이 게이트다(상세는 tooSoonSinceLastSend 주석).
   *    같은 응급을 지금 보내는 중이어도 여기서 걸린다(진행 중 표시 — IN_FLIGHT_MS 주석).
   */
  if (tooSoonSinceLastSend(fanoutKey)) {
    console.warn("[emergency-notify] 최근(또는 진행 중) 같은 응급 발송 이력(메모리 상한) — 폭주 방지로 skip");
    return { sent: false, channels: [], reason: "메모리 상한 — 최근(또는 진행 중) 동일 응급 발송 이력" };
  }
  markInFlight(fanoutKey);

  /** 중복 확인 조회 실패(8차) — 운영자 경보(늘 — alertLookupProblems). 앵커 규칙에는 넣지 않는다(retryMayHelp 주석) */
  let dedupLookupFailed = false;
  try {
    if (await withinMs(isDuplicate(payload.userId, payload.category, payload.level), DEDUP_LOOKUP_TIMEOUT_MS)) {
      recentSends.delete(fanoutKey);   // 보내지 않는다 — 진행 중 표시를 거둔다(DB dedup이 계속 막는다)
      return { sent: false, channels: [], reason: `dedup window (${DEDUP_WINDOW_MS / 60000}분 내 동일 카테고리 L${payload.level}+ 발송 이력)` };
    }
  } catch (e) {
    // DB로 중복을 확인할 수 없어도 위 메모리 게이트는 이미 통과했다 — 발송을 진행한다.
    //   (중복 알림은 보호자가 한 번 더 확인하면 끝이지만, 누락은 되돌릴 수 없다)
    dedupLookupFailed = true;
    console.warn("[emergency-notify] dedup 조회 실패 — 중복 위험을 감수하고 발송 진행:", e instanceof Error ? e.message : e);
  }

  // 2) 사용자 보호자 정보 조회
  //    조회 실패를 치명으로 다루지 않는다 — webhook·email은 못 쓰더라도 아래 FCM 경로는
  //    별도 쿼리(ExpertPatient)라 살아 있을 수 있다. 한 쿼리 실패로 전 채널을 버리지 않는다.
  let user: { name: string | null; guardianWebhookUrl: string | null; guardianEmail: string | null; guardianName: string | null } | null = null;
  /**
   * 조회 실패는 조회마다 따로 센다(2026-10-07 3·6차) — 연락처(users)·연결(ExpertPatient). 어느 쪽이든 운영자 경보(늘 — 따로) +
   *   dedup 앵커 없음(아래 6 — 60초 바닥만, 2026-10-08 10차부터 받은 곳이 확인됐어도). 연락처를 못 읽으면 이메일·메신저가, 연결을 못 읽으면
   *   앱 알림(등록 휴대폰·토픽 사본)이 통째로 빠진다. 전 채널 실패 사유에서 "조회 실패"와 "대상 없음"을 가를 때는 둘 중 하나라도면 조회 실패다.
   *   (7차) 각 5초(TARGET_LOOKUP_TIMEOUT_MS) 안에 답이 없어도 조회 실패다 — 예전엔 DB가 멈추면 응급 알림 전체가 여기서 멈췄다.
   */
  let contactLookupFailed = false;
  let linkLookupFailed = false;
  try {
    user = await withinMs(prisma.user.findUnique({
      where: { id: payload.userId },
      select: { name: true, guardianWebhookUrl: true, guardianEmail: true, guardianName: true },
    }), TARGET_LOOKUP_TIMEOUT_MS);
  } catch (e) {
    contactLookupFailed = true;
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

  /**
   * 3) 메신저(webhook)·이메일 — 앱 푸시와 **함께 출발한다**(2026-10-07 3차). 둘은 앱 푸시 결과와 무관한데, 예전엔
   *    웹훅 → 앱 푸시(등록 휴대폰 조회·재시도 포함) → 이메일 차례로 기다려, DB가 느린 바로 그 순간 이메일까지 늦었다.
   *    채널 집계 순서(webhook → 앱 푸시 → email)는 그대로다 — 아래에서 셋을 다 기다린 뒤 차례로 넣는다.
   */
  const webhookSent = settleChannel("webhook", sendGuardianWebhook(user?.guardianWebhookUrl, payload, who, label));
  const emailSent = settleChannel("email", sendGuardianEmail(user?.guardianEmail, payload, who, label));

  // 4) 앱 푸시 — 환자와 연결된 보호자(전문가) 계정의 등록 휴대폰 + 토픽 사본(maeum_<보호자id>). 상세는 sendAppPush.
  let guardianIds: string[] = [];
  try {
    // 5초 상한(7차) — 넘기면 조회 실패. 이메일·메신저는 이 조회를 기다리지 않고 이미 출발했다(위 3)
    const links = await withinMs(prisma.expertPatient.findMany({
      where: { patientUserId: payload.userId, status: "active" },
      select: { expertUserId: true },
    }), TARGET_LOOKUP_TIMEOUT_MS);
    guardianIds = links.map((l) => l.expertUserId);
  } catch (e) {
    // 여기서 throw되면 **뒤에 오는 이메일 발송까지 통째로 날아간다**. 격리한다.
    //   "연결 보호자 없음"으로 삼키지 않는다(6차) — 운영자 경보(alertLinkLookupFailed) + 앵커 규칙(아래 6)
    linkLookupFailed = true;
    console.error("[emergency-notify] 보호자 연결 조회 실패 — FCM 건너뜀:", e instanceof Error ? e.message : e);
  }
  let appPushSent: Promise<AppPushOutcome> = Promise.resolve({
    channels: [], devices: 0, readyDevices: 0, deviceLookupFailed: false, devicePathTimedOut: null, deviceLookupMs: null,
    deviceTableMissing: false, tokenSendFailed: false, topicFailed: false, failures: [],
  });
  if (guardianIds.length > 0) {
    // 이번 알림을 묶는 id(두 경로 공통 tag). 메시지 id는 쓰지 않는다 — 같은 메시지로 L2·L3가 따로 나가면
    //   tag가 같아져 나중 알림이 앞 알림을 덮는다(더 위급한 쪽이 알림창에서 사라질 수 있다).
    const alertId = randomUUID();
    // 등록 휴대폰은 그 계정이 직접 등록했다 — 실명(모르면 "어르신": 호칭·"선생님"은 누군지 못 가린다). 실명 미사용(C2)이면 호칭
    const deviceWho = payload.realName === false ? payload.userName : realName || "어르신";
    appPushSent = sendAppPush(
      guardianIds,
      appPushPayload(payload, deviceWho, label, when, alertId),
      appPushPayload(payload, pushWho, label, when, alertId),
    );
  }

  // 5) 셋을 다 기다린 뒤 예전과 같은 순서로 집계한다(webhook → 앱 푸시 → email)
  const [webhook, appPush, email] = await Promise.all([webhookSent, appPushSent, emailSent]);
  if (webhook === "ok") channels.push("webhook");
  channels.push(...appPush.channels);
  if (email === "ok") channels.push("email");

  const confirmed = channels.some((c) => CONFIRMED_CHANNELS.has(c));
  /**
   * 발송 실패(2026-10-07 4·5·6차) — 주소·대상이 있는데 못 보낸 경로.
   *   · sendFailed = **일시 실패만**(메신저·이메일 "failed", 등록 휴대폰·토픽 일시 발송 실패) — 이게 있으면 dedup 앵커를 걸지 않는다
   *     (아래 6, 60초 바닥만 — 10차부터 받은 곳이 확인됐어도). 받은 곳이 확인됐으면 "일부 경로 일시 실패" 경보(아래 7, 10차).
   *   · 영구 실패(메신저·이메일 "failed-permanent"·"blocked", 앱 푸시의 "영구 실패" 항목 — 없는 기기·서버 자격증명·권한 등)는 앵커를
   *     막지 않는다 — 다시 보내도 같다. 경보에는 늘 싣는다(아래 7).
   *   failures는 그 경보에 싣는 경로 이름(+ FCM 오류 코드, 영구 실패 표시)이다 — 이름·주소·토큰은 싣지 않는다.
   */
  const sendFailed = webhook === "failed" || email === "failed" || appPush.tokenSendFailed || appPush.topicFailed;
  const failures = [...contactFailures("webhook", webhook), ...appPush.failures, ...contactFailures("email", email)];
  /**
   * 다시 보내면 달라질 수 있나(2026-10-07 7차에 이름을 붙였다 — 아래 두 앵커 규칙이 같은 판단을 쓴다): 일시 발송 실패(sendFailed)나
   *   조회 실패(등록 휴대폰 — DB·시간 상한, 보호자 연락처·연결 — DB·5초 상한)가 있으면 그렇다. 영구 실패만 있으면 아니다.
   *   중복 확인 조회 실패(dedupLookupFailed, 8차)는 **넣지 않는다** — 그 실패로 빠진 사본이 없다: 발송은 이미 fail-open으로 모든 경로에
   *   나갔고, 다시 보내도 전달 결과가 달라지지 않는다(앵커를 막으면 같은 응급이 다시 감지될 때마다(60초 뒤부터) 한 번 더 갈 뿐이다).
   *   운영자 경보는 늘 간다.
   */
  const retryMayHelp = sendFailed || appPush.deviceLookupFailed || contactLookupFailed || linkLookupFailed;
  /** 운영자 경보에 싣는 조회 실패(늘 따로 — alertLookupProblems) */
  const lookups: LookupFailures = { dedup: dedupLookupFailed, contact: contactLookupFailed, link: linkLookupFailed };

  // 6) 발송 시각 마킹 (어느 채널이든 1건 이상 성공 시)
  if (channels.length > 0) {
    /**
     * dedup 앵커 — 무언가 **일시적으로 실패**했으면 **걸지 않는다**: 등록 휴대폰을 못 읽었거나(DB·시간 상한), 보호자 연락처·연결을
     *   못 읽었거나(DB)(2026-10-07·6차), 어느 경로가 일시 발송 실패했으면(4차). 빠진 사본(실명 알림·이메일·메신저·다른 보호자의 토픽
     *   사본)이 있는 발송으로 1시간을 막으면, 장애가 지나간 뒤에도 그 응급은 그 채널로 끝내 가지 않는다. 짧은 재시도 바닥만 남기고
     *   notifiedAt도 쓰지 않는다 — 같은 응급이 다시 감지되면(60초 뒤부터) 다시 간다(재시도 큐는 없다). 실패 없이 토픽·꺼진
     *   휴대폰뿐이면 예전처럼 건다(받는 사람을 모를 뿐 실패는
     *   아니다). 영구 실패뿐이어도 건다(5·6차 — 다시 보내도 같은 결과다. 경보는 간다).
     *   (2026-10-08 10차) **받은 곳이 확인됐어도** 같다 — 예전엔 누군가(이메일·알림 허용 휴대폰·메신저) 받았으면 1시간을 걸어, 일시
     *   오류로 빠진 다른 사본의 받는 사람(다른 보호자의 토픽 사본·실명 사본 등)에게는 그 응급이 끝내 다시 가지 않았다. 이제 60초 바닥만
     *   — 이미 받은 곳은 다음 발송에서 한 번 더 받는다(새 alertId라 알림이 하나 더 뜬다. 조용함보다 중복). 경보는 아래 7.
     */
    const anchor = !retryMayHelp;
    // DB 마킹과 **별개로** 메모리 앵커를 남긴다 — 마킹이 실패해도 폭주 상한은 살아 있어야 한다.
    markSent(fanoutKey, anchor);
    /**
     * notifiedAt 기록 — 시작만 하고 **운영자 경보를 먼저 보낸다**(2026-10-07 7차). 기록은 5초 상한(MARK_NOTIFIED_TIMEOUT_MS)이고
     *   실패·시간 초과는 로그만 남긴다 — 이미 성공한 발송을 실패로 둔갑시키지 않는다(DB dedup이 안 걸려 같은 응급이 다시 감지되면
     *   한 번 더 갈 수 있는데, 누락보다 낫다. 폭주는 위 메모리 앵커가 막는다). 예전엔 이 쓰기를 기다린 뒤에 경보를 보내, DB가 멈추면 그 응급의
     *   경보(조회 실패·발송 실패)까지 멈췄다. 끝에서 기다린다(after() 안에서 끝나게 — 부유 프라미스 금지).
     */
    let marking: Promise<void> = Promise.resolve();
    if (!anchor) {
      console.error("[emergency-notify] 조회 실패(등록 휴대폰·보호자 연락처·연결) 또는 일시 발송 실패 — 받은 곳이 있어도 dedup 기록 없이 끝낸다(같은 응급이 다시 감지되면 60초 뒤부터 다시 보낸다)");
    } else if (payload.messageId) {
      marking = withinMs(prisma.message.update({
        where: { id: payload.messageId },
        data: { notifiedAt: new Date() },
      }), MARK_NOTIFIED_TIMEOUT_MS).then(() => undefined, (e: unknown) => {
        console.error("[emergency-notify] notifiedAt 마킹 실패(발송은 성공):", e instanceof Error ? e.message : e);
      });
    } else {
      console.warn("[emergency-notify] messageId 없음 — 발송은 했으나 dedup 기록 불가(저장 실패 턴)");
    }
    /**
     * 7) 운영자 경보 — 메모리 앵커를 **남긴 뒤에** 보낸다(2026-10-07 4차). 경보 메일(한 통 최대 35초 — alerts OPS_ALERT_TIMEOUT_MS,
     *    8차)이 멈추거나 실패해도 폭주 상한은 이미 걸렸다 — 예전엔 조회 실패 경보를 먼저 기다려, 그 사이 같은 응급이 다시 들어오면 또 나갔다.
     *    notifiedAt 기록은 기다리지 않는다(7차 — 위).
     *    받은 곳이 확인되지 않았으면: 발송 실패(일시·영구)가 섞였으면 늘 alertSendFailed, 아니면(토픽·꺼진 휴대폰뿐) Play 배포
     *    스위치를 켠 뒤(1.2.0 프로덕션 단계적 출시가 100%가 된 뒤)에만 alertUnconfirmedDelivery — 같은 응급에 비슷한 경보 두 통을 보내지 않는다.
     *    받은 곳이 확인됐어도 일시 발송 실패가 섞였으면 alertTransientFailures(10차 — 앵커 없이 다시 보낸다는 것과 실패 경로, 영구 실패도
     *    함께), 영구 실패만 섞였으면 alertPermanentFailures(7차 — 다시 보내도 같은 고장은 고칠 사람에게 늘 알린다).
     *    (2026-10-08 11차) 앵커를 실제로 걸었는지(anchor)를 영구 실패 경보에도 넘긴다 — 영구 실패는 앵커를 막지 않지만, 같은 응급의 조회
     *    실패·등록 휴대폰 경로 시간 초과는 막는다. 예전엔 그 경보가 늘 "중복 방지 기록은 남겼습니다"라, 함께 간 조회 실패 경보("남기지
     *    않았습니다")와 엇갈렸다(실제로는 같은 응급이 다시 감지되면 60초 뒤부터 다시 갔다). (12차) 조회 실패 경보에도 넘긴다 — 중복 확인 조회 실패 경보가 앵커 결과를 적는다.
     */
    await alertLookupProblems(payload, channels, confirmed, appPush, lookups, anchor);
    if (!confirmed && failures.length > 0) await alertSendFailed(payload, channels, failures, appPush, anchor);
    else if (confirmed && sendFailed) await alertTransientFailures(payload, channels, failures, appPush);
    else if (confirmed && failures.some(isPermanentFailure)) await alertPermanentFailures(payload, channels, failures, appPush, anchor);
    else if (!confirmed && PUSH_TOKENS_LIVE) await alertUnconfirmedDelivery(payload, channels, appPush);
    await marking;
    return { sent: true, channels };
  }
  // 전 채널 실패/미설정 — 사유를 남겨 호출부 로그('skipped: undefined')가 원인 불명이 되지 않게
  const hadTargets = Boolean(user?.guardianWebhookUrl) || guardianIds.length > 0 || Boolean(user?.guardianEmail);
  // ⚠ 조회가 실패한 경우를 "보호자 미연결"로 적으면 **운영자가 원인을 영원히 못 찾는다**.
  //   대상이 없는 것과 대상을 못 읽은 것은 조치가 완전히 다르다(전자는 설정, 후자는 장애).
  /**
   * 전 채널 실패 — 기본은 **짧은 재시도 바닥**만 남긴다(성공 창을 쓰면 안 된다).
   *   아무것도 전달되지 않았는데 1시간을 막으면 일시 장애가 지나간 뒤에도 그 응급이
   *   영영 전달되지 않는다(위음성). 반대로 바닥이 없으면 SMTP 거절 같은 실패를 같은 응급이
   *   다시 감지될 때마다 재시도하며 공용 Gmail 쿼터를 태운다. 바닥이 지나도 저절로 다시 보내지는 않는다 — 같은 응급이 다시
   *   감지되면(60초 뒤부터) 다시 간다.
   *   (7차) 실패가 **모두 영구 실패**면(일시 실패·조회 실패 없음 — retryMayHelp) 1시간 창을 건다: 다시 보내도 같은 결과인데 다시
   *   감지될 때마다(60초 뒤부터) 같은 고장으로 다시 돌며 로그·경보 시도만 쌓이지 않게(고칠 사람은 운영자다 — 경보는 아래에서 간다). notifiedAt은 쓰지 않는다
   *   — 보호자에게 아무것도 닿지 않았으니 하루 점검(scripts/pilot-daily-check.ts — notifiedAt IS NULL)이 그대로 잡아야 한다.
   *   보낼 곳이 없는 경우(실패 0건 — 대상 없음)와 일시 실패·조회 실패가 있는 경우는 예전대로 60초 바닥.
   */
  const onlyPermanent = failures.length > 0 && !retryMayHelp;
  markSent(fanoutKey, onlyPermanent);

  const lookupFailed = contactLookupFailed || linkLookupFailed;   // 조회 실패와 "대상 없음"을 가른다(연락처·연결 어느 쪽이든)
  const noTargets = !lookupFailed && !hadTargets;   // 설정 문제(보호자 미연결·연락처 미등록) — 장애가 아니다
  const reason = lookupFailed && !hadTargets
    ? "보호자 조회 실패 — 발송 대상 확인 불가(DB 장애 의심)"
    : hadTargets ? "모든 채널 발송 실패(위 warn 로그 참조)" : "알림 대상 없음(보호자 미연결·webhook/email 미등록)";
  if (lookupFailed && !hadTargets) {
    console.error("[emergency-notify] 발송 0건 — 보호자 조회 실패로 대상 확인 불가(DB 장애 의심)");
  }

  // 조회 쪽 장애 경보는 전 채널 실패 경보보다 먼저, 따로 — 전 채널 실패 경보 속에 DB 장애라는 사실이 묻히지 않게
  //   (12차) 앵커 결과(onlyPermanent)와 "대상 없음"도 넘긴다 — 중복 확인 조회 실패 경보가 이 경보와 같은 결과를 적는다
  await alertLookupProblems(payload, channels, confirmed, appPush, lookups, onlyPermanent, noTargets);
  /**
   * 운영자 경보 — 보호자에게 한 건도 못 보낸 응급을 **사람에게 알리는 마지막 경로**.
   *
   * 결함(2026-10-02 적대 리뷰): 여기서 sent:false를 돌려줘도 호출부 5곳이 전부 console.warn으로
   *   끝냈고, 영속 기록도 통보도 없었다. 유일한 사후 탐지인 scripts/pilot-daily-check.ts는
   *   `Message.notifiedAt IS NULL`을 보는데, **알림이 실패하는 전형적 상황(RDS 장애)에서는
   *   Message 행 자체가 안 만들어진다.** 탐지 사각이 이중으로 겹쳐 "그날 응급 0건"으로 보였다.
   *   이 경로는 SMTP만 쓰므로 RDS가 죽어도 닿는다. env OPS_ALERT_EMAIL 미설정이면 조용히 skip.
   *   발송 실패 경로(4차 — 5차부터 영구 실패 포함)도 여기에 함께 싣는다 — 이 응급에 "위급 알림 발송 실패" 경보를 따로 보내지
   *   않는다(비슷한 경보 두 통 금지).
   *   제목(5차): 레벨·분류·어르신 userId — sendOpsAlert는 같은 제목을 1시간에 한 번으로 묶는다. 예전 제목(레벨·분류만)은 같은
   *   시간대 **다른 어르신**의 같은 분류 실패를 삼켰다. "알림 대상 없음"(설정 문제)은 제목을 따로 둔다 — 같은 제목이면 연결·연락처
   *   설정 전의 응급이 그 어르신의 1시간 창을 차지해, 그 사이 진짜 발송 실패 경보가 억제된다.
   *   보호자 연결 조회가 실패했으면 그렇다고 적는다(6차) — 이메일이 일시 실패한 사유("모든 채널 발송 실패")만 보이면 앱 알림이
   *   대상을 몰라 아예 나가지 않았다는 사실이 이 경보에서 빠진다(따로 가는 연결 조회 실패 경보와 같은 사실).
   *   앵커 결과(2026-10-08 12차): 영구 실패뿐이면 1시간 창, 일시 실패·조회 실패가 있으면 60초 바닥(NOT_ANCHORED_LINE — 다시 보내는 것은
   *   같은 응급이 다시 감지될 때뿐이다). 예전엔 1시간 창일 때만 적어, 운영자가 다시 가는지·언제 가는지 알 수 없었다. 보낼 곳이 없는
   *   "응급 알림 대상 없음"(설정 문제)은 적지 않는다 — 다시 감지돼도 보낼 곳이 없다.
   *   ⚠ 부유 프라미스 금지 — 호출부가 after()로 감싸 실행을 보장하는 블록 안에서 await한다.
   */
  await sendOpsAlert(
    `${noTargets ? "응급 알림 대상 없음" : "응급 알림 실패"} L${payload.level} ${payload.category} ${payload.userId}`,
    [
      `사유: ${reason}`,
      ...(failures.length > 0 ? [`실패한 경로: ${failures.join(", ")}`] : []),
      ...(linkLookupFailed ? ["보호자 연결 조회 실패(DB) — 연결 보호자 앱 알림(등록 휴대폰·토픽 사본)은 보낼 계정을 몰라 보내지 못했습니다."] : []),
      `레벨: L${payload.level} / 분류: ${payload.category}`,
      `대상 userId: ${payload.userId}`,
      `메시지 기록: ${payload.messageId ? payload.messageId : "없음(저장 실패 또는 안전망 경로)"}`,
      `발생 시각: ${payload.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}`,
      "",
      "보호자에게 한 건도 전달되지 않았습니다. 수동 확인이 필요합니다.",
      ...(onlyPermanent
        ? ["실패가 모두 영구 실패라(다시 보내도 같다) 같은 응급을 1시간 동안 다시 보내지 않습니다 — 고친 뒤에도 이 응급은 자동으로 다시 가지 않으니 보호자에게 직접 연락해 주세요."]
        : noTargets ? [] : [NOT_ANCHORED_LINE]),
      ...permanentNote(failures),
    ],
  ).catch(() => false);   // 경보 실패가 호출부를 무너뜨리지 않게

  return { sent: false, channels, reason };
}
