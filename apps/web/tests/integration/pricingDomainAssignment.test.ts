import { afterEach, describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, ValidationError } from "@noahark/core";
import { createSystemClient } from "@noahark/db/system";
import {
  archivePriceListAssignment,
  createPriceListAssignment,
  getPriceListAssignment,
  listPriceListAssignments,
  setDefaultPriceList,
  updatePriceListAssignment,
} from "@noahark/catalog";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  contextWithEntities,
  createTestPriceList,
  setupPricingDomainFixture,
  type PricingDomainFixture,
} from "./pricingDomainFixture";

describe("P2C.2 — price list assignments", () => {
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

  it("is target-scoped, last-ACTIVE guarded, and permanently unique after archive", async () => {
    fixture = await setupPricingDomainFixture();
    const { ctxA, ctxB, ctxAB, leA, leB, leC, setup } = fixture;
    const onlyA = await createTestPriceList(ctxA, leA.id);
    const db = createSystemClient();
    const auditsBefore = await db.auditEvent.count({
      where: { tenantId: setup.tenantId, action: "price_list_assignment.created" },
    });
    await expect(
      createPriceListAssignment(ctxB, {
        priceListId: onlyA.priceList.id,
        legalEntityId: leB.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(
      await db.priceListLegalEntityAssignment.count({
        where: { priceListId: onlyA.priceList.id, legalEntityId: leB.id },
      }),
    ).toBe(0);
    expect(
      await db.auditEvent.count({
        where: { tenantId: setup.tenantId, action: "price_list_assignment.created" },
      }),
    ).toBe(auditsBefore);

    await createPriceListAssignment(ctxAB, {
      priceListId: onlyA.priceList.id,
      legalEntityId: leB.id,
    });
    const ctxBC = contextWithEntities(ctxAB, [leB.id, leC.id]);
    const extended = await createPriceListAssignment(ctxBC, {
      priceListId: onlyA.priceList.id,
      legalEntityId: leC.id,
    });
    expect(extended.legalEntityId).toBe(leC.id);

    await expect(
      createPriceListAssignment(ctxAB, {
        priceListId: onlyA.priceList.id,
        legalEntityId: leB.id,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    await expect(
      archivePriceListAssignment(ctxA, onlyA.assignment.id, onlyA.assignment.version),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      updatePriceListAssignment(ctxA, onlyA.assignment.id, {
        expectedVersion: onlyA.assignment.version,
        status: "SUSPENDED",
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const listed = await listPriceListAssignments(ctxAB, {
      priceListId: onlyA.priceList.id,
    });
    expect(listed.length).toBeGreaterThanOrEqual(3);

    await expect(getPriceListAssignment(ctxA, extended.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const suspended = await updatePriceListAssignment(ctxAB, extended.id, {
      expectedVersion: extended.version,
      status: "SUSPENDED",
    });
    expect(suspended.status).toBe("SUSPENDED");
    expect(suspended.archivedAt).toBeNull();
    const reactivated = await updatePriceListAssignment(ctxAB, extended.id, {
      expectedVersion: suspended.version,
      status: "ACTIVE",
    });
    expect(reactivated.status).toBe("ACTIVE");

    await setDefaultPriceList(ctxAB, {
      legalEntityId: leC.id,
      priceListId: onlyA.priceList.id,
    });
    const withDefault = await getPriceListAssignment(ctxAB, reactivated.id);
    expect(withDefault.isDefault).toBe(true);
    const suspendedDefault = await updatePriceListAssignment(ctxAB, reactivated.id, {
      expectedVersion: withDefault.version,
      status: "SUSPENDED",
    });
    expect(suspendedDefault.isDefault).toBe(false);

    const archived = await archivePriceListAssignment(
      ctxAB,
      suspendedDefault.id,
      suspendedDefault.version,
    );
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.isDefault).toBe(false);
    await expect(
      updatePriceListAssignment(ctxAB, archived.id, {
        expectedVersion: archived.version,
        status: "ACTIVE",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Committed schema: (price_list_id, legal_entity_id) UNIQUE with no status
    // predicate, so archive permanently prevents re-assigning this pair.
    await expect(
      createPriceListAssignment(ctxAB, {
        priceListId: onlyA.priceList.id,
        legalEntityId: leC.id,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const other = await createTestPriceList(ctxB, leB.id);
    await expect(
      getPriceListAssignment(ctxA, other.assignment.id),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createPriceListAssignment(ctxA, {
        priceListId: other.priceList.id,
        legalEntityId: leA.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(
      Object.keys(await import("@noahark/catalog")).filter((k) => k.startsWith("delete")),
    ).toEqual([]);
  });
});
