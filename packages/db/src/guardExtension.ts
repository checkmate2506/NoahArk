import { Prisma } from "./generated/prisma/client";
import { currentTenantScope } from "./tenantScopeContext";
import { isTenantOwnedModel, isLegalEntityRequiredModel } from "./tenantOwnedModels";

export class UnscopedTenantQueryError extends Error {
  constructor(model: string, operation: string) {
    super(
      `Refusing to run ${operation} on tenant-owned model "${model}" with no active tenant scope. ` +
        `Every query against a tenant-owned model must run inside withTenantContext() (or, only for the ` +
        `narrow membership-bootstrap case, withUserContext()). This is an application-layer guard on top ` +
        `of PostgreSQL RLS (Postgres would also return zero rows for this query) — it exists so this ` +
        `mistake fails loudly and immediately instead of silently returning an empty result.`,
    );
    this.name = "UnscopedTenantQueryError";
  }
}

/**
 * F-3C (Phase 1B): a Prisma Client Extension that denies any query against
 * a tenant-owned model when no tenant scope is active for the current
 * async call stack (see tenantScopeContext.ts), and any query against a
 * legal-entity-scoped model when the active scope's legalEntityIds set is
 * empty. Applied once, when constructing the shared `noahark_app` client
 * (see client.ts's createAppClient) — every consumer of getAppClient()
 * automatically gets this guard; there is no way to obtain an unguarded
 * handle to that client from application code.
 *
 * Deliberately does NOT replace PostgreSQL RLS: this is an in-process
 * sanity check that runs BEFORE the query reaches the database, using
 * AsyncLocalStorage state that this same process set — it cannot detect a
 * bug in RLS itself, and a bug in THIS extension (or a caller that somehow
 * bypasses it) would still be caught by RLS at the database. The two layers
 * check independent things: RLS enforces "this row belongs to the caller's
 * tenant" against real data; this guard enforces "this code path
 * remembered to establish a tenant scope at all."
 *
 * `withPlatformAuditContext` and the bootstrap carve-out
 * (`withUserContext`) are intentionally scoped to the specific
 * tenant-owned models each is designed for (audit_event / tenant_membership
 * / legal_entity_membership / tenant respectively) — see the `kind` checks
 * below.
 */
export function tenantGuardExtension() {
  return Prisma.defineExtension({
    name: "noahark-tenant-guard",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          assertScopeAllows(model, operation);
          return query(args);
        },
      },
    },
  });
}

const BOOTSTRAP_ALLOWED_MODELS = new Set([
  "TenantMembership",
  "LegalEntityMembership",
  "Tenant",
]);
const PLATFORM_AUDIT_ALLOWED_MODELS = new Set(["AuditEvent"]);
const INVITATION_ACCEPT_ALLOWED_MODELS = new Set(["MembershipInvitation"]);
const SIGNED_FILE_DELIVERY_ALLOWED_MODELS = new Set(["FileObject"]);

function assertScopeAllows(model: string, operation: string): void {
  if (!isTenantOwnedModel(model)) return; // global identity table — no scope required

  const scope = currentTenantScope();

  if (!scope || scope.kind === "unscoped-global") {
    throw new UnscopedTenantQueryError(model, operation);
  }

  if (scope.kind === "user-bootstrap" && !BOOTSTRAP_ALLOWED_MODELS.has(model)) {
    throw new UnscopedTenantQueryError(model, operation);
  }

  if (scope.kind === "platform-audit" && !PLATFORM_AUDIT_ALLOWED_MODELS.has(model)) {
    throw new UnscopedTenantQueryError(model, operation);
  }

  if (
    scope.kind === "invitation-accept" &&
    !INVITATION_ACCEPT_ALLOWED_MODELS.has(model)
  ) {
    throw new UnscopedTenantQueryError(model, operation);
  }

  if (
    scope.kind === "signed-file-delivery" &&
    !SIGNED_FILE_DELIVERY_ALLOWED_MODELS.has(model)
  ) {
    throw new UnscopedTenantQueryError(model, operation);
  }

  // A caller with ZERO legal-entity grants can never legitimately WRITE a
  // row to a model whose legal_entity_id column is non-nullable (there is
  // no "tenant-wide" case for these — see tenantOwnedModels.ts). This
  // heuristic is deliberately NOT applied to nullable-legal-entity models
  // (ApprovalRequest, FileObject, etc.) or to reads — see the comment on
  // LEGAL_ENTITY_NULLABLE_MODELS for why a blanket rule there would be a
  // false positive against real Phase 1 flows.
  if (
    scope.kind === "tenant" &&
    isLegalEntityRequiredModel(model) &&
    scope.legalEntityIds.size === 0 &&
    (operation.startsWith("create") ||
      operation.startsWith("update") ||
      operation.startsWith("upsert"))
  ) {
    throw new UnscopedTenantQueryError(model, operation);
  }
}
