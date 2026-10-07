import pg from "pg"; import "dotenv/config";
import { pgTlsOptions } from "./db-tls.mjs";
// TLS는 앱과 같은 정책(scripts/db-tls.mjs → lib/db-tls, 2026-10-07 8차) — 검증을 끄는 건 DATABASE_SSL_NO_VERIFY=1뿐이다
const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL);
const p = new pg.Pool({ connectionString, ...(ssl ? { ssl } : {}) });
const c = await p.connect();
const u = await c.query(`SELECT id FROM "User" WHERE email='cycle_test_2026@example.com'`);
const r = await c.query(
  `SELECT role, LEFT(content,90) AS content, "createdAt" FROM "Message"
   WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "userId"=$1)
   ORDER BY "createdAt" DESC LIMIT 6`, [u.rows[0].id]);
for (const x of r.rows.reverse()) console.log(`[${new Date(x.createdAt).toLocaleTimeString("ko-KR")}] ${x.role}: ${x.content}`);
c.release(); await p.end();
