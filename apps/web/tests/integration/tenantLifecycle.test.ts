import { afterEach, describe, expect, it } from "vitest";
import { getTenant, updateTenant } from "@/lib/services/tenantService";
import {
  createLegalEntity,
  listLegalEntities,
  updateLegalEntity,
} from "@/lib/services/legalEntityService";
import { updateTenantSetting, listTenantSettings } from "@/lib/services/settingsService";
import { listAuditEvents } from "@/lib/services/auditService";
import {
  setupTestTenant,
  buildContext,
  cleanupTenant,
  cleanupUser,
  grantLegalEntityAccessDirect,
  type TestTenantSetup,
} from "./testHelpers";

describe("tenant lifecycle (real Postgres, RLS-enforced path)", () => {
  let setup: TestTenantSetup;

  afterEach(async () => {
    if (setup) {
      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    }
  });

  it("reads and updates a tenant, recording an audit event", async () => {
    setup = await setupTestTenant();
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);

    const before = await getTenant(ctx);
    expect(before.id).toBe(setup.tenantId);

    const updated = await updateTenant(ctx, { name: "Renamed Tenant" });
    expect(updated.name).toBe("Renamed Tenant");

    const { events } = await listAuditEvents(ctx, { limit: 10 });
    const updateEvent = events.find((e) => e.action === "tenant.updated");
    expect(updateEvent).toBeDefined();
    expect(updateEvent?.hash).toBeTruthy();
  });

  it("creates legal entities for all three approved jurisdictions", async () => {
    setup = await setupTestTenant();
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);

    const sg = await createLegalEntity(ctx, {
      name: "Acme SG",
      jurisdiction: "SG",
      functionalCurrency: "SGD",
      timeZone: "Asia/Singapore",
      defaultLanguage: "EN",
    });
    const my = await createLegalEntity(ctx, {
      name: "Acme MY",
      jurisdiction: "MY",
      functionalCurrency: "MYR",
      timeZone: "Asia/Kuala_Lumpur",
      defaultLanguage: "MS",
    });
    const id = await createLegalEntity(ctx, {
      name: "Acme ID",
      jurisdiction: "ID",
      functionalCurrency: "IDR",
      timeZone: "Asia/Jakarta",
      defaultLanguage: "ID",
    });

    expect(sg.jurisdiction).toBe("SG");
    expect(my.jurisdiction).toBe("MY");
    expect(id.jurisdiction).toBe("ID");

    const all = await listLegalEntities(ctx);
    expect(all.map((le) => le.id).sort()).toEqual([sg.id, my.id, id.id].sort());
  });

  it("rejects a jurisdiction/currency mismatch at the service layer", async () => {
    setup = await setupTestTenant();
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);

    await expect(
      createLegalEntity(ctx, {
        name: "Bad Entity",
        jurisdiction: "SG",
        functionalCurrency: "MYR",
        timeZone: "Asia/Singapore",
        defaultLanguage: "EN",
      }),
    ).rejects.toThrow(/requires functional currency SGD/);
  });

  it("updates a legal entity and records before/after audit metadata", async () => {
    setup = await setupTestTenant();
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    const legalEntity = await createLegalEntity(ctx, {
      name: "Original Name",
      jurisdiction: "SG",
      functionalCurrency: "SGD",
      timeZone: "Asia/Singapore",
      defaultLanguage: "EN",
    });

    // Creating a legal entity does NOT itself grant the creator access to
    // it (LEGAL_ENTITY_ARCHITECTURE.md §5: access is never implicit) — the
    // admin must be explicitly granted before they can update it, and the
    // context must be rebuilt to pick up the new grant.
    await grantLegalEntityAccessDirect(setup.tenantId, legalEntity.id, setup.adminUserId);
    const scopedCtx = await buildContext(setup.adminUserId, setup.tenantId);

    const updated = await updateLegalEntity(scopedCtx, legalEntity.id, {
      name: "Updated Name",
    });
    expect(updated.name).toBe("Updated Name");

    const { events } = await listAuditEvents(scopedCtx, { limit: 10 });
    const updateEvent = events.find((e) => e.action === "legal_entity.updated");
    expect(updateEvent).toBeDefined();
    expect((updateEvent?.beforeData as { name?: string } | null)?.name).toBe(
      "Original Name",
    );
    expect((updateEvent?.afterData as { name?: string } | null)?.name).toBe(
      "Updated Name",
    );
  });

  it("validates settings against the typed registry and rejects unknown keys", async () => {
    setup = await setupTestTenant();
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);

    const setting = await updateTenantSetting(ctx, {
      key: "ui.defaultLanguage",
      value: "MS",
    });
    expect(setting.value).toBe("MS");

    await expect(
      updateTenantSetting(ctx, { key: "gst.rate", value: 0.09 }),
    ).rejects.toThrow(/Unknown tenant setting key/);

    const settings = await listTenantSettings(ctx);
    expect(settings.find((s) => s.key === "ui.defaultLanguage")?.value).toBe("MS");
  });
});
