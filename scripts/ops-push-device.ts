/**
 * 위급 알림 휴대폰 등록 테이블(push_device) 생성 + 개수 점검.
 * ⚠️ prisma db push 금지 — 수동 SQL. 멱등. 아무것도 지우지 않는다.
 *
 *   npx tsx scripts/ops-push-device.ts   → 테이블·인덱스 생성(멱등) + 개수 보고(휴대폰 수·계정 수만)
 *
 * ⚠ 배포 순서: 테이블 생성은 **코드 배포 전**에 한다. 테이블이 없으면 코드는 "등록된 휴대폰 없음"으로 보고
 *   등록 요청엔 503 notReady를 돌려준다(lib/push/devices.ts) — 그동안에도 토픽 사본은 그대로 나가므로
 *   위급 알림이 끊기지는 않는다. 앱은 로그인해 있는 동안 토픽 구독을 늘 유지한다(app/RnBridge 계약).
 *
 * 왜 이 테이블인가 (2026-10-07): FCM 토픽(maeum_<id>)은 구독 권한 검사가 없고(이름만 알면 누구든 받는다),
 *   서버는 토픽에 받는 기기가 있는지 모르며(구독자 0명이어도 발송 성공 — 앱에 로그인한 적 없는 보호자도 "알림 보냄"),
 *   넘겨받은 휴대폰이 이전 계정 구독을 계속 들고 있을 수 있다. 기기 토큰은 로그인한 세션만 자기 계정에 등록하고,
 *   서버가 계정별 휴대폰을 알며, 다른 계정이 같은 토큰을 등록하면 그 계정으로 옮겨 가고, 기기별 발송 오류로
 *   앱을 지운 휴대폰을 알아낸다. 상세는 lib/push/devices.ts.
 *
 * 보고는 개수만 찍는다 — 토큰·계정 id는 찍지 않는다(토큰은 그 휴대폰으로 알림을 보낼 수 있는 값이다).
 */
import "dotenv/config";
import { Pool } from "pg";
import { pgTlsOptions } from "../lib/db-tls";

async function main() {
  /**
   * TLS는 앱(lib/prisma.ts)과 **같은 정책**(lib/db-tls, 2026-10-07 7차) — RDS면 RDS CA로 서버 인증서를 검증하고
   *   (rejectUnauthorized: true), 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다. 예전엔 sslmode=no-verify + rejectUnauthorized:false로
   *   검증을 끈 채 운영 DB에 붙어, 이 스크립트만 중간자에게 열려 있었다.
   */
  const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL!);
  const pool = new Pool({ connectionString, ...(ssl ? { ssl } : {}) });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_device (
        token           TEXT PRIMARY KEY,                 -- FCM 등록 토큰(휴대폰 하나에 하나)
        user_id         TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,  -- 지금 로그인한 계정(옮겨 갈 수 있다)
        platform        TEXT NOT NULL DEFAULT 'android',
        app_version     TEXT,                             -- 앱이 보고한 버전(점검용)
        permission      TEXT NOT NULL DEFAULT 'unknown',  -- granted | denied | unknown
        channel_blocked BOOLEAN NOT NULL DEFAULT false,   -- 위급 알림 채널을 사용자가 껐는지
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT now() -- 마지막 확인(앱이 다시 보고한 시각)
      )`);
    // 위급 알림 발송·화면 표시가 계정으로 찾는다
    await client.query(`CREATE INDEX IF NOT EXISTS push_device_user_id_idx ON push_device (user_id)`);
    console.log("✓ push_device 테이블·인덱스 확인(멱등 생성)");

    const r = await client.query<{ devices: string; users: string }>(
      `SELECT count(*) AS devices, count(DISTINCT user_id) AS users FROM push_device`);
    console.log(`\n[등록 휴대폰] ${r.rows[0].devices}대 · 계정 ${r.rows[0].users}명`);
  } finally {
    client.release(); await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
