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
 * Phase 2A — database-level invariants for shared parties & catalog.
 *
 * Everything here is proven against real PostgreSQL, and every claim that the
 * DATABASE enforces something is proven by attacking it with RAW SQL through
 * an independent `pg` connection that bypasses Prisma and the application
 * layer entirely. A constraint that only holds when the app is well-behaved
 * is not an invariant.
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

/** Asserts a raw-SQL statement is rejected, returning the SQLSTATE. */
async function expectRawRejected(sql: string, params: unknown[] = []): Promise<string> {
  return raw(async (c) => {
    try {
      await c.query(sql, params);
    } catch (e) {
      return (e as { code?: string }).code ?? "UNKNOWN";
    }
    throw new Error(`expected raw SQL to be rejected but it succeeded: ${sql}`);
  });
}

describe("Phase 2A — parties & catalog database invariants", () => {
  let setup: Awaited<ReturnType<typeof setupTestTenant>> | undefined;

  afterEach(async () => {
    if (setup) {
      await cleanupTenant(setup.tenantId).catch(() => undefined);
      await cleanupUser(setup.adminUserId).catch(() => undefined);
      setup = undefined;
    }
  });

  // -------------------------------------------------------------------------
  // Party invariants
  // -------------------------------------------------------------------------

  it("an ORGANISATION requires a legal name and an INDIVIDUAL requires a given name — raw SQL cannot create a nameless party", async () => {
    const db = createSystemClient();
    setup = await setupTestTenant();
    const owner = await createTestLegalEntity(setup.tenantId, "SG");

    const ok = await db.party.create({
      data: {
        tenantId: setup.tenantId,
        ownerLegalEntityId: owner.id,
        code: code("ORG"),
        partyType: "ORGANISATION",
        legalName: "Acme Pte Ltd",
        normalisedName: "acme pte ltd",
      },
    });
    expect(ok.id).toBeTruthy();

    const indiv = await db.party.create({
      data: {
        tenantId: setup.tenantId,
        ownerLegalEntityId: owner.id,
        code: code("IND"),
        partyType: "INDIVIDUAL",
        givenName: "Mei",
        familyName: "Tan",
        normalisedName: "mei tan",
      },
    });
    expect(indiv.partyType).toBe("INDIVIDUAL");

    // Adversarial: ORGANISATION with no legal name, straight through raw SQL.
    const sqlstate = await expectRawRejected(
      `INSERT INTO party (id, tenant_id, owner_legal_entity_id, code, party_type, normalised_name, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'ORGANISATION', 'x', 'ACTIVE', 1, now(), now())`,
      [code("bad"), setup.tenantId, owner.id, code("BAD")],
    );
    expect(sqlstate).toBe("23514"); // check_violation

    // Adversarial: an INDIVIDUAL may not carry organisation-only fields.
    const sqlstate2 = await expectRawRejected(
      `INSERT INTO party (id, tenant_id, owner_legal_entity_id, code, party_type, given_name, legal_name, normalised_name, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'INDIVIDUAL', 'Mei', 'Acme', 'x', 'ACTIVE', 1, now(), now())`,
      [code("bad2"), setup.tenantId, owner.id, code("BAD2")],
    );
    expect(sqlstate2).toBe("23514");
  });

  it("party code is unique per tenant and archive state is symmetric with archivedAt", async () => {
    const db = createSystemClient();
    setup = await setupTestTenant();
    const owner = await createTestLegalEntity(setup.tenantId, "SG");
    const c = code("DUP");
    await db.party.create({
      data: {
        tenantId: setup.tenantId,
        ownerLegalEntityId: owner.id,
        code: c,
        partyType: "ORGANISATION",
        legalName: "One",
        normalisedName: "one",
      },
    });
    await expect(
      db.party.create({
        data: {
          tenantId: setup.tenantId,
          ownerLegalEntityId: owner.id,
          code: c,
          partyType: "ORGANISATION",
          legalName: "Two",
          normalisedName: "two",
        },
      }),
    ).rejects.toThrow();

    // ARCHIVED without archived_at is rejected by the database.
    const sqlstate = await expectRawRejected(
      `INSERT INTO party (id, tenant_id, owner_legal_entity_id, code, party_type, legal_name, normalised_name, status, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'ORGANISATION', 'X', 'x', 'ARCHIVED', 1, now(), now())`,
      [code("arch"), setup.tenantId, owner.id, code("ARCH")],
    );
    expect(sqlstate).toBe("23514");
  });

  it("a party has at most one primary contact", async () => {
    const db = createSystemClient();
    setup = await setupTestTenant();
    const owner = await createTestLegalEntity(setup.tenantId, "SG");
    const party = await db.party.create({
      data: {
        tenantId: setup.tenantId,
        ownerLegalEntityId: owner.id,
        code: code("P"),
        partyType: "ORGANISATION",
        legalName: "Contacts Ltd",
        normalisedName: "contacts ltd",
      },
    });
    await db.partyContact.create({
      data: {
        tenantId: setup.tenantId,
        partyId: party.id,
        givenName: "First",
        isPrimary: true,
      },
    });
    // A second NON-primary contact is fine.
    await db.partyContact.create({
      data: {
        tenantId: setup.tenantId,
        partyId: party.id,
        givenName: "Second",
        isPrimary: false,
      },
    });
    // A second PRIMARY contact is not.
    await expect(
      db.partyContact.create({
        data: {
          tenantId: setup.tenantId,
          partyId: party.id,
          givenName: "Third",
          isPrimary: true,
        },
      }),
    ).rejects.toThrow();
  });

  it("address country is an uppercase two-letter shape, and a foreign country is accepted descriptively", async () => {
    const db = createSystemClient();
    setup = await setupTestTenant();
    const owner = await createTestLegalEntity(setup.tenantId, "SG");
    const party = await db.party.create({
      data: {
        tenantId: setup.tenantId,
        ownerLegalEntityId: owner.id,
        code: code("ADDR"),
        partyType: "ORGANISATION",
        legalName: "Global Ltd",
        normalisedName: "global ltd",
      },
    });

    // A non-SG/MY/ID counterparty address is legitimate and must be storable.
    for (const cc of ["SG", "MY", "ID", "GB", "US", "JP"]) {
      const a = await db.partyAddress.create({
        data: {
          tenantId: setup.tenantId,
          partyId: party.id,
          addressType: "BILLING",
          line1: "1 Test Road",
          countryCode: cc,
        },
      });
      expect(a.countryCode).toBe(cc);
    }

    // Two independent defences reject a malformed code, and which one fires
    // depends on the input: `CHAR(2)` truncation-checks over-length values
    // (22001) before any CHECK constraint runs, while the shape CHECK catches
    // lower-case, digits and short values (23514, after CHAR(2) blank-pads).
    const rejections: ReadonlyArray<[value: string, sqlstate: string]> = [
      ["sg", "23514"],
      ["S", "23514"],
      ["12", "23514"],
      ["SGP", "22001"],
      ["sgp", "22001"],
    ];
    for (const [bad, expected] of rejections) {
      const sqlstate = await expectRawRejected(
        `INSERT INTO party_address (id, tenant_id, party_id, address_type, line1, country_code, status, version, created_at, updated_at)
         VALUES ($1, $2, $3, 'BILLING', 'x', $4, 'ACTIVE', 1, now(), now())`,
        [code("a"), setup.tenantId, party.id, bad],
      );
      expect(sqlstate, `country_code "${bad}" must be rejected`).toBe(expected);
    }
  });

  it("one assignment may carry BOTH a customer and a vendor role, with independent codes unique per legal entity", async () => {
    const db = createSystemClient();
    setup = await setupTestTenant();
    const le = await createTestLegalEntity(setup.tenantId, "SG");
    const party = await db.party.create({
      data: {
        tenantId: setup.tenantId,
        ownerLegalEntityId: le.id,
        code: code("BOTH"),
        partyType: "ORGANISATION",
        legalName: "Both Roles Pte Ltd",
        normalisedName: "both roles",
      },
    });
    const assignment = await db.partyLegalEntityAssignment.create({
      data: { tenantId: setup.tenantId, partyId: party.id, legalEntityId: le.id },
    });

    const custCode = code("C");
    const vendCode = code("V");
    await db.customerRole.create({
      data: {
        tenantId: setup.tenantId,
        legalEntityId: le.id,
        assignmentId: assignment.id,
        code: custCode,
      },
    });
    await db.vendorRole.create({
      data: {
        tenantId: setup.tenantId,
        legalEntityId: le.id,
        assignmentId: assignment.id,
        code: vendCode,
      },
    });

    const roles = await db.partyLegalEntityAssignment.findUnique({
      where: { id: assignment.id },
      include: { customerRole: true, vendorRole: true },
    });
    expect(roles?.customerRole?.code).toBe(custCode);
    expect(roles?.vendorRole?.code).toBe(vendCode);

    // Only one customer role per assignment.
    await expect(
      db.customerRole.create({
        data: {
          tenantId: setup.tenantId,
          legalEntityId: le.id,
          assignmentId: assignment.id,
          code: code("C2"),
        },
      }),
    ).rejects.toThrow();
  });

  it("composite foreign keys make a cross-tenant or cross-entity assignment structurally impossible", async () => {
    const db = createSystemClient();
    setup = await setupTestTenant();
    const otherSetup = await setupTestTenant();
    try {
      const leOther = await createTestLegalEntity(otherSetup.tenantId, "MY");
      const owner = await createTestLegalEntity(setup.tenantId, "SG");
      const party = await db.party.create({
        data: {
          tenantId: setup.tenantId,
          ownerLegalEntityId: owner.id,
          code: code("X"),
          partyType: "ORGANISATION",
          legalName: "Cross",
          normalisedName: "cross",
        },
      });

      // Assign our party to ANOTHER tenant's legal entity via raw SQL. The
      // composite FK (legal_entity_id, tenant_id) has no matching row.
      const sqlstate = await expectRawRejected(
        `INSERT INTO party_legal_entity_assignment
           (id, tenant_id, party_id, legal_entity_id, status, assigned_at, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'ACTIVE', now(), 1, now(), now())`,
        [code("as"), setup.tenantId, party.id, leOther.id],
      );
      expect(sqlstate).toBe("23503"); // foreign_key_violation
    } finally {
      await cleanupTenant(otherSetup.tenantId).catch(() => undefined);
      await cleanupUser(otherSetup.adminUserId).catch(() => undefined);
    }
  });

  it("concurrent duplicate customer codes and vendor codes each yield exactly one row", async () => {
    const db = createSystemClient();
    setup = await setupTestTenant();
    const le = await createTestLegalEntity(setup.tenantId, "SG");

    const assignments = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const p = await db.party.create({
          data: {
            tenantId: setup!.tenantId,
            ownerLegalEntityId: le.id,
            code: code(`R${i}`),
            partyType: "ORGANISATION",
            legalName: `Racer ${i}`,
            normalisedName: `racer ${i}`,
          },
        });
        return db.partyLegalEntityAssignment.create({
          data: { tenantId: setup!.tenantId, partyId: p.id, legalEntityId: le.id },
        });
      }),
    );

    const contested = code("RACE");
    const results = await Promise.allSettled(
      assignments.map((a) =>
        db.customerRole.create({
          data: {
            tenantId: setup!.tenantId,
            legalEntityId: le.id,
            assignmentId: a.id,
            code: contested,
          },
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const vendorResults = await Promise.allSettled(
      assignments.map((a) =>
        db.vendorRole.create({
          data: {
            tenantId: setup!.tenantId,
            legalEntityId: le.id,
            assignmentId: a.id,
            code: contested,
          },
        }),
      ),
    );
    expect(vendorResults.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Catalog invariants
  // -------------------------------------------------------------------------

  it("catalog item code is unique per tenant, categories/UOM cannot cross tenants, and referenced reference data cannot be deleted", async () => {
    const db = createSystemClient();
    setup = await setupTestTenant();
    const otherSetup = await setupTestTenant();
    try {
      const cat = await db.catalogCategory.create({
        data: { tenantId: setup.tenantId, code: code("CAT"), name: "Cat" },
      });
      const uom = await db.unitOfMeasure.create({
        data: { tenantId: setup.tenantId, code: code("EA"), name: "Each" },
      });
      const otherUom = await db.unitOfMeasure.create({
        data: { tenantId: otherSetup.tenantId, code: code("EA"), name: "Each" },
      });
      const owner = await createTestLegalEntity(setup.tenantId, "SG");

      const itemCode = code("SKU");
      await db.catalogItem.create({
        data: {
          tenantId: setup.tenantId,
          ownerLegalEntityId: owner.id,
          code: itemCode,
          itemType: "PRODUCT",
          name: "Widget",
          categoryId: cat.id,
          baseUomId: uom.id,
        },
      });
      await expect(
        db.catalogItem.create({
          data: {
            tenantId: setup.tenantId,
            ownerLegalEntityId: owner.id,
            code: itemCode,
            itemType: "SERVICE",
            name: "Dup",
            baseUomId: uom.id,
          },
        }),
      ).rejects.toThrow();

      // Cross-tenant UOM substitution through raw SQL.
      const sqlstate = await expectRawRejected(
        `INSERT INTO catalog_item (id, tenant_id, owner_legal_entity_id, code, item_type, name, base_uom_id, is_sellable, is_purchasable, status, version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'PRODUCT', 'X', $5, true, true, 'ACTIVE', 1, now(), now())`,
        [code("ci"), setup.tenantId, owner.id, code("SKU2"), otherUom.id],
      );
      expect(sqlstate).toBe("23503");

      // A referenced UOM cannot be destructively deleted (RESTRICT).
      await expect(db.unitOfMeasure.delete({ where: { id: uom.id } })).rejects.toThrow();
    } finally {
      await cleanupTenant(otherSetup.tenantId).catch(() => undefined);
      await cleanupUser(otherSetup.adminUserId).catch(() => undefined);
    }
  });

  it("catalog_item carries no inventory, costing or accounting columns", async () => {
    const cols = await raw((c) =>
      c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='catalog_item'`,
      ),
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const forbidden of [
      "is_stock_tracked",
      "quantity_on_hand",
      "stock_quantity",
      "valuation",
      "cost",
      "cost_method",
      "gl_account_id",
      "revenue_account_id",
      "variant_of_id",
    ]) {
      expect(
        names,
        `catalog_item must not have a ${forbidden} column in Phase 2`,
      ).not.toContain(forbidden);
    }
    // The one permitted inert placeholder.
    expect(names).toContain("tax_category_code");
    expect(names).toContain("owner_legal_entity_id");
  });

  // -------------------------------------------------------------------------
  // Price-list invariants
  // -------------------------------------------------------------------------

  it("a price entry cannot combine a price-list assignment and an item assignment from different legal entities", async () => {
    const db = createSystemClient();
    setup = await setupTestTenant();
    const leA = await createTestLegalEntity(setup.tenantId, "SG");
    const leB = await createTestLegalEntity(setup.tenantId, "MY");

    const uom = await db.unitOfMeasure.create({
      data: { tenantId: setup.tenantId, code: code("EA"), name: "Each" },
    });
    const item = await db.catalogItem.create({
      data: {
        tenantId: setup.tenantId,
        ownerLegalEntityId: leA.id,
        code: code("SKU"),
        itemType: "PRODUCT",
        name: "W",
        baseUomId: uom.id,
      },
    });
    const pl = await db.priceList.create({
      data: {
        tenantId: setup.tenantId,
        ownerLegalEntityId: leA.id,
        code: code("PL"),
        name: "Std",
        currency: "SGD",
      },
    });

    // Item assigned to entity B; price list assigned to entity A.
    const itemAssignB = await db.catalogItemLegalEntityAssignment.create({
      data: { tenantId: setup.tenantId, catalogItemId: item.id, legalEntityId: leB.id },
    });
    const plAssignA = await db.priceListLegalEntityAssignment.create({
      data: { tenantId: setup.tenantId, priceListId: pl.id, legalEntityId: leA.id },
    });

    // Raw SQL, claiming entity A: the catalog-item assignment's composite FK
    // (id, legal_entity_id) has no row for (itemAssignB.id, leA.id).
    const sqlstate = await expectRawRejected(
      `INSERT INTO price_list_entry
         (id, tenant_id, legal_entity_id, price_list_assignment_id, catalog_item_assignment_id,
          unit_price, effective_from, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 10.00, '2026-01-01', 1, now(), now())`,
      [code("pe"), setup.tenantId, leA.id, plAssignA.id, itemAssignB.id],
    );
    expect(sqlstate).toBe("23503");

    // Claiming entity B instead fails on the price-list assignment side.
    const sqlstate2 = await expectRawRejected(
      `INSERT INTO price_list_entry
         (id, tenant_id, legal_entity_id, price_list_assignment_id, catalog_item_assignment_id,
          unit_price, effective_from, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 10.00, '2026-01-01', 1, now(), now())`,
      [code("pe2"), setup.tenantId, leB.id, plAssignA.id, itemAssignB.id],
    );
    expect(sqlstate2).toBe("23503");
  });

  it("exactly one ACTIVE default price list per legal entity, including under a concurrent race", async () => {
    const db = createSystemClient();
    setup = await setupTestTenant();
    const le = await createTestLegalEntity(setup.tenantId, "SG");

    const lists = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        db.priceList.create({
          data: {
            tenantId: setup!.tenantId,
            ownerLegalEntityId: le.id,
            code: code(`PL${i}`),
            name: `L${i}`,
            currency: "SGD",
          },
        }),
      ),
    );

    const results = await Promise.allSettled(
      lists.map((l) =>
        db.priceListLegalEntityAssignment.create({
          data: {
            tenantId: setup!.tenantId,
            priceListId: l.id,
            legalEntityId: le.id,
            isDefault: true,
          },
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const defaults = await db.priceListLegalEntityAssignment.count({
      where: { legalEntityId: le.id, isDefault: true, status: "ACTIVE" },
    });
    expect(defaults).toBe(1);
  });

  it("prices are exact NUMERIC(23,6), never negative, and round-trip at both magnitude extremes", async () => {
    const db = createSystemClient();
    setup = await setupTestTenant();
    const le = await createTestLegalEntity(setup.tenantId, "ID");
    const uom = await db.unitOfMeasure.create({
      data: { tenantId: setup.tenantId, code: code("EA"), name: "Each" },
    });
    const item = await db.catalogItem.create({
      data: {
        tenantId: setup.tenantId,
        ownerLegalEntityId: le.id,
        code: code("SKU"),
        itemType: "PRODUCT",
        name: "W",
        baseUomId: uom.id,
      },
    });
    const pl = await db.priceList.create({
      data: {
        tenantId: setup.tenantId,
        ownerLegalEntityId: le.id,
        code: code("PL"),
        name: "L",
        currency: "IDR",
      },
    });
    const ia = await db.catalogItemLegalEntityAssignment.create({
      data: { tenantId: setup.tenantId, catalogItemId: item.id, legalEntityId: le.id },
    });
    const pa = await db.priceListLegalEntityAssignment.create({
      data: { tenantId: setup.tenantId, priceListId: pl.id, legalEntityId: le.id },
    });

    // Smallest representable unit and a very large IDR-scale value.
    const values = ["0.000001", "99999999999999999.999999", "0"];
    for (const [i, v] of values.entries()) {
      await db.priceListEntry.create({
        data: {
          tenantId: setup.tenantId,
          legalEntityId: le.id,
          priceListAssignmentId: pa.id,
          catalogItemAssignmentId: ia.id,
          unitPrice: v,
          effectiveFrom: new Date(Date.UTC(2020 + i, 0, 1)),
          effectiveTo: new Date(Date.UTC(2020 + i, 5, 30)),
        },
      });
    }

    // Read back through an INDEPENDENT raw connection: proves the bytes on
    // disk, not what Prisma echoes to itself.
    const stored = await raw((c) =>
      c.query<{ unit_price: string }>(
        `SELECT unit_price::text FROM price_list_entry
          WHERE catalog_item_assignment_id = $1 ORDER BY effective_from`,
        [ia.id],
      ),
    );
    expect(stored.rows.map((r) => r.unit_price)).toEqual([
      "0.000001",
      "99999999999999999.999999",
      "0.000000",
    ]);

    const sqlstate = await expectRawRejected(
      `INSERT INTO price_list_entry
         (id, tenant_id, legal_entity_id, price_list_assignment_id, catalog_item_assignment_id,
          unit_price, effective_from, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, -0.01, '2030-01-01', 1, now(), now())`,
      [code("neg"), setup.tenantId, le.id, pa.id, ia.id],
    );
    expect(sqlstate).toBe("23514");
  });

  it("overlapping price-effective periods are rejected by PostgreSQL; adjacent, same-day and open-ended ranges behave correctly", async () => {
    const db = createSystemClient();
    setup = await setupTestTenant();
    const le = await createTestLegalEntity(setup.tenantId, "SG");
    const uom = await db.unitOfMeasure.create({
      data: { tenantId: setup.tenantId, code: code("EA"), name: "Each" },
    });
    const item = await db.catalogItem.create({
      data: {
        tenantId: setup.tenantId,
        ownerLegalEntityId: le.id,
        code: code("SKU"),
        itemType: "PRODUCT",
        name: "W",
        baseUomId: uom.id,
      },
    });
    const pl = await db.priceList.create({
      data: {
        tenantId: setup.tenantId,
        ownerLegalEntityId: le.id,
        code: code("PL"),
        name: "L",
        currency: "SGD",
      },
    });
    const ia = await db.catalogItemLegalEntityAssignment.create({
      data: { tenantId: setup.tenantId, catalogItemId: item.id, legalEntityId: le.id },
    });
    const pa = await db.priceListLegalEntityAssignment.create({
      data: { tenantId: setup.tenantId, priceListId: pl.id, legalEntityId: le.id },
    });

    const insert = (from: string, to: string | null, price = "1.5") =>
      raw((c) =>
        c.query(
          `INSERT INTO price_list_entry
             (id, tenant_id, legal_entity_id, price_list_assignment_id, catalog_item_assignment_id,
              unit_price, effective_from, effective_to, version, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,1,now(),now())`,
          [code("pe"), setup!.tenantId, le.id, pa.id, ia.id, price, from, to],
        ),
      );

    // 1. Jan 1 – Mar 31 inclusive.
    await insert("2026-01-01", "2026-03-31");

    // 2. ADJACENT (Apr 1 onwards) is accepted — no overlap.
    await insert("2026-04-01", "2026-06-30");

    // 3. OVERLAP by a single day (Mar 31) is rejected.
    let state = "";
    try {
      await insert("2026-03-31", "2026-05-01");
    } catch (e) {
      state = (e as { code?: string }).code ?? "";
    }
    expect(state, "a one-day overlap must be rejected").toBe("23P01"); // exclusion_violation

    // 4. SAME-DAY single-day range immediately after the last one is fine.
    await insert("2026-07-01", "2026-07-01");

    // 5. OPEN-ENDED range from Aug 1 is accepted...
    await insert("2026-08-01", null);

    // ...and any later range now overlaps it, however far in the future.
    let state2 = "";
    try {
      await insert("2099-01-01", null);
    } catch (e) {
      state2 = (e as { code?: string }).code ?? "";
    }
    expect(state2, "an open-ended range must block all later ranges").toBe("23P01");

    // effective_to before effective_from is rejected by CHECK, not EXCLUDE.
    const badRange = await expectRawRejected(
      `INSERT INTO price_list_entry
         (id, tenant_id, legal_entity_id, price_list_assignment_id, catalog_item_assignment_id,
          unit_price, effective_from, effective_to, version, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,1.0,'2027-05-01','2027-04-01',1,now(),now())`,
      [code("pe"), setup.tenantId, le.id, pa.id, ia.id],
    );
    expect(badRange).toBe("23514");
  });

  it("a stored effective date reads back as the same civil day under every SG/MY/ID session timezone", async () => {
    const db = createSystemClient();
    setup = await setupTestTenant();
    const le = await createTestLegalEntity(setup.tenantId, "ID");
    const uom = await db.unitOfMeasure.create({
      data: { tenantId: setup.tenantId, code: code("EA"), name: "Each" },
    });
    const item = await db.catalogItem.create({
      data: {
        tenantId: setup.tenantId,
        ownerLegalEntityId: le.id,
        code: code("SKU"),
        itemType: "PRODUCT",
        name: "W",
        baseUomId: uom.id,
      },
    });
    const pl = await db.priceList.create({
      data: {
        tenantId: setup.tenantId,
        ownerLegalEntityId: le.id,
        code: code("PL"),
        name: "L",
        currency: "IDR",
      },
    });
    const ia = await db.catalogItemLegalEntityAssignment.create({
      data: { tenantId: setup.tenantId, catalogItemId: item.id, legalEntityId: le.id },
    });
    const pa = await db.priceListLegalEntityAssignment.create({
      data: { tenantId: setup.tenantId, priceListId: pl.id, legalEntityId: le.id },
    });
    const entry = await db.priceListEntry.create({
      data: {
        tenantId: setup.tenantId,
        legalEntityId: le.id,
        priceListAssignmentId: pa.id,
        catalogItemAssignmentId: ia.id,
        unitPrice: "12.500000",
        effectiveFrom: new Date(Date.UTC(2026, 6, 1)),
      },
    });

    const zones = [
      "UTC",
      "Asia/Singapore",
      "Asia/Kuala_Lumpur",
      "Asia/Jakarta",
      "Asia/Jayapura",
      "Etc/GMT+5",
    ];
    const seen: string[] = [];
    for (const zone of zones) {
      const c = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
      await c.connect();
      try {
        await c.query(`SET TIME ZONE '${zone}'`);
        const r = await c.query<{ d: string }>(
          "SELECT to_char(effective_from, 'YYYY-MM-DD') AS d FROM price_list_entry WHERE id = $1",
          [entry.id],
        );
        seen.push(r.rows[0]!.d);
      } finally {
        await c.end();
      }
    }
    expect(new Set(seen).size, `civil date drifted across zones: ${seen.join(",")}`).toBe(
      1,
    );
    expect(seen[0]).toBe("2026-07-01");
  });
});
