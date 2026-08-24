import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 1H.3 (Opus finding F-2): `@prisma/adapter-pg` mis-serializes a
 * write to a genuine `timestamptz` column whenever the connection's
 * session `TimeZone` is explicitly non-UTC (see ADR-56/ADR-61 in
 * docs/DECISION_REGISTER.md). `packages/db/provisioning/provision-roles.mjs`'s
 * `ALTER DATABASE ... SET timezone TO 'UTC'` removes the trigger condition
 * for every NORMAL session — one that never explicitly overrides its own
 * timezone — but does nothing for a session that explicitly runs
 * `SET TIME ZONE` after connecting. No current production code path does
 * this (confirmed here), which is why F-2 is accepted as a known,
 * non-runtime-reachable residual risk rather than fixed by a connection-pool
 * redesign.
 *
 * This test scans PRODUCTION source only — `apps/web/app`,
 * `apps/web/components`, `apps/web/lib` (excluding test files, including
 * this one), `apps/web/middleware.ts`, `apps/web/scripts` (this includes
 * `worker.ts`, the actual worker entrypoint), and every package's `src`
 * directory under `packages` (excluding colocated `*.test.ts` files) —
 * for the literal SQL fragment
 * `SET TIME ZONE` (case-insensitive) or a `.query`/`.raw`-style call
 * containing it. Test code is explicitly NOT scanned: the timezone-matrix
 * adversarial suites (`jobSchedulingTemporalMatrix.test.ts`,
 * `temporalSecurityBoundaries.test.ts`) legitimately use `SET TIME ZONE`
 * to prove the database layer is timezone-independent, and must continue
 * to be able to do so.
 *
 * Adding a legitimate production `SET TIME ZONE` call site requires a
 * deliberate, reviewed edit to `ALLOWED_RELATIVE_PATHS` below, not a
 * silent pass.
 */
const REPO_ROOT = join(__dirname, "..", "..", "..");

const SCAN_ROOTS = [
  join(REPO_ROOT, "apps", "web", "app"),
  join(REPO_ROOT, "apps", "web", "components"),
  join(REPO_ROOT, "apps", "web", "lib"),
  join(REPO_ROOT, "apps", "web", "scripts"),
  join(REPO_ROOT, "packages"),
];

const MIDDLEWARE_FILE = join(REPO_ROOT, "apps", "web", "middleware.ts");

/** No production call site is currently allowlisted — see this file's own doc comment. */
const ALLOWED_RELATIVE_PATHS = new Set<string>();

function isTestFile(fileName: string): boolean {
  return /\.test\.(ts|tsx)$/.test(fileName);
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (/\.(ts|tsx|mjs)$/.test(entry) && !isTestFile(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("production session-timezone boundary (Phase 1H.3, Opus F-2)", () => {
  it("no production source file issues SET TIME ZONE", () => {
    const files = SCAN_ROOTS.flatMap((root) => listFilesRecursive(root));
    files.push(MIDDLEWARE_FILE);

    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      if (!/SET\s+TIME\s+ZONE/i.test(content)) continue;
      const relPath = relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (!ALLOWED_RELATIVE_PATHS.has(relPath)) {
        offenders.push(relPath);
      }
    }

    expect(
      offenders,
      "Found a production source file issuing SET TIME ZONE. This reintroduces a " +
        "session under which the installed @prisma/adapter-pg write-path bug " +
        "(ADR-56/ADR-61) applies, defeating the UTC-database-default mitigation. " +
        "If this is a deliberate, reviewed exception, add it to " +
        "ALLOWED_RELATIVE_PATHS in this file with a comment explaining why the " +
        "resulting session is safe.",
    ).toEqual([]);
  });

  it("the disposable-database provisioning script still establishes UTC as the session default", () => {
    const provisionPath = join(
      REPO_ROOT,
      "packages",
      "db",
      "provisioning",
      "provision-roles.mjs",
    );
    const content = readFileSync(provisionPath, "utf8");
    expect(content).toMatch(/ALTER DATABASE[\s\S]*SET timezone TO 'UTC'/i);
  });
});
