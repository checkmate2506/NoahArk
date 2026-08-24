import { createHash, randomUUID } from "node:crypto";
import { authorize, PERMISSIONS } from "@noahark/authz";
import { type AccessContext, NotFoundError, ValidationError } from "@noahark/core";
import type { TransactionClient } from "@noahark/db";
import type { StorageProvider } from "./storageProvider";
import { sniffMimeType } from "./mimeSniff";

const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25 MiB — Phase 1 foundation default

export interface UploadFileInput {
  originalFilename: string;
  buffer: Buffer;
  legalEntityId?: string | null;
  ownerEntityType: string;
  ownerEntityId: string;
}

/**
 * Uploads a file: sniffs its real content type (never trusting the
 * client), hashes it, stores it under a random, tenant-namespaced key, and
 * records both a FileObject and its owning Attachment in the same
 * transaction as the storage write's caller.
 *
 * PRODUCTION MALWARE SCANNING IS NOT IMPLEMENTED IN PHASE 1. The
 * integration point is here, immediately after `sniffMimeType` and before
 * `storage.put` — a later phase should call a scanning provider on
 * `input.buffer` and reject the upload (throwing before any write happens)
 * rather than storing-then-scanning. No placeholder/no-op scan function is
 * included, so this gap cannot be mistaken for real protection.
 */
export async function uploadFile(
  tx: TransactionClient,
  storage: StorageProvider,
  ctx: AccessContext,
  input: UploadFileInput,
) {
  authorize(ctx, {
    permission: PERMISSIONS.FILE_UPLOAD,
    legalEntityId: input.legalEntityId ?? null,
  });

  if (input.buffer.byteLength === 0) {
    throw new ValidationError("Cannot upload an empty file");
  }
  if (input.buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new ValidationError("File exceeds the maximum allowed size", {
      maxBytes: MAX_FILE_SIZE_BYTES,
    });
  }

  const mimeType = await sniffMimeType(input.buffer);
  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const safeName = sanitizeFilename(input.originalFilename);
  const storageKey = `tenant/${ctx.tenantId}/${input.legalEntityId ?? "shared"}/${randomUUID()}-${safeName}`;

  // --- malware-scan integration point would go here, before storage.put ---

  await storage.put(storageKey, input.buffer);

  const fileObject = await tx.fileObject.create({
    data: {
      tenantId: ctx.tenantId,
      legalEntityId: input.legalEntityId ?? null,
      storageKey,
      originalFilename: input.originalFilename,
      mimeType,
      sizeBytes: input.buffer.byteLength,
      sha256,
      uploadedByUserId: ctx.userId,
    },
  });

  await tx.attachment.create({
    data: {
      tenantId: ctx.tenantId,
      fileObjectId: fileObject.id,
      ownerEntityType: input.ownerEntityType,
      ownerEntityId: input.ownerEntityId,
      createdByUserId: ctx.userId,
    },
  });

  return fileObject;
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]/g, "_");
  return cleaned.slice(-100) || "file";
}

/**
 * Loads a file for download. `tx` must come from `withTenantContext`, so
 * RLS already restricts the query to the caller's tenant — the permission
 * check below is deliberate defense-in-depth on top of that, not a
 * substitute for it.
 *
 * F-13 (Phase 1B): the file is loaded FIRST and its own `legalEntityId` is
 * passed into `authorize()`, so the FILE_READ permission itself is
 * evaluated against the file's legal entity (or tenant-wide, for a
 * genuinely tenant-shared file with a null legalEntityId) — not always
 * tenant-wide regardless of the file. The previous version called
 * `authorize(ctx, { permission: FILE_READ })` with no legalEntityId, then
 * SEPARATELY checked `ctx.legalEntityIds.has(...)` for access; that meant a
 * user holding FILE_READ only via an entity-scoped role (not tenant-wide)
 * was incorrectly denied for files in exactly the entity they were granted
 * — the permission and access checks were evaluating two different scopes.
 * `authorize()`'s own legal-entity-access check (run before the permission
 * check) now does that job in one call.
 */
/**
 * F-15 (Phase 1B.1): also rejects a QUARANTINED file and a file with a
 * non-null `revokedAt` — this function is used both to authorize serving
 * an ALREADY-signed URL and to authorize MINTING a new one, so both paths
 * share the same "is this file currently servable at all" gate. A revoked
 * file cannot have new URLs minted for it either — revocation would be
 * pointless if a caller could simply request a fresh one immediately
 * after.
 */
export async function getFileForDownload(
  tx: TransactionClient,
  ctx: AccessContext,
  fileId: string,
) {
  const file = await tx.fileObject.findUnique({ where: { id: fileId } });
  if (!file || file.status !== "ACTIVE" || file.revokedAt) {
    throw new NotFoundError("File");
  }

  authorize(ctx, {
    permission: PERMISSIONS.FILE_READ,
    legalEntityId: file.legalEntityId,
  });

  return file;
}

/** Soft-deletes the FileObject row. The physical object is retained in
 * Phase 1 (no hard delete of storage content) so recovery/audit stays
 * possible; physical retention/cleanup is a later-phase job.
 *
 * F-13 (Phase 1B): same fix as getFileForDownload — the permission check
 * is evaluated against the file's own legal entity.
 *
 * F-15 (Phase 1B.1): also bumps `version` — every previously-issued signed
 * URL for this file (which bound the OLD version into its signature) fails
 * verification immediately, not just once its own TTL happens to expire.
 */
export async function deleteFile(
  tx: TransactionClient,
  ctx: AccessContext,
  fileId: string,
) {
  const file = await tx.fileObject.findUnique({ where: { id: fileId } });
  if (!file || file.status === "DELETED") {
    throw new NotFoundError("File");
  }

  authorize(ctx, {
    permission: PERMISSIONS.FILE_DELETE,
    legalEntityId: file.legalEntityId,
  });

  return tx.fileObject.update({
    where: { id: fileId },
    data: { status: "DELETED", deletedAt: new Date(), version: { increment: 1 } },
  });
}

/**
 * F-15 (Phase 1B.1): quarantines a file (e.g. a future malware-scanning
 * integration flagging it after the fact) — distinct from delete, since a
 * quarantined file may later be cleared by an operator, whereas delete is
 * a one-way lifecycle transition in Phase 1. Bumps `version`, immediately
 * revoking every outstanding signed URL.
 */
export async function quarantineFile(
  tx: TransactionClient,
  ctx: AccessContext,
  fileId: string,
) {
  const file = await tx.fileObject.findUnique({ where: { id: fileId } });
  if (!file || file.status === "DELETED") {
    throw new NotFoundError("File");
  }

  authorize(ctx, {
    permission: PERMISSIONS.FILE_ADMINISTER,
    legalEntityId: file.legalEntityId,
  });

  return tx.fileObject.update({
    where: { id: fileId },
    data: { status: "QUARANTINED", version: { increment: 1 } },
  });
}

/**
 * F-15 (Phase 1B.1): explicit revocation — invalidates every outstanding
 * signed URL for this file WITHOUT deleting or quarantining it (e.g. a
 * suspected leak of a specific link; the file itself remains fine and a
 * fresh URL can be minted immediately after, unlike delete/quarantine).
 * Sets `revokedAt` (so `getFileForDownload` also refuses to mint a new URL
 * until a future "un-revoke" action, not built in Phase 1) AND bumps
 * `version` (so even an in-flight request racing this call still fails).
 */
export async function revokeFileAccess(
  tx: TransactionClient,
  ctx: AccessContext,
  fileId: string,
) {
  const file = await tx.fileObject.findUnique({ where: { id: fileId } });
  if (!file || file.status === "DELETED") {
    throw new NotFoundError("File");
  }

  authorize(ctx, {
    permission: PERMISSIONS.FILE_ADMINISTER,
    legalEntityId: file.legalEntityId,
  });

  return tx.fileObject.update({
    where: { id: fileId },
    data: { revokedAt: new Date(), version: { increment: 1 } },
  });
}

export interface ReplaceFileContentInput {
  buffer: Buffer;
}

/**
 * F-15 (Phase 1B.1): replaces a FileObject's stored content in place
 * (same id, same attachment linkage) — e.g. re-uploading a corrected
 * version of a document. Stores the new content under a NEW storage key
 * (the old physical object is retained, same soft-deletion-style retention
 * as deleteFile, not overwritten in place) and bumps `version`, which
 * immediately revokes every previously-issued signed URL — a signature
 * minted for the old content must never continue to resolve to the new
 * content, and must never keep resolving to the old content once a signed
 * URL for it is reissued at the new version.
 */
export async function replaceFileContent(
  tx: TransactionClient,
  storage: StorageProvider,
  ctx: AccessContext,
  fileId: string,
  input: ReplaceFileContentInput,
) {
  const file = await tx.fileObject.findUnique({ where: { id: fileId } });
  if (!file || file.status === "DELETED") {
    throw new NotFoundError("File");
  }

  authorize(ctx, {
    permission: PERMISSIONS.FILE_UPLOAD,
    legalEntityId: file.legalEntityId,
  });

  if (input.buffer.byteLength === 0) {
    throw new ValidationError("Cannot upload an empty file");
  }
  if (input.buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new ValidationError("File exceeds the maximum allowed size", {
      maxBytes: MAX_FILE_SIZE_BYTES,
    });
  }

  const mimeType = await sniffMimeType(input.buffer);
  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const safeName = sanitizeFilename(file.originalFilename);
  const storageKey = `tenant/${ctx.tenantId}/${file.legalEntityId ?? "shared"}/${randomUUID()}-${safeName}`;

  await storage.put(storageKey, input.buffer);

  return tx.fileObject.update({
    where: { id: fileId },
    data: {
      storageKey,
      mimeType,
      sizeBytes: input.buffer.byteLength,
      sha256,
      version: { increment: 1 },
    },
  });
}
