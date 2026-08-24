import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

/**
 * N-3 / P1E-2 (Phase 1D / 1F): proves the repo-root ESLint config's
 * privileged-client import boundary (see eslint.config.mjs) actually
 * rejects every bypass form Phase 1E's live probe found working — static
 * import, dynamic import(), require(), and a relative path into
 * systemClient/workerClient — from application-runtime code, while still
 * permitting them from test fixtures, from packages/jobs' legitimate
 * worker-only use, and leaving the ordinary RLS-enforced @noahark/db
 * client untouched everywhere. Runs the real config via ESLint's Node API
 * against synthetic in-memory source, rather than a permanently-broken
 * fixture file left in the tree.
 *
 * cwd is pinned to the repo root (not `apps/web`) because ESLint resolves
 * flat-config `files` globs relative to cwd, and this suite's own cwd is
 * `apps/web`.
 */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /^\/([a-zA-Z]):/,
  "$1:",
);

async function restrictedMessages(filePath: string, code: string) {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const results = await eslint.lintText(code, { filePath: `${REPO_ROOT}/${filePath}` });
  return (results[0]?.messages ?? []).filter(
    (m) => m.ruleId === "no-restricted-imports" || m.ruleId === "no-restricted-syntax",
  );
}

describe("ESLint import boundary — application runtime cannot reach owner/worker Prisma clients (N-3)", () => {
  it("rejects @noahark/db/system from apps/web/lib", async () => {
    const messages = await restrictedMessages(
      "apps/web/lib/someService.ts",
      `import { createSystemClient } from "@noahark/db/system";\nexport const x = createSystemClient;\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("rejects @noahark/db/worker from an API route", async () => {
    const messages = await restrictedMessages(
      "apps/web/app/api/v1/example/route.ts",
      `import { getWorkerClient } from "@noahark/db/worker";\nexport const x = getWorkerClient;\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("rejects @noahark/db/system from middleware.ts", async () => {
    const messages = await restrictedMessages(
      "apps/web/middleware.ts",
      `import { createSystemClient } from "@noahark/db/system";\nexport const x = createSystemClient;\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("allows the ordinary RLS-enforced @noahark/db client from apps/web/lib", async () => {
    const messages = await restrictedMessages(
      "apps/web/lib/someService.ts",
      `import { getIdentityClient } from "@noahark/db";\nexport const x = getIdentityClient;\n`,
    );
    expect(messages.length).toBe(0);
  });

  it("allows @noahark/db/system from test fixtures (outside the runtime boundary)", async () => {
    const messages = await restrictedMessages(
      "apps/web/tests/integration/someFixture.test.ts",
      `import { createSystemClient } from "@noahark/db/system";\nexport const x = createSystemClient;\n`,
    );
    expect(messages.length).toBe(0);
  });
});

describe("ESLint import boundary — bypass forms Phase 1E found (P1E-2)", () => {
  it("rejects dynamic import() of @noahark/db/system", async () => {
    const messages = await restrictedMessages(
      "apps/web/lib/someService.ts",
      `export const x = async () => (await import("@noahark/db/system")).createSystemClient();\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("rejects dynamic import() of @noahark/db/worker", async () => {
    const messages = await restrictedMessages(
      "apps/web/app/api/v1/example/route.ts",
      `export const x = async () => (await import("@noahark/db/worker")).getWorkerClient();\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("rejects require('@noahark/db/system')", async () => {
    const messages = await restrictedMessages(
      "apps/web/lib/someService.ts",
      `const m = require("@noahark/db/system");\nexport const x = m;\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("rejects a relative-path import ending in systemClient", async () => {
    const messages = await restrictedMessages(
      "apps/web/lib/someService.ts",
      `import { createSystemClient } from "../../packages/db/src/systemClient";\nexport const x = createSystemClient;\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("rejects a relative-path import ending in workerClient", async () => {
    const messages = await restrictedMessages(
      "apps/web/lib/someService.ts",
      `import { getWorkerClient } from "../../packages/db/src/workerClient";\nexport const x = getWorkerClient;\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("rejects a dynamic import() of a relative path ending in systemClient", async () => {
    const messages = await restrictedMessages(
      "apps/web/lib/someService.ts",
      `export const x = async () => (await import("../../packages/db/src/systemClient")).createSystemClient();\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("rejects require() of a relative path ending in workerClient", async () => {
    const messages = await restrictedMessages(
      "apps/web/lib/someService.ts",
      `const m = require("../../packages/db/src/workerClient");\nexport const x = m;\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
  });
});

describe("ESLint import boundary — other workspace packages (P1E-2)", () => {
  it("rejects @noahark/db/system from packages/core", async () => {
    const messages = await restrictedMessages(
      "packages/core/src/somewhere.ts",
      `import { createSystemClient } from "@noahark/db/system";\nexport const x = createSystemClient;\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("rejects @noahark/db/worker from packages/authz", async () => {
    const messages = await restrictedMessages(
      "packages/authz/src/somewhere.ts",
      `import { getWorkerClient } from "@noahark/db/worker";\nexport const x = getWorkerClient;\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("allows @noahark/db/worker from packages/jobs (its legitimate, documented use)", async () => {
    const messages = await restrictedMessages(
      "packages/jobs/src/queue.ts",
      `import { getWorkerClient } from "@noahark/db/worker";\nexport const x = getWorkerClient;\n`,
    );
    expect(messages.length).toBe(0);
  });

  it("still rejects @noahark/db/system from packages/jobs (never legitimate there)", async () => {
    const messages = await restrictedMessages(
      "packages/jobs/src/queue.ts",
      `import { createSystemClient } from "@noahark/db/system";\nexport const x = createSystemClient;\n`,
    );
    expect(messages.length).toBeGreaterThan(0);
  });

  it("allows @noahark/db/system and /worker from packages/db's own source", async () => {
    const messages = await restrictedMessages(
      "packages/db/src/somewhereElse.ts",
      `export { createSystemClient } from "./systemClient";\nexport { getWorkerClient } from "./workerClient";\n`,
    );
    expect(messages.length).toBe(0);
  });
});
