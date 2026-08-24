/**
 * Shared "does this connection string look like production?" heuristic,
 * used by both prisma/seed.ts (F-1) and the Playwright E2E global setup
 * (F-24) — both are development/test-only operations that must refuse a
 * production-looking target. This is a BACKSTOP only, never the sole gate:
 * callers must also require an explicit environment-variable opt-in and
 * check NODE_ENV themselves (see prisma/seed.ts's assertSeedIsAllowed for
 * the pattern).
 */
const PRODUCTION_HOST_MARKERS = [".postgres.database.azure.com", "prod", "production"];

export function assertDatabaseTargetIsSafe(databaseUrl: string, purpose: string): void {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error(
      `${purpose} — DATABASE_MIGRATION_URL is not a valid connection string`,
    );
  }
  const host = parsed.hostname.toLowerCase();
  const dbName = parsed.pathname.replace(/^\//, "").toLowerCase();
  for (const marker of PRODUCTION_HOST_MARKERS) {
    if (host.includes(marker) || dbName.includes(marker)) {
      throw new Error(
        `${purpose} — target host/database "${host}${parsed.pathname}" looks like a production target ` +
          `(matched "${marker}"). This is a development/test-only operation.`,
      );
    }
  }
}
