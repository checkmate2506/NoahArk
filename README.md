# NoahArk

Multi-tenant business-management platform for Singapore, Malaysia and Indonesia.
Phase 1 (platform foundation) — see [docs/PHASE_01_FOUNDATION.md](docs/PHASE_01_FOUNDATION.md)
for scope and [docs/PHASE_01_IMPLEMENTATION.md](docs/PHASE_01_IMPLEMENTATION.md) for
what was actually built, its security model, permission catalogue and API
conventions.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript (strict, `exactOptionalPropertyTypes`)
· PostgreSQL 16 · Prisma 7 (driver adapters) · Tailwind CSS 4 · Vitest · Playwright ·
pnpm + Turborepo.

## Repository layout

```
apps/web/            Next.js app — UI + /api/v1 routes
packages/core/        context, errors, Result, jurisdiction rules, omitUndefined
packages/config/       env schema, typed settings validation
packages/authz/         permission catalogue, six-check authorize()
packages/audit/          append-only audit + hash chain
packages/workflow/        generic approval state machine
packages/auth/              password hashing (argon2id)
packages/jobs/                Postgres-backed job queue + transactional outbox
packages/files/                 storage abstraction (local dev provider)
packages/notifications/          provider-neutral notifications
packages/ui/                      shared UI primitives
packages/db/                       Prisma schema, RLS migrations, seed
docs/                                architecture & phase documents
```

## Local development setup

### Prerequisites

- Node.js ≥ 24, pnpm ≥ 11
- A PostgreSQL 16 instance. Two options:
  - **Docker Compose** (recommended when Docker is available): `docker compose up -d`
    starts Postgres on `localhost:5432` with the credentials in `.env.example`.
  - **Embedded Postgres** (no Docker required — what this repo's own development used):
    `pnpm --filter @noahark/db db:dev-postgres:start` downloads and runs a real
    PostgreSQL binary directly, listening on `127.0.0.1:55432`. Stop it with
    `pnpm --filter @noahark/db db:dev-postgres:stop`. See
    `packages/db/scripts/embedded-pg.mjs` for details — this is a dev/CI-only
    substitute for Testcontainers/Docker, never used in production.

### Install

```bash
pnpm install
```

### Environment variables

Copy `.env.example` to `.env` in **both** `packages/db/` and `apps/web/`
(each package loads its own `.env` — see `.env.example` at the repo root for the
full reference and explanation of every variable). Never commit a real `.env`.

Key variables — **credentials are scoped by PROCESS, not shared** (N-3, Phase
1D):

- `DATABASE_URL` — the non-superuser `noahark_app` role. Required by `next
build`/`next dev`/`next start`. Every ordinary application query uses this —
  Row-Level Security is always enforced for it.
- `DATABASE_MIGRATION_URL` — owner/superuser connection. Required **only** by
  `prisma migrate`, `prisma/seed.ts` and `provisioning/provision-roles.mjs`.
  `packages/config/src/env.ts`'s runtime env schema does not declare this
  field at all, so the Next.js app process cannot be made to require it even
  by misconfiguration. An ESLint rule (`eslint.config.mjs`) also rejects
  **static and dynamic imports, `require()`, and any relative path** into
  the owner-role Prisma client (`@noahark/db/system`) from
  `apps/web/app/**`, `apps/web/lib/**`, `apps/web/components/**`,
  `middleware.ts`, and every other workspace package except `packages/db`
  itself (defines the client) — see `apps/web/lib/importBoundaries.test.ts`
  (17 cases covering every bypass form) and `packages/db/src/index.test.ts`
  for the automated proof. This is a static-analysis backstop, not the
  primary control — the primary control is that the running app never has
  the credential in the first place (live-verified: `next build`, `next
start`, and the worker all start cleanly with `DATABASE_MIGRATION_URL`
  unset or poisoned).
- `DATABASE_WORKER_URL` — the `noahark_worker` role. Non-superuser,
  **not** BYPASSRLS (Phase 1B/F-12) — its cross-tenant visibility into
  `background_job`/`outbox_event` comes from an explicit RLS policy scoped
  `TO noahark_worker` on exactly those two tables, not a blanket role
  attribute. It cannot read any other table. Required only by `tsx
scripts/worker.ts`, never by `next build`/`next start`.
- `AUTH_SECRET` — a real, independently-generated random string, 32+
  characters (44+ in production). **Must be regenerated per environment** —
  known placeholder values (including `.env.example`'s own text) and
  low-entropy padding are rejected at startup (F-1B/F-10).
- `AUTH_URL` — must **exactly** match the origin (scheme + host + port) the
  app is actually reached at. It is also the trusted origin for CSRF
  Origin-header validation (F-8) — if you run the dev server on a port other
  than 3000 (this repo's own development used 3100, since 3000 was occupied
  by an unrelated local service), update this to match, or every
  state-changing request will be rejected. `localhost` and `127.0.0.1` are
  DIFFERENT origins even though they resolve to the same server — pick one
  and use it consistently in your browser too.
- `TRUSTED_ORIGINS` — optional comma-separated list of additional trusted
  origins for CSRF validation.

### Database provisioning and migrations

Provisioning (creating the `noahark_app`/`noahark_worker` roles) is a
**separate step from migrations** (F-1B/F-4) — this keeps the migration
chain portable to environments (e.g. Azure Database for PostgreSQL Flexible
Server) where the connecting admin role cannot `CREATE ROLE ... BYPASSRLS`:

```bash
cd packages/db
pnpm db:generate                    # generate the Prisma client
node provisioning/provision-roles.mjs  # create/converge noahark_app + noahark_worker
                                        # (idempotent — safe to re-run; never resets an
                                        #  already-set password)
pnpm db:migrate:deploy               # apply migrations/ (RLS policies, the audit block
                                      #   trigger, jurisdiction/currency constraint, etc.
                                      #   — assumes the roles above already exist)
ALLOW_DEMO_SEED=1 pnpm db:seed  # seeds the permission catalogue + a demo tenant
                              #   ("Acme Group") with SG/MY/ID legal entities and
                              #   an admin user (admin@noahark.demo). ALLOW_DEMO_SEED=1
                              #   is REQUIRED every run (not a one-time setup flag) —
                              #   the script also refuses to run when NODE_ENV=production
                              #   or the target host/database name looks production-like.
                              #   The admin password is randomly generated and printed
                              #   ONCE to the terminal — it is never written to a file,
                              #   log, or source, and re-running the seed does not reset
                              #   it once set. Copy it down immediately.
```

See `packages/db/provisioning/provision-roles.mjs` for Azure PostgreSQL
provisioning notes, and [docs/PHASE_01_IMPLEMENTATION.md](docs/PHASE_01_IMPLEMENTATION.md)
for the operational assumptions that remain to be confirmed before a real
deployment.

Migrations live in `packages/db/prisma/migrations/`:

1. `20260817000001_init` — generated via `prisma migrate diff --from-empty`
   (base schema DDL).
2. `20260817000002_rls_and_constraints` — hand-authored: enables Row-Level
   Security with tenant + legal-entity scoped policies on every tenant-owned
   table (assuming the roles from provisioning already exist), adds the
   jurisdiction/currency CHECK constraint, and the audit-event/system-role
   protection triggers. Read the file's header comment before touching it —
   every GRANT and policy is load-bearing. See
   [docs/PHASE_01_IMPLEMENTATION.md](docs/PHASE_01_IMPLEMENTATION.md) for the
   full security model this migration implements.

### Verifying audit chain integrity

```bash
cd packages/db
npx tsx scripts/verify-audit-chain.ts --platform        # or: --tenant <tenantId>
```

Read-only; recomputes and checks the hash chain for the selected chain,
prints only structural facts (never audit content), and exits non-zero if
tampering or a gap is detected.

### Run the app

```bash
pnpm --filter @noahark/web dev      # http://localhost:3000
pnpm --filter @noahark/web worker   # background job/outbox processor (separate process)
```

The worker also runs a periodic, low-frequency retention sweep (N-5/P1E-4 —
default hourly, `packages/jobs/src/maintenance.ts`) covering nine categories
of ephemeral data — see `apps/web/lib/maintenanceRegistry.ts` for the full,
tested inventory (rate-limit buckets; email-verification and MFA-challenge
tokens; sessions; membership invitations; test-email captures; terminal
jobs/outbox events; deleted files' physical storage). Both the job/outbox
lease reaper and this sweep are housekeeping only, safe to run from multiple
worker processes concurrently, and never require `DATABASE_MIGRATION_URL`.

### Tests

```bash
pnpm test                                        # unit tests, every package
pnpm --filter @noahark/web test:integration        # integration tests — needs ONLY a
                                                      # running Postgres server reachable
                                                      # via DATABASE_MIGRATION_URL; the
                                                      # suite creates/migrates/drops its
                                                      # own disposable database per run
pnpm --filter @noahark/web e2e                       # Playwright — same: creates its own
                                                        # disposable database AND its own
                                                        # `next dev` server (first run:
                                                        # pnpm exec playwright install chromium)
pnpm typecheck                                          # tsc --noEmit, every package
pnpm lint                                                # eslint, every package
pnpm --filter @noahark/web build                          # production build
```

See [docs/PHASE_01_IMPLEMENTATION.md](docs/PHASE_01_IMPLEMENTATION.md) §Testing
for what each test suite actually covers, including the mandatory negative
security tests.

**Both the integration suite and the E2E suite provision their own,
uniquely-named, disposable PostgreSQL database per run** (P1E-5, Phase 1F —
`apps/web/tests/testDbLifecycle.ts`) — never the shared `noahark`
development database a `pnpm --filter @noahark/web worker` you have running
locally might be pointed at. `DATABASE_MIGRATION_URL` in your `.env` is used
only as the admin/owner connection to CREATE that disposable database; the
suite's own `DATABASE_URL`/`DATABASE_MIGRATION_URL`/`DATABASE_WORKER_URL`
are then overridden to point at it for the rest of that run. A stale
disposable database from a run that crashed before it could drop its own is
swept (by name pattern + age) before a new one is created — self-healing
regardless of how the previous run ended, and the underlying row-level purge
this replaced (`apps/web/tests/testDataPurge.ts`, N-4/Phase 1D, P1E-1/Phase
1F) is retained as an independently-gated utility for anyone who deliberately
opts out of the disposable-database flow. Live-verified: the integration
suite passes in full with a real `tsx scripts/worker.ts` running
continuously against the shared `noahark` database throughout the run.

Neither suite is safe to run as two overlapping/concurrent invocations
against the SAME disposable database within one run (matches
`vitest.config.ts`'s own comment on `fileParallelism: false`) — this refers
to two processes racing inside a single suite invocation, not to running the
suite itself repeatedly, which is always safe since each invocation gets its
own database.

## Scope

Phase 1 is the platform foundation only: tenancy, legal entities, RBAC, audit,
approvals, jobs/outbox, files, settings, a thin admin UI, authentication
(password + TOTP MFA + email verification), and membership invitations. No
business modules (CRM, accounting, payroll, tax, invoicing, purchasing,
projects) and no statutory formulas of any kind — see
[docs/IMPLEMENTATION_ROADMAP.md](docs/IMPLEMENTATION_ROADMAP.md) for the full
phase sequence and [docs/COUNTRY_COMPATIBILITY_MATRIX.md](docs/COUNTRY_COMPATIBILITY_MATRIX.md)
for what regulatory research remains before any country-specific phase begins.
