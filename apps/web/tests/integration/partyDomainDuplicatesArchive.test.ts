import { afterEach, describe, expect, it } from "vitest";
import { StaleVersionError } from "@noahark/core";
import {
  archiveParty,
  createAssignment,
  createContact,
  createParty,
  listDuplicateCandidates,
  listParties,
  updateParty,
} from "@noahark/crm";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  partyCode,
  setupPartyDomainFixture,
  type PartyDomainFixture,
} from "./partyDomainFixture";

describe("P2B — duplicates and archive", () => {
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

  it("duplicate-candidate warning is advisory and does not auto-merge", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, leA } = fixture;
    const first = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Acme Duplicate",
      taxIdentifier: "TAX-123",
    });
    const second = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Acme Duplicate",
      taxIdentifier: "TAX-123",
    });
    expect(second.party.id).not.toBe(first.party.id);
    expect(second.duplicateCandidates.some((c) => c.partyId === first.party.id)).toBe(
      true,
    );
    expect(second.duplicateCandidates[0]?.matchReasons).toEqual(
      expect.arrayContaining(["name", "tax_identifier"]),
    );
    expect(
      JSON.stringify(second.duplicateCandidates).includes("TAX-123") === false ||
        second.duplicateCandidates.every((c) => !("taxIdentifier" in c)),
    ).toBe(true);
  });

  it("does not disclose invisible candidates", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, ctxB, leA } = fixture;
    await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Hidden Twin",
    });
    const seen = await listDuplicateCandidates(ctxB, {
      partyType: "ORGANISATION",
      legalName: "Hidden Twin",
    });
    expect(seen).toEqual([]);
  });

  it("archived parties are excluded from default lists and archive is version-gated", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, leA } = fixture;
    const created = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Archive Me",
    });
    const bumped = await updateParty(ctxA, created.party.id, {
      expectedVersion: created.party.version,
      tradingName: "bump-for-stale",
    });
    await expect(
      archiveParty(ctxA, created.party.id, created.party.version),
    ).rejects.toBeInstanceOf(StaleVersionError);
    const archived = await archiveParty(ctxA, created.party.id, bumped.version);
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.archivedAt).not.toBeNull();
    const listed = await listParties(ctxA, {});
    expect(listed.parties.some((p) => p.id === created.party.id)).toBe(false);
    const withArchived = await listParties(ctxA, { includeArchived: true });
    expect(withArchived.parties.some((p) => p.id === created.party.id)).toBe(true);
  });

  it("does not merge or mutate another party when creating a duplicate", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const first = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Stay Put",
    });
    await createAssignment(ctxAB, {
      partyId: first.party.id,
      legalEntityId: leB.id,
    });
    await createContact(ctxA, {
      partyId: first.party.id,
      givenName: "Pat",
      email: "pat@stay.example",
    });
    await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Stay Put",
      contactEmailForDuplicateCheck: "pat@stay.example",
    });
    const still = await listParties(ctxA, { q: "stay put" });
    expect(still.parties.filter((p) => p.legalName === "Stay Put").length).toBe(2);
  });
});
