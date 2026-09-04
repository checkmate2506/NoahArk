import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ValidationError } from "@noahark/core";
import * as dbMod from "@noahark/db";
import { createSystemClient } from "@noahark/db/system";
import {
  createPriceListAssignment,
  setDefaultPriceList,
  updatePriceListAssignment,
} from "@noahark/catalog";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  createTestPriceList,
  setupPricingDomainFixture,
  type PricingDomainFixture,
} from "./pricingDomainFixture";

describe("P2C.2 — default price list", () => {
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

  it("supports first-time set, swap, clear, and two rejected no-ops", async () => {
    fixture = await setupPricingDomainFixture();
    const { ctxA, ctxAB, leA, leB, setup } = fixture;
    const first = await createTestPriceList(ctxA, leA.id, "SGD", "First");
    const second = await createTestPriceList(ctxA, leA.id, "SGD", "Second");
    const db = createSystemClient();

    await expect(
      setDefaultPriceList(ctxA, { legalEntityId: leA.id, priceListId: null }),
    ).rejects.toBeInstanceOf(ValidationError);

    const firstSet = await setDefaultPriceList(ctxA, {
      legalEntityId: leA.id,
      priceListId: first.priceList.id,
    });
    expect(firstSet.priceListId).toBe(first.priceList.id);
    const afterFirst = await db.priceListLegalEntityAssignment.findFirstOrThrow({
      where: { priceListId: first.priceList.id, legalEntityId: leA.id },
    });
    expect(afterFirst.isDefault).toBe(true);
    expect(afterFirst.version).toBe(first.assignment.version + 1);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: setup.tenantId,
          action: "price_list_assignment.default_changed",
        },
      }),
    ).toBe(1);

    const noOpAudits = await db.auditEvent.count({
      where: { tenantId: setup.tenantId },
    });
    await expect(
      setDefaultPriceList(ctxA, {
        legalEntityId: leA.id,
        priceListId: first.priceList.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(
      (
        await db.priceListLegalEntityAssignment.findFirstOrThrow({
          where: { id: afterFirst.id },
        })
      ).version,
    ).toBe(afterFirst.version);
    expect(await db.auditEvent.count({ where: { tenantId: setup.tenantId } })).toBe(
      noOpAudits,
    );

    const beforeSwapFirst = await db.priceListLegalEntityAssignment.findFirstOrThrow({
      where: { priceListId: first.priceList.id, legalEntityId: leA.id },
    });
    const beforeSwapSecond = await db.priceListLegalEntityAssignment.findFirstOrThrow({
      where: { priceListId: second.priceList.id, legalEntityId: leA.id },
    });
    const swap = await setDefaultPriceList(ctxA, {
      legalEntityId: leA.id,
      priceListId: second.priceList.id,
    });
    expect(swap.previousPriceListId).toBe(first.priceList.id);
    expect(swap.priceListId).toBe(second.priceList.id);
    const afterSwapFirst = await db.priceListLegalEntityAssignment.findFirstOrThrow({
      where: { id: beforeSwapFirst.id },
    });
    const afterSwapSecond = await db.priceListLegalEntityAssignment.findFirstOrThrow({
      where: { id: beforeSwapSecond.id },
    });
    expect(afterSwapFirst.isDefault).toBe(false);
    expect(afterSwapSecond.isDefault).toBe(true);
    expect(afterSwapFirst.version).toBe(beforeSwapFirst.version + 1);
    expect(afterSwapSecond.version).toBe(beforeSwapSecond.version + 1);
    expect(
      await db.auditEvent.count({
        where: {
          tenantId: setup.tenantId,
          action: "price_list_assignment.default_changed",
        },
      }),
    ).toBe(2);

    const origWithTenant = dbMod.withTenantContext;
    vi.spyOn(dbMod, "withTenantContext").mockImplementationOnce(async (input, fn) =>
      origWithTenant(input, async (tx) => {
        const original = tx.priceListLegalEntityAssignment.updateMany.bind(
          tx.priceListLegalEntityAssignment,
        );
        let calls = 0;
        tx.priceListLegalEntityAssignment.updateMany = (async (
          args: Parameters<typeof original>[0],
        ) => {
          calls += 1;
          if (calls === 2) throw new Error("forced target update failure");
          return original(args);
        }) as unknown as typeof tx.priceListLegalEntityAssignment.updateMany;
        return fn(tx);
      }),
    );
    await expect(
      setDefaultPriceList(ctxA, {
        legalEntityId: leA.id,
        priceListId: first.priceList.id,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(
      (
        await db.priceListLegalEntityAssignment.findFirstOrThrow({
          where: { id: afterSwapSecond.id },
        })
      ).isDefault,
    ).toBe(true);

    vi.spyOn(dbMod, "writeAuditEventInTx").mockRejectedValueOnce(
      new Error("forced audit failure"),
    );
    await expect(
      setDefaultPriceList(ctxA, {
        legalEntityId: leA.id,
        priceListId: first.priceList.id,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(
      (
        await db.priceListLegalEntityAssignment.findFirstOrThrow({
          where: { id: afterSwapSecond.id },
        })
      ).isDefault,
    ).toBe(true);

    const cleared = await setDefaultPriceList(ctxA, {
      legalEntityId: leA.id,
      priceListId: null,
    });
    expect(cleared.priceListId).toBeNull();
    expect(
      (
        await db.priceListLegalEntityAssignment.findFirstOrThrow({
          where: { id: afterSwapSecond.id },
        })
      ).isDefault,
    ).toBe(false);

    const other = await createTestPriceList(ctxAB, leB.id);
    await setDefaultPriceList(ctxAB, {
      legalEntityId: leB.id,
      priceListId: other.priceList.id,
    });
    expect(
      await db.priceListLegalEntityAssignment.count({
        where: { legalEntityId: leA.id, isDefault: true, status: "ACTIVE" },
      }),
    ).toBe(0);

    await setDefaultPriceList(ctxA, {
      legalEntityId: leA.id,
      priceListId: first.priceList.id,
    });
    const toSuspend = await db.priceListLegalEntityAssignment.findFirstOrThrow({
      where: { priceListId: first.priceList.id, legalEntityId: leA.id },
    });
    await createPriceListAssignment(ctxAB, {
      priceListId: first.priceList.id,
      legalEntityId: leB.id,
    });
    const suspended = await updatePriceListAssignment(ctxAB, toSuspend.id, {
      expectedVersion: toSuspend.version,
      status: "SUSPENDED",
    });
    expect(suspended.isDefault).toBe(false);
    await setDefaultPriceList(ctxA, {
      legalEntityId: leA.id,
      priceListId: second.priceList.id,
    });
    const restored = await updatePriceListAssignment(ctxA, suspended.id, {
      expectedVersion: suspended.version,
      status: "ACTIVE",
    });
    expect(restored.isDefault).toBe(false);
    await expect(
      setDefaultPriceList(ctxA, {
        legalEntityId: leA.id,
        priceListId: first.priceList.id,
      }),
    ).resolves.toMatchObject({ priceListId: first.priceList.id });

    await db.priceList.update({
      where: { id: second.priceList.id },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });
    await expect(
      setDefaultPriceList(ctxA, {
        legalEntityId: leA.id,
        priceListId: second.priceList.id,
      }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});
