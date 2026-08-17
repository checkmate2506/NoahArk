# NoahArk — Architecture Decision Register

> Phase 0R. Format: ID · Decision · Context · Consequences · Status.
> Status values: ACCEPTED · PROPOSED · OPEN (needs user decision) · SUPERSEDED.

## Superseded by Phase 0R

| ID | Superseded assumption (from earlier Phase 0) | Replaced by |
|---|---|---|
| ADR-0R-A | "Worldwide / country-neutral localisation via a generic country-adapter engine, Singapore-first" | **Scope restricted to SG/MY/ID only**; three named adapters, no generic worldwide engine (ADR-14) |
| ADR-0R-B | Single-currency-leaning defaults; currency as a later concern | **Per-legal-entity functional currency (SGD/MYR/IDR)** + FX + consolidation from the accounting core (ADR-16) |
| ADR-0R-C | Tenant≈company; "multi-company optional" | **Mandatory Tenant → Legal-entity model**; every country-sensitive txn belongs to a legal entity (ADR-2, ADR-3) |
| ADR-0R-D | Generic single tax/e-invoice abstraction | **Country-specific tax + separate e-invoicing adapters** (InvoiceNow/MyInvois/Coretax) (ADR-17, ADR-18) |
| ADR-0R-E | "Singapore localisation" framing only | **Three-country requirement registers** + regulatory-source governance (ADR-19) |

Useful non-conflicting Phase 0 design (modular monolith, RLS tenancy, immutable
audit, double-entry, outbox, Postgres jobs, REST+OpenAPI, shadcn UI) is **retained**
and extended.

## Accepted / proposed decisions

| ID | Decision | Context | Consequences | Status |
|---|---|---|---|---|
| ADR-1 | Modular monolith, not microservices | SMB scale; one team; strong consistency needs | Simpler ops; enforce boundaries via packages + lint | ACCEPTED |
| ADR-2 | Mandatory **Tenant → Legal-entity** hierarchy | Multi-country groups in one tenant | Two isolation axes everywhere | ACCEPTED |
| ADR-3 | Jurisdiction + functional currency are properties of the **legal entity** (immutable after first posting) | Country rules must not rely on tenant flag | Entity owns the country contract | ACCEPTED |
| ADR-4 | Shared-DB + dual discriminators (`tenant_id`,`legal_entity_id`) + **RLS** | Isolation w/ manageable ops | Non-superuser app role; RLS on every table | ACCEPTED |
| ADR-5 | Context from **server session only**; client ids untrusted | Prevent spoofing | Hard 403 + audit on mismatch | ACCEPTED |
| ADR-6 | **Six-check authZ** (tenant, entity, module, record, field, approval) | Enterprise RBAC + SoD | UI is never authorization | ACCEPTED |
| ADR-7 | Auth.js v5, **DB sessions**, Argon2id, TOTP MFA | Revocable sessions; regulated roles | App-layer RBAC (not in Auth.js) | ACCEPTED |
| ADR-8 | **Append-only, hash-chained audit**; no app UPDATE/DELETE | Tamper-evidence | Trigger + privileges + RLS enforce it | ACCEPTED |
| ADR-9 | **Transactional outbox** for events/notifications/webhooks/e-invoice/projections | Reliable side-effects | Consumers idempotent | ACCEPTED |
| ADR-10 | **Graphile Worker (Postgres)** for jobs | Enqueue atomically with business tx; minimal infra | Revisit Redis at scale (OPEN AD-5) | PROPOSED |
| ADR-11 | **shadcn/Radix + Tailwind** owned UI | Own brand, no licence lock-in | Build/maintain components | PROPOSED |
| ADR-12 | **REST + OpenAPI 3.1** external contract | Webhooks/integrations need REST | tRPC internal-only optional later | ACCEPTED |
| ADR-13 | **Double-entry ledger per legal entity**, immutable after posting, reversal-only, idempotent, transactional | Financial integrity | DB balance constraint; period locks | ACCEPTED |
| ADR-14 | **Three country adapters (SG/MY/ID)** behind shared interfaces; no generic worldwide engine | Scope discipline | Adds a country = new adapter + approval | ACCEPTED |
| ADR-15 | **Statutory rules versioned, effective-dated, source-referenced, platform-maintained** | No invented/hard-coded formulas | Rule-set snapshots pinned to calculations | ACCEPTED |
| ADR-16 | **One functional currency per entity** + FX (locked on posting) + consolidation in group currency | Multi-country group reporting | Realised/unrealised FX; CTA; elimination | ACCEPTED |
| ADR-17 | **Country-specific tax determination** (GST / SST / PPN+WHT) as tax lines; never breaks balancing | Three indirect-tax regimes | Adapter computes; ledger stays invariant | ACCEPTED |
| ADR-18 | **Separate e-invoicing adapters** (InvoiceNow / MyInvois / Coretax) under a shared orchestrator | Country lifecycles differ | No universal state machine beyond storage/audit | ACCEPTED |
| ADR-19 | **Regulatory-source governance** with classifications + register | Time-sensitive statutory data | No compliance claim without specialist sign-off | ACCEPTED |
| ADR-20 | **Payroll per legal employer**; distinct time/attendance/payroll domains | Avoid conflating time tables | Employment binds person↔employer↔jurisdiction | ACCEPTED |
| ADR-21 | Languages limited to **EN / MS / ID**; language axis independent of tax/payroll | Regional scope | ICU catalogs; no worldwide i18n | ACCEPTED |

## Approved decisions (closed — Phase 0R.1)

All ten decisions are **CLOSED**. None remains open.

| ID | Decision | Approved outcome | Status |
|---|---|---|---|
| **AD-1** | Multi-entity foundation | **YES.** Tenant and legal entity are separate **from the first database migration**. A tenant may own multiple legal entities across SG, MY and ID. Not a retrofit. | **ACCEPTED** |
| **AD-2** | Billing provider | **Deferred.** Phase 1 may define a **provider-neutral subscription and entitlement interface**, but **must not implement external charging**. | **ACCEPTED** |
| **AD-3** | Email provider | **Deferred.** Use a **provider interface** with a development-safe implementation. No tight coupling to any email vendor. | **ACCEPTED** |
| **AD-4** | SSO | **Not required for initial release.** Authentication architecture must remain capable of adding enterprise SSO later **without replacing** the user, tenant or membership models. | **ACCEPTED** |
| **AD-5** | Jobs and queues | **PostgreSQL-based jobs, transactional outbox and worker processing.** **No Redis in Phase 1** unless a demonstrated requirement cannot be met safely with PostgreSQL. | **ACCEPTED** |
| **AD-6** | Deployment model & residency | **SaaS-first**; **Azure Singapore** proposed primary region. **Architectural direction, not a legal-compliance conclusion** — residency, DR region and cross-border handling for SG/MY/ID remain subject to **specialist legal and security confirmation before production**. **No on-premises deployment** in initial phases. | **ACCEPTED** (with standing specialist condition) |
| **AD-7** | Group reporting currency | Each legal entity has **one functional currency** by jurisdiction/approved config. A tenant may select **one group-reporting currency from SGD, MYR or IDR**; **default SGD**. Changing it after consolidated reporting begins requires a **controlled migration and audit record**. | **ACCEPTED** |
| **AD-8** | Fixed assets | **Deferred** until core accounting, AR and AP are stable. Preserve architecture extension points; **not in Phase 1**. | **ACCEPTED** |
| **AD-9** | Statutory-report depth | Country phases first provide **validated operational reports, audit data and authority-compatible exports where specifications are verified**. **Direct statutory submission only** in the relevant country integration phase, **after official schemas and certification requirements are confirmed**. | **ACCEPTED** |
| **AD-10** | Brand assets | **NoahArk** as provisional product name; **replaceable placeholder design tokens and assets** during foundation development. **No PMSuite branding or visual assets.** | **ACCEPTED** |

## Phase 0R.1 — source-governance correction

| ID | Decision | Rationale | Status |
|---|---|---|---|
| ADR-22 | **A statutory item may be marked `VERIFIED` only when a primary official source was retrieved and its content directly supports the assertion.** | Phase 0R marked items VERIFIED on secondary sourcing, breaching the primary-source rule | ACCEPTED |
| ADR-23 | **Secondary sources (vendors, consultancies, law firms, blogs, aggregators) are discovery references only, explicitly labelled NOT AUTHORITATIVE, and may never be the basis of an implementation requirement.** | Prevents commercial summaries becoming de-facto specifications | ACCEPTED |
| ADR-24 | **Unverified rates, thresholds, mandate dates and formulas are removed from requirement documents**, not merely annotated. | An unverified number left in a spec eventually gets implemented | ACCEPTED |
| ADR-25 | **Country phases (11–16) are gated**: none may start until its statutory items are primary-sourced and specialist-confirmed. **Phases 1–10 carry no statutory dependency** and proceed regardless; the ledger is testable with **synthetic** tax rates. | Decouples engine progress from regulatory verification | ACCEPTED |
| ADR-26 | **Correction of the Phase 0R readiness contradiction.** Phase 0R stated both "none blocking" and "AD-1/5/6 must be resolved before Phase 1". With all ten decisions now closed, **Phase 1 has no open architectural blockers**; the remaining blockers are **statutory only and bind Phases 11–16**. | Removes the contradictory readiness statement | ACCEPTED |
