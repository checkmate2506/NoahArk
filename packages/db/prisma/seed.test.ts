import { describe, expect, it } from "vitest";
import { assertSeedIsAllowed, assertSeedTargetIsSafe } from "./seed";

describe("assertSeedIsAllowed (F-1)", () => {
  it("rejects when NODE_ENV=production regardless of ALLOW_DEMO_SEED", () => {
    expect(() =>
      assertSeedIsAllowed({ NODE_ENV: "production", ALLOW_DEMO_SEED: "1" }),
    ).toThrow(/NODE_ENV=production/);
  });

  it("rejects when ALLOW_DEMO_SEED is missing", () => {
    expect(() => assertSeedIsAllowed({ NODE_ENV: "development" })).toThrow(
      /ALLOW_DEMO_SEED/,
    );
  });

  it("rejects when ALLOW_DEMO_SEED is not exactly '1'", () => {
    expect(() =>
      assertSeedIsAllowed({ NODE_ENV: "development", ALLOW_DEMO_SEED: "true" }),
    ).toThrow(/ALLOW_DEMO_SEED/);
  });

  it("allows development seeding with explicit opt-in", () => {
    expect(() =>
      assertSeedIsAllowed({ NODE_ENV: "development", ALLOW_DEMO_SEED: "1" }),
    ).not.toThrow();
  });

  it("allows test seeding with explicit opt-in", () => {
    expect(() =>
      assertSeedIsAllowed({ NODE_ENV: "test", ALLOW_DEMO_SEED: "1" }),
    ).not.toThrow();
  });
});

describe("assertSeedTargetIsSafe (F-1 heuristic backstop)", () => {
  it("rejects an Azure-managed Postgres host", () => {
    expect(() =>
      assertSeedTargetIsSafe(
        "postgresql://user:pass@myserver.postgres.database.azure.com:5432/noahark",
      ),
    ).toThrow(/production target/);
  });

  it('rejects a host containing "prod"', () => {
    expect(() =>
      assertSeedTargetIsSafe("postgresql://user:pass@noahark-prod.internal:5432/noahark"),
    ).toThrow(/production target/);
  });

  it('rejects a database name containing "production"', () => {
    expect(() =>
      assertSeedTargetIsSafe("postgresql://user:pass@localhost:5432/noahark_production"),
    ).toThrow(/production target/);
  });

  it("allows a local development target", () => {
    expect(() =>
      assertSeedTargetIsSafe("postgresql://postgres:postgres@127.0.0.1:55432/noahark"),
    ).not.toThrow();
  });

  it("allows a disposable/test database name", () => {
    expect(() =>
      assertSeedTargetIsSafe(
        "postgresql://postgres:postgres@127.0.0.1:55432/noahark_test",
      ),
    ).not.toThrow();
  });

  it("rejects an unparsable connection string", () => {
    expect(() => assertSeedTargetIsSafe("not-a-url")).toThrow(
      /not a valid connection string/,
    );
  });
});
