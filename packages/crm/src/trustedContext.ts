import {
  ForbiddenError,
  UnauthenticatedError,
  ValidationError,
  type AccessContext,
} from "@noahark/core";

/** Server-derived AccessContext only. Client-supplied tenant/actor/LE lists
 * are never accepted as a substitute. */
export function assertTrustedContext(ctx: AccessContext): void {
  if (!ctx.userId || !ctx.tenantId || !ctx.requestId) {
    throw new UnauthenticatedError();
  }
}

export function assertHasLegalEntityAccess(
  ctx: AccessContext,
  legalEntityId: string,
): void {
  assertTrustedContext(ctx);
  if (!ctx.legalEntityIds.has(legalEntityId)) {
    throw new ForbiddenError("Not permitted");
  }
}

export function requireNonEmptyLegalEntityScope(ctx: AccessContext): void {
  assertTrustedContext(ctx);
  if (ctx.legalEntityIds.size === 0) {
    throw new ForbiddenError("Not permitted");
  }
}

export function requireExpectedVersion(version: number, resource: string): void {
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError(`${resource} expected version must be a positive integer`);
  }
}

export function tenantContextInput(ctx: AccessContext) {
  return {
    tenantId: ctx.tenantId,
    legalEntityIds: ctx.legalEntityIds,
    userId: ctx.userId,
  };
}
