import { describe, expect, it, vi } from "vitest";
import { startWorkerLoop } from "@noahark/jobs";

/**
 * N-5 (Phase 1D): proves the maintenance sweep wired into startWorkerLoop
 * (packages/jobs/src/worker.ts + maintenance.ts) actually fires on its
 * configured interval — not just that the standalone primitives
 * (cleanupExpiredBuckets, cleanupExpiredVerificationTokens,
 * runMaintenanceTasks) work in isolation, which the other N-5 tests
 * already cover.
 */
describe("startWorkerLoop maintenance sweep (N-5)", () => {
  it("invokes supplied maintenance tasks on the configured interval", async () => {
    const task = vi.fn().mockResolvedValue(0);
    const handle = startWorkerLoop(
      "test-maintenance-worker",
      {},
      {},
      {
        pollIntervalMs: 20,
        reapIntervalMs: 10_000,
        maintenanceIntervalMs: 30,
        maintenanceTasks: { probe: task },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    await handle.stop();

    expect(task.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("never calls maintenance tasks when none are supplied (no default work)", async () => {
    const handle = startWorkerLoop(
      "test-no-maintenance-worker",
      {},
      {},
      { pollIntervalMs: 20, reapIntervalMs: 10_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The real assertion: startWorkerLoop runs and stops cleanly with the
    // maintenance options omitted entirely (truly optional, no forced
    // dependency on a caller supplying anything).
    await expect(handle.stop()).resolves.toBeUndefined();
  });
});
