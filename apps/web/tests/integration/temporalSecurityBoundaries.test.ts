import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import { signFileAccess, verifyFileAccess } from "@noahark/files";
import { cleanupExpiredBuckets } from "@/lib/rateLimiter";
import { writeAuditEvent } from "@/lib/services/auditService";
import {
  buildContext,
  setupTestTenant,
  cleanupTenant,
  cleanupUser,
  createTestUser,
} from "./testHelpers";

/**
 * Phase 1H.2 §6: every OTHER Phase 1 time-based security/correctness
 * boundary, proven timezone-independent — either because the underlying
 * column is now a correctly-typed, correctly-written `timestamptz`
 * (invitation/verification/session expiry — see
 * `temporalSchemaConformance.test.ts`'s write-path regression guard for
 * the general proof) or because the check never touches the database's
 * session timezone at all (signed-file expiry, encoded entirely as a
 * numeric Unix-ms value inside the token itself).
 */
describe("temporal security boundaries — timezone independence (Phase 1H.2)", () => {
  // Phase 1H.3 (test-isolation hardening): fixtures assign to these SHARED
  // variables instead of local `const` so the `afterEach` below can clean
  // them up even when a mid-test assertion throws — see
  // jobSchedulingTemporalMatrix.test.ts's identical pattern and its fuller
  // rationale comment for why this matters (a live Opus verification
  // caught a related worker-fork-crash contamination case in this phase).
  let tenantSetup: Awaited<ReturnType<typeof setupTestTenant>> | undefined;
  let standaloneUser: Awaited<ReturnType<typeof createTestUser>> | undefined;
  afterEach(async () => {
    if (tenantSetup) {
      await cleanupTenant(tenantSetup.tenantId).catch(() => undefined);
      await cleanupUser(tenantSetup.adminUserId).catch(() => undefined);
      tenantSetup = undefined;
    }
    if (standaloneUser) {
      await cleanupUser(standaloneUser.id).catch(() => undefined);
      standaloneUser = undefined;
    }
  });

  it("membership invitation expiry: expiresAt round-trips correctly and a past expiry is recognized as expired", async () => {
    const system = createSystemClient();
    const setup = (tenantSetup = await setupTestTenant());

    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const invitation = await system.membershipInvitation.create({
      data: {
        tenantId: setup.tenantId,
        email: "invitee@test.noahark.local",
        tokenHash: randomUUID(),
        invitedByUserId: setup.adminUserId,
        status: "PENDING",
        expiresAt: future,
      },
    });

    // Read back through an INDEPENDENT raw connection — proves the value
    // actually on disk, not merely what Prisma's own model layer echoes.
    const raw = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
    await raw.connect();
    try {
      const result = await raw.query<{ expires_at: Date }>(
        "SELECT expires_at FROM membership_invitation WHERE id = $1",
        [invitation.id],
      );
      expect(
        Math.abs(result.rows[0]!.expires_at.getTime() - future.getTime()),
      ).toBeLessThan(1000);
    } finally {
      await raw.end();
    }

    // A JS-side expiry check (exactly what invitationService.ts's own
    // `expiresAt < new Date()` does) is unaffected by any session
    // timezone — it's a pure epoch-millisecond comparison once the value
    // is correctly in memory.
    expect(invitation.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const past = await system.membershipInvitation.create({
      data: {
        tenantId: setup.tenantId,
        email: "expired@test.noahark.local",
        tokenHash: randomUUID(),
        invitedByUserId: setup.adminUserId,
        status: "PENDING",
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    expect(past.expiresAt.getTime()).toBeLessThan(Date.now());

    await system.membershipInvitation.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("email-verification token expiry round-trips correctly through raw SQL", async () => {
    const system = createSystemClient();
    const user = (standaloneUser = await createTestUser());
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const token = await system.verificationToken.create({
      data: { identifier: user.email!, token: randomUUID(), expires: future },
    });

    const raw = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
    await raw.connect();
    try {
      const result = await raw.query<{ expires: Date }>(
        "SELECT expires FROM verification_token WHERE identifier = $1 AND token = $2",
        [token.identifier, token.token],
      );
      expect(Math.abs(result.rows[0]!.expires.getTime() - future.getTime())).toBeLessThan(
        1000,
      );
    } finally {
      await raw.end();
    }

    await system.verificationToken.deleteMany({ where: { identifier: user.email! } });
    await cleanupUser(user.id);
  });

  it("session expiry round-trips correctly through raw SQL", async () => {
    const system = createSystemClient();
    const user = (standaloneUser = await createTestUser());
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const session = await system.session.create({
      data: { sessionToken: randomUUID(), userId: user.id, expires: future },
    });

    const raw = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
    await raw.connect();
    try {
      const result = await raw.query<{ expires: Date }>(
        "SELECT expires FROM session WHERE id = $1",
        [session.id],
      );
      expect(Math.abs(result.rows[0]!.expires.getTime() - future.getTime())).toBeLessThan(
        1000,
      );
    } finally {
      await raw.end();
    }

    await system.session.deleteMany({ where: { userId: user.id } });
    await cleanupUser(user.id);
  });

  it("rate-limit window boundaries are timezone-independent — window_start is exact-match bucketed, not range-compared against a session-clocked value", async () => {
    const system = createSystemClient();
    const now = Date.now();
    const windowStart = new Date(Math.floor(now / (15 * 60_000)) * (15 * 60_000));

    await system.$executeRaw`
      INSERT INTO auth_rate_limit_bucket (id, dimension, key_hash, window_start, attempt_count, updated_at)
      VALUES (gen_random_uuid()::text, 'EMAIL', ${"tzbucketguard"}, ${windowStart}, 1, now())
    `;

    const raw = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
    await raw.connect();
    let storedWindowStart: Date;
    try {
      const result = await raw.query<{ window_start: Date }>(
        "SELECT window_start FROM auth_rate_limit_bucket WHERE key_hash = $1",
        ["tzbucketguard"],
      );
      storedWindowStart = result.rows[0]!.window_start;
    } finally {
      await raw.end();
    }
    expect(storedWindowStart.getTime()).toBe(windowStart.getTime());

    const removed = await cleanupExpiredBuckets(now + 25 * 60 * 60 * 1000);
    expect(removed).toBeGreaterThanOrEqual(1);
  });

  it("signed-file URL expiry is encoded as a plain numeric Unix-ms value, never a database timestamp comparison — timezone-independent by construction", () => {
    const input = {
      fileId: "file-1",
      storageKey: "key-1",
      version: 1,
      operation: "download" as const,
    };
    const secret = "test-secret";

    const fresh = signFileAccess(input, secret, 60);
    expect(verifyFileAccess(input, fresh.expiresAt, fresh.signature, secret)).toBe(true);

    const expired = signFileAccess(input, secret, -1);
    expect(verifyFileAccess(input, expired.expiresAt, expired.signature, secret)).toBe(
      false,
    );
  });

  it("audit event sequence ordering is monotonic for naturally-created rows, and created_at round-trips correctly — no audit-trigger manipulation involved", async () => {
    // Phase 1H.3: this test previously forced a deliberate `createdAt` TIE
    // across 5 rows via a raw `ALTER TABLE audit_event DISABLE/ENABLE
    // TRIGGER` pair, to prove pagination survives that adversarial case.
    // Removed — not because the claim was wrong, but because:
    //   (1) `ALTER TABLE ... TRIGGER` takes an ACCESS EXCLUSIVE lock on
    //       `audit_event` for the whole database, issued here OUTSIDE the
    //       shared gated primitive (`withGatedAuditTriggerDisabled`,
    //       `apps/web/tests/testCleanupGate.ts`) that every other
    //       trigger-disabling call site goes through — a real regression
    //       against P1G-1/ADR-47 that a live Opus verification caught: the
    //       lock contention made the mandatory "integration suite twice"
    //       gate fail in roughly half of a 12-run sample (crashed vitest
    //       worker forks left PENDING job fixtures uncleaned, which
    //       `claimNextJob()` then correctly-but-unhelpfully claimed in
    //       LATER, unrelated test files).
    //   (2) The tied-timestamp pagination proof this test duplicated
    //       already lives in `auditPagination.test.ts` ("paginates forward
    //       with no duplicates and no skips across many
    //       identically-timestamped events"), which goes through the
    //       shared gated primitive correctly. Nothing is lost by not
    //       repeating it here a second time with a second, ungated
    //       mechanism.
    // What THIS file still owns (a distinct, genuinely temporal-security
    // claim, matching the pattern already used above for invitation/
    // verification/session expiry): `audit_event.created_at` round-trips
    // correctly as a genuine `timestamptz` through an INDEPENDENT raw
    // connection read, and `sequence` — a plain monotonic `BigInt` counter
    // (see schema.prisma's own comment: looked up by `(chainKey,
    // sequence)`, never by `createdAt`) — is strictly increasing for
    // naturally-created rows with no tie-forcing needed to demonstrate
    // that. No row is ever mutated; the audit chain's append-only triggers
    // are never touched.
    const system = createSystemClient();
    const setup = (tenantSetup = await setupTestTenant());
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    const ids: string[] = [];
    await withTenantContext(
      {
        tenantId: setup.tenantId,
        legalEntityIds: ctx.legalEntityIds,
        userId: ctx.userId,
      },
      async (tx) => {
        for (let i = 0; i < 5; i++) {
          const event = await writeAuditEvent(tx, {
            tenantId: setup.tenantId,
            actorUserId: ctx.userId,
            action: "test.tz_audit_guard",
            entityType: "test_entity",
            entityId: `entity-${i}`,
          });
          ids.push(event.id);
        }
      },
    );

    const rows = await system.auditEvent.findMany({
      where: { id: { in: ids } },
      orderBy: { sequence: "asc" },
      select: { id: true, sequence: true, createdAt: true },
    });
    expect(rows.map((r) => r.id)).toEqual(ids); // insertion order preserved
    const sequences = rows.map((r) => r.sequence);
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]! > sequences[i - 1]!).toBe(true);
    }
    expect(new Set(sequences.map(String)).size).toBe(5); // no duplicate sequence values

    const raw = new pg.Client({ connectionString: process.env.DATABASE_MIGRATION_URL });
    await raw.connect();
    try {
      const result = await raw.query<{ id: string; created_at: Date }>(
        "SELECT id, created_at FROM audit_event WHERE id = ANY($1::text[])",
        [ids],
      );
      expect(result.rows).toHaveLength(5);
      for (const row of result.rows) {
        const matching = rows.find((r) => r.id === row.id);
        expect(matching).toBeDefined();
        expect(
          Math.abs(row.created_at.getTime() - matching!.createdAt.getTime()),
        ).toBeLessThan(1000);
      }
    } finally {
      await raw.end();
    }

    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });
});
