import { AsyncLocalStorage } from "node:async_hooks";

/**
 * F-3C (Phase 1B): tracks, for the CURRENT async call stack, whether a
 * tenant-scoped RLS context is active. This is a pure in-process signal —
 * it does not talk to Postgres — used exclusively by the tenant/legal-
 * entity guard extension (guardExtension.ts) to fail fast, in the
 * application process, BEFORE a query is even sent to the database, if
 * code accidentally queries a tenant-owned model with no scoped context.
 *
 * This is explicitly a SECOND, independent layer on top of PostgreSQL RLS,
 * not a replacement for it: RLS is what makes cross-tenant access
 * structurally impossible even if this guard has a bug or is bypassed by
 * some future refactor; this guard exists so that mistake surfaces as an
 * immediate, specific thrown error ("queried a tenant-owned model with no
 * scoped context") instead of a confusing, silently-empty result set that
 * a developer might misread as "there's no data" rather than "I forgot to
 * scope this query."
 */
export interface TenantScope {
  readonly kind:
    | "tenant"
    | "user-bootstrap"
    | "platform-audit"
    | "invitation-accept"
    | "signed-file-delivery"
    | "unscoped-global";
  readonly legalEntityIds: ReadonlySet<string>;
}

const storage = new AsyncLocalStorage<TenantScope>();

export function runWithTenantScope<T>(scope: TenantScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentTenantScope(): TenantScope | undefined {
  return storage.getStore();
}
