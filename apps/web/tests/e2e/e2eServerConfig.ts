/**
 * P1E-5 (Phase 1F): shared between playwright.config.ts (evaluated at CLI
 * startup) and tests/e2e/globalSetup.ts (runs after) — both need to agree
 * on the SAME port without either being able to tell the other at runtime,
 * since config evaluation happens before globalSetup runs. A single
 * exported constant is the simplest way to guarantee they can't drift.
 */
export const DEFAULT_E2E_PORT = 3102;
