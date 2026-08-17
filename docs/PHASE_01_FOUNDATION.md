# NoahArk — Phase 1 Foundation Specification

> Phase 0R deliverable (design of Phase 1). **Phase 1 is NOT implemented in this
> phase.** No code, no migrations, no packages.

## 1. Goal

A working modular-monolith skeleton that proves NoahArk's **dual-axis isolation
(tenant + legal entity)**, server-side RBAC + field policies, immutable audit,
approvals, jobs/outbox, and files — exercised by one thin vertical slice:
**tenant / legal-entity / user / role administration**. No country tax, payroll or
e-invoicing; no financial documents.

## 2. Scope (in)

- Monorepo scaffold (pnpm + Turborepo), TypeScript strict, lint/format, CI.
- PostgreSQL 16 database (NoahArk's own) with **RLS from migration #1** and a
  **non-superuser app role**.
- **Tenant and legal entity separate from the first migration (AD-1)** — a tenant
  may own multiple legal entities across SG, MY and ID. Not a later retrofit.
- Prisma with a **tenant/legal-entity guard** client extension.
- Auth.js v5 (DB sessions, Argon2id, email verification, TOTP MFA, tenant/entity
  switch). **No enterprise SSO (AD-4)** — but user/tenant/membership models must
  admit SSO later without replacement.
- RBAC (permission catalog, seeded system roles, `authorize()` gate) + field-policy
  scaffold.
- Immutable audit (append-only + hash chain + block trigger + outbox writer).
- Approval-engine core, notification outbox, **PostgreSQL-based jobs + transactional
  outbox + worker processing (AD-5 — no Redis)**, files broker (MinIO/Blob signed
  URLs) — skeletons exercised by the admin slice.
- **Provider-neutral interfaces only**: a subscription/entitlement interface with
  **no external charging implemented** (AD-2), and an email-sender interface with a
  development-safe implementation (AD-3). No vendor coupling.
- `/api/v1` conventions + OpenAPI 3.1 doc + Zod validation + problem responses +
  idempotency middleware.
- UI shell (app layout, auth screens, tenant + legal-entity + user + role admin).
- Docker Compose (Postgres, MinIO, Mailpit).

## 3. Scope (out)

Country tax/payroll/e-invoicing; CRM/sales/accounting documents; reporting
dashboards; external billing/charging; **fixed assets (AD-8)**; enterprise SSO
(AD-4); Redis (AD-5). (These are later phases or deferred.)

The **country contract fields** on `legal_entity` exist (jurisdiction enum SG|MY|ID,
functional currency, time zone, default language, identifier/registration slots),
but **no statutory logic runs and no tax, payroll or e-invoicing formula, rate,
threshold or schema appears anywhere in Phase 1.** Phase 1 has **zero regulatory
dependencies** and is therefore not blocked by the outstanding verification work in
REGULATORY_SOURCE_REGISTER.md.

## 4. Proposed packages / files (design intent — not created here)

```
apps/web/                         Next.js app (UI + /api/v1)
packages/core/                    context, Result/error, Money, ids, clock
packages/db/                      Prisma schema, migrations (RLS), seeds
packages/auth/                    Auth.js config, sessions, MFA
packages/authz/                   RBAC, policies, field-level permissions
packages/audit/                   append-only audit + hash chain + outbox writer
packages/workflow/                approval engine core
packages/notifications/           outbox → channels (in-app/email)
packages/jobs/                    Graphile Worker tasks + scheduler
packages/files/                   S3/Blob broker, signed URLs, scan hook
packages/api/                     OpenAPI, HTTP conventions, idempotency
packages/ui/                      shadcn/Radix components, theme
packages/config/                  env schema, feature flags, entitlements
docs/                             (this Phase 0R set)
.github/workflows/ci.yml          lint→typecheck→unit→integration→build→e2e
docker-compose.yml                postgres, minio, mailpit
```

## 5. Foundational schema (indicative)

`tenant`, `legal_entity` (jurisdiction SG|MY|ID, functional_currency, time_zone,
default_language, identifiers, registrations), `business_unit`, `department`,
`team`, `branch`, `warehouse`, `cost_centre`, `user`, `membership`,
`legal_entity_access`, `role`, `permission`, `role_permission`, `user_role`,
`field_policy`, `tenant_setting`, `legal_entity_setting`, `custom_field_def`,
`audit_event`, `approval_request`, `approval_step`, `notification`,
`notification_outbox`, `event_outbox`, `idempotency_key`, `attachment`.

All tenant-owned tables carry `tenant_id`; entity-scoped tables also `legal_entity_id`;
all have RLS policies keyed on `app.tenant_id` / `app.legal_entity_ids`.

## 6. Security requirements (must be true at exit)

- RLS on every tenant-owned table; app role cannot bypass RLS.
- Tenant + legal-entity context from session only; client-supplied ids ignored.
- Six-check authZ gate available and used by the admin slice.
- Field-level masking demonstrated on at least one sensitive field.
- Audit append-only + hash chain + no UPDATE/DELETE for app role.
- MFA enforced for admin role.

## 7. Test gates (CI blockers)

1. **Tenant-isolation suite** — cross-tenant read/write rejected (DB + service).
2. **Legal-entity-isolation suite** — access to one entity never yields another.
3. **AuthZ tests** — all six checks incl. field masking and SoD basics.
4. **Audit immutability tests** — UPDATE/DELETE blocked; hash chain verifies.
5. **Migration-integrity tests** — schema applies cleanly; RLS present.
6. **Idempotency test** — repeated admin mutation with same key = single effect.
7. E2E smoke (Playwright): sign-in + MFA + create tenant/entity/user/role.

All gates green ⇒ Phase 1 exit.

## 8. Rollback / recovery

- Forward-only migrations with tested down paths in dev; no destructive prod ops.
- Feature flags gate the admin slice.
- Backups + restore drill defined before any UAT data.

## 9. Explicit reminders

- No module is "done" on CRUD alone.
- No statutory formula is written in Phase 1.
- Leave all Phase 1 work uncommitted for review (per CLAUDE.md) when it is built —
  in a later, separately authorised phase.
