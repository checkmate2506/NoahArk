# NoahArk — Phase 1 Implementation Record

> What was actually built, as opposed to `docs/PHASE_01_FOUNDATION.md` (the
> pre-implementation design). Read this alongside the Phase 1 final report for
> the full picture: commands run, test results, and known gaps.

## 1. Architecture as implemented

A pnpm + Turborepo monorepo, matching `docs/TARGET_ARCHITECTURE.md`'s package
map with two deliberate simplifications recorded here (not silently dropped):

- **No separate `packages/api`.** API conventions (correlation IDs, the
  `{ data } | { error }` envelope, idempotency) live directly in
  `apps/web/lib/apiHandler.ts` since Phase 1 has exactly one API consumer.
  Extracting a shared package makes sense once a second consumer exists.
- **Local Docker Compose is Postgres-only**, not Postgres+MinIO+Mailpit as
  originally proposed. Files use a local-filesystem `StorageProvider`
  (`packages/files`) and email uses a console-logging `EmailProvider`
  (`packages/notifications`) — both explicitly permitted by
  `docs/PHASE_01_FOUNDATION.md` §11/§10 as Phase 1 substitutes, so the extra
  containers weren't needed.

### Technology deviations from the original baseline

- **Auth.js was replaced with a custom database-session implementation**
  (`apps/web/lib/session.ts`). Auth.js v5's Credentials provider does not
  cleanly support `session: "database"` — `authorize()` returning a user does
  not trigger `adapter.createSession`, and this needs to be wired manually, per
  community guidance found during implementation. Rather than ship an
  integration that couldn't be exercised end-to-end with confidence, Phase 1
  implements its own small, directly-tested DB session layer (SHA-256-hashed
  opaque tokens, 30-day expiry, disabled-user and membership-suspension
  enforcement) against the _same_ `Session`/`Account`/`User`/`VerificationToken`
  tables Auth.js's Prisma adapter expects — so a real Auth.js OAuth/SSO
  provider (AD-4, a later phase) can be added on top of the same schema
  without a migration.
- **Prisma 7** (not 5/6) — the only version available at implementation time.
  This mandated the new `prisma-client` generator, driver adapters
  (`@prisma/adapter-pg`), and `prisma.config.ts` in place of schema-embedded
  datasource URLs. Documented since it changes several conventions from
  older Prisma docs (e.g. `prisma migrate diff --to-schema`, not
  `--to-schema-datamodel`).
- **`embedded-postgres` for local/CI Postgres** instead of Testcontainers/Docker
  — see §7 (Testing) below. This is dev/CI tooling only; production still
  targets a real managed PostgreSQL instance.

## 2. Database schema

37 tables (see `packages/db/prisma/schema.prisma`), organised as:

- **Tenant & legal entity**: `tenant`, `tenant_entitlement`, `tenant_setting`,
  `legal_entity`, `legal_entity_setting`.
- **Organisational structure**: `business_unit`, `department`, `team`,
  `branch`, `warehouse`, `cost_centre` — thin, structural only in Phase 1.
- **Identity**: `app_user`, `user_credential`, `account`, `session`,
  `verification_token` — global, not tenant-owned (LEGAL_ENTITY_ARCHITECTURE.md:
  "User — global identity").
- **Membership**: `tenant_membership`, `legal_entity_membership` — access to
  one legal entity is never implied by tenant membership.
- **RBAC**: `permission` (global catalogue), `role`, `role_permission`,
  `membership_role` (role assignment, optionally legal-entity-scoped).
- **Field-level access**: `field_policy` (foundation only — no real protected
  fields exist yet; see `PERMISSIONS.DEMO_PROTECTED_FIELD_READ` for the
  self-test).
- **Approvals**: `approval_policy`, `approval_step`, `approval_request`,
  `approval_decision`, `demo_approval_subject` (the neutral demonstration
  resource — no invoice/payroll/expense workflow exists).
- **Audit**: `audit_event` — append-only, hash-chained, nullable `tenant_id`
  (platform-level events chain separately from tenant events).
- **Jobs & outbox**: `background_job`, `outbox_event`.
- **Notifications**: `notification`, `notification_preference`.
- **Files**: `file_object`, `attachment`.
- **Custom fields**: `custom_field_definition`, `custom_field_value`.
- **API idempotency**: `idempotency_key`.

Every tenant-owned table carries `tenant_id`; every legal-entity-scoped table
also carries `legal_entity_id`. See §4 for how these are enforced.

## 3. Authentication

- Argon2id via `@node-rs/argon2` (prebuilt binaries — chosen over `argon2`,
  which requires a native build toolchain).
- Opaque, 256-bit random session tokens; only the SHA-256 hash is persisted
  (mirrors why passwords are never stored in plaintext).
- Sign-in: `POST /api/v1/auth/sign-in` — rate-limited (in-memory, keyed on
  BOTH email and source IP with independent thresholds — F-9, Phase 1B;
  documented single-process limitation, see `apps/web/lib/rateLimiter.ts`),
  checks `user.isDisabled`, audits both success and failure (as a
  platform-level, `tenantId: null` audit event — sign-in precedes tenant
  selection). Password verification always runs (against a real hash or a
  fixed dummy hash of identical cost) to avoid a timing side-channel for
  account enumeration (F-9). If the user has confirmed TOTP MFA (§12),
  password verification alone does not issue a session — see the MFA
  section of §12 for the full challenge flow.
- Sign-out: `POST /api/v1/auth/sign-out` — deletes the session row
  (`invalidateSession`); `invalidateAllSessionsForUser` also exists for a
  future "sign out everywhere" admin action.
- Email verification and TOTP MFA (§12, Phase 1B) sit alongside this as
  independent, composable pieces — a user's password credential, email
  verification state, and MFA enrolment are each tracked and enforced
  separately.
- Middleware (`apps/web/middleware.ts`) does a coarse, Edge-safe
  cookie-presence check to redirect unauthenticated users — explicitly **not**
  the authorization boundary (SECURITY_AND_TENANCY.md: "UI visibility is not
  authorization"). Every page and API route independently re-validates via
  `requireCurrentUser()`/`getAccessContext()`, which always hits the database.

## 4. Tenant and legal-entity isolation

Enforced at **two independent layers** (plus a THIRD, application-process
sanity check added in Phase 1B — see below):

### Application layer

`AccessContext` (`packages/core/src/context.ts`) is built exactly once per
request by `getAccessContext(userId, tenantId, meta)`
(`apps/web/lib/context.ts`), which:

1. Resolves the caller's `TenantMembership` for the requested tenant —
   `ForbiddenError` if none, or not `ACTIVE`.
2. Resolves `LegalEntityMembership` rows for that tenant — `ctx.legalEntityIds`
   contains only entities actually granted, never implied by tenant access.
3. Resolves `MembershipRole` assignments (tenant-wide and legal-entity-scoped
   separately) into `ctx.permissions` / `ctx.legalEntityPermissions` and
   `ctx.roleIds` / `ctx.legalEntityRoleIds`.

The requested `tenantId` is a client-supplied **hint** of which of the
caller's own tenants to act in — never trusted directly; every value in the
resulting context is independently re-derived from the database.

`authorize()` (`packages/authz/src/authorize.ts`) is the mandatory gate,
implementing checks 2–4 of the six-check model
(SECURITY_AND_TENANCY.md §3): legal-entity access, module permission, record
scope. `authorizeField()`/`maskProtectedFields()` implement check 5
(field-level). Approval authority (check 6) is separate — role-based, not
permission-based — see `packages/workflow`.

### Database layer (Row-Level Security)

`packages/db/prisma/migrations/20260817000002_rls_and_constraints/migration.sql`
enables RLS on every tenant-owned table, keyed off two per-transaction
session variables set via `set_config()` (parameterized — never string-
interpolated SQL): `app.tenant_id` and `app.legal_entity_ids`. Three
Postgres roles:

| Role                 | RLS                                                         | Access                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `noahark_app`        | Fully enforced                                              | Every ordinary application query                                                                                                                                                                                                                                                                                                               |
| `noahark_worker`     | **Fully enforced** (F-12, Phase 1B — no longer `BYPASSRLS`) | Cross-tenant visibility into `background_job`/`outbox_event` comes from an explicit RLS policy scoped `TO noahark_worker` on exactly those two tables — never GRANTed any other table, so it cannot read business data even if compromised, and the containment is enforced by RLS itself rather than resting on the absence of a future GRANT |
| migration/owner role | N/A (superuser or FORCE-exempt owner)                       | Migrations, `packages/db/provisioning/provision-roles.mjs`, `prisma/seed.ts`                                                                                                                                                                                                                                                                   |

Key policy patterns (see the migration file's own header comment for the
full rationale):

- **Bootstrap carve-out**: `tenant`, `tenant_membership` and
  `legal_entity_membership` additionally allow `USING` (read) access when
  `user_id = current_setting('app.user_id', true)` (or, for `tenant`, an
  `EXISTS` against the caller's own active membership) — resolving "which
  tenants/entities do I belong to" is otherwise circular (you'd need
  `app.tenant_id` set to read the very table that tells you what it should
  be). `WITH CHECK` (write) never carries this carve-out.
- **Legal-entity-scoped tables** use
  `legal_entity_id = ANY(string_to_array(current_setting('app.legal_entity_ids', true), ','))`,
  with an `OR legal_entity_id IS NULL` branch for tables where a NULL
  legal-entity means "tenant-wide", not "unscoped".
- **`audit_event`** uses `tenant_id IS NOT DISTINCT FROM current_setting(...)`
  so `NULL = NULL` correctly matches (platform-level events).
- A connection with **no context set at all** matches zero rows everywhere —
  secure by default, never "all rows" (verified directly: see §7).

### Application-process layer (F-3C, Phase 1B)

A Prisma Client Extension (`packages/db/src/guardExtension.ts`) additionally
denies, in-process and before any query reaches the database, a query
against a tenant-owned model with no active tenant scope. This is NOT a
replacement for RLS above — it is a fail-fast sanity check on top of it,
using `AsyncLocalStorage` state this same process set, so it cannot detect
a bug in RLS itself; RLS remains what makes cross-tenant access
structurally impossible. See §12 for the full design.

## 5. RBAC and field-level controls

Permission catalogue: `packages/authz/src/permissions.ts` (`PERMISSIONS`
constant + `PERMISSION_CATALOG` array — the single source of truth `seed.ts`
and every `authorize()` call site import from). Full list in §Permission
catalogue below.

Two system roles seeded per tenant, both `isSystem: true`:

- **`tenant_admin`** — every foundation permission.
- **`member`** — read-only + self-service (submit approvals, upload/read
  files).

System-role protection is enforced at **three** layers:

1. Application (`roleService.ts` checks `role.isSystem` before allowing
   permission changes or deletion).
2. Database triggers (`protect_system_role_permissions`,
   `protect_system_role_deletion`) — bypassed only for
   `current_user <> 'noahark_app'`, so `prisma/seed.ts` (which runs as the
   owner role) can seed system roles while the live application cannot ever
   modify or delete one.

Self-escalation guards (`assertCanAssignRole`, `assertCanGrantLegalEntityAccess`
in `packages/authz`): a user can never modify their own role assignment,
grant themselves legal-entity access, or grant a role/permission they do not
themselves hold.

Field-level foundation: `FieldPolicy` table + `authorizeField()`/
`maskProtectedFields()`. No real protected fields exist in Phase 1 (no
HR/payroll data) — `PERMISSIONS.DEMO_PROTECTED_FIELD_READ` exists purely to
prove the mechanism end-to-end (see the unit tests in
`packages/authz/src/authorize.test.ts`).

## 6. Audit, approvals, jobs/outbox, files, module entitlements

- **Audit**: `packages/audit` (pure: sanitisation, hash chain) +
  `apps/web/lib/services/auditService.ts` (DB-touching: reads the chain's
  latest hash and sequence and inserts, holding a `pg_advisory_xact_lock`
  for the duration so concurrent writers to the same chain can never race
  and fork it). Append-only enforced by both absent GRANTs and an
  unconditional block trigger for the `noahark_app`/`noahark_worker`
  roles — see §9 below for the precise, corrected boundary of what this
  guarantees (it is tamper-evident and strongly tamper-resistant in normal
  operation, not absolutely immutable against the database owner).
- **Approvals**: `packages/workflow` (pure state machine — `decide()`,
  `assertApprovalAuthority()`, `validateStepSequence()`) +
  `apps/web/lib/services/approvalService.ts` (DB-touching, with a
  DB-level optimistic-concurrency guard via `updateMany({ where: { version } })`
  in addition to the in-memory check). Demonstrated via
  `DemoApprovalSubject`, never a business document.
- **Jobs/outbox**: `packages/jobs` — `SELECT ... FOR UPDATE SKIP LOCKED` for
  safe concurrent claiming, exponential backoff with jitter on retry,
  terminal `DEAD` state after `maxAttempts`. A standalone worker entrypoint
  (`apps/web/scripts/worker.ts`) exists so the mechanism is exercised
  end-to-end, though no job/outbox handler types are registered yet — Phase 1
  has no business events to react to.
- **Files**: `packages/files` — real content-type sniffing via `file-type`
  (never trusts the client's filename or `Content-Type`), path-traversal-safe
  local storage provider, HMAC-signed short-lived download URLs (the
  signature itself is the authorization artifact for the unauthenticated
  `/api/v1/files/local/[...key]` serving route — the check already happened
  when the URL was signed). Soft-delete only; malware scanning is **not
  implemented** — the integration point is documented directly in
  `fileService.ts` (immediately before `storage.put`), with no placeholder
  scan function that could be mistaken for real protection.
- **Module entitlements** (`TenantEntitlement` + `entitlementService.ts`):
  foundation for SaaS plan enforcement (AD-2 defers billing itself).
  `assertModuleEnabled()` gates approvals and file upload independent of the
  caller's permissions — proven by a dedicated negative test.

## 7. Testing

### What actually ran, and against what

- **Unit tests** (no database): 90+ tests across `packages/core`, `authz`,
  `audit`, `workflow`, `auth`, `files`, `config`, `jobs` — pure logic
  (permission evaluation, jurisdiction/currency validation, approval
  transitions, audit sanitisation/hash-chain, idempotency helpers, settings
  validation, path-traversal rejection, signed-URL verification).
- **Integration tests** (`apps/web/tests/integration/`, 33 tests as of this
  section's original writing): run against a **real Postgres instance** —
  not mocked, not an in-memory substitute. No Docker was available in the
  implementation environment, so `embedded-postgres` (downloads and runs a
  genuine Postgres binary) served the same role Testcontainers/Docker
  Compose would in an environment where they're available; this is dev/CI
  tooling only. This section originally described that instance as
  PostgreSQL 16; the `embedded-postgres` package version pinned by the
  project has since moved to a PostgreSQL 18.4 build, which is what routine
  development and CI test runs actually exercise today (dev/CI coverage
  only — see the "Phase 1 pre-commit cleanup" ADR-66 in
  `docs/DECISION_REGISTER.md`). **PostgreSQL 16 remains the production
  compatibility baseline** (matching `README.md` and `docker-compose.yml`'s
  `postgres:16-alpine`) and has now been independently verified as of that
  cleanup: role provisioning, migration deploy (fresh + idempotent second
  deploy), migration status/drift, temporal schema conformance, RLS/
  database-role tests, job/outbox/lease/retention/timezone tests, and the
  complete integration suite (run five consecutive times) all pass against
  a genuine PostgreSQL 16.14 instance, and twice against PostgreSQL 18.4 —
  see the "PostgreSQL 16 integration-stability remediation" ADRs (ADR-67–
  ADR-69) in `docs/DECISION_REGISTER.md` for the full evidence trail. That
  remediation also **corrects** the pre-commit cleanup's own claim above:
  an intermittent "Worker exited unexpectedly" failure first attributed to
  concurrent test interference was independently reproduced with zero
  concurrent activity and root-caused instead to an environment-level
  mechanism that externally terminates a spawned OS process (not
  PostgreSQL, not Prisma, not this repository's test code); the exact
  terminator was not identified. The integration project now runs on
  Vitest's thread pool (`pool: "threads"` in `apps/web/vitest.config.ts`),
  which removes the separate forked Vitest worker process that mechanism
  was hitting — this changes the failure mode from a silent partial-worker
  corruption to a whole-run fail-stop if the same mechanism ever targets
  the main Vitest process instead, but it is **not** immunity from
  external termination. See ADR-68/ADR-69 in
  `docs/DECISION_REGISTER.md` for the evidence-scoped root-cause wording.
  Every test exercises the
  real service layer end-to-end, including actual RLS enforcement (not
  mocked authorization). Covers: tenant lifecycle, legal-entity
  create/update with the jurisdiction/currency CHECK constraint, the full
  approval submit→decide flow, Postgres-backed job claim/retry/dead-letter
  and outbox processing, file upload with real magic-byte sniffing, and
  **all 16 mandatory negative security tests** (cross-tenant read/write,
  cross-legal-entity read/write, tenant/legal-entity substitution,
  self-role-escalation, unauthorised role assignment, disabled/suspended
  membership, audit immutability, attachment ID enumeration, approval
  without authority, duplicate approval, disabled-module access, and a
  connection with no context set seeing zero rows).
- **Production build**: `next build` (Turbopack) succeeds — every route
  (27 API routes, 8 admin pages) compiles and prerenders cleanly.
- **Manual browser verification**: extensive, across both the original
  implementation and the Phase 1B remediation — sign-in (including the
  origin-matching sensitivity introduced by F-8's CSRF check — see §9),
  tenant overview, audit log, legal-entities list, and — end-to-end through
  the real UI, not just tests — creating a membership invitation, following
  its accept link, and landing auto-signed-in with the correct tenant
  membership and role provisioned. An earlier session's browser tool had a
  compositor limitation that blocked click-through testing entirely; that
  was specific to that tool session and did not recur.
- **E2E (Playwright)**: `apps/web/tests/e2e/foundation.spec.ts` — **executed
  and passing (3/3)**, twice, against the real production build, a real
  migrated+seeded Postgres database, and a real installed Chromium browser.
  Previously reported as "not executed" due to two compounding issues, both
  fixed in Phase 1B: (1) `playwright.config.ts` never loaded `.env` at all,
  so every spec failed immediately with `DATABASE_MIGRATION_URL is not set`
  — fixed via a `globalSetup` hook (`tests/e2e/globalSetup.ts`) that loads
  and validates the environment (also refusing a production-looking target,
  mirroring the seed script's own safety gate); (2) the installed Chromium
  build (1228) didn't match what `@playwright/test` required (1234) — fixed
  by running `pnpm exec playwright install chromium`. The suite also no
  longer depends on `pnpm db:seed`'s output at all (F-1 made the seeded
  admin password random and unpredictable) — it provisions its own tenant,
  admin-equivalent user, and restricted user directly, and tears them down
  afterward.

## 8. A real bug found and fixed during verification

Manual browser testing (§7) caught a genuine RLS gap: `tenant`'s policy had
no bootstrap carve-out (unlike `tenant_membership`/`legal_entity_membership`).
`listMyTenants()` joins `tenant_membership → tenant` inside the
user-context bootstrap transaction (`app.tenant_id` deliberately unset); RLS
applied to that join exactly as it would a direct query, so the membership
row came through (via its own carve-out) but the joined `tenant` came back
`NULL` — crashing `.filter(m => m.tenant.status === "ACTIVE")`. Fixed by
adding an `EXISTS`-against-the-caller's-own-membership branch to `tenant`'s
policy (present in the migration file as committed — this was caught and
fixed _before_ the migration was treated as final, not patched around it).
Verified by re-running all 33 integration tests (still green) and re-testing
the actual sign-in → tenant-overview flow in the browser.

## 9. Permission catalogue

| Key                              | Category     | Description                                                   |
| -------------------------------- | ------------ | ------------------------------------------------------------- |
| `tenant:read`                    | tenant       | View tenant details                                           |
| `tenant:update`                  | tenant       | Update tenant details and status                              |
| `legal_entity:read`              | legal_entity | View legal entities                                           |
| `legal_entity:create`            | legal_entity | Create a legal entity                                         |
| `legal_entity:update`            | legal_entity | Update a legal entity                                         |
| `membership:read`                | membership   | View tenant memberships                                       |
| `membership:invite`              | membership   | Invite a user to the tenant                                   |
| `membership:update`              | membership   | Suspend/reactivate a tenant membership                        |
| `legal_entity_membership:read`   | membership   | View legal-entity access grants                               |
| `legal_entity_membership:grant`  | membership   | Grant a user access to a legal entity                         |
| `legal_entity_membership:revoke` | membership   | Revoke a user's legal-entity access                           |
| `role:read`                      | role         | View roles and permissions                                    |
| `role:create`                    | role         | Create a custom role                                          |
| `role:update`                    | role         | Update a non-system role's permissions                        |
| `role:delete`                    | role         | Delete a non-system role                                      |
| `role:assign`                    | role         | Assign a role to a membership                                 |
| `settings:read`                  | settings     | View tenant/legal-entity settings                             |
| `settings:update`                | settings     | Update tenant/legal-entity settings                           |
| `approval_policy:manage`         | approval     | Manage approval policies and steps                            |
| `approval:submit`                | approval     | Submit a request for approval                                 |
| `approval:decide`                | approval     | Approve, reject or cancel an approval request                 |
| `approval:read`                  | approval     | View approval requests and history                            |
| `audit:read`                     | audit        | View audit events                                             |
| `file:upload`                    | file         | Upload a file                                                 |
| `file:read`                      | file         | Read/download a file                                          |
| `file:delete`                    | file         | Delete (soft) a file                                          |
| `file:administer`                | file         | Administer files across the tenant                            |
| `job:read`                       | job          | View background job status                                    |
| `job:administer`                 | job          | Retry/cancel background jobs                                  |
| `outbox:read`                    | job          | View outbox event status                                      |
| `outbox:administer`              | job          | Administer outbox events                                      |
| `field_policy:manage`            | field_policy | Manage field-level access policies                            |
| `demo.protected_field:read`      | demo         | Read the demo protected field (field-level-control self-test) |

`tenant_admin` holds all of the above; `member` holds
`tenant:read`, `legal_entity:read`, `membership:read`, `role:read`,
`settings:read`, `approval:submit`, `approval:read`, `file:upload`,
`file:read`.

## 10. API conventions

- **Base path**: `/api/v1`.
- **Envelope**: `{ "data": ... }` on success, never a bare array/object;
  `{ "error": { "code", "message", "details"?, "requestId" } }` on failure.
  `code` is one of `AppErrorCode` (packages/core/src/errors.ts) — stable,
  client-safe, never a stack trace or driver error message.
- **Correlation**: every response carries `x-request-id` (propagated from the
  request header if present, generated otherwise).
- **Idempotency**: enqueueing supports an `idempotencyKey` (jobs);
  `IdempotencyKey` table exists for request-level idempotency (foundation —
  not yet wired into every mutating route, since Phase 1's mutations are
  mostly naturally idempotent via unique constraints or explicit checks).
- **Optimistic concurrency**: `ApprovalRequest.version`, checked both
  in-memory (the pure `decide()` function) and at the database level
  (`updateMany({ where: { version } })`).
- **Auth**: opaque `noahark_session` HttpOnly cookie, `SameSite=Lax`. No JWT
  anywhere.
- **CSRF (F-8, Phase 1B)**: every state-changing request (`POST`/`PUT`/
  `PATCH`/`DELETE`) through `apiHandler` additionally requires its `Origin`
  header to match a trusted-origins allowlist (`AUTH_URL` + optional
  `TRUSTED_ORIGINS`) — see `apps/web/lib/csrf.ts`. Defense-in-depth on top
  of `SameSite=Lax`, which alone does not protect against a same-site/
  subdomain attacker. **Operational note**: `AUTH_URL` must exactly match
  the origin the app is actually reached at (scheme+host+port) —
  `localhost` and `127.0.0.1` are different origins even on the same
  machine; a mismatch rejects every mutating request with 403.
- **OpenAPI**: `apps/web/openapi.yaml` — representative coverage (auth,
  tenant, legal-entity create/validate, approval decide), not
  code-generated and not exhaustive of all routes; a later phase should
  either generate it from the Zod schemas or expand it by hand. **Not
  extended in Phase 1B** despite the growth in routes (invitations, email
  verification, MFA) — tracked as a known gap, not silently dropped.

## 11. Deferred / explicitly out of scope for Phase 1

- Any CRM/accounting/payroll/tax/invoicing/purchasing/projects functionality.
- Any statutory formula, rate, or schema (GST/SST/PPN/CPF/EPF/SOCSO/BPJS/PPh21/
  e-invoicing) — see `docs/REGULATORY_SOURCE_REGISTER.md`.
- Enterprise SSO/OAuth (AD-4) — schema is ready, not wired.
- External billing/payment charging (AD-2).
- Production email delivery (AD-3) — console-only in Phase 1.
- MinIO/S3-compatible object storage — local filesystem provider only.
- Malware scanning on file upload — integration point documented, not built.
- Fixed assets (AD-8).
- A UI toggle for module entitlements (the mechanism exists and is tested;
  no admin screen exposes it yet).
- Full OpenAPI coverage of every route (§10).
- Revocable/versioned signed file-download URLs — soft-deleting a file does
  not invalidate a URL already issued for it within its 5-minute TTL. A
  known, not-yet-fixed gap (Phase 1A finding F-15).
- Background-job/outbox worker lease/crash-recovery — a worker that crashes
  mid-job leaves that job stranded in `PROCESSING` forever (proven by a
  direct test during the Phase 1A review); no reaper reclaims it. A known,
  not-yet-fixed gap (F-19). The worker also does not itself re-establish an
  RLS-scoped context for business-data access during a job — job/outbox
  handlers that touch tenant-owned tables must call `withTenantContext`
  themselves using the tenant/legal-entity ids carried on the claimed job
  row; Phase 1 has none registered, so this is unexercised (F-20).

## 12. Phase 1B remediation record

Phase 1A (an independent review) found 7 blocking issues and ~25 additional
findings against the original Phase 1 implementation. This section records
what Phase 1B fixed, what changed structurally, and what is honestly still
open — see the Phase 1B final report for the complete findings-by-findings
disposition; this section is the durable summary.

### Audit integrity — the corrected boundary (F-2)

Earlier documentation (and the original Phase 1 final report) described
audit immutability as absolute. That overclaimed. The accurate description,
verified directly against the database:

- **Append-only for the `noahark_app` and `noahark_worker` roles** — the
  only roles the running application ever uses. Both the trigger AND the
  absence of UPDATE/DELETE grants enforce this; there is no code path in
  the application that can mutate or delete an audit row.
- **Tamper-evident** via the SHA-256 hash chain (now sequence-keyed — see
  below), independently verifiable with
  `packages/db/scripts/verify-audit-chain.ts`.
- **Strongly tamper-resistant in normal operation** — even a superuser
  `UPDATE`/`DELETE` is rejected by the trigger (verified directly).
- **Not absolutely immutable against the table owner or a privileged
  operator**: `ALTER TABLE audit_event DISABLE TRIGGER ...` succeeds for
  the owning/migration role (verified directly). This is an inherent
  property of PostgreSQL trigger-based enforcement, not a defect specific
  to this schema — no ordinary application-layer mechanism can prevent an
  operator with DDL privilege on the database from altering its own
  enforcement. The compensating controls are operational, not
  cryptographic: the migration/owner credential must be tightly held and
  distinct from any credential the running application ever uses (already
  true here — see §Database provisioning below), and
  `verify-audit-chain.ts` should be run periodically/out-of-band so
  tampering is detected even though it cannot be made impossible.

### Audit chain — sequence-keyed, not timestamp-ordered (F-6)

A real, previously-undiscovered bug: the original chain-predecessor lookup
used `ORDER BY created_at DESC`. `audit_event.created_at` is
`TIMESTAMP(3)`, and back-to-back writes tie at that precision routinely
under real concurrency (measured directly: 1000/1000 ties in a tight
loop). The `pg_advisory_xact_lock` serializes writers to the same chain,
but does not prevent two writes from tying on `created_at` — the
predecessor lookup could then pick either one, non-deterministically,
capable of forking the chain.

Fixed by adding `chain_key` (the tenant id, or the literal `__platform__`
for pre-tenant-selection events) and a monotonic `sequence` (`BigInt`,
unique per `(chain_key, sequence)`) to `audit_event`. The predecessor is
now looked up by `sequence DESC`, which has no ties by construction
(allocated exactly once per write, under the same advisory lock). The hash
itself now covers `chainKey` and `sequence` too, so tampering with either
is caught by hash recomputation, not just the uniqueness constraint. See
`packages/audit/src/hashChain.ts` and
`apps/web/lib/services/auditService.ts`.

A SECOND, independently-discovered bug surfaced while fixing the first:
`current_setting(name, true)` returns NULL only if `name` was never
touched on the current backend connection — once touched and the setting
transaction committed, later reads on that SAME pooled connection return
`''` (empty string), not NULL (verified directly). Prisma's connection
pool reuses connections across unrelated requests, so a platform-chain
write immediately after an ordinary tenant-scoped request could land on a
connection where `app.tenant_id` was `''` rather than genuinely unset —
and the audit_event policy's original `IS NOT DISTINCT FROM` WITH CHECK
treated NULL and `''` as distinct (correctly, as values — but this meant a
legitimate platform-chain write could be spuriously rejected). Fixed with
`NULLIF(current_setting(...), '')` in the RLS policy. See the RLS
migration's §8 comment and the regression test in
`apps/web/tests/integration/security.test.ts` ("writes a platform audit
event correctly even on a connection previously used for a real tenant").

### Platform audit isolation (F-7)

The platform chain (sign-in/sign-out/failed-login, before tenant
selection) was previously readable by any connection with no tenant
context set at all — including `withoutTenantContext()`, used for
unrelated global lookups. Every user's sign-in email/IP was incidentally
readable by any such code path. Fixed with a dedicated
`withPlatformAuditContext()` (`packages/db/src/client.ts`), the only
context that sets `app.platform_audit_access = true`; the RLS policy now
requires that exact setting for `tenant_id IS NULL` rows. Phase 1 has no
platform-administrator screen, so platform events are not reachable
through any product surface today — the plumbing exists for a future one.

### Database provisioning and Azure portability (F-4, F-12)

Role creation and `GRANT CONNECT ON DATABASE <hardcoded name>` used to live
inside the RLS migration itself, requiring the connecting role to have
CREATEROLE/superuser-equivalent privilege and assuming a database
literally named `noahark`. Both break on Azure Database for PostgreSQL
Flexible Server. Fixed by splitting provisioning into
`packages/db/provisioning/provision-roles.mjs` — idempotent, parameterised
by the database name (parsed from the connection string, never
hardcoded), safe to re-run without resetting an already-rotated password —
which must run once per environment BEFORE `prisma migrate deploy`.
`noahark_worker` no longer uses the `BYPASSRLS` role attribute (which also
requires elevated privilege to grant); its cross-tenant visibility into
`background_job`/`outbox_event` comes from an explicit RLS policy scoped
`TO noahark_worker` instead — verified directly: the worker can read jobs
across tenants but a live probe confirmed `permission denied` against
`tenant`/`tenant_setting`. See ADR-30/ADR-31 in
`docs/DECISION_REGISTER.md`.

**Azure operational assumptions still requiring specialist confirmation**
(not newly introduced by this fix, but worth restating): the exact
`azure_pg_admin` privilege set on the target Flexible Server instance,
network/firewall configuration, connection-pooling behaviour under
PgBouncer if used (transaction-mode pooling can interact with `SET LOCAL`
semantics — `withTenantContext` relies on `set_config(..., true)` being
transaction-scoped), and backup/point-in-time-recovery configuration.

### Tenant/legal-entity guard extension (F-3C)

A Prisma Client Extension (`packages/db/src/guardExtension.ts`) now denies,
in the application process itself, BEFORE a query reaches the database,
any query against a tenant-owned model with no active tenant scope, or a
write to a legal-entity-**required** model (org-structure tables — no
"tenant-wide" case exists for these) when the caller has zero legal-entity
grants. Deliberately NOT applied to legal-entity-**nullable** models
(approvals, files, notifications, etc.) for writes, since a caller with
zero grants can still legitimately create a tenant-wide row there (e.g. a
member submitting a demo approval) — the guard's own model classification
(`packages/db/src/tenantOwnedModels.ts`) is cross-checked against
`schema.prisma` by a dedicated test so it cannot silently drift as models
are added.

This is explicitly a SECOND, independent layer on top of PostgreSQL RLS,
not a replacement — RLS is what makes cross-tenant access structurally
impossible even if this guard has a bug; the guard exists so a scoping
mistake fails immediately with a specific error instead of silently
returning zero rows. Tracked via `AsyncLocalStorage`
(`packages/db/src/tenantScopeContext.ts`), set by
`withTenantContext`/`withUserContext`/`withPlatformAuditContext`/
`withoutTenantContext`. Nine dedicated negative tests
(`apps/web/tests/integration/tenantGuard.test.ts`) cover representative
read/create/update/delete calls, the legal-entity-required heuristic
(both a true positive and a deliberate false-positive avoidance for the
nullable case), and confirm global (non-tenant-owned) models remain
reachable with no scope at all.

### Email verification (F-3A)

Built on the **existing** `VerificationToken` table (Auth.js adapter
contract — was granted to `noahark_app` but never used by any code path)
rather than a new one. `apps/web/lib/services/emailVerificationService.ts`
— random 256-bit token, only its SHA-256 hash persisted, 24-hour expiry,
single-use (deleted on confirmation), resend supersedes any previous
pending token for the same email, generic error messages (no oracle for
token existence/expiry/reuse). Routes: `POST /api/v1/auth/verify-email/
request` (authenticated), `POST /api/v1/auth/verify-email/confirm`
(public — the token is the authorization artifact). Minimal UI at
`/verify-email`.

### TOTP MFA (F-3B)

- **`packages/auth/src/totp.ts`** — RFC 6238 TOTP built directly on Node's
  `crypto` (HMAC-SHA1) rather than adding a dependency; correctness
  verified against the RFC 4226 Appendix D test vectors (10 exact-match
  unit tests), not just "it seems to produce 6 digits." 30-second step,
  ±1 step drift tolerance, timing-safe comparison.
- **`packages/auth/src/mfaSecretCrypto.ts`** — the TOTP secret is
  encrypted at rest with AES-256-GCM, keyed by SHA-256(`AUTH_SECRET` +
  a fixed label) — the same key-separation pattern as the file-signing
  key, no second required secret.
- **`packages/auth/src/recoveryCodes.ts`** — 10 single-use recovery codes,
  only their SHA-256 hashes persisted (`MfaRecoveryCode`, one row per
  code).
- **Two-step enrolment**: `enrollMfa()` generates and stores an
  UNCONFIRMED secret; `confirmMfaEnrollment()` requires a valid code
  against it before `confirmedAt` is set and recovery codes are issued —
  an unconfirmed secret never gates sign-in.
- **Sign-in integration**: password verification for a user with confirmed
  MFA does not issue a session — it returns a short-lived (5-minute)
  challenge token (built on the same `VerificationToken` table, a
  different identifier prefix), exchanged for a session only after a
  valid TOTP or recovery code at `POST /api/v1/auth/mfa/challenge`. The
  challenge token is consumed on every attempt, success or failure — no
  unlimited retries against one password-verification proof.
- **Disable requires re-authentication** (current password), and cascades
  to delete all recovery codes.
- A dedicated test asserts no MFA secret or recovery code ever appears in
  any audit event row, by inspecting the actual persisted rows (not just
  the call sites).

### Membership invitations (F-3E)

The `membership:invite` permission existed in the catalogue since Phase 1
but had no implementation. `MembershipInvitation` (new table, RLS-scoped
like `tenant_membership`/`legal_entity_membership`'s bootstrap carve-out,
but keyed by the invitation's own token hash rather than a user id — see
`withInvitationAcceptContext()` and the RLS migration's dedicated policy,
since the accepting identity may not have a `User` row yet at all).

- **Authority checks at invite time**: an inviter cannot invite someone
  into a role carrying permissions the inviter does not hold themselves
  (mirrors `assertCanAssignRole`'s rule), and cannot grant legal-entity
  access to an entity the inviter was not themselves granted. Phase 1 does
  not re-check authority at acceptance time (7-day TTL; a later phase
  could add this if invitations become longer-lived).
- **Acceptance** (`POST /api/v1/invitations/accept`, public — the token is
  the authorization artifact) resolves or creates the `User` (a password
  is required only if no account exists yet for the invited email),
  creates the `TenantMembership`, optionally the intended
  `MembershipRole`/`LegalEntityMembership`, marks the invitation
  `ACCEPTED`, and auto-signs the user in. `createSession()` runs AFTER the
  provisioning transaction commits, not inside it — session creation uses
  a separate connection (the shared identity client) and would otherwise
  violate the not-yet-committed new user's foreign key.
- Verified end-to-end through the real admin UI, not just tests: create an
  invitation → the accept link is surfaced in the UI (Phase 1 has no
  production email provider, AD-3) → following it provisions the account
  and lands the new user, auto-signed-in, on the tenant overview with the
  correct legal entities visible.
- Minimal admin UI: `InviteMemberForm`/`RevokeInvitationButton` on the
  Users & access page; a public `/invitations/accept` page.

### Audit outbox writer — the three-mechanism boundary (F-3D)

Clarified, not newly built from scratch — the primitives (`writeAuditEvent`,
`emitOutboxEvent`) already existed; what was missing was the explicit
boundary and a proven call site combining them:

1. **Synchronous security audit event** — written directly, in the same
   transaction as the business mutation, by the request-handling process.
   Never routed through a worker, so it can never be lost to a worker
   failure. The authoritative record.
2. **Transactional outbox event** — also written in the same transaction,
   but NOT the audit trail; a durable, at-least-once queue row for later
   asynchronous fan-out, with its own independent retry/failure accounting
   via the existing outbox worker mechanics.
3. **Asynchronous delivery** — what actually consumes (2). Phase 1
   registers no handlers (no external integrations exist yet), so an
   emitted outbox event sits `PENDING` until a later phase adds one — the
   audit record from (1) is unaffected either way.

`writeAuditEventAndOutbox()` (`apps/web/lib/services/auditService.ts`)
wires both together for one representative flow
(`roleService.assignRole` → `membership_role.assigned`), proven
transactional (both rows exist, or neither does) and proven to actually
retry-then-fail correctly via the existing outbox worker's retry/attempt-cap
logic — see `apps/web/tests/integration/jobsAndOutbox.test.ts`.

### Web/auth hardening (F-5, F-9, F-10, F-21)

- **Open redirect (F-5)**: `sanitizeCallbackUrl()`
  (`apps/web/lib/safeRedirect.ts`) rejects anything that isn't a genuinely
  same-origin relative path — absolute URLs, protocol-relative `//host`,
  backslash tricks, and percent-encoded forms of either — falling back to
  `/app`.
- **Rate limiting (F-9)**: now keyed on two independent dimensions (email
  AND source IP), with the per-email threshold raised (5 → 10) so a single
  malicious actor cannot trivially lock a known victim out of their own
  account, while a separate, stricter per-IP threshold (20) still catches
  broad credential stuffing. **Superseded by Phase 1B.1**: this became a
  real PostgreSQL-backed limiter (`AuthRateLimitBucket`, atomic
  `INSERT ... ON CONFLICT`), not in-memory — see `apps/web/lib/rateLimiter.ts`
  and the Phase 1D section below for the third (MFA) dimension added later.
- **Timing-safe sign-in (F-9)**: `verifyPassword()` now runs
  unconditionally — against the real user's hash if they exist, or a
  fixed precomputed `DUMMY_PASSWORD_HASH` of identical Argon2id cost if
  they don't (`packages/auth/src/password.ts`) — so response timing can no
  longer distinguish "no such account" from "wrong password."
- **Secret validation (F-10)**: `AUTH_SECRET` now rejects known
  placeholder values (including `.env.example`'s own text) and low-entropy
  padding, case-insensitively, regardless of length; production requires
  44+ characters (`packages/config/src/env.ts`).
- **Security headers (F-21)**: CSP, `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, HSTS (production only), and `Cache-Control:
private, no-store` on every `/api/*` response — see `next.config.ts`.
  **A nonce-based CSP (no `unsafe-inline`) was implemented and reverted** —
  Next.js only attaches a nonce to a page's scripts when that page is
  dynamically rendered per-request, and this app's public pages are
  statically prerendered at build time; verified directly (the app failed
  to hydrate at all under the nonce CSP, confirmed via a CSP-violation
  console error). `script-src 'self' 'unsafe-inline'` — Next.js's own
  documented default path for this situation — was kept instead, a
  considered trade-off given the app has no other realistic inline-script
  injection vector (React's default output escaping throughout, no
  `dangerouslySetInnerHTML` anywhere). See `next.config.ts`'s own comment
  for the full reasoning; a later phase should revisit nonces alongside
  deliberately forcing dynamic rendering.

### File download authorization (F-13)

`getFileForDownload`/`deleteFile` previously checked the `FILE_READ`/
`FILE_DELETE` permission tenant-wide (`legalEntityId: null`) regardless of
the file's own legal entity, then separately checked entity ACCESS — two
different scopes for what should be one check. A user holding `FILE_READ`
only via an entity-scoped role (not tenant-wide) was incorrectly denied
for files in exactly the entity they were granted. Fixed by loading the
file first and passing its own `legalEntityId` into `authorize()`, so the
permission check itself is evaluated against the correct scope.

### Approval corrections (F-17, F-18)

- **F-17**: the module-entitlement check for a decision now runs inside
  the SAME transaction as the decision itself (`assertModuleEnabledTx`),
  closing a TOCTOU window where a module could be disabled by another
  request between a separate check and the write.
- **F-18**: `ApprovalPolicy.allowSelfApproval` (new column, default
  `false`) — a submitter who also holds the approver role can no longer
  approve/reject their own request unless the policy explicitly opts in
  (segregation of duties by default). Separately, cancellation authority
  was decoupled from approval authority: a submitter without the approver
  role can now cancel their own pending request (previously blocked
  entirely, contradicting the pure state machine's own "only the submitter
  may cancel" rule) — `approval:decide` permission and step-approver-role
  membership are both skipped for `CANCEL`, since withdrawing your own
  request is a narrower, distinct action from deciding on someone else's.
  An attempted self-approval or unauthorised decision now also writes an
  `authorization.denied` audit event before the error propagates.

### Repository hygiene (F-25–F-33)

Formatting (`prettier --write .`, 79 files), corrected `.gitignore`/
`.prettierignore` paths (the generated Prisma client lives at
`packages/db/src/generated/`, not `packages/db/prisma/generated/` — the
old path never matched anything), `.data/` (local file storage) now
ignored, the broken `db:migrate:diff` script flag fixed
(`--to-schema-datamodel` → `--to-schema`, removed in Prisma 7),
`getIdentityClient()`'s doc comment corrected (an unscoped query against a
tenant-owned table returns zero rows under this schema's RLS, not "every
row"), and the audit sanitisation denylist extended (salt, OTP/TOTP,
recovery codes, `Authorization`/cookie headers, generic "credential", and
NRIC/NIK) with structural (separator-and-case-insensitive) matching
instead of exact-spelling-only.

### A genuine regression found and fixed during this remediation

Changing `AuditEvent`'s `tenant`/`legalEntity`/`actor` foreign keys from
`Cascade`/`SetNull` to `Restrict` (the F-16 fix, making the schema honestly
reflect what the append-only trigger already enforced in practice) broke
the integration test suite's own tenant cleanup: `cleanupTenant()`
previously relied on `tenant.delete()` cascading away a test tenant's audit
events (with the trigger temporarily disabled) — with `Restrict` in place,
Postgres rejects the tenant delete via the foreign key before the
(disabled) trigger is even relevant. Every test that created a tenant and
produced any audit event began silently failing to clean up (the original
`.catch(() => undefined)` swallowed the failure), and orphaned
tenants/audit rows accumulated across runs undetected until a later test's
assertions started failing against polluted data. Fixed by having
`cleanupTenant()` explicitly delete the tenant's audit_event rows (only
possible with the trigger disabled — the same test-only exception already
documented there) before deleting the tenant, and by making the delete
failure-mode loud (no more silently-swallowed `.catch`) rather than a
repeat of this exact class of problem going undetected again.

### What remains open

See §11 (Deferred) for F-15 (revocable signed URLs) and F-19/F-20 (worker
lease/crash-recovery and RLS context restoration), and §10 for OpenAPI
coverage — none of these were reached in Phase 1B. The mandatory blocking
findings from the Phase 1A review (F-1 through F-6, plus F-24) and all
five F-3 sub-components (email verification, MFA, the tenant guard, the
audit outbox writer, membership invitations) are complete, tested, and
verified against a real database and, where applicable, through the real
UI.

**This subsection is a Phase-1B-era snapshot, kept for history.** F-15,
F-19 and F-20 were completed in Phase 1B.1; OpenAPI coverage was completed
in Phase 1B.1 (F-14); a further security/operational round (Phase 1C
review → Phase 1D remediation) followed — see the section below.

## Phase 1D — final security and operational remediation (N-1–N-7)

Closes all 7 findings from an independent Opus security review (Phase 1C;
disposition REMEDIATION REQUIRED, commit-readiness NO). Full rationale for
each fix is in `docs/DECISION_REGISTER.md`'s Phase 1D section (ADR-32–38);
this is a pointer to the code and tests.

- **N-1 — MFA brute-force + TOTP replay.** New rate-limit dimension family
  (`MFA_ACCOUNT`/`MFA_IP`, `packages/db/prisma/schema.prisma`'s
  `RateLimitDimension` enum), checked in both `sign-in/route.ts` (before
  issuing a challenge token) and `mfa/challenge/route.ts` (before verifying
  one) — `apps/web/lib/rateLimiter.ts`'s `isMfaRateLimited`/
  `recordMfaFailedAttempt`/`clearMfaAttempts`. TOTP replay closed via
  `MfaCredential.lastUsedTotpCounter` and an atomic conditional
  `updateMany` (`packages/auth/src/totp.ts`'s `verifyTotpWithCounter`,
  `apps/web/lib/services/mfaService.ts`). Tests:
  `apps/web/tests/integration/mfaRateLimitAndReplay.test.ts` (15 tests) —
  live-reproduces the exact Phase 1C exploit (25 attempts against a correct
  password) and confirms it now stops at 5.
- **N-2 — File PATCH validation.** `PatchFileSchema.safeParse` replaces a
  throwing `.parse()` — `apps/web/app/api/v1/tenants/[tenantId]/files/[fileId]/route.ts`.
  Confirmed the only such occurrence repo-wide.
- **N-3 — Runtime credential boundary.** `packages/config/src/env.ts`'s
  schema no longer declares `DATABASE_MIGRATION_URL`/`DATABASE_WORKER_URL`;
  `eslint.config.mjs` blocks `@noahark/db/system`/`@noahark/db/worker`
  imports from `apps/web/app/**`, `lib/**`, `components/**`,
  `middleware.ts`. Tests: `apps/web/lib/importBoundaries.test.ts` (lints
  synthetic fixtures via ESLint's Node API), `packages/db/src/index.test.ts`
  (the main barrel never exports the owner/worker clients). Live-verified:
  `next build`, `next start` (served a real `DATABASE_URL`-only request),
  and `tsx scripts/worker.ts` all start cleanly with
  `DATABASE_MIGRATION_URL` unset.
- **N-4 — Hermetic test isolation.** `apps/web/tests/testDataPurge.ts`,
  wired into both suites' `globalSetup`, unconditionally clears
  `outbox_event`/`background_job` and any orphaned test-pattern
  tenant/user before a run starts — self-healing regardless of how the
  previous run ended. Separately fixed: `cleanupUser()`
  (`apps/web/tests/integration/testHelpers.ts`) and E2E's `afterAll`
  (`apps/web/tests/e2e/foundation.spec.ts`) now clear platform-level
  (`tenantId=null`) audit rows before deleting a user — previously always
  failed silently, leaking 143 accumulated `@test.noahark.local` users
  before this fix. Verified: integration suite run 5× consecutively
  (181–188/same passing, zero flakiness), E2E run 3× consecutively
  (18/18 each), and a direct post-run DB query confirming zero leftover
  tenants/users/pending queue rows.
- **N-5 — Scheduled retention/cleanup.** `packages/jobs/src/maintenance.ts`'s
  `runMaintenanceTasks`, wired into `startWorkerLoop` on a separate,
  coarser interval (default 1 hour) from the existing lease-reap sweep.
  `apps/web/scripts/worker.ts` supplies `cleanupExpiredBuckets`
  (pre-existing but never scheduled) and the new
  `cleanupExpiredVerificationTokens`
  (`apps/web/lib/verificationTokenMaintenance.ts` — never-consumed
  email-verification/MFA-challenge tokens previously had no retention path
  at all).
- **N-6 — Test-capture gate.** Corrected an inaccurate doc-comment claim
  (`apps/web/lib/testEmailCapture.ts`, `apps/web/app/api/v1/test/email-captures/route.ts`)
  and added automated coverage for both gate states:
  `apps/web/lib/testEmailCapture.test.ts` (7 tests, closed-gate) and
  `apps/web/tests/integration/testEmailCaptureGate.test.ts` (3 tests,
  open-gate, real database).
- **N-7 — Safe provisioning.** `packages/db/provisioning/provision-roles.mjs`'s
  `ensureRole()` uses `client.escapeLiteral()`/`escapeIdentifier()` and
  plain (non-dollar-quoted) `CREATE ROLE`/`ALTER ROLE` statements —
  PostgreSQL has no parameterized-query path for the `PASSWORD` clause, so
  eliminating the `DO $...$` wrapper, not better escaping, is the actual
  fix. 12 live tests against a real server
  (`packages/db/provisioning/provision-roles.live.test.ts`).

## Phase 1F — final correction of Phase 1E's non-blocking findings

Closes the 5 non-blocking findings from an independent Opus commit-gate
review (Phase 1E). Full rationale in `docs/DECISION_REGISTER.md`'s Phase 1F
section (ADR-39–43); this is a pointer to the code, tests, and — for two
findings — live bugs the implementation work itself surfaced.

- **P1E-1 — Safe test purge.** `apps/web/tests/testDataPurge.ts`'s
  `purgeOrphanedTestData` now requires `NODE_ENV=test`,
  `ALLOW_TEST_DB_PURGE=1`, a non-production-looking connection string
  (unchanged heuristic), AND — checked both from the caller's URL and LIVE
  via `SELECT current_database()` — a name matching
  `testDbLifecycle.ts`'s `isRecognizedTestDatabaseName` pattern. Job/outbox
  deletion is scoped by a `test.`-prefixed type instead of an unconditional
  `deleteMany({})`. Tests: `apps/web/tests/integration/testPurgeSafety.test.ts`
  (7 tests) — each gate refused independently, a non-test tenant/job/outbox
  row surviving, and trigger restoration in `finally` after an induced
  failure (an orphaned test user referenced by a Restrict FK from a
  deliberately-preserved non-test tenant).
- **P1E-5 — Test/worker isolation.** `apps/web/tests/testDbLifecycle.ts`
  creates a uniquely-named, freshly migrated PostgreSQL database per
  integration or E2E run (never the shared `noahark` development
  database), sweeping stale ones from crashed prior runs first. E2E's
  `globalSetup.ts` additionally spawns its own `next dev` server against
  that database on a fixed port (`e2eServerConfig.ts`) — `E2E_BASE_URL`
  opts back out to the pre-Phase-1F workflow. Live-verified: the
  integration suite passes with all 202 tests while a real
  `tsx scripts/worker.ts` runs continuously against the shared `noahark`
  database throughout — the exact scenario Phase 1E found failing.
  **A real bug surfaced and was fixed during this work**: the first E2E
  globalSetup implementation built a separate `serverEnv` object for the
  spawned server but never mutated `process.env` itself, so
  `foundation.spec.ts`'s own `test.beforeAll` (which runs in the same
  process and inherits `globalSetup`'s environment — verified directly)
  kept using the original `.env`-sourced connection string. The fixture
  admin user was created in one database while the server ran against
  another; every sign-in 401'd. Caught by inspecting the failing run's own
  Playwright trace, not by assumption.
- **P1E-2 — Import boundary.** `eslint.config.mjs`'s privileged-client
  boundary now also blocks dynamic `import()`, `require()`, and any
  relative path ending in `systemClient`/`workerClient` (via
  `no-restricted-syntax` AST selectors, alongside the existing
  `no-restricted-imports` rule) — Phase 1E's live probe found all three
  were working bypasses of the Phase 1D rule. Extended to every workspace
  package except `packages/db` (defines the clients) and `packages/jobs`
  (legitimate worker-client-only exception — see P1E-4 below). 17 tests in
  `apps/web/lib/importBoundaries.test.ts` present every bypass form
  against every boundary and confirm rejection, plus confirm the
  legitimate `packages/jobs` exception and `packages/db`'s own internal
  references still work.
- **P1E-3 — Capture gate order.** `apps/web/app/api/v1/test/email-captures/route.ts`
  now checks `isTestEmailCaptureActive()` before parsing the query —
  previously validation ran first, so a malformed query (422) was
  distinguishable from a well-formed one (404) even with the gate closed.
  Both now get the identical 404, and neither reaches the database.
- **P1E-4 — Complete retention maintenance.** Nine categories registered
  in `apps/web/lib/maintenanceRegistry.ts` (rate-limit buckets,
  verification/MFA-challenge tokens, sessions, membership invitations,
  test-email captures, terminal jobs, terminal outbox events, deleted
  files' physical storage), each batched, with an inventory test
  (`apps/web/lib/maintenanceRegistry.test.ts`) that fails if a documented
  category is unregistered. **Two real RLS/grant gaps were found and fixed
  while implementing this, not anticipated in advance**: (1)
  `noahark_worker` had SELECT/UPDATE but never DELETE on
  `background_job`/`outbox_event` — terminal-job/outbox retention (now in
  `packages/jobs/src/queue.ts`/`outbox.ts`, reusing that role's existing
  RLS-scoped cross-tenant access) needs DELETE; the migration now grants it
  on exactly those same two tables, no new blast radius. (2) No role could
  enumerate `Tenant` ids across tenants at all — needed so
  `apps/web/lib/retentionMaintenance.ts`'s invitation/file-storage sweeps
  can iterate every tenant via an ordinary `withTenantContext` each. Rather
  than widen `noahark_worker`'s footprint to two more tables (contradicting
  ADR-31), a new narrow scope (`withWorkerMaintenanceContext`, Tenant-id
  enumeration only) was added to the ordinary app-client guard, backed by a
  matching RLS carve-out on the `tenant` policy — see `packages/db/src/client.ts`.
  A third, smaller gap (physical file purge had no way to know it had
  already run, so it silently re-attempted the same already-purged file
  forever) was caught by this feature's own idempotency test and fixed by
  adding `FileObject.storagePurgedAt`.

## Phase 1H — final source-review hardening

Closes the 8 findings from a source-level-only Opus verification pass
(Phase 1G — live/adversarial verification could not complete due to tool
unavailability, so every finding here is a source-level gap Phase 1F's own
implementation left behind). Full rationale in `docs/DECISION_REGISTER.md`'s
Phase 1H section (ADR-44–50); this is a pointer to the code and tests.

- **P1G-8 — Active test-database ownership.** `apps/web/tests/testDbLifecycle.ts`
  no longer decides staleness by age alone. `createDisposableTestDatabase`
  opens a dedicated admin connection and holds
  `pg_advisory_lock(hashtext(name))` for the database's whole lifetime
  (PostgreSQL auto-releases this if the process crashes — no manual
  recovery needed). `dropStaleDisposableDatabases` only considers a
  candidate eligible once it can itself `pg_try_advisory_lock` the same key
  AND a live `pg_stat_activity` check shows zero other connections to it —
  the lock is held through the actual `DROP DATABASE`, not released
  beforehand, so a candidate's destructive evaluation is serialized rather
  than interleaved. That lock hold is necessary but **not sufficient on its
  own** to close the concurrent-sweeper check-then-act race:
  `pg_try_advisory_lock` is session-scoped and released the moment the
  winning sweeper's probe connection ends, so a slower sweeper can
  legitimately acquire the same key afterwards. What actually closes the
  race (ADR-70) is a final revalidation of the candidate's existence in
  `pg_database`, performed **under the lock** immediately before acting:
  only the invocation whose own under-lock check finds a real row may
  report that name as dropped, and the reported result is never gated on
  `DROP DATABASE IF EXISTS` completing without error — that statement
  succeeds silently as a no-op against an already-absent database, which
  is exactly how the superseded implementation double-credited a single
  physical deletion. Age (`STALE_DATABASE_MIN_AGE_MS`, 60 seconds) survives only as
  a startup-race grace period between `CREATE DATABASE` and the owner's own
  lock acquisition, never as the staleness signal itself. Tests:
  `apps/web/tests/integration/testDbLifecycleOwnership.test.ts` — an
  active-young and an active-old (by embedded name) database both survive
  a sweep while their lock is held; an inactive database with an old
  embedded name is removed; two concurrent "active" runs both survive the
  same sweep; a simulated crash (lock connection closed without a formal
  drop) makes a database eligible for a later sweep; two concurrent
  sweepers racing the same stale candidate never both attempt the drop and
  neither errors — the loser's under-lock revalidation finds the database
  already absent and it skips the candidate without issuing `DROP` — with
  exactly one invocation reporting the deletion and a later sweep
  reporting none (ADR-70); a database whose name only resembles the
  pattern is never touched; a production-looking admin target is refused
  outright.
- **P1G-6 — Narrow tenant-ID enumeration.** The `tenant` RLS policy's
  `app.worker_maintenance_access` OR-clause and `withWorkerMaintenanceContext`
  (packages/db/src/client.ts) are both removed. Replaced by
  `worker_maintenance_list_tenant_ids()`, a `SECURITY DEFINER` SQL function
  (RLS migration) owned by a new NOLOGIN role, `noahark_maintenance_definer`
  (created idempotently by `packages/db/provisioning/provision-roles.mjs`'s
  new `ensureNoLoginRole`), with `RETURNS TABLE(id text)`, a fixed
  `search_path`, and `EXECUTE`-only granted to `noahark_app` — no broader
  `SELECT` grant on `tenant` than `noahark_app` already had for its own
  row. `packages/db/src/client.ts`'s new `listAllTenantIdsForMaintenance()`
  calls it via `$queryRaw`; `apps/web/lib/retentionMaintenance.ts`'s
  `forEachTenant` now calls that instead of the retired context.
- **Worker DELETE hardening.** `noahark_worker` no longer has a direct
  `DELETE` grant on `background_job`/`outbox_event` (RLS migration).
  `packages/jobs/src/queue.ts`'s `cleanupTerminalJobs` and
  `outbox.ts`'s `cleanupTerminalOutboxEvents` now call
  `worker_cleanup_terminal_jobs(cutoff, batch_size)` /
  `worker_cleanup_terminal_outbox_events(cutoff, batch_size)` —
  `SECURITY DEFINER` functions owned by `noahark_maintenance_definer` that
  re-enforce terminal status (their own WHERE clause) and cap batch size
  at 1000, returning only a deleted count. `noahark_maintenance_definer`
  additionally has its own RLS `SELECT`/`DELETE` policies on both tables
  restricted to terminal statuses, as a second, independent enforcement
  layer beyond the function's own logic. **A real bug was found during
  this work, misdiagnosed, then correctly root-caused and fixed in Phase
  1H.1** — see that phase's own section below for the full, corrected
  account. (Phase 1H's own original claim here — that moving the floor
  into the TypeScript caller was the fix, and that the underlying cause
  was clock drift between the Postgres server and the Node process — was
  WRONG; Phase 1H.1 measured the clocks directly and found no drift, then
  found and fixed the real cause.)
- **P1G-1 — Gated cleanup helpers.** `apps/web/tests/testCleanupGate.ts`
  extracts `purgeOrphanedTestData`'s original four gates
  (`NODE_ENV=test`, `ALLOW_TEST_DB_PURGE=1`, non-production-looking target,
  live disposable-database-identity check) into
  `assertTestCleanupAllowed`/`assertTestCleanupAllowedForCurrentEnv`, plus a
  `withGatedAuditTriggerDisabled` wrapper for the shared
  "gate, disable both audit_event triggers, run fn, re-enable in finally"
  pattern. `testHelpers.ts`'s `cleanupTenant`/`cleanupUser`,
  `auditPagination.test.ts`'s tied-timestamp fixture manipulation, and
  `foundation.spec.ts`'s E2E `afterAll` all now go through it — previously
  each disabled the audit triggers with no gates at all.
  `testDataPurge.ts`'s own `purgeOrphanedTestData` now calls the shared
  `assertTestCleanupAllowed` directly rather than keeping its own copy.
  Tests: `apps/web/tests/integration/testCleanupGate.test.ts` (the shared
  primitive's own gates, refused independently) plus two negative tests
  proving `cleanupTenant`/`cleanupUser` themselves refuse and leave the
  target row intact.
- **P1G-3 — Structural export boundary for `@noahark/jobs`.**
  `packages/jobs/src/jobsPublicSurface.test.ts` inspects the package's
  actual resolved exports (`import * as jobsPublicSurface from "./index"`)
  and fails if `getWorkerClient`/`workerClient`/`getSystemClient`/
  `systemClient` or related names ever appear. `eslint.config.mjs`'s new
  `JOBS_EXPORT_BOUNDARY_SELECTORS`, merged into the same
  `no-restricted-syntax` array `buildPrivilegedClientBoundary` already
  produces for `packages/jobs/src/**` (a separate config object would have
  silently REPLACED, not added to, that existing dynamic-import rule —
  ESLint flat config does not merge same-key rule settings across matching
  config objects), blocks the `export` statement forms that could
  introduce a leak. Internal `import { getWorkerClient } from
"@noahark/db/worker"` use inside `packages/jobs` remains untouched — only
  `export` is restricted.
- **P1G-4 — File tombstone decision.** `apps/web/lib/retentionMaintenance.ts`'s
  `purgeDeletedFileObjectStorage` doc comment now explicitly states: the
  `FileObject` row is never deleted, only its physical bytes; the row
  remains a non-downloadable tombstone (`status` stays `DELETED`);
  `storagePurgedAt` proves physical purge occurred; attachment/audit
  history stays intact via the surviving row; final database-row
  retention/deletion is deferred pending country-specific legal review
  (CLAUDE.md's regulatory-implementation-rule). The maintenance-inventory
  category label (`apps/web/lib/maintenanceRegistry.ts`'s
  `DOCUMENTED_MAINTENANCE_CATEGORIES`) is renamed from "deleted file
  objects' physical storage" to "Deleted-file physical storage purge";
  `maintenanceRegistry.test.ts` updated to match.
- **P1G-7 — File purge failure isolation.** Each file's storage-delete +
  `storagePurgedAt` update in `purgeDeletedFileObjectStorage` now runs
  between a Postgres `SAVEPOINT sp_file_purge` and
  `RELEASE`/`ROLLBACK TO SAVEPOINT`, instead of a bare `try`/`catch` alone
  — a DB-level error on one file's `UPDATE` could otherwise poison the
  WHOLE enclosing per-tenant transaction (every later statement in that
  batch, including unrelated files and the eventual `COMMIT`, would fail
  until rolled back), not just a storage-layer throw (which the try/catch
  alone already tolerated). Test:
  `apps/web/tests/integration/retentionMaintenance.test.ts`'s new
  "P1G-7" case — file1's physical delete fails (an intentionally invalid
  `../`-containing storage key, rejected by `LocalStorageProvider` before
  any DB write), file2 succeeds in the same batch; asserts file1 stays
  unmarked and file2 is marked; asserts a later cycle, after fixing file1's
  key, successfully processes it.
- **P1G-2/P1G-5 — Documentation corrections.** `testDataPurge.ts`'s doc
  comment no longer cites a `purgeQueueDebris` helper that never existed
  under that name; `maintenanceRegistry.ts`'s doc comment now cites its
  actual test file (`apps/web/lib/maintenanceRegistry.test.ts`) instead of
  a path that was never real.

## Phase 1H.1 — database-enforced retention boundary

A narrowly scoped follow-up to Phase 1H's worker-DELETE-hardening section,
which had left the retention-age floor enforced only in the TypeScript
caller — insufficient, since a compromised or independently-invoked
worker role could call the SQL function directly with a hostile cutoff.
Full rationale in `docs/DECISION_REGISTER.md`'s Phase 1H.1 section
(ADR-51–53); this is a pointer to the code and tests.

- **Root cause, measured not assumed.** Phase 1H's original diagnosis
  ("PostgreSQL server clock running hours out of sync with the Node.js
  process clock") was investigated directly before touching any code, per
  this phase's own brief, and found to be WRONG. A raw `pg`-driver
  comparison of `clock_timestamp()`/`current_timestamp` against
  `Date.now()` shows the two clocks agree to within ~100ms — there is no
  clock drift. The real cause was two distinct things: (1) Prisma's
  `$queryRaw`/`$queryRawUnsafe` misdisplays a genuinely `timestamptz`
  raw-query result (e.g. `SELECT now()`) read back under this
  environment's non-UTC session `TimeZone` (`Asia/Kuala_Lumpur` — this
  project's local dev/test Postgres instance does not default to UTC);
  and (2) every `DateTime` column in `schema.prisma` maps to PostgreSQL
  `timestamp WITHOUT time zone` (Prisma's unannotated default — confirmed
  via `information_schema.columns`), and Phase 1H's original function
  body compared that naive column directly against a `timestamptz`
  PL/pgSQL variable with no explicit zone conversion, triggering an
  implicit cast resolved through the session `TimeZone` GUC that silently
  shifted the comparison by the zone's offset.
- **Database-enforced retention floor, corrected.**
  `worker_cleanup_terminal_jobs`/`worker_cleanup_terminal_outbox_events`
  (RLS migration) now compute
  `safe_cutoff := LEAST(retention_cutoff, clock_timestamp() - interval
'1 hour')` and compare against `(updated_at AT TIME ZONE 'UTC')` /
  `(created_at AT TIME ZONE 'UTC')` — an explicit, session-TimeZone-
  independent conversion, verified directly to produce the correct
  instant. A caller-supplied cutoff (via the TypeScript wrapper or a
  direct SQL call as `noahark_worker`) can only ever narrow eligibility,
  never widen it past the 1-hour floor — verified directly with `now()`,
  a one-year-future date, and the year 9999 as hostile cutoffs, all
  producing the identical (correct) eligibility result.
  `packages/jobs/src/queue.ts`/`outbox.ts`'s `MIN_RETENTION_MS` remains as
  defence-in-depth only, explicitly documented as non-authoritative in
  both files.
- **Migration mechanism.** Applied by continuing to hand-edit
  `packages/db/prisma/migrations/20260817000002_rls_and_constraints/migration.sql`
  directly, matching this migration's established, repeatedly-used
  edit-in-place convention since Phase 1B — the project has never been
  deployed to any real environment, so every local/CI database is
  disposable or freely re-migratable.
- **Adversarial tests**, rewritten in
  `apps/web/tests/integration/workerDeleteHardening.test.ts` (26 tests,
  all passing): every test calls the SQL functions directly as the
  `noahark_worker` role via raw SQL, bypassing the TypeScript wrapper.
  Covers, for both `background_job` and `outbox_event`: raw `DELETE`
  denied; every non-terminal and recently-terminal status survives
  (including a manually-inserted `JobStatus.FAILED` row, proving the
  function's status filter protects it even though no current code path
  ever sets that status); an old eligible row is removed; a
  future-dated and a year-9999 cutoff cannot bypass the floor; a
  `batch_size` of 999999 is still capped at 1000 (verified against 1005
  real eligible rows); concurrent calls never delete non-eligible rows;
  repeated calls are idempotent; the TypeScript wrapper still works end
  to end. A separate timezone-independence test opens direct role
  connections under `SET TIME ZONE 'UTC'`, `'Asia/Singapore'`, and
  `'Etc/GMT+5'` and confirms identical eligibility results across all
  three for the same stored data.
- **Out-of-scope finding, not fixed here — FIXED in Phase 1H.2 below.**
  The same class of bug (naive-column-vs-`timestamptz` comparison under
  non-UTC session `TimeZone`) affects `packages/jobs/src/queue.ts`'s
  `claimNextJob` (`WHERE run_at <= now()`) — live-reproduced: a job
  scheduled 1 hour in the future was claimed immediately. This likely
  defeats `failJob`'s exponential-backoff retry delay on any deployment
  where the session `TimeZone` is not UTC. Not fixed in this phase (its
  own brief was explicitly narrow: the retention-cleanup boundary, not a
  general job-scheduling audit) — flagged as a separate follow-up task
  instead of silently expanding scope.

## Phase 1H.2 — temporal semantics and job-scheduling hardening

Closes Phase 1H.1's own flagged out-of-scope finding (`claimNextJob`'s
premature-claim defect) with a systematic, schema-wide temporal audit
rather than a single-query patch — the investigation established that
EVERY unannotated `DateTime` field in `schema.prisma` mapped to
PostgreSQL `timestamp WITHOUT time zone` (Prisma's default), so
`claimNextJob` was one symptom of a schema-wide condition. Full rationale
in `docs/DECISION_REGISTER.md`'s Phase 1H.2 section (ADR-54–58); this is
a pointer to the code and tests.

- **Temporal field inventory and classification.** Every temporal column
  in the schema (69 `DateTime` fields) is now documented in
  `packages/db/src/temporalInventory.ts`, classified per a five-way
  taxonomy (ABSOLUTE_INSTANT / LOCAL_CIVIL_DATE / LOCAL_CIVIL_TIME /
  REPORTING_PERIOD / DURATION). Every field in the current schema is
  ABSOLUTE_INSTANT — Phase 1 has no accounting/payroll/statutory business
  models yet, so no genuinely local-date/time field exists to be
  misclassified; this file is the wired-in place a future phase
  registers one when it does.
- **Schema-level fix.** Every ABSOLUTE_INSTANT field gained
  `@db.Timestamptz(3)` in `schema.prisma` (all 69), and
  `packages/db/prisma/migrations/20260817000001_init/migration.sql` was
  regenerated via `prisma migrate diff --from-empty` — a diff against the
  previous generated migration confirmed `TIMESTAMPTZ(3)` replacing
  `TIMESTAMP(3)` was the ONLY textual change, nothing else shifted.
  Chosen over accumulating `AT TIME ZONE 'UTC'` casts at each call site
  (Phase 1H.1's approach, now superseded for the two cleanup functions —
  see `packages/db/prisma/migrations/20260817000002_rls_and_constraints/migration.sql`,
  which dropped the workaround since both sides of its comparisons are
  now genuinely `timestamptz`) because the project is greenfield and
  never deployed, matching the brief's own stated preference for
  correcting the schema once over an unbounded number of scattered casts.
  Verified empirically: with the schema fix alone, `claimNextJob`'s SQL
  — completely unmodified — correctly refuses a job scheduled 1 hour in
  the future.
- **A second, independent, more severe defect found and fixed.**
  `@prisma/adapter-pg` (the driver adapter every Prisma client in this
  codebase uses) was found to serialize a JS `Date` WRITTEN to a genuine
  `timestamptz` column incorrectly whenever the connection's session
  `TimeZone` was not UTC — the instant actually stored on disk came out
  shifted by the session's UTC offset, confirmed by reading a
  Prisma-written value back through an INDEPENDENT raw `pg` connection
  (Prisma's own model layer's return value looked correct; the bytes on
  disk did not). This is a write-path bug no read-side cast can fix.
  Mitigated — not fixed at its root — with
  `packages/db/provisioning/provision-roles.mjs`'s new
  `ALTER DATABASE <name> SET timezone TO 'UTC'`, applied to every
  database this project provisions (persistent and disposable alike),
  making UTC the default session `TimeZone` for every role connecting to
  it — including the migration/system role, which this script does not
  otherwise manage. **Correction (Phase 1H.3):** an `ALTER DATABASE`
  default only applies to a session that never explicitly overrides its
  own timezone. It removes the trigger condition for every normal
  NoahArk session (confirmed by grep: no production source path issues
  `SET TIME ZONE`, enforced going forward by
  `apps/web/lib/productionSessionTimezoneBoundary.test.ts`), but a
  session that explicitly runs `SET TIME ZONE` after connecting remains
  affected by the installed `@prisma/adapter-pg` version — reproduced
  directly. This residual risk is accepted as known and
  non-runtime-reachable, not claimed away.
- **Job/outbox scheduling verified correct**, not merely assumed, across
  `UTC`/`Asia/Singapore`/`Asia/Kuala_Lumpur`/`Asia/Jakarta`/`Etc/GMT+5`
  session timezones: future-scheduled jobs are never claimed early;
  past-due jobs are claimed correctly; retry backoff is honoured and the
  job becomes claimable only after the backoff instant; lease expiry,
  heartbeat extension, and expired-lease recovery are identical
  regardless of session timezone; concurrent workers cannot double-claim
  or claim a future job; terminal cleanup still cannot bypass the
  Phase 1H.1 minimum-retention floor. See
  `apps/web/tests/integration/jobSchedulingTemporalMatrix.test.ts` (56
  tests) for both real-function tests (default session) and a
  parameterized raw-SQL matrix proving the query text itself carries no
  session-timezone dependency.
- **Other Phase 1 temporal security boundaries verified**: membership
  invitation expiry, email-verification token expiry, and session expiry
  all round-trip correctly through an independent raw-connection read
  (not just Prisma's own echo); the rate limiter's fixed-window bucketing
  is exact-match, never range-compared against a session-clocked value;
  signed-file URL expiry is encoded as a plain Unix-ms number inside the
  signed token itself and never touches the database at all — timezone-
  independent by construction; audit-event ordering/pagination is keyed
  by the hash chain's own monotonic `sequence` column (F-32), never by a
  timestamp, so it was never exposed to this class of bug in the first
  place. See `apps/web/tests/integration/temporalSecurityBoundaries.test.ts`.
- **Schema-conformance test.**
  `apps/web/tests/integration/temporalSchemaConformance.test.ts` compares
  `temporalInventory.ts`'s documented list against a fresh disposable
  database's `information_schema.columns` in both directions (every
  documented column has its expected type; every deployed temporal
  column is documented) and separately asserts zero naive `timestamp`
  columns exist at all — a future schema change that omits
  `@db.Timestamptz` on a new `DateTime` field fails this test. It also
  includes the write-path regression guard described above (an
  independent raw-connection read of a Prisma-written value) and confirms
  the disposable database's default session timezone is UTC.
- **No LOCAL_CIVIL_DATE/TIME/REPORTING_PERIOD/DURATION columns are
  intentionally retained as naive** — there are none in the Phase 1
  schema at all (see the inventory's own doc comment); every temporal
  column that exists is now `timestamptz`, with zero exceptions.
