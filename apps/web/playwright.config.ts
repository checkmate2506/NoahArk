// F-24 (Phase 1B): loaded here (not only in tests/e2e/globalSetup.ts) so the
// variables are set on THIS process's `process.env` before Playwright forks
// worker processes — workers inherit their parent's env, but globalSetup
// alone runs too late/in a separate lifecycle stage to be relied on for
// propagation. globalSetup.ts still owns the safety VALIDATION (refusing a
// production-looking target), which only needs to run once and can safely
// assume the variables are already loaded by the time it executes.
import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";
import { DEFAULT_E2E_PORT } from "./tests/e2e/e2eServerConfig";

/**
 * P1E-5 (Phase 1F): by default, `globalSetup.ts` now owns the ENTIRE
 * lifecycle — a disposable database, and its own `next dev` server running
 * against it — so this config's `baseURL` must agree with globalSetup on a
 * FIXED port (config is evaluated before globalSetup runs, so it cannot
 * read a port choice made there). Setting `E2E_BASE_URL` explicitly opts
 * BACK OUT of the auto-managed flow entirely (see globalSetup.ts) — points
 * Playwright at an already-running server you started and migrated
 * yourself, matching this project's pre-P1E-5 behaviour.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/globalSetup.ts",
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  // P1E-5 (Phase 1F): the auto-managed server (see globalSetup.ts) is a
  // freshly started `next dev` process — its FIRST request to any given
  // route pays Turbopack's on-demand compile cost, which the previous
  // "point Playwright at a server you already had running" workflow never
  // hit (that server had usually been warmed by normal browsing). 30s
  // (Playwright's default) was observed too tight for the very first
  // sign-in + first render of a dynamic route under a cold server;
  // globalSetup also warms `/sign-in` itself as a first mitigation, but
  // this budget still needs to cover a cold `/app/[tenantId]` render on
  // test 1 specifically.
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${DEFAULT_E2E_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
