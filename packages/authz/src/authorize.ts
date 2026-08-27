import {
  type AccessContext,
  effectivePermissions,
  hasLegalEntityAccess,
  ForbiddenError,
} from "@noahark/core";
import type { PermissionKey } from "./permissions";
import { PERMISSIONS } from "./permissions";

export type RecordScopePredicate = (ctx: AccessContext) => boolean;

export interface AuthorizeInput {
  permission: PermissionKey;
  /** null/omitted = tenant-wide action. A string requires membership in
   * that specific legal entity (checked before the permission itself). */
  legalEntityId?: string | null;
  /** Optional fourth check: does this specific record fall within the
   * caller's allowed scope (e.g. "own records only")? */
  recordScope?: RecordScopePredicate;
}

/**
 * The central, mandatory authorization gate. Implements checks 2–4 of the
 * six independent server-side checks (SECURITY_AND_TENANCY.md §3):
 *   1. tenant access       — implicit: AccessContext only exists for a
 *                             validated tenant membership (built server-side)
 *   2. legal-entity access — verified here
 *   3. module permission   — verified here
 *   4. record scope        — verified here (caller-supplied predicate)
 *   5. field-level access  — see authorizeField() below
 *   6. approval authority  — see packages/workflow (role-based, not
 *                             permission-based)
 *
 * Throws ForbiddenError (never returns a boolean) so a call site can never
 * accidentally ignore the result. Use `can()` for a non-throwing query.
 */
export function authorize(ctx: AccessContext, input: AuthorizeInput): void {
  const legalEntityId = input.legalEntityId ?? null;

  if (legalEntityId !== null && !hasLegalEntityAccess(ctx, legalEntityId)) {
    throw new ForbiddenError("No access to this legal entity");
  }

  const perms = effectivePermissions(ctx, legalEntityId);
  if (!perms.has(input.permission)) {
    throw new ForbiddenError(`Missing permission: ${input.permission}`);
  }

  if (input.recordScope && !input.recordScope(ctx)) {
    throw new ForbiddenError("Record is outside your access scope");
  }
}

/** Non-throwing form — for building "what can this user do" responses.
 * Never use this to decide whether to hide a UI control in place of a
 * server-side authorize() call on the actual mutating endpoint. */
export function can(ctx: AccessContext, input: AuthorizeInput): boolean {
  try {
    authorize(ctx, input);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Field-level access (check 5)
// ---------------------------------------------------------------------------

export interface FieldPolicyRule {
  entityType: string;
  fieldName: string;
  /** Catalogue key, or a declared-but-unseeded later-phase key. Unknown
   * keys fail closed (the caller does not hold them). */
  requiredPermission: string;
}

export function isFieldProtected(
  policies: readonly FieldPolicyRule[],
  entityType: string,
  fieldName: string,
): boolean {
  return policies.some((p) => p.entityType === entityType && p.fieldName === fieldName);
}

/** Permission-set lookup that accepts catalogue keys and declared-but-
 * unseeded later-phase keys. Missing keys fail closed. */
export function callerHasPermission(
  ctx: AccessContext,
  permission: string,
  legalEntityId?: string | null,
): boolean {
  const scopedLegalEntityId = legalEntityId ?? null;
  if (scopedLegalEntityId !== null && !hasLegalEntityAccess(ctx, scopedLegalEntityId)) {
    return false;
  }
  return effectivePermissions(ctx, scopedLegalEntityId).has(permission);
}

/** Throws if the field is protected and the caller lacks the required
 * permission. A field with no registered policy is unprotected (Phase 1
 * ships no real protected fields — see PERMISSIONS.DEMO_PROTECTED_FIELD_READ
 * for the foundation's self-test). */
export function authorizeField(
  ctx: AccessContext,
  policies: readonly FieldPolicyRule[],
  entityType: string,
  fieldName: string,
  legalEntityId?: string | null,
): void {
  const rule = policies.find(
    (p) => p.entityType === entityType && p.fieldName === fieldName,
  );
  if (!rule) return;
  if (!callerHasPermission(ctx, rule.requiredPermission, legalEntityId ?? null)) {
    throw new ForbiddenError(`Missing permission: ${rule.requiredPermission}`);
  }
}

/** Returns a shallow copy of `record` with any field the caller is not
 * authorized to see removed. Used for read paths where most fields are
 * visible and a few are protected — mutation paths should call
 * authorizeField() directly and reject the whole request instead. */
export function maskProtectedFields<T extends Record<string, unknown>>(
  ctx: AccessContext,
  policies: readonly FieldPolicyRule[],
  entityType: string,
  record: T,
  legalEntityId?: string | null,
): T {
  const result: Record<string, unknown> = { ...record };
  for (const policy of policies) {
    if (policy.entityType !== entityType) continue;
    if (!(policy.fieldName in result)) continue;
    if (!callerHasPermission(ctx, policy.requiredPermission, legalEntityId ?? null)) {
      delete result[policy.fieldName];
    }
  }
  return result as T;
}

// ---------------------------------------------------------------------------
// Self-escalation guards
// ---------------------------------------------------------------------------

/** A user may never modify their own role assignment, and may never grant a
 * role carrying permissions they do not themselves hold (no privilege
 * escalation via delegation). */
export function assertCanAssignRole(
  ctx: AccessContext,
  input: {
    targetUserId: string;
    rolePermissions: readonly PermissionKey[];
    legalEntityId?: string | null;
  },
): void {
  authorize(ctx, {
    permission: PERMISSIONS.ROLE_ASSIGN,
    legalEntityId: input.legalEntityId ?? null,
  });

  if (input.targetUserId === ctx.userId) {
    throw new ForbiddenError("You cannot change your own role assignment");
  }

  const actorPermissions = effectivePermissions(ctx, input.legalEntityId ?? null);
  const missing = input.rolePermissions.filter((p) => !actorPermissions.has(p));
  if (missing.length > 0) {
    throw new ForbiddenError("You cannot grant permissions you do not hold yourself");
  }
}

/** A user may never grant themselves access to a legal entity. */
export function assertCanGrantLegalEntityAccess(
  ctx: AccessContext,
  input: { targetUserId: string; legalEntityId: string },
): void {
  authorize(ctx, {
    permission: PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_GRANT,
    legalEntityId: input.legalEntityId,
  });

  if (input.targetUserId === ctx.userId) {
    throw new ForbiddenError("You cannot grant yourself access to a legal entity");
  }
}
