import { describe, expect, it } from "vitest";
import { loadEnv, __resetEnvCacheForTests } from "./env";

const BASE_ENV = {
  NODE_ENV: "development",
  LOG_LEVEL: "info",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  AUTH_URL: "http://localhost:3000",
  FILES_LOCAL_ROOT: "./.data/files",
  EMAIL_PROVIDER: "console",
} as const;

function envWith(overrides: Record<string, string>): NodeJS.ProcessEnv {
  __resetEnvCacheForTests();
  return { ...BASE_ENV, ...overrides };
}

describe("loadEnv — AUTH_SECRET validation (F-10)", () => {
  it("accepts a real, high-entropy secret", () => {
    const env = envWith({ AUTH_SECRET: "bSKyIF50I0cFh3rPWddSSFnH54UymNIY8NBQQdSB+Vo=" });
    expect(() => loadEnv(env)).not.toThrow();
  });

  it("rejects a secret shorter than 32 characters", () => {
    const env = envWith({ AUTH_SECRET: "too-short" });
    expect(() => loadEnv(env)).toThrow(/at least 32 characters/);
  });

  it("rejects the exact .env.example placeholder value", () => {
    const env = envWith({ AUTH_SECRET: "replace-with-a-real-random-secret" });
    expect(() => loadEnv(env)).toThrow(/placeholder/);
  });

  it("rejects known placeholder values case-insensitively", () => {
    const env = envWith({ AUTH_SECRET: "REPLACE-WITH-A-REAL-RANDOM-SECRET" });
    expect(() => loadEnv(env)).toThrow(/placeholder/);
  });

  it("rejects a low-entropy padded value that merely satisfies the length check", () => {
    const env = envWith({ AUTH_SECRET: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(() => loadEnv(env)).toThrow(/entropy/);
  });

  it("rejects a short secret in production even if not a known placeholder", () => {
    const env = envWith({
      NODE_ENV: "production",
      AUTH_SECRET: "just-barely-thirty-two-characters!!",
    });
    expect(() => loadEnv(env)).toThrow(/44 characters in production/);
  });

  it("accepts a 44+ character secret in production", () => {
    const env = envWith({
      NODE_ENV: "production",
      AUTH_SECRET: "bSKyIF50I0cFh3rPWddSSFnH54UymNIY8NBQQdSB+Vo=extra",
    });
    expect(() => loadEnv(env)).not.toThrow();
  });
});

describe("loadEnv — N-3 (Phase 1D): does not require administrative database credentials", () => {
  // The running application must be able to boot with only a
  // least-privileged `noahark_app` connection. DATABASE_MIGRATION_URL
  // (owner/superuser, bypasses RLS) and DATABASE_WORKER_URL (cross-tenant
  // queue role) are read directly from process.env by the tooling that
  // actually needs them (systemClient.ts, workerClient.ts, seed.ts,
  // prisma.config.ts) — they must never be required by this schema.
  it("succeeds with only DATABASE_URL set — no DATABASE_MIGRATION_URL or DATABASE_WORKER_URL present at all", () => {
    __resetEnvCacheForTests();
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
      AUTH_URL: "http://localhost:3000",
      FILES_LOCAL_ROOT: "./.data/files",
      EMAIL_PROVIDER: "console",
      AUTH_SECRET: "bSKyIF50I0cFh3rPWddSSFnH54UymNIY8NBQQdSB+Vo=",
    };
    expect("DATABASE_MIGRATION_URL" in env).toBe(false);
    expect("DATABASE_WORKER_URL" in env).toBe(false);
    expect(() => loadEnv(env)).not.toThrow();
  });

  it("does not surface DATABASE_MIGRATION_URL or DATABASE_WORKER_URL on the parsed result even when present in process.env", () => {
    const env = envWith({
      AUTH_SECRET: "bSKyIF50I0cFh3rPWddSSFnH54UymNIY8NBQQdSB+Vo=",
      DATABASE_MIGRATION_URL: "postgresql://owner:owner@localhost:5432/db",
      DATABASE_WORKER_URL: "postgresql://worker:worker@localhost:5432/db",
    });
    const parsed = loadEnv(env);
    expect(parsed).not.toHaveProperty("DATABASE_MIGRATION_URL");
    expect(parsed).not.toHaveProperty("DATABASE_WORKER_URL");
  });
});
