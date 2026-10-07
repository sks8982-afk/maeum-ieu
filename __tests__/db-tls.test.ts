/**
 * Postgres TLS 정책(lib/db-tls) — 앱(lib/prisma.ts)과 운영 스크립트가 **같은 함수**로 정한다(2026-10-07 7차).
 *
 * 결함: scripts/ops-push-device.ts는 sslmode=no-verify + rejectUnauthorized:false로 **인증서 검증을 끈 채** 운영 RDS에 붙었다 —
 *   앱은 RDS CA로 검증하는데, 위급 알림 테이블을 만드는 스크립트만 중간자에게 열려 있었다. 정책을 한 함수로 모으고, 그 함수의
 *   규칙(RDS → CA 검증, DATABASE_SSL_NO_VERIFY=1만 예외)과 두 사용처를 고정한다. 스크립트는 실행하지 않는다(운영 DB).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { pgTlsOptions } from "@/lib/db-tls";
import { RDS_CA } from "@/lib/rds-ca";

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
