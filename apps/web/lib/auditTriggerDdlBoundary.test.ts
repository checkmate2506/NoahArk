import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Phase 1H.3: a structural (source-scanning, no live database needed)
 * guard against the exact regression a live Opus verification caught —
 * `apps/web/tests/integration/temporalSecurityBoundaries.test.ts` (Phase
 * 1H.2) issued a raw `ALTER TABLE audit_event DISABLE/ENABLE TRIGGER`
 * pair OUTSIDE the shared gated primitive
 * (`withGatedAuditTriggerDisabled`, `apps/web/tests/testCleanupGate.ts`)
 * that every other trigger-disabling call site goes through. `ALTER TABLE
 * ... TRIGGER` takes an ACCESS EXCLUSIVE lock on `audit_event` for the
 * whole database — issuing it outside the gate (which itself does
 * nothing to bound the LOCK, only the four safety CONDITIONS under which
 * it may run at all) reintroduces both the P1G-1 safety gap and a real,
 * measured source of integration-suite flakiness (worker-fork crashes
 * under lock contention left PENDING job fixtures uncleaned, which
 * `claimNextJob()` then claimed in unrelated, later test files).
 *
 * This test scans every `.ts`/`.tsx`/`.mjs` file under `apps/web/tests/`
 * (test code only — this boundary has no reason to exist in application
 * code, since production never disables an audit trigger at all) for the
 * literal SQL fragments `DISABLE TRIGGER` / `ENABLE TRIGGER`
 * (case-insensitive) and fails if either appears anywhere OUTSIDE the two
 * explicitly allowlisted files below. Adding a THIRD legitimate call site
 * requires a deliberate edit to `ALLOWED_RELATIVE_PATHS` here, not a
 * silent pass.
 *
 * Phase 1H.3 pre-commit cleanup (Opus finding L-1): the allowlist check
 * previously matched on `basename` alone, so `integration/testDataPurge.ts`
 * or any other `testCleanupGate.ts` dropped into a subdirectory would have
 * silently passed — the guard would not have caught a same-named file
 * planted anywhere else in the tree. It now matches the full path,
 * normalized and relative to the scanned root, so only the two exact
 * files at the tests root are ever allowed; a same-named file one level
 * deeper fails like any other offender. `scanForUnauthorizedTriggerDdl` is
 * exported from this module (not just used inline) so the adversarial
 * tests below can point it at a disposable synthetic directory tree
 * instead of writing throwaway fixtures into the real, guarded
 * `apps/web/tests/` tree.
 */
const TESTS_ROOT = join(__dirname, "..", "tests");

/**
 * `testCleanupGate.ts` is the shared gated primitive itself
 * (`withGatedAuditTriggerDisabled`) — the only place this DDL should
 * originate from for every test file that needs it.
 * `testDataPurge.ts`'s `purgeOrphanedTestData` is a pre-existing,
 * independently-gated call site (calls `assertTestCleanupAllowed`
 * directly rather than going through the shared wrapper — see that
 * file's own doc comment for why) that predates the shared primitive and
 * was already reviewed and approved (P1G-1, Phase 1H).
 *
 * These are full paths relative to the scanned root (forward-slash
 * normalized), not basenames — both files happen to live directly at the
 * real tests root today, so each entry has no subdirectory prefix.
 */
export const ALLOWED_RELATIVE_PATHS = new Set(["testCleanupGate.ts", "testDataPurge.ts"]);

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (/\.(ts|tsx|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Returns the forward-slash-normalized relative paths (from `root`) of
 * every file containing raw `DISABLE TRIGGER` / `ENABLE TRIGGER` DDL that
 * is NOT one of the two exact allowlisted paths. An empty result means
 * the tree is clean.
 */
export function scanForUnauthorizedTriggerDdl(root: string): string[] {
  const offenders: string[] = [];
  for (const file of listFilesRecursive(root)) {
    const relPath = relative(root, file).replace(/\\/g, "/");
    const content = readFileSync(file, "utf8");
    const hasTriggerDdl = /\b(DISABLE|ENABLE)\s+TRIGGER\b/i.test(content);
    if (!hasTriggerDdl) continue;
    if (!ALLOWED_RELATIVE_PATHS.has(relPath)) {
      offenders.push(relPath);
    }
  }
  return offenders;
}

describe("audit-trigger DDL boundary (Phase 1H.3)", () => {
  it("no test file disables/enables the audit_event triggers outside the allowlisted gated primitive", () => {
    const offenders = scanForUnauthorizedTriggerDdl(TESTS_ROOT);
    expect(
      offenders,
      "Found raw audit-trigger DISABLE/ENABLE TRIGGER DDL outside the allowlisted " +
        "gated primitive. Use `withGatedAuditTriggerDisabled` from " +
        "apps/web/tests/testCleanupGate.ts instead — see this test's own doc " +
        "comment for why a bare ALTER TABLE ... TRIGGER statement is unsafe here.",
    ).toEqual([]);
  });

  it("the allowlisted files still exist and still contain the expected gated mechanism", () => {
    const gatePath = join(TESTS_ROOT, "testCleanupGate.ts");
    const gateContent = readFileSync(gatePath, "utf8");
    expect(gateContent).toMatch(/withGatedAuditTriggerDisabled/);
    expect(gateContent).toMatch(/assertTestCleanupAllowed/);

    const purgePath = join(TESTS_ROOT, "testDataPurge.ts");
    const purgeContent = readFileSync(purgePath, "utf8");
    expect(purgeContent).toMatch(/assertTestCleanupAllowed/);
  });
});

/**
 * Phase 1H.3 pre-commit cleanup (Opus finding L-1, adversarial proof):
 * exercises `scanForUnauthorizedTriggerDdl` end to end (real directory
 * walk + real content scan + real allowlist match) against a disposable
 * synthetic tree, never against the real `apps/web/tests/` directory —
 * so these tests can plant genuinely offending files without ever risking
 * contamination of, or being caught by, the real guard above.
 */
describe("audit-trigger DDL boundary — adversarial path-matching proof (Phase 1H.3, L-1)", () => {
  let sandboxRoot: string | undefined;

  afterEach(() => {
    if (sandboxRoot) {
      rmSync(sandboxRoot, { recursive: true, force: true });
      sandboxRoot = undefined;
    }
  });

  function writeSandboxFile(relPath: string, content: string): void {
    const full = join(sandboxRoot!, relPath);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }

  it("the two exact approved paths pass, even though both contain trigger DDL", () => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "noahark-trigger-ddl-boundary-"));
    writeSandboxFile(
      "testCleanupGate.ts",
      `export async function withGatedAuditTriggerDisabled() {
  await tx.$executeRawUnsafe("ALTER TABLE audit_event DISABLE TRIGGER audit_event_append_only");
  await tx.$executeRawUnsafe("ALTER TABLE audit_event ENABLE TRIGGER audit_event_append_only");
}`,
    );
    writeSandboxFile(
      "testDataPurge.ts",
      `await client.query("ALTER TABLE audit_event DISABLE TRIGGER audit_event_append_only");`,
    );

    expect(scanForUnauthorizedTriggerDdl(sandboxRoot)).toEqual([]);
  });

  it("integration/testDataPurge.ts (same basename, wrong directory) fails", () => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "noahark-trigger-ddl-boundary-"));
    writeSandboxFile(
      "integration/testDataPurge.ts",
      `await client.query("ALTER TABLE audit_event DISABLE TRIGGER audit_event_append_only");`,
    );

    expect(scanForUnauthorizedTriggerDdl(sandboxRoot)).toEqual([
      "integration/testDataPurge.ts",
    ]);
  });

  it("a nested testCleanupGate.ts one level deeper (same basename, wrong directory) fails", () => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "noahark-trigger-ddl-boundary-"));
    writeSandboxFile(
      "nested/testCleanupGate.ts",
      `await tx.$executeRawUnsafe("ALTER TABLE audit_event ENABLE TRIGGER audit_event_append_only");`,
    );

    expect(scanForUnauthorizedTriggerDdl(sandboxRoot)).toEqual([
      "nested/testCleanupGate.ts",
    ]);
  });

  it("an unrelated file containing trigger DDL fails", () => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "noahark-trigger-ddl-boundary-"));
    writeSandboxFile(
      "someOtherTest.test.ts",
      `await tx.$executeRawUnsafe("ALTER TABLE audit_event DISABLE TRIGGER audit_event_append_only");`,
    );

    expect(scanForUnauthorizedTriggerDdl(sandboxRoot)).toEqual(["someOtherTest.test.ts"]);
  });

  it("a file with no trigger DDL at all never appears as an offender, allowlisted or not", () => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "noahark-trigger-ddl-boundary-"));
    writeSandboxFile("integration/harmless.test.ts", `export const x = 1;`);

    expect(scanForUnauthorizedTriggerDdl(sandboxRoot)).toEqual([]);
  });
});
