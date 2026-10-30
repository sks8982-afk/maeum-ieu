/**
 * Postgres TLS 정책(lib/db-tls) — 앱(lib/prisma.ts)과 운영 스크립트가 **같은 함수**로 정한다(2026-10-07 7차).
 *
 * 결함: scripts/ops-push-device.ts는 sslmode=no-verify + rejectUnauthorized:false로 **인증서 검증을 끈 채** 운영 RDS에 붙었다 —
 *   앱은 RDS CA로 검증하는데, 위급 알림 테이블을 만드는 스크립트만 중간자에게 열려 있었다. 정책을 한 함수로 모으고, 그 함수의
 *   규칙(RDS → CA 검증, DATABASE_SSL_NO_VERIFY=1만 예외)과 두 사용처를 고정한다. 스크립트는 실행하지 않는다(운영 DB).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { X509Certificate } from "node:crypto";
import { pgTlsOptions } from "@/lib/db-tls";
import { RDS_CA } from "@/lib/rds-ca";
import { ONPREM_DB_CA } from "@/lib/onprem-db-ca";

const RDS = "postgresql://app:pw@maeum.abc123.ap-northeast-2.rds.amazonaws.com:5432/maeum";

describe("pgTlsOptions — RDS는 CA로 검증, 검증 끄기는 DATABASE_SSL_NO_VERIFY=1뿐", () => {
  it("RDS — RDS CA로 서버 인증서를 검증하고(rejectUnauthorized: true), 연결문자열의 sslmode는 지운다(남으면 ca가 무시된다)", () => {
    const r = pgTlsOptions(`${RDS}?sslmode=require&application_name=x`, {});
    expect(r.ssl).toEqual({ ca: RDS_CA, rejectUnauthorized: true });
    // 🔒 sslmode가 남으면 node-postgres가 ssl.ca를 무시한다 — 검증이 조용히 빠진다
    expect(new URL(r.connectionString).searchParams.has("sslmode")).toBe(false);
    expect(new URL(r.connectionString).searchParams.get("application_name")).toBe("x");
  });

  it("DATABASE_SSL_NO_VERIFY=1만 검증을 끈다(비상 탈출구) — 정확히 '1'일 때만", () => {
    expect(pgTlsOptions(RDS, { DATABASE_SSL_NO_VERIFY: "1" })).toEqual({
      connectionString: `${RDS}?sslmode=no-verify`, ssl: { rejectUnauthorized: false },
    });
    // 🔒 "true"·"0" 같은 값으로 검증이 꺼지면 안 된다
    for (const v of ["true", "0", "", undefined]) {
      expect(pgTlsOptions(RDS, { DATABASE_SSL_NO_VERIFY: v }).ssl).toEqual({ ca: RDS_CA, rejectUnauthorized: true });
    }
  });

  it("RDS가 아니면(로컬) ssl 객체를 주지 않는다 · URL로 읽을 수 없으면 손대지 않는다", () => {
    expect(pgTlsOptions("postgresql://localhost:5432/maeumieu", {})).toEqual({ connectionString: "postgresql://localhost:5432/maeumieu" });
    expect(pgTlsOptions("not a url", {})).toEqual({ connectionString: "not a url" });
  });
});

/**
 * 자체 DB 서버(2026-10-19) — RDS에서 회사 자체 PostgreSQL로 옮긴다. 그 서버 인증서는 회사가 만든 인증기관(lib/onprem-db-ca)이 서명해
 *   시스템 신뢰저장소에 없다(RDS와 같은 사정). 그래서 RDS처럼 CA를 코드에 두고 검증한다 — 검증을 끄는(NO_VERIFY) 쪽으로 가지 않는다.
 *   주소 목록은 두지 않는다(공개 저장소에 서버 주소를 적지 않는다): RDS가 아니고 이 컴퓨터(localhost)도 아니면 자체 CA로 검증한다.
 *   모르는 서버면 검증에 실패해 **붙지 않는다**(평문·무검증으로 새지 않는다). 아래 주소는 문서용 예시(RFC 5737·example.com)다.
 */
describe("pgTlsOptions — RDS도 로컬도 아니면 자체 CA로 검증", () => {
  const BY_NAME = "postgresql://app:pw@db.example.com:5432/maeum";

  it("이름으로 붙으면 자체 CA로 검증하고 sslmode는 지운다(남으면 ca가 무시된다) · 다른 파라미터는 둔다", () => {
    const r = pgTlsOptions(`${BY_NAME}?schema=public&sslmode=verify-full`, {});
    expect(r.ssl).toEqual({ ca: ONPREM_DB_CA, rejectUnauthorized: true });
    const u = new URL(r.connectionString);
    expect(u.searchParams.has("sslmode")).toBe(false);
    expect(u.searchParams.get("schema")).toBe("public");
  });

  it("IP로 붙으면 그 IP를 host로 넘긴다 — node-postgres는 IP면 servername을 비워 Node가 'localhost'로 확인해 실패한다", () => {
    for (const ip of ["203.0.113.10", "192.0.2.10"]) {
      const r = pgTlsOptions(`postgresql://app:pw@${ip}:5432/maeum?sslmode=verify-full`, {});
      expect(r.ssl).toEqual({ ca: ONPREM_DB_CA, rejectUnauthorized: true, host: ip });
      expect(new URL(r.connectionString).searchParams.has("sslmode")).toBe(false);
    }
  });

  /**
   * 같은 VPC 안에서 사설 주소로 붙으면 그 주소가 서버 인증서에 없다(2026-10-30 AWS 이전). 검증을 끄지 않고, 인증서에 있는 이름을
   *   DATABASE_TLS_NAME으로 따로 준다. IP로 붙을 때만 쓰인다 — node-postgres는 IP면 servername을 비워 ssl.host가 확인 대상이 되고,
   *   이름으로 붙으면 servername을 그 이름으로 덮어 확인 이름이 바뀌지 않는다(실패하면 붙지 않을 뿐 — 아래 pg 소스 고정 참조).
   */
  it("IP로 붙고 DATABASE_TLS_NAME이 있으면 그 이름으로 인증서를 확인한다(사설 주소가 인증서에 없을 때)", () => {
    const raw = "postgresql://app:pw@10.0.0.5:5432/maeum?sslmode=verify-full";
    for (const [name, want] of [["db.example.com", "db.example.com"], ["  DB.Example.COM ", "db.example.com"], ["203.0.113.10", "203.0.113.10"]]) {
      const r = pgTlsOptions(raw, { DATABASE_TLS_NAME: name });
      expect(r.ssl).toEqual({ ca: ONPREM_DB_CA, rejectUnauthorized: true, host: want });
      // 🔒 접속 대상은 그대로 — 확인 이름만 바뀐다
      expect(new URL(r.connectionString).hostname).toBe("10.0.0.5");
    }
    // 비었거나 공백뿐이면 지금처럼 접속 IP로 확인한다
    for (const v of ["", "   ", undefined]) {
      expect(pgTlsOptions(raw, { DATABASE_TLS_NAME: v }).ssl).toEqual({ ca: ONPREM_DB_CA, rejectUnauthorized: true, host: "10.0.0.5" });
    }
  });

  it("DATABASE_TLS_NAME은 이름으로 붙을 때·RDS·검증 끄기에는 끼어들지 않는다", () => {
    expect(pgTlsOptions(BY_NAME, { DATABASE_TLS_NAME: "other.example.com" }).ssl).toEqual({ ca: ONPREM_DB_CA, rejectUnauthorized: true });
    expect(pgTlsOptions(RDS, { DATABASE_TLS_NAME: "other.example.com" }).ssl).toEqual({ ca: RDS_CA, rejectUnauthorized: true });
    expect(pgTlsOptions(BY_NAME, { DATABASE_TLS_NAME: "other.example.com", DATABASE_SSL_NO_VERIFY: "1" }).ssl).toEqual({ rejectUnauthorized: false });
  });

  it("node-postgres는 IP로 붙으면 servername을 넣지 않는다 — 그래야 ssl.host가 확인 이름이 된다(pg를 올릴 때 깨지면 여기서 잡힌다)", () => {
    const req = createRequire(import.meta.url);
    const src = readFileSync(req.resolve("pg/lib/connection.js"), "utf-8");
    // 🔒 우리 ssl 객체를 먼저 펼치고, IP가 아닐 때만 servername을 접속 이름으로 덮는다
    expect(src).toMatch(/Object\.assign\(options, self\.ssl\)/);
    expect(src).toMatch(/if \(net\.isIP && net\.isIP\(host\) === 0\) \{\s*options\.servername = host/);
  });

  it("이름은 대소문자를 가리지 않는다 · 이름으로 붙을 땐 host를 덧붙이지 않는다", () => {
    expect(pgTlsOptions("postgresql://u:p@DB.Example.COM:5432/maeum", {}).ssl).toEqual({ ca: ONPREM_DB_CA, rejectUnauthorized: true });
  });

  it("이 컴퓨터(localhost·127.x·::1)와 점 없는 이름(docker 서비스명 등)은 지금처럼 손대지 않는다", () => {
    for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "[::1]", "db"]) {
      const raw = `postgresql://u:p@${h}:5432/x`;
      expect(pgTlsOptions(raw, {}).ssl).toBeUndefined();
    }
  });

  it("DATABASE_SSL_NO_VERIFY=1은 자체 DB에도 그대로 비상 탈출구다(정확히 '1'일 때만)", () => {
    expect(pgTlsOptions(BY_NAME, { DATABASE_SSL_NO_VERIFY: "1" }).ssl).toEqual({ rejectUnauthorized: false });
    expect(pgTlsOptions(BY_NAME, { DATABASE_SSL_NO_VERIFY: "true" }).ssl).toEqual({ ca: ONPREM_DB_CA, rejectUnauthorized: true });
  });

  /**
   * 🔒 node-postgres는 연결문자열을 풀어 ssl 객체 **위에** 덮는다(pg/lib/connection-parameters). sslmode만 지우면
   *   ssl=0(평문)·ssl=no-verify(무검증)·ssl=true·sslrootcert 등이 CA 검증을 조용히 바꾼다 → 검증하는 길에서는 모두 지운다.
   *   자체 DB 쪽에서는 ?host=도 지운다(접속 대상과 인증서 확인 대상이 갈라진다).
   */
  it("검증하는 길(RDS·자체 DB)에서는 TLS를 바꾸는 파라미터를 모두 지운다 — 검증을 끄는 건 NO_VERIFY=1뿐", () => {
    const tlsParams = "ssl=0&sslmode=disable&sslcert=/c&sslkey=/k&sslrootcert=/r&uselibpqcompat=true";
    for (const [raw, ca] of [[`${RDS}?${tlsParams}&application_name=x`, RDS_CA], [`${BY_NAME}?${tlsParams}&host=192.0.2.99&application_name=x`, ONPREM_DB_CA]] as const) {
      const r = pgTlsOptions(raw, {});
      expect(r.ssl?.ca).toBe(ca);
      const u = new URL(r.connectionString);
      for (const k of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) expect(u.searchParams.has(k)).toBe(false);
      expect(u.searchParams.get("application_name")).toBe("x");
    }
    expect(new URL(pgTlsOptions(`${BY_NAME}?host=192.0.2.99`, {}).connectionString).searchParams.has("host")).toBe(false);
  });

  /** 함수가 낸 값을 node-postgres가 **실제로** 그대로 쓰는지 — pg를 올려도 이 보장이 깨지면 여기서 잡힌다(네트워크 없음). */
  it("node-postgres의 연결 설정에 넣으면 우리 ssl 객체와 URL의 host가 그대로 남는다", () => {
    const req = createRequire(import.meta.url);
    const ConnectionParameters = req("pg/lib/connection-parameters");
    const cases = [
      `${RDS}?sslmode=require&ssl=no-verify`,
      "postgresql://app:pw@203.0.113.10:5432/maeum?sslmode=verify-full&ssl=0",
      `${BY_NAME}?sslmode=verify-full&sslrootcert=/nope`,
    ];
    for (const raw of cases) {
      const { connectionString, ssl } = pgTlsOptions(raw, {});
      const cp = new ConnectionParameters({ connectionString, ssl });
      expect(cp.ssl).toEqual(ssl);
      expect(cp.host).toBe(new URL(raw).hostname);
    }
  });

  it("자체 CA는 인증서 한 장 · 지문이 고정값과 같고 · CA이며 · 아직 유효하고 · RDS 번들과 다르다", () => {
    expect(ONPREM_DB_CA.match(/-----BEGIN CERTIFICATE-----/g)).toHaveLength(1);
    const cert = new X509Certificate(ONPREM_DB_CA);
    expect(cert.fingerprint256).toBe("D6:4D:B1:CC:5A:E6:6D:8C:08:46:81:DE:A1:96:EA:32:80:B0:8C:7F:CA:85:DA:94:0B:75:78:D5:75:F2:4D:B8");
    expect(cert.ca).toBe(true);
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now());
    expect(ONPREM_DB_CA).not.toBe(RDS_CA);
  });
});

describe("두 사용처가 같은 함수를 쓴다", () => {
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it("scripts/ops-push-device.ts — pgTlsOptions로 연결하고, 검증을 끄는 설정을 직접 쓰지 않는다", () => {
    const src = code(readFileSync("scripts/ops-push-device.ts", "utf-8"));
    expect(src).toMatch(/import \{ pgTlsOptions \} from "\.\.\/lib\/db-tls";/);
    expect(src).toMatch(/pgTlsOptions\(process\.env\.DATABASE_URL!?\)/);
    // 🔒 예전 코드 — 운영 DB에 인증서 검증 없이 붙었다
    expect(src).not.toMatch(/rejectUnauthorized|no-verify|sslmode/);
  });

  it("lib/prisma.ts — 같은 함수로 연결 옵션을 정한다(정책이 두 군데에 있으면 또 갈린다)", () => {
    const src = code(readFileSync("lib/prisma.ts", "utf-8"));
    expect(src).toMatch(/pgTlsOptions\(process\.env\.DATABASE_URL/);
    expect(src).not.toMatch(/rejectUnauthorized|RDS_CA/);
  });

  /**
   * scripts/ 전체(2026-10-07 8차) — 운영 DB에 붙는 스크립트 56개(점검·백필·ops-*·e2e-*)가 저마다 인증서 검증을 끈 채(sslmode=no-verify +
   *   rejectUnauthorized:false) 붙고 있었다. 모두 같은 함수로 바꿨다 — TS는 pgTlsOptions를 직접, node로 도는 .mjs는 scripts/db-tls.mjs
   *   (tsx로 lib/db-tls.ts를 그대로 불러온다)로. 디렉터리에서 찾아 검사하므로 새 스크립트도 저절로 들어온다. 스크립트는 실행하지 않는다.
   */
  it("scripts/ — 검증을 끄는 설정을 직접 쓰는 스크립트가 없고, pg Pool을 만드는 스크립트는 모두 같은 함수를 쓴다(8차)", () => {
    const files = (readdirSync("scripts", { recursive: true }) as string[])
      .map((f) => `scripts/${f.replace(/\\/g, "/")}`)
      .filter((f) => /\.(ts|mjs|js|cjs)$/.test(f));
    const src = (f: string) => code(readFileSync(f, "utf-8"));
    // 🔒 스크립트 하나라도 검증을 끄면 그 스크립트가 운영 DB(건강 민감정보)에 중간자 위험을 연다
    expect(files.filter((f) => /rejectUnauthorized\s*:\s*false|no-verify/.test(src(f)))).toEqual([]);
    const pools = files.filter((f) => /new (pg\.)?Pool\(/.test(src(f)));
    expect(pools.length).toBeGreaterThan(50);   // 공허하게 통과하지 않게 — 지금 57개(ops-push-device 포함)
    expect(pools.filter((f) => !/pgTlsOptions\(/.test(src(f)))).toEqual([]);
    // node로 도는 .mjs의 길목 — tsx로 같은 TS 파일을 불러온다(베낀 정책이 아니다)
    expect(src("scripts/db-tls.mjs")).toMatch(/tsxRequire\("\.\.\/lib\/db-tls\.ts", import\.meta\.url\)/);
  });
});
