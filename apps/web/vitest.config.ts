import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = fileURLToPath(new URL(".", import.meta.url));
const alias = { "@": rootDir };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["lib/**/*.test.ts"],
          environment: "node",
          setupFiles: ["./vitest.setup.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          setupFiles: ["./vitest.setup.ts"],
          // N-4 (Phase 1D): purges orphaned test data left behind by a
          // previous run that never got to finish its own cleanup — see
          // tests/testDataPurge.ts.
          globalSetup: ["./tests/integration/globalSetup.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
          // Integration tests share one Postgres instance and create/tear
          // down their own tenants — safe to run sequentially, not safe to
          // fan out across worker processes touching the same DB pool.
          // Confirmed directly (PostgreSQL 16 integration-stability
          // remediation): running two files concurrently under this
          // config, even with fileParallelism serialization disabled,
          // reproduces genuine cross-file data races (wrong job claimed,
          // tenant collisions) — fileParallelism:false remains required
          // for correctness, independent of the pool setting below.
          fileParallelism: false,
          // `pool: "threads"` (not the default "forks"): live diagnosis
          // against PostgreSQL 16.14 reproduced an intermittent "Worker
          // exited unexpectedly" failure under the default fork pool —
          // confirmed via direct instrumentation (heartbeat + exit/
          // uncaughtException/unhandledRejection hooks in every worker)
          // that the child process is terminated WITHOUT ever running its
          // own exit handlers, and without any PostgreSQL server-side
          // FATAL/PANIC or Windows Application Error / crash-report
          // artifact — evidence of an external, environment-level
          // termination of a spawned OS child process (not a PostgreSQL,
          // Prisma, or test-code defect; not file-level parallelism,
          // since a single-persistent-fork/no-isolate configuration still
          // failed 1/5 runs). Abrupt termination was reproduced under
          // both PostgreSQL 16.14 and PostgreSQL 18.4 in this
          // investigation, so this is not a PostgreSQL-16-specific
          // defect — PostgreSQL 16's different timing appears to change
          // how OFTEN this environment-level mechanism triggers, not to
          // introduce a defect of its own.
          //
          // IMPORTANT — this does not make the run immune to external
          // termination. Under the fork pool, the terminated process was
          // a SEPARATE forked worker, so the main Vitest process survived
          // and reported a partial, corrupted result (lost/uncounted
          // tests from whichever file was running, with no assertion
          // failure of its own). Under the thread pool there is no
          // separate worker process to terminate — the same external
          // mechanism, if it fires, would instead hit the main Vitest
          // process itself, which fails the whole run outright (fail-
          // stop) rather than corrupting a subset of results. This
          // changes the FAILURE MODE from silent partial corruption to
          // an obvious whole-run failure; it does not remove the
          // underlying external-termination risk, whose exact trigger
          // was not identified. See docs/DECISION_REGISTER.md's
          // PostgreSQL 16 integration-stability ADRs (ADR-68/ADR-69) for
          // the full diagnostic matrix and the evidence-scoped root-cause
          // wording.
          pool: "threads",
        },
      },
    ],
  },
});
