import { NextResponse } from "next/server";
import { NotFoundError, ValidationError } from "@noahark/core";
import { apiHandler } from "@/lib/apiHandler";
import { deliverSignedFile } from "@/lib/services/fileServiceWrapper";

type Params = { fileId: string };

/**
 * Serves a local-provider file given a valid, fully-bound HMAC signature —
 * the signed URL itself IS the authorization artifact (minted only for an
 * already-authorized user by getSignedDownloadUrl). This route performs no
 * session/tenant lookup of its own; that check already happened when the
 * URL was signed. See deliverSignedFile (F-15, Phase 1B.1) for the full
 * chain of checks — signature validity, expiry, current file status,
 * revocation, and version match — that replaced the old "storage key +
 * expiry only" design.
 */
export const GET = apiHandler<Params>(async (req, _requestId, { fileId }) => {
  const url = new URL(req.url);
  const storageKey = url.searchParams.get("sk");
  const versionRaw = url.searchParams.get("v");
  const expiresAtRaw = url.searchParams.get("exp");
  const signature = url.searchParams.get("sig");
  if (!fileId || !storageKey || !versionRaw || !expiresAtRaw || !signature) {
    throw new ValidationError("Missing signature");
  }

  const version = Number(versionRaw);
  const expiresAt = Number(expiresAtRaw);
  if (!Number.isFinite(version) || !Number.isFinite(expiresAt)) {
    throw new ValidationError("Invalid signature");
  }

  const buffer = await deliverSignedFile({
    fileId,
    storageKey,
    version,
    expiresAt,
    signature,
  }).catch(() => {
    throw new NotFoundError("File");
  });

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": "attachment",
      "cache-control": "private, max-age=0, no-store",
    },
  });
});
