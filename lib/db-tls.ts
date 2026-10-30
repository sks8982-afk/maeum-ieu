/**
 * Postgres 연결 TLS 정책 — 앱(lib/prisma.ts)과 운영 스크립트(scripts/ops-push-device.ts)가 **같은 함수**로 정한다(2026-10-07 7차).
 *   건강/인지 민감 데이터 경로의 중간자 공격 방지:
 *   · AWS RDS(*.rds.amazonaws.com)는 자체 CA로 서명 → 시스템 신뢰저장소에 없어 검증 실패. RDS CA 번들(lib/rds-ca)로 서버 인증서를
 *     검증한다(rejectUnauthorized: true).
 *   · 그 밖의 원격 서버(2026-10-19 RDS에서 옮긴 회사 자체 DB 서버)는 회사 CA(lib/onprem-db-ca)로 같은 방식으로 검증한다.
 *     주소 목록을 두지 않는다 — 공개 저장소에 서버 주소를 적지 않고, 모르는 서버면 검증에 실패해 붙지 않는다(평문·무검증으로 새지 않는다).
 *     IP로 붙으면 그 IP를 host로 넘긴다 — node-postgres는 IP 주소면 servername을 비워 두고, 그러면 Node가 'localhost'로 확인해 실패한다.
 *     DATABASE_TLS_NAME(2026-10-30 AWS 이전): IP로 붙는데 그 주소가 인증서에 없을 때(같은 VPC 안 사설 주소) 인증서에 있는 이름을 따로 준다.
 *     검증은 그대로다 — 회사 CA가 서명했고 그 이름이 든 인증서만 통과한다. 이름으로 붙을 때는 쓰이지 않는다(pg가 servername을 덮는다).
 *     ⚠ node-postgres는 연결문자열을 풀어 ssl 객체 **위에** 덮는다(pg/lib/connection-parameters). 그래서 검증하는 길에서는 TLS를 바꾸는
 *     파라미터(sslmode·ssl·sslcert·sslkey·sslrootcert·uselibpqcompat)를 모두 지우고 ssl 객체로만 제어한다 — 하나라도 남으면 ca가 무시되거나
 *     ssl=0(평문)·ssl=no-verify(무검증)로 조용히 바뀐다. 자체 DB 쪽에선 ?host=도 지운다(접속 대상과 인증서 확인 대상이 갈라진다).
 *   · DATABASE_SSL_NO_VERIFY=1: 검증을 끄는 **유일한** 비상 탈출구(권장 안 함 — scripts/check-env.ts가 경고한다).
 *   · 이 컴퓨터(localhost·127.x·::1)와 점 없는 이름(docker 서비스명·소켓): ssl 객체를 주지 않는다(연결문자열 그대로).
 *     URL로 읽을 수 없으면 손대지 않는다.
 *   왜 한 곳에: 운영 스크립트가 검증을 끈 채(sslmode=no-verify + rejectUnauthorized:false) 운영 RDS에 붙고 있었다 — 앱만 검증하고
 *   테이블을 만드는 스크립트는 중간자에게 열려 있었다. 정책이 두 군데 있으면 또 갈린다.
 */
import { RDS_CA } from "./rds-ca";
import { ONPREM_DB_CA } from "./onprem-db-ca";

export interface PgTlsOptions {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean; ca?: string; host?: string };
}

/** node-postgres가 연결문자열에서 읽어 ssl 설정을 바꾸는 파라미터 — 검증하는 길에서는 모두 지운다. */
const TLS_URL_PARAMS = ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"] as const;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 이 컴퓨터 안의 DB(로컬 개발·docker 서비스명·소켓) — TLS 정책을 걸지 않는다. */
function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127\./.test(host) || !host.includes(".");
}

function stripTlsParams(url: URL): void {
  for (const k of TLS_URL_PARAMS) url.searchParams.delete(k);
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
      stripTlsParams(url); // 남아있으면 ca가 무시되거나 검증이 바뀜 → 지우고 ssl 객체로 검증
      return { connectionString: url.toString(), ssl: { ca: RDS_CA, rejectUnauthorized: true } };
    }
    const host = url.hostname.toLowerCase();
    if (isLocalHost(host)) return { connectionString: url.toString() };
    stripTlsParams(url);
    url.searchParams.delete("host");
    const ssl = { ca: ONPREM_DB_CA, rejectUnauthorized: true };
    const certName = env.DATABASE_TLS_NAME?.trim().toLowerCase();
    return { connectionString: url.toString(), ssl: IPV4.test(host) ? { ...ssl, host: certName || host } : ssl };
  } catch {
    // URL 파싱 실패 시 그대로 사용(로컬 등)
    return { connectionString: rawConnectionString };
  }
}
