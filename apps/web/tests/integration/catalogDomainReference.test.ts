import { afterEach, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError, ValidationError } from "@noahark/core";
import { createSystemClient } from "@noahark/db/system";
import {
  activateCatalogCategory,
  createCatalogCategory,
  createCatalogItem,
  deactivateCatalogCategory,
  deactivateUnitOfMeasure,
  getCatalogCategory,
  listCatalogCategories,
  updateCatalogCategory,
  updateCatalogItem,
  createUnitOfMeasure,
  getUnitOfMeasure,
  listUnitsOfMeasure,
  updateUnitOfMeasure,
  activateUnitOfMeasure,
} from "@noahark/catalog";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  catalogCode,
  createTestCategory,
  createTestUom,
  setupCatalogDomainFixture,
  type CatalogDomainFixture,
} from "./catalogDomainFixture";

describe("P2C.1 — category and UOM reference data", () => {
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

  it("supports CRUD, uniqueness, visibility, versions, and empty-scope fail-closed", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, ctxB, ctxNone, setup } = fixture;
    const category = await createCatalogCategory(ctxA, {
      code: catalogCode("CAT"),
      name: "Goods",
    });
    expect(category.isActive).toBe(true);
    expect(await getCatalogCategory(ctxB, category.id)).toMatchObject({
      id: category.id,
    });
    await expect(
      createCatalogCategory(ctxA, { code: category.code, name: "Dup" }),
    ).rejects.toBeInstanceOf(Error);
    const updated = await updateCatalogCategory(ctxA, category.id, {
      expectedVersion: category.version,
      name: "Goods 2",
    });
    expect(updated.version).toBe(category.version + 1);
    await expect(
      updateCatalogCategory(ctxA, category.id, {
        expectedVersion: updated.version,
        name: "X",
        code: "NOPE",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const deactivated = await deactivateCatalogCategory(ctxA, category.id, {
      expectedVersion: updated.version,
    });
    expect(deactivated.isActive).toBe(false);
    await expect(
      deactivateCatalogCategory(ctxA, category.id, {
        expectedVersion: deactivated.version,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    const activated = await activateCatalogCategory(ctxA, category.id, {
      expectedVersion: deactivated.version,
    });
    expect(activated.isActive).toBe(true);

    const uom = await createUnitOfMeasure(ctxA, {
      code: catalogCode("UOM"),
      name: "Each",
    });
    expect(await getUnitOfMeasure(ctxB, uom.id)).toMatchObject({ id: uom.id });
    await updateUnitOfMeasure(ctxA, uom.id, {
      expectedVersion: uom.version,
      name: "Each 2",
    });

    const db = createSystemClient();
    const beforeCount = await db.catalogCategory.count({
      where: { tenantId: setup.tenantId },
    });
    await expect(
      createCatalogCategory(ctxNone, { code: catalogCode("X"), name: "N" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getCatalogCategory(ctxNone, category.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(listCatalogCategories(ctxNone)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      updateCatalogCategory(ctxNone, category.id, { expectedVersion: 1, name: "N" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      deactivateCatalogCategory(ctxNone, category.id, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      activateCatalogCategory(ctxNone, category.id, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.catalogCategory.count({ where: { tenantId: setup.tenantId } })).toBe(
      beforeCount,
    );

    const uomBefore = await db.unitOfMeasure.count({
      where: { tenantId: setup.tenantId },
    });
    await expect(
      createUnitOfMeasure(ctxNone, { code: catalogCode("U"), name: "N" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getUnitOfMeasure(ctxNone, uom.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(listUnitsOfMeasure(ctxNone)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      updateUnitOfMeasure(ctxNone, uom.id, { expectedVersion: 1, name: "N" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      deactivateUnitOfMeasure(ctxNone, uom.id, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      activateUnitOfMeasure(ctxNone, uom.id, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.unitOfMeasure.count({ where: { tenantId: setup.tenantId } })).toBe(
      uomBefore,
    );

    const page1 = await listCatalogCategories(ctxA, { limit: 1, q: "Goods" });
    expect(page1.categories.length).toBe(1);
    if (page1.nextCursor) {
      const page2 = await listCatalogCategories(ctxA, {
        limit: 1,
        q: "Goods",
        cursor: page1.nextCursor,
      });
      expect(page2.categories[0]?.id).not.toBe(page1.categories[0]?.id);
    }

    const other = await db.tenant.findFirst({
      where: { id: { not: setup.tenantId } },
    });
    if (other) {
      await expect(getCatalogCategory(ctxA, "not-a-real-id")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    }

    const listed = await listCatalogCategories(ctxA, { q: "Goods" });
    expect(listed.categories.some((row) => row.id === category.id)).toBe(true);
  });

  it("1-A: unrelated and echo updates succeed after deactivation; changing to inactive fails with no write", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, leA, setup } = fixture;
    const category = await createTestCategory(ctxA);
    const inactiveTarget = await createTestCategory(ctxA, "Inactive target");
    const uom = await createTestUom(ctxA);
    const inactiveUom = await createTestUom(ctxA, "Inactive UOM");
    const created = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Widget",
      categoryId: category.id,
      baseUomId: uom.id,
    });
    const db = createSystemClient();

    await deactivateCatalogCategory(ctxA, category.id, {
      expectedVersion: category.version,
    });
    const renamed = await updateCatalogItem(ctxA, created.item.id, {
      expectedVersion: created.item.version,
      name: "Widget 2",
    });
    expect(renamed.version).toBe(created.item.version + 1);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: setup.tenantId,
          entityId: created.item.id,
          action: "catalog_item.updated",
        },
      }),
    ).toBeGreaterThan(0);

    const echoed = await updateCatalogItem(ctxA, created.item.id, {
      expectedVersion: renamed.version,
      categoryId: category.id,
      baseUomId: uom.id,
    });
    expect(echoed.categoryId).toBe(category.id);
    expect(echoed.baseUomId).toBe(uom.id);

    await deactivateUnitOfMeasure(ctxA, uom.id, { expectedVersion: uom.version });
    const echoedUom = await updateCatalogItem(ctxA, created.item.id, {
      expectedVersion: echoed.version,
      baseUomId: uom.id,
    });
    expect(echoedUom.baseUomId).toBe(uom.id);

    await deactivateCatalogCategory(ctxA, inactiveTarget.id, {
      expectedVersion: inactiveTarget.version,
    });
    await deactivateUnitOfMeasure(ctxA, inactiveUom.id, {
      expectedVersion: inactiveUom.version,
    });

    async function expectRejectedUnchanged(
      payload: Record<string, unknown>,
      snapshot: { version: number; categoryId: string | null; baseUomId: string },
    ) {
      const auditsBefore = await db.auditEvent.count({
        where: {
          tenantId: setup.tenantId,
          entityId: created.item.id,
          action: "catalog_item.updated",
        },
      });
      await expect(
        updateCatalogItem(ctxA, created.item.id, {
          expectedVersion: snapshot.version,
          ...payload,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      const row = await db.catalogItem.findFirstOrThrow({
        where: { id: created.item.id },
      });
      expect(row.version).toBe(snapshot.version);
      expect(row.categoryId).toBe(snapshot.categoryId);
      expect(row.baseUomId).toBe(snapshot.baseUomId);
      expect(
        await db.auditEvent.count({
          where: {
            tenantId: setup.tenantId,
            entityId: created.item.id,
            action: "catalog_item.updated",
          },
        }),
      ).toBe(auditsBefore);
    }

    await expectRejectedUnchanged(
      { categoryId: inactiveTarget.id },
      {
        version: echoedUom.version,
        categoryId: category.id,
        baseUomId: uom.id,
      },
    );
    await expectRejectedUnchanged(
      { baseUomId: inactiveUom.id },
      {
        version: echoedUom.version,
        categoryId: category.id,
        baseUomId: uom.id,
      },
    );

    const cleared = await updateCatalogItem(ctxA, created.item.id, {
      expectedVersion: echoedUom.version,
      categoryId: null,
    });
    expect(cleared.categoryId).toBeNull();
    await expectRejectedUnchanged(
      { categoryId: inactiveTarget.id },
      {
        version: cleared.version,
        categoryId: null,
        baseUomId: uom.id,
      },
    );
  });
});
