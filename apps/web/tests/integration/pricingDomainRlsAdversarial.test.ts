import { afterEach, describe, expect, it } from "vitest";
import { ForbiddenError, NotFoundError } from "@noahark/core";
import { createSystemClient } from "@noahark/db/system";
import * as catalog from "@noahark/catalog";
import {
  createPriceList,
  createPriceListAssignment,
  createPriceListEntry,
  getPriceList,
  getPriceListEntry,
  listPriceLists,
  resolveEffectivePrice,
  updatePriceList,
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
  createTestItem,
  createTestPriceList,
  createTestUom,
  setupPricingDomainFixture,
  type PricingDomainFixture,
} from "./pricingDomainFixture";

describe("P2C.2 — pricing RLS adversarial probes", () => {
  let fixture: PricingDomainFixture | undefined;
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

  it("keeps owner-only mutation, fail-closed empty scope, and assigned-entry create", async () => {
    fixture = await setupPricingDomainFixture();
    const { ctxA, ctxB, ctxAB, ctxNone, leA, leB } = fixture;
    const list = await createTestPriceList(ctxA, leA.id);
    const db = createSystemClient();

    await expect(getPriceList(ctxB, list.priceList.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(
      (await listPriceLists(ctxB)).items.some((row) => row.id === list.priceList.id),
    ).toBe(false);
    await expect(
      updatePriceList(ctxB, list.priceList.id, {
        expectedVersion: list.priceList.version,
        name: "X",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await createPriceListAssignment(ctxAB, {
      priceListId: list.priceList.id,
      legalEntityId: leB.id,
    });
    expect((await getPriceList(ctxB, list.priceList.id)).id).toBe(list.priceList.id);
    await expect(
      updatePriceList(ctxB, list.priceList.id, {
        expectedVersion: list.priceList.version,
        name: "Hijack",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(getPriceList(ctxNone, list.priceList.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(listPriceLists(ctxNone)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      createPriceList(ctxNone, {
        ownerLegalEntityId: leA.id,
        code: "X",
        name: "X",
        currency: "SGD",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      resolveEffectivePrice(ctxNone, {
        legalEntityId: leA.id,
        catalogItemId: "x",
        onDate: "2026-07-01",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(
      createPriceListAssignment(ctxA, {
        priceListId: list.priceList.id,
        legalEntityId: leB.id,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const other = await setupTestTenant();
    extraTenantId = other.tenantId;
    extraUserId = other.adminUserId;
    const otherLe = await createTestLegalEntity(other.tenantId, "SG");
    await grantLegalEntityAccessDirect(other.tenantId, otherLe.id, other.adminUserId);
    const otherCtx = await buildContext(other.adminUserId, other.tenantId);
    await expect(getPriceList(otherCtx, list.priceList.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      updatePriceList(otherCtx, list.priceList.id, {
        expectedVersion: list.priceList.version,
        name: "X",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const uom = await createTestUom(ctxA);
    const item = await createTestItem(ctxA, leA.id, uom.id);
    await catalog.createCatalogItemAssignment(ctxAB, {
      catalogItemId: item.item.id,
      legalEntityId: leB.id,
    });
    const entry = await createPriceListEntry(ctxB, {
      priceListAssignmentId: (
        await db.priceListLegalEntityAssignment.findFirstOrThrow({
          where: { priceListId: list.priceList.id, legalEntityId: leB.id },
        })
      ).id,
      catalogItemAssignmentId: (
        await db.catalogItemLegalEntityAssignment.findFirstOrThrow({
          where: { catalogItemId: item.item.id, legalEntityId: leB.id },
        })
      ).id,
      unitPrice: "3",
      effectiveFrom: "2026-07-01",
      effectiveTo: null,
    });
    expect(entry.legalEntityId).toBe(leB.id);
    expect(await getPriceListEntry(ctxB, entry.id)).toMatchObject({ id: entry.id });
    await expect(getPriceListEntry(ctxA, entry.id)).rejects.toBeInstanceOf(NotFoundError);

    expect(catalog).not.toHaveProperty("archivePriceList");
    expect(catalogDomain).not.toHaveProperty("archivePriceList");
  });
});
