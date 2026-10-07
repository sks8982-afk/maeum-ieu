/**
 * Postgres 연결 TLS 정책 — 앱(lib/prisma.ts)과 운영 스크립트(scripts/ops-push-device.ts)가 **같은 함수**로 정한다(2026-10-07 7차).
 *   건강/인지 민감 데이터 경로의 중간자 공격 방지:
 *   · AWS RDS(*.rds.amazonaws.com)는 자체 CA로 서명 → 시스템 신뢰저장소에 없어 검증 실패. RDS CA 번들(lib/rds-ca)로 서버 인증서를
 *     검증한다(rejectUnauthorized: true).
 *     ⚠ 연결문자열에 sslmode가 있으면 node-postgres가 ssl.ca를 무시하므로, sslmode를 지우고 ssl 객체로 제어한다.
 *   · DATABASE_SSL_NO_VERIFY=1: 검증을 끄는 **유일한** 비상 탈출구(권장 안 함 — scripts/check-env.ts가 경고한다).
 *   · 그 밖(로컬 등): ssl 객체를 주지 않는다(연결문자열 그대로). URL로 읽을 수 없으면 손대지 않는다.
 *   왜 한 곳에: 운영 스크립트가 검증을 끈 채(sslmode=no-verify + rejectUnauthorized:false) 운영 RDS에 붙고 있었다 — 앱만 검증하고
 *   테이블을 만드는 스크립트는 중간자에게 열려 있었다. 정책이 두 군데 있으면 또 갈린다.
 */
import { RDS_CA } from "./rds-ca";

export interface PgTlsOptions {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean; ca?: string };
}

export function pgTlsOptions(
  rawConnectionString: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PgTlsOptions {
  const noVerify = env.DATABASE_SSL_NO_VERIFY === "1";
  const isRds = /\.rds\.amazonaws\.com/i.test(rawConnectionString);
  try {
    const url = new URL(rawConnectionString);
    if (noVerify) {
      url.searchParams.set("sslmode", "no-verify");
      return { connectionString: url.toString(), ssl: { rejectUnauthorized: false } };
    }
    if (isRds) {
      url.searchParams.delete("sslmode"); // sslmode가 남아있으면 ca가 무시됨 → 제거 후 ssl 객체로 검증
      return { connectionString: url.toString(), ssl: { ca: RDS_CA, rejectUnauthorized: true } };
    }
    return { connectionString: url.toString() };
  } catch {
    // URL 파싱 실패 시 그대로 사용(로컬 등)
    return { connectionString: rawConnectionString };
  }
}
