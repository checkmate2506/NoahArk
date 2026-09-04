import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  StaleVersionError,
  ValidationError,
} from "@noahark/core";
import * as dbMod from "@noahark/db";
import { createSystemClient } from "@noahark/db/system";
import {
  createPriceList,
  createPriceListAssignment,
  getPriceList,
  listPriceLists,
  transferPriceListOwnership,
  updatePriceList,
} from "@noahark/catalog";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  catalogCode,
  createTestPriceList,
  setupPricingDomainFixture,
  type PricingDomainFixture,
} from "./pricingDomainFixture";

describe("P2C.2 — price list master", () => {
  let fixture: PricingDomainFixture | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("bootstraps atomically, enforces owner mutation, and paginates", async () => {
    fixture = await setupPricingDomainFixture();
    const { ctxA, ctxB, ctxAB, leA, leB, setup } = fixture;
    const created = await createTestPriceList(ctxA, leA.id, "SGD", "Retail");
    expect(created.priceList.status).toBe("ACTIVE");
    expect(created.assignment.legalEntityId).toBe(leA.id);
    expect(created.assignment.isDefault).toBe(false);

    const db = createSystemClient();
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: setup.tenantId,
          entityId: created.priceList.id,
          action: "price_list.created",
        },
      }),
    ).toBe(1);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: setup.tenantId,
          entityId: created.assignment.id,
          action: "price_list_assignment.created",
        },
      }),
    ).toBe(1);

    const origWithTenant = dbMod.withTenantContext;
    const listsBeforeAssignFail = await db.priceList.count({
      where: { tenantId: setup.tenantId },
    });
    const auditsBeforeAssignFail = await db.auditEvent.count({
      where: { tenantId: setup.tenantId },
    });
    vi.spyOn(dbMod, "withTenantContext").mockImplementationOnce(async (input, fn) =>
      origWithTenant(input, async (tx) => {
        tx.priceListLegalEntityAssignment.create = (async () => {
          throw Object.assign(new Error("forced assignment failure"), { code: "23503" });
        }) as unknown as typeof tx.priceListLegalEntityAssignment.create;
        return fn(tx);
      }),
    );
    await expect(
      createPriceList(ctxA, {
        ownerLegalEntityId: leA.id,
        code: catalogCode("PL"),
        name: "Assign fail",
        currency: "SGD",
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(await db.priceList.count({ where: { tenantId: setup.tenantId } })).toBe(
      listsBeforeAssignFail,
    );
    expect(await db.auditEvent.count({ where: { tenantId: setup.tenantId } })).toBe(
      auditsBeforeAssignFail,
    );

    const listsBeforeAuditFail = await db.priceList.count({
      where: { tenantId: setup.tenantId },
    });
    const auditsBeforeAuditFail = await db.auditEvent.count({
      where: { tenantId: setup.tenantId },
    });
    vi.spyOn(dbMod, "writeAuditEventInTx").mockRejectedValueOnce(
      new Error("forced audit failure"),
    );
    await expect(
      createPriceList(ctxA, {
        ownerLegalEntityId: leA.id,
        code: catalogCode("PL"),
        name: "Audit fail",
        currency: "SGD",
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(await db.priceList.count({ where: { tenantId: setup.tenantId } })).toBe(
      listsBeforeAuditFail,
    );
    expect(await db.auditEvent.count({ where: { tenantId: setup.tenantId } })).toBe(
      auditsBeforeAuditFail,
    );

    const mutated = await updatePriceList(ctxA, created.priceList.id, {
      expectedVersion: created.priceList.version,
      name: "Retail 2",
    });
    expect(mutated.name).toBe("Retail 2");
    await expect(
      updatePriceList(ctxA, created.priceList.id, {
        expectedVersion: mutated.version,
        name: "No",
        currency: "MYR",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    await expect(getPriceList(ctxB, created.priceList.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      updatePriceList(ctxB, created.priceList.id, {
        expectedVersion: mutated.version,
        name: "Hijack",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    await createPriceListAssignment(ctxAB, {
      priceListId: created.priceList.id,
      legalEntityId: leB.id,
    });
    expect((await getPriceList(ctxB, created.priceList.id)).name).toBe("Retail 2");
    await expect(
      updatePriceList(ctxB, created.priceList.id, {
        expectedVersion: mutated.version,
        name: "Hijack",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await expect(
      createPriceList(ctxA, {
        ownerLegalEntityId: leA.id,
        code: created.priceList.code,
        name: "Dup",
        currency: "MYR",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const hidden = await createTestPriceList(ctxB, leB.id, "MYR", "Hidden");
    await expect(
      createPriceList(ctxA, {
        ownerLegalEntityId: leA.id,
        code: hidden.priceList.code,
        name: "Clash",
        currency: "SGD",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    await expect(
      transferPriceListOwnership(ctxA, created.priceList.id, {
        newOwnerLegalEntityId: leB.id,
        expectedVersion: mutated.version,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      transferPriceListOwnership(ctxB, created.priceList.id, {
        newOwnerLegalEntityId: leB.id,
        expectedVersion: mutated.version,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const transferred = await transferPriceListOwnership(ctxAB, created.priceList.id, {
      newOwnerLegalEntityId: leB.id,
      expectedVersion: mutated.version,
    });
    expect(transferred.ownerLegalEntityId).toBe(leB.id);
    const assigns = await db.priceListLegalEntityAssignment.findMany({
      where: { priceListId: created.priceList.id },
    });
    expect(assigns.map((row) => row.legalEntityId).sort()).toEqual(
      [leA.id, leB.id].sort(),
    );

    await expect(
      updatePriceList(ctxAB, created.priceList.id, {
        expectedVersion: 1,
        name: "Stale",
      }),
    ).rejects.toBeInstanceOf(StaleVersionError);

    await db.priceList.update({
      where: { id: created.priceList.id },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });
    await expect(
      updatePriceList(ctxAB, created.priceList.id, {
        expectedVersion: transferred.version,
        name: "Archived",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const page = await listPriceLists(ctxB, { limit: 1 });
    expect(page.items.length).toBe(1);
    if (page.nextCursor) {
      const next = await listPriceLists(ctxB, { cursor: page.nextCursor, limit: 10 });
      expect(next.items.some((row) => row.id === page.items[0]?.id)).toBe(false);
    }
  });
});
