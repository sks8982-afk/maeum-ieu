import { PrismaClient } from "../generated/prisma/client/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { pgTlsOptions } from "./db-tls";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

// SSL 정책 — 건강/인지 민감 데이터 경로의 중간자 공격 방지. RDS는 RDS CA로 검증(rejectUnauthorized:true),
//   DATABASE_SSL_NO_VERIFY=1만 비상 탈출구. 운영 스크립트와 같은 함수다(lib/db-tls — 2026-10-07 7차에 옮겼다, 정책은 그대로).
const { connectionString, ssl } = pgTlsOptions(process.env.DATABASE_URL ?? "postgresql://localhost:5432/maeumieu");

/**
 * 커넥션 풀 상한 — **인스턴스 수 × 이 값**이 RDS max_connections를 넘으면 전면 장애다.
 *
 * ⚠ 2026-10-02 AWS 이전 감사 #25. Vercel 서버리스에서는 인스턴스당 커넥션이 적고 수명이
 *   짧아 드러나지 않았지만, ALB 뒤 상주 프로세스 N개가 되면 각자 풀을 끝까지 채운다.
 *   db.t4g.micro급은 max_connections가 수십~백 단위라 금방 소진되고,
 *   소진되면 **응급 알림의 dedup 조회·마킹까지 함께 실패**한다(알림 경로가 DB를 탄다).
 *
 *   DB_POOL_MAX로 조정한다. 산식: (RDS max_connections − 운영 여유 10) ÷ 예상 최대 태스크 수.
 *   예: max 100, 태스크 4 → (100−10)/4 ≈ 22 → 넉넉히 15~20.
 *   기본 10은 보수적인 값 — 모르면 이대로 두고 태스크를 늘릴 때 함께 계산한다.
 *   ⚠ 빈 문자열은 미설정으로 처리한다(ECS 태스크 정의에서 흔한 실수 — daily-limit와 같은 이유).
 */
const DB_POOL_MAX = (() => {
  const raw = process.env.DB_POOL_MAX?.trim();
  if (!raw) return 10;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 10;
})();

const adapter = new PrismaPg({
  connectionString,
  ...(ssl ? { ssl } : {}),
  max: DB_POOL_MAX,
  // 유휴 커넥션을 오래 쥐고 있으면 스케일인 뒤에도 RDS 쪽 슬롯이 남는다
  idleTimeoutMillis: 30_000,
  // 풀이 포화일 때 무한 대기하지 않는다 — 요청이 쌓여 ECS 헬스체크까지 밀리는 것 방지
  connectionTimeoutMillis: 10_000,
});

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    // dev query 로그는 PII 컬럼 포함 SQL이 로그 파일에 누적됨 — DEBUG_PRISMA_QUERY=1일 때만 활성
    log: process.env.NODE_ENV === "development"
      ? (process.env.DEBUG_PRISMA_QUERY === "1" ? ["query", "error", "warn"] : ["error", "warn"])
      : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
