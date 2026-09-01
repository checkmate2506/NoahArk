import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError } from "@noahark/core";
import { createSystemClient } from "@noahark/db/system";
import {
  archiveCatalogItemAssignment,
  createCatalogItem,
  createCatalogItemAssignment,
  getCatalogItemAssignment,
  listCatalogItemAssignments,
  updateCatalogItemAssignment,
} from "@noahark/catalog";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  catalogCode,
  contextWithEntities,
  createTestUom,
  setupCatalogDomainFixture,
  type CatalogDomainFixture,
} from "./catalogDomainFixture";

describe("P2C.1 — catalog item assignments", () => {
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

  it("covers CRUD, uniqueness, last-ACTIVE, archived entityItemCode, and §10.1 authority", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, ctxB, ctxAB, leA, leB, leC, setup } = fixture;
    const uom = await createTestUom(ctxA);
    const created = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Assigned",
      baseUomId: uom.id,
      entityItemCode: "A-1",
    });
    const assignB = await createCatalogItemAssignment(ctxAB, {
      catalogItemId: created.item.id,
      legalEntityId: leB.id,
      entityItemCode: "B-1",
    });
    expect(assignB.status).toBe("ACTIVE");
    expect(await getCatalogItemAssignment(ctxB, assignB.id)).toMatchObject({
      id: assignB.id,
    });
    await expect(getCatalogItemAssignment(ctxA, assignB.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    await expect(
      createCatalogItemAssignment(ctxAB, {
        catalogItemId: created.item.id,
        legalEntityId: leB.id,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const otherEntitySameCode = await createCatalogItemAssignment(ctxAB, {
      catalogItemId: created.item.id,
      legalEntityId: leC.id,
      entityItemCode: "B-1",
    });
    expect(otherEntitySameCode.entityItemCode).toBe("B-1");

    const listed = await listCatalogItemAssignments(ctxAB, {
      catalogItemId: created.item.id,
    });
    expect(listed.length).toBeGreaterThanOrEqual(3);

    const archivedC = await archiveCatalogItemAssignment(
      ctxAB,
      otherEntitySameCode.id,
      otherEntitySameCode.version,
    );
    expect(archivedC.status).toBe("ARCHIVED");
    expect(archivedC.archivedAt).not.toBeNull();

    const reserved = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Reserved code",
      baseUomId: uom.id,
    });
    await expect(
      createCatalogItemAssignment(ctxAB, {
        catalogItemId: reserved.item.id,
        legalEntityId: leC.id,
        entityItemCode: "B-1",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const lastOnly = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Last active",
      baseUomId: uom.id,
    });
    await expect(
      archiveCatalogItemAssignment(
        ctxA,
        lastOnly.assignment.id,
        lastOnly.assignment.version,
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      updateCatalogItemAssignment(ctxA, lastOnly.assignment.id, {
        expectedVersion: lastOnly.assignment.version,
        status: "SUSPENDED",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const db = createSystemClient();
    await db.catalogItem.update({
      where: { id: created.item.id },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });
    await expect(
      createCatalogItemAssignment(ctxAB, {
        catalogItemId: created.item.id,
        legalEntityId: leC.id,
        entityItemCode: "C-NEW",
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await db.catalogItem.update({
      where: { id: created.item.id },
      data: { status: "ACTIVE", archivedAt: null },
    });

    const onlyA = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Invisible target",
      baseUomId: uom.id,
    });
    const auditsBefore = await db.auditEvent.count({
      where: {
        tenantId: setup.tenantId,
        action: "catalog_item_assignment.created",
      },
    });
    await expect(
      createCatalogItemAssignment(ctxB, {
        catalogItemId: onlyA.item.id,
        legalEntityId: leB.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      await db.catalogItem.findFirst({ where: { id: onlyA.item.id } }),
    ).not.toBeNull();
    expect(
      await db.catalogItemLegalEntityAssignment.count({
        where: { catalogItemId: onlyA.item.id, legalEntityId: leB.id },
      }),
    ).toBe(0);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: setup.tenantId,
          action: "catalog_item_assignment.created",
        },
      }),
    ).toBe(auditsBefore);

    await createCatalogItemAssignment(ctxAB, {
      catalogItemId: onlyA.item.id,
      legalEntityId: leB.id,
    });
    const ctxBC = contextWithEntities(ctxAB, [leB.id, leC.id]);
    const extended = await createCatalogItemAssignment(ctxBC, {
      catalogItemId: onlyA.item.id,
      legalEntityId: leC.id,
    });
    expect(extended.status).toBe("ACTIVE");
    expect(extended.legalEntityId).toBe(leC.id);
    const extendAudit = await db.auditEvent.findFirst({
      where: {
        tenantId: setup.tenantId,
        action: "catalog_item_assignment.created",
        entityId: extended.id,
      },
    });
    expect(extendAudit?.legalEntityId).toBe(leC.id);
  });
});
