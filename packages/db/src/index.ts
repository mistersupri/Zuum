import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __zuumPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__zuumPrisma ??
  new PrismaClient({ log: process.env.PRISMA_LOG === "1" ? ["query", "warn", "error"] : ["warn", "error"] });

if (process.env.NODE_ENV !== "production") globalForPrisma.__zuumPrisma = prisma;
