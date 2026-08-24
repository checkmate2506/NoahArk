import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageProvider } from "@noahark/files";
import {
  uploadFile,
  getSignedDownloadUrl,
  deleteFile,
  quarantineFile,
  revokeFileAccess,
  replaceFileContent,
  deliverSignedFile,
  type SignedFileDeliveryInput,
} from "@/lib/services/fileServiceWrapper";
import {
  buildContext,
  setupTestTenant,
  cleanupTenant,
  cleanupUser,
  createTestLegalEntity,
  type TestTenantSetup,
} from "./testHelpers";

/**
 * F-15 (Phase 1B.1): the redesigned signed-download capability. Exercises
 * the actual production entry point (deliverSignedFile — the same function
 * the unauthenticated `/api/v1/files/local/[fileId]` route calls), not a
 * lower-level primitive, so these tests prove the FULL chain: signature
 * binding, expiry, current-state checks against the real FileObject row,
 * and cross-tenant/cross-legal-entity isolation via real RLS.
 */
describe("signed file delivery (F-15, real Postgres + local storage)", () => {
  let setups: TestTenantSetup[] = [];
  let storageRoot: string;

  afterEach(async () => {
    for (const setup of setups) {
      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
      // Files uploaded through the real fileServiceWrapper land under the
      // app's configured FILES_LOCAL_ROOT (not the throwaway storageRoot
      // below, which is only used for the direct-DB-row fixture test) —
      // clean those up too so repeated runs don't accumulate disk state.
      await rm(join(process.cwd(), ".data", "files", "tenant", setup.tenantId), {
        recursive: true,
        force: true,
      });
    }
    setups = [];
    if (storageRoot) await rm(storageRoot, { recursive: true, force: true });
  });

  async function uploadTestFile(setup: TestTenantSetup, content = "hello world") {
    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    const file = await uploadFile(
      ctx,
      {
        ownerEntityType: "demo.approval_subject",
        ownerEntityId: "test-owner",
        legalEntityId: null,
      },
      { originalFilename: "note.txt", buffer: Buffer.from(content) },
    );
    return { ctx, file };
  }

  async function newSetup() {
    const setup = await setupTestTenant();
    setups.push(setup);
    return setup;
  }

  it("serves a validly signed URL", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-sfd-test-"));
    const setup = await newSetup();
    const { ctx, file } = await uploadTestFile(setup);
    const { url } = await getSignedDownloadUrl(ctx, file.id);
    const input = parseSignedUrl(url);

    const buffer = await deliverSignedFile(input);
    expect(buffer.toString("utf8")).toBe("hello world");
  });

  it("rejects a signature with a tampered fileId", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-sfd-test-"));
    const setup = await newSetup();
    const { ctx, file } = await uploadTestFile(setup);
    const { url } = await getSignedDownloadUrl(ctx, file.id);
    const input = parseSignedUrl(url);

    await expect(
      deliverSignedFile({ ...input, fileId: "not-the-real-id" }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects a signature with a tampered storage key", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-sfd-test-"));
    const setup = await newSetup();
    const { ctx, file } = await uploadTestFile(setup);
    const { url } = await getSignedDownloadUrl(ctx, file.id);
    const input = parseSignedUrl(url);

    await expect(
      deliverSignedFile({ ...input, storageKey: `${input.storageKey}-tampered` }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects a tampered/extended expiry", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-sfd-test-"));
    const setup = await newSetup();
    const { ctx, file } = await uploadTestFile(setup);
    const { url } = await getSignedDownloadUrl(ctx, file.id);
    const input = parseSignedUrl(url);

    await expect(
      deliverSignedFile({ ...input, expiresAt: input.expiresAt + 60_000 }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects a tampered version", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-sfd-test-"));
    const setup = await newSetup();
    const { ctx, file } = await uploadTestFile(setup);
    const { url } = await getSignedDownloadUrl(ctx, file.id);
    const input = parseSignedUrl(url);

    await expect(
      deliverSignedFile({ ...input, version: input.version + 1 }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects an expired URL", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-sfd-test-"));
    const setup = await newSetup();
    const { ctx, file } = await uploadTestFile(setup);
    const { url } = await getSignedDownloadUrl(ctx, file.id);
    const input = parseSignedUrl(url);

    await expect(
      deliverSignedFile({ ...input, expiresAt: Date.now() - 1000 }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects a URL for a deleted file", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-sfd-test-"));
    const setup = await newSetup();
    const { ctx, file } = await uploadTestFile(setup);
    const { url } = await getSignedDownloadUrl(ctx, file.id);
    const input = parseSignedUrl(url);

    await deleteFile(ctx, file.id);

    await expect(deliverSignedFile(input)).rejects.toThrow(/not found/i);
  });

  it("rejects a URL for a quarantined file", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-sfd-test-"));
    const setup = await newSetup();
    const { ctx, file } = await uploadTestFile(setup);
    const { url } = await getSignedDownloadUrl(ctx, file.id);
    const input = parseSignedUrl(url);

    await quarantineFile(ctx, file.id);

    await expect(deliverSignedFile(input)).rejects.toThrow(/not found/i);
  });

  it("rejects a URL for a file whose content has been replaced, but a freshly minted URL for the new content works", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-sfd-test-"));
    const setup = await newSetup();
    const { ctx, file } = await uploadTestFile(setup, "original content");
    const { url: oldUrl } = await getSignedDownloadUrl(ctx, file.id);
    const oldInput = parseSignedUrl(oldUrl);

    await replaceFileContent(ctx, file.id, { buffer: Buffer.from("replaced content") });

    await expect(deliverSignedFile(oldInput)).rejects.toThrow(/not found/i);

    const { url: newUrl } = await getSignedDownloadUrl(ctx, file.id);
    const newInput = parseSignedUrl(newUrl);
    const buffer = await deliverSignedFile(newInput);
    expect(buffer.toString("utf8")).toBe("replaced content");
  });

  it("rejects a URL after explicit revocation, and minting a fresh URL immediately after also fails", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-sfd-test-"));
    const setup = await newSetup();
    const { ctx, file } = await uploadTestFile(setup);
    const { url } = await getSignedDownloadUrl(ctx, file.id);
    const input = parseSignedUrl(url);

    await revokeFileAccess(ctx, file.id);

    await expect(deliverSignedFile(input)).rejects.toThrow(/not found/i);
    // Revocation blocks minting a new URL too — see getFileForDownload's
    // revokedAt check — a revoked file cannot simply be re-signed around.
    await expect(getSignedDownloadUrl(ctx, file.id)).rejects.toThrow(/not found/i);
  });

  it("replay after revocation: an old URL captured before revocation never becomes valid again", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-sfd-test-"));
    const setup = await newSetup();
    const { ctx, file } = await uploadTestFile(setup);
    const { url } = await getSignedDownloadUrl(ctx, file.id);
    const input = parseSignedUrl(url);

    // Prove it worked BEFORE revocation.
    await expect(deliverSignedFile(input)).resolves.toBeInstanceOf(Buffer);

    await revokeFileAccess(ctx, file.id);

    // Replaying the exact same (still cryptographically valid, unexpired)
    // signature after revocation must fail — state, not just signature
    // validity, gates delivery.
    await expect(deliverSignedFile(input)).rejects.toThrow(/not found/i);
  });

  it("rejects a URL minted in one tenant when delivered against a file id from another tenant", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-sfd-test-"));
    const setupA = await newSetup();
    const setupB = await newSetup();
    const { file: fileB } = await uploadTestFile(setupB, "tenant B secret");
    const ctxA = await buildContext(setupA.adminUserId, setupA.tenantId);

    // ctxA has no access to fileB's tenant at all — minting must fail via
    // RLS before a signature is ever produced.
    await expect(getSignedDownloadUrl(ctxA, fileB.id)).rejects.toThrow(/not found/i);
  });

  it("rejects a URL for a file belonging to a legal entity the caller has no access to", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-sfd-test-"));
    const setup = await newSetup();
    const legalEntity = await createTestLegalEntity(setup.tenantId, "MY");
    const provider = new LocalStorageProvider(storageRoot);

    // Uploaded via a system-privileged context standing in for a different
    // user who DOES have access to this legal entity.
    const db = (await import("@noahark/db/system")).createSystemClient();
    const fileObject = await db.fileObject.create({
      data: {
        tenantId: setup.tenantId,
        legalEntityId: legalEntity.id,
        storageKey: `tenant/${setup.tenantId}/${legalEntity.id}/entity-secret.txt`,
        originalFilename: "entity-secret.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        sha256: "abc",
        uploadedByUserId: setup.adminUserId,
      },
    });

    const ctx = await buildContext(setup.adminUserId, setup.tenantId);
    expect(ctx.legalEntityIds.has(legalEntity.id)).toBe(false);

    await expect(getSignedDownloadUrl(ctx, fileObject.id)).rejects.toThrow(/not found/i);
    await provider.delete(fileObject.storageKey).catch(() => undefined);
  });

  it("rejects a malformed (wrong-length) signature without throwing an unhandled exception", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-sfd-test-"));
    const setup = await newSetup();
    const { ctx, file } = await uploadTestFile(setup);
    const { url } = await getSignedDownloadUrl(ctx, file.id);
    const input = parseSignedUrl(url);

    await expect(deliverSignedFile({ ...input, signature: "ab" })).rejects.toThrow(
      /not found/i,
    );
    await expect(deliverSignedFile({ ...input, signature: "" })).rejects.toThrow(
      /not found/i,
    );
    await expect(
      deliverSignedFile({ ...input, signature: "not-hex-characters-!!" }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects malformed/non-finite numeric input without throwing", async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "noahark-sfd-test-"));
    const setup = await newSetup();
    const { ctx, file } = await uploadTestFile(setup);
    const { url } = await getSignedDownloadUrl(ctx, file.id);
    const input = parseSignedUrl(url);

    await expect(deliverSignedFile({ ...input, expiresAt: Number.NaN })).rejects.toThrow(
      /not found/i,
    );
  });
});

function parseSignedUrl(url: string): SignedFileDeliveryInput {
  const [pathPart, queryPart] = url.split("?");
  const fileId = decodeURIComponent(pathPart!.split("/").pop()!);
  const params = new URLSearchParams(queryPart);
  return {
    fileId,
    storageKey: decodeURIComponent(params.get("sk")!),
    version: Number(params.get("v")),
    expiresAt: Number(params.get("exp")),
    signature: params.get("sig")!,
  };
}
