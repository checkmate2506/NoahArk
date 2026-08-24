import { cookies, headers } from "next/headers";
import {
  newRequestId,
  type AccessContext,
  ForbiddenError,
  UnauthenticatedError,
} from "@noahark/core";
import { withTenantContext, withUserContext } from "@noahark/db";
import { SESSION_COOKIE_NAME, resolveSession } from "./session";

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
}

/** Who is making this request? The ONLY source of truth is the session
 * cookie, resolved against the database. */
export async function requireCurrentUser(): Promise<CurrentUser> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!raw) throw new UnauthenticatedError();
  const resolved = await resolveSession(raw);
  if (!resolved) throw new UnauthenticatedError();
  return resolved.user;
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
}

/** Every tenant the user has ACTIVE membership in — used for the tenant
 * switcher and to validate a requested tenant id. Resolved inside the
 * user-context bootstrap transaction (see withUserContext in @noahark/db). */
export async function listMyTenants(userId: string): Promise<TenantSummary[]> {
  return withUserContext(userId, async (tx) => {
    const memberships = await tx.tenantMembership.findMany({
      where: { userId, status: "ACTIVE" },
      include: { tenant: true },
    });
    return memberships
      .filter((m) => m.tenant.status === "ACTIVE")
      .map((m) => ({ id: m.tenant.id, name: m.tenant.name, slug: m.tenant.slug }));
  });
}

export interface ContextMeta {
  requestId: string;
  ipAddress?: string | undefined;
  userAgent?: string | undefined;
}

/**
 * Builds the full AccessContext for one tenant. `tenantId` is a
 * client-supplied HINT of which of the user's OWN tenants to act in — never
 * trusted directly. Membership status, legal-entity grants, role
 * assignments and permissions are all re-derived from the database on every
 * call; a tenant the caller has no active membership in always yields
 * ForbiddenError, never a usable context.
 */
export async function getAccessContext(
  userId: string,
  tenantId: string,
  meta: ContextMeta,
): Promise<AccessContext> {
  const { membership, legalEntityMemberships } = await withUserContext(
    userId,
    async (tx) => {
      const membership = await tx.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
      });
      const legalEntityMemberships = await tx.legalEntityMembership.findMany({
        where: { tenantId, userId, status: "ACTIVE" },
      });
      return { membership, legalEntityMemberships };
    },
  );

  if (!membership || membership.status !== "ACTIVE") {
    throw new ForbiddenError("No active membership in this tenant");
  }

  const legalEntityIds = new Set(legalEntityMemberships.map((m) => m.legalEntityId));

  const roleAssignments = await withTenantContext(
    { tenantId, legalEntityIds, userId },
    (tx) =>
      tx.membershipRole.findMany({
        where: { tenantMembershipId: membership.id },
        include: {
          role: { include: { rolePermissions: { include: { permission: true } } } },
        },
      }),
  );

  const permissions = new Set<string>();
  const roleIds = new Set<string>();
  const legalEntityPermissions = new Map<string, Set<string>>();
  const legalEntityRoleIds = new Map<string, Set<string>>();

  for (const assignment of roleAssignments) {
    const permKeys = assignment.role.rolePermissions.map((rp) => rp.permission.key);
    if (assignment.legalEntityId === null) {
      roleIds.add(assignment.roleId);
      for (const key of permKeys) permissions.add(key);
    } else {
      const roleSet =
        legalEntityRoleIds.get(assignment.legalEntityId) ?? new Set<string>();
      roleSet.add(assignment.roleId);
      legalEntityRoleIds.set(assignment.legalEntityId, roleSet);

      const permSet =
        legalEntityPermissions.get(assignment.legalEntityId) ?? new Set<string>();
      for (const key of permKeys) permSet.add(key);
      legalEntityPermissions.set(assignment.legalEntityId, permSet);
    }
  }

  return {
    requestId: meta.requestId,
    userId,
    tenantId,
    legalEntityIds,
    permissions,
    legalEntityPermissions,
    roleIds,
    legalEntityRoleIds,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  };
}

export function requestMeta(req: Request, requestId: string): ContextMeta {
  return {
    requestId,
    ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
    userAgent: req.headers.get("user-agent") ?? undefined,
  };
}

/** Convenience used by every tenant-scoped route: authenticate, then build
 * the AccessContext for the tenant named in the URL. */
export async function resolveTenantContext(
  req: Request,
  requestId: string,
  tenantId: string,
): Promise<AccessContext> {
  const user = await requireCurrentUser();
  return getAccessContext(user.id, tenantId, requestMeta(req, requestId));
}

/** Server Component equivalent of resolveTenantContext — there is no
 * Request object in a Server Component, so metadata comes from
 * next/headers instead. Used only for read paths (page rendering);
 * mutations always go through the /api/v1 routes above. */
export async function resolveTenantContextForPage(
  tenantId: string,
): Promise<AccessContext> {
  const user = await requireCurrentUser();
  const headerList = await headers();
  return getAccessContext(user.id, tenantId, {
    requestId: newRequestId(),
    ipAddress: headerList.get("x-forwarded-for")?.split(",")[0]?.trim(),
    userAgent: headerList.get("user-agent") ?? undefined,
  });
}
