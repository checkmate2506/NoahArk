import { describe, expect, it } from "vitest";
import { resolveRolePasswords, parseDatabaseName } from "./provision-roles.mjs";

describe("resolveRolePasswords (F-4)", () => {
  it("rejects production without explicit passwords", () => {
    expect(() => resolveRolePasswords({ NODE_ENV: "production" })).toThrow(
      /required when NODE_ENV=production/,
    );
  });

  it("accepts production with both passwords explicitly set", () => {
    const result = resolveRolePasswords({
      NODE_ENV: "production",
      NOAHARK_APP_DB_PASSWORD: "app-secret",
      NOAHARK_WORKER_DB_PASSWORD: "worker-secret",
    });
    expect(result).toEqual({
      appPassword: "app-secret",
      workerPassword: "worker-secret",
    });
  });

  it("falls back to well-known dev passwords in development", () => {
    const result = resolveRolePasswords({ NODE_ENV: "development" });
    expect(result.appPassword).toBe("noahark_app");
    expect(result.workerPassword).toBe("noahark_worker");
  });

  it("honours explicit overrides in development", () => {
    const result = resolveRolePasswords({
      NODE_ENV: "development",
      NOAHARK_APP_DB_PASSWORD: "custom",
    });
    expect(result.appPassword).toBe("custom");
    expect(result.workerPassword).toBe("noahark_worker");
  });
});

describe("parseDatabaseName (F-4)", () => {
  it("extracts the database name from a connection string, never hardcoded", () => {
    expect(parseDatabaseName("postgresql://user:pass@localhost:5432/noahark")).toBe(
      "noahark",
    );
    expect(
      parseDatabaseName(
        "postgresql://user:pass@myhost.postgres.database.azure.com:5432/customdb",
      ),
    ).toBe("customdb");
  });

  it("throws when no database name is present", () => {
    expect(() => parseDatabaseName("postgresql://user:pass@localhost:5432/")).toThrow(
      /no database name/,
    );
  });
});
