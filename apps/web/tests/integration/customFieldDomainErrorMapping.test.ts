import { afterEach, describe, expect, it } from "vitest";
import { Prisma, withTenantContext } from "@noahark/db";
import { tenantContextInput, ValidationError } from "@noahark/core";
import { mapCustomFieldDbError } from "@noahark/custom-fields";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  createStringDefinition,
  createTestParty,
  setupCustomFieldDomainFixture,
  type CustomFieldDomainFixture,
} from "./customFieldDomainFixture";

function collectStructuredShape(error: unknown): {
  codes: string[];
  originalCodes: string[];
  kinds: string[];
  className: string;
  isKnownRequest: boolean;
  topLevelCode: string | null;
} {
  const codes: string[] = [];
  const originalCodes: string[] = [];
  const kinds: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const rec = node as {
      code?: unknown;
      originalCode?: unknown;
      kind?: unknown;
      cause?: unknown;
      meta?: { driverAdapterError?: unknown };
    };
    if (typeof rec.code === "string") codes.push(rec.code);
    if (typeof rec.originalCode === "string") originalCodes.push(rec.originalCode);
    if (typeof rec.kind === "string") kinds.push(rec.kind);
    walk(rec.cause);
    walk(rec.meta?.driverAdapterError);
  };
  walk(error);
  return {
    codes,
    originalCodes,
    kinds,
    className: error instanceof Error ? error.constructor.name : typeof error,
    isKnownRequest: error instanceof Prisma.PrismaClientKnownRequestError,
    topLevelCode:
      error instanceof Prisma.PrismaClientKnownRequestError ? error.code : null,
  };
}

function leak(text: string) {
  expect(text).not.toMatch(/SQLSTATE/i);
  expect(text).not.toMatch(/23514/);
  expect(text).not.toMatch(/prisma/i);
  expect(text).not.toMatch(/pg_/);
  expect(text).not.toMatch(/_check/);
  expect(text).not.toMatch(/_key/);
  expect(text).not.toMatch(/_fkey/);
  expect(text).not.toMatch(/_trg/);
  expect(text).not.toMatch(/custom_field_value_phase2/);
}

describe("P2C.3 — custom-field error mapping", () => {
  let fixture: CustomFieldDomainFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("captures the sanitized live 23514 shape and maps it without leaking internals", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definition = await createStringDefinition(ctxA, "party");

    let raw: unknown;
    try {
      await withTenantContext(tenantContextInput(ctxA), async (tx) => {
        await tx.customFieldValue.create({
          data: {
            tenantId: ctxA.tenantId,
            legalEntityId: leA.id,
            definitionId: definition.id,
            entityType: "party",
            entityId: party.party.id,
            valueText: "one",
            valueInteger: 1,
          },
        });
      });
    } catch (error) {
      raw = error;
    }
    expect(raw).toBeDefined();
    const shape = collectStructuredShape(raw);
    expect(shape.className).toBe("PrismaClientKnownRequestError");
    expect(shape.isKnownRequest).toBe(true);
    expect(shape.originalCodes).toContain("23514");
    expect(shape.codes.includes("23514") || shape.originalCodes.includes("23514")).toBe(
      true,
    );

    const versionRows = await withTenantContext(tenantContextInput(ctxA), async (tx) => {
      return tx.$queryRaw<{ v: string }[]>`SELECT version() AS v`;
    });
    expect(versionRows[0]?.v ?? "").toMatch(/PostgreSQL 18\.4/);

    expect(() => mapCustomFieldDbError(raw, "Custom field value")).toThrow(
      ValidationError,
    );
    try {
      mapCustomFieldDbError(raw, "Custom field value");
    } catch (mapped) {
      expect(mapped).toBeInstanceOf(ValidationError);
      const err = mapped as ValidationError;
      expect(err.message).toBe("Custom field value failed a storage constraint");
      leak(err.message);
      leak(JSON.stringify(err.details ?? {}));
    }
  });
});
