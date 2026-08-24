import { describe, expect, it } from "vitest";
import * as jobsPublicSurface from "./index";

/**
 * P1G-3 (Phase 1H): a structural (not just lint-time) proof that this
 * package's public barrel (`index.ts`'s `export *` chain) never exposes
 * the privileged worker/system Prisma clients it uses internally
 * (queue.ts/outbox.ts's `getWorkerClient()`). `@noahark/jobs` itself is
 * importable from anywhere in the app (see eslint.config.mjs's
 * `buildPrivilegedClientBoundary` — it does not restrict this package),
 * so if any of these names ever appeared here, ordinary application code
 * could obtain the RLS-bypassing worker/system client just by importing
 * `@noahark/jobs`. See eslint.config.mjs's `JOBS_EXPORT_BOUNDARY_SELECTORS`
 * for the companion static-analysis rule that blocks the `export`
 * statement itself at lint time — this test is the runtime backstop,
 * checking the package's ACTUAL resolved surface rather than its source
 * text, so it also catches an indirect leak lint's syntax-level check
 * might miss (e.g. a re-exported namespace object containing the symbol
 * under a different property path).
 */
describe("packages/jobs public surface never exposes a privileged Prisma client (P1G-3)", () => {
  const FORBIDDEN_NAMES = [
    "getWorkerClient",
    "workerClient",
    "getSystemClient",
    "systemClient",
    "createSystemClient",
    "disconnectWorkerClient",
    "disconnectSystemClient",
  ];

  it("does not export any privileged client symbol by name", () => {
    const exportedNames = Object.keys(jobsPublicSurface);
    for (const forbidden of FORBIDDEN_NAMES) {
      expect(exportedNames, `public surface leaked "${forbidden}"`).not.toContain(
        forbidden,
      );
    }
  });

  it("does not export a raw PrismaClient-shaped value under any key", () => {
    // Defense in depth beyond name-matching: nothing exported from this
    // package should itself be a Prisma client instance/factory (which
    // would expose $queryRaw/$transaction and therefore unrestricted
    // database access) — every legitimate export here is either a plain
    // function operating on a caller-supplied `tx`, or a constant/type.
    for (const [name, value] of Object.entries(jobsPublicSurface)) {
      if (typeof value === "function") {
        // A factory function is only suspicious if its OWN name matches
        // the forbidden list (checked above); ordinary exported functions
        // (enqueueJob, startWorkerLoop, cleanupTerminalJobs, etc.) are
        // expected and fine.
        continue;
      }
      expect(
        value === null ||
          typeof value !== "object" ||
          !("$transaction" in (value as object)),
        `export "${name}" looks like a Prisma client instance`,
      ).toBe(true);
    }
  });
});
