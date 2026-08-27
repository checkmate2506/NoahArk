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

export function partyCode(prefix = "P"): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

export async function grantLe(tenantId: string, legalEntityId: string, userId: string) {
  return grantLegalEntityAccessDirect(tenantId, legalEntityId, userId);
}

export interface PartyDomainFixture {
  setup: TestTenantSetup;
  leA: Awaited<ReturnType<typeof createTestLegalEntity>>;
  leB: Awaited<ReturnType<typeof createTestLegalEntity>>;
  leId: Awaited<ReturnType<typeof createTestLegalEntity>>;
  ctxAB: AccessContext;
  ctxA: AccessContext;
  ctxB: AccessContext;
  userAId: string;
  userBId: string;
}

export async function setupPartyDomainFixture(): Promise<PartyDomainFixture> {
  const setup = await setupTestTenant();
  const leA = await createTestLegalEntity(setup.tenantId, "SG");
  const leB = await createTestLegalEntity(setup.tenantId, "MY");
  const leId = await createTestLegalEntity(setup.tenantId, "ID");
  await grantLe(setup.tenantId, leA.id, setup.adminUserId);
  await grantLe(setup.tenantId, leB.id, setup.adminUserId);

  const userA = await createTestUser();
  const memA = await addTenantMember(setup.tenantId, userA.id);
  await assignRoleDirect(setup.tenantId, memA.id, setup.memberRoleId, setup.adminUserId);
  await grantLe(setup.tenantId, leA.id, userA.id);

  const userB = await createTestUser();
  const memB = await addTenantMember(setup.tenantId, userB.id);
  await assignRoleDirect(setup.tenantId, memB.id, setup.memberRoleId, setup.adminUserId);
  await grantLe(setup.tenantId, leB.id, userB.id);

  return {
    setup,
    leA,
    leB,
    leId,
    ctxAB: await buildContext(setup.adminUserId, setup.tenantId),
    ctxA: await buildContext(userA.id, setup.tenantId),
    ctxB: await buildContext(userB.id, setup.tenantId),
    userAId: userA.id,
    userBId: userB.id,
  };
}

export { uniqueSlug };
