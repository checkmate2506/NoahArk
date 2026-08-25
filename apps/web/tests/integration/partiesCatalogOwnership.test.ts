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
 * Phase 2A audit remediation (ADR-73 / F-1, F-2, F-4).
 *
 * Proves INSERT and UPDATE RLS for shared masters against real PostgreSQL
 * through the application role, using raw SQL so application validation
 * cannot paper over a policy hole.
 */

function code(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
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

async function asAppNoContext<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

function isRlsDenied(e: unknown): boolean {
  return (e as { code?: string }).code === "42501";
}

describe("Phase 2A — shared-master owner mutation boundary", () => {
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

  async function twoEntities() {
    const db = createSystemClient();
    const s = await setupTestTenant();
    setup = s;
    const leA = await createTestLegalEntity(s.tenantId, "SG");
    const leB = await createTestLegalEntity(s.tenantId, "MY");
    return { db, s, leA, leB };
  }

  async function insertParty(
    c: pg.Client,
    tenantId: string,
    ownerId: string,
    id = code("p"),
  ): Promise<string> {
    await c.query(
      `INSERT INTO party (id, tenant_id, owner_legal_entity_id, code, party_type, legal_name, normalised_name, status, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'ORGANISATION','Owned','owned','ACTIVE',1,now(),now())`,
      [id, tenantId, ownerId, code("P")],
    );
    return id;
  }

  it("owner A can insert and read a party before any assignment; entity B cannot read it", async () => {
    const { s, leA, leB } = await twoEntities();
    const id = await asApp(s.tenantId, [leA.id], (c) =>
      insertParty(c, s.tenantId, leA.id),
    );
    const seenA = await asApp(
      s.tenantId,
      [leA.id],
      async (c) => (await c.query("SELECT id FROM party WHERE id=$1", [id])).rowCount,
    );
    const seenB = await asApp(
      s.tenantId,
      [leB.id],
      async (c) => (await c.query("SELECT id FROM party WHERE id=$1", [id])).rowCount,
    );
    expect(seenA).toBe(1);
    expect(seenB).toBe(0);
  });

  it("assignment to B allows B to read; assigned B cannot update the shared master; owner A can, and B sees the owner-approved update", async () => {
    const { db, s, leA, leB } = await twoEntities();
    const id = await asApp(s.tenantId, [leA.id], (c) =>
      insertParty(c, s.tenantId, leA.id),
    );
    await db.partyLegalEntityAssignment.create({
      data: { tenantId: s.tenantId, partyId: id, legalEntityId: leB.id },
    });

    expect(
      await asApp(
        s.tenantId,
        [leB.id],
        async (c) => (await c.query("SELECT id FROM party WHERE id=$1", [id])).rowCount,
      ),
    ).toBe(1);

    await asApp(s.tenantId, [leB.id], async (c) => {
      const r = await c.query("UPDATE party SET legal_name='Hijacked' WHERE id=$1", [id]);
      expect(r.rowCount, "assigned non-owner UPDATE must affect zero rows").toBe(0);
    });

    await asApp(s.tenantId, [leA.id], async (c) => {
      const r = await c.query("UPDATE party SET legal_name='Approved' WHERE id=$1", [id]);
      expect(r.rowCount).toBe(1);
    });

    const name = await asApp(s.tenantId, [leB.id], async (c) => {
      const r = await c.query<{ legal_name: string }>(
        "SELECT legal_name FROM party WHERE id=$1",
        [id],
      );
      return r.rows[0]?.legal_name;
    });
    expect(name).toBe("Approved");
  });

  it("owner transfer A→B fails under A-only and B-only context and succeeds only with A+B", async () => {
    const { s, leA, leB } = await twoEntities();
    const id = await asApp(s.tenantId, [leA.id], (c) =>
      insertParty(c, s.tenantId, leA.id),
    );

    await asApp(s.tenantId, [leA.id], async (c) => {
      try {
        await c.query("UPDATE party SET owner_legal_entity_id=$1 WHERE id=$2", [
          leB.id,
          id,
        ]);
        throw new Error("A-only context must not transfer owner to B");
      } catch (e) {
        expect(isRlsDenied(e)).toBe(true);
      }
    });

    await asApp(s.tenantId, [leB.id], async (c) => {
      const r = await c.query("UPDATE party SET owner_legal_entity_id=$1 WHERE id=$2", [
        leB.id,
        id,
      ]);
      expect(r.rowCount, "B-only context must not transfer ownership").toBe(0);
    });

    await asApp(s.tenantId, [leA.id, leB.id], async (c) => {
      const r = await c.query("UPDATE party SET owner_legal_entity_id=$1 WHERE id=$2", [
        leB.id,
        id,
      ]);
      expect(r.rowCount).toBe(1);
    });

    await asApp(s.tenantId, [leA.id], async (c) => {
      const r = await c.query("UPDATE party SET legal_name='FromA' WHERE id=$1", [id]);
      expect(r.rowCount, "former owner A must not mutate after transfer").toBe(0);
    });

    await asApp(s.tenantId, [leB.id], async (c) => {
      const r = await c.query("UPDATE party SET legal_name='FromB' WHERE id=$1", [id]);
      expect(r.rowCount).toBe(1);
    });
  });

  it("PartyContact and PartyAddress INSERT/UPDATE by an assigned non-owner are rejected; the owner may maintain them", async () => {
    const { db, s, leA, leB } = await twoEntities();
    const partyId = await asApp(s.tenantId, [leA.id], (c) =>
      insertParty(c, s.tenantId, leA.id),
    );
    await db.partyLegalEntityAssignment.create({
      data: { tenantId: s.tenantId, partyId, legalEntityId: leB.id },
    });

    await asApp(s.tenantId, [leB.id], async (c) => {
      try {
        await c.query(
          `INSERT INTO party_contact (id, tenant_id, party_id, given_name, status, version, created_at, updated_at)
           VALUES ($1,$2,$3,'Eve','ACTIVE',1,now(),now())`,
          [code("c"), s.tenantId, partyId],
        );
        throw new Error("assigned non-owner must not INSERT party_contact");
      } catch (e) {
        expect(isRlsDenied(e)).toBe(true);
      }
      try {
        await c.query(
          `INSERT INTO party_address (id, tenant_id, party_id, address_type, line1, country_code, status, version, created_at, updated_at)
           VALUES ($1,$2,$3,'BILLING','1 Road','SG','ACTIVE',1,now(),now())`,
          [code("a"), s.tenantId, partyId],
        );
        throw new Error("assigned non-owner must not INSERT party_address");
      } catch (e) {
        expect(isRlsDenied(e)).toBe(true);
      }
    });

    const contactId = code("c");
    const addressId = code("a");
    await asApp(s.tenantId, [leA.id], async (c) => {
      await c.query(
        `INSERT INTO party_contact (id, tenant_id, party_id, given_name, status, version, created_at, updated_at)
         VALUES ($1,$2,$3,'Ann','ACTIVE',1,now(),now())`,
        [contactId, s.tenantId, partyId],
      );
      await c.query(
        `INSERT INTO party_address (id, tenant_id, party_id, address_type, line1, country_code, status, version, created_at, updated_at)
         VALUES ($1,$2,$3,'BILLING','1 Owner Road','SG','ACTIVE',1,now(),now())`,
        [addressId, s.tenantId, partyId],
      );
      expect(
        (
          await c.query("UPDATE party_contact SET given_name='Anne' WHERE id=$1", [
            contactId,
          ])
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await c.query("UPDATE party_address SET line1='2 Owner Road' WHERE id=$1", [
            addressId,
          ])
        ).rowCount,
      ).toBe(1);
    });

    await asApp(s.tenantId, [leB.id], async (c) => {
      const contact = await c.query(
        "UPDATE party_contact SET given_name='Hijack' WHERE id=$1",
        [contactId],
      );
      expect(contact.rowCount).toBe(0);
      const address = await c.query(
        "UPDATE party_address SET line1='Hijack' WHERE id=$1",
        [addressId],
      );
      expect(address.rowCount).toBe(0);
      // Read visibility still follows the party.
      expect(
        (await c.query("SELECT id FROM party_contact WHERE id=$1", [contactId])).rowCount,
      ).toBe(1);
    });
  });

  it("CatalogItem and PriceList follow the same owner INSERT/UPDATE boundary as Party", async () => {
    const { db, s, leA, leB } = await twoEntities();
    const uom = await db.unitOfMeasure.create({
      data: { tenantId: s.tenantId, code: code("EA"), name: "Each" },
    });
    const itemId = code("i");
    const listId = code("l");

    await asApp(s.tenantId, [leA.id], async (c) => {
      await c.query(
        `INSERT INTO catalog_item (id, tenant_id, owner_legal_entity_id, code, item_type, name, base_uom_id, is_sellable, is_purchasable, status, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'PRODUCT','Widget',$5,true,true,'ACTIVE',1,now(),now())`,
        [itemId, s.tenantId, leA.id, code("SKU"), uom.id],
      );
      await c.query(
        `INSERT INTO price_list (id, tenant_id, owner_legal_entity_id, code, name, currency, status, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'List','SGD','ACTIVE',1,now(),now())`,
        [listId, s.tenantId, leA.id, code("PL")],
      );
      expect(
        (await c.query("SELECT id FROM catalog_item WHERE id=$1", [itemId])).rowCount,
      ).toBe(1);
      expect(
        (await c.query("SELECT id FROM price_list WHERE id=$1", [listId])).rowCount,
      ).toBe(1);
    });

    expect(
      await asApp(
        s.tenantId,
        [leB.id],
        async (c) =>
          (await c.query("SELECT id FROM catalog_item WHERE id=$1", [itemId])).rowCount,
      ),
    ).toBe(0);

    await db.catalogItemLegalEntityAssignment.create({
      data: { tenantId: s.tenantId, catalogItemId: itemId, legalEntityId: leB.id },
    });
    await db.priceListLegalEntityAssignment.create({
      data: { tenantId: s.tenantId, priceListId: listId, legalEntityId: leB.id },
    });

    await asApp(s.tenantId, [leB.id], async (c) => {
      expect(
        (await c.query("SELECT id FROM catalog_item WHERE id=$1", [itemId])).rowCount,
      ).toBe(1);
      expect(
        (await c.query("UPDATE catalog_item SET name='Stolen' WHERE id=$1", [itemId]))
          .rowCount,
      ).toBe(0);
      expect(
        (await c.query("UPDATE price_list SET name='Stolen' WHERE id=$1", [listId]))
          .rowCount,
      ).toBe(0);
    });

    await asApp(s.tenantId, [leA.id], async (c) => {
      expect(
        (await c.query("UPDATE catalog_item SET name='OwnerEdit' WHERE id=$1", [itemId]))
          .rowCount,
      ).toBe(1);
      expect(
        (await c.query("UPDATE price_list SET name='OwnerEdit' WHERE id=$1", [listId]))
          .rowCount,
      ).toBe(1);
    });

    const names = await asApp(s.tenantId, [leB.id], async (c) => ({
      item: (
        await c.query<{ name: string }>("SELECT name FROM catalog_item WHERE id=$1", [
          itemId,
        ])
      ).rows[0]?.name,
      list: (
        await c.query<{ name: string }>("SELECT name FROM price_list WHERE id=$1", [
          listId,
        ])
      ).rows[0]?.name,
    }));
    expect(names).toEqual({ item: "OwnerEdit", list: "OwnerEdit" });
  });

  it("a wrong-tenant owner legal entity is rejected by the composite foreign key", async () => {
    const { s, leA } = await twoEntities();
    extra = await setupTestTenant();
    const foreignLe = await createTestLegalEntity(extra.tenantId, "SG");

    const c = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
    await c.connect();
    try {
      try {
        await c.query(
          `INSERT INTO party (id, tenant_id, owner_legal_entity_id, code, party_type, legal_name, normalised_name, status, version, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'ORGANISATION','X','x','ACTIVE',1,now(),now())`,
          [code("p"), s.tenantId, foreignLe.id, code("P")],
        );
        throw new Error("cross-tenant owner FK must be rejected");
      } catch (e) {
        expect((e as { code?: string }).code).toBe("23503");
      }
    } finally {
      await c.end();
    }
    void leA;
  });

  it("missing, empty or malformed context fails closed on INSERT and SELECT", async () => {
    const { s, leA } = await twoEntities();
    const id = await asApp(s.tenantId, [leA.id], (c) =>
      insertParty(c, s.tenantId, leA.id),
    );

    const noCtx = await asAppNoContext(
      async (c) => (await c.query("SELECT id FROM party")).rowCount,
    );
    expect(noCtx).toBe(0);

    await asAppNoContext(async (c) => {
      try {
        await insertParty(c, s.tenantId, leA.id);
        throw new Error("INSERT with no context must fail");
      } catch (e) {
        expect(isRlsDenied(e)).toBe(true);
      }
    });

    expect(
      await asApp(
        s.tenantId,
        [],
        async (c) => (await c.query("SELECT id FROM party")).rowCount,
      ),
    ).toBe(0);

    expect(
      await asApp(
        "not-a-real-tenant",
        [leA.id],
        async (c) => (await c.query("SELECT id FROM party WHERE id=$1", [id])).rowCount,
      ),
    ).toBe(0);
  });

  it("pooled-connection context switching remains safe for owner mutation", async () => {
    const { s, leA, leB } = await twoEntities();
    const id = await asApp(s.tenantId, [leA.id], (c) =>
      insertParty(c, s.tenantId, leA.id),
    );
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query("SELECT set_config('app.tenant_id', $1, false)", [s.tenantId]);
      await c.query("SELECT set_config('app.legal_entity_ids', $1, false)", [leA.id]);
      expect(
        (await c.query("UPDATE party SET legal_name='A1' WHERE id=$1", [id])).rowCount,
      ).toBe(1);

      await c.query("SELECT set_config('app.legal_entity_ids', $1, false)", [leB.id]);
      expect(
        (await c.query("UPDATE party SET legal_name='B1' WHERE id=$1", [id])).rowCount,
      ).toBe(0);

      await c.query("SELECT set_config('app.legal_entity_ids', '', false)");
      expect((await c.query("SELECT id FROM party")).rowCount).toBe(0);
    } finally {
      await c.end();
    }
  });

  it("owner legal-entity deactivation does not delete the master", async () => {
    const { db, s, leA } = await twoEntities();
    const id = await asApp(s.tenantId, [leA.id], (c) =>
      insertParty(c, s.tenantId, leA.id),
    );
    await db.legalEntity.update({
      where: { id: leA.id },
      data: { status: "INACTIVE" },
    });
    const still = await db.party.findUnique({ where: { id } });
    expect(still).not.toBeNull();
    expect(still?.ownerLegalEntityId).toBe(leA.id);
  });
});
