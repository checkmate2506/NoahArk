/**
 * F-24 (Phase 1B): Playwright global setup — loads and validates the
 * environment before any spec runs, and refuses anything that looks like a
 * production database (same heuristic as prisma/seed.ts).
 *
 * P1E-5 (Phase 1F): by default, this now owns the ENTIRE E2E environment —
 * a disposable database (never the shared development database a
 * developer's own `pnpm --filter @noahark/web worker` might be pointed
 * at), plus its own `next dev` server running against it on a fixed port
 * (see e2eServerConfig.ts, shared with playwright.config.ts). Teardown
 * stops the server and drops the database unconditionally. Setting
 * `E2E_BASE_URL` explicitly opts BACK OUT of this — it points Playwright
 * at an already-running server you started and migrated yourself
 * (matching this project's pre-P1E-5 behaviour), and this file then only
 * validates the target, exactly as before.
 */
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertDatabaseTargetIsSafe } from "@noahark/db";
import {
  createDisposableTestDatabase,
  dropDisposableTestDatabase,
  type DisposableTestDatabase,
} from "../testDbLifecycle";
import { killProcessTree } from "../processTree";
import { DEFAULT_E2E_PORT } from "./e2eServerConfig";

const WEB_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

function validateCommonEnvironment(): string {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  if (!migrationUrl) {
    throw new Error(
      "DATABASE_MIGRATION_URL is not set. E2E tests need an owner/admin connection — " +
        "either to create their own disposable database (default) or, with E2E_BASE_URL " +
        "set, to provision/verify the database an already-running server points at. Copy " +
        ".env.example to apps/web/.env for local runs.",
    );
  }
  assertDatabaseTargetIsSafe(migrationUrl, "Refusing to run E2E tests");
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to run E2E tests: NODE_ENV=production. E2E is a development/test-only operation.",
    );
  }
  return migrationUrl;
}

async function waitForServerReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(
    `E2E app server did not become ready within ${timeoutMs}ms at ${url}${lastError ? ` (last error: ${String(lastError)})` : ""}`,
  );
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const adminUrl = validateCommonEnvironment();

  if (process.env.E2E_BASE_URL) {
    console.warn(
      `[e2e globalSetup] E2E_BASE_URL is set — using the already-running server at ` +
        `${process.env.E2E_BASE_URL} instead of an auto-managed disposable database/server. ` +
        `That server's own DATABASE_URL must already point at whatever DATABASE_MIGRATION_URL ` +
        `resolves to here.`,
    );
    return async () => {};
  }

  // NODE_ENV is typed readonly on process.env; see integration/globalSetup.ts's
  // identical comment.
  (process.env as Record<string, string | undefined>).NODE_ENV =
    process.env.NODE_ENV ?? "test";
  process.env.ALLOW_TEST_DB_PURGE = "1";
  process.env.TEST_NOTIFICATION_CAPTURE = "1";

  const db = await createDisposableTestDatabase("e2e", adminUrl);

  // Critical: mutate process.env itself, not just a local object handed to
  // the spawned server below. `foundation.spec.ts`'s own `test.beforeAll`
  // runs in THIS process (Playwright's worker inherits globalSetup's
  // process.env — verified directly) and calls `createSystemClient()`,
  // which reads `process.env.DATABASE_MIGRATION_URL` at call time. Without
  // this line, that fixture creation silently used whatever `.env` had
  // ALREADY loaded (the shared dev database) while the server below
  // correctly used the disposable one — the fixture user would then exist
  // in a database the server never queries, and every sign-in in the
  // actual test run would 401. Confirmed live before this fix (inspected
  // the failing run's own network trace: sign-in returned 401 for the
  // beforeAll-created admin user on every single one of the 18 scenarios).
  process.env.DATABASE_URL = db.appUrl;
  process.env.DATABASE_MIGRATION_URL = db.migrationUrl;
  process.env.DATABASE_WORKER_URL = db.workerUrl;

  const port = String(DEFAULT_E2E_PORT);
  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AUTH_URL: `http://localhost:${port}`,
    PORT: port,
  };

  const serverProcess: ChildProcess = spawn("npx", ["next", "dev", "-p", port], {
    cwd: WEB_DIR,
    env: serverEnv,
    shell: true,
    windowsHide: true,
  });

  let serverOutput = "";
  serverProcess.stdout?.on("data", (d: Buffer) => {
    serverOutput += d.toString();
  });
  serverProcess.stderr?.on("data", (d: Buffer) => {
    serverOutput += d.toString();
  });

  try {
    await waitForServerReady(`http://localhost:${port}/api/v1/me/tenants`, 60_000);
    // Best-effort warm-up: forces Turbopack to compile the one page every
    // scenario visits first (see playwright.config.ts's `timeout` comment)
    // before Playwright's own per-test clock starts running. A failure
    // here is not fatal — the per-test timeout is generous enough to
    // absorb a cold compile on its own if this somehow doesn't help.
    await fetch(`http://localhost:${port}/sign-in`).catch(() => undefined);
  } catch (e) {
    console.error(serverOutput.slice(-4000));
    await killProcessTree(serverProcess);
    await dropDisposableTestDatabase(db);
    throw e;
  }

  console.warn(
    `[e2e globalSetup] app server ready on :${port} against disposable database "${db.name}"`,
  );

  return async () => {
    await killProcessTree(serverProcess);
    await dropDisposableTestDatabase(db as DisposableTestDatabase);
    console.warn(
      `[e2e globalSetup] stopped server and dropped disposable database "${db.name}"`,
    );
  };
}
