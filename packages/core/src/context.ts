/**
 * AccessContext is the ONLY source of truth for who is making a request and
 * what they may touch. It is built exactly once per request, entirely from
 * server-side state (session -> membership lookups) — never from client-
 * supplied tenantId/legalEntityId/role/permission values.
 *
 * SECURITY_AND_TENANCY.md §2: "Server-derived context only."
 */
export interface AccessContext {
  readonly requestId: string;
  readonly userId: string;
  readonly tenantId: string;
  /** Legal entities this user currently has ACTIVE membership in, within
   * this tenant. Access to one entity never implies access to another. */
  readonly legalEntityIds: ReadonlySet<string>;
  /** Permission keys resolved server-side from the user's roles for this
   * tenant (tenant-wide roles) — legal-entity-scoped roles are resolved
   * separately via `legalEntityPermissions`. */
  readonly permissions: ReadonlySet<string>;
  /** legalEntityId -> permission keys granted specifically within that
   * entity (from MembershipRole rows scoped to one legal entity). */
  readonly legalEntityPermissions: ReadonlyMap<string, ReadonlySet<string>>;
  /** Role IDs held tenant-wide. Distinct from `permissions`: approval
   * authority is checked against the *role* an ApprovalStep names, not
   * against a permission key — see packages/workflow. */
  readonly roleIds: ReadonlySet<string>;
  /** legalEntityId -> role IDs held specifically within that entity. */
  readonly legalEntityRoleIds: ReadonlyMap<string, ReadonlySet<string>>;
  // Explicit `| undefined` (not bare `?:`) so building this object from a
  // source that may genuinely produce `undefined` (e.g. a missing header)
  // type-checks under exactOptionalPropertyTypes — see packages/core's
  // errors.ts for the same pattern with a longer explanation.
  readonly ipAddress?: string | undefined;
  readonly userAgent?: string | undefined;
}

/** A background job's restored context. Jobs must re-derive/validate this
 * from durable state (the job payload's tenant/legal-entity ids plus a fresh
 * permission lookup) — never trust a serialized AccessContext blindly. */
export interface JobContext {
  readonly correlationId: string;
  readonly tenantId?: string;
  readonly legalEntityId?: string;
}

/** Effective permission set for a given legal entity: tenant-wide
 * permissions unioned with that entity's scoped permissions. Returns an
 * empty set (not an error) if the caller lacks access to the entity at all
 * — callers must check `hasLegalEntityAccess` separately. */
export function effectivePermissions(
  ctx: AccessContext,
  legalEntityId: string | null,
): ReadonlySet<string> {
  if (legalEntityId === null) return ctx.permissions;
  if (!ctx.legalEntityIds.has(legalEntityId)) return new Set();
  const scoped = ctx.legalEntityPermissions.get(legalEntityId) ?? new Set<string>();
  return new Set([...ctx.permissions, ...scoped]);
}

export function hasLegalEntityAccess(ctx: AccessContext, legalEntityId: string): boolean {
  return ctx.legalEntityIds.has(legalEntityId);
}

/** Mirrors `effectivePermissions` for role membership — used by the
 * approval engine to decide whether an actor holds the specific role an
 * ApprovalStep names as its approver. */
export function effectiveRoleIds(
  ctx: AccessContext,
  legalEntityId: string | null,
): ReadonlySet<string> {
  if (legalEntityId === null) return ctx.roleIds;
  if (!ctx.legalEntityIds.has(legalEntityId)) return new Set();
  const scoped = ctx.legalEntityRoleIds.get(legalEntityId) ?? new Set<string>();
  return new Set([...ctx.roleIds, ...scoped]);
}

export function hasRole(
  ctx: AccessContext,
  roleId: string,
  legalEntityId: string | null,
): boolean {
  return effectiveRoleIds(ctx, legalEntityId).has(roleId);
}
