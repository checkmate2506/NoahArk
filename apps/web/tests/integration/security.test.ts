import { afterEach, describe, expect, it } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import {
  withTenantContext,
  withoutTenantContext,
  UnscopedTenantQueryError,
} from "@noahark/db";
import { getTenant, updateTenant } from "@/lib/services/tenantService";
import { listLegalEntities, updateLegalEntity } from "@/lib/services/legalEntityService";
import { updateMembershipStatus } from "@/lib/services/membershipService";
import { assignRole } from "@/lib/services/roleService";
import { getAccessContext } from "@/lib/context";
import {
  setupTestTenant,
  buildContext,
  cleanupTenant,
  cleanupUser,
  createTestUser,
  createTestLegalEntity,
  addTenantMember,
  assignRoleDirect,
  grantLegalEntityAccessDirect,
  type TestTenantSetup,
} from "./testHelpers";

describe("mandatory negative security tests", () => {
  let setupA: TestTenantSetup;
  let setupB: TestTenantSetup;
  let extraUserIds: string[] = [];

  afterEach(async () => {
    for (const id of extraUserIds) await cleanupUser(id);
    extraUserIds = [];
    if (setupA) {
      await cleanupTenant(setupA.tenantId);
      await cleanupUser(setupA.adminUserId);
    }
    if (setupB) {
      await cleanupTenant(setupB.tenantId);
      await cleanupUser(setupB.adminUserId);
    }
  });

  it("rejects a cross-tenant read (RLS)", async () => {
    setupA = await setupTestTenant();
    setupB = await setupTestTenant();

    // A's admin has no membership in tenant B — context resolution itself
    // must refuse, before any RLS-scoped query even runs.
    await expect(
      getAccessContext(setupA.adminUserId, setupB.tenantId, { requestId: "t" }),
    ).rejects.toThrow(/No active membership/);
  });

  it("rejects a raw write to another tenant's row even when connected as the app role (RLS, not just the service layer)", async () => {
    setupA = await setupTestTenant();
    setupB = await setupTestTenant();

    // Bypasses the service layer entirely (which would keep the RLS
    // session tenant and the WHERE-clause target self-consistent) to prove
    // RLS itself — not just application code — refuses a write whose
    // target row's tenant_id doesn't match the session's app.tenant_id.
    // Session context is tenant A; the WHERE clause targets tenant B's row.
    const updateCount = await withTenantContext(
      { tenantId: setupA.tenantId, legalEntityIds: new Set<string>() },
      (tx) =>
        tx.tenant.updateMany({
          where: { id: setupB.tenantId },
          data: { name: "Hijacked" },
        }),
    );
    expect(updateCount.count).toBe(0);

    const db = createSystemClient();
    const tenantB = await db.tenant.findUniqueOrThrow({ where: { id: setupB.tenantId } });
    expect(tenantB.name).not.toBe("Hijacked");
  });

  it("rejects reading a legal entity that belongs to another tenant", async () => {
    setupA = await setupTestTenant();
    setupB = await setupTestTenant();
    await createTestLegalEntity(setupB.tenantId, "SG");

    const ctxA = await buildContext(setupA.adminUserId, setupA.tenantId);
    const legalEntitiesVisibleToA = await listLegalEntities(ctxA);
    expect(legalEntitiesVisibleToA).toHaveLength(0); // A's tenant has none of its own
  });

  it("rejects writing to a legal entity in a tenant the caller has no membership in", async () => {
    setupA = await setupTestTenant();
    setupB = await setupTestTenant();
    const legalEntityB = await createTestLegalEntity(setupB.tenantId, "SG");
    const ctxA = await buildContext(setupA.adminUserId, setupA.tenantId);

    await expect(
      updateLegalEntity(ctxA, legalEntityB.id, { name: "Hijacked" }),
    ).rejects.toThrow();
  });

  it("rejects a legal-entity read for a member with no legal-entity grant", async () => {
    setupA = await setupTestTenant();
    const legalEntity = await createTestLegalEntity(setupA.tenantId, "SG");
    const user = await createTestUser();
    extraUserIds.push(user.id);
    await addTenantMember(setupA.tenantId, user.id);
    // NOTE: no legal-entity membership granted

    const ctx = await buildContext(user.id, setupA.tenantId);
    expect(ctx.legalEntityIds.has(legalEntity.id)).toBe(false);
  });

  it("rejects a legal-entity write for a member with no legal-entity grant", async () => {
    setupA = await setupTestTenant();
    const legalEntity = await createTestLegalEntity(setupA.tenantId, "SG");
    const user = await createTestUser();
    extraUserIds.push(user.id);
    const membership = await addTenantMember(setupA.tenantId, user.id);
    // A role WITH the required permission, scoped to this very legal
    // entity — but no LegalEntityMembership grant exists. This proves
    // legal-entity access (check 2) is independent of, and evaluated
    // before, module permission (check 3): a role scoped to an entity
    // cannot substitute for actually being granted access to it.
    await assignRoleDirect(
      setupA.tenantId,
      membership.id,
      setupA.adminRoleId,
      setupA.adminUserId,
      legalEntity.id,
    );

    const ctx = await buildContext(user.id, setupA.tenantId);
    await expect(updateLegalEntity(ctx, legalEntity.id, { name: "x" })).rejects.toThrow(
      /No access to this legal entity/,
    );
  });

  it("rejects a client-supplied tenant id the caller has no membership in (tenant substitution)", async () => {
    setupA = await setupTestTenant();
    const bogusTenantId = "not-a-real-or-authorized-tenant-id";
    await expect(
      getAccessContext(setupA.adminUserId, bogusTenantId, { requestId: "t" }),
    ).rejects.toThrow(/No active membership/);
  });

  it("never includes a legal entity in the context that the caller was not actually granted (legal-entity substitution)", async () => {
    setupA = await setupTestTenant();
    const grantedEntity = await createTestLegalEntity(setupA.tenantId, "SG");
    const ungrantedEntity = await createTestLegalEntity(setupA.tenantId, "MY");
    await grantLegalEntityAccessDirect(
      setupA.tenantId,
      grantedEntity.id,
      setupA.adminUserId,
    );

    const ctx = await buildContext(setupA.adminUserId, setupA.tenantId);
    expect(ctx.legalEntityIds.has(grantedEntity.id)).toBe(true);
    expect(ctx.legalEntityIds.has(ungrantedEntity.id)).toBe(false);
  });

  it("rejects self-role escalation (assigning a role to yourself)", async () => {
    setupA = await setupTestTenant();
    const ctx = await buildContext(setupA.adminUserId, setupA.tenantId);

    await expect(
      assignRole(ctx, {
        tenantMembershipId: setupA.adminMembershipId,
        roleId: setupA.memberRoleId,
        legalEntityId: null,
      }),
    ).rejects.toThrow(/cannot change your own role/);
  });

  it("rejects an unauthorised user assigning any role", async () => {
    setupA = await setupTestTenant();
    const user = await createTestUser();
    extraUserIds.push(user.id);
    const membership = await addTenantMember(setupA.tenantId, user.id); // no role => no permissions
    const ctx = await buildContext(user.id, setupA.tenantId);

    await expect(
      assignRole(ctx, {
        tenantMembershipId: membership.id,
        roleId: setupA.memberRoleId,
        legalEntityId: null,
      }),
    ).rejects.toThrow(/Missing permission/);
  });

  it("rejects a disabled/suspended membership from resolving a usable context", async () => {
    setupA = await setupTestTenant();
    const user = await createTestUser();
    extraUserIds.push(user.id);
    await addTenantMember(setupA.tenantId, user.id, "SUSPENDED");

    await expect(
      getAccessContext(user.id, setupA.tenantId, { requestId: "t" }),
    ).rejects.toThrow(/No active membership/);
  });

  it("rejects mutation attempts by a user whose membership was suspended mid-session", async () => {
    setupA = await setupTestTenant();
    const user = await createTestUser();
    extraUserIds.push(user.id);
    const membership = await addTenantMember(setupA.tenantId, user.id);
    await assignRoleDirect(
      setupA.tenantId,
      membership.id,
      setupA.adminRoleId,
      setupA.adminUserId,
    );

    // Session was valid a moment ago...
    const ctx = await buildContext(user.id, setupA.tenantId);
    await expect(getTenant(ctx)).resolves.toBeDefined();

    // ...but the membership is suspended before the next request.
    await updateMembershipStatus(
      await buildContext(setupA.adminUserId, setupA.tenantId),
      membership.id,
      { status: "SUSPENDED" },
    );

    await expect(
      getAccessContext(user.id, setupA.tenantId, { requestId: "t2" }),
    ).rejects.toThrow(/No active membership/);
  });

  it("rejects updating or deleting an audit event (append-only)", async () => {
    setupA = await setupTestTenant();
    const ctx = await buildContext(setupA.adminUserId, setupA.tenantId);
    await updateTenant(ctx, { name: "trigger an audit event" });

    // audit_event is RLS-protected (nullable tenant_id, IS NOT DISTINCT FROM
    // policy — see the RLS migration §8) — it must be read through
    // withTenantContext, not the identity client (which sets no tenant
    // context at all and would correctly see zero rows here).
    const event = await withTenantContext(
      { tenantId: setupA.tenantId, legalEntityIds: new Set<string>() },
      (tx) =>
        tx.auditEvent.findFirst({
          where: { tenantId: setupA.tenantId },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        }),
    );
    expect(event).toBeDefined();

    await withTenantContext(
      { tenantId: setupA.tenantId, legalEntityIds: new Set<string>() },
      async (tx) => {
        await expect(
          tx.$executeRaw`UPDATE audit_event SET action = 'tampered' WHERE id = ${event!.id}`,
        ).rejects.toThrow();
        await expect(
          tx.$executeRaw`DELETE FROM audit_event WHERE id = ${event!.id}`,
        ).rejects.toThrow();
      },
    );
  });

  it("rejects attachment/file id enumeration across tenants (returns not-found, not the file)", async () => {
    setupA = await setupTestTenant();
    setupB = await setupTestTenant();

    // A file created under tenant B, referenced by a plausible-looking id.
    const db = createSystemClient();
    const fileB = await db.fileObject.create({
      data: {
        tenantId: setupB.tenantId,
        storageKey: `tenant/${setupB.tenantId}/enum-test.txt`,
        originalFilename: "secret.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        sha256: "deadbeef",
        uploadedByUserId: setupB.adminUserId,
      },
    });

    const ctxA = await buildContext(setupA.adminUserId, setupA.tenantId);
    const { getSignedDownloadUrl } = await import("@/lib/services/fileServiceWrapper.js");
    await expect(getSignedDownloadUrl(ctxA, fileB.id)).rejects.toThrow(/not found/i);
  });

  it("rejects a decision from a user without the required approval authority", async () => {
    setupA = await setupTestTenant();
    const db = createSystemClient();
    const policy = await db.approvalPolicy.create({
      data: {
        tenantId: setupA.tenantId,
        subjectType: "demo.approval_subject",
        name: "p",
        isActive: true,
      },
    });
    await db.approvalStep.create({
      data: {
        tenantId: setupA.tenantId,
        approvalPolicyId: policy.id,
        stepOrder: 1,
        approverRoleId: setupA.adminRoleId,
      },
    });

    const noAuthorityUser = await createTestUser();
    extraUserIds.push(noAuthorityUser.id);
    const membership = await addTenantMember(setupA.tenantId, noAuthorityUser.id);
    await assignRoleDirect(
      setupA.tenantId,
      membership.id,
      setupA.memberRoleId,
      setupA.adminUserId,
    );

    const adminCtx = await buildContext(setupA.adminUserId, setupA.tenantId);
    const { createAndSubmitDemoSubject, decideApproval } =
      await import("@/lib/services/approvalService.js");
    const { request } = await createAndSubmitDemoSubject(adminCtx, {
      title: "x",
      legalEntityId: null,
    });

    const noAuthorityCtx = await buildContext(noAuthorityUser.id, setupA.tenantId);
    await expect(
      decideApproval(noAuthorityCtx, request.id, {
        action: "APPROVE",
        expectedVersion: request.version,
      }),
    ).rejects.toThrow();
  });

  it("rejects access to a module disabled server-side, regardless of the caller's permissions", async () => {
    setupA = await setupTestTenant();
    const { setModuleEnabled, MODULE_KEYS } =
      await import("@/lib/services/entitlementService.js");
    const ctx = await buildContext(setupA.adminUserId, setupA.tenantId);

    await setModuleEnabled(ctx, { moduleKey: MODULE_KEYS.APPROVALS, enabled: false });

    const { createAndSubmitDemoSubject } =
      await import("@/lib/services/approvalService.js");
    await expect(
      createAndSubmitDemoSubject(ctx, {
        title: "should be blocked",
        legalEntityId: null,
      }),
    ).rejects.toThrow(/not enabled for this tenant/);
  });

  it("rejects a user querying tenant-owned data with no tenant context set at all", async () => {
    setupA = await setupTestTenant();
    await createTestLegalEntity(setupA.tenantId, "SG");

    // Two independent layers, both verified here: the F-3C application
    // guard now fails FAST (before the query reaches Postgres) for any
    // tenant-owned model queried with no active tenant scope...
    await expect(
      withoutTenantContext((tx) =>
        tx.legalEntity.findMany({ where: { tenantId: setupA.tenantId } }),
      ),
    ).rejects.toThrow(UnscopedTenantQueryError);

    // ...and even if that guard were bypassed entirely (a raw query, which
    // the guard extension does not intercept), RLS independently treats a
    // connection with no app.tenant_id set as "match nothing", not
    // "match everything" — the database-level backstop this guard sits on
    // top of, not a replacement for.
    const rawRows = await withoutTenantContext(
      (tx) =>
        tx.$queryRaw`SELECT id FROM legal_entity WHERE tenant_id = ${setupA.tenantId}`,
    );
    expect(rawRows).toHaveLength(0);
  });

  it("rejects reading the platform audit chain from an ordinary tenant context or a bare unscoped connection (F-7)", async () => {
    setupA = await setupTestTenant();
    const { withPlatformAuditContext } = await import("@noahark/db");
    const { writeAuditEvent } = await import("@/lib/services/auditService.js");

    await withPlatformAuditContext((tx) =>
      writeAuditEvent(tx, {
        tenantId: null,
        actorUserId: setupA.adminUserId,
        actorType: "USER",
        action: "auth.sign_in",
        entityType: "user",
        entityId: setupA.adminUserId,
        outcome: "SUCCESS",
      }),
    );

    // An ordinary tenant-scoped connection must never see platform rows.
    const viaTenantContext = await withTenantContext(
      { tenantId: setupA.tenantId, legalEntityIds: new Set<string>() },
      (tx) => tx.auditEvent.findMany({ where: { tenantId: null } }),
    );
    expect(viaTenantContext).toHaveLength(0);

    // A bare unscoped connection (no app.platform_audit_access set either)
    // must not see them, closing the gap the Phase 1A review found — the
    // F-3C guard now denies this immediately (a stronger outcome than
    // "zero rows"), so both layers are asserted the same way as the
    // no-context test above.
    await expect(
      withoutTenantContext((tx) => tx.auditEvent.findMany({ where: { tenantId: null } })),
    ).rejects.toThrow(UnscopedTenantQueryError);
    const rawViaUnscoped = await withoutTenantContext(
      (tx) => tx.$queryRaw`SELECT id FROM audit_event WHERE tenant_id IS NULL`,
    );
    expect(rawViaUnscoped).toHaveLength(0);

    // Only the dedicated platform-audit context can read them.
    const viaPlatformContext = await withPlatformAuditContext((tx) =>
      tx.auditEvent.findMany({ where: { tenantId: null } }),
    );
    expect(viaPlatformContext.length).toBeGreaterThan(0);
  });

  it("writes a platform audit event correctly even on a connection previously used for a real tenant (regression)", async () => {
    // Found during Phase 1B remediation: `current_setting(name, true)`
    // returns NULL only if `name` was NEVER touched on the current backend
    // connection. Once a transaction does `set_config(name, value, true)`
    // and commits, later reads on that SAME pooled connection see '' (empty
    // string), not NULL. Prisma's connection pool reuses connections across
    // unrelated calls — getAppClient() backs both withTenantContext and
    // withPlatformAuditContext — so a platform-chain write immediately
    // after a tenant-scoped write can land on a connection where
    // app.tenant_id is '' rather than genuinely unset. The audit_event RLS
    // policy's WITH CHECK must treat both as "no tenant" (see the RLS
    // migration's NULLIF fix) or this write is spuriously rejected.
    setupA = await setupTestTenant();
    const { withPlatformAuditContext, withTenantContext } = await import("@noahark/db");
    const { writeAuditEvent } = await import("@/lib/services/auditService.js");

    // Touch a real tenant context on whatever connection Prisma hands us,
    // and let it commit normally.
    await withTenantContext(
      { tenantId: setupA.tenantId, legalEntityIds: new Set<string>() },
      (tx) => tx.tenant.findUnique({ where: { id: setupA.tenantId } }),
    );

    // Immediately write a platform-level event — must succeed regardless of
    // which pooled connection this lands on.
    const event = await withPlatformAuditContext((tx) =>
      writeAuditEvent(tx, {
        tenantId: null,
        actorUserId: setupA.adminUserId,
        actorType: "USER",
        action: "auth.sign_in",
        entityType: "user",
        entityId: setupA.adminUserId,
        outcome: "SUCCESS",
      }),
    );
    expect(event.tenantId).toBeNull();
  });
});
