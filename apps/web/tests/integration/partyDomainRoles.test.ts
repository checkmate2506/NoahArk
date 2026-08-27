import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import {
  createAssignment,
  createCustomerRole,
  createParty,
  getParty,
  updateCustomerRole,
} from "@noahark/crm";
import { createVendorRole } from "@noahark/purchasing";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  partyCode,
  setupPartyDomainFixture,
  type PartyDomainFixture,
} from "./partyDomainFixture";

describe("P2B — customer and vendor roles", () => {
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

  it("supports customer-only, vendor-only and dual-role with independent codes", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, leA } = fixture;
    const customerOnly = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Cust Co",
      customerRole: { code: partyCode("C") },
    });
    expect(customerOnly.customerRole?.code).toBeTruthy();
    expect(customerOnly.vendorRole).toBeNull();

    const vendorOnly = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Vend Co",
      vendorRole: { code: partyCode("V") },
    });
    expect(vendorOnly.vendorRole?.code).toBeTruthy();
    expect(vendorOnly.customerRole).toBeNull();

    const dual = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Both Co",
      customerRole: { code: partyCode("C") },
      vendorRole: { code: partyCode("V") },
    });
    expect(dual.customerRole?.assignmentId).toBe(dual.assignment.id);
    expect(dual.vendorRole?.assignmentId).toBe(dual.assignment.id);
    expect(dual.customerRole?.code).not.toBe(dual.vendorRole?.code);
  });

  it("rejects cross-entity assignment-id substitution without disclosure", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, ctxAB, ctxB, leA, leB } = fixture;
    const created = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Role Iso",
    });
    const bAssign = await createAssignment(ctxAB, {
      partyId: created.party.id,
      legalEntityId: leB.id,
    });
    await expect(
      createCustomerRole(ctxA, { assignmentId: bAssign.id, code: partyCode("C") }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createVendorRole(ctxA, { assignmentId: bAssign.id, code: partyCode("V") }),
    ).rejects.toBeInstanceOf(NotFoundError);
    const vendor = await createVendorRole(ctxB, {
      assignmentId: bAssign.id,
      code: partyCode("V"),
    });
    expect(vendor.legalEntityId).toBe(leB.id);
  });

  it("duplicate customer and vendor code races yield one success each", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, leA } = fixture;
    const a = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Race A",
    });
    const b = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Race B",
    });
    const custCode = partyCode("C");
    const vendCode = partyCode("V");
    const custRace = await Promise.allSettled([
      createCustomerRole(ctxA, { assignmentId: a.assignment.id, code: custCode }),
      createCustomerRole(ctxA, { assignmentId: b.assignment.id, code: custCode }),
    ]);
    expect(custRace.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      custRace.filter(
        (r) => r.status === "rejected" && r.reason instanceof ConflictError,
      ),
    ).toHaveLength(1);
    const vendRace = await Promise.allSettled([
      createVendorRole(ctxA, { assignmentId: a.assignment.id, code: vendCode }),
      createVendorRole(ctxA, { assignmentId: b.assignment.id, code: vendCode }),
    ]);
    expect(vendRace.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      vendRace.filter(
        (r) => r.status === "rejected" && r.reason instanceof ConflictError,
      ),
    ).toHaveLength(1);
  });

  it("role mutation does not alter party master fields", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, leA } = fixture;
    const created = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Stable Name",
      customerRole: { code: partyCode("C") },
    });
    const before = await getParty(ctxA, created.party.id);
    await updateCustomerRole(ctxA, created.customerRole!.id, {
      expectedVersion: created.customerRole!.version,
      code: partyCode("C2"),
    });
    const after = await getParty(ctxA, created.party.id);
    expect(after.legalName).toBe(before.legalName);
    expect(after.version).toBe(before.version);
    expect(after.ownerLegalEntityId).toBe(before.ownerLegalEntityId);
    const partyRows = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) => tx.party.findFirst({ where: { id: created.party.id } }),
    );
    expect(partyRows?.legalName).toBe("Stable Name");
  });
});
