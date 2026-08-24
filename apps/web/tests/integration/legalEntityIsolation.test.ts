import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { withTenantContext } from "@noahark/db";
import { createSystemClient } from "@noahark/db/system";
import {
  setupTestTenant,
  cleanupTenant,
  cleanupUser,
  createTestLegalEntity,
  type TestTenantSetup,
} from "./testHelpers";

/**
 * F-23 (Phase 1B.1): legal-entity-level isolation via RAW SQL against real
 * rows — not the Prisma query builder, and not a privileged client for the
 * action under test. A query returning zero rows only proves enforcement
 * when the row is KNOWN to exist first (verified via the system client
 * separately) — every test here does that check before asserting isolation.
 */
describe("legal-entity isolation (F-23, real Postgres, raw SQL)", () => {
  let setup: TestTenantSetup;

  afterEach(async () => {
    if (setup) {
      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    }
  });

  it("a raw SELECT scoped to entity A cannot read entity B's business_unit row", async () => {
    setup = await setupTestTenant();
    const entityA = await createTestLegalEntity(setup.tenantId, "SG");
    const entityB = await createTestLegalEntity(setup.tenantId, "MY");

    const system = createSystemClient();
    const rowB = await system.businessUnit.create({
      data: {
        tenantId: setup.tenantId,
        legalEntityId: entityB.id,
        name: "Entity B unit",
      },
    });

    const seen = await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set([entityA.id]) },
      (tx) => tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "business_unit" WHERE id = ${rowB.id}
      `,
    );
    expect(seen).toHaveLength(0);
  });

  it("a raw UPDATE scoped to entity A affects zero rows against entity B's row (row is left unchanged)", async () => {
    setup = await setupTestTenant();
    const entityA = await createTestLegalEntity(setup.tenantId, "SG");
    const entityB = await createTestLegalEntity(setup.tenantId, "ID");

    const system = createSystemClient();
    const rowB = await system.businessUnit.create({
      data: {
        tenantId: setup.tenantId,
        legalEntityId: entityB.id,
        name: "Original Name",
      },
    });

    const affected = await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set([entityA.id]) },
      (tx) => tx.$executeRaw`
        UPDATE "business_unit" SET name = 'Hijacked' WHERE id = ${rowB.id}
      `,
    );
    expect(affected).toBe(0);

    const stillOriginal = await system.businessUnit.findUniqueOrThrow({
      where: { id: rowB.id },
    });
    expect(stillOriginal.name).toBe("Original Name");
  });

  it("a raw DELETE scoped to entity A affects zero rows against entity B's row (row still exists)", async () => {
    setup = await setupTestTenant();
    const entityA = await createTestLegalEntity(setup.tenantId, "SG");
    const entityB = await createTestLegalEntity(setup.tenantId, "MY");

    const system = createSystemClient();
    const rowB = await system.businessUnit.create({
      data: {
        tenantId: setup.tenantId,
        legalEntityId: entityB.id,
        name: "Do not delete me",
      },
    });

    const affected = await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set([entityA.id]) },
      (tx) => tx.$executeRaw`
        DELETE FROM "business_unit" WHERE id = ${rowB.id}
      `,
    );
    expect(affected).toBe(0);

    const stillExists = await system.businessUnit.findUnique({ where: { id: rowB.id } });
    expect(stillExists).not.toBeNull();
  });

  it("a legal entity belonging to ANOTHER tenant is invisible even when its id is directly referenced", async () => {
    setup = await setupTestTenant();
    const otherSetup = await setupTestTenant();
    try {
      const foreignEntity = await createTestLegalEntity(otherSetup.tenantId, "SG");

      const seen = await withTenantContext(
        { tenantId: setup.tenantId, legalEntityIds: new Set([foreignEntity.id]) },
        (tx) => tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "legal_entity" WHERE id = ${foreignEntity.id}
        `,
      );
      // legal_entity's own RLS policy is tenant-scoped only (see the RLS
      // migration) — tenant_id must match app.tenant_id regardless of
      // whatever the caller claims in app.legal_entity_ids.
      expect(seen).toHaveLength(0);
    } finally {
      await cleanupTenant(otherSetup.tenantId);
      await cleanupUser(otherSetup.adminUserId);
    }
  });

  it("distinguishes a tenant-wide record (legal_entity_id NULL) from an entity-owned one, for the SAME model", async () => {
    setup = await setupTestTenant();
    const grantedEntity = await createTestLegalEntity(setup.tenantId, "SG");
    const otherEntity = await createTestLegalEntity(setup.tenantId, "MY");

    const system = createSystemClient();
    const tenantWide = await system.fileObject.create({
      data: {
        tenantId: setup.tenantId,
        legalEntityId: null,
        storageKey: `test/${randomUUID()}`,
        originalFilename: "tenant-wide.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        sha256: "a".repeat(64),
        uploadedByUserId: setup.adminUserId,
      },
    });
    const grantedOwned = await system.fileObject.create({
      data: {
        tenantId: setup.tenantId,
        legalEntityId: grantedEntity.id,
        storageKey: `test/${randomUUID()}`,
        originalFilename: "granted-entity.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        sha256: "b".repeat(64),
        uploadedByUserId: setup.adminUserId,
      },
    });
    const otherOwned = await system.fileObject.create({
      data: {
        tenantId: setup.tenantId,
        legalEntityId: otherEntity.id,
        storageKey: `test/${randomUUID()}`,
        originalFilename: "other-entity.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        sha256: "c".repeat(64),
        uploadedByUserId: setup.adminUserId,
      },
    });

    // A caller granted ONLY grantedEntity should see the tenant-wide record
    // AND the grantedEntity-owned record, but NOT otherEntity's.
    const visible = await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set([grantedEntity.id]) },
      (tx) => tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "file_object" WHERE id IN (${tenantWide.id}, ${grantedOwned.id}, ${otherOwned.id})
      `,
    );
    const visibleIds = visible.map((r) => r.id);
    expect(visibleIds).toContain(tenantWide.id);
    expect(visibleIds).toContain(grantedOwned.id);
    expect(visibleIds).not.toContain(otherOwned.id);

    // A caller granted ONLY otherEntity should see the SAME tenant-wide
    // record (it's tenant-wide, not entity-specific) but NOT grantedEntity's.
    const visibleFromOther = await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set([otherEntity.id]) },
      (tx) => tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "file_object" WHERE id IN (${tenantWide.id}, ${grantedOwned.id}, ${otherOwned.id})
      `,
    );
    const visibleFromOtherIds = visibleFromOther.map((r) => r.id);
    expect(visibleFromOtherIds).toContain(tenantWide.id);
    expect(visibleFromOtherIds).toContain(otherOwned.id);
    expect(visibleFromOtherIds).not.toContain(grantedOwned.id);
  });
});
