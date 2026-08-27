import { afterEach, describe, expect, it } from "vitest";
import { ConflictError } from "@noahark/core";
import { verifyAuditChain, type AuditChainLink } from "@noahark/audit";
import { withTenantContext } from "@noahark/db";
import { createParty, transferPartyOwnership, updateParty } from "@noahark/crm";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  partyCode,
  setupPartyDomainFixture,
  type PartyDomainFixture,
} from "./partyDomainFixture";

function toLinks(
  rows: Array<{
    prevHash: string | null;
    hash: string;
    sequence: bigint;
    tenantId: string | null;
    legalEntityId: string | null;
    actorUserId: string | null;
    actorType: string;
    action: string;
    entityType: string;
    entityId: string | null;
    beforeData: unknown;
    afterData: unknown;
    outcome: string;
    createdAt: Date;
    chainKey: string;
  }>,
): AuditChainLink[] {
  return rows.map((row) => ({
    prevHash: row.prevHash,
    hash: row.hash,
    sequence: row.sequence,
    payload: {
      tenantId: row.tenantId,
      legalEntityId: row.legalEntityId,
      actorUserId: row.actorUserId,
      actorType: row.actorType,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      beforeData: row.beforeData,
      afterData: row.afterData,
      outcome: row.outcome,
      createdAt: row.createdAt.toISOString(),
      chainKey: row.chainKey,
      sequence: row.sequence.toString(),
    },
  }));
}

describe("P2B — audit events", () => {
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

  it("records mutations, ownership transfer metadata, and a valid hash chain", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const created = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Audit Co",
    });
    const updated = await updateParty(ctxA, created.party.id, {
      expectedVersion: created.party.version,
      tradingName: "Audited",
    });
    await transferPartyOwnership(ctxAB, created.party.id, {
      newOwnerLegalEntityId: leB.id,
      expectedVersion: updated.version,
    });

    const events = await withTenantContext(
      { tenantId: ctxAB.tenantId, legalEntityIds: ctxAB.legalEntityIds },
      (tx) =>
        tx.auditEvent.findMany({
          where: { tenantId: ctxAB.tenantId },
          orderBy: { sequence: "asc" },
        }),
    );
    const actions = events.map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "party.created",
        "party_assignment.created",
        "party.updated",
        "party.ownership_transferred",
      ]),
    );
    const transfer = events.find((e) => e.action === "party.ownership_transferred");
    const before = transfer?.beforeData as { ownerLegalEntityId?: string };
    const after = transfer?.afterData as { ownerLegalEntityId?: string };
    expect(before.ownerLegalEntityId).toBe(leA.id);
    expect(after.ownerLegalEntityId).toBe(leB.id);
    expect(JSON.stringify(transfer?.afterData)).not.toMatch(/password|secret|token/i);

    const result = verifyAuditChain(toLinks(events));
    expect(result.valid).toBe(true);
  });

  it("writes no audit event when a mutation rolls back", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, leA } = fixture;
    const roleCode = partyCode("CUST");
    await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "First",
      customerRole: { code: roleCode },
    });
    const before = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) => tx.auditEvent.count({ where: { tenantId: ctxA.tenantId } }),
    );
    await expect(
      createParty(ctxA, {
        ownerLegalEntityId: leA.id,
        code: partyCode(),
        partyType: "ORGANISATION",
        legalName: "Second",
        customerRole: { code: roleCode },
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    const after = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) => tx.auditEvent.count({ where: { tenantId: ctxA.tenantId } }),
    );
    expect(after).toBe(before);
  });
});
