import { afterEach, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError, StaleVersionError } from "@noahark/core";
import {
  createAddress,
  createAssignment,
  createContact,
  createParty,
  getParty,
  transferPartyOwnership,
  updateParty,
} from "@noahark/crm";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  partyCode,
  setupPartyDomainFixture,
  type PartyDomainFixture,
} from "./partyDomainFixture";

describe("P2B — ownership and transfer", () => {
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

  async function ownedParty() {
    fixture = await setupPartyDomainFixture();
    const created = await createParty(fixture.ctxA, {
      ownerLegalEntityId: fixture.leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Owner Co",
    });
    await createAssignment(fixture.ctxAB, {
      partyId: created.party.id,
      legalEntityId: fixture.leB.id,
    });
    return created;
  }

  it("owner can mutate party/contact/address; assigned non-owner can read but not mutate", async () => {
    const created = await ownedParty();
    const { ctxA, ctxB } = fixture!;
    const updated = await updateParty(ctxA, created.party.id, {
      expectedVersion: created.party.version,
      tradingName: "Owned Trading",
    });
    expect(updated.tradingName).toBe("Owned Trading");
    const seenByB = await getParty(ctxB, created.party.id);
    expect(seenByB.tradingName).toBe("Owned Trading");
    await expect(
      updateParty(ctxB, created.party.id, {
        expectedVersion: updated.version,
        tradingName: "Hijack",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const contact = await createContact(ctxA, {
      partyId: created.party.id,
      givenName: "Pat",
      email: "pat@owner.example",
    });
    await expect(
      createContact(ctxB, {
        partyId: created.party.id,
        givenName: "Eve",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createAddress(ctxB, {
        partyId: created.party.id,
        addressType: "GENERAL",
        line1: "1 Street",
        countryCode: "US",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(contact.givenName).toBe("Pat");
  });

  it("unrelated entity cannot read the party", async () => {
    fixture = await setupPartyDomainFixture();
    const created = await createParty(fixture.ctxA, {
      ownerLegalEntityId: fixture.leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Secret Co",
    });
    await expect(getParty(fixture.ctxB, created.party.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("A-only and B-only transfer fail; A+B transfer succeeds and mutation authority changes", async () => {
    const created = await ownedParty();
    const { ctxA, ctxB, ctxAB, leB } = fixture!;
    await expect(
      transferPartyOwnership(ctxA, created.party.id, {
        newOwnerLegalEntityId: leB.id,
        expectedVersion: created.party.version,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      transferPartyOwnership(ctxB, created.party.id, {
        newOwnerLegalEntityId: leB.id,
        expectedVersion: created.party.version,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const transferred = await transferPartyOwnership(ctxAB, created.party.id, {
      newOwnerLegalEntityId: leB.id,
      expectedVersion: created.party.version,
    });
    expect(transferred.ownerLegalEntityId).toBe(leB.id);
    await expect(
      updateParty(ctxA, created.party.id, {
        expectedVersion: transferred.version,
        tradingName: "A after transfer",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const after = await updateParty(ctxB, created.party.id, {
      expectedVersion: transferred.version,
      tradingName: "B owns now",
    });
    expect(after.tradingName).toBe("B owns now");
  });

  it("concurrent transfers produce exactly one success", async () => {
    const created = await ownedParty();
    const { ctxAB, leB } = fixture!;
    const results = await Promise.allSettled([
      transferPartyOwnership(ctxAB, created.party.id, {
        newOwnerLegalEntityId: leB.id,
        expectedVersion: created.party.version,
      }),
      transferPartyOwnership(ctxAB, created.party.id, {
        newOwnerLegalEntityId: leB.id,
        expectedVersion: created.party.version,
      }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const rejection = failed[0] as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(StaleVersionError);
  });

  it("stale version transfer fails", async () => {
    const created = await ownedParty();
    const { ctxAB, ctxA, leB } = fixture!;
    await updateParty(ctxA, created.party.id, {
      expectedVersion: created.party.version,
      tradingName: "bump",
    });
    await expect(
      transferPartyOwnership(ctxAB, created.party.id, {
        newOwnerLegalEntityId: leB.id,
        expectedVersion: created.party.version,
      }),
    ).rejects.toBeInstanceOf(StaleVersionError);
  });
});
