-- =============================================================================
-- NoahArk — Row-Level Security and invariant constraints.
--
-- This migration is what makes SECURITY_AND_TENANCY.md's isolation model
-- real at the database level (not just in application code). Read this file
-- top to bottom before touching it — every GRANT/policy here is load-bearing.
--
-- F-4 (Phase 1B): role creation, database-level GRANT CONNECT, and
-- schema-level GRANT USAGE used to live in THIS file, hardcoded to a
-- database literally named "noahark" and requiring the connecting role to
-- have CREATEROLE/superuser-equivalent privilege. That broke on Azure
-- Database for PostgreSQL Flexible Server (the admin login there is a
-- member of azure_pg_admin, not a real superuser, and cannot grant
-- BYPASSRLS to anything) and on any database not literally named "noahark".
-- Role/database provisioning now lives in a SEPARATE, explicit step —
-- see packages/db/provisioning/provision-roles.sql (run once per
-- environment, parameterised by database name, BEFORE `prisma migrate
-- deploy`). This migration now assumes noahark_app and noahark_worker
-- ALREADY EXIST and only grants privileges on the objects it creates.
--
-- Two application-facing Postgres roles (created by provisioning, not
-- here):
--   noahark_app     Non-superuser, NOBYPASSRLS. Runs ALL ordinary
--                    application queries via withTenantContext()/
--                    withoutTenantContext() (@noahark/db). RLS is fully
--                    enforced for this role — it is structurally incapable
--                    of reading/writing another tenant's rows.
--   noahark_worker   F-12 (Phase 1B): Non-superuser, NOBYPASSRLS (no
--                    longer BYPASSRLS — see §9 below). Its cross-tenant
--                    visibility into background_job/outbox_event now comes
--                    from an explicit RLS policy scoped `TO noahark_worker`
--                    on exactly those two tables, not from a blanket role
--                    attribute that would silently apply to any table this
--                    role is ever granted in the future. Cannot read any
--                    business table: RLS applies to it like any other role,
--                    and it was never GRANTed those tables at all.
--   (migration role) Whatever DATABASE_MIGRATION_URL connects as (typically
--                    the Postgres superuser locally, or the provisioning-
--                    created owner role in a managed environment). Owns
--                    every table. A non-superuser owner does NOT bypass
--                    FORCE ROW LEVEL SECURITY, which is why every ALTER
--                    TABLE below sets FORCE — this migration's own writes
--                    (there are none; it's DDL-only) would still be
--                    RLS-checked if it tried to touch data directly.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2. Invariant CHECK constraint — jurisdiction <-> functional currency
--
-- App-layer mirror: packages/core's assertJurisdictionCurrencyCompatible().
-- Both must independently reject a mismatched pairing — this is the
-- database-level backstop in case application code is ever bypassed.
-- -----------------------------------------------------------------------------

ALTER TABLE "legal_entity" ADD CONSTRAINT "legal_entity_jurisdiction_currency_check"
  CHECK (
    ("jurisdiction" = 'SG' AND "functional_currency" = 'SGD') OR
    ("jurisdiction" = 'MY' AND "functional_currency" = 'MYR') OR
    ("jurisdiction" = 'ID' AND "functional_currency" = 'IDR')
  );

-- -----------------------------------------------------------------------------
-- 3. Append-only audit_event — trigger blocks UPDATE/DELETE unconditionally
--
-- Deliberately has NO current_user bypass (unlike the system-role-protection
-- triggers in §6) — there is no legitimate reason, including seeding or
-- migrations, to ever mutate a written audit event.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION audit_event_block_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_event rows are append-only and cannot be updated or deleted (attempted % on id=%)',
    TG_OP, COALESCE(OLD.id, 'unknown');
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_update
  BEFORE UPDATE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION audit_event_block_mutation();

CREATE TRIGGER audit_event_no_delete
  BEFORE DELETE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION audit_event_block_mutation();

-- -----------------------------------------------------------------------------
-- 4. System-role protection — role_permission / role
--
-- Bypassed only when current_user <> 'noahark_app', so prisma/seed.ts
-- (which runs as the migration/owner role via createSystemClient()) can
-- seed system roles' permissions, while the live application — which only
-- ever touches these tables as noahark_app — is structurally blocked from
-- ever modifying or deleting a system role.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION protect_system_role_permissions() RETURNS trigger AS $$
DECLARE
  is_sys BOOLEAN;
BEGIN
  IF current_user <> 'noahark_app' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  SELECT "is_system" INTO is_sys FROM "role" WHERE "id" = COALESCE(NEW."role_id", OLD."role_id");
  IF is_sys THEN
    RAISE EXCEPTION 'Cannot modify permissions of a system role';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_permission_protect_system
  BEFORE INSERT OR UPDATE OR DELETE ON "role_permission"
  FOR EACH ROW EXECUTE FUNCTION protect_system_role_permissions();

CREATE OR REPLACE FUNCTION protect_system_role_deletion() RETURNS trigger AS $$
BEGIN
  IF current_user <> 'noahark_app' THEN
    RETURN OLD;
  END IF;
  IF OLD."is_system" THEN
    RAISE EXCEPTION 'Cannot delete a system role';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_protect_system_deletion
  BEFORE DELETE ON "role"
  FOR EACH ROW EXECUTE FUNCTION protect_system_role_deletion();

-- -----------------------------------------------------------------------------
-- 5. Row-Level Security policies
--
-- Two reusable predicates, inlined into each policy (Postgres RLS policies
-- cannot call a function that itself needs to be planner-inlined for index
-- use, so we write the condition out per table rather than wrapping it):
--
--   tenant match:        tenant_id = current_setting('app.tenant_id', true)
--   legal-entity match:  legal_entity_id IS NULL
--                         OR legal_entity_id = ANY(string_to_array(
--                              current_setting('app.legal_entity_ids', true), ','))
--
-- current_setting(name, true) returns NULL when unset (missing_ok) rather
-- than erroring — so a connection with no context set matches ZERO rows
-- everywhere (secure by default), never "all rows".
-- -----------------------------------------------------------------------------

-- tenant (root — no separate tenant_id column, id IS the tenant id).
-- Carries the SAME bootstrap carve-out as tenant_membership /
-- legal_entity_membership (§ below): listMyTenants() joins
-- tenant_membership -> tenant inside withUserContext (app.tenant_id
-- unset), and RLS applies to that join just as it would a direct query —
-- without this OR clause the membership row is visible (via its own
-- carve-out) but its joined `tenant` comes back NULL, not merely "no
-- extra tenant visible". WITH CHECK intentionally has NO carve-out: a
-- bootstrap-only transaction can discover/read tenants it belongs to, but
-- can never write one.
ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY;
-- P1E-4 (Phase 1F): the third OR clause is a narrow carve-out for the
-- worker's cross-tenant retention sweeps (apps/web/lib/retentionMaintenance.ts's
-- cleanupTerminalInvitations/purgeDeletedFileObjectStorage) — they need to
-- enumerate every tenant id to iterate `withTenantContext` per tenant.
--
-- P1G-6 (Phase 1H): this policy previously had a THIRD OR-branch,
-- `current_setting('app.worker_maintenance_access', true) = 'true'`, set by
-- client.ts's withWorkerMaintenanceContext. That carve-out granted the
-- WHOLE tenant row (every column noahark_app can already see for its own
-- tenant — name, slug, status, timestamps, settings), not "tenant IDs
-- only" as the surrounding code/docs claimed: the restriction to ids was
-- only an application-layer convention (a `select: { id: true }` at one
-- call site), never database-enforced. Any other query issued while that
-- session flag was set (a bug, or a future call site that forgot the
-- `select`) would have received full cross-tenant visibility into every
-- tenant's name/slug/status/settings. That branch and
-- withWorkerMaintenanceContext are both removed — replaced by
-- worker_maintenance_list_tenant_ids() below, a SECURITY DEFINER function
-- whose RETURNS TABLE(id text) signature makes "ids only" a database-level
-- fact, not a caller convention, and which is never reachable through this
-- policy or through noahark_app's ordinary table-level grant at all.
CREATE POLICY tenant_isolation ON "tenant"
  USING (
    "id" = current_setting('app.tenant_id', true)
    OR EXISTS (
      SELECT 1 FROM "tenant_membership" tm
      WHERE tm."tenant_id" = "tenant"."id"
        AND tm."user_id" = current_setting('app.user_id', true)
        AND tm."status" = 'ACTIVE'
    )
  )
  WITH CHECK ("id" = current_setting('app.tenant_id', true));
GRANT SELECT, UPDATE ON "tenant" TO noahark_app;

-- -----------------------------------------------------------------------------
-- Cross-tenant maintenance role (P1G-6/P1G-7, Phase 1H)
--
-- `noahark_maintenance_definer` is a NOLOGIN role that exists solely to own
-- a small set of SECURITY DEFINER functions below. Nobody ever connects to
-- Postgres as this role directly (NOLOGIN makes that structurally
-- impossible, not just a convention) — it is only ever "worn" by a
-- SECURITY DEFINER function for the duration of that function's own body.
-- Each function's RETURN TYPE (not a table-level GRANT) is what bounds
-- what a caller can get back, and each function's own WHERE clause (not a
-- caller-supplied predicate) is what bounds which rows it touches — see
-- the individual GRANT/RLS-policy/function definitions below for exactly
-- what this role can reach, kept as narrow as the specific maintenance
-- task requires and no broader.
--
-- Like noahark_app/noahark_worker, this role is NOT created here — role
-- provisioning is a separate step from schema migrations (F-4: CREATE ROLE
-- needs CREATEROLE-equivalent privilege, which the Azure Flexible Server
-- admin login has but which is an environment-level concern, not a schema
-- change) — see provisioning/provision-roles.mjs's ensureNoLoginRole. This
-- GRANT/CREATE POLICY will fail with "role does not exist" if provisioning
-- has not already run, exactly like every existing GRANT to noahark_app/
-- noahark_worker below.

-- Column-level grant: even a hypothetical future SQL statement executed as
-- this role (not merely the one function below) can only ever read the
-- `id` column of `tenant` — never name/slug/status/timestamps/settings.
-- This is deliberately redundant with the function's own RETURNS TABLE(id
-- text) signature (defense in depth: the grant alone would already stop a
-- `SELECT *`, independent of whatever the function body happens to say).
GRANT SELECT ("id") ON "tenant" TO noahark_maintenance_definer;
CREATE POLICY maintenance_definer_enumerate_ids ON "tenant"
  FOR SELECT TO noahark_maintenance_definer
  USING (true);

-- SECURITY DEFINER: runs with noahark_maintenance_definer's own privileges
-- (the function's OWNER, set below), not the CALLER's — so noahark_app can
-- be granted EXECUTE without ever being granted cross-tenant SELECT on
-- "tenant" itself. Fixed `search_path` prevents a search-path-injection
-- attack from redirecting an unqualified relation name to an
-- attacker-controlled object; `LANGUAGE sql` with no dynamic SQL means
-- there is no caller-controlled predicate or table name to inject through
-- in the first place.
CREATE FUNCTION worker_maintenance_list_tenant_ids()
RETURNS TABLE(id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT "id" FROM "tenant";
$fn$;
ALTER FUNCTION worker_maintenance_list_tenant_ids() OWNER TO noahark_maintenance_definer;
REVOKE ALL ON FUNCTION worker_maintenance_list_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker_maintenance_list_tenant_ids() TO noahark_app;

-- Simple tenant-scoped tables (tenant_id required, no legal_entity_id column)
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tenant_entitlement', 'tenant_setting', 'role', 'role_permission', 'idempotency_key',
    'approval_step', 'approval_decision', 'attachment', 'custom_field_value'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $fmt$CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = current_setting('app.tenant_id', true))
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true))$fmt$,
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO noahark_app', t);
  END LOOP;
END
$$;

-- "legal_entity" itself: intentionally tenant-scoped only (NOT additionally
-- filtered by app.legal_entity_ids) — listing which legal entities exist in
-- your own tenant is tenant-wide visibility by design. Legal-entity ACCESS
-- governs entity-scoped sub-resources and mutations instead, matching the
-- application-layer authorize() calls in lib/services/legalEntityService.ts.
ALTER TABLE "legal_entity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legal_entity" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "legal_entity"
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "legal_entity" TO noahark_app;

-- Entity-scoped sub-resources (org structure + entity settings) — these DO
-- get the legal-entity-scoped policy, matching the corresponding
-- authorize(ctx, { ..., legalEntityId }) checks in the service layer
-- (settingsService.listLegalEntitySettings/updateLegalEntitySetting etc.):
-- a member with tenant access but no grant for a specific legal entity must
-- not see that entity's departments, cost centres or settings either.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'legal_entity_setting', 'business_unit', 'department',
    'team', 'branch', 'warehouse', 'cost_centre'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $fmt$CREATE POLICY tenant_and_legal_entity_isolation ON %I
        USING (
          tenant_id = current_setting('app.tenant_id', true)
          AND legal_entity_id = ANY(string_to_array(current_setting('app.legal_entity_ids', true), ','))
        )
        WITH CHECK (
          tenant_id = current_setting('app.tenant_id', true)
          AND legal_entity_id = ANY(string_to_array(current_setting('app.legal_entity_ids', true), ','))
        )$fmt$,
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO noahark_app', t);
  END LOOP;
END
$$;

-- Tenant-scoped tables with a NULLABLE legal_entity_id — entity-scoped
-- indirect-access defense (attachments/approvals/settings/notifications
-- must not leak via a legal entity the caller has no grant for).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'approval_policy', 'approval_request', 'demo_approval_subject',
    'outbox_event', 'background_job', 'notification', 'file_object',
    'custom_field_definition'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $fmt$CREATE POLICY tenant_and_legal_entity_isolation ON %I
        USING (
          tenant_id = current_setting('app.tenant_id', true)
          AND (legal_entity_id IS NULL OR legal_entity_id = ANY(string_to_array(current_setting('app.legal_entity_ids', true), ',')))
        )
        WITH CHECK (
          tenant_id = current_setting('app.tenant_id', true)
          AND (legal_entity_id IS NULL OR legal_entity_id = ANY(string_to_array(current_setting('app.legal_entity_ids', true), ',')))
        )$fmt$,
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO noahark_app', t);
  END LOOP;
END
$$;

-- F-15 (Phase 1B.1): a narrow, SELECT-only carve-out on file_object so the
-- unauthenticated signed-file-download route can load the exact FileObject
-- named by an already-validated signature (see withSignedFileDeliveryContext
-- in packages/db/src/client.ts) without any tenant context — the same
-- bootstrap-carve-out SHAPE as membership_invitation's token-hash policy
-- below, keyed by the FileObject's own id instead of a token hash.
-- `app.signed_file_delivery_id` is set ONLY by withSignedFileDeliveryContext,
-- to the one specific file id named in an already-verified signature — this
-- cannot be used to enumerate or browse other files, only to read the exact
-- row a valid signature named. `FOR SELECT` only: this is an additional
-- PERMISSIVE policy (Postgres ORs multiple permissive SELECT policies
-- together), so it adds no WITH CHECK surface and cannot be used to write —
-- every write to file_object still requires the ordinary tenant_and_legal_
-- entity_isolation policy above via a real tenant context.
CREATE POLICY signed_file_delivery_read ON "file_object"
  FOR SELECT
  USING (id = current_setting('app.signed_file_delivery_id', true));

-- field_policy has NO legal_entity_id column (a policy is scoped by
-- entityType/fieldName, not a specific legal entity) and a NULLABLE
-- tenant_id (NULL = a platform-wide default policy, not tenant data) — so
-- it gets its own hand-written policy rather than joining either loop
-- above. USING allows platform defaults (tenant_id IS NULL) to remain
-- visible to every tenant; WITH CHECK still requires a real tenant_id, so
-- the app role can never itself write a platform-wide (NULL-tenant) row.
ALTER TABLE "field_policy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "field_policy" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_or_platform_default ON "field_policy"
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "field_policy" TO noahark_app;

-- notification_preference (tenant-scoped, no legal_entity_id column)
ALTER TABLE "notification_preference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_preference" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "notification_preference"
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "notification_preference" TO noahark_app;

-- membership_role (tenant-scoped, nullable legal_entity_id — a tenant-wide
-- role assignment when NULL, entity-scoped when set)
ALTER TABLE "membership_role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership_role" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_and_legal_entity_isolation ON "membership_role"
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    AND (legal_entity_id IS NULL OR legal_entity_id = ANY(string_to_array(current_setting('app.legal_entity_ids', true), ',')))
  )
  WITH CHECK (
    tenant_id = current_setting('app.tenant_id', true)
    AND (legal_entity_id IS NULL OR legal_entity_id = ANY(string_to_array(current_setting('app.legal_entity_ids', true), ',')))
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON "membership_role" TO noahark_app;

-- tenant_membership / legal_entity_membership — the bootstrap carve-out
-- (SECURITY_AND_TENANCY.md / packages/db's withUserContext doc comment).
-- USING allows "my own membership rows" regardless of app.tenant_id (so
-- context resolution can discover which tenants/entities a user belongs to
-- before app.tenant_id is known); WITH CHECK does NOT include that
-- carve-out, so a bootstrap-only transaction (app.user_id set, app.tenant_id
-- unset) can read but never write.
ALTER TABLE "tenant_membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_membership" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_or_self ON "tenant_membership"
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR user_id = current_setting('app.user_id', true)
  )
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant_membership" TO noahark_app;

ALTER TABLE "legal_entity_membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legal_entity_membership" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_or_self ON "legal_entity_membership"
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR user_id = current_setting('app.user_id', true)
  )
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "legal_entity_membership" TO noahark_app;

-- membership_invitation — F-3E (Phase 1B). Same bootstrap-carve-out SHAPE
-- as tenant_membership/legal_entity_membership above, but keyed by the
-- invitation's own token hash rather than a user id: the person accepting
-- an invitation does not yet have ANY membership in the target tenant (that
-- is exactly what accepting grants), so they cannot set app.tenant_id to a
-- value RLS would otherwise accept. `app.invitation_token_hash` is set ONLY
-- by withInvitationAcceptContext() (packages/db/src/client.ts), for the one
-- specific token hash the caller already possesses (received via the
-- invitation email) — this cannot be used to enumerate or browse other
-- tenants' invitations, only to read/accept the exact one you were sent.
-- WITH CHECK has NO such carve-out: accepting an invitation updates status
-- via a service call using the tenant's own withTenantContext once the
-- membership has been created, never a direct write under this bootstrap
-- context.
ALTER TABLE "membership_invitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership_invitation" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_or_token ON "membership_invitation"
  USING (
    tenant_id = current_setting('app.tenant_id', true)
    OR token_hash = current_setting('app.invitation_token_hash', true)
  )
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE, DELETE ON "membership_invitation" TO noahark_app;

-- -----------------------------------------------------------------------------
-- 6. Global identity tables — NO RLS (not tenant-owned; see
--    packages/db/src/client.ts's getIdentityClient() doc comment). Full
--    CRUD for noahark_app, which is the only role that ever touches them.
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON "app_user" TO noahark_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "user_credential" TO noahark_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "account" TO noahark_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "session" TO noahark_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "verification_token" TO noahark_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "mfa_credential" TO noahark_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "mfa_recovery_code" TO noahark_app;
-- F-9 (Phase 1B.1): shared rate-limit counters — global, not tenant-owned,
-- keyed only by a hash of the email/IP. No RLS: there is no tenant to scope
-- it to (rate limiting happens before any tenant is known), and the stored
-- value is a hash, never the raw identifier.
GRANT SELECT, INSERT, UPDATE, DELETE ON "auth_rate_limit_bucket" TO noahark_app;

-- F-14/E2E (Phase 1B.1): test-only email capture — global, no RLS, same
-- posture as auth_rate_limit_bucket above. Every read/write is additionally
-- gated in application code (apps/web/lib/testEmailCapture.ts) behind
-- NODE_ENV !== "production" AND TEST_NOTIFICATION_CAPTURE === "1" — the
-- GRANT alone does not make this reachable from any real product surface.
GRANT SELECT, INSERT, DELETE ON "test_email_capture" TO noahark_app;

-- -----------------------------------------------------------------------------
-- 7. Global platform catalogue — permission (seeded, not RLS'd; read-only
--    for the app role — only the migration/system role may write it)
-- -----------------------------------------------------------------------------

GRANT SELECT ON "permission" TO noahark_app;

-- -----------------------------------------------------------------------------
-- 8. audit_event — append-only grants (NO UPDATE/DELETE — enforced twice:
--    here by the absence of the grant, and in §3 by the trigger, in case a
--    future migration ever mistakenly re-adds the grant)
--
-- F-7 (Phase 1B): platform-level rows (tenant_id IS NULL — sign-in,
-- sign-out, failed login, before any tenant is selected) used to be
-- readable by ANY connection with no tenant context set at all — including
-- withoutTenantContext(), which is used for unrelated global lookups like
-- the Permission catalogue. That meant every user's sign-in email/IP was
-- incidentally readable by any code path that happened to run unscoped.
-- Platform rows now additionally require `app.platform_audit_access =
-- 'true'`, set ONLY by the dedicated withPlatformAuditContext() wrapper
-- (packages/db/src/client.ts) — currently used only by the sign-in/sign-out
-- routes to write their own audit trail. Phase 1 has no platform-admin
-- screen; nothing else can read these rows through any product surface.
-- -----------------------------------------------------------------------------

ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;
-- IMPORTANT — a real bug found and fixed while writing this migration
-- (Phase 1B): `current_setting(name, true)` returns NULL only if `name` has
-- NEVER been touched on the current backend connection. Once ANY
-- transaction has done `set_config(name, value, true)` and then COMMITTED,
-- later calls to `current_setting(name, true)` on that SAME (pooled,
-- reused) connection return '' (empty string), not NULL — proven directly:
-- set app.tenant_id inside a transaction, commit, then read it back on the
-- same connection outside any transaction; it comes back ''. Prisma's
-- connection pool reuses connections across unrelated requests, so a
-- platform-chain write via withPlatformAuditContext() on a connection
-- previously used for an ordinary tenant-scoped request would see
-- app.tenant_id = '' rather than NULL. The original `tenant_id IS NOT
-- DISTINCT FROM current_setting(...)` WITH CHECK treats NULL and '' as
-- DISTINCT (correctly — they're different values), so inserting a
-- platform-level row (tenant_id IS NULL) on such a connection was
-- incorrectly rejected — a previously-undiscovered latent bug that would
-- have silently broken the platform audit chain (sign-in/sign-out/failed-
-- login events) in production under ordinary connection-pool reuse.
-- NULLIF(..., '') normalizes both "never touched" and "touched, then
-- reset by commit" to NULL before the comparison, closing the gap.
CREATE POLICY tenant_isolation ON "audit_event"
  USING (
    (tenant_id IS NOT NULL AND tenant_id = NULLIF(current_setting('app.tenant_id', true), ''))
    OR (tenant_id IS NULL AND current_setting('app.platform_audit_access', true) = 'true')
  )
  -- WITH CHECK deliberately has NO platform_audit_access requirement — an
  -- INSERT of a platform-level row must succeed under
  -- withPlatformAuditContext()'s (or a future withoutTenantContext())
  -- transaction regardless, since INSERT is governed by WITH CHECK alone
  -- and platform-audit-context is a READ restriction (see USING above).
  -- writeAuditEvent's own predecessor lookup (a SELECT) is what actually
  -- requires withPlatformAuditContext() for the platform chain.
  WITH CHECK (tenant_id IS NOT DISTINCT FROM NULLIF(current_setting('app.tenant_id', true), ''));
GRANT SELECT, INSERT ON "audit_event" TO noahark_app;

-- -----------------------------------------------------------------------------
-- 9. noahark_worker — queue tables only, via an explicit RLS policy rather
--    than BYPASSRLS.
--
-- F-4/F-12 (Phase 1B): noahark_worker previously had the BYPASSRLS role
-- attribute, which (a) requires CREATEROLE/superuser-equivalent privilege
-- to grant — unavailable on Azure Database for PostgreSQL Flexible Server's
-- azure_pg_admin login, breaking deployment — and (b) is a blanket
-- attribute: if this role were ever mistakenly GRANTed access to another
-- table in a future migration, BYPASSRLS would silently expose every
-- tenant's data through it with no additional review needed. Provisioning
-- (see packages/db/provisioning/provision-roles.sql) now creates
-- noahark_worker as an ordinary NOBYPASSRLS role. Its cross-tenant queue
-- visibility comes ONLY from the two permissive policies below, scoped `TO
-- noahark_worker` specifically — containment is enforced by RLS itself, not
-- merely by the absence of a GRANT elsewhere.
-- -----------------------------------------------------------------------------

-- P1E-4 (Phase 1F) / P1G (Phase 1H): noahark_worker's own grant/policy stay
-- SELECT+UPDATE only (claim/complete/fail/heartbeat/reap — queue.ts/
-- outbox.ts). DELETE is deliberately NOT granted to noahark_worker here —
-- see "Worker DELETE hardening" below: retention deletes go through two
-- narrowly-scoped SECURITY DEFINER functions instead of a direct DELETE
-- grant, so the database itself (not just application query predicates)
-- enforces which rows can ever be removed.
CREATE POLICY worker_full_access ON "background_job"
  FOR ALL TO noahark_worker
  USING (true)
  WITH CHECK (true);
GRANT SELECT, UPDATE ON "background_job" TO noahark_worker;

CREATE POLICY worker_full_access ON "outbox_event"
  FOR ALL TO noahark_worker
  USING (true)
  WITH CHECK (true);
GRANT SELECT, UPDATE ON "outbox_event" TO noahark_worker;

-- -----------------------------------------------------------------------------
-- Worker DELETE hardening (Phase 1H)
--
-- Previously noahark_worker had a direct DELETE grant on both tables, with
-- the `worker_full_access` policy (FOR ALL ... USING(true)) imposing no
-- in-database restriction on WHICH rows could be deleted — status/age
-- enforcement lived only in packages/jobs's application query predicates
-- (cleanupTerminalJobs/cleanupTerminalOutboxEvents's `where` clauses). A
-- bug or a future call site could have issued an unrestricted
-- `deleteMany()` through the same client and removed PENDING/PROCESSING
-- rows with nothing in the database to stop it.
--
-- Replaced with two SECURITY DEFINER functions, each independently
-- enforcing (inside the database, not just inside the calling TypeScript):
--   - terminal status only (SUCCEEDED/DEAD, PROCESSED/FAILED)
--   - a retention-age floor the caller cannot shorten below
--     MIN_RETENTION_MS (clamped server-side, not merely defaulted)
--   - a bounded batch size (LIMIT, capped at MAX_BATCH_SIZE)
-- and returning ONLY a deleted count — never row contents, never accepting
-- caller-supplied predicates or raw SQL. Belt-and-suspenders: the owning
-- role (noahark_maintenance_definer) additionally has its OWN RLS DELETE
-- policy on both tables restricted to terminal statuses, so even a bug
-- inside the function body's WHERE clause could not delete a
-- non-terminal row — Postgres would reject it at the row-security layer
-- independently of the function's own logic.
GRANT SELECT, DELETE ON "background_job" TO noahark_maintenance_definer;
CREATE POLICY maintenance_definer_delete_terminal ON "background_job"
  FOR DELETE TO noahark_maintenance_definer
  USING (status IN ('SUCCEEDED', 'DEAD'));
CREATE POLICY maintenance_definer_select_terminal ON "background_job"
  FOR SELECT TO noahark_maintenance_definer
  USING (status IN ('SUCCEEDED', 'DEAD'));

GRANT SELECT, DELETE ON "outbox_event" TO noahark_maintenance_definer;
CREATE POLICY maintenance_definer_delete_terminal ON "outbox_event"
  FOR DELETE TO noahark_maintenance_definer
  USING (status IN ('PROCESSED', 'FAILED'));
CREATE POLICY maintenance_definer_select_terminal ON "outbox_event"
  FOR SELECT TO noahark_maintenance_definer
  USING (status IN ('PROCESSED', 'FAILED'));

-- Phase 1H.2: `updated_at`/`created_at` are genuine PostgreSQL
-- `timestamp WITH time zone` columns (`@db.Timestamptz(3)` in
-- schema.prisma — see packages/db/src/temporalInventory.ts for the full,
-- documented inventory of every temporal column in this schema and why
-- each is classified an absolute instant). Comparing them against
-- `safe_cutoff` (also `timestamptz`) is therefore a genuine instant-vs-
-- instant comparison with NO implicit cast and no dependency on the
-- connection's session `TimeZone` GUC — the `AT TIME ZONE 'UTC'`
-- conversion Phase 1H.1 added here as a workaround for the OLD naive
-- `timestamp WITHOUT time zone` columns is removed; it is no longer
-- necessary and would now be a no-op at best, misleading at worst (it
-- would read as "this column might still be naive" when it structurally
-- cannot be). See docs/DECISION_REGISTER.md's Phase 1H.2 section for the
-- full schema-level fix and why it was preferred over accumulating
-- per-query casts across the codebase.
--
-- The minimum-retention floor is still enforced HERE, inside the
-- database, using `clock_timestamp()` — PostgreSQL's own trusted,
-- server-side wall clock — not the caller-supplied `retention_cutoff`
-- alone. `safe_cutoff := LEAST(retention_cutoff, clock_timestamp() -
-- interval '1 hour')` means the caller's cutoff can only ever NARROW
-- (move further into the past / delete less) — it can never widen past
-- the 1-hour floor, regardless of what a compromised, buggy, or directly
-- SQL-invoking worker-role caller passes: `now()`, a far-future date, or
-- an arbitrary extreme value. Verified directly (Phase 1H.1, re-verified
-- Phase 1H.2 after the column-type change): with `background_job`/
-- `outbox_event` rows at 0 minutes and 8 days old, a caller-supplied
-- cutoff of `now()`, "+1 year", and the year 9999 all produced the
-- IDENTICAL eligibility result (only the 8-day-old row) as a
-- correctly-computed cutoff would — the floor cannot be bypassed by any
-- cutoff value.
--
-- Batch size is capped (`safe_batch`, max 1000 regardless of what's
-- requested), terminal status is enforced twice (this function's own
-- WHERE clause AND `noahark_maintenance_definer`'s own RLS DELETE policy
-- above), the SQL shape is fixed (no caller-supplied predicates or raw
-- SQL), and `search_path` is fixed (search-path-injection defense, same
-- as worker_maintenance_list_tenant_ids above). Application-side
-- validation (`packages/jobs/src/queue.ts`'s own `MIN_RETENTION_MS`)
-- remains as defence in depth ONLY — it is not, and must never be
-- treated as, the authoritative control: this function enforces the
-- floor even when called directly by the worker role with a hostile
-- `retention_cutoff`, bypassing the TypeScript wrapper entirely — see
-- apps/web/tests/integration/workerDeleteHardening.test.ts's direct-role
-- adversarial tests.
CREATE FUNCTION worker_cleanup_terminal_jobs(retention_cutoff timestamptz, batch_size int)
RETURNS TABLE(deleted_count int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  safe_cutoff timestamptz := LEAST(retention_cutoff, clock_timestamp() - interval '1 hour');
  safe_batch int := GREATEST(1, LEAST(COALESCE(batch_size, 500), 1000));
  removed int;
BEGIN
  WITH eligible AS (
    SELECT "id" FROM "background_job"
    WHERE status IN ('SUCCEEDED', 'DEAD') AND updated_at < safe_cutoff
    ORDER BY updated_at
    LIMIT safe_batch
  ),
  gone AS (
    DELETE FROM "background_job" WHERE "id" IN (SELECT "id" FROM eligible)
    RETURNING "id"
  )
  SELECT count(*)::int INTO removed FROM gone;
  RETURN QUERY SELECT removed;
END;
$fn$;
ALTER FUNCTION worker_cleanup_terminal_jobs(timestamptz, int) OWNER TO noahark_maintenance_definer;
REVOKE ALL ON FUNCTION worker_cleanup_terminal_jobs(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker_cleanup_terminal_jobs(timestamptz, int) TO noahark_worker;

-- See worker_cleanup_terminal_jobs's doc comment above — identical
-- rationale and mechanism (database-enforced 1-hour floor via
-- `clock_timestamp()`, plain instant-vs-instant comparison against the
-- now-genuinely-timestamptz `created_at` column).
CREATE FUNCTION worker_cleanup_terminal_outbox_events(retention_cutoff timestamptz, batch_size int)
RETURNS TABLE(deleted_count int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  safe_cutoff timestamptz := LEAST(retention_cutoff, clock_timestamp() - interval '1 hour');
  safe_batch int := GREATEST(1, LEAST(COALESCE(batch_size, 500), 1000));
  removed int;
BEGIN
  WITH eligible AS (
    SELECT "id" FROM "outbox_event"
    WHERE status IN ('PROCESSED', 'FAILED') AND created_at < safe_cutoff
    ORDER BY created_at
    LIMIT safe_batch
  ),
  gone AS (
    DELETE FROM "outbox_event" WHERE "id" IN (SELECT "id" FROM eligible)
    RETURNING "id"
  )
  SELECT count(*)::int INTO removed FROM gone;
  RETURN QUERY SELECT removed;
END;
$fn$;
ALTER FUNCTION worker_cleanup_terminal_outbox_events(timestamptz, int) OWNER TO noahark_maintenance_definer;
REVOKE ALL ON FUNCTION worker_cleanup_terminal_outbox_events(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker_cleanup_terminal_outbox_events(timestamptz, int) TO noahark_worker;
