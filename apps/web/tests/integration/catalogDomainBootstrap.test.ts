import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "@noahark/core";
import { createSystemClient } from "@noahark/db/system";
import {
  createCatalogItem,
  deactivateCatalogCategory,
  deactivateUnitOfMeasure,
} from "@noahark/catalog";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  catalogCode,
  createTestCategory,
  createTestUom,
  setupCatalogDomainFixture,
  type CatalogDomainFixture,
} from "./catalogDomainFixture";

describe("P2C.1 — atomic catalog item bootstrap", () => {
  let fixture: CatalogDomainFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("creates item and owner assignment atomically and rolls back on assignment or reference failure", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, leA, setup } = fixture;
    const category = await createTestCategory(ctxA);
    const uom = await createTestUom(ctxA);
    const created = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "SERVICE",
      name: "Install",
      categoryId: category.id,
      baseUomId: uom.id,
      entityItemCode: "LOCAL-1",
    });
    expect(created).toMatchObject({
      item: { id: created.item.id, status: "ACTIVE" },
      assignment: {
        catalogItemId: created.item.id,
        legalEntityId: leA.id,
        status: "ACTIVE",
      },
    });

    const db = createSystemClient();
    await expect(
      createCatalogItem(ctxA, {
        ownerLegalEntityId: leA.id,
        code: catalogCode("SKU"),
        itemType: "PRODUCT",
        name: "Dup code path",
        baseUomId: uom.id,
        entityItemCode: "LOCAL-1",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(
      await db.catalogItem.count({
        where: { tenantId: setup.tenantId, name: "Dup code path" },
      }),
    ).toBe(0);

    await expect(
      createCatalogItem(ctxA, {
        ownerLegalEntityId: leA.id,
        code: catalogCode("SKU"),
        itemType: "PRODUCT",
        name: "Bad FK",
        baseUomId: "missing-uom",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(
      await db.catalogItem.count({ where: { tenantId: setup.tenantId, name: "Bad FK" } }),
    ).toBe(0);

    await deactivateCatalogCategory(ctxA, category.id, {
      expectedVersion: category.version,
    });
    await expect(
      createCatalogItem(ctxA, {
        ownerLegalEntityId: leA.id,
        code: catalogCode("SKU"),
        itemType: "PRODUCT",
        name: "Inactive cat",
        categoryId: category.id,
        baseUomId: uom.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await deactivateUnitOfMeasure(ctxA, uom.id, { expectedVersion: uom.version });
    const freshUom = await createTestUom(ctxA, "Pair");
    await expect(
      createCatalogItem(ctxA, {
        ownerLegalEntityId: leA.id,
        code: catalogCode("SKU"),
        itemType: "PRODUCT",
        name: "Inactive uom",
        baseUomId: uom.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const noCategory = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "No category",
      baseUomId: freshUom.id,
    });
    expect(noCategory.item.categoryId).toBeNull();

    await expect(
      createCatalogItem(ctxA, {
        ownerLegalEntityId: leA.id,
        code: catalogCode("SKU"),
        itemType: "PRODUCT",
        name: "Foreign category",
        categoryId: "foreign-category-id",
        baseUomId: freshUom.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const activeItems = await db.catalogItem.findMany({
      where: { tenantId: setup.tenantId, status: "ACTIVE" },
    });
    for (const item of activeItems) {
      const activeAssignments = await db.catalogItemLegalEntityAssignment.count({
        where: { catalogItemId: item.id, status: "ACTIVE" },
      });
      expect(activeAssignments).toBeGreaterThanOrEqual(1);
    }
  });
});
