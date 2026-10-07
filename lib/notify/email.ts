/**
 * 위급 알림 이메일 발송 — Gmail SMTP(nodemailer).
 *
 * env: GMAIL_USER(보내는 Gmail 주소) + GMAIL_APP_PASSWORD(앱 비밀번호, 공백 자동 제거).
 *   미설정 시 graceful skip. 수신자는 보호자 이메일(동적).
 *   ⚠️ 앱 비밀번호는 절대 코드/깃에 두지 말 것 — env로만. 노출 시 Google 계정에서 재발급.
 */
import nodemailer from "nodemailer";

let transporter: nodemailer.Transporter | null | undefined;
function getTransporter(): nodemailer.Transporter | null {
  if (transporter !== undefined) return transporter;
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, ""); // "abcd efgh ..." → 공백 제거
  if (!user || !pass) {
    // 결과를 캐시하므로 인스턴스당 한 번만 찍힌다(2026-10-07 5차 — 예전엔 아무 흔적 없이 건너뛰어, 보호자 이메일이 통째로
    //   꺼져 있어도 몰랐다. 설정 문제라 위급 알림에선 발송 실패로 세지 않는다 — lib/chat/emergency-notify sendGuardianEmail)
    console.error("[email] 🔴 Gmail SMTP 자격증명 없음(GMAIL_USER·GMAIL_APP_PASSWORD) — 보호자 위급 이메일·운영 경보가 나가지 않는다");
    transporter = null;
    return null;
  }
  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
    /**
     * ⚠ 타임아웃을 명시한다 (2026-10-02 AWS 이전 감사 #20).
     *
     * nodemailer 기본값은 socketTimeout ~10분이다. 응급 알림은 `after()` 안에서 돌고,
     * self-host(ECS)에서는 SIGTERM 뒤 `stopTimeout`(기본 30초)이 지나면 SIGKILL이다.
     * 멈춘 SMTP 하나가 10분을 붙들면:
     *   · 배포·스케일인 때마다 그 알림이 **중간에 잘려 유실**되고
     *   · 순차 팬아웃이라 **뒤에 오는 채널(이메일 다음 단계)까지** 실행되지 않는다
     * Vercel에서는 waitUntil이 함수 수명을 늘려 가려져 있었다.
     *
     * 합계가 stopTimeout 안에 들어오도록 잡는다(연결 8 + 인사 8 + 소켓 15 ≈ 최악 31초).
     * 런북에서 ECS stopTimeout을 60초 이상으로 올리는 것과 짝이다 — 둘 중 하나만으로는 부족하다.
     */
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 15_000,
  });
  return transporter;
}

export interface EmergencyEmailPayload {
  userName: string;
  level: 2 | 3;
  category: string;
  createdAt: Date;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * 보내는 Gmail(SMTP) 자격증명이 설정돼 있나 — 없으면 인스턴스당 한 번 크게 로그(getTransporter).
 *   위급 알림은 이걸 먼저 보고 "설정 문제"와 "발송 실패"를 가른다(2026-10-07 5차, lib/chat/emergency-notify sendGuardianEmail).
 */
export function isEmailConfigured(): boolean {
  return getTransporter() !== null;
}

/** 받는 주소 형식 검사 — 발송(sendEmergencyEmail)과 같은 규칙. 틀린 주소는 다시 보내도 같다(위급 알림의 영구 실패) */
export function isValidEmailAddress(to: string): boolean {
  return EMAIL_RE.test(to);
}

/**
 * 위급 메일 한 통의 결과(2026-10-07 6차) — 위급 알림(lib/chat/emergency-notify sendGuardianEmail)이 다시 보낼지 가른다:
 *   "ok" · "transient"(다시 보내면 될 수 있다 — dedup 앵커를 막는다, 2026-10-08 10차부터 다른 경로에서 받은 곳이 확인됐어도) ·
 *   "permanent"(다시 보내도 같다 — 운영자 경보에만 싣는다). 예전엔 true/false뿐이라 앱 비밀번호가 틀린 것(고칠 때까지 계속 실패)도
 *   60초마다 다시 보냈다.
 */
export type EmailSendResult = "ok" | "transient" | "permanent";

/**
 * nodemailer 오류 → 다시 보내면 될 수 있나(6차).
 *   · SMTP 응답 코드가 있으면 그것을 따른다 — 5xx는 영구(주소 거절·인증 거절 535·534·일일 발송 한도 550 5.4.5 등 — 60초 뒤에도
 *     같다), 4xx는 일시(421·450·451·452·454 — 서버가 "잠시 뒤 다시"라고 한 것. 인증 오류(EAUTH)여도 454 "잠시 뒤 다시"는 일시다).
 *   · 응답 코드가 없으면 nodemailer 오류 코드로: EAUTH(자격증명 거절·누락)는 영구, 연결·시간 초과·소켓·DNS(ECONNECTION·ETIMEDOUT·
 *     ESOCKET·EDNS)는 일시.
 *   · 모르는 오류는 일시 — 다시 보내 본다(조용함보다 중복).
 */
function smtpFailureKind({ code, responseCode }: SmtpError): "transient" | "permanent" {
  if (typeof responseCode === "number" && responseCode >= 400 && responseCode < 600) return responseCode >= 500 ? "permanent" : "transient";
  return code === "EAUTH" ? "permanent" : "transient";
}

/** nodemailer 오류에서 보는 값 — code(EAUTH·ECONNECTION…)·responseCode(SMTP 응답 코드)·command(실패한 SMTP 명령 이름) */
type SmtpError = { code?: unknown; responseCode?: unknown; command?: unknown };

/**
 * SMTP 실패 로그에 싣는 값 — code·responseCode·command **만**(2026-10-07 7차).
 *   err.message·err.response는 싣지 않는다 — nodemailer는 서버의 거절 응답을 메시지에 붙이고("550 5.1.1 <g@…>: Recipient address
 *   rejected"·"Invalid recipient \"g@…\""), 거기에 보호자 이메일 주소가 그대로 들어 있다. 예전엔 그 메시지를 찍어 보호자 주소가
 *   서버 로그(호스팅 로그 보관·전달)에 남았다. command는 명령 이름뿐이다("RCPT TO"·"AUTH PLAIN" — nodemailer _formatError가
 *   주소 인자를 붙이지 않는다). 분류(영구·일시)에 쓰는 값과 같아 원인 파악에는 이것으로 충분하다.
 */
function smtpLogFields(e: unknown): { code: unknown; responseCode: unknown; command: unknown } {
  const err: SmtpError = typeof e === "object" && e !== null ? e : {};
  return { code: err.code, responseCode: err.responseCode, command: err.command };
}

export async function sendEmergencyEmail(to: string, p: EmergencyEmailPayload): Promise<EmailSendResult> {
  const t = getTransporter();
  // 자격증명이 없거나 받는 주소가 틀렸으면 다시 보내도 같다(영구) — 위급 알림은 이 둘을 먼저 걸러 부른다(sendGuardianEmail).
  //   형식 검사는 복호 실패 시 enc:… 값이 수신자로 가는 것을 막는다
  if (!t || !to || !EMAIL_RE.test(to)) return "permanent";

  const from = `마음이음 <${process.env.GMAIL_USER}>`;
  const urgent = p.level === 3;
  const when = p.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const subject = `${urgent ? "🚨 즉시 응급" : "⚠️ 주의"} [마음이음] ${p.userName}님 위급 신호`;
  // ⚠ 이름은 사용자가 정하는 자유 입력이다 — HTML에 넣는 모든 자리에서 이스케이프한다(2026-10-07 재검토:
  //   여기만 빠져 있어, 이름에 링크 태그를 넣으면 공식 발송 계정 메일에 임의 링크가 실렸다)
  const action = urgent
    ? `지금 바로 ${esc(p.userName)}님께 연락하시거나 119에 신고해주세요.`
    : `시간 되실 때 ${esc(p.userName)}님 안부를 확인해주세요.`;
  const accent = urgent ? "#E2547B" : "#E8920C";
  const html = `
  <div style="font-family:'Malgun Gothic',Apple SD Gothic Neo,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#211B2E">
    <div style="background:${accent};color:#fff;border-radius:14px 14px 0 0;padding:16px 20px;font-size:18px;font-weight:bold">
      ${urgent ? "🚨 즉시 응급 신호" : "⚠️ 주의 신호"}
    </div>
    <div style="border:1px solid #DDD9E6;border-top:none;border-radius:0 0 14px 14px;padding:20px">
      <p style="font-size:16px;margin:0 0 12px"><b>${esc(p.userName)}</b>님에게서 위급 신호가 감지되었습니다.</p>
      <table style="font-size:14px;color:#4b4b5a;border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#6B7280">종류</td><td>${esc(p.category)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#6B7280">시각</td><td>${when}</td></tr>
      </table>
      <p style="margin:16px 0 0;padding:12px 14px;background:#FBEAEF;border-radius:10px;font-size:15px;font-weight:600;color:${accent}">
        👉 ${action}
      </p>
      <p style="margin:16px 0 0;font-size:12px;color:#9C93B0">마음이음 · 이 메일은 보호자 알림용으로 자동 발송되었습니다.</p>
    </div>
  </div>`;

  try {
    await t.sendMail({ from, to, subject, html });
    return "ok";
  } catch (e) {
    const err: SmtpError = typeof e === "object" && e !== null ? e : {};
    const kind = smtpFailureKind(err);
    // 메시지는 찍지 않는다 — 받는 사람(보호자) 주소가 들어 있다(smtpLogFields)
    console.warn(`[email] Gmail 발송 실패(${kind === "permanent" ? "영구" : "일시"}):`, smtpLogFields(e));
    return kind;
  }
}

/**
 * 운영자 경보 — **모든 보호자 채널이 실패했을 때**의 마지막 통보.
 *
 * 왜 필요한가 (2026-10-02 적대 리뷰): notifyGuardian이 sent:false를 돌려줘도 호출부 5곳이
 *   전부 console.warn으로 끝냈다. 영속 기록도, 사람에게 닿는 경로도 없었다.
 *   유일한 사후 탐지인 scripts/pilot-daily-check.ts는 `Message.notifiedAt IS NULL`을 보는데,
 *   **알림이 실패하는 전형적 상황(RDS 장애)에서는 Message 행 자체가 안 만들어진다.**
 *   즉 가장 위험한 순간의 사건이 하루 한 번 점검에도 안 잡혀 "그날 응급 0건"으로 보였다 —
 *   탐지 사각이 이중으로 겹친 상태였다.
 *
 * 이 경로는 **DB를 쓰지 않는다**(SMTP만). 그래서 RDS가 죽어도 사람에게 닿는다.
 * env OPS_ALERT_EMAIL 미설정이면 조용히 skip — 기능을 막지는 않는다.
 *
 * 쓰로틀 — 같은 사유의 경보를 창(window)당 1회로 묶는다.
 *
 * ⚠ 2026-10-02 적대 리뷰가 잡은 **내가 만든 결함**: 이 함수에 dedup이 전혀 없었다.
 *   RDS 장애처럼 "모든 보호자 채널이 실패"가 지속되는 상황에서는 응급 턴마다 경보가 나가고,
 *   **보호자 알림과 같은 Gmail 계정을 쓰므로**(GMAIL_USER 공유) 일일 발신 한도를 스스로 태운다.
 *   그러면 정작 복구된 뒤에 가야 할 **보호자 이메일이 못 나간다** —
 *   운영자에게 알리려다 환자의 알림 채널을 죽이는, 어제 emergency-notify에서 고친 것과 같은 유형이다.
 *
 * 설계: 프로세스 메모리이므로 멀티 인스턴스에서는 N배까지 샐 수 있다(ECS 태스크 수만큼).
 *   그래도 "무제한"과 "인스턴스당 시간당 1건"은 자릿수가 다르다. 완전한 해법은 Redis 공유 카운터이고,
 *   그건 Upstash가 이미 있으니 AWS 이전 때 함께 옮기는 게 맞다(지금은 과한 결합).
 *
 * 1시간 창은 **보낸 경보에만** 건다(2026-10-07 9차). 예전엔 보내기 전에 1시간 기록을 남겨, 메일이 실패하거나 호출부의 상한(위급 알림
 *   35초 — lib/chat/emergency-notify-alerts OPS_ALERT_TIMEOUT_MS)이 먼저 끝나 아무것도 나가지 않았어도 같은 사유의 경보가 1시간 동안
 *   막혔다 — 장애를 알려야 할 바로 그때 운영자는 아무것도 받지 못했다. 보내는 동안과 실패한 뒤에는 짧은 바닥(OPS_ALERT_RETRY_FLOOR_MS)만 둔다.
 */
const OPS_ALERT_WINDOW_MS = 60 * 60 * 1000;   // 1시간 — sendMail이 성공한 경보만
/**
 * 보내는 중·보내지 못한 경보의 재시도 바닥(9차) — 같은 사유가 동시에 몰려도 한 통만 보내고, Gmail 장애 동안 응급 턴마다 다시 보내며
 *   일일 발신 한도(보호자 위급 이메일과 같은 계정)를 태우지 않을 만큼. 실패했으면 실패한 시각부터 잰다 — 느린 실패(SMTP 상한 ~31초)
 *   뒤에도 바로 다시 보내지 않게.
 */
const OPS_ALERT_RETRY_FLOOR_MS = 60 * 1000;
/** subject → { 기록 시각, 막는 길이(보냄 1시간 · 보내는 중·실패 60초), 그 뒤 억제된 건수 } */
const opsAlertSent = new Map<string, { at: number; windowMs: number; suppressed: number }>();

export async function sendOpsAlert(subject: string, lines: string[]): Promise<boolean> {
  // 받는 곳: OPS_ALERT_EMAIL → 없으면 **보내는 Gmail 계정 자신**(GMAIL_USER)의 받은편지함.
  //   2026-10-06: 운영 경보 전용 주소를 따로 두지 않는 운영이라, 예전처럼 "없으면 아무에게도 안 보냄"이면
  //   모든 보호자 채널이 실패한 응급을 아무도 모른다(사용자: "그 Gmail로 보내게 되어 있을 텐데").
  const to = (process.env.OPS_ALERT_EMAIL?.trim() || process.env.GMAIL_USER?.trim());
  const t = getTransporter();
  if (!t || !to || !EMAIL_RE.test(to)) return false;

  /**
   * 같은 사유(subject)는 창당 1회. 만료분은 같은 패스에서 정리한다(맵 무한 증가 방지).
   * ⚠ 키가 subject라 **다른 환자의 같은 유형 경보도 함께 억제된다.** 그래서 억제 건수를 세어
   *   다음 메일에 싣는다 — 운영자에게 필요한 건 개별 사건이 아니라 "장애가 났고 규모가 N건"이다.
   *   건수가 없으면 1건짜리 사고와 전면 장애가 똑같은 메일로 보인다.
   */
  const now = Date.now();
  // ⚠ prev를 **정리보다 먼저** 읽는다. 만료 정리가 이 subject의 항목을 지우면
  //   그 창에서 억제한 건수가 함께 사라져, 복구 후 첫 메일이 규모를 전하지 못한다
  //   (실제로 그렇게 짰다가 테스트가 잡았다).
  const prev = opsAlertSent.get(subject);
  for (const [k, v] of opsAlertSent) {
    if (k !== subject && now - v.at >= v.windowMs) opsAlertSent.delete(k);
  }
  if (prev && now - prev.at < prev.windowMs) {
    prev.suppressed++;
    console.warn(`[ops-alert] 억제(창 내 중복 ${prev.suppressed}건): ${subject}`);
    return false;
  }
  const suppressed = prev?.suppressed ?? 0;
  /**
   * 보내는 동안은 바닥(60초)만 — 1시간은 sendMail이 성공한 뒤에야 건다(9차). 호출부의 상한이 먼저 끝나도(메일은 뒤에서 이어질 수 있다)
   *   이 기록은 바닥 그대로라, 끝내 나가지 않은 메일이 1시간을 막지 않는다. 늦게라도 성공하면 그때 1시간이 된다(실제로 나갔다).
   *   기록을 갈아 끼우지 않고 이 항목을 고친다 — 그 사이 바닥이 지나 다음 시도가 새 항목을 넣었으면 이 항목은 맵에서 빠져 있어 그
   *   시도를 덮지 않는다.
   */
  const entry = { at: now, windowMs: OPS_ALERT_RETRY_FLOOR_MS, suppressed: 0 };
  opsAlertSent.set(subject, entry);
  const body = suppressed > 0
    ? [...lines, "", `※ 직전 창에서 같은 사유 ${suppressed}건이 추가로 발생해 메일은 억제되었습니다.`]
    : lines;

  try {
    await t.sendMail({
      from: `마음이음 운영 <${process.env.GMAIL_USER}>`,
      to,
      subject: `[마음이음 운영] ${subject}`,
      text: body.join("\n"),
      html: `<pre style="font:14px/1.6 ui-monospace,monospace">${body.map(esc).join("\n")}</pre>`,
    });
    entry.windowMs = OPS_ALERT_WINDOW_MS;
    return true;
  } catch (e) {
    // 실패 — 1시간 대신 바닥(60초)만, 실패한 시각부터. 이 메일에 실으려던 억제 건수는 전해지지 않았다 — 되돌려 다음 메일에 싣는다
    entry.at = Date.now();
    entry.suppressed += suppressed;
    // 여기서 throw하면 호출부(이미 실패 처리 중)가 또 무너진다. 메시지는 찍지 않는다 — 받는 주소가 들어 있다(smtpLogFields)
    console.error("[ops-alert] 발송 실패:", smtpLogFields(e));
    return false;
  }
}
