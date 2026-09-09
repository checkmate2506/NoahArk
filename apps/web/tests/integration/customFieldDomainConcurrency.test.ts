import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { verifyAuditChain, type AuditChainLink } from "@noahark/audit";
import type { AccessContext } from "@noahark/core";
import { ConflictError, NotFoundError, StaleVersionError } from "@noahark/core";
import { createSystemClient } from "@noahark/db/system";
import { withTenantContext } from "@noahark/db";
import { archiveParty, transferPartyOwnership } from "@noahark/crm";
import {
  createCustomFieldDefinition,
  deactivateCustomFieldDefinition,
  updateCustomFieldDefinition,
} from "../../lib/services/customFieldDomain";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  createStringDefinition,
  createTestParty,
  fieldKey,
  setStringValue,
  setupCustomFieldDomainFixture,
  type CustomFieldDomainFixture,
} from "./customFieldDomainFixture";

function valueKey(tenantId: string, definitionId: string, entityId: string): string {
  return `custom-field-value:${tenantId}:${definitionId}:${entityId}`;
}

async function holdTx(
  ctx: AccessContext,
  acquire: (client: pg.Client) => Promise<void>,
  whileHeld: () => Promise<void>,
  then: (client: pg.Client) => Promise<void> = async () => undefined,
): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    await client.query("SELECT set_config('app.legal_entity_ids', $1, true)", [
      Array.from(ctx.legalEntityIds).join(","),
    ]);
    await client.query("SELECT set_config('app.user_id', $1, true)", [ctx.userId]);
    await acquire(client);
    await whileHeld();
    await then(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function waitUntil(sql: string, label: string): Promise<void> {
  const url = process.env.DATABASE_MIGRATION_URL;
  if (!url) throw new Error("DATABASE_MIGRATION_URL is not set");
  const observer = new pg.Client({ connectionString: url });
  await observer.connect();
  try {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ n: string }>(sql);
      if (Number(result.rows[0]?.n ?? 0) > 0) return;
      await new Promise((r) => setTimeout(r, 15));
    }
    throw new Error(`timed out waiting for ${label}`);
  } finally {
    await observer.end();
  }
}

function waitUntilAdvisoryWaiter(): Promise<void> {
  return waitUntil(
    `SELECT count(*)::text AS n
     FROM pg_locks
     WHERE locktype = 'advisory' AND NOT granted`,
    "a blocked advisory lock",
  );
}

function waitUntilRowLockWaiter(): Promise<void> {
  return waitUntil(
    `SELECT count(*)::text AS n
     FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
       AND wait_event_type = 'Lock'`,
    "a blocked row lock",
  );
}

function toAuditLinks(
  rows: Array<{
    prevHash: string | null;
    hash: string;
    sequence: bigint;
    tenantId: string | null;
    legalEntityId: string | null;
    actorUserId: string | null;
    actorType: string;
    action: string;
    entityType: string;
    entityId: string | null;
    beforeData: unknown;
    afterData: unknown;
    outcome: string;
    createdAt: Date;
    chainKey: string;
  }>,
): AuditChainLink[] {
  return rows.map((row) => ({
    prevHash: row.prevHash,
    hash: row.hash,
    sequence: row.sequence,
    payload: {
      tenantId: row.tenantId,
      legalEntityId: row.legalEntityId,
      actorUserId: row.actorUserId,
      actorType: row.actorType,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      beforeData: row.beforeData,
      afterData: row.afterData,
      outcome: row.outcome,
      createdAt: row.createdAt.toISOString(),
      chainKey: row.chainKey,
      sequence: row.sequence.toString(),
    },
  }));
}

describe("P2C.3 — custom-field concurrency races", () => {
  let fixture: CustomFieldDomainFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("serializes same-key definition create and concurrent definition updates", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA } = fixture;
    const key = fieldKey("race");
    const settled = await Promise.allSettled([
      createCustomFieldDefinition(ctxA, {
        entityType: "party",
        key,
        label: "A",
        dataType: "STRING",
      }),
      createCustomFieldDefinition(ctxA, {
        entityType: "party",
        key,
        label: "B",
        dataType: "STRING",
      }),
    ]);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.status === "rejected" && rejected[0].reason).toBeInstanceOf(
      ConflictError,
    );

    const created = await createCustomFieldDefinition(ctxA, {
      entityType: "party",
      key: fieldKey("upd"),
      label: "Start",
      dataType: "STRING",
    });
    const updates = await Promise.allSettled([
      updateCustomFieldDefinition(ctxA, created.id, {
        expectedVersion: 1,
        label: "One",
      }),
      updateCustomFieldDefinition(ctxA, created.id, {
        expectedVersion: 1,
        label: "Two",
      }),
    ]);
    expect(updates.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      updates.some(
        (r) => r.status === "rejected" && r.reason instanceof StaleVersionError,
      ),
    ).toBe(true);
  });

  it("deactivate versus set-value, both orderings", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definition = await createStringDefinition(ctxA, "party");

    let setRejected: Promise<void> | undefined;
    await holdTx(
      ctxA,
      async (client) => {
        const locked = await client.query(
          `SELECT id FROM custom_field_definition
           WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [definition.id, ctxA.tenantId],
        );
        if (locked.rowCount !== 1) throw new Error("failed to lock definition");
      },
      async () => {
        const pending = setStringValue(ctxA, definition.id, party.party.id, "late");
        setRejected = expect(pending).rejects.toBeInstanceOf(ConflictError);
        await waitUntilRowLockWaiter();
      },
      async (client) => {
        const updated = await client.query(
          `UPDATE custom_field_definition
           SET is_active = false, version = version + 1
           WHERE id = $1 AND tenant_id = $2`,
          [definition.id, ctxA.tenantId],
        );
        if (updated.rowCount !== 1) throw new Error("failed to deactivate on holder");
      },
    );
    await setRejected;

    const definition2 = await createStringDefinition(ctxA, "party");
    let setDone: Promise<void> | undefined;
    let deactivateDone: Promise<void> | undefined;
    await holdTx(
      ctxA,
      async (client) => {
        const locked = await client.query(
          `SELECT id FROM custom_field_definition
           WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
          [definition2.id, ctxA.tenantId],
        );
        if (locked.rowCount !== 1) throw new Error("failed to share-lock definition");
      },
      async () => {
        const pendingSet = setStringValue(ctxA, definition2.id, party.party.id, "first");
        setDone = expect(pendingSet).resolves.toMatchObject({ version: 1 });
        const pendingDeactivate = deactivateCustomFieldDefinition(ctxA, definition2.id, {
          expectedVersion: 1,
        });
        deactivateDone = expect(pendingDeactivate).resolves.toMatchObject({
          isActive: false,
        });
        await waitUntilRowLockWaiter();
        await setDone;
      },
    );
    await deactivateDone;
    const db = createSystemClient();
    expect(
      await db.customFieldValue.count({
        where: { definitionId: definition2.id, entityId: party.party.id },
      }),
    ).toBe(1);
  });

  it("serializes concurrent first set and concurrent overwrite of the same value", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definition = await createStringDefinition(ctxA, "party");
    const first = await Promise.allSettled([
      setStringValue(ctxA, definition.id, party.party.id, "alpha"),
      setStringValue(ctxA, definition.id, party.party.id, "beta"),
    ]);
    expect(first.every((r) => r.status === "fulfilled")).toBe(true);
    const db = createSystemClient();
    const rows = await db.customFieldValue.findMany({
      where: { definitionId: definition.id, entityId: party.party.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(2);

    const overwrite = await Promise.allSettled([
      setStringValue(ctxA, definition.id, party.party.id, "gamma"),
      setStringValue(ctxA, definition.id, party.party.id, "delta"),
    ]);
    expect(overwrite.every((r) => r.status === "fulfilled")).toBe(true);
    const after = await db.customFieldValue.findMany({
      where: { definitionId: definition.id, entityId: party.party.id },
    });
    expect(after).toHaveLength(1);
    expect(after[0]?.version).toBe(4);
  });

  it("target archive versus value write, both orderings", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definition = await createStringDefinition(ctxA, "party");

    let setRejected: Promise<void> | undefined;
    await holdTx(
      ctxA,
      async (client) => {
        const locked = await client.query(
          `SELECT id FROM party WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [party.party.id, ctxA.tenantId],
        );
        if (locked.rowCount !== 1) throw new Error("failed to lock party");
      },
      async () => {
        const pending = setStringValue(ctxA, definition.id, party.party.id, "late");
        setRejected = expect(pending).rejects.toBeInstanceOf(ConflictError);
        await waitUntilRowLockWaiter();
      },
      async (client) => {
        const updated = await client.query(
          `UPDATE party SET status = 'ARCHIVED', archived_at = now(), version = version + 1
           WHERE id = $1 AND tenant_id = $2`,
          [party.party.id, ctxA.tenantId],
        );
        if (updated.rowCount !== 1) throw new Error("failed to archive on holder");
      },
    );
    await setRejected;

    const party2 = await createTestParty(ctxA, leA.id);
    const definition2 = await createStringDefinition(ctxA, "party");
    let setDone: Promise<void> | undefined;
    let archiveDone: Promise<void> | undefined;
    await holdTx(
      ctxA,
      async (client) => {
        const locked = await client.query(
          `SELECT id FROM party WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
          [party2.party.id, ctxA.tenantId],
        );
        if (locked.rowCount !== 1) throw new Error("failed to share-lock party");
      },
      async () => {
        const pendingSet = setStringValue(ctxA, definition2.id, party2.party.id, "first");
        setDone = expect(pendingSet).resolves.toMatchObject({ version: 1 });
        const pendingArchive = archiveParty(ctxA, party2.party.id, party2.party.version);
        archiveDone = expect(pendingArchive).resolves.toMatchObject({
          status: "ARCHIVED",
        });
        await waitUntilRowLockWaiter();
        await setDone;
      },
    );
    await archiveDone;
  });

  it("ownership transfer versus value write, both orderings", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, ctxAB, leA, leB } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definition = await createStringDefinition(ctxA, "party");

    let setRejected: Promise<void> | undefined;
    await holdTx(
      ctxAB,
      async (client) => {
        const locked = await client.query(
          `SELECT id FROM party WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [party.party.id, ctxA.tenantId],
        );
        if (locked.rowCount !== 1) throw new Error("failed to lock party");
      },
      async () => {
        const pending = setStringValue(ctxA, definition.id, party.party.id, "late");
        setRejected = expect(pending).rejects.toBeInstanceOf(NotFoundError);
        await waitUntilRowLockWaiter();
      },
      async (client) => {
        const updated = await client.query(
          `UPDATE party SET owner_legal_entity_id = $1, version = version + 1
           WHERE id = $2 AND tenant_id = $3`,
          [leB.id, party.party.id, ctxA.tenantId],
        );
        if (updated.rowCount !== 1) throw new Error("failed to transfer on holder");
      },
    );
    await setRejected;

    const party2 = await createTestParty(ctxA, leA.id);
    const definition2 = await createStringDefinition(ctxA, "party");
    let setDone: Promise<void> | undefined;
    let transferDone: Promise<void> | undefined;
    await holdTx(
      ctxAB,
      async (client) => {
        const locked = await client.query(
          `SELECT id FROM party WHERE id = $1 AND tenant_id = $2 FOR SHARE`,
          [party2.party.id, ctxA.tenantId],
        );
        if (locked.rowCount !== 1) throw new Error("failed to share-lock party");
      },
      async () => {
        const pendingSet = setStringValue(ctxA, definition2.id, party2.party.id, "first");
        setDone = expect(pendingSet).resolves.toMatchObject({ version: 1 });
        const pendingTransfer = transferPartyOwnership(ctxAB, party2.party.id, {
          newOwnerLegalEntityId: leB.id,
          expectedVersion: party2.party.version,
        });
        transferDone = expect(pendingTransfer).resolves.toMatchObject({
          ownerLegalEntityId: leB.id,
        });
        await waitUntilRowLockWaiter();
        await setDone;
      },
    );
    await transferDone;
  });

  it("waits on an external advisory holder then writes exactly one row", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definition = await createStringDefinition(ctxA, "party");
    let setDone: Promise<void> | undefined;
    await holdTx(
      ctxA,
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          valueKey(ctxA.tenantId, definition.id, party.party.id),
        ]);
      },
      async () => {
        const pending = setStringValue(ctxA, definition.id, party.party.id, "held");
        setDone = expect(pending).resolves.toMatchObject({
          typedValue: { dataType: "STRING", value: "held" },
        });
        await waitUntilAdvisoryWaiter();
      },
    );
    await setDone;
    const db = createSystemClient();
    expect(
      await db.customFieldValue.count({
        where: { definitionId: definition.id, entityId: party.party.id },
      }),
    ).toBe(1);
  });

  it("keeps the concurrent audit chain valid and gapless", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definitionA = await createStringDefinition(ctxA, "party");
    const definitionB = await createStringDefinition(ctxA, "party");
    await Promise.all([
      setStringValue(ctxA, definitionA.id, party.party.id, "a"),
      setStringValue(ctxA, definitionB.id, party.party.id, "b"),
    ]);
    const events = await withTenantContext(
      { tenantId: ctxA.tenantId, legalEntityIds: ctxA.legalEntityIds },
      (tx) =>
        tx.auditEvent.findMany({
          where: { tenantId: ctxA.tenantId },
          orderBy: { sequence: "asc" },
        }),
    );
    const result = verifyAuditChain(toAuditLinks(events));
    expect(result.valid).toBe(true);
    const sequences = events.map((e) => Number(e.sequence));
    for (let i = 1; i < sequences.length; i += 1) {
      expect(sequences[i]).toBe((sequences[i - 1] ?? 0) + 1);
    }
  });
});
