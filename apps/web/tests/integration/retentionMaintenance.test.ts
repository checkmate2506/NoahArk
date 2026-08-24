import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSystemClient } from "@noahark/db/system";
import { cleanupTerminalJobs, cleanupTerminalOutboxEvents } from "@noahark/jobs";
import {
  cleanupExpiredSessions,
  cleanupTerminalInvitations,
  cleanupExpiredTestEmailCaptures,
  purgeDeletedFileObjectStorage,
  MAINTENANCE_BATCH_SIZE,
} from "@/lib/retentionMaintenance";
import { getStorageProvider } from "@/lib/services/fileServiceWrapper";
import {
  setupTestTenant,
  cleanupTenant,
  cleanupUser,
  createTestUser,
} from "./testHelpers";

/**
 * P1E-4 (Phase 1F): per-category coverage for the 6 new retention routines
 * — expired removed, unexpired preserved, idempotent rerun, and (for the
 * one category with real batching stakes — sessions, the cheapest to
 * create in bulk) the batch limit is actually respected. Concurrency
 * safety and failure isolation are structural properties of each
 * function's own shape (a single scoped `deleteMany`/independent
 * try/catch per row for the storage-purge case — see
 * retentionMaintenance.ts) rather than something a single-process test can
 * meaningfully race; `packages/jobs/src/maintenance.test.ts` already
 * covers `runMaintenanceTasks`'s cross-task failure isolation, which every
 * task registered here inherits for free.
 */
describe("cleanupExpiredSessions (P1E-4)", () => {
  it("removes expired sessions, preserves unexpired ones, and is idempotent", async () => {
    const db = createSystemClient();
    const user = await createTestUser();
    const now = Date.now();
    const expired = await db.session.create({
      data: {
        sessionToken: randomUUID(),
        userId: user.id,
        expires: new Date(now - 2 * 24 * 60 * 60 * 1000),
      },
    });
    const unexpired = await db.session.create({
      data: {
        sessionToken: randomUUID(),
        userId: user.id,
        expires: new Date(now + 60 * 60 * 1000),
      },
    });

    const removed = await cleanupExpiredSessions(now);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await db.session.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await db.session.findUnique({ where: { id: unexpired.id } })).not.toBeNull();

    const secondRun = await cleanupExpiredSessions(now);
    expect(secondRun).toBe(0);

    await db.session.deleteMany({ where: { id: unexpired.id } });
    await cleanupUser(user.id);
  });

  it("respects the batch size limit", async () => {
    const db = createSystemClient();
    const user = await createTestUser();
    const now = Date.now();
    const overflow = MAINTENANCE_BATCH_SIZE + 5;
    await db.session.createMany({
      data: Array.from({ length: overflow }, () => ({
        sessionToken: randomUUID(),
        userId: user.id,
        expires: new Date(now - 2 * 24 * 60 * 60 * 1000),
      })),
    });

    const firstBatch = await cleanupExpiredSessions(now);
    expect(firstBatch).toBe(MAINTENANCE_BATCH_SIZE);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(5);

    const secondBatch = await cleanupExpiredSessions(now);
    expect(secondBatch).toBe(5);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(0);

    await cleanupUser(user.id);
  }, 30_000);
});

describe("cleanupTerminalInvitations (P1E-4)", () => {
  it("removes terminal invitations past retention, preserves active/recent ones", async () => {
    const db = createSystemClient();
    const setup = await setupTestTenant();
    const now = Date.now();
    const longAgo = new Date(now - 40 * 24 * 60 * 60 * 1000);
    const recently = new Date(now - 1 * 24 * 60 * 60 * 1000);

    const oldAccepted = await db.membershipInvitation.create({
      data: {
        tenantId: setup.tenantId,
        email: "old-accepted@test.noahark.local",
        tokenHash: randomUUID(),
        invitedByUserId: setup.adminUserId,
        status: "ACCEPTED",
        expiresAt: longAgo,
        acceptedAt: longAgo,
      },
    });
    const recentAccepted = await db.membershipInvitation.create({
      data: {
        tenantId: setup.tenantId,
        email: "recent-accepted@test.noahark.local",
        tokenHash: randomUUID(),
        invitedByUserId: setup.adminUserId,
        status: "ACCEPTED",
        expiresAt: recently,
        acceptedAt: recently,
      },
    });
    const stillPending = await db.membershipInvitation.create({
      data: {
        tenantId: setup.tenantId,
        email: "still-pending@test.noahark.local",
        tokenHash: randomUUID(),
        invitedByUserId: setup.adminUserId,
        status: "PENDING",
        expiresAt: new Date(now + 60 * 60 * 1000),
      },
    });

    const removed = await cleanupTerminalInvitations(now);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(
      await db.membershipInvitation.findUnique({ where: { id: oldAccepted.id } }),
    ).toBeNull();
    expect(
      await db.membershipInvitation.findUnique({ where: { id: recentAccepted.id } }),
    ).not.toBeNull();
    expect(
      await db.membershipInvitation.findUnique({ where: { id: stillPending.id } }),
    ).not.toBeNull();

    expect(await cleanupTerminalInvitations(now)).toBe(0);

    await db.membershipInvitation.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });
});

describe("cleanupExpiredTestEmailCaptures (P1E-4)", () => {
  it("removes old captures, preserves recent ones, idempotent", async () => {
    const db = createSystemClient();
    const now = Date.now();
    const old = await db.testEmailCapture.create({
      data: {
        to: `old-${randomUUID()}@test.noahark.local`,
        subject: "s",
        body: "b",
        createdAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
      },
    });
    const recent = await db.testEmailCapture.create({
      data: { to: `recent-${randomUUID()}@test.noahark.local`, subject: "s", body: "b" },
    });

    const removed = await cleanupExpiredTestEmailCaptures(now);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await db.testEmailCapture.findUnique({ where: { id: old.id } })).toBeNull();
    expect(
      await db.testEmailCapture.findUnique({ where: { id: recent.id } }),
    ).not.toBeNull();
    expect(await cleanupExpiredTestEmailCaptures(now)).toBe(0);

    await db.testEmailCapture.deleteMany({ where: { id: recent.id } });
  });
});

describe("cleanupTerminalJobs / cleanupTerminalOutboxEvents (P1E-4, @noahark/jobs — worker-client, cross-tenant)", () => {
  it("removes old terminal jobs, preserves active/recent ones, idempotent", async () => {
    const db = createSystemClient();
    const setup = await setupTestTenant();
    const now = Date.now();
    const oldSucceeded = await db.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.old_succeeded",
        payload: {},
        status: "SUCCEEDED",
      },
    });
    await db.backgroundJob.update({
      where: { id: oldSucceeded.id },
      data: { updatedAt: new Date(now - 8 * 24 * 60 * 60 * 1000) },
    });
    const recentDead = await db.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.recent_dead",
        payload: {},
        status: "DEAD",
      },
    });
    const stillPending = await db.backgroundJob.create({
      data: {
        tenantId: setup.tenantId,
        jobType: "test.still_pending",
        payload: {},
        status: "PENDING",
      },
    });

    const removed = await cleanupTerminalJobs(now);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(
      await db.backgroundJob.findUnique({ where: { id: oldSucceeded.id } }),
    ).toBeNull();
    expect(
      await db.backgroundJob.findUnique({ where: { id: recentDead.id } }),
    ).not.toBeNull();
    expect(
      await db.backgroundJob.findUnique({ where: { id: stillPending.id } }),
    ).not.toBeNull();
    expect(await cleanupTerminalJobs(now)).toBe(0);

    await db.backgroundJob.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("removes old terminal outbox events, preserves active/recent ones, idempotent", async () => {
    const db = createSystemClient();
    const setup = await setupTestTenant();
    const now = Date.now();
    const oldProcessed = await db.outboxEvent.create({
      data: {
        tenantId: setup.tenantId,
        eventType: "test.old_processed",
        payload: {},
        status: "PROCESSED",
      },
    });
    await db.outboxEvent.update({
      where: { id: oldProcessed.id },
      data: { createdAt: new Date(now - 8 * 24 * 60 * 60 * 1000) },
    });
    const recentFailed = await db.outboxEvent.create({
      data: {
        tenantId: setup.tenantId,
        eventType: "test.recent_failed",
        payload: {},
        status: "FAILED",
      },
    });
    const stillPending = await db.outboxEvent.create({
      data: {
        tenantId: setup.tenantId,
        eventType: "test.still_pending",
        payload: {},
        status: "PENDING",
      },
    });

    const removed = await cleanupTerminalOutboxEvents(now);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(
      await db.outboxEvent.findUnique({ where: { id: oldProcessed.id } }),
    ).toBeNull();
    expect(
      await db.outboxEvent.findUnique({ where: { id: recentFailed.id } }),
    ).not.toBeNull();
    expect(
      await db.outboxEvent.findUnique({ where: { id: stillPending.id } }),
    ).not.toBeNull();
    expect(await cleanupTerminalOutboxEvents(now)).toBe(0);

    await db.outboxEvent.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });
});

describe("purgeDeletedFileObjectStorage (P1E-4)", () => {
  it("purges the physical object for an old soft-deleted file, never touches the DB row, and preserves an active file", async () => {
    const db = createSystemClient();
    const setup = await setupTestTenant();
    const provider = getStorageProvider();
    const now = Date.now();

    const deletedKey = `p1e4/${randomUUID()}.txt`;
    await provider.put(deletedKey, Buffer.from("gone soon"));
    const deletedFile = await db.fileObject.create({
      data: {
        tenantId: setup.tenantId,
        storageKey: deletedKey,
        originalFilename: "gone.txt",
        mimeType: "text/plain",
        sizeBytes: 9,
        sha256: "x".repeat(64),
        uploadedByUserId: setup.adminUserId,
        status: "DELETED",
        deletedAt: new Date(now - 40 * 24 * 60 * 60 * 1000),
      },
    });

    const activeKey = `p1e4/${randomUUID()}.txt`;
    await provider.put(activeKey, Buffer.from("still here"));
    const activeFile = await db.fileObject.create({
      data: {
        tenantId: setup.tenantId,
        storageKey: activeKey,
        originalFilename: "active.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        sha256: "y".repeat(64),
        uploadedByUserId: setup.adminUserId,
        status: "ACTIVE",
      },
    });

    expect(await provider.exists(deletedKey)).toBe(true);
    const purged = await purgeDeletedFileObjectStorage(now);
    expect(purged).toBeGreaterThanOrEqual(1);

    // Storage object gone, DB row untouched (still exists, still DELETED).
    expect(await provider.exists(deletedKey)).toBe(false);
    const rowAfter = await db.fileObject.findUnique({ where: { id: deletedFile.id } });
    expect(rowAfter).not.toBeNull();
    expect(rowAfter?.status).toBe("DELETED");

    // Active file untouched entirely.
    expect(await provider.exists(activeKey)).toBe(true);
    expect(
      await db.fileObject.findUnique({ where: { id: activeFile.id } }),
    ).not.toBeNull();

    // Idempotent: re-running finds nothing new to purge for this file
    // (provider.delete is itself idempotent — see localProvider.ts).
    const secondRun = await purgeDeletedFileObjectStorage(now);
    expect(secondRun).toBe(0);

    await provider.delete(activeKey).catch(() => undefined);
    await db.fileObject.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });

  it("P1G-7: one file's failed physical purge does not abort or stall the rest of the same tenant's batch", async () => {
    const db = createSystemClient();
    const setup = await setupTestTenant();
    const provider = getStorageProvider();
    const now = Date.now();
    const oldEnough = new Date(now - 40 * 24 * 60 * 60 * 1000);

    // file1's storageKey is deliberately invalid (contains "..") —
    // LocalStorageProvider.resolveKey() rejects it synchronously, so
    // provider.delete() throws before any filesystem or DB write for this
    // row happens, exercising the SAME per-item failure path a real
    // physical-storage error would (permission denied, disk full, etc.)
    // without needing to fake a filesystem fault.
    const file1 = await db.fileObject.create({
      data: {
        tenantId: setup.tenantId,
        storageKey: "../escapes/root.txt",
        originalFilename: "file1.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        sha256: "a".repeat(64),
        uploadedByUserId: setup.adminUserId,
        status: "DELETED",
        deletedAt: oldEnough,
      },
    });

    const file2Key = `p1g7/${randomUUID()}.txt`;
    await provider.put(file2Key, Buffer.from("purge me too"));
    const file2 = await db.fileObject.create({
      data: {
        tenantId: setup.tenantId,
        storageKey: file2Key,
        originalFilename: "file2.txt",
        mimeType: "text/plain",
        sizeBytes: 12,
        sha256: "b".repeat(64),
        uploadedByUserId: setup.adminUserId,
        status: "DELETED",
        deletedAt: oldEnough,
      },
    });

    const purged = await purgeDeletedFileObjectStorage(now);
    // file2 purged successfully; file1 failed — exactly one success in
    // this batch, not zero (which is what a poisoned/aborted enclosing
    // transaction would have produced for the WHOLE tenant, including
    // file2 despite it never failing).
    expect(purged).toBe(1);

    const file1After = await db.fileObject.findUnique({ where: { id: file1.id } });
    expect(file1After?.storagePurgedAt).toBeNull();
    const file2After = await db.fileObject.findUnique({ where: { id: file2.id } });
    expect(file2After?.storagePurgedAt).not.toBeNull();
    expect(await provider.exists(file2Key)).toBe(false);

    // A later maintenance cycle retries file1 independently and succeeds
    // once its storage key is fixed to something valid — proving the
    // earlier failure didn't leave the transaction, or file1's own row, in
    // some permanently-broken state.
    const fixedKey = `p1g7/${randomUUID()}.txt`;
    await provider.put(fixedKey, Buffer.from("fixed"));
    await db.fileObject.update({
      where: { id: file1.id },
      data: { storageKey: fixedKey },
    });
    const secondRun = await purgeDeletedFileObjectStorage(now);
    expect(secondRun).toBe(1);
    const file1Retried = await db.fileObject.findUnique({ where: { id: file1.id } });
    expect(file1Retried?.storagePurgedAt).not.toBeNull();

    await db.fileObject.deleteMany({ where: { tenantId: setup.tenantId } });
    await cleanupTenant(setup.tenantId);
    await cleanupUser(setup.adminUserId);
  });
});
