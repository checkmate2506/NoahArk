import type { NextResponse } from "next/server";
import {
  ForbiddenError,
  ValidationError,
  assertTrustedContext,
  type AccessContext,
} from "@noahark/core";
import { authorize, type PermissionKey } from "@noahark/authz";
import { apiHandler } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import { enforceTenantWriteRateLimit } from "@/lib/api/apiRateLimit";

export type TenantRouteParams = { tenantId: string };

export type TenantRouteHandler<TParams extends TenantRouteParams> = (
  req: Request,
  requestId: string,
  params: TParams,
  ctx: AccessContext,
) => Promise<NextResponse>;

export type LegalEntityIdFrom<TParams extends TenantRouteParams> = (
  req: Request,
  params: TParams,
) => Promise<string | null> | string | null;

export interface TenantBoundRouteConfig<
  TParams extends TenantRouteParams = TenantRouteParams,
> {
  permission: PermissionKey;
  handler: TenantRouteHandler<TParams>;
  legalEntityIdFrom?: LegalEntityIdFrom<TParams>;
}

const READ_GET_METHODS = new Set(["GET"]);
const READ_POST_METHODS = new Set(["POST"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH"]);

type BoundKind = "read-get" | "read-post" | "write";

function assertBoundConfig<TParams extends TenantRouteParams>(
  config: TenantBoundRouteConfig<TParams>,
  constructorName: string,
): void {
  if (config.permission == null) {
    throw new Error(`${constructorName} requires an exact permission key`);
  }
  if (typeof config.handler !== "function") {
    throw new Error(`${constructorName} requires a handler`);
  }
}

/**
 * Private shared implementation. Not exported — callers must pick a
 * method-bound constructor so a mutating route cannot be labelled "read".
 */
function bindTenantRoute<TParams extends TenantRouteParams>(
  kind: BoundKind,
  allowedMethods: ReadonlySet<string>,
  constructorName: string,
  config: TenantBoundRouteConfig<TParams>,
) {
  assertBoundConfig(config, constructorName);
  const consumeWriteAllowance = kind === "write";
  return apiHandler<TParams>(async (req, requestId, params) => {
    if (!allowedMethods.has(req.method)) {
      throw new ForbiddenError("HTTP method is not allowed for this route");
    }

    const tenantId = params.tenantId;
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new ValidationError("Invalid tenant id");
    }

    const ctx = await resolveTenantContext(req, requestId, tenantId);
    assertTrustedContext(ctx);

    let legalEntityId: string | null = null;
    if (config.legalEntityIdFrom) {
      const resolved = await config.legalEntityIdFrom(req.clone(), params);
      legalEntityId = resolved ?? null;
    }

    authorize(ctx, { permission: config.permission, legalEntityId });

    if (consumeWriteAllowance) {
      await enforceTenantWriteRateLimit(ctx);
    }

    return config.handler(req, requestId, params, ctx);
  });
}

/** GET only. Never invokes the write limiter. */
export function tenantReadRoute<TParams extends TenantRouteParams>(
  config: TenantBoundRouteConfig<TParams>,
) {
  return bindTenantRoute("read-get", READ_GET_METHODS, "tenantReadRoute", config);
}

/**
 * POST only. Reserved for genuinely read-only POST operations such as the
 * future duplicate-candidate query. Does not consume a write allowance.
 * Boundary tests allow this constructor only on an explicit path allowlist.
 */
export function tenantReadPostRoute<TParams extends TenantRouteParams>(
  config: TenantBoundRouteConfig<TParams>,
) {
  return bindTenantRoute("read-post", READ_POST_METHODS, "tenantReadPostRoute", config);
}

/** POST, PUT, or PATCH. Always consumes the write limiter after authorize(). */
export function tenantWriteRoute<TParams extends TenantRouteParams>(
  config: TenantBoundRouteConfig<TParams>,
) {
  return bindTenantRoute("write", WRITE_METHODS, "tenantWriteRoute", config);
}
