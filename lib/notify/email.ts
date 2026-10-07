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

export async function sendEmergencyEmail(to: string, p: EmergencyEmailPayload): Promise<boolean> {
  const t = getTransporter();
  if (!t || !to || !EMAIL_RE.test(to)) return false; // 복호 실패 시 enc:… 값이 수신자로 가는 것 방지

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
    return true;
  } catch (e) {
    console.warn("[email] Gmail 발송 실패:", (e as Error).message);
    return false;
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
 */
const OPS_ALERT_WINDOW_MS = 60 * 60 * 1000;   // 1시간
/** subject → { 마지막 발송 시각, 그 뒤 억제된 건수 } */
const opsAlertSent = new Map<string, { at: number; suppressed: number }>();

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
    if (k !== subject && now - v.at >= OPS_ALERT_WINDOW_MS) opsAlertSent.delete(k);
  }
  if (prev && now - prev.at < OPS_ALERT_WINDOW_MS) {
    prev.suppressed++;
    console.warn(`[ops-alert] 억제(창 내 중복 ${prev.suppressed}건): ${subject}`);
    return false;
  }
  const suppressed = prev?.suppressed ?? 0;
  opsAlertSent.set(subject, { at: now, suppressed: 0 });
  const body = suppressed > 0
    ? [...lines, "", `※ 직전 1시간 창에서 같은 사유 ${suppressed}건이 추가로 발생해 메일은 억제되었습니다.`]
    : lines;

  try {
    await t.sendMail({
      from: `마음이음 운영 <${process.env.GMAIL_USER}>`,
      to,
      subject: `[마음이음 운영] ${subject}`,
      text: body.join("\n"),
      html: `<pre style="font:14px/1.6 ui-monospace,monospace">${body.map(esc).join("\n")}</pre>`,
    });
    return true;
  } catch (e) {
    // 여기서 throw하면 호출부(이미 실패 처리 중)가 또 무너진다.
    console.error("[ops-alert] 발송 실패:", e instanceof Error ? e.message : e);
    return false;
  }
}
