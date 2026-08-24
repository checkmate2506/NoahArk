import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTenantContext } from "@noahark/db";
import {
  LocalStorageProvider,
  uploadFile,
  getFileForDownload,
  deleteFile,
} from "@noahark/files";
import {
  buildContext,
  setupTestTenant,
  cleanupTenant,
  cleanupUser,
  type TestTenantSetup,
} from "./testHelpers";

describe("file upload and attachment access (real Postgres + local storage)", () => {
  let setup: TestTenantSetup;
  let storageRoot: string;

  afterEach(async () => {
    if (setup) {
      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    }
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  it("uploads a file, sniffs its real content type, and links an attachment", async () => {
    setup = await setupTestTenant();
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-attach-test-"));
    const provider = new LocalStorageProvider(storageRoot);
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);

    // A minimal-but-real PNG (signature + IHDR chunk header — file-type
    // needs this much to positively identify the format, not just the
    // 8-byte signature) with a filename that LIES about the type —
    // sniffMimeType() must trust the bytes, not the client-supplied name.
    const pngMagic = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d, // IHDR chunk length
      0x49,
      0x48,
      0x44,
      0x52, // "IHDR"
      0x00,
      0x00,
      0x00,
      0x01, // width
      0x00,
      0x00,
      0x00,
      0x01, // height
      0x08,
      0x06,
      0x00,
      0x00,
      0x00, // bit depth / colour type / etc.
    ]);

    const file = await withTenantContext(
      {
        tenantId: setup.tenantId,
        legalEntityIds: ctx.legalEntityIds,
        userId: ctx.userId,
      },
      (tx) =>
        uploadFile(tx, provider, ctx, {
          originalFilename: "totally-not-an-image.txt",
          buffer: pngMagic,
          ownerEntityType: "demo.approval_subject",
          ownerEntityId: "test-owner",
        }),
    );

    expect(file.mimeType).toBe("image/png");
    expect(await provider.exists(file.storageKey)).toBe(true);
  });

  it("rejects downloading a file whose legal entity the caller has no access to", async () => {
    setup = await setupTestTenant();
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-attach-test-"));
    const provider = new LocalStorageProvider(storageRoot);

    const { createTestLegalEntity } = await import("./testHelpers.js");
    const legalEntity = await createTestLegalEntity(setup.tenantId, "SG");
    // Deliberately do NOT grant the admin access to this legal entity.
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    expect(ctx.legalEntityIds.has(legalEntity.id)).toBe(false);

    // Upload happens via a context that DOES claim the entity (simulating a
    // file created by someone else with real access) — we then verify the
    // no-access user cannot read it back.
    const db = (await import("@noahark/db/system")).createSystemClient();
    const fileObject = await db.fileObject.create({
      data: {
        tenantId: setup.tenantId,
        legalEntityId: legalEntity.id,
        storageKey: `tenant/${setup.tenantId}/${legalEntity.id}/secret.txt`,
        originalFilename: "secret.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        sha256: "abc",
        uploadedByUserId: setup.adminUserId,
      },
    });

    // RLS on file_object (tenant + legal-entity scoped — see the RLS
    // migration §5) hides this row entirely before the query even reaches
    // getFileForDownload's own explicit legal-entity check, so the observed
    // failure is NotFoundError ("File not found"), not the more specific
    // ForbiddenError message that check would produce if RLS were ever
    // bypassed. Both are secure outcomes; this is defense-in-depth working
    // as intended — the primary layer (RLS) catches it first.
    await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: ctx.legalEntityIds },
      async (tx) => {
        await expect(getFileForDownload(tx, ctx, fileObject.id)).rejects.toThrow(
          /not found/i,
        );
      },
    );

    await provider.delete(fileObject.storageKey).catch(() => undefined);
  });

  it("soft-deletes a file (row marked DELETED, not hard-removed)", async () => {
    setup = await setupTestTenant();
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-attach-test-"));
    const provider = new LocalStorageProvider(storageRoot);
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);

    const file = await withTenantContext(
      {
        tenantId: setup.tenantId,
        legalEntityIds: ctx.legalEntityIds,
        userId: ctx.userId,
      },
      (tx) =>
        uploadFile(tx, provider, ctx, {
          originalFilename: "note.txt",
          buffer: Buffer.from("hello world"),
          ownerEntityType: "demo.approval_subject",
          ownerEntityId: "test-owner",
        }),
    );

    await withTenantContext(
      {
        tenantId: setup.tenantId,
        legalEntityIds: ctx.legalEntityIds,
        userId: ctx.userId,
      },
      (tx) => deleteFile(tx, ctx, file.id),
    );

    await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: ctx.legalEntityIds },
      async (tx) => {
        await expect(getFileForDownload(tx, ctx, file.id)).rejects.toThrow(/not found/i);
      },
    );

    // The physical object is still on disk — Phase 1 does not hard-delete.
    expect(await provider.exists(file.storageKey)).toBe(true);
  });
});
