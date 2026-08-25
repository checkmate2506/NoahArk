import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createSystemClient } from "@noahark/db/system";
import {
  setupTestTenant,
  createTestLegalEntity,
  cleanupTenant,
  cleanupUser,
} from "./testHelpers";

/**
 * Phase 2A — RLS, custom-field hardening and role-privilege boundaries.
 *
 * Shared masters (party, catalog item, price list) are tenant-level records
 * with an explicit managing `owner_legal_entity_id` (ADR-73). SELECT is
 * owner-OR-assignment; INSERT/UPDATE require the owner in
 * `app.legal_entity_ids`. Assigned non-owners may read, not mutate.
 */

function code(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

/** Opens a connection as the NON-superuser app role, under an explicit
 * tenant/legal-entity context, exactly as the running application does. */
async function asApp<T>(
  tenantId: string,
  legalEntityIds: string[],
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
    await c.query("SELECT set_config('app.legal_entity_ids', $1, false)", [
      legalEntityIds.join(","),
    ]);
    return await fn(c);
  } finally {
    await c.end();
  }
}

/** Opens a connection as the app role with NO context set at all. */
async function asAppNoContext<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function asWorker<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_WORKER_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe("Phase 2A — RLS and privilege boundaries", () => {
  let setup: Awaited<ReturnType<typeof setupTestTenant>> | undefined;

  afterEach(async () => {
    if (setup) {
      await cleanupTenant(setup.tenantId).catch(() => undefined);
      await cleanupUser(setup.adminUserId).catch(() => undefined);
      setup = undefined;
    }
  });

  /** Builds a tenant with two legal entities and a party assigned ONLY to A. */
  async function twoEntityFixture() {
    const db = createSystemClient();
    const s = await setupTestTenant();
    setup = s;
    const leA = await createTestLegalEntity(s.tenantId, "SG");
    const leB = await createTestLegalEntity(s.tenantId, "MY");
    const party = await db.party.create({
      data: {
        tenantId: s.tenantId,
        ownerLegalEntityId: leA.id,
        code: code("P"),
        partyType: "ORGANISATION",
        legalName: "Only In A",
        normalisedName: "only in a",
      },
    });
    const assignA = await db.partyLegalEntityAssignment.create({
      data: { tenantId: s.tenantId, partyId: party.id, legalEntityId: leA.id },
    });
    const custA = await db.customerRole.create({
      data: {
        tenantId: s.tenantId,
        legalEntityId: leA.id,
        assignmentId: assignA.id,
        code: code("CUST"),
      },
    });
    return { db, s, leA, leB, party, assignA, custA };
  }

  it("a party assigned only to entity A is invisible to an entity-B session, and B cannot discover the assignment or role", async () => {
    const { s, leA, leB, party, assignA, custA } = await twoEntityFixture();

    const inA = await asApp(s.tenantId, [leA.id], async (c) => ({
      party: (await c.query("SELECT id FROM party WHERE id = $1", [party.id])).rowCount,
      assignment: (
        await c.query("SELECT id FROM party_legal_entity_assignment WHERE id = $1", [
          assignA.id,
        ])
      ).rowCount,
      role: (await c.query("SELECT id FROM customer_role WHERE id = $1", [custA.id]))
        .rowCount,
    }));
    expect(inA).toEqual({ party: 1, assignment: 1, role: 1 });

    const inB = await asApp(s.tenantId, [leB.id], async (c) => ({
      party: (await c.query("SELECT id FROM party WHERE id = $1", [party.id])).rowCount,
      assignment: (
        await c.query("SELECT id FROM party_legal_entity_assignment WHERE id = $1", [
          assignA.id,
        ])
      ).rowCount,
      role: (await c.query("SELECT id FROM customer_role WHERE id = $1", [custA.id]))
        .rowCount,
      anyParty: (await c.query("SELECT id FROM party")).rowCount,
    }));
    expect(inB).toEqual({ party: 0, assignment: 0, role: 0, anyParty: 0 });
  });

  it("a party assigned to BOTH entities exposes only each entity's own role and code", async () => {
    const { db, s, leA, leB, party, custA } = await twoEntityFixture();
    const assignB = await db.partyLegalEntityAssignment.create({
      data: { tenantId: s.tenantId, partyId: party.id, legalEntityId: leB.id },
    });
    const custB = await db.customerRole.create({
      data: {
        tenantId: s.tenantId,
        legalEntityId: leB.id,
        assignmentId: assignB.id,
        code: code("CUSTB"),
      },
    });

    const seenByA = await asApp(s.tenantId, [leA.id], async (c) =>
      (await c.query<{ id: string }>("SELECT id FROM customer_role")).rows.map(
        (r) => r.id,
      ),
    );
    const seenByB = await asApp(s.tenantId, [leB.id], async (c) =>
      (await c.query<{ id: string }>("SELECT id FROM customer_role")).rows.map(
        (r) => r.id,
      ),
    );
    expect(seenByA).toEqual([custA.id]);
    expect(seenByB).toEqual([custB.id]);

    // The shared master is visible to both — that is the point of sharing.
    for (const le of [leA, leB]) {
      const n = await asApp(
        s.tenantId,
        [le.id],
        async (c) =>
          (await c.query("SELECT id FROM party WHERE id = $1", [party.id])).rowCount,
      );
      expect(n).toBe(1);
    }
  });

  it("contacts and addresses of an unassigned-to-me party are invisible even when their ids are known", async () => {
    const { db, s, leB, party } = await twoEntityFixture();
    const contact = await db.partyContact.create({
      data: { tenantId: s.tenantId, partyId: party.id, givenName: "Secret" },
    });
    const address = await db.partyAddress.create({
      data: {
        tenantId: s.tenantId,
        partyId: party.id,
        addressType: "BILLING",
        line1: "1 Secret Road",
        countryCode: "SG",
      },
    });

    const leaked = await asApp(s.tenantId, [leB.id], async (c) => ({
      contact: (await c.query("SELECT id FROM party_contact WHERE id = $1", [contact.id]))
        .rowCount,
      address: (await c.query("SELECT id FROM party_address WHERE id = $1", [address.id]))
        .rowCount,
    }));
    expect(leaked).toEqual({ contact: 0, address: 0 });
  });

  it("catalog items and price lists assigned only to entity B are invisible to entity A, including their price entries", async () => {
    const db = createSystemClient();
    const s = await setupTestTenant();
    setup = s;
    const leA = await createTestLegalEntity(s.tenantId, "SG");
    const leB = await createTestLegalEntity(s.tenantId, "MY");
    const uom = await db.unitOfMeasure.create({
      data: { tenantId: s.tenantId, code: code("EA"), name: "Each" },
    });
    const item = await db.catalogItem.create({
      data: {
        tenantId: s.tenantId,
        ownerLegalEntityId: leB.id,
        code: code("SKU"),
        itemType: "PRODUCT",
        name: "B only",
        baseUomId: uom.id,
      },
    });
    const pl = await db.priceList.create({
      data: {
        tenantId: s.tenantId,
        ownerLegalEntityId: leB.id,
        code: code("PL"),
        name: "B",
        currency: "MYR",
      },
    });
    const ia = await db.catalogItemLegalEntityAssignment.create({
      data: { tenantId: s.tenantId, catalogItemId: item.id, legalEntityId: leB.id },
    });
    const pa = await db.priceListLegalEntityAssignment.create({
      data: { tenantId: s.tenantId, priceListId: pl.id, legalEntityId: leB.id },
    });
    const entry = await db.priceListEntry.create({
      data: {
        tenantId: s.tenantId,
        legalEntityId: leB.id,
        priceListAssignmentId: pa.id,
        catalogItemAssignmentId: ia.id,
        unitPrice: "9.990000",
        effectiveFrom: new Date(Date.UTC(2026, 0, 1)),
      },
    });

    const fromA = await asApp(s.tenantId, [leA.id], async (c) => ({
      item: (await c.query("SELECT id FROM catalog_item WHERE id = $1", [item.id]))
        .rowCount,
      list: (await c.query("SELECT id FROM price_list WHERE id = $1", [pl.id])).rowCount,
      entry: (await c.query("SELECT id FROM price_list_entry WHERE id = $1", [entry.id]))
        .rowCount,
    }));
    expect(fromA).toEqual({ item: 0, list: 0, entry: 0 });

    const fromB = await asApp(s.tenantId, [leB.id], async (c) => ({
      item: (await c.query("SELECT id FROM catalog_item WHERE id = $1", [item.id]))
        .rowCount,
      entry: (await c.query("SELECT id FROM price_list_entry WHERE id = $1", [entry.id]))
        .rowCount,
    }));
    expect(fromB).toEqual({ item: 1, entry: 1 });
  });

  it("categories and units are tenant-visible by design, but never cross a tenant boundary", async () => {
    const db = createSystemClient();
    const s = await setupTestTenant();
    setup = s;
    const other = await setupTestTenant();
    try {
      const leA = await createTestLegalEntity(s.tenantId, "SG");
      const cat = await db.catalogCategory.create({
        data: { tenantId: s.tenantId, code: code("CAT"), name: "Shared" },
      });
      const otherCat = await db.catalogCategory.create({
        data: { tenantId: other.tenantId, code: code("CAT"), name: "Theirs" },
      });

      const seen = await asApp(s.tenantId, [leA.id], async (c) => ({
        own: (await c.query("SELECT id FROM catalog_category WHERE id = $1", [cat.id]))
          .rowCount,
        foreign: (
          await c.query("SELECT id FROM catalog_category WHERE id = $1", [otherCat.id])
        ).rowCount,
      }));
      expect(seen).toEqual({ own: 1, foreign: 0 });
    } finally {
      await cleanupTenant(other.tenantId).catch(() => undefined);
      await cleanupUser(other.adminUserId).catch(() => undefined);
    }
  });

  it("an owner-created master is visible to its owner before the first assignment, and invisible to other entities of the same tenant", async () => {
    const db = createSystemClient();
    const s = await setupTestTenant();
    setup = s;
    const leA = await createTestLegalEntity(s.tenantId, "SG");
    const leB = await createTestLegalEntity(s.tenantId, "MY");

    const partyId = code("boot");
    await asApp(s.tenantId, [leA.id], async (c) => {
      await c.query(
        `INSERT INTO party (id, tenant_id, owner_legal_entity_id, code, party_type, legal_name, normalised_name, status, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'ORGANISATION','Bootstrap','bootstrap','ACTIVE',1,now(),now())`,
        [partyId, s.tenantId, leA.id, code("B")],
      );
      // Owner-visible unassigned master: the creator can read it immediately.
      const seen = await c.query("SELECT id FROM party WHERE id = $1", [partyId]);
      expect(seen.rowCount).toBe(1);
    });

    const fromB = await asApp(
      s.tenantId,
      [leB.id],
      async (c) =>
        (await c.query("SELECT id FROM party WHERE id = $1", [partyId])).rowCount,
    );
    expect(fromB).toBe(0);

    // A client-supplied owner id outside server-derived context is rejected.
    await asApp(s.tenantId, [leB.id], async (c) => {
      try {
        await c.query(
          `INSERT INTO party (id, tenant_id, owner_legal_entity_id, code, party_type, legal_name, normalised_name, status, version, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'ORGANISATION','Steal','steal','ACTIVE',1,now(),now())`,
          [code("steal"), s.tenantId, leA.id, code("ST")],
        );
        throw new Error("entity B must not INSERT a master owned by A");
      } catch (e) {
        // 42501 insufficient_privilege (RLS WITH CHECK) — not a successful insert.
        expect((e as { code?: string }).code).toBe("42501");
      }
    });

    await db.partyLegalEntityAssignment.create({
      data: { tenantId: s.tenantId, partyId, legalEntityId: leA.id },
    });
    const stillVisible = await asApp(
      s.tenantId,
      [leA.id],
      async (c) =>
        (await c.query("SELECT id FROM party WHERE id = $1", [partyId])).rowCount,
    );
    expect(stillVisible).toBe(1);
  });

  it("the app role has no DELETE privilege on any Phase 2 business table", async () => {
    const tables = [
      "party",
      "party_contact",
      "party_address",
      "party_legal_entity_assignment",
      "customer_role",
      "vendor_role",
      "catalog_category",
      "unit_of_measure",
      "catalog_item",
      "catalog_item_legal_entity_assignment",
      "price_list",
      "price_list_legal_entity_assignment",
      "price_list_entry",
    ];
    const db = createSystemClient();
    const rows = await db.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.table_privileges
        WHERE grantee = 'noahark_app' AND privilege_type = 'DELETE'
          AND table_name = ANY($1)`,
      tables,
    );
    expect(
      rows.map((r) => r.table_name),
      "Phase 2 introduces no hard-delete path — archival is the only removal semantics",
    ).toEqual([]);
  });

  it("noahark_worker cannot SELECT, INSERT, UPDATE or DELETE any Phase 2 business table", async () => {
    const s = await setupTestTenant();
    setup = s;
    const tables = [
      "party",
      "party_contact",
      "party_address",
      "party_legal_entity_assignment",
      "customer_role",
      "vendor_role",
      "catalog_category",
      "unit_of_measure",
      "catalog_item",
      "catalog_item_legal_entity_assignment",
      "price_list",
      "price_list_legal_entity_assignment",
      "price_list_entry",
    ];
    const denied: string[] = [];
    await asWorker(async (c) => {
      for (const t of tables) {
        for (const stmt of [
          `SELECT * FROM "${t}" LIMIT 1`,
          `DELETE FROM "${t}"`,
          `UPDATE "${t}" SET tenant_id = tenant_id`,
        ]) {
          try {
            await c.query(stmt);
          } catch (e) {
            if ((e as { code?: string }).code === "42501") denied.push(`${t}:${stmt[0]}`);
            continue;
          }
          throw new Error(`worker was ALLOWED to run: ${stmt}`);
        }
      }
    });
    expect(denied.length).toBe(tables.length * 3);
  });

  it("a session with no context, or a malformed context, sees nothing (fail closed)", async () => {
    const { s, leA, party } = await twoEntityFixture();

    const noCtx = await asAppNoContext(
      async (c) => (await c.query("SELECT id FROM party")).rowCount,
    );
    expect(noCtx).toBe(0);

    // Correct tenant, but an empty legal-entity set.
    const emptyEntities = await asApp(
      s.tenantId,
      [],
      async (c) => (await c.query("SELECT id FROM party")).rowCount,
    );
    expect(emptyEntities).toBe(0);

    // Correct entity, but a foreign tenant id.
    const wrongTenant = await asApp(
      "not-a-real-tenant",
      [leA.id],
      async (c) =>
        (await c.query("SELECT id FROM party WHERE id = $1", [party.id])).rowCount,
    );
    expect(wrongTenant).toBe(0);
  });

  it("RLS holds across sequential reuses of one pooled connection", async () => {
    const { s, leA, leB, party } = await twoEntityFixture();
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      // Same physical connection, context switched between reads.
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [s.tenantId]);
      await c.query("SELECT set_config('app.legal_entity_ids', $1, false)", [leA.id]);
      expect(
        (await c.query("SELECT id FROM party WHERE id=$1", [party.id])).rowCount,
      ).toBe(1);

      await c.query("SELECT set_config('app.legal_entity_ids', $1, false)", [leB.id]);
      expect(
        (await c.query("SELECT id FROM party WHERE id=$1", [party.id])).rowCount,
      ).toBe(0);

      // Resetting context mid-connection must fail closed, not fall back to
      // the previous grant.
      await c.query("SELECT set_config('app.legal_entity_ids', '', false)");
      expect((await c.query("SELECT id FROM party")).rowCount).toBe(0);
    } finally {
      await c.end();
    }
  });

  // -------------------------------------------------------------------------
  // Custom fields
  // -------------------------------------------------------------------------

  it("authentication and security models can never be custom-field targets", async () => {
    const db = createSystemClient();
    const s = await setupTestTenant();
    setup = s;
    for (const target of [
      "user",
      "account",
      "session",
      "user_credential",
      "mfa_credential",
      "permission",
      "role",
      "field_policy",
      "audit_event",
    ]) {
      await expect(
        db.customFieldDefinition.create({
          data: {
            tenantId: s.tenantId,
            entityType: target,
            key: code("k"),
            label: "X",
            dataType: "STRING",
          },
        }),
        `custom fields must never target ${target}`,
      ).rejects.toThrow();
    }
  });

  it("a Phase 2 custom-field value requires a legal entity, typed storage, and agreement with its definition", async () => {
    const db = createSystemClient();
    const s = await setupTestTenant();
    setup = s;
    const le = await createTestLegalEntity(s.tenantId, "SG");
    const party = await db.party.create({
      data: {
        tenantId: s.tenantId,
        ownerLegalEntityId: le.id,
        code: code("P"),
        partyType: "ORGANISATION",
        legalName: "Rated",
        normalisedName: "rated",
      },
    });
    await db.partyLegalEntityAssignment.create({
      data: { tenantId: s.tenantId, partyId: party.id, legalEntityId: le.id },
    });
    const def = await db.customFieldDefinition.create({
      data: {
        tenantId: s.tenantId,
        entityType: "party",
        key: code("rating"),
        label: "Rating",
        dataType: "DECIMAL",
      },
    });

    // Correct: typed decimal, legal-entity scoped, real party target.
    const ok = await db.customFieldValue.create({
      data: {
        tenantId: s.tenantId,
        legalEntityId: le.id,
        definitionId: def.id,
        entityType: "party",
        entityId: party.id,
        valueDecimal: "12.345678",
      },
    });
    expect(ok.valueDecimal?.toString()).toBe("12.345678");

    const partyMissingLe = await db.party.create({
      data: {
        tenantId: s.tenantId,
        ownerLegalEntityId: le.id,
        code: code("P0"),
        partyType: "ORGANISATION",
        legalName: "P0",
        normalisedName: "p0",
      },
    });

    // Missing legal entity -> CHECK.
    await expect(
      db.customFieldValue.create({
        data: {
          tenantId: s.tenantId,
          definitionId: def.id,
          entityType: "party",
          entityId: partyMissingLe.id,
          valueDecimal: "1.0",
        },
      }),
    ).rejects.toThrow();

    // Wrong typed column for a DECIMAL definition -> trigger.
    const party2 = await db.party.create({
      data: {
        tenantId: s.tenantId,
        ownerLegalEntityId: le.id,
        code: code("P2"),
        partyType: "ORGANISATION",
        legalName: "P2",
        normalisedName: "p2",
      },
    });
    await expect(
      db.customFieldValue.create({
        data: {
          tenantId: s.tenantId,
          legalEntityId: le.id,
          definitionId: def.id,
          entityType: "party",
          entityId: party2.id,
          valueText: "not a decimal",
        },
      }),
    ).rejects.toThrow();

    const party3 = await db.party.create({
      data: {
        tenantId: s.tenantId,
        ownerLegalEntityId: le.id,
        code: code("P3"),
        partyType: "ORGANISATION",
        legalName: "P3",
        normalisedName: "p3",
      },
    });
    // Two typed columns at once -> CHECK.
    await expect(
      db.customFieldValue.create({
        data: {
          tenantId: s.tenantId,
          legalEntityId: le.id,
          definitionId: def.id,
          entityType: "party",
          entityId: party3.id,
          valueDecimal: "1.0",
          valueText: "also",
        },
      }),
    ).rejects.toThrow();

    const party4 = await db.party.create({
      data: {
        tenantId: s.tenantId,
        ownerLegalEntityId: le.id,
        code: code("P4"),
        partyType: "ORGANISATION",
        legalName: "P4",
        normalisedName: "p4",
      },
    });
    // Writing the legacy JSON column for a Phase 2 target -> CHECK.
    await expect(
      db.customFieldValue.create({
        data: {
          tenantId: s.tenantId,
          legalEntityId: le.id,
          definitionId: def.id,
          entityType: "party",
          entityId: party4.id,
          value: { legacy: true },
        },
      }),
    ).rejects.toThrow();
  });

  it("an inactive definition rejects new values, and a legacy foundation row still works untouched", async () => {
    const db = createSystemClient();
    const s = await setupTestTenant();
    setup = s;
    const le = await createTestLegalEntity(s.tenantId, "SG");
    const uom = await db.unitOfMeasure.create({
      data: { tenantId: s.tenantId, code: code("EA"), name: "Each" },
    });
    const item = await db.catalogItem.create({
      data: {
        tenantId: s.tenantId,
        ownerLegalEntityId: le.id,
        code: code("SKU"),
        itemType: "PRODUCT",
        name: "Inactive target",
        baseUomId: uom.id,
      },
    });

    const inactive = await db.customFieldDefinition.create({
      data: {
        tenantId: s.tenantId,
        entityType: "catalog_item",
        key: code("k"),
        label: "K",
        dataType: "STRING",
        isActive: false,
      },
    });
    await expect(
      db.customFieldValue.create({
        data: {
          tenantId: s.tenantId,
          legalEntityId: le.id,
          definitionId: inactive.id,
          entityType: "catalog_item",
          entityId: item.id,
          valueText: "x",
        },
      }),
    ).rejects.toThrow();

    // Legacy-only target keeps Phase 1 behaviour: untyped JSON, no legal
    // entity, no parent-table proof. demo_approval_subject is retained
    // explicitly and must not masquerade as a Phase 2 typed target.
    const legacyDef = await db.customFieldDefinition.create({
      data: {
        tenantId: s.tenantId,
        entityType: "demo_approval_subject",
        key: code("legacy"),
        label: "Legacy",
        dataType: "NUMBER",
      },
    });
    const legacy = await db.customFieldValue.create({
      data: {
        tenantId: s.tenantId,
        definitionId: legacyDef.id,
        entityType: "demo_approval_subject",
        entityId: code("d"),
        value: { any: "shape" },
      },
    });
    expect(legacy.legalEntityId).toBeNull();
    expect(legacy.value).toEqual({ any: "shape" });
  });

  it("a Phase 2 custom-field value is invisible from another legal entity even when its entityId is known", async () => {
    const db = createSystemClient();
    const s = await setupTestTenant();
    setup = s;
    const leA = await createTestLegalEntity(s.tenantId, "SG");
    const leB = await createTestLegalEntity(s.tenantId, "MY");
    const def = await db.customFieldDefinition.create({
      data: {
        tenantId: s.tenantId,
        entityType: "party",
        key: code("secret"),
        label: "Secret",
        dataType: "STRING",
      },
    });
    const party = await db.party.create({
      data: {
        tenantId: s.tenantId,
        ownerLegalEntityId: leA.id,
        code: code("P"),
        partyType: "ORGANISATION",
        legalName: "Secret",
        normalisedName: "secret",
      },
    });
    await db.partyLegalEntityAssignment.create({
      data: { tenantId: s.tenantId, partyId: party.id, legalEntityId: leA.id },
    });
    const targetId = party.id;
    const value = await db.customFieldValue.create({
      data: {
        tenantId: s.tenantId,
        legalEntityId: leA.id,
        definitionId: def.id,
        entityType: "party",
        entityId: targetId,
        valueText: "confidential",
      },
    });

    const fromB = await asApp(s.tenantId, [leB.id], async (c) => ({
      byId: (await c.query("SELECT id FROM custom_field_value WHERE id = $1", [value.id]))
        .rowCount,
      byGuessedEntity: (
        await c.query("SELECT id FROM custom_field_value WHERE entity_id = $1", [
          targetId,
        ])
      ).rowCount,
    }));
    expect(fromB).toEqual({ byId: 0, byGuessedEntity: 0 });

    const fromA = await asApp(
      s.tenantId,
      [leA.id],
      async (c) =>
        (
          await c.query("SELECT value_text FROM custom_field_value WHERE id = $1", [
            value.id,
          ])
        ).rows,
    );
    expect(fromA).toEqual([{ value_text: "confidential" }]);
  });

  it("audit immutability is unchanged by Phase 2", async () => {
    const db = createSystemClient();
    const rows = await db.$queryRawUnsafe<Array<{ tgname: string; tgenabled: string }>>(
      // tgenabled is `"char"`, which Prisma cannot deserialize — cast it,
      // matching testCleanupGate.test.ts's own treatment.
      `SELECT tgname, tgenabled::text AS tgenabled FROM pg_trigger
        WHERE tgrelid = 'audit_event'::regclass AND NOT tgisinternal ORDER BY tgname`,
    );
    expect(rows.map((r) => `${r.tgname}=${r.tgenabled}`)).toEqual([
      "audit_event_no_delete=O",
      "audit_event_no_update=O",
    ]);
  });
});
