# NoahArk — Tenant & Legal-Entity Architecture

> Phase 0R. Design only. This is the backbone of NoahArk's isolation model.

## 1. Mandatory hierarchy

```
Tenant (subscribing customer / corporate group)
 └── Legal entity            (exactly one jurisdiction: SG | MY | ID)
      ├── Business unit
      │    └── Department
      │         └── Team
      ├── Branch / location
      ├── Warehouse (where applicable)
      └── Project / cost centre
```

- **Tenant** = the billing/subscription boundary and top isolation boundary.
- **Legal entity** = a jurisdiction-bound company; the unit of accounting, tax,
  payroll and statutory submission. **This is where country rules live.**
- Business unit / department / team / branch / warehouse / cost centre are
  organisational sub-structures **within** a legal entity.

Example tenant "ABC Group": `ABC Singapore Pte Ltd (SG)`, `ABC Malaysia Sdn Bhd (MY)`,
`PT ABC Indonesia (ID)` — one tenant, three legal entities, three jurisdictions.

## 2. The legal entity owns the country contract

Each legal entity record carries (or references) exactly one jurisdiction and, from
that, the following country-determined configuration:

| Attribute | Source of truth |
|---|---|
| Jurisdiction (SG/MY/ID) | Legal entity (immutable after first posting) |
| Registered identifiers (UEN / SSM+TIN / NPWP+NITKU) | Legal entity |
| Taxpayer identifiers & registrations (GST/SST/PKP) | Legal entity |
| Functional currency (SGD/MYR/IDR) | Legal entity (immutable after first posting) |
| Fiscal-year & period configuration | Legal entity |
| Chart-of-accounts assignment & ledger | Legal entity (not shared) |
| Tax codes & determination rules | Country adapter + legal-entity elections |
| Statutory invoice & e-invoicing config | Country adapter + legal-entity registration |
| Payroll config & statutory contributions | Country adapter + legal-entity elections |
| Employment rules | Country adapter |
| Public-holiday calendar | Country adapter (+ entity/branch overrides where legal) |
| Document numbering sequences | Legal entity (per statutory rules) |
| Address structure | Country adapter |
| Default time zone & document language | Legal entity |
| Statutory reports & retention policy | Country adapter + legal-entity |

**Rule:** a tenant-level country setting is insufficient for any country-sensitive
transaction. Every such transaction resolves jurisdiction via its legal entity.

## 3. What legal entities must NOT share

The following are **legally separated per legal entity** and must never be shared
across entities (enforced by scoping + DB constraints):

- Accounting journals & ledgers
- Statutory invoice / document sequences
- Payroll runs
- Tax submissions
- Statutory contribution submissions
- Bank reconciliation
- Period locks & fiscal closing records

Cross-entity financial effects are only possible through **explicit intercompany
processing** (matched intercompany accounts + elimination on consolidation). There
is no implicit cross-entity posting.

## 4. Shared master-data ownership model

Some master data is naturally shared across a tenant's entities but must be
**assigned/authorised per legal entity** for transactional use. Pattern: a
tenant-scoped master record + explicit `*_legal_entity_assignment` links (with
per-entity attributes such as tax treatment, control account, currency).

| Shared entity | Owning context | Tenant-shared master? | Per-legal-entity binding |
|---|---|---|---|
| **User** | Identity & Access | Yes (one identity per person) | Access granted **per legal entity** via membership; entity access is not transitive |
| **Employee / person** | HR | Person is tenant-level; **employment** is per legal employer | Payroll/statutory only via an employment bound to one legal entity |
| **Customer** | CRM | Yes | AR customer link + tax treatment per entity that transacts |
| **Contact** | CRM | Yes | Visibility scoped by entity assignment |
| **Vendor / supplier** | Purchasing | Yes | AP link + WHT/tax treatment per entity |
| **Product / service** | Catalog | Yes | Tax-code mapping & pricing per entity/jurisdiction |
| **Price list** | Catalog & Pricing | Yes | Currency + entity assignment |
| **Project** | Projects | Tenant or entity level | Costing maps to one entity's cost centres |
| **Contract** | Sales/CRM | Yes | Billing entity assigned explicitly |
| **Chart of accounts** | Accounting | Template shareable; **ledger is per entity** | Each entity has its own accounts instance |
| **Tax codes** | Country adapter | Per jurisdiction (platform-maintained) | Entity elects which apply |
| **Bank accounts** | Accounting | No | Owned by one legal entity |
| **Payment terms** | Sales/Accounting | Yes | Entity default overridable |
| **Cost centres / departments** | Accounting/HR | Per entity | — |
| **Attachments** | Files | Tenant-scoped keys | Referenced by owning record's entity |
| **Custom fields** | Platform | Tenant-defined | May be entity- or jurisdiction-scoped |
| **Approval policies** | Workflow | Tenant-defined | May be scoped per entity/module/amount |

## 5. Access model (six independent checks)

Authorisation is the **conjunction** of six server-side checks — none may be
inferred from another, and none may be supplied by the client:

1. **Tenant access** — is the session's user a member of this tenant?
2. **Legal-entity access** — is the user granted this specific legal entity?
   (Access to one entity never implies access to another.)
3. **Module permission** — does the user's role permit this resource:action?
4. **Record scope** — is the record within the user's allowed scope (own/team/entity)?
5. **Field-level permission** — may the user see/modify sensitive fields (HR/payroll)?
6. **Approval authority** — does the user hold the required approval limit/role for
   this action (posting, payroll finalisation, statutory submission)?

See SECURITY_AND_TENANCY.md for enforcement mechanics (session context, RLS, policy
layer).

## 6. Immutability rules on entity attributes

- **Jurisdiction** and **functional currency** are immutable once the entity has any
  posted financial record. Corrections require a new entity, not mutation.
- Registered identifiers and tax registrations are **effective-dated** (a GST/SST/PKP
  registration has validity dates that determine tax treatment on a given date).

## 7. Data model anchors

Foundational tables (detail in DOMAIN_MODEL.md): `tenant`, `legal_entity`
(`jurisdiction`, `functional_currency`, `time_zone`, `default_language`,
identifiers), `business_unit`, `department`, `team`, `branch`, `warehouse`,
`cost_centre`, `membership` (user × tenant), `legal_entity_access` (user × entity),
plus `*_legal_entity_assignment` bridges for shared master data.
