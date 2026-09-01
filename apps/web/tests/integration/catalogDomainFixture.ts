import { randomBytes } from "node:crypto";
import type { AccessContext } from "@noahark/core";
import {
  addTenantMember,
  assignRoleDirect,
  buildContext,
  createTestLegalEntity,
  createTestUser,
  grantLegalEntityAccessDirect,
  setupTestTenant,
  uniqueSlug,
  type TestTenantSetup,
} from "./testHelpers";
import {
  createCatalogCategory,
  createUnitOfMeasure,
} from "../../lib/services/catalogDomain";

export function catalogCode(prefix = "C"): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`.slice(0, 32);
}

export async function grantLe(tenantId: string, legalEntityId: string, userId: string) {
  return grantLegalEntityAccessDirect(tenantId, legalEntityId, userId);
}

export function contextWithEntities(
  base: AccessContext,
  legalEntityIds: readonly string[],
): AccessContext {
  return { ...base, legalEntityIds: new Set(legalEntityIds) };
}

export interface CatalogDomainFixture {
  setup: TestTenantSetup;
  leA: Awaited<ReturnType<typeof createTestLegalEntity>>;
  leB: Awaited<ReturnType<typeof createTestLegalEntity>>;
  leC: Awaited<ReturnType<typeof createTestLegalEntity>>;
  leD: Awaited<ReturnType<typeof createTestLegalEntity>>;
  ctxAB: AccessContext;
  ctxA: AccessContext;
  ctxB: AccessContext;
  ctxNone: AccessContext;
  userAId: string;
  userBId: string;
}

export async function setupCatalogDomainFixture(): Promise<CatalogDomainFixture> {
  const setup = await setupTestTenant();
  const leA = await createTestLegalEntity(setup.tenantId, "SG");
  const leB = await createTestLegalEntity(setup.tenantId, "MY");
  const leC = await createTestLegalEntity(setup.tenantId, "ID");
  const leD = await createTestLegalEntity(setup.tenantId, "SG");
  await grantLe(setup.tenantId, leA.id, setup.adminUserId);
  await grantLe(setup.tenantId, leB.id, setup.adminUserId);
  await grantLe(setup.tenantId, leC.id, setup.adminUserId);
  await grantLe(setup.tenantId, leD.id, setup.adminUserId);

  const userA = await createTestUser();
  const memA = await addTenantMember(setup.tenantId, userA.id);
  await assignRoleDirect(setup.tenantId, memA.id, setup.memberRoleId, setup.adminUserId);
  await grantLe(setup.tenantId, leA.id, userA.id);

  const userB = await createTestUser();
  const memB = await addTenantMember(setup.tenantId, userB.id);
  await assignRoleDirect(setup.tenantId, memB.id, setup.memberRoleId, setup.adminUserId);
  await grantLe(setup.tenantId, leB.id, userB.id);

  const ctxAB = await buildContext(setup.adminUserId, setup.tenantId);
  const ctxA = await buildContext(userA.id, setup.tenantId);
  const ctxB = await buildContext(userB.id, setup.tenantId);
  const ctxNone: AccessContext = {
    ...ctxAB,
    legalEntityIds: new Set(),
    legalEntityPermissions: new Map(),
    legalEntityRoleIds: new Map(),
  };

  return {
    setup,
    leA,
    leB,
    leC,
    leD,
    ctxAB,
    ctxA,
    ctxB,
    ctxNone,
    userAId: userA.id,
    userBId: userB.id,
  };
}

export async function createTestCategory(ctx: AccessContext, name = "Category") {
  return createCatalogCategory(ctx, { code: catalogCode("CAT"), name });
}

export async function createTestUom(ctx: AccessContext, name = "Each") {
  return createUnitOfMeasure(ctx, { code: catalogCode("UOM"), name });
}

export { uniqueSlug };
