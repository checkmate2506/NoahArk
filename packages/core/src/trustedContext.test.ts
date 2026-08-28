import { describe, expect, it } from "vitest";
import type { AccessContext } from "./context";
import { ForbiddenError, UnauthenticatedError, ValidationError } from "./errors";
import {
  afterCreatedAtId,
  boundPageSize,
  decodeCreatedAtIdCursor,
  encodeCreatedAtIdCursor,
} from "./pagination";
import {
  assertHasLegalEntityAccess,
  assertTrustedContext,
  requireExpectedVersion,
  requireNonEmptyLegalEntityScope,
  tenantContextInput,
} from "./trustedContext";

function ctx(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    requestId: "r1",
    userId: "u1",
    tenantId: "t1",
    legalEntityIds: new Set(["le1"]),
    permissions: new Set(),
    legalEntityPermissions: new Map(),
    roleIds: new Set(),
    legalEntityRoleIds: new Map(),
    ...overrides,
  };
}

describe("assertTrustedContext", () => {
  it("accepts a valid trusted context", () => {
    expect(() => assertTrustedContext(ctx())).not.toThrow();
  });

  it("rejects missing actor, tenant, or request identity", () => {
    expect(() => assertTrustedContext(ctx({ userId: "" }))).toThrow(UnauthenticatedError);
    expect(() => assertTrustedContext(ctx({ tenantId: "" }))).toThrow(
      UnauthenticatedError,
    );
    expect(() => assertTrustedContext(ctx({ requestId: "" }))).toThrow(
      UnauthenticatedError,
    );
  });
});

describe("legal-entity scope", () => {
  it("rejects an empty legal-entity set", () => {
    expect(() =>
      requireNonEmptyLegalEntityScope(ctx({ legalEntityIds: new Set() })),
    ).toThrow(ForbiddenError);
  });

  it("asserts access only for legal entities in trusted context", () => {
    const trusted = ctx();
    expect(() => assertHasLegalEntityAccess(trusted, "le1")).not.toThrow();
    expect(() => assertHasLegalEntityAccess(trusted, "le-other")).toThrow(ForbiddenError);
  });
});

describe("requireExpectedVersion", () => {
  it("accepts a positive integer version", () => {
    expect(() => requireExpectedVersion(1, "Party")).not.toThrow();
  });

  it("rejects non-positive or non-integer versions", () => {
    expect(() => requireExpectedVersion(0, "Party")).toThrow(ValidationError);
    expect(() => requireExpectedVersion(-1, "Party")).toThrow(ValidationError);
    expect(() => requireExpectedVersion(1.5, "Party")).toThrow(ValidationError);
  });
});

describe("tenantContextInput", () => {
  it("returns the exact structural tenant-context object", () => {
    const trusted = ctx({ ipAddress: "1.1.1.1" });
    const input = tenantContextInput(trusted);
    expect(input).toEqual({
      tenantId: "t1",
      legalEntityIds: trusted.legalEntityIds,
      userId: "u1",
    });
    expect(Object.keys(input).sort()).toEqual(["legalEntityIds", "tenantId", "userId"]);
    expect(input.legalEntityIds).toBe(trusted.legalEntityIds);
  });
});

describe("pagination", () => {
  it("bounds page size", () => {
    expect(boundPageSize(undefined)).toBe(25);
    expect(boundPageSize(1000)).toBe(100);
    expect(() => boundPageSize(0)).toThrow(ValidationError);
    expect(() => boundPageSize(-2)).toThrow(ValidationError);
  });

  it("round-trips a valid createdAt/id cursor", () => {
    const at = new Date("2026-08-25T10:00:00.000Z");
    const encoded = encodeCreatedAtIdCursor(at, "abc");
    expect(decodeCreatedAtIdCursor(encoded)).toEqual({ createdAt: at, id: "abc" });
    expect(afterCreatedAtId({ createdAt: at, id: "abc" })).toEqual({
      createdAt: at,
      id: "abc",
    });
  });

  it("rejects malformed cursors", () => {
    expect(() => decodeCreatedAtIdCursor("%%%")).toThrow(ValidationError);
    expect(() => decodeCreatedAtIdCursor("")).toThrow(ValidationError);
    expect(() =>
      decodeCreatedAtIdCursor(Buffer.from("not-a-date|id", "utf8").toString("base64url")),
    ).toThrow(ValidationError);
  });
});
