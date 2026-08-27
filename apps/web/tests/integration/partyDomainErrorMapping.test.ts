import { afterEach, describe, expect, it } from "vitest";
import { ConflictError } from "@noahark/core";
import { Prisma, withTenantContext } from "@noahark/db";
import { createParty, mapPartyDbError } from "@noahark/crm";
import { tenantContextInput } from "@noahark/crm";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  partyCode,
  setupPartyDomainFixture,
  type PartyDomainFixture,
} from "./partyDomainFixture";

function walkErrorCodes(error: unknown): {
  codes: string[];
  prismaCode: string | null;
  isKnownRequest: boolean;
  target: unknown;
} {
  const codes: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const rec = current as { code?: unknown; cause?: unknown };
    if (typeof rec.code === "string") codes.push(rec.code);
    current = rec.cause;
  }
  const isKnownRequest = error instanceof Prisma.PrismaClientKnownRequestError;
  return {
    codes,
    prismaCode: isKnownRequest ? error.code : null,
    isKnownRequest,
    target: isKnownRequest ? error.meta?.target : undefined,
  };
}

describe("P2B — Prisma unique-violation error shape", () => {
  let fixture: PartyDomainFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("records the adapter error shape for a real duplicate customer code", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, leA } = fixture;
    const code = partyCode("C");
    const first = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Error Shape A",
      customerRole: { code },
    });
    const second = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Error Shape B",
    });

    let raw: unknown;
    try {
      await withTenantContext(tenantContextInput(ctxA), async (tx) => {
        await tx.customerRole.create({
          data: {
            tenantId: ctxA.tenantId,
            legalEntityId: leA.id,
            assignmentId: second.assignment.id,
            code,
          },
        });
      });
    } catch (error) {
      raw = error;
    }
    expect(raw).toBeDefined();
    expect(raw).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const known = raw as InstanceType<typeof Prisma.PrismaClientKnownRequestError>;
    const shape = walkErrorCodes(raw);
    expect(shape.isKnownRequest).toBe(true);
    expect(shape.prismaCode).toBe("P2002");
    expect(shape.codes).toEqual(["P2002"]);
    expect(shape.codes.includes("23505")).toBe(false);
    expect(shape.target).toBeUndefined();
    expect(known.meta).toMatchObject({ modelName: "CustomerRole" });
    expect(
      known.meta && "target" in known.meta ? known.meta.target : undefined,
    ).toBeUndefined();
    const adapterError = known.meta?.driverAdapterError as
      { cause?: { kind?: unknown; originalCode?: unknown } } | undefined;
    expect(adapterError?.cause?.kind).toBe("UniqueConstraintViolation");
    expect(adapterError?.cause?.originalCode).toBe("23505");

    let mapped: unknown;
    try {
      mapPartyDbError(raw, "CustomerRole");
    } catch (error) {
      mapped = error;
    }
    expect(mapped).toBeInstanceOf(ConflictError);
    const conflict = mapped as ConflictError;
    expect(conflict.code).toBe("CONFLICT");
    expect(conflict.message).toBe("CustomerRole conflicts with an existing record");
    expect(conflict.message).not.toMatch(
      /prisma|sqlstate|unique_violation|customer_role_/i,
    );

    expect(first.customerRole?.code).toBe(code);
  });
});
