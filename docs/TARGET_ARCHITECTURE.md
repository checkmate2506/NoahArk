# NoahArk — Target Architecture

> Phase 0R. Design only. Modular monolith. SG/MY/ID only.

## 1. Architectural style

- **Modular monolith**: one deployable application, many internal packages with
  explicit public interfaces. No microservices unless a specific integration,
  scale or security boundary demands one (none identified for the foundation).
- **Bounded contexts** own their tables. Cross-context access is via typed service
  interfaces and IDs — **no cross-context foreign keys**, no reach-in queries.
- **Two isolation axes everywhere**: `tenant_id` and `legal_entity_id`.

## 2. Technology stack & baseline assessment

| Area | Proposed baseline | Decision | Notes / deviation |
|---|---|---|---|
| App framework | Next.js | **Accept** — Next.js (App Router) as single deployable (UI + REST route handlers) | — |
| UI | React | **Accept** — React + TypeScript strict | `noUncheckedIndexedAccess` on |
| Language | TS strict | **Accept** | Strictest practical config |
| DB | PostgreSQL | **Accept** — PostgreSQL 16, **NoahArk's own database** | — |
| ORM | Prisma | **Accept** — Prisma + client extension for tenant/entity guard | RLS is the backstop |
| CSS | Tailwind | **Accept** | — |
| Component lib | "Enterprise component library" | **Deviation** — shadcn/ui + Radix + TanStack Table (owned, accessible, no licence lock-in) | vs proprietary MUI/AntD Pro |
| Auth | Auth.js or other | **Accept (scoped)** — Auth.js v5, DB sessions; RBAC/field policies in app layer | Auth.js does authN + session only |
| API | REST first + OpenAPI | **Accept** — REST `/api/v1` + OpenAPI 3.1 contract | tRPC internal-only optional later |
| Object storage | S3-compatible | **Accept** — MinIO local, Azure Blob (S3 API) in cloud | — |
| Background jobs | Job infra | **Decided (AD-5)** — PostgreSQL-based jobs + transactional outbox + worker processing | enqueue in same tx as business write. **No Redis in Phase 1** unless a demonstrated requirement cannot be met safely with PostgreSQL |
| Local infra | Docker Compose | **Accept** — Postgres, MinIO, Mailpit | — |
| Unit/integration | Vitest | **Accept + add** Testcontainers (real Postgres for RLS & isolation tests) | — |
| E2E | Playwright | **Accept** | — |
| CI | GitHub Actions | **Accept** | — |
| Deploy | Azure-compatible | **Decided (AD-6)** — SaaS-first on Azure Container Apps + Azure Database for PostgreSQL Flexible Server + Azure Blob + Key Vault; **proposed primary region: Azure Singapore** | Architectural direction only — **residency, DR region and cross-border handling for SG/MY/ID remain subject to specialist legal & security confirmation before production**. No on-premises deployment in the initial phases |
| Monorepo | (unspecified) | **Propose** pnpm + Turborepo | single deployable, many packages |

**Deviation rationale.** (a) *Component library:* an owned shadcn/Radix layer gives
NoahArk its own brand identity (CLAUDE.md) with no per-seat licence and full
accessibility control; **NoahArk is the provisional product name and the design
tokens/assets are replaceable placeholders** (AD-10). (b) *Jobs on Postgres:* the
outbox, notifications, webhook delivery and **statutory submission** flows all need
a job enqueued **atomically** with the business transaction; a Postgres-backed
worker does this without Redis (AD-5, decided).

**Vendor-neutral external services.** Billing/charging (AD-2) and email (AD-3)
providers are **deferred**. Phase 1 defines **provider-neutral interfaces** only —
a subscription/entitlement interface with **no external charging implemented**, and
an email-sender interface with a development-safe implementation (e.g. local mail
catcher). No platform code may couple to a specific billing or email vendor.
**Enterprise SSO is not required for the initial release** (AD-4), but the user,
tenant and membership models must allow SSO to be added later without replacement.

## 3. Layering (per module)

```
HTTP route (Next.js handler) → application service (use-case, tx, authZ)
  → domain (invariants) → repository (Prisma, tenant+entity scoped) → PostgreSQL
```

- Validation (Zod) at every external boundary.
- Domain invariants enforced in the service **and** by DB constraints.
- Country-specific behaviour is reached only through **country adapters** behind a
  shared interface (tax, payroll, e-invoicing, holidays, numbering, address).

## 4. Package map (proposed)

```
apps/
  web/                 Next.js app (UI + /api/v1 handlers)
packages/
  core/                request context, Result/errors, Money, ids, clock
  db/                  Prisma schema, migrations, RLS policies, seeds
  auth/                Auth.js config, sessions, MFA
  authz/               RBAC, policies, field-level permissions
  audit/               append-only audit + hash chain + outbox writer
  jobs/                Graphile Worker tasks & scheduler
  files/               S3/Blob broker, signed URLs, scan hook
  notifications/       outbox → channels
  workflow/            approval engine
  api/                 OpenAPI spec, shared HTTP conventions, idempotency
  ui/                  shadcn/Radix components, theme
  config/              env schema, feature flags, entitlements
  # bounded contexts
  crm/  catalog/  sales/  purchasing/  accounting/  hr/  time/  payroll/
  projects/  workspace/  reporting/  billing/  integration/
  # country adapters
  country-core/        adapter interfaces + registry (SG|MY|ID only)
  country-sg/  country-my/  country-id/
```

Boundary enforcement: ESLint import rules forbid importing another context's
internals; only its `*/public` interface and shared kernel packages are importable.

## 5. Cross-context integration rules

- **Reads**: synchronous calls to the owner's service interface.
- **Side-effects**: domain events via the **transactional outbox** (`event_outbox`)
  → jobs → consumers (notifications, webhooks, reporting projections, GL posting
  requests). At-least-once; consumers are idempotent.
- **Financial truth** always resolves to the ledger; Sales/Purchasing/Payroll
  *request* postings from Accounting (see ACCOUNTING_ARCHITECTURE.md).
- **Country truth** always resolves to the legal entity's jurisdiction + the
  versioned rule set in effect on the relevant date.

## 6. API & webhook conventions (summary)

- REST under `/api/v1`; JSON; cursor pagination; RFC-7807 problem responses.
- `Idempotency-Key` required on unsafe money/workflow/statutory endpoints.
- ETags/optimistic concurrency on mutable resources.
- AuthN: first-party session cookie (UI) + scoped API keys / OAuth
  client-credentials (integrations); tenant + entity resolved server-side.
- Webhooks: HMAC-SHA256 signature + timestamp, at-least-once with backoff,
  replay-safe event IDs, delivery log, versioned event catalog. Full detail in the
  Integration context spec (later phase).

## 7. Reporting & dashboards

- Read models / materialised views in a separate `reporting` schema, refreshed by
  jobs and incrementally via outbox projections.
- Per-entity functional-currency reporting + **group consolidation** in a chosen
  group reporting currency with explicit translation and intercompany elimination
  (see ACCOUNTING_ARCHITECTURE.md §Consolidation).

## 8. Environments & deployment

- `dev → uat → prod` on Azure Container Apps; Azure Database for PostgreSQL
  Flexible Server; Azure Blob; Key Vault; per-env config via `packages/config`.
- Migrations validated in CI and applied as a gated deploy step.
- Data residency: **decided (AD-6)** — SaaS-first, **Azure Singapore proposed as
  primary region**. This is an architectural direction only; residency, DR region
  and cross-border handling for SG/MY/ID **require specialist legal and security
  confirmation before production deployment**.

## 9. Time, currency, language separation (invariant)

The following are **independent** axes and must never be conflated:
UI language · document language · employee-communication language ·
legal-entity jurisdiction · transaction currency · reporting currency ·
user time zone · legal-entity time zone. Changing display language must not change
tax, payroll, accounting, jurisdiction or statutory behaviour.
