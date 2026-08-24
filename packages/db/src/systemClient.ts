import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

/**
 * Owner-role connection (DATABASE_MIGRATION_URL) — bypasses RLS entirely.
 * ONLY for migrations, prisma/seed.ts, and integration-test fixture setup.
 * Never import this from apps/web request-handling code.
 *
 * Memoized (like client.ts's getAppClient() / workerClient.ts's
 * getWorkerClient()) so a long-running process — a test suite calling this
 * many times across many files, not just seed.ts's one-shot use — reuses a
 * single connection pool instead of opening a new one per call. Without
 * this, Postgres's connection limit is exhausted quickly under test load.
 */
let systemClient: PrismaClient | undefined;

export function createSystemClient(): PrismaClient {
  if (!systemClient) {
    const url = process.env.DATABASE_MIGRATION_URL;
    if (!url) throw new Error("DATABASE_MIGRATION_URL is not set");
    const adapter = new PrismaPg({ connectionString: url });
    systemClient = new PrismaClient({ adapter });
  }
  return systemClient;
}

export async function disconnectSystemClient(): Promise<void> {
  if (systemClient) {
    await systemClient.$disconnect();
    systemClient = undefined;
  }
}
