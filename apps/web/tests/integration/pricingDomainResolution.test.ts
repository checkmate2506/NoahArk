import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { NotFoundError, ValidationError } from "@noahark/core";
import { createSystemClient } from "@noahark/db/system";
import {
  createPriceListEntry,
  resolveEffectivePrice,
  setDefaultPriceList,
  updatePriceListAssignment,
} from "@noahark/catalog";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  createTestItem,
  createTestPriceList,
  createTestUom,
  setupPricingDomainFixture,
  type PricingDomainFixture,
} from "./pricingDomainFixture";

describe("P2C.2 — effective price resolution", () => {
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

  it("resolves inclusive bounds, defaults, and inactive inputs uniformly", async () => {
    fixture = await setupPricingDomainFixture();
    const { ctxA, ctxAB, leA, leB, setup } = fixture;
    const uom = await createTestUom(ctxA);
    const item = await createTestItem(ctxA, leA.id, uom.id);
    const list = await createTestPriceList(ctxA, leA.id);
    await createPriceListEntry(ctxA, {
      priceListAssignmentId: list.assignment.id,
      catalogItemAssignmentId: item.assignment.id,
      unitPrice: "12.5",
      effectiveFrom: "2026-07-01",
      effectiveTo: "2026-07-31",
    });
    const db = createSystemClient();
    const auditsBefore = await db.auditEvent.count({
      where: { tenantId: setup.tenantId },
    });

    const onFrom = await resolveEffectivePrice(ctxA, {
      legalEntityId: leA.id,
      catalogItemId: item.item.id,
      priceListId: list.priceList.id,
      onDate: "2026-07-01",
    });
    expect(onFrom).toMatchObject({ resolved: true, unitPrice: "12.500000" });
    expect(await db.auditEvent.count({ where: { tenantId: setup.tenantId } })).toBe(
      auditsBefore,
    );
    const onTo = await resolveEffectivePrice(ctxA, {
      legalEntityId: leA.id,
      catalogItemId: item.item.id,
      priceListId: list.priceList.id,
      onDate: "2026-07-31",
    });
    expect(onTo.resolved).toBe(true);
    const interior = await resolveEffectivePrice(ctxA, {
      legalEntityId: leA.id,
      catalogItemId: item.item.id,
      priceListId: list.priceList.id,
      onDate: "2026-07-15",
    });
    expect(interior.resolved).toBe(true);
    const before = await resolveEffectivePrice(ctxA, {
      legalEntityId: leA.id,
      catalogItemId: item.item.id,
      priceListId: list.priceList.id,
      onDate: "2026-06-30",
    });
    expect(before).toMatchObject({ resolved: false, unitPrice: null });
    const after = await resolveEffectivePrice(ctxA, {
      legalEntityId: leA.id,
      catalogItemId: item.item.id,
      priceListId: list.priceList.id,
      onDate: "2026-08-01",
    });
    expect(after.resolved).toBe(false);

    const openList = await createTestPriceList(ctxA, leA.id, "SGD", "Open");
    const openItem = await createTestItem(ctxA, leA.id, uom.id, "Open item");
    await createPriceListEntry(ctxA, {
      priceListAssignmentId: openList.assignment.id,
      catalogItemAssignmentId: openItem.assignment.id,
      unitPrice: "1",
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    });
    const far = await resolveEffectivePrice(ctxA, {
      legalEntityId: leA.id,
      catalogItemId: openItem.item.id,
      priceListId: openList.priceList.id,
      onDate: "2099-12-31",
    });
    expect(far.resolved).toBe(true);

    await expect(
      resolveEffectivePrice(ctxA, {
        legalEntityId: leA.id,
        catalogItemId: item.item.id,
        priceListId: list.priceList.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await setDefaultPriceList(ctxA, {
      legalEntityId: leA.id,
      priceListId: list.priceList.id,
    });
    const viaDefault = await resolveEffectivePrice(ctxA, {
      legalEntityId: leA.id,
      catalogItemId: item.item.id,
      onDate: "2026-07-15",
    });
    expect(viaDefault.resolved).toBe(true);
    await setDefaultPriceList(ctxA, { legalEntityId: leA.id, priceListId: null });
    await expect(
      resolveEffectivePrice(ctxA, {
        legalEntityId: leA.id,
        catalogItemId: item.item.id,
        onDate: "2026-07-15",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const { createPriceListAssignment } = await import("@noahark/catalog");
    await createPriceListAssignment(ctxAB, {
      priceListId: list.priceList.id,
      legalEntityId: leB.id,
    });
    const suspended = await updatePriceListAssignment(ctxAB, list.assignment.id, {
      expectedVersion: (
        await db.priceListLegalEntityAssignment.findFirstOrThrow({
          where: { id: list.assignment.id },
        })
      ).version,
      status: "SUSPENDED",
    });
    await expect(
      resolveEffectivePrice(ctxA, {
        legalEntityId: leA.id,
        catalogItemId: item.item.id,
        priceListId: list.priceList.id,
        onDate: "2026-07-15",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await updatePriceListAssignment(ctxAB, suspended.id, {
      expectedVersion: suspended.version,
      status: "ACTIVE",
    });
    const itemAssign = await db.catalogItemLegalEntityAssignment.findFirstOrThrow({
      where: { id: item.assignment.id },
    });
    await db.catalogItemLegalEntityAssignment.update({
      where: { id: itemAssign.id },
      data: { status: "SUSPENDED" },
    });
    await expect(
      resolveEffectivePrice(ctxA, {
        legalEntityId: leA.id,
        catalogItemId: item.item.id,
        priceListId: list.priceList.id,
        onDate: "2026-07-15",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await db.catalogItemLegalEntityAssignment.update({
      where: { id: itemAssign.id },
      data: { status: "ACTIVE" },
    });

    await db.priceList.update({
      where: { id: list.priceList.id },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });
    await expect(
      resolveEffectivePrice(ctxA, {
        legalEntityId: leA.id,
        catalogItemId: item.item.id,
        priceListId: list.priceList.id,
        onDate: "2026-07-15",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const previousTz = process.env.TZ;
    try {
      for (const zone of ["Asia/Jakarta", "Asia/Jayapura", "Etc/GMT+12"]) {
        process.env.TZ = zone;
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error("DATABASE_URL is not set");
        const client = new pg.Client({ connectionString: url });
        await client.connect();
        try {
          await client.query(`SET TIME ZONE '${zone}'`);
        } finally {
          await client.end();
        }
        const resolved = await resolveEffectivePrice(ctxA, {
          legalEntityId: leA.id,
          catalogItemId: openItem.item.id,
          priceListId: openList.priceList.id,
          onDate: "2026-07-15",
        });
        expect(resolved.resolved).toBe(true);
      }
    } finally {
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    }
  });
});
