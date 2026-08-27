import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import {
  createAssignment,
  createParty,
  getAssignment,
  revokeAssignment,
} from "@noahark/crm";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  partyCode,
  setupPartyDomainFixture,
  type PartyDomainFixture,
} from "./partyDomainFixture";

describe("P2B — assignment invariant", () => {
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

  it("creates a second assignment and rejects duplicate concurrent assignment", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, ctxAB, ctxB, leA, leB } = fixture;
    const created = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Assign Co",
    });
    const second = await createAssignment(ctxAB, {
      partyId: created.party.id,
      legalEntityId: leB.id,
    });
    expect(second.legalEntityId).toBe(leB.id);
    const races = await Promise.allSettled([
      createAssignment(ctxB, {
        partyId: created.party.id,
        legalEntityId: leB.id,
      }),
      createAssignment(ctxAB, {
        partyId: created.party.id,
        legalEntityId: leB.id,
      }),
    ]);
    expect(races.filter((r) => r.status === "fulfilled")).toHaveLength(0);
    expect(
      races.every((r) => r.status === "rejected" && r.reason instanceof ConflictError),
    ).toBe(true);
  });

  it("revoking the last active assignment fails; revoking one of many succeeds", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const created = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Keep One",
    });
    await expect(
      revokeAssignment(ctxA, created.assignment.id, created.assignment.version),
    ).rejects.toBeInstanceOf(ConflictError);
    const extra = await createAssignment(ctxAB, {
      partyId: created.party.id,
      legalEntityId: leB.id,
    });
    const revoked = await revokeAssignment(ctxAB, extra.id, extra.version);
    expect(revoked.status).toBe("ARCHIVED");
    expect(revoked.archivedAt).not.toBeNull();
    const remaining = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) =>
        tx.partyLegalEntityAssignment.count({
          where: { partyId: created.party.id, status: "ACTIVE" },
        }),
    );
    expect(remaining).toBe(1);
  });

  it("concurrent last-assignment revokes cannot leave zero active assignments", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const created = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Race Revoke",
    });
    const extra = await createAssignment(ctxAB, {
      partyId: created.party.id,
      legalEntityId: leB.id,
    });
    const results = await Promise.allSettled([
      revokeAssignment(ctxA, created.assignment.id, created.assignment.version),
      revokeAssignment(ctxAB, extra.id, extra.version),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok.length + failed.length).toBe(2);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const active = await withTenantContext(
      { tenantId: ctxAB.tenantId, legalEntityIds: ctxAB.legalEntityIds },
      (tx) =>
        tx.partyLegalEntityAssignment.count({
          where: { partyId: created.party.id, status: "ACTIVE" },
        }),
    );
    expect(active).toBeGreaterThanOrEqual(1);
  });

  it("entity A cannot enumerate entity B assignment ids", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const created = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Hide B",
    });
    const bAssign = await createAssignment(ctxAB, {
      partyId: created.party.id,
      legalEntityId: leB.id,
    });
    await expect(getAssignment(ctxA, bAssign.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
