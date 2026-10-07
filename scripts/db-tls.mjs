/**
 * node로 도는 .mjs 스크립트(e2e-*·점검용)의 Postgres TLS — 앱(lib/prisma.ts)·TS 스크립트와 **같은 함수**(lib/db-tls pgTlsOptions)로
 *   정한다(2026-10-07 8차). RDS면 RDS CA로 서버 인증서를 검증하고(rejectUnauthorized: true), 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다.
 *   왜: 예전엔 스크립트마다 sslmode=no-verify + rejectUnauthorized:false로 검증을 끈 채 운영 RDS에 붙었다 — 앱만 검증하고 스크립트는
 *   중간자에게 열려 있었다. 이 스크립트들은 tsx 없이 node로 돌아 TS 파일을 바로 import하지 못해, tsx의 범위 한정 require로 **같은 파일**을
 *   불러온다(정책을 .mjs에 따로 베끼면 또 갈린다). tsx는 devDependency다 — 이 스크립트들도 개발 도구라 같은 환경에서 돈다.
 *   쓰는 법: const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL);
 *            new pg.Pool({ connectionString, ...(ssl ? { ssl } : {}) })
 */
import { require as tsxRequire } from "tsx/cjs/api";

/** @type {typeof import("../lib/db-tls")} */
const dbTls = tsxRequire("../lib/db-tls.ts", import.meta.url);

export const pgTlsOptions = dbTls.pgTlsOptions;
