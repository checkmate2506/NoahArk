import { afterEach, describe, expect, it } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import { verifyAuditChain, type AuditChainLink } from "@noahark/audit";
import { hashPassword, computeTotp } from "@noahark/auth";
import { InMemoryEmailProvider } from "@noahark/notifications";
import { writeAuditEvent } from "@/lib/services/auditService";
import {
  createAndSubmitDemoSubject,
  decideApproval,
} from "@/lib/services/approvalService";
import { createInvitation, acceptInvitation } from "@/lib/services/invitationService";
import {
  requestEmailVerification,
  confirmEmailVerification,
} from "@/lib/services/emailVerificationService";
import {
  enrollMfa,
  confirmMfaEnrollment,
  issueMfaChallengeToken,
  verifyMfaChallenge,
} from "@/lib/services/mfaService";
import {
  setupTestTenant,
  buildContext,
  cleanupTenant,
  cleanupUser,
  createTestUser,
  addTenantMember,
  assignRoleDirect,
  type TestTenantSetup,
} from "./testHelpers";

/**
 * F-22/F-23 (Phase 1B.1): genuine concurrent-write races via `Promise.all`
 * against real Postgres — every earlier test for these flows drove the
 * two attempts SEQUENTIALLY (await, then await), which proves the state
 * machine rejects a SECOND attempt after the first committed, but not that
 * two attempts racing for the SAME window can't both partially succeed.
 * These tests fire genuinely concurrent requests and assert exactly one
 * outcome wins.
 */
describe("concurrency races (F-22/F-23, real Postgres)", () => {
  let setup: TestTenantSetup;
  let extraUserIds: string[] = [];

  afterEach(async () => {
    for (const id of extraUserIds) await cleanupUser(id);
    extraUserIds = [];
    if (setup) {
      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    }
  });

  async function loadChain(chainKey: string): Promise<AuditChainLink[]> {
    const db = createSystemClient();
    const rows = await db.auditEvent.findMany({
      where: { chainKey },
      orderBy: { sequence: "asc" },
    });
    return rows.map((r) => ({
      prevHash: r.prevHash,
      hash: r.hash,
      sequence: r.sequence,
      payload: {
        tenantId: r.tenantId,
        legalEntityId: r.legalEntityId,
        actorUserId: r.actorUserId,
        actorType: r.actorType,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        beforeData: r.beforeData,
        afterData: r.afterData,
        outcome: r.outcome,
        createdAt: r.createdAt.toISOString(),
        chainKey,
        sequence: r.sequence.toString(),
      },
    }));
  }

  it("parallel audit writers on the SAME chain never fork it — gapless sequence, valid hash chain", async () => {
    setup = await setupTestTenant();
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    const WRITER_COUNT = 12;

    await Promise.all(
      Array.from({ length: WRITER_COUNT }, (_, i) =>
        withTenantContext(
          { tenantId: setup.tenantId, legalEntityIds: new Set(), userId: ctx.userId },
          (tx) =>
            writeAuditEvent(tx, {
              tenantId: setup.tenantId,
              actorUserId: ctx.userId,
              action: "test.concurrent_write",
              entityType: "test_entity",
              entityId: `entity-${i}`,
            }),
        ),
      ),
    );

    const links = await loadChain(setup.tenantId);
    expect(links).toHaveLength(WRITER_COUNT);
    const result = verifyAuditChain(links);
    expect(result.valid).toBe(true);
    // Gapless from 1..N is implied by verifyAuditChain, but assert it
    // explicitly too for a clearer failure message if this regresses.
    expect(links.map((l) => l.sequence)).toEqual(
      Array.from({ length: WRITER_COUNT }, (_, i) => BigInt(i + 1)),
    );
  });

  it("parallel audit writers on DIFFERENT chains (different tenants) don't interfere with each other", async () => {
    setup = await setupTestTenant();
    const otherSetup = await setupTestTenant();
    try {
      const ctxA = await buildContext(setup.adminUserId, setup.tenantId);
      const ctxB = await buildContext(otherSetup.adminUserId, otherSetup.tenantId);
      const COUNT_PER_TENANT = 8;

      await Promise.all([
        ...Array.from({ length: COUNT_PER_TENANT }, (_, i) =>
          withTenantContext(
            { tenantId: setup.tenantId, legalEntityIds: new Set(), userId: ctxA.userId },
            (tx) =>
              writeAuditEvent(tx, {
                tenantId: setup.tenantId,
                actorUserId: ctxA.userId,
                action: "test.concurrent_write_a",
                entityType: "test_entity",
                entityId: `a-${i}`,
              }),
          ),
        ),
        ...Array.from({ length: COUNT_PER_TENANT }, (_, i) =>
          withTenantContext(
            {
              tenantId: otherSetup.tenantId,
              legalEntityIds: new Set(),
              userId: ctxB.userId,
            },
            (tx) =>
              writeAuditEvent(tx, {
                tenantId: otherSetup.tenantId,
                actorUserId: ctxB.userId,
                action: "test.concurrent_write_b",
                entityType: "test_entity",
                entityId: `b-${i}`,
              }),
          ),
        ),
      ]);

      const chainA = await loadChain(setup.tenantId);
      const chainB = await loadChain(otherSetup.tenantId);
      expect(chainA).toHaveLength(COUNT_PER_TENANT);
      expect(chainB).toHaveLength(COUNT_PER_TENANT);
      expect(verifyAuditChain(chainA).valid).toBe(true);
      expect(verifyAuditChain(chainB).valid).toBe(true);
      // Every event landed on its OWN tenant's chain, never the other's.
      expect(chainA.every((l) => l.payload.tenantId === setup.tenantId)).toBe(true);
      expect(chainB.every((l) => l.payload.tenantId === otherSetup.tenantId)).toBe(true);
    } finally {
      await cleanupTenant(otherSetup.tenantId);
      await cleanupUser(otherSetup.adminUserId);
    }
  });

  it("parallel approval decisions on the same step: exactly one wins, the other loses the optimistic-concurrency race", async () => {
    setup = await setupTestTenant();
    const db = createSystemClient();
    const policy = await db.approvalPolicy.create({
      data: {
        tenantId: setup.tenantId,
        subjectType: "demo.approval_subject",
        name: "Race policy",
        isActive: true,
        allowSelfApproval: true,
      },
    });
    await db.approvalStep.create({
      data: {
        tenantId: setup.tenantId,
        approvalPolicyId: policy.id,
        stepOrder: 1,
        approverRoleId: setup.adminRoleId,
      },
    });

    // Two DIFFERENT users, both holding the approver role, racing to decide
    // the SAME step — two genuinely separate connections/contexts, not one
    // caller awaited twice.
    const approverB = await createTestUser();
    extraUserIds.push(approverB.id);
    const membershipB = await addTenantMember(setup.tenantId, approverB.id);
    await assignRoleDirect(
      setup.tenantId,
      membershipB.id,
      setup.adminRoleId,
      setup.adminUserId,
    );

    const submitterCtx = await buildContext(setup.adminUserId, setup.tenantId);
    const { request } = await createAndSubmitDemoSubject(submitterCtx, {
      title: "Race target",
      legalEntityId: null,
    });

    const ctxA = await buildContext(setup.adminUserId, setup.tenantId);
    const ctxB = await buildContext(approverB.id, setup.tenantId);

    const results = await Promise.allSettled([
      decideApproval(ctxA, request.id, {
        action: "APPROVE",
        expectedVersion: request.version,
      }),
      decideApproval(ctxB, request.id, {
        action: "REJECT",
        expectedVersion: request.version,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const final = await db.approvalRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(["APPROVED", "REJECTED"]).toContain(final.status);
    expect(final.version).toBe(request.version + 1); // exactly one decision applied
  });

  it("invitation double-acceptance race: exactly one concurrent accept succeeds", async () => {
    setup = await setupTestTenant();
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    const email = `race-invitee-${Date.now()}@test.noahark.local`;
    const { rawToken } = await createInvitation(ctx, {
      email,
      intendedRoleId: null,
      intendedLegalEntityId: null,
    });

    const results = await Promise.allSettled([
      acceptInvitation({
        token: rawToken,
        password: "RacePassword123!",
        name: "Racer 1",
      }),
      acceptInvitation({
        token: rawToken,
        password: "RacePassword123!",
        name: "Racer 2",
      }),
    ]);

    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof acceptInvitation>>> =>
        r.status === "fulfilled",
    );
    expect(fulfilled).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const db = createSystemClient();
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    extraUserIds.push(user.id);
    const memberships = await db.tenantMembership.findMany({
      where: { tenantId: setup.tenantId, userId: user.id },
    });
    expect(memberships).toHaveLength(1); // not double-provisioned
  });

  it("email-verification-token double-use race: exactly one concurrent confirm succeeds", async () => {
    const user = await createTestUser();
    extraUserIds.push(user.id);
    const provider = new InMemoryEmailProvider();
    await requestEmailVerification(user.id, provider);
    const body = provider.sent.at(-1)?.body ?? "";
    const rawToken = /token=([^\s&]+)/.exec(body)?.[1] ?? "";
    expect(rawToken).not.toBe("");

    const results = await Promise.allSettled([
      confirmEmailVerification(rawToken),
      confirmEmailVerification(rawToken),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("MFA recovery-code double-use race: exactly one concurrent challenge succeeds", async () => {
    const db = createSystemClient();
    const user = await db.user.create({
      data: { email: `mfa-race-${Date.now()}@test.noahark.local` },
    });
    extraUserIds.push(user.id);
    await db.userCredential.create({
      data: {
        userId: user.id,
        passwordHash: await hashPassword("Password123!"),
        algorithm: "argon2id",
      },
    });

    const { secret } = await enrollMfa(user.id);
    const { recoveryCodes } = await confirmMfaEnrollment(user.id, computeTotp(secret));
    const code = recoveryCodes[0]!;

    // Two SEPARATE challenge tokens (as two concurrent sign-in attempts
    // would each get their own), both racing to redeem the SAME recovery
    // code.
    const [tokenA, tokenB] = await Promise.all([
      issueMfaChallengeToken(user.id),
      issueMfaChallengeToken(user.id),
    ]);

    const results = await Promise.allSettled([
      verifyMfaChallenge(tokenA, code),
      verifyMfaChallenge(tokenB, code),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});
