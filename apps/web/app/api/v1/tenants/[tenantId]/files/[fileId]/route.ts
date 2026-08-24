import { z } from "zod";
import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import {
  getSignedDownloadUrl,
  deleteFile,
  quarantineFile,
  revokeFileAccess,
} from "@/lib/services/fileServiceWrapper";

type Params = { tenantId: string; fileId: string };

export const GET = apiHandler<Params>(async (req, requestId, { tenantId, fileId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const { url, expiresAt, file } = await getSignedDownloadUrl(ctx, fileId);
  return jsonOk({ url, expiresAt, file });
});

export const DELETE = apiHandler<Params>(async (req, requestId, { tenantId, fileId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  const file = await deleteFile(ctx, fileId);
  return jsonOk({ file });
});

const PatchFileSchema = z.object({ action: z.enum(["quarantine", "revoke"]) });

/** F-15 (Phase 1B.1): explicit quarantine/revoke actions — both immediately
 * invalidate every previously-issued signed URL for the file (see
 * quarantineFile/revokeFileAccess in fileServiceWrapper.ts). */
export const PATCH = apiHandler<Params>(async (req, requestId, { tenantId, fileId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);
  // N-2 (Phase 1D): was PatchFileSchema.parse(...), which throws a raw
  // ZodError — apiHandler's catch-all maps any non-AppError to 500
  // INTERNAL_ERROR, silently violating this route's own documented 422
  // VALIDATION_FAILED contract (openapi.yaml) for something as ordinary as
  // a missing/invalid `action`. safeParse + ValidationError matches every
  // other route in this codebase (see settings/roles/legal-entities routes).
  const parsed = PatchFileSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw new ValidationError("Invalid request body", { issues: parsed.error.issues });
  }
  const body = parsed.data;
  const file =
    body.action === "quarantine"
      ? await quarantineFile(ctx, fileId)
      : await revokeFileAccess(ctx, fileId);
  return jsonOk({ file });
});
