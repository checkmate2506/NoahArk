import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { ForbiddenError, NotFoundError } from "@noahark/core";
import { createAppClient, withTenantContext } from "@noahark/db";
import { createParty, getParty, listParties } from "@noahark/crm";
import {
  cleanupTenant,
  cleanupUser,
  createTestLegalEntity,
  grantLegalEntityAccessDirect,
  setupTestTenant,
  buildContext,
} from "./testHelpers";
import {
  partyCode,
  setupPartyDomainFixture,
  type PartyDomainFixture,
} from "./partyDomainFixture";

describe("P2B — isolation", () => {
  let fixture: PartyDomainFixture | undefined;
  let other: Awaited<ReturnType<typeof setupTestTenant>> | undefined;

  afterEach(async () => {
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
    if (other) {
      await cleanupTenant(other.tenantId).catch(() => undefined);
      await cleanupUser(other.adminUserId).catch(() => undefined);
      other = undefined;
    }
  });

  it("blocks cross-tenant reads and mutations", async () => {
    fixture = await setupPartyDomainFixture();
    other = await setupTestTenant();
    const otherLe = await createTestLegalEntity(other.tenantId, "SG");
    await grantLegalEntityAccessDirect(other.tenantId, otherLe.id, other.adminUserId);
    const otherCtx = await buildContext(other.adminUserId, other.tenantId);
    const created = await createParty(fixture.ctxA, {
      ownerLegalEntityId: fixture.leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Tenant A Co",
    });
    await expect(getParty(otherCtx, created.party.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const listed = await listParties(otherCtx, {});
    expect(listed.parties.some((p) => p.id === created.party.id)).toBe(false);
  });

  it("keeps SG/MY/ID legal entities and multi-entity visibility distinct", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, ctxB, leA, leId } = fixture;
    await grantLegalEntityAccessDirect(
      fixture.setup.tenantId,
      leId.id,
      fixture.setup.adminUserId,
    );
    const ctxABC = await buildContext(fixture.setup.adminUserId, fixture.setup.tenantId);
    const sg = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "SG Co",
    });
    const idn = await createParty(ctxABC, {
      ownerLegalEntityId: leId.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "ID Co",
    });
    await expect(getParty(ctxB, sg.party.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(getParty(ctxA, idn.party.id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await getParty(ctxABC, sg.party.id)).id).toBe(sg.party.id);
    expect((await getParty(ctxABC, idn.party.id)).id).toBe(idn.party.id);
  });

  it("pooled-connection switching does not leak party rows", async () => {
    fixture = await setupPartyDomainFixture();
    other = await setupTestTenant();
    const otherLe = await createTestLegalEntity(other.tenantId, "MY");
    await grantLegalEntityAccessDirect(other.tenantId, otherLe.id, other.adminUserId);
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const client = createAppClient(url, { max: 1 });
    try {
      const created = await createParty(fixture.ctxA, {
        ownerLegalEntityId: fixture.leA.id,
        code: partyCode(),
        partyType: "ORGANISATION",
        legalName: "Pool Co",
      });
      await withTenantContext(
        { tenantId: fixture.setup.tenantId, legalEntityIds: fixture.ctxA.legalEntityIds },
        async (tx) => {
          const rows = await tx.party.findMany({ where: { id: created.party.id } });
          expect(rows).toHaveLength(1);
        },
        client,
      );
      await withTenantContext(
        { tenantId: other.tenantId, legalEntityIds: new Set([otherLe.id]) },
        async (tx) => {
          const rows = await tx.party.findMany({ where: { id: created.party.id } });
          expect(rows).toHaveLength(0);
        },
        client,
      );
    } finally {
      await client.$disconnect();
    }
  });

  it("empty legal-entity context fails closed", async () => {
    fixture = await setupPartyDomainFixture();
    const empty = {
      ...fixture.ctxA,
      legalEntityIds: new Set<string>(),
    };
    await expect(
      createParty(empty, {
        ownerLegalEntityId: fixture.leA.id,
        code: partyCode(),
        partyType: "ORGANISATION",
        legalName: "Empty",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("noahark_worker has zero access to party tables", async () => {
    fixture = await setupPartyDomainFixture();
    await createParty(fixture.ctxA, {
      ownerLegalEntityId: fixture.leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Worker Denied",
    });
    const c = new pg.Client({ connectionString: process.env.DATABASE_WORKER_URL });
    await c.connect();
    try {
      await expect(c.query("SELECT * FROM party LIMIT 1")).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await c.end();
    }
  });
});
