import { afterEach, describe, expect, it } from "vitest";
import {
  withoutTenantContext,
  withTenantContext,
  UnscopedTenantQueryError,
} from "@noahark/db";
import {
  setupTestTenant,
  createTestLegalEntity,
  cleanupTenant,
  cleanupUser,
  type TestTenantSetup,
} from "./testHelpers";

/**
 * F-3C: dedicated negative tests for the Prisma tenant/legal-entity guard
 * extension (packages/db/src/guardExtension.ts) — representative read,
 * create, update and delete calls against a tenant-owned model with no
 * active tenant scope, and the legal-entity-required-model write guard.
 */
describe("tenant guard extension (F-3C)", () => {
  let setup: TestTenantSetup;

  afterEach(async () => {
    if (setup) {
      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    }
  });

  it("denies a READ on a tenant-owned model with no active scope", async () => {
    await expect(
      withoutTenantContext((tx) => tx.tenantSetting.findMany({})),
    ).rejects.toThrow(UnscopedTenantQueryError);
  });

  it("denies a CREATE on a tenant-owned model with no active scope", async () => {
    setup = await setupTestTenant();
    await expect(
      withoutTenantContext((tx) =>
        tx.tenantSetting.create({
          data: { tenantId: setup.tenantId, key: "x", value: "1", updatedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(UnscopedTenantQueryError);
  });

  it("denies an UPDATE on a tenant-owned model with no active scope", async () => {
    await expect(
      withoutTenantContext((tx) =>
        tx.tenantSetting.updateMany({ where: {}, data: { key: "y" } }),
      ),
    ).rejects.toThrow(UnscopedTenantQueryError);
  });

  it("denies a DELETE on a tenant-owned model with no active scope", async () => {
    await expect(
      withoutTenantContext((tx) => tx.tenantSetting.deleteMany({ where: {} })),
    ).rejects.toThrow(UnscopedTenantQueryError);
  });

  it("allows a READ on a tenant-owned model inside a properly scoped context", async () => {
    setup = await setupTestTenant();
    await expect(
      withTenantContext({ tenantId: setup.tenantId, legalEntityIds: new Set() }, (tx) =>
        tx.tenantSetting.findMany({ where: { tenantId: setup.tenantId } }),
      ),
    ).resolves.toEqual([]);
  });

  it("denies a WRITE on a legal-entity-REQUIRED model when the caller has zero legal-entity grants", async () => {
    setup = await setupTestTenant();
    await expect(
      withTenantContext({ tenantId: setup.tenantId, legalEntityIds: new Set() }, (tx) =>
        tx.businessUnit.create({
          data: { tenantId: setup.tenantId, legalEntityId: "nonexistent", name: "x" },
        }),
      ),
    ).rejects.toThrow(UnscopedTenantQueryError);
  });

  it("does NOT apply the legal-entity-required heuristic to a nullable-legal-entity model (avoids a false positive)", async () => {
    setup = await setupTestTenant();
    // Notification.legalEntityId is nullable — a tenant-wide notification
    // must remain creatable even with zero legal-entity grants.
    await expect(
      withTenantContext({ tenantId: setup.tenantId, legalEntityIds: new Set() }, (tx) =>
        tx.notification.create({
          data: {
            tenantId: setup.tenantId,
            recipientUserId: setup.adminUserId,
            channel: "IN_APP",
            type: "test",
            title: "t",
            body: "b",
          },
        }),
      ),
    ).resolves.toMatchObject({ tenantId: setup.tenantId });
  });

  it("allows a legal-entity-required-model write once the caller has at least one grant", async () => {
    setup = await setupTestTenant();
    const legalEntity = await createTestLegalEntity(setup.tenantId, "SG");
    await expect(
      withTenantContext(
        { tenantId: setup.tenantId, legalEntityIds: new Set([legalEntity.id]) },
        (tx) =>
          tx.businessUnit.create({
            data: { tenantId: setup.tenantId, legalEntityId: legalEntity.id, name: "x" },
          }),
      ),
    ).resolves.toMatchObject({ legalEntityId: legalEntity.id });
  });

  it("allows unrestricted access to a GLOBAL (non-tenant-owned) model with no scope at all", async () => {
    await expect(
      withoutTenantContext((tx) => tx.permission.findMany({})),
    ).resolves.toBeInstanceOf(Array);
  });
});
