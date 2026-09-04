import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { ConflictError, StaleVersionError, ValidationError } from "@noahark/core";
import { tenantContextInput } from "@noahark/core";
import { withTenantContext } from "@noahark/db";
import {
  archivePriceListAssignment,
  closePriceListEntry,
  createPriceListAssignment,
  createPriceListEntry,
  getPriceListEntry,
  listPriceListEntries,
  updatePriceListAssignment,
  updatePriceListEntry,
} from "@noahark/catalog";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  createTestItem,
  createTestPriceList,
  createTestUom,
  setupPricingDomainFixture,
  type PricingDomainFixture,
} from "./pricingDomainFixture";

async function raw<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function expectRawRejected(sql: string, params: unknown[] = []): Promise<string> {
  return raw(async (c) => {
    try {
      await c.query(sql, params);
    } catch (e) {
      return (e as { code?: string }).code ?? "UNKNOWN";
    }
    throw new Error("expected raw SQL to be rejected");
  });
}

describe("P2C.2 — price list entries", () => {
  let fixture: PricingDomainFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("stores exact decimals, polices ranges, and allows close after assignment archive", async () => {
    fixture = await setupPricingDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const uom = await createTestUom(ctxA);
    const item = await createTestItem(ctxA, leA.id, uom.id);
    const list = await createTestPriceList(ctxA, leA.id);

    const values = ["0", "0.000001", "99999999999999999.999999"] as const;
    const createdIds: string[] = [];
    for (const [i, unitPrice] of values.entries()) {
      const entry = await createPriceListEntry(ctxA, {
        priceListAssignmentId: list.assignment.id,
        catalogItemAssignmentId: item.assignment.id,
        unitPrice,
        effectiveFrom: `2020-0${i + 1}-01`,
        effectiveTo: `2020-0${i + 1}-15`,
      });
      expect(entry.unitPrice.endsWith("000") || entry.unitPrice.includes(".")).toBe(true);
      createdIds.push(entry.id);
    }
    const stored = await raw((c) =>
      c.query<{ unit_price: string }>(
        `SELECT unit_price::text FROM price_list_entry
          WHERE price_list_assignment_id = $1
          ORDER BY effective_from`,
        [list.assignment.id],
      ),
    );
    expect(stored.rows.map((r) => r.unit_price)).toEqual([
      "0.000000",
      "0.000001",
      "99999999999999999.999999",
    ]);

    await expect(
      createPriceListEntry(ctxA, {
        priceListAssignmentId: list.assignment.id,
        catalogItemAssignmentId: item.assignment.id,
        unitPrice: "-1",
        effectiveFrom: "2021-01-01",
        effectiveTo: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const neg = await expectRawRejected(
      `INSERT INTO price_list_entry
         (id, tenant_id, legal_entity_id, price_list_assignment_id, catalog_item_assignment_id,
          unit_price, effective_from, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, -0.01, '2030-01-01', 1, now(), now())`,
      [
        randomBytes(12).toString("hex"),
        ctxA.tenantId,
        leA.id,
        list.assignment.id,
        item.assignment.id,
      ],
    );
    expect(neg).toBe("23514");

    const jan = await createPriceListEntry(ctxA, {
      priceListAssignmentId: list.assignment.id,
      catalogItemAssignmentId: item.assignment.id,
      unitPrice: "1",
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-01-31",
    });
    const feb = await createPriceListEntry(ctxA, {
      priceListAssignmentId: list.assignment.id,
      catalogItemAssignmentId: item.assignment.id,
      unitPrice: "2",
      effectiveFrom: "2026-02-01",
      effectiveTo: "2026-02-28",
    });
    await expect(
      createPriceListEntry(ctxA, {
        priceListAssignmentId: list.assignment.id,
        catalogItemAssignmentId: item.assignment.id,
        unitPrice: "3",
        effectiveFrom: "2026-01-01",
        effectiveTo: "2026-02-01",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const sameDay = await createPriceListEntry(ctxA, {
      priceListAssignmentId: list.assignment.id,
      catalogItemAssignmentId: item.assignment.id,
      unitPrice: "4",
      effectiveFrom: "2026-03-01",
      effectiveTo: "2026-03-01",
    });
    expect(sameDay.effectiveFrom).toBe("2026-03-01");

    const open = await createPriceListEntry(ctxA, {
      priceListAssignmentId: list.assignment.id,
      catalogItemAssignmentId: item.assignment.id,
      unitPrice: "5",
      effectiveFrom: "2026-04-01",
      effectiveTo: null,
    });
    await expect(
      createPriceListEntry(ctxA, {
        priceListAssignmentId: list.assignment.id,
        catalogItemAssignmentId: item.assignment.id,
        unitPrice: "6",
        effectiveFrom: "2026-05-01",
        effectiveTo: null,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const otherItem = await createTestItem(ctxAB, leB.id, uom.id, "B item");
    await expect(
      createPriceListEntry(ctxAB, {
        priceListAssignmentId: list.assignment.id,
        catalogItemAssignmentId: otherItem.assignment.id,
        unitPrice: "1",
        effectiveFrom: "2027-01-01",
        effectiveTo: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const fk = await expectRawRejected(
      `INSERT INTO price_list_entry
         (id, tenant_id, legal_entity_id, price_list_assignment_id, catalog_item_assignment_id,
          unit_price, effective_from, version, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, '2027-01-01', 1, now(), now())`,
      [
        randomBytes(12).toString("hex"),
        ctxA.tenantId,
        leA.id,
        list.assignment.id,
        otherItem.assignment.id,
      ],
    );
    expect(fk).toBe("23503");

    await expect(
      createPriceListEntry(ctxA, {
        priceListAssignmentId: list.assignment.id,
        catalogItemAssignmentId: item.assignment.id,
        unitPrice: "1",
        effectiveFrom: "2028-02-01",
        effectiveTo: "2028-01-01",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await createPriceListAssignment(ctxAB, {
      priceListId: list.priceList.id,
      legalEntityId: leB.id,
    });
    const suspended = await updatePriceListAssignment(ctxAB, list.assignment.id, {
      expectedVersion: list.assignment.version,
      status: "SUSPENDED",
    });
    await expect(
      updatePriceListEntry(ctxA, jan.id, {
        expectedVersion: jan.version,
        unitPrice: "9",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await getPriceListEntry(ctxA, jan.id)).toMatchObject({ id: jan.id });
    const listed = await listPriceListEntries(ctxA, {
      priceListAssignmentId: list.assignment.id,
    });
    expect(listed.items.some((row) => row.id === jan.id)).toBe(true);
    const closedWhileSuspended = await closePriceListEntry(ctxA, open.id, {
      expectedVersion: open.version,
      effectiveTo: "2026-12-31",
    });
    expect(closedWhileSuspended.effectiveTo).toBe("2026-12-31");

    const reactivated = await updatePriceListAssignment(ctxAB, list.assignment.id, {
      expectedVersion: suspended.version,
      status: "ACTIVE",
    });
    const updatedSameDay = await updatePriceListEntry(ctxA, sameDay.id, {
      expectedVersion: sameDay.version,
      unitPrice: "8",
    });
    expect(updatedSameDay.unitPrice).toBe("8.000000");
    const archived = await archivePriceListAssignment(
      ctxAB,
      reactivated.id,
      reactivated.version,
    );
    expect(archived.status).toBe("ARCHIVED");
    expect(await getPriceListEntry(ctxA, feb.id)).toMatchObject({ id: feb.id });
    const closedFromE = await closePriceListEntry(ctxA, feb.id, {
      expectedVersion: feb.version,
      effectiveTo: "2026-02-15",
    });
    expect(closedFromE.effectiveTo).toBe("2026-02-15");
    await expect(
      closePriceListEntry(ctxA, feb.id, {
        expectedVersion: closedFromE.version,
        effectiveTo: "2026-02-15",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      closePriceListEntry(ctxA, feb.id, {
        expectedVersion: closedFromE.version,
        effectiveTo: "2026-02-20",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      closePriceListEntry(ctxA, jan.id, {
        expectedVersion: jan.version,
        effectiveTo: "2025-12-31",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const adjacentClose = await closePriceListEntry(ctxA, jan.id, {
      expectedVersion: jan.version,
      effectiveTo: "2026-01-20",
    });
    expect(adjacentClose.effectiveTo).toBe("2026-01-20");
    await expect(
      closePriceListEntry(ctxA, jan.id, {
        expectedVersion: jan.version,
        effectiveTo: "2026-01-15",
      }),
    ).rejects.toBeInstanceOf(StaleVersionError);

    await expect(
      updatePriceListEntry(ctxA, sameDay.id, {
        expectedVersion: updatedSameDay.version,
        unitPrice: "7",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(
      Object.keys(await import("@noahark/catalog")).filter(
        (k) => k === "deletePriceListEntry" || k === "archivePriceListEntry",
      ),
    ).toEqual([]);
    expect(createdIds.length).toBe(3);
  });

  it("captures the sanitized Prisma adapter shape of a live exclusion violation", async () => {
    fixture = await setupPricingDomainFixture();
    const { ctxA, leA } = fixture;
    const uom = await createTestUom(ctxA);
    const item = await createTestItem(ctxA, leA.id, uom.id);
    const list = await createTestPriceList(ctxA, leA.id);
    await createPriceListEntry(ctxA, {
      priceListAssignmentId: list.assignment.id,
      catalogItemAssignmentId: item.assignment.id,
      unitPrice: "1",
      effectiveFrom: "2026-07-01",
      effectiveTo: "2026-07-31",
    });
    try {
      await withTenantContext(tenantContextInput(ctxA), async (tx) => {
        await tx.priceListEntry.create({
          data: {
            tenantId: ctxA.tenantId,
            legalEntityId: leA.id,
            priceListAssignmentId: list.assignment.id,
            catalogItemAssignmentId: item.assignment.id,
            unitPrice: "2",
            effectiveFrom: new Date(Date.UTC(2026, 6, 15)),
            effectiveTo: new Date(Date.UTC(2026, 6, 20)),
          },
        });
      });
      throw new Error("expected exclusion violation");
    } catch (error) {
      expect((error as Error).message).not.toBe("expected exclusion violation");
      const rec = error as {
        name?: string;
        code?: unknown;
        meta?: {
          driverAdapterError?: {
            name?: unknown;
            cause?: {
              code?: unknown;
              originalCode?: unknown;
              kind?: unknown;
            };
          };
        };
      };
      expect(error?.constructor?.name).toBe("PrismaClientKnownRequestError");
      expect(rec.code).toBe("P2039");
      expect(Object.keys(rec.meta ?? {}).sort()).toEqual([
        "driverAdapterError",
        "modelName",
      ]);
      const adapter = rec.meta?.driverAdapterError;
      expect(adapter?.constructor?.name).toBe("DriverAdapterError");
      expect(Object.keys(adapter ?? {}).sort()).toEqual(["cause", "name"]);
      const nested = adapter?.cause;
      expect(Object.keys(nested ?? {}).sort()).toEqual([
        "code",
        "column",
        "detail",
        "hint",
        "kind",
        "message",
        "originalCode",
        "originalMessage",
        "severity",
      ]);
      expect(nested?.code).toBe("23P01");
      expect(nested?.originalCode).toBe("23P01");
      expect(nested?.kind).toBe("postgres");
    }
  });
});
