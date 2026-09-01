import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "@noahark/core";
import { createSystemClient } from "@noahark/db/system";
import * as catalog from "@noahark/catalog";
import {
  archiveCatalogItemAssignment,
  createCatalogItem,
  createCatalogItemAssignment,
  deactivateCatalogCategory,
  getCatalogCategory,
  getCatalogItem,
  getUnitOfMeasure,
  listCatalogItemAssignments,
  listCatalogItems,
  updateCatalogItem,
} from "@noahark/catalog";
import * as catalogDomain from "../../lib/services/catalogDomain";
import {
  buildContext,
  cleanupTenant,
  cleanupUser,
  createTestLegalEntity,
  grantLegalEntityAccessDirect,
  setupTestTenant,
} from "./testHelpers";
import {
  catalogCode,
  createTestCategory,
  createTestUom,
  setupCatalogDomainFixture,
  type CatalogDomainFixture,
} from "./catalogDomainFixture";

describe("P2C.1 — catalog RLS adversarial probes", () => {
  let fixture: CatalogDomainFixture | undefined;
  let extraTenantId: string | undefined;
  let extraUserId: string | undefined;

  afterEach(async () => {
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
    if (extraTenantId) {
      await cleanupTenant(extraTenantId).catch(() => undefined);
      extraTenantId = undefined;
    }
    if (extraUserId) {
      await cleanupUser(extraUserId).catch(() => undefined);
      extraUserId = undefined;
    }
  });

  it("locks Probe A, over-refusal, cross-tenant substitution, and absent archiveCatalogItem", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, ctxB, ctxAB, leA, leB, setup } = fixture;
    const category = await createTestCategory(ctxA);
    const uom = await createTestUom(ctxA);
    const hidden = await createCatalogItem(ctxB, {
      ownerLegalEntityId: leB.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Hidden from A",
      categoryId: category.id,
      baseUomId: uom.id,
    });

    const db = createSystemClient();
    expect(
      await db.catalogItem.findFirst({ where: { id: hidden.item.id } }),
    ).not.toBeNull();
    await expect(getCatalogItem(ctxA, hidden.item.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const listed = await listCatalogItems(ctxA);
    expect(listed.items.some((row) => row.id === hidden.item.id)).toBe(false);
    await expect(
      updateCatalogItem(ctxA, hidden.item.id, {
        expectedVersion: hidden.item.version,
        name: "Hijack",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(await getCatalogCategory(ctxA, category.id)).toMatchObject({
      id: category.id,
    });
    expect(await getUnitOfMeasure(ctxA, uom.id)).toMatchObject({ id: uom.id });

    const deactivated = await deactivateCatalogCategory(ctxA, category.id, {
      expectedVersion: category.version,
    });
    expect(deactivated.isActive).toBe(false);

    expect(
      await listCatalogItemAssignments(ctxA, { catalogItemId: hidden.item.id }),
    ).toEqual([]);

    const visible = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Over-refusal",
      baseUomId: uom.id,
    });
    await createCatalogItemAssignment(ctxAB, {
      catalogItemId: visible.item.id,
      legalEntityId: leB.id,
    });
    await expect(
      archiveCatalogItemAssignment(
        ctxA,
        visible.assignment.id,
        visible.assignment.version,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    // Accepted safely-conservative over-refusal (ADR-77(c)): ctx-A sees one
    // ACTIVE assignment and refuses, even though B's hidden assignment is still ACTIVE.
    const stillActive = await db.catalogItemLegalEntityAssignment.findMany({
      where: { catalogItemId: visible.item.id, status: "ACTIVE" },
    });
    expect(stillActive.map((row) => row.legalEntityId).sort()).toEqual(
      [leA.id, leB.id].sort(),
    );

    const other = await setupTestTenant();
    extraTenantId = other.tenantId;
    extraUserId = other.adminUserId;
    const otherLe = await createTestLegalEntity(other.tenantId, "SG");
    await grantLegalEntityAccessDirect(other.tenantId, otherLe.id, other.adminUserId);
    const otherCtx = await buildContext(other.adminUserId, other.tenantId);
    await expect(getCatalogItem(otherCtx, visible.item.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(getCatalogCategory(otherCtx, category.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(getUnitOfMeasure(otherCtx, uom.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      updateCatalogItem(otherCtx, visible.item.id, {
        expectedVersion: visible.item.version,
        name: "X",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createCatalogItemAssignment(otherCtx, {
        catalogItemId: visible.item.id,
        legalEntityId: otherLe.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(catalog).not.toHaveProperty("archiveCatalogItem");
    expect(catalogDomain).not.toHaveProperty("archiveCatalogItem");
    expect(setup.tenantId).toBeTruthy();
  });
});
