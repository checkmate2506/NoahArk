import { describe, expect, it } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import { getWorkerClient } from "@noahark/db/worker";
import {
  getIdentityClient,
  listAllTenantIdsForMaintenance,
  withTenantContext,
} from "@noahark/db";
import { setupTestTenant, cleanupTenant, cleanupUser } from "./testHelpers";

/**
 * P1G-6 (Phase 1H) adversarial live probes for
 * `worker_maintenance_list_tenant_ids()` / `listAllTenantIdsForMaintenance`
 * — proving the replacement for `withWorkerMaintenanceContext` is
 * genuinely narrower, not just described as narrower. Phase 1G's core
 * finding was that the OLD mechanism's "ids only" claim was an application
 * convention, not a database fact; these tests exercise the DATABASE
 * directly (raw SQL through the ordinary `noahark_app`-role client, the
 * exact role granted EXECUTE on the new function) rather than only calling
 * the wrapper function this codebase happens to use.
 */
describe("cross-tenant maintenance boundary — worker_maintenance_list_tenant_ids (P1G-6)", () => {
  it("enumerates tenant ids across tenants the caller does not belong to", async () => {
    const setupA = await setupTestTenant();
    const setupB = await setupTestTenant();

    const ids = await listAllTenantIdsForMaintenance();

    expect(ids).toContain(setupA.tenantId);
    expect(ids).toContain(setupB.tenantId);

    await cleanupTenant(setupA.tenantId);
    await cleanupUser(setupA.adminUserId);
    await cleanupTenant(setupB.tenantId);
    await cleanupUser(setupB.adminUserId);
  });

  it("the underlying SQL function's own column set is id-only — a raw SELECT * cannot surface more", async () => {
    const db = getIdentityClient();
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      "SELECT * FROM worker_maintenance_list_tenant_ids() LIMIT 1",
    );
    const firstRow = rows[0];
    if (firstRow) {
      expect(Object.keys(firstRow)).toEqual(["id"]);
    }
  });

  it("noahark_app still cannot read another tenant's name/slug/settings through the ordinary tenant table outside a matching scope", async () => {
    const setup = await setupTestTenant();
    const stranger = await setupTestTenant();

    // Ordinary tenant-scoped query, scoped to `setup`'s own tenant — RLS
    // must still refuse to surface `stranger`'s row, exactly as before
    // this change. The new function grants EXECUTE, not a broader SELECT
    // on `tenant` — this proves that boundary still holds.
    await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set<string>() },
      async (tx) => {
        const rows = await tx.tenant.findMany({ where: { id: stranger.tenantId } });
        expect(rows).toHaveLength(0);
      },
    );

    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
    await cleanupTenant(stranger.tenantId);
    await cleanupUser(stranger.adminUserId);
  });

  it("noahark_worker (a different role) has no EXECUTE grant on the maintenance-enumeration function", async () => {
    const worker = getWorkerClient();
    await expect(
      worker.$queryRawUnsafe(
        "SELECT * FROM worker_maintenance_list_tenant_ids() LIMIT 1",
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("noahark_maintenance_definer (the function's own owner) is NOLOGIN and cannot be connected to directly", async () => {
    const system = createSystemClient();
    const rows = await system.$queryRawUnsafe<Array<{ rolcanlogin: boolean }>>(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'noahark_maintenance_definer'",
    );
    expect(rows[0]?.rolcanlogin).toBe(false);
  });
});
