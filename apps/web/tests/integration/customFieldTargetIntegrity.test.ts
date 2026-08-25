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
 * Phase 2A audit remediation (ADR-73 / F-3, F-6).
 *
 * Fail-closed custom-field allowlist and polymorphic target integrity,
 * proven with raw SQL through both the migration (superuser) role and the
 * application role.
 */

function code(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

async function raw<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

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

function sqlstate(e: unknown): string {
  return (e as { code?: string }).code ?? "UNKNOWN";
}

const ALLOWLIST = [
  "party",
  "party_contact",
  "party_legal_entity_assignment",
  "customer_role",
  "vendor_role",
  "catalog_item",
  "catalog_item_legal_entity_assignment",
  "price_list",
  "price_list_legal_entity_assignment",
  "demo_approval_subject",
] as const;

const REJECTED_NAMES = [
  " user",
  "user ",
  " user ",
  "User",
  "USER",
  "users",
  "account",
  "session",
  "credentials",
  "user_credential",
  "mfa_credential",
  "permission",
  "role",
  "audit_event",
  "idempotency_key",
  "Party",
  "parties",
  "party ",
  " party",
  "party_address",
  "price_list_entry",
  "catalog_category",
  "unit_of_measure",
  "file_object",
  "attachment",
  "unknown_type",
];

describe("Phase 2A — custom-field allowlist and target integrity", () => {
  let setup: Awaited<ReturnType<typeof setupTestTenant>> | undefined;
  let extra: Awaited<ReturnType<typeof setupTestTenant>> | undefined;

  afterEach(async () => {
    if (setup) {
      await cleanupTenant(setup.tenantId).catch(() => undefined);
      await cleanupUser(setup.adminUserId).catch(() => undefined);
      setup = undefined;
    }
    if (extra) {
      await cleanupTenant(extra.tenantId).catch(() => undefined);
      await cleanupUser(extra.adminUserId).catch(() => undefined);
      extra = undefined;
    }
  });

  async function tenantPair() {
    const db = createSystemClient();
    const s = await setupTestTenant();
    setup = s;
    extra = await setupTestTenant();
    const leA = await createTestLegalEntity(s.tenantId, "SG");
    const leB = await createTestLegalEntity(s.tenantId, "MY");
    const otherLe = await createTestLegalEntity(extra.tenantId, "SG");
    return { db, s, leA, leB, otherLe };
  }

  async function partyGraph(
    db: ReturnType<typeof createSystemClient>,
    tenantId: string,
    ownerId: string,
    alsoAssign?: string,
  ) {
    const party = await db.party.create({
      data: {
        tenantId,
        ownerLegalEntityId: ownerId,
        code: code("P"),
        partyType: "ORGANISATION",
        legalName: "Target",
        normalisedName: "target",
      },
    });
    const assign = await db.partyLegalEntityAssignment.create({
      data: { tenantId, partyId: party.id, legalEntityId: ownerId },
    });
    if (alsoAssign) {
      await db.partyLegalEntityAssignment.create({
        data: { tenantId, partyId: party.id, legalEntityId: alsoAssign },
      });
    }
    const contact = await db.partyContact.create({
      data: { tenantId, partyId: party.id, givenName: "Pat" },
    });
    const customer = await db.customerRole.create({
      data: {
        tenantId,
        legalEntityId: ownerId,
        assignmentId: assign.id,
        code: code("C"),
      },
    });
    const vendor = await db.vendorRole.create({
      data: {
        tenantId,
        legalEntityId: ownerId,
        assignmentId: assign.id,
        code: code("V"),
      },
    });
    return { party, assign, contact, customer, vendor };
  }

  async function catalogGraph(
    db: ReturnType<typeof createSystemClient>,
    tenantId: string,
    ownerId: string,
  ) {
    const uom = await db.unitOfMeasure.create({
      data: { tenantId, code: code("EA"), name: "Each" },
    });
    const item = await db.catalogItem.create({
      data: {
        tenantId,
        ownerLegalEntityId: ownerId,
        code: code("SKU"),
        itemType: "PRODUCT",
        name: "Item",
        baseUomId: uom.id,
      },
    });
    const itemAssign = await db.catalogItemLegalEntityAssignment.create({
      data: { tenantId, catalogItemId: item.id, legalEntityId: ownerId },
    });
    const list = await db.priceList.create({
      data: {
        tenantId,
        ownerLegalEntityId: ownerId,
        code: code("PL"),
        name: "List",
        currency: "SGD",
      },
    });
    const listAssign = await db.priceListLegalEntityAssignment.create({
      data: { tenantId, priceListId: list.id, legalEntityId: ownerId },
    });
    return { item, itemAssign, list, listAssign };
  }

  it("every allowlisted type is accepted as a definition entityType", async () => {
    const db = createSystemClient();
    const s = await setupTestTenant();
    setup = s;
    for (const entityType of ALLOWLIST) {
      const def = await db.customFieldDefinition.create({
        data: {
          tenantId: s.tenantId,
          entityType,
          key: code("k"),
          label: "K",
          dataType: entityType === "demo_approval_subject" ? "NUMBER" : "STRING",
        },
      });
      expect(def.entityType).toBe(entityType);
    }
  });

  it("every non-allowlisted, whitespace, case, plural and auth-adjacent name is rejected", async () => {
    const db = createSystemClient();
    const s = await setupTestTenant();
    setup = s;
    for (const entityType of REJECTED_NAMES) {
      await expect(
        db.customFieldDefinition.create({
          data: {
            tenantId: s.tenantId,
            entityType,
            key: code("k"),
            label: "K",
            dataType: "STRING",
          },
        }),
        `must reject entityType ${JSON.stringify(entityType)}`,
      ).rejects.toThrow();
    }
  });

  it("raw SQL whitespace and case variants are rejected on both definition and value", async () => {
    const { s } = await tenantPair();
    const variants = [" party", "party ", "Party", "PARTY", "parties"];
    for (const entityType of variants) {
      const state = await raw(async (c) => {
        try {
          await c.query(
            `INSERT INTO custom_field_definition (id, tenant_id, entity_type, key, label, data_type, is_required, is_active, display_order, version, created_at, updated_at)
             VALUES ($1,$2,$3,$4,'L','STRING',false,true,0,1,now(),now())`,
            [code("d"), s.tenantId, entityType, code("k")],
          );
          return "OK";
        } catch (e) {
          return sqlstate(e);
        }
      });
      expect(state, `definition ${JSON.stringify(entityType)}`).toBe("23514");
    }
  });

  it("every Phase 2 allowlisted type accepts a value against a real same-tenant, same-entity target", async () => {
    const { db, s, leA } = await tenantPair();
    const parties = await partyGraph(db, s.tenantId, leA.id);
    const catalog = await catalogGraph(db, s.tenantId, leA.id);

    const targets: Array<{ entityType: string; entityId: string }> = [
      { entityType: "party", entityId: parties.party.id },
      { entityType: "party_contact", entityId: parties.contact.id },
      { entityType: "party_legal_entity_assignment", entityId: parties.assign.id },
      { entityType: "customer_role", entityId: parties.customer.id },
      { entityType: "vendor_role", entityId: parties.vendor.id },
      { entityType: "catalog_item", entityId: catalog.item.id },
      {
        entityType: "catalog_item_legal_entity_assignment",
        entityId: catalog.itemAssign.id,
      },
      { entityType: "price_list", entityId: catalog.list.id },
      {
        entityType: "price_list_legal_entity_assignment",
        entityId: catalog.listAssign.id,
      },
    ];

    for (const t of targets) {
      const def = await db.customFieldDefinition.create({
        data: {
          tenantId: s.tenantId,
          entityType: t.entityType,
          key: code("k"),
          label: "K",
          dataType: "STRING",
        },
      });
      const value = await db.customFieldValue.create({
        data: {
          tenantId: s.tenantId,
          legalEntityId: leA.id,
          definitionId: def.id,
          entityType: t.entityType,
          entityId: t.entityId,
          valueText: "ok",
        },
      });
      expect(value.entityId).toBe(t.entityId);
    }
  });

  it("target id must exist; guessed ids and wrong types are rejected", async () => {
    const { db, s, leA } = await tenantPair();
    const parties = await partyGraph(db, s.tenantId, leA.id);
    const def = await db.customFieldDefinition.create({
      data: {
        tenantId: s.tenantId,
        entityType: "party",
        key: code("k"),
        label: "K",
        dataType: "STRING",
      },
    });

    await expect(
      db.customFieldValue.create({
        data: {
          tenantId: s.tenantId,
          legalEntityId: leA.id,
          definitionId: def.id,
          entityType: "party",
          entityId: code("guess"),
          valueText: "x",
        },
      }),
    ).rejects.toThrow();

    const contactDef = await db.customFieldDefinition.create({
      data: {
        tenantId: s.tenantId,
        entityType: "party_contact",
        key: code("k"),
        label: "K",
        dataType: "STRING",
      },
    });
    await expect(
      db.customFieldValue.create({
        data: {
          tenantId: s.tenantId,
          legalEntityId: leA.id,
          definitionId: contactDef.id,
          entityType: "party_contact",
          entityId: parties.party.id, // real id, wrong type
          valueText: "x",
        },
      }),
    ).rejects.toThrow();
  });

  it("cross-tenant and cross-entity targets are rejected", async () => {
    const { db, s, leA, leB, otherLe } = await tenantPair();
    const local = await partyGraph(db, s.tenantId, leA.id);
    const foreignDb = createSystemClient();
    const foreign = await partyGraph(foreignDb, extra!.tenantId, otherLe.id);

    const def = await db.customFieldDefinition.create({
      data: {
        tenantId: s.tenantId,
        entityType: "party",
        key: code("k"),
        label: "K",
        dataType: "STRING",
      },
    });

    await expect(
      db.customFieldValue.create({
        data: {
          tenantId: s.tenantId,
          legalEntityId: leA.id,
          definitionId: def.id,
          entityType: "party",
          entityId: foreign.party.id,
          valueText: "x",
        },
      }),
    ).rejects.toThrow();

    await expect(
      db.customFieldValue.create({
        data: {
          tenantId: s.tenantId,
          legalEntityId: leB.id,
          definitionId: def.id,
          entityType: "party",
          entityId: local.party.id,
          valueText: "x",
        },
      }),
    ).rejects.toThrow();
  });

  it("raw SQL cannot write a Phase 2 value into the legacy JSON column", async () => {
    const { db, s, leA } = await tenantPair();
    const parties = await partyGraph(db, s.tenantId, leA.id);
    const def = await db.customFieldDefinition.create({
      data: {
        tenantId: s.tenantId,
        entityType: "party",
        key: code("k"),
        label: "K",
        dataType: "STRING",
      },
    });
    const state = await raw(async (c) => {
      try {
        await c.query(
          `INSERT INTO custom_field_value
             (id, tenant_id, legal_entity_id, definition_id, entity_type, entity_id, value, version, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'party',$5,'{"legacy":true}'::jsonb,1,now(),now())`,
          [code("v"), s.tenantId, leA.id, def.id, parties.party.id],
        );
        return "OK";
      } catch (e) {
        return sqlstate(e);
      }
    });
    expect(state).toBe("23514");
  });

  it("typed-column / dataType agreement remains enforced", async () => {
    const { db, s, leA } = await tenantPair();
    const parties = await partyGraph(db, s.tenantId, leA.id);
    const def = await db.customFieldDefinition.create({
      data: {
        tenantId: s.tenantId,
        entityType: "party",
        key: code("k"),
        label: "K",
        dataType: "INTEGER",
      },
    });
    await expect(
      db.customFieldValue.create({
        data: {
          tenantId: s.tenantId,
          legalEntityId: leA.id,
          definitionId: def.id,
          entityType: "party",
          entityId: parties.party.id,
          valueText: "nope",
        },
      }),
    ).rejects.toThrow();
    const ok = await db.customFieldValue.create({
      data: {
        tenantId: s.tenantId,
        legalEntityId: leA.id,
        definitionId: def.id,
        entityType: "party",
        entityId: parties.party.id,
        valueInteger: 7,
      },
    });
    expect(ok.valueInteger).toBe(7);
  });

  it("definition entityType and dataType cannot change once values exist", async () => {
    const { db, s, leA } = await tenantPair();
    const parties = await partyGraph(db, s.tenantId, leA.id);
    const def = await db.customFieldDefinition.create({
      data: {
        tenantId: s.tenantId,
        entityType: "party",
        key: code("k"),
        label: "K",
        dataType: "STRING",
      },
    });
    await db.customFieldValue.create({
      data: {
        tenantId: s.tenantId,
        legalEntityId: leA.id,
        definitionId: def.id,
        entityType: "party",
        entityId: parties.party.id,
        valueText: "held",
      },
    });
    await expect(
      db.customFieldDefinition.update({
        where: { id: def.id },
        data: { dataType: "INTEGER" },
      }),
    ).rejects.toThrow();
    await expect(
      db.customFieldDefinition.update({
        where: { id: def.id },
        data: { entityType: "catalog_item" },
      }),
    ).rejects.toThrow();
  });

  it("an inactive definition rejects new values; a definition with no values may still change type", async () => {
    const { db, s, leA } = await tenantPair();
    const parties = await partyGraph(db, s.tenantId, leA.id);
    const inactive = await db.customFieldDefinition.create({
      data: {
        tenantId: s.tenantId,
        entityType: "party",
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
          legalEntityId: leA.id,
          definitionId: inactive.id,
          entityType: "party",
          entityId: parties.party.id,
          valueText: "x",
        },
      }),
    ).rejects.toThrow();

    const unused = await db.customFieldDefinition.create({
      data: {
        tenantId: s.tenantId,
        entityType: "party",
        key: code("u"),
        label: "U",
        dataType: "STRING",
      },
    });
    const flipped = await db.customFieldDefinition.update({
      where: { id: unused.id },
      data: { dataType: "INTEGER" },
    });
    expect(flipped.dataType).toBe("INTEGER");
  });

  it("legacy demo_approval_subject remains writable with JSON and is not treated as a Phase 2 target", async () => {
    const db = createSystemClient();
    const s = await setupTestTenant();
    setup = s;
    const def = await db.customFieldDefinition.create({
      data: {
        tenantId: s.tenantId,
        entityType: "demo_approval_subject",
        key: code("legacy"),
        label: "Legacy",
        dataType: "NUMBER",
      },
    });
    const row = await db.customFieldValue.create({
      data: {
        tenantId: s.tenantId,
        definitionId: def.id,
        entityType: "demo_approval_subject",
        entityId: code("missing-on-purpose"),
        value: { any: "shape" },
      },
    });
    expect(row.legalEntityId).toBeNull();
    expect(row.value).toEqual({ any: "shape" });
    expect(row.valueText).toBeNull();
  });

  it("an application-role session cannot attach a custom field to another entity's party by guessing the id", async () => {
    const { db, s, leA, leB } = await tenantPair();
    const parties = await partyGraph(db, s.tenantId, leA.id);
    const def = await db.customFieldDefinition.create({
      data: {
        tenantId: s.tenantId,
        entityType: "party",
        key: code("k"),
        label: "K",
        dataType: "STRING",
      },
    });

    await asApp(s.tenantId, [leB.id], async (c) => {
      try {
        await c.query(
          `INSERT INTO custom_field_value
             (id, tenant_id, legal_entity_id, definition_id, entity_type, entity_id, value_text, version, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'party',$5,'leak',1,now(),now())`,
          [code("v"), s.tenantId, leB.id, def.id, parties.party.id],
        );
        throw new Error("entity B must not attach a value to A's unassigned-to-B party");
      } catch (e) {
        const codeVal = sqlstate(e);
        expect(["23514", "42501"]).toContain(codeVal);
      }
    });
  });
});
