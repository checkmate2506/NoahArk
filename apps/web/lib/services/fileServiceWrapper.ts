import { createHmac } from "node:crypto";
import { z } from "zod";
import { type AccessContext, NotFoundError } from "@noahark/core";
import { withTenantContext, withSignedFileDeliveryContext } from "@noahark/db";
import {
  LocalStorageProvider,
  uploadFile as coreUploadFile,
  getFileForDownload,
  deleteFile as coreDeleteFile,
  quarantineFile as coreQuarantineFile,
  revokeFileAccess as coreRevokeFileAccess,
  replaceFileContent as coreReplaceFileContent,
  signFileAccess,
  verifyFileAccess,
  type SignedFileAccessInput,
} from "@noahark/files";
import { loadEnv } from "@noahark/config";
import { AUDIT_ACTIONS } from "@noahark/audit";
import { writeAuditEvent } from "./auditService";
import { assertModuleEnabledTx, MODULE_KEYS } from "./entitlementService";

let storageProvider: LocalStorageProvider | undefined;
export function getStorageProvider(): LocalStorageProvider {
  if (!storageProvider)
    storageProvider = new LocalStorageProvider(loadEnv().FILES_LOCAL_ROOT);
  return storageProvider;
}

/** Derives a purpose-specific signing key from AUTH_SECRET via HMAC (key
 * separation) rather than introducing a second required secret env var for
 * a single-secret Phase 1 deployment. */
function getFileSigningSecret(): string {
  return createHmac("sha256", loadEnv().AUTH_SECRET)
    .update("noahark:file-signing")
    .digest("hex");
}

export const UploadFileSchema = z.object({
  ownerEntityType: z.string().min(1),
  ownerEntityId: z.string().min(1),
  legalEntityId: z.string().min(1).nullable().default(null),
});

export async function uploadFile(
  ctx: AccessContext,
  input: z.infer<typeof UploadFileSchema>,
  file: { originalFilename: string; buffer: Buffer },
) {
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      // F-17 (Phase 1B): checked in the SAME transaction as the write below.
      await assertModuleEnabledTx(tx, ctx.tenantId, MODULE_KEYS.FILES);

      const fileObject = await coreUploadFile(tx, getStorageProvider(), ctx, {
        originalFilename: file.originalFilename,
        buffer: file.buffer,
        legalEntityId: input.legalEntityId,
        ownerEntityType: input.ownerEntityType,
        ownerEntityId: input.ownerEntityId,
      });

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        legalEntityId: input.legalEntityId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.FILE_UPLOADED,
        entityType: "file_object",
        entityId: fileObject.id,
        afterData: {
          originalFilename: fileObject.originalFilename,
          mimeType: fileObject.mimeType,
          sizeBytes: fileObject.sizeBytes,
        },
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return fileObject;
    },
  );
}

/** Returns a short-lived signed download URL rather than the file bytes
 * directly, so the storage key is never exposed and access expires.
 *
 * F-15 (Phase 1B.1): the signed payload now binds fileId/storageKey/version/
 * operation (not just storageKey/expiry — see @noahark/files/signedUrl.ts),
 * and the URL routes by fileId so the delivery route can load the exact
 * FileObject row rather than trusting the storage key alone. */
export async function getSignedDownloadUrl(ctx: AccessContext, fileId: string) {
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds },
    async (tx) => {
      const file = await getFileForDownload(tx, ctx, fileId);
      const signInput: SignedFileAccessInput = {
        fileId: file.id,
        storageKey: file.storageKey,
        version: file.version,
        operation: "download",
      };
      const { expiresAt, signature } = signFileAccess(
        signInput,
        getFileSigningSecret(),
        300,
      );
      const url =
        `/api/v1/files/local/${encodeURIComponent(file.id)}` +
        `?sk=${encodeURIComponent(file.storageKey)}&v=${file.version}&exp=${expiresAt}&sig=${signature}`;
      return { url, expiresAt, file };
    },
  );
}

export async function deleteFile(ctx: AccessContext, fileId: string) {
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const file = await coreDeleteFile(tx, ctx, fileId);

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        legalEntityId: file.legalEntityId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.FILE_DELETED,
        entityType: "file_object",
        entityId: fileId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return file;
    },
  );
}

/** F-15 (Phase 1B.1): quarantines a file, immediately revoking every
 * outstanding signed URL for it (see quarantineFile in @noahark/files). */
export async function quarantineFile(ctx: AccessContext, fileId: string) {
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const file = await coreQuarantineFile(tx, ctx, fileId);

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        legalEntityId: file.legalEntityId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.FILE_QUARANTINED,
        entityType: "file_object",
        entityId: fileId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return file;
    },
  );
}

/** F-15 (Phase 1B.1): explicit revocation of a file's outstanding signed
 * URLs without deleting or quarantining the file itself. */
export async function revokeFileAccess(ctx: AccessContext, fileId: string) {
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const file = await coreRevokeFileAccess(tx, ctx, fileId);

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        legalEntityId: file.legalEntityId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.FILE_ACCESS_REVOKED,
        entityType: "file_object",
        entityId: fileId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return file;
    },
  );
}

/** F-15 (Phase 1B.1): re-uploads a file's content in place (same
 * FileObject id), storing the new bytes under a new storage key and
 * bumping `version` — immediately revoking every previously-issued signed
 * URL for this file. */
export async function replaceFileContent(
  ctx: AccessContext,
  fileId: string,
  file: { buffer: Buffer },
) {
  return withTenantContext(
    { tenantId: ctx.tenantId, legalEntityIds: ctx.legalEntityIds, userId: ctx.userId },
    async (tx) => {
      const updated = await coreReplaceFileContent(
        tx,
        getStorageProvider(),
        ctx,
        fileId,
        {
          buffer: file.buffer,
        },
      );

      await writeAuditEvent(tx, {
        tenantId: ctx.tenantId,
        legalEntityId: updated.legalEntityId,
        actorUserId: ctx.userId,
        action: AUDIT_ACTIONS.FILE_CONTENT_REPLACED,
        entityType: "file_object",
        entityId: fileId,
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });

      return updated;
    },
  );
}

export interface SignedFileDeliveryInput {
  fileId: string;
  storageKey: string;
  version: number;
  expiresAt: number;
  signature: string;
}

/**
 * Serves a signed local-file request (used by the unauthenticated
 * `/api/v1/files/local/[fileId]` route). F-15 (Phase 1B.1) redesign — this
 * is the "narrowly scoped delivery service" the finding required:
 *
 * 1. Constant-time signature verification over the FULL bound tuple
 *    (fileId, storageKey, version, operation, expiresAt) — no DB call yet,
 *    so a forged/tampered request is rejected before ever touching the
 *    database.
 * 2. Only once the signature is valid, the exact FileObject row is loaded
 *    by ID via `withSignedFileDeliveryContext` — a dedicated RLS carve-out
 *    scoped to exactly that one row (see packages/db/src/client.ts), not a
 *    privileged/BYPASSRLS client.
 * 3. The file's CURRENT `status`, `revokedAt` and `version` are checked
 *    against the database, not just "does the storage object still exist
 *    on disk" — soft deletion, quarantine, content replacement and
 *    explicit revocation all bump `version` and/or set fields this check
 *    reads, so a previously-issued signed URL fails immediately after any
 *    of those, even though its own `exp` TTL hasn't elapsed yet.
 * 4. Bytes are read using the storage key loaded from the DATABASE, never
 *    the caller-supplied query-string value — the query-string `sk` is
 *    only ever used as part of the signed payload for step 1.
 */
export async function deliverSignedFile(input: SignedFileDeliveryInput): Promise<Buffer> {
  const signInput: SignedFileAccessInput = {
    fileId: input.fileId,
    storageKey: input.storageKey,
    version: input.version,
    operation: "download",
  };

  if (
    !verifyFileAccess(signInput, input.expiresAt, input.signature, getFileSigningSecret())
  ) {
    throw new NotFoundError("File");
  }

  const file = await withSignedFileDeliveryContext(input.fileId, (tx) =>
    tx.fileObject.findUnique({
      where: { id: input.fileId },
      select: {
        id: true,
        storageKey: true,
        status: true,
        version: true,
        revokedAt: true,
      },
    }),
  );

  if (
    !file ||
    file.status !== "ACTIVE" ||
    file.revokedAt !== null ||
    file.version !== input.version ||
    file.storageKey !== input.storageKey
  ) {
    throw new NotFoundError("File");
  }

  return getStorageProvider().get(file.storageKey);
}
