# NoahArk — Security & Tenancy

> Phase 0R. Design only. Isolation on two axes: tenant and legal entity.

## 1. Isolation model

**Shared database, shared schema, dual discriminators (`tenant_id`,
`legal_entity_id`) with defence-in-depth:**

1. **Postgres Row-Level Security (RLS)** on every tenant-owned table. Policies key
   off per-transaction GUCs `app.tenant_id` and, for entity-scoped tables,
   `app.legal_entity_ids` (the set the session may access). The application DB role
   is **non-superuser** and cannot bypass RLS.
2. **Prisma client extension** that (a) requires an explicit request context,
   (b) injects `tenant_id`/`legal_entity_id` on writes, (c) refuses reads/writes
   with no tenant context set. App-layer belt to the RLS braces.
3. **Server-derived context only.** `tenant_id`, legal-entity access, roles,
   permissions, approval limits and posting/payroll/statutory authority come from
   the authenticated session — **never** from client input. Any client-supplied
   tenant/entity id is ignored; a mismatch is a hard 403 + audit event.
4. **Control-plane separation.** Platform/provisioning/billing-operator data lives
   in a separate schema/role and is never readable under a tenant session.

Rejected alternatives: schema-per-tenant and database-per-tenant (operational cost
at SMB tenant counts). The dual-discriminator + RLS model is designed to allow
later physical sharding by tenant if an enterprise tier requires it.

## 2. Request context lifecycle

```
authenticated request
  → resolve session → user
  → resolve active tenant (membership) and permitted legal_entity set
  → open DB tx; SET LOCAL app.tenant_id, app.legal_entity_ids, app.user_id
  → service authorises (six checks §3) → repository queries (RLS enforced) → commit
```

## 3. Authorisation — six independent server-side checks

Every protected operation must pass **all** applicable checks; none inferred from
another; none client-supplied:

1. Tenant access · 2. Legal-entity access (non-transitive) · 3. Module permission
(`resource:action`) · 4. Record scope (own/team/entity) · 5. Field-level permission
(HR/payroll sensitive fields) · 6. Approval authority (limits/roles for posting,
payroll finalisation, statutory submission).

**UI visibility is never authorisation** — the server gate is the boundary; the UI
merely hides controls for UX.

## 4. Authentication & sessions

- Auth.js v5; credentials-based sign-in. **Enterprise SSO is not required for the
  initial release (AD-4)**; the user, tenant and membership models must allow
  OIDC/SSO to be added later **without replacing** them.
- **Database session strategy** (server-side, revocable) so admins can force logout.
- Argon2id password hashing; email verification; **TOTP MFA** required by policy for
  finance/HR/admin/approval roles.
- Multi-tenant users: switching active tenant/entity re-establishes context
  server-side (no client-trusted switch).
- Rate limiting + lockout on auth endpoints; audit events for login, logout, failed
  login, tenant/entity switch, privilege change.

## 5. Field-level protection for HR & payroll

- Compensation, statutory IDs (NRIC/FIN, MyKad/passport, NIK/NPWP) and bank-payment
  instructions live in **separate protected tables**, omitted from default DTOs.
- Access requires a **specific field permission**; otherwise values are masked.
- **Every read** of sensitive fields emits an audit event.
- Exports respect field-level permissions (no leaking payroll/PII via export).

## 6. Segregation of duties (SoD)

- Distinct permissions for prepare vs approve vs post vs pay across finance and
  payroll. The same user cannot both create and approve the same
  invoice/journal/payroll run/statutory submission unless an explicit tenant policy
  permits it (and that election is audited).
- Approval limits are attributes of the role/assignment, evaluated server-side.

## 7. Immutable audit

- Single append-only `audit_event` store: `(tenant, legal_entity?, actor, action,
  resource_type, resource_id, before/after diff, request_id, ip, ts, prev_hash,
  hash)`.
- **Tamper-evident**: per-tenant hash chain (`hash = H(prev_hash ‖ payload)`),
  periodic anchoring. **No UPDATE/DELETE** for the app role — enforced by table
  privileges + a block trigger + RLS.
- Written via the transactional outbox so an audited action and its event commit
  atomically.

## 8. Cross-border data considerations (SG/MY/ID)

Personal, payroll and accounting data may exist for all three jurisdictions within
one tenant. The design must **assess and control cross-border access**:

- Each jurisdiction has a personal-data protection regime — PDPA (SG, PDPC),
  PDPA as amended (MY, JPDP) and the Personal Data Protection Law (ID) — imposing
  obligations on personal-data handling, cross-border transfer and breach
  notification. **The specific obligations, commencement dates and sanction levels
  are not recorded** in these documents: their primary sources were not retrieved.
  Treat all of them as **RESEARCH REQUIRED / SPECIALIST CONFIRMATION REQUIRED**.
- Design controls: legal-entity-scoped access to personal/payroll data; explicit
  grants for a user to view another entity's HR data; export controls and audit on
  personal-data access; retention policy per legal entity.
- **Deployment/residency direction (AD-6):** SaaS-first, with **Azure Singapore as
  the proposed primary region**. This is an **architectural direction, not a legal
  conclusion** — data residency, DR region and cross-border handling for SG, MY and
  ID **must be confirmed by legal and security specialists before production
  deployment**. No on-premises deployment is designed in the initial phases.
- The specific obligations of each regime (including cross-border transfer
  conditions and retention periods) are **not recorded** in these documents; their
  primary sources were not retrievable (REGULATORY_SOURCE_REGISTER.md §5).
- **No compliance claim** is made by listing a requirement. Legal specialist
  confirmation is required before asserting cross-border compliance.

## 9. Platform security baseline

TLS in transit; encryption at rest (Azure-managed keys); secrets in Azure Key
Vault; least-privilege non-superuser DB role; Zod validation at boundaries; CSRF
protection; rate limiting; dependency & container scanning in CI; signed webhooks;
idempotency on unsafe endpoints; PII data-subject export/erase honouring financial
& statutory retention rules.

## 10. Tenant-isolation & entity-isolation testing (mandatory)

- A dedicated suite proves, per tenant-owned table, that cross-tenant and
  cross-legal-entity reads/writes are rejected at the DB (RLS) and service layers.
- AuthZ tests cover all six checks incl. field-level masking and SoD.
- These suites are **release gates** (see PHASE_01_FOUNDATION.md and roadmap gates).
