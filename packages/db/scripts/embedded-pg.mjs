/**
 * Local/CI development Postgres — no Docker required. This is what the
 * Phase 1 report's "environmental limitation" note refers to when Docker
 * isn't available: `embedded-postgres` downloads and runs a real
 * PostgreSQL binary directly, serving the same purpose Testcontainers
 * would (TARGET_ARCHITECTURE.md's original proposal). NOT used in
 * production — this is exclusively for `pnpm db:dev-postgres` / local
 * integration-test runs.
 *
 * Usage: node scripts/embedded-pg.mjs start|stop
 */
import EmbeddedPostgres from "embedded-postgres";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", ".embedded-postgres", "data");
const PORT = 55432;

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "postgres",
  port: PORT,
  persistent: true, // avoid Windows file-lock races on rmdir at stop time
});

const command = process.argv[2];

if (command === "start") {
  await pg.initialise().catch(() => {
    // Already initialised from a previous run — fine, just start it.
  });
  await pg.start();
  try {
    await pg.createDatabase("noahark");
  } catch {
    // Database already exists from a previous run — fine.
  }
  console.warn(`[embedded-pg] listening on 127.0.0.1:${PORT}, database "noahark" ready`);
  console.warn(
    `[embedded-pg] DATABASE_MIGRATION_URL=postgresql://postgres:postgres@127.0.0.1:${PORT}/noahark`,
  );
} else if (command === "stop") {
  await pg.stop();
  console.warn("[embedded-pg] stopped");
} else {
  console.error("Usage: node scripts/embedded-pg.mjs start|stop");
  process.exit(1);
}
