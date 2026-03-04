import { PrismaClient } from "../generated/prisma/client/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

let connectionString =
  process.env.DATABASE_URL ?? "postgresql://localhost:5432/maeumieu";
// AWS RDS 등: SSL은 사용하되 인증서 검증 생략 (self-signed 등)
try {
  const url = new URL(connectionString);
  url.searchParams.set("sslmode", "no-verify");
  connectionString = url.toString();
} catch {
  // URL 파싱 실패 시 그대로 사용
}

const adapter = new PrismaPg({
  connectionString,
  ssl: { rejectUnauthorized: false },
});

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
