import { afterEach, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError, ValidationError } from "@noahark/core";
import { createSystemClient } from "@noahark/db/system";
import {
  createCatalogItem,
  createCatalogItemAssignment,
  getCatalogItem,
  transferCatalogItemOwnership,
  updateCatalogItem,
} from "@noahark/catalog";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  catalogCode,
  contextWithEntities,
  createTestUom,
  setupCatalogDomainFixture,
  type CatalogDomainFixture,
} from "./catalogDomainFixture";

describe("P2C.1 — catalog item ownership", () => {
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

  it("owner mutates; assigned non-owner is Forbidden; unassigned is NotFound; transfer needs both owners", async () => {
    fixture = await setupCatalogDomainFixture();
    const { ctxA, ctxB, ctxAB, leA, leB } = fixture;
    const uom = await createTestUom(ctxA);
    const created = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "Owned",
      baseUomId: uom.id,
    });
    const updated = await updateCatalogItem(ctxA, created.item.id, {
      expectedVersion: created.item.version,
      name: "Owned 2",
    });
    expect(updated.name).toBe("Owned 2");

    await expect(getCatalogItem(ctxB, created.item.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      updateCatalogItem(ctxB, created.item.id, {
        expectedVersion: updated.version,
        name: "Hijack",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await createCatalogItemAssignment(ctxAB, {
      catalogItemId: created.item.id,
      legalEntityId: leB.id,
    });
    expect((await getCatalogItem(ctxB, created.item.id)).name).toBe("Owned 2");
    await expect(
      updateCatalogItem(ctxB, created.item.id, {
        expectedVersion: updated.version,
        name: "Hijack",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      transferCatalogItemOwnership(ctxB, created.item.id, {
        newOwnerLegalEntityId: leB.id,
        expectedVersion: updated.version,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(
      transferCatalogItemOwnership(ctxA, created.item.id, {
        newOwnerLegalEntityId: leB.id,
        expectedVersion: updated.version,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      transferCatalogItemOwnership(ctxB, created.item.id, {
        newOwnerLegalEntityId: leB.id,
        expectedVersion: updated.version,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const transferred = await transferCatalogItemOwnership(ctxAB, created.item.id, {
      newOwnerLegalEntityId: leB.id,
      expectedVersion: updated.version,
    });
    expect(transferred.ownerLegalEntityId).toBe(leB.id);

    const db = createSystemClient();
    const assignments = await db.catalogItemLegalEntityAssignment.findMany({
      where: { catalogItemId: created.item.id },
    });
    expect(assignments.map((row) => row.legalEntityId).sort()).toEqual(
      [leA.id, leB.id].sort(),
    );
    expect(
      assignments.filter((row) => row.status === "ACTIVE").map((r) => r.legalEntityId),
    ).toEqual(expect.arrayContaining([leA.id, leB.id]));

    await expect(
      transferCatalogItemOwnership(ctxAB, created.item.id, {
        newOwnerLegalEntityId: leB.id,
        expectedVersion: transferred.version,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const onlyA = await createCatalogItem(ctxA, {
      ownerLegalEntityId: leA.id,
      code: catalogCode("SKU"),
      itemType: "PRODUCT",
      name: "A only",
      baseUomId: uom.id,
    });
    const afterAtoB = await transferCatalogItemOwnership(
      contextWithEntities(ctxAB, [leA.id, leB.id]),
      onlyA.item.id,
      { newOwnerLegalEntityId: leB.id, expectedVersion: onlyA.item.version },
    );
    expect(afterAtoB.ownerLegalEntityId).toBe(leB.id);
    const remaining = await db.catalogItemLegalEntityAssignment.findMany({
      where: { catalogItemId: onlyA.item.id, status: "ACTIVE" },
    });
    expect(remaining.map((row) => row.legalEntityId)).toEqual([leA.id]);

    const archived = await db.catalogItem.update({
      where: { id: created.item.id },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });
    await expect(
      transferCatalogItemOwnership(ctxAB, created.item.id, {
        newOwnerLegalEntityId: leA.id,
        expectedVersion: archived.version,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
