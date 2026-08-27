import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { verifyAuditChain, type AuditChainLink } from "@noahark/audit";
import type { AccessContext } from "@noahark/core";
import { ConflictError, ForbiddenError, ValidationError } from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import {
  archiveParty,
  createAddress,
  createAssignment,
  createContact,
  createParty,
  getContact,
  listContacts,
  updateContact,
} from "@noahark/crm";
import { PENDING_PARTY_CONTACT_PERMISSIONS } from "@noahark/crm";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  partyCode,
  setupPartyDomainFixture,
  type PartyDomainFixture,
} from "./partyDomainFixture";

async function holdPartyRow(
  ctx: AccessContext,
  partyId: string,
  whileHeld: () => Promise<void>,
  then: (client: pg.Client) => Promise<void>,
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    await client.query("SELECT set_config('app.legal_entity_ids', $1, true)", [
      Array.from(ctx.legalEntityIds).join(","),
    ]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [ctx.userId]);
    const locked = await client.query(
      "SELECT id FROM party WHERE id = $1 AND tenant_id = $2 FOR UPDATE",
      [partyId, ctx.tenantId],
    );
    if (locked.rowCount !== 1) throw new Error("failed to lock party row");
    await whileHeld();
    await then(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function archiveLockedParty(
  client: pg.Client,
  tenantId: string,
  partyId: string,
): Promise<void> {
  const result = await client.query(
    `UPDATE party
     SET status = 'ARCHIVED',
         archived_at = now(),
         version = version + 1,
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'ACTIVE'`,
    [partyId, tenantId],
  );
  if (result.rowCount !== 1) throw new Error("failed to archive locked party");
}

async function waitUntilCreateIsBlockedOnPartyLock(): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error("DATABASE_MIGRATION_URL is not set");
  const observer = new pg.Client({ connectionString: url });
  await observer.connect();
  try {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ n: string }>(
        `SELECT count(*)::text AS n
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND wait_event_type = 'Lock'
           AND query ILIKE '%FROM party%'
           AND query ILIKE '%FOR UPDATE%'`,
      );
      if (Number(result.rows[0]?.n ?? 0) > 0) return;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error("timed out waiting for a blocked party FOR UPDATE");
  } finally {
    await observer.end();
  }
}

function toAuditLinks(
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

describe("P2B — contact and address", () => {
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

  it("supports multiple contacts, primary-contact race, masking, and foreign address", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, ctxB, ctxAB, leA, leB } = fixture;
    const created = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Contact Co",
    });
    await createAssignment(ctxAB, {
      partyId: created.party.id,
      legalEntityId: leB.id,
    });
    const c1 = await createContact(ctxA, {
      partyId: created.party.id,
      givenName: "One",
      email: "one@co.example",
      phone: "+65 1111",
    });
    const c2 = await createContact(ctxA, {
      partyId: created.party.id,
      givenName: "Two",
      email: "two@co.example",
      phone: "+65 2222",
    });
    expect(c1.partyId).toBe(created.party.id);
    expect(c2.partyId).toBe(created.party.id);
    expect(c1.email).toBeNull();
    expect(c1.phone).toBeNull();
    const listed = await listContacts(ctxA, created.party.id);
    const detail = await getContact(ctxA, c1.id);
    expect(listed.find((c) => c.id === c1.id)?.email).toBe(detail.email);
    expect(listed.find((c) => c.id === c1.id)?.phone).toBe(detail.phone);

    const unmaskedCtx = {
      ...ctxA,
      permissions: new Set([
        ...ctxA.permissions,
        PENDING_PARTY_CONTACT_PERMISSIONS.EMAIL_READ,
        PENDING_PARTY_CONTACT_PERMISSIONS.PHONE_READ,
      ]),
    };
    const visible = await getContact(unmaskedCtx, c1.id);
    expect(visible.email).toBe("one@co.example");
    expect(visible.phone).toBe("+65 1111");

    const races = await Promise.allSettled([
      updateContact(ctxA, c1.id, { expectedVersion: c1.version, isPrimary: true }),
      updateContact(ctxA, c2.id, { expectedVersion: c2.version, isPrimary: true }),
    ]);
    const ok = races.filter((r) => r.status === "fulfilled");
    expect(ok.length).toBeGreaterThanOrEqual(1);
    if (ok.length === 1) {
      const failed = races.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(
        failed.reason instanceof ConflictError || failed.reason instanceof Error,
      ).toBe(true);
    }
    const after = await listContacts(ctxA, created.party.id);
    expect(after.filter((c) => c.isPrimary)).toHaveLength(1);

    const addr = await createAddress(ctxA, {
      partyId: created.party.id,
      addressType: "BILLING",
      line1: "1 Infinite Loop",
      city: "Cupertino",
      countryCode: "US",
    });
    expect(addr.countryCode).toBe("US");
    await expect(
      createAddress(ctxA, {
        partyId: created.party.id,
        addressType: "GENERAL",
        line1: "x",
        countryCode: "sg",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createContact(ctxB, { partyId: created.party.id, givenName: "No" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects contact and address create after a concurrent archive commits under the row lock", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, leA } = fixture;

    const contactParty = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Archive Race Contact",
    });
    const addressParty = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Archive Race Address",
    });

    const auditBefore = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) =>
        tx.auditEvent.count({
          where: {
            tenantId: ctxA.tenantId,
            action: { in: ["party_contact.created", "party_address.created"] },
          },
        }),
    );

    let contactRejected: Promise<unknown> | undefined;
    await holdPartyRow(
      ctxA,
      contactParty.party.id,
      async () => {
        contactRejected = expect(
          createContact(ctxA, {
            partyId: contactParty.party.id,
            givenName: "Late",
          }),
        ).rejects.toBeInstanceOf(ValidationError);
        await waitUntilCreateIsBlockedOnPartyLock();
      },
      (client) => archiveLockedParty(client, ctxA.tenantId, contactParty.party.id),
    );
    await contactRejected;

    let addressRejected: Promise<unknown> | undefined;
    await holdPartyRow(
      ctxA,
      addressParty.party.id,
      async () => {
        addressRejected = expect(
          createAddress(ctxA, {
            partyId: addressParty.party.id,
            addressType: "GENERAL",
            line1: "Too late",
            countryCode: "SG",
          }),
        ).rejects.toBeInstanceOf(ValidationError);
        await waitUntilCreateIsBlockedOnPartyLock();
      },
      (client) => archiveLockedParty(client, ctxA.tenantId, addressParty.party.id),
    );
    await addressRejected;

    const leftover = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      async (tx) => ({
        contacts: await tx.partyContact.count({
          where: { tenantId: ctxA.tenantId, partyId: contactParty.party.id },
        }),
        addresses: await tx.partyAddress.count({
          where: { tenantId: ctxA.tenantId, partyId: addressParty.party.id },
        }),
        createdAudits: await tx.auditEvent.count({
          where: {
            tenantId: ctxA.tenantId,
            action: { in: ["party_contact.created", "party_address.created"] },
          },
        }),
      }),
    );
    expect(leftover.contacts).toBe(0);
    expect(leftover.addresses).toBe(0);
    expect(leftover.createdAudits).toBe(auditBefore);
  });

  it("allows create to commit when it obtains the lock before archive, then archive succeeds", async () => {
    fixture = await setupPartyDomainFixture();
    const { ctxA, leA } = fixture;
    const created = await createParty(ctxA, {
      ownerLegalEntityId: leA.id,
      code: partyCode(),
      partyType: "ORGANISATION",
      legalName: "Create Then Archive",
    });

    let contactCreate: Promise<{ id: string }> | undefined;
    await holdPartyRow(
      ctxA,
      created.party.id,
      async () => {
        contactCreate = createContact(ctxA, {
          partyId: created.party.id,
          givenName: "On Time",
        });
        await waitUntilCreateIsBlockedOnPartyLock();
      },
      async () => undefined,
    );
    const contact = await contactCreate;
    expect(contact?.id).toBeTruthy();

    let addressCreate: Promise<{ id: string }> | undefined;
    await holdPartyRow(
      ctxA,
      created.party.id,
      async () => {
        addressCreate = createAddress(ctxA, {
          partyId: created.party.id,
          addressType: "GENERAL",
          line1: "On time",
          countryCode: "MY",
        });
        await waitUntilCreateIsBlockedOnPartyLock();
      },
      async () => undefined,
    );
    const address = await addressCreate;
    expect(address?.id).toBeTruthy();

    const archived = await archiveParty(ctxA, created.party.id, created.party.version);
    expect(archived.status).toBe("ARCHIVED");

    const state = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      async (tx) => ({
        contacts: await tx.partyContact.count({
          where: { tenantId: ctxA.tenantId, partyId: created.party.id },
        }),
        addresses: await tx.partyAddress.count({
          where: { tenantId: ctxA.tenantId, partyId: created.party.id },
        }),
        events: await tx.auditEvent.findMany({
          where: { tenantId: ctxA.tenantId },
          orderBy: { sequence: "asc" },
        }),
      }),
    );
    expect(state.contacts).toBe(1);
    expect(state.addresses).toBe(1);
    expect(state.events.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "party.created",
        "party_contact.created",
        "party_address.created",
        "party.archived",
      ]),
    );
    expect(verifyAuditChain(toAuditLinks(state.events)).valid).toBe(true);
  });
});
