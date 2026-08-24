import { describe, expect, it } from "vitest";
import * as dbIndex from "./index";

/**
 * N-3 (Phase 1D): structural regression test — independent of the ESLint
 * import-boundary rule (importBoundaries.test.ts in apps/web) — proving
 * ordinary request-handling code that does `import { X } from "@noahark/db"`
 * has no path to the owner/migration client or the worker-role client,
 * because they are never part of this package's main barrel export. See
 * this file's own doc comment for the deliberate `export *` list.
 */
describe("@noahark/db main barrel export — application runtime cannot reach owner/worker clients (N-3)", () => {
  it("does not export createSystemClient / disconnectSystemClient", () => {
    expect("createSystemClient" in dbIndex).toBe(false);
    expect("disconnectSystemClient" in dbIndex).toBe(false);
  });

  it("does not export getWorkerClient / disconnectWorkerClient", () => {
    expect("getWorkerClient" in dbIndex).toBe(false);
    expect("disconnectWorkerClient" in dbIndex).toBe(false);
  });
});
