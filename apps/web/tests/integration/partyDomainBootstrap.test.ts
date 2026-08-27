import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError } from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import { createSystemClient } from "@noahark/db/system";
import { createParty, getParty } from "@noahark/crm";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  partyCode,
  setupPartyDomainFixture,
  type PartyDomainFixture,
} from "./partyDomainFixture";

describe("P2B — atomic party bootstrap", () => {
  let fixture: PartyDomainFixture | undefined;
  const extraUserIds: string[] = [];

  afterEach(async () => {
    for (const id of extraUserIds) await cleanupUser(id).catch(() => undefined);
    extraUserIds.length = 0;
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("creates party and first assignment atomically", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, leA } = fixture;
    const created = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Atomic Co",
    });
    expect(created.assignment.partyId).toBe(created.party.id);
    expect(created.assignment.legalEntityId).toBe(leA.id);
    expect(created.assignment.status).toBe("ACTIVE");
    const loaded = await getParty(ctxA, created.party.id);
    expect(loaded.id).toBe(created.party.id);
    const assignments = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) =>
        tx.partyLegalEntityAssignment.count({
          where: { partyId: created.party.id, status: "ACTIVE" },
        }),
    );
    expect(assignments).toBe(1);
  });

  it("rolls back party when initial role creation fails uniqueness", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, leA } = fixture;
    const roleCode = partyCode("CUST");
    await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "First Co",
      customerRole: { code: roleCode },
    });
    const before = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) => tx.party.count({ where: { tenantId: ctxA.tenantId } }),
    );
    await expect(
      createParty(ctxA, {
        ownerLegalEntityId: leA.id,
        code: partyCode(),
        partyType: "ORGANISATION",
        legalName: "Second Co",
        customerRole: { code: roleCode },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    const after = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) => tx.party.count({ where: { tenantId: ctxA.tenantId } }),
    );
    expect(after).toBe(before);
  });

  it("rolls back party when assignment insert fails on a bad legal-entity FK", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, leA } = fixture;
    const code = partyCode();
    await expect(
      withTenantContext(
        {
          tenantId: ctxA.tenantId,
          legalEntityIds: ctxA.legalEntityIds,
          userId: ctxA.userId,
        },
        async (tx) => {
          await tx.party.create({
            data: {
              tenantId: ctxA.tenantId,
              ownerLegalEntityId: leA.id,
              code,
              partyType: "ORGANISATION",
              legalName: "Orphan Probe",
              normalisedName: "orphan probe",
            },
          });
          await tx.partyLegalEntityAssignment.create({
            data: {
              tenantId: ctxA.tenantId,
              partyId: "does-not-exist",
              legalEntityId: leA.id,
            },
          });
        },
      ),
    ).rejects.toBeTruthy();
    const leftover = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) => tx.party.findFirst({ where: { tenantId: ctxA.tenantId, code } }),
    );
    expect(leftover).toBeNull();
  });

  it("does not return an unassigned party from the public create service", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, leA } = fixture;
    const created = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "INDIVIDUAL",
      givenName: "Ada",
      familyName: "Lovelace",
    });
    const db = createSystemClient();
    const count = await db.partyLegalEntityAssignment.count({
      where: { partyId: created.party.id, status: "ACTIVE" },
    });
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("rejects owner legal entity outside trusted context", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, leB } = fixture;
    await expect(
      createParty(ctxA, {
        ownerLegalEntityId: leB.id,
        code: partyCode(),
        partyType: "ORGANISATION",
        legalName: "Nope",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("treats unknown party as not found", async () => {
    fixture = await setupPartyDomainFixture();
    await expect(getParty(fixture.ctxA, "missing-id")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
