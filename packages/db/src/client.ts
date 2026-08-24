import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { tenantGuardExtension } from "./guardExtension";
import { runWithTenantScope } from "./tenantScopeContext";

// Re-exports every generated model type, enum and the `Prisma` namespace
// (both its types like `Prisma.TransactionClient` and runtime values like
// `Prisma.JsonNull`) so consumers never import from the generated path
// directly.
export * from "./generated/prisma/client";
export { UnscopedTenantQueryError } from "./guardExtension";

/**
 * The application's ONLY Prisma client. It connects as the non-superuser
 * `noahark_app` role (DATABASE_URL) so PostgreSQL Row-Level Security is
 * always enforced — SECURITY_AND_TENANCY.md §1: "the application DB role is
 * non-superuser and cannot bypass RLS." Extended with the F-3C tenant guard
 * (guardExtension.ts) — every consumer of getAppClient() automatically gets
 * it; there is no unguarded path to this client from application code.
 *
 * Never query through this client directly outside `withTenantContext` /
 * `withoutTenantContext` / `withUserContext` / `withPlatformAuditContext` —
 * an un-scoped connection has no app.tenant_id set, which RLS policies
 * treat as "match nothing" (secure by default), and the guard extension
 * additionally throws immediately for any tenant-owned model query with no
 * active scope rather than letting it silently return zero rows.
 */
/**
 * F-22 (Phase 1B.1): `poolConfig` is exposed (and this factory exported)
 * SOLELY so integration tests can construct a second app-role client with a
 * deliberately tiny connection pool (`{ max: 1 }`) — forcing genuine
 * physical-connection reuse across alternating tenant requests, which is
 * what actually proves `SET LOCAL`-style `set_config(..., true)` context
 * cannot leak from one request to the next on a pooled connection. The
 * singleton client below (getAppClient/DATABASE_URL) uses node-postgres's
 * default pool size and gives no such guarantee to a test — a test running
 * against it might coincidentally get two different physical connections
 * for two "back to back" requests, which would prove nothing either way.
 * No production code path passes `poolConfig` — the singleton is
 * unaffected.
 */
function createAppClient(databaseUrl: string, poolConfig: Record<string, unknown> = {}) {
  const adapter = new PrismaPg({ connectionString: databaseUrl, ...poolConfig });
  return new PrismaClient({ adapter }).$extends(tenantGuardExtension());
}
export { createAppClient };

export type AppClient = ReturnType<typeof createAppClient>;

/** The interactive-transaction callback's `tx` parameter type for the
 * EXTENDED client (not the base `Prisma.TransactionClient`, which no
 * longer structurally matches once `.$extends()` is applied — the
 * extension adds/wraps operations, changing the client's exact type). */
type ExtendedTransactionClient = Parameters<
  Parameters<AppClient["$transaction"]>[0] & {}
>[0];

let appClient: AppClient | undefined;

function getAppClient(): AppClient {
  if (!appClient) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    appClient = createAppClient(url);
  }
  return appClient;
}

export type TransactionClient = ExtendedTransactionClient;

export interface TenantContextInput {
  tenantId: string;
  legalEntityIds: ReadonlySet<string> | readonly string[];
  userId?: string;
}

/**
 * Opens a transaction, sets the RLS session variables for this request via
 * the parameterized `set_config()` function (never string-interpolated SQL
 * — see below), runs `fn`, and commits. Every repository call for a
 * tenant-scoped request MUST go through this wrapper.
 *
 * `set_config(name, value, is_local)` with `is_local = true` behaves like
 * `SET LOCAL`: the value is visible only inside the current transaction and
 * is discarded on commit/rollback, so pooled connections can never leak one
 * request's tenant context into the next.
 */
export async function withTenantContext<T>(
  input: TenantContextInput,
  fn: (tx: TransactionClient) => Promise<T>,
  /** F-22 (Phase 1B.1): test-only override — see createAppClient's doc
   * comment. Defaults to the real singleton; no production call site passes
   * this. */
  client: AppClient = getAppClient(),
): Promise<T> {
  const legalEntityIds = new Set(input.legalEntityIds);
  const legalEntityIdsCsv = Array.from(legalEntityIds).join(",");
  return runWithTenantScope({ kind: "tenant", legalEntityIds }, () =>
    client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.legal_entity_ids', ${legalEntityIdsCsv}, true)`;
      if (input.userId) {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${input.userId}, true)`;
      }
      return fn(tx);
    }),
  );
}

/**
 * For the narrow set of operations that legitimately need to read a single
 * global (non-tenant-owned) table — e.g. the Permission catalogue — without
 * a tenant context. RLS on Permission has no tenant policy (it isn't
 * tenant-owned), so this still cannot see any tenant-scoped data.
 *
 * Does NOT grant access to the platform audit chain (tenant_id IS NULL
 * rows in audit_event) — see withPlatformAuditContext below. F-7 (Phase
 * 1B): a bare unscoped connection using this function previously could
 * still read every platform-level audit event (every user's sign-in
 * emails/IPs), because audit_event's old RLS policy treated "no tenant
 * context set" as "match the platform chain". That has been narrowed —
 * see the RLS migration's audit_event policy.
 */
export async function withoutTenantContext<T>(
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return runWithTenantScope({ kind: "unscoped-global", legalEntityIds: new Set() }, () =>
    getAppClient().$transaction(async (tx) => fn(tx)),
  );
}

/**
 * The ONLY context that can read or write the platform audit chain
 * (audit_event rows with tenant_id IS NULL — sign-in/sign-out/failed-login,
 * before any tenant is selected). Sets `app.platform_audit_access = true`
 * for the transaction; the audit_event RLS policy requires this exact
 * setting for tenant_id IS NULL rows (see the RLS migration).
 *
 * Phase 1 has no platform-administrator role or screen — the only current
 * callers are the sign-in/sign-out routes writing their own audit events.
 * A future cross-tenant admin capability would reuse this same context
 * setter behind its own dedicated authorization check (not a tenant
 * permission — there is no tenant to check permissions against here); it
 * does not yet exist, so platform audit events are not readable through any
 * product surface today.
 */
export async function withPlatformAuditContext<T>(
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return runWithTenantScope({ kind: "platform-audit", legalEntityIds: new Set() }, () =>
    getAppClient().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform_audit_access', 'true', true)`;
      return fn(tx);
    }),
  );
}

/**
 * P1G-6 (Phase 1H): the ONLY way to read Tenant ids without belonging to
 * (or already having selected) that tenant — used solely by the worker's
 * cross-tenant retention sweeps (apps/web/lib/retentionMaintenance.ts's
 * cleanupTerminalInvitations/purgeDeletedFileObjectStorage) to enumerate
 * every tenant so they can then iterate an ordinary `withTenantContext`
 * per tenant to actually delete anything.
 *
 * Replaces the earlier `withWorkerMaintenanceContext` (Phase 1F), which set
 * a session flag that widened the `tenant` RLS policy to expose the WHOLE
 * row (every column) — "ids only" was an application-layer convention, not
 * a database-enforced fact. This calls `worker_maintenance_list_tenant_ids()`,
 * a SECURITY DEFINER SQL function (see the RLS migration's "Cross-tenant
 * maintenance role" section) whose RETURNS TABLE(id text) signature makes
 * "ids only" true at the database level: `noahark_app` has EXECUTE on the
 * function but no SELECT grant on `tenant` beyond its own row, so there is
 * no query this client could issue — buggy or malicious — that reads any
 * other tenant's name, slug, status, timestamps or settings.
 *
 * Deliberately bypasses the tenant-scope guard extension (raw SQL, not a
 * Prisma model query) — there is no scope to set up front because the
 * function itself performs the elevation, narrowly, inside the database.
 */
export async function listAllTenantIdsForMaintenance(): Promise<string[]> {
  const rows = await getAppClient().$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM worker_maintenance_list_tenant_ids()`;
  return rows.map((row) => row.id);
}

/**
 * Bootstraps access-context resolution. Before we know which tenant/legal
 * entities a user may act in, we first need to ask "which tenants/legal
 * entities does this user belong to?" — a query against TenantMembership /
 * LegalEntityMembership, which are themselves RLS-protected by
 * `app.tenant_id`. That's circular: we can't set `app.tenant_id` until we've
 * queried the membership table that tells us what it should be.
 *
 * The break in the cycle is a narrow, explicit RLS carve-out: both
 * TenantMembership and LegalEntityMembership additionally allow rows where
 * `user_id = current_setting('app.user_id', true)`, regardless of
 * app.tenant_id (see the RLS migration). This function sets ONLY
 * `app.user_id` — no tenant/legal-entity context — so queries inside `fn`
 * can see (only) the caller's own membership rows via that carve-out, and
 * nothing else. Every other tenant-owned table has no such clause, so this
 * context cannot be used to read business data.
 */
export async function withUserContext<T>(
  userId: string,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return runWithTenantScope({ kind: "user-bootstrap", legalEntityIds: new Set() }, () =>
    getAppClient().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      return fn(tx);
    }),
  );
}

/**
 * F-3E: the ONLY context that can read a MembershipInvitation row before
 * the accepting user has any membership in its tenant — the same bootstrap
 * problem withUserContext solves for sign-in, but keyed by the invitation's
 * token hash (which the caller already possesses, from the invitation
 * email) rather than a user id, since the accepting identity may not even
 * have a User row yet. Sets ONLY `app.invitation_token_hash`; the RLS
 * carve-out on membership_invitation matches exactly (and only) that one
 * row — see the RLS migration. Once the invitation is validated, callers
 * MUST switch to an ordinary `withTenantContext({ tenantId: invitation.tenantId, ... })`
 * for every write (creating the membership, marking the invitation
 * accepted) — this bootstrap context's WITH CHECK deliberately has no
 * carve-out and cannot write.
 */
export async function withInvitationAcceptContext<T>(
  tokenHash: string,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return runWithTenantScope(
    { kind: "invitation-accept", legalEntityIds: new Set() },
    () =>
      getAppClient().$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.invitation_token_hash', ${tokenHash}, true)`;
        return fn(tx);
      }),
  );
}

/**
 * F-15 (Phase 1B.1): the ONLY context that can read a FileObject row before
 * any tenant/session context exists — the same bootstrap pattern as
 * `withInvitationAcceptContext`, keyed by the FileObject's own ID (which the
 * caller already possesses, having received a signature bound to that exact
 * ID at mint time — see @noahark/files/signedUrl.ts). Sets ONLY
 * `app.signed_file_delivery_id`; the RLS carve-out on file_object is a
 * SELECT-only policy matching exactly (and only) that one row — see the RLS
 * migration. This exists so the unauthenticated download route
 * (`/api/v1/files/local/[fileId]`) never needs a privileged/BYPASSRLS
 * client: RLS still enforces "this is the one row the signature named,"
 * even though there is no tenant context to scope by yet. Callers MUST NOT
 * use this context to derive any further access — it is read-only, single-
 * row, and exists solely so the route can check the file's current
 * status/version/revocation state before serving bytes.
 */
export async function withSignedFileDeliveryContext<T>(
  fileId: string,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return runWithTenantScope(
    { kind: "signed-file-delivery", legalEntityIds: new Set() },
    () =>
      getAppClient().$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.signed_file_delivery_id', ${fileId}, true)`;
        return fn(tx);
      }),
  );
}

/**
 * Returns the shared `noahark_app`-role client for direct use by the Auth.js
 * adapter. This is deliberately NOT wrapped in `withTenantContext`: User,
 * Account, Session, UserCredential and VerificationToken are global identity
 * tables with no `tenant_id` column and no RLS policy — a user's identity
 * exists independently of, and prior to, any tenant selection
 * (LEGAL_ENTITY_ARCHITECTURE.md: "User — global identity"). RLS protects
 * tenant-owned business data; it does not apply here by design.
 *
 * Do not use this client for a tenant-owned table expecting to read
 * business data: RLS IS enforced for the `noahark_app` role on every
 * tenant-owned table, and this client sets no `app.tenant_id` — so (F-28,
 * corrected) a query against a tenant-owned table through this client
 * returns ZERO rows, not "every row" (verified directly: a connection with
 * no context set matches nothing under this schema's RLS policies — see
 * SECURITY_AND_TENANCY.md and the negative test in
 * apps/web/tests/integration/security.test.ts). The risk of using this
 * client incorrectly is a silently-empty result set, not a cross-tenant
 * leak — but it is still the wrong client for anything but the identity
 * tables it exists for.
 */
export function getIdentityClient(): AppClient {
  return getAppClient();
}

export async function disconnectAppClient(): Promise<void> {
  if (appClient) {
    await appClient.$disconnect();
    appClient = undefined;
  }
}
