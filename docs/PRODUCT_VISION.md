# NoahArk — Product Vision

> Status: Phase 0R (three-country revision). Design only. No application code.
> Supersedes any worldwide/country-neutral assumptions from the earlier Phase 0.

## 1. Vision statement

NoahArk is an independently built, multi-tenant SaaS business-management platform
purpose-built for **Singapore, Malaysia and Indonesia**. It is the single system
of record where a Southeast-Asian SMB or corporate group runs its customers,
sales, people, projects, and money — with **legally separated accounting, tax and
payroll for each operating jurisdiction** inside one tenant.

The differentiating bet is **integration correctness under real regional
compliance**: a quote becomes a sales order, an invoice, a statutory e-invoice
(InvoiceNow / MyInvois / Coretax), a balanced double-entry posting, and a
collections task — without re-keying, without the numbers drifting, and without
one country's rules leaking into another's ledger.

## 2. What NoahArk is

- A **regional** platform for **SG, MY and ID only** (see PRODUCT_SCOPE.md §Out of scope).
- A **modular monolith** with strict internal bounded contexts.
- A **tenant → legal-entity** model where every country-sensitive transaction
  belongs to a legal entity, never to a mere tenant-level country flag.
- A system where **statutory rules are versioned, effective-dated and traceable to
  an official source**, never invented and never hard-coded.

## 3. What NoahArk is explicitly NOT

- Not a worldwide or generic global ERP.
- Not a country-neutral accounting product.
- Not a user-configurable "any-country" statutory rule engine.
- Not a system that supports arbitrary currencies, languages or tax authorities.
- Future country expansion is **out of scope** unless separately approved.

## 4. Design pillars

1. **Jurisdiction integrity** — jurisdiction is a property of the legal entity and
   drives currency, tax, e-invoicing, payroll, holidays, numbering and reports.
2. **Isolation that never leaks** — tenant isolation *and* legal-entity isolation,
   both enforced server-side and in the database.
3. **Money that always balances** — double-entry, immutable after posting,
   corrected by reversal, idempotent, transactional.
4. **Compliance you can defend** — every statutory requirement is source-referenced
   and classified; nothing is claimed "compliant" without specialist confirmation.
5. **Localisation without hard-coding** — three country adapters, shared
   orchestration, no generic global engine.
6. **Trustworthy audit** — immutable, tamper-evident audit events for sensitive
   operations.

## 5. Value proposition by audience

| Audience | Pain today | NoahArk value |
|---|---|---|
| Regional SMB group (SG+MY+ID) | 3–4 country tools + spreadsheets; consolidation by hand | One tenant, three compliant legal entities, consolidated group reporting |
| Finance lead | Reconciling CRM/sales to accounting; e-invoice mandates | Straight-through sales→ledger→e-invoice with audit trail |
| HR/payroll officer | Different statutory rules per country; sensitive data everywhere | Country payroll adapters + field-level protection of pay/PII |
| Owner/GM | No cross-module, cross-entity view | Group dashboards with per-entity drill-down |

## 6. Success criteria (product-level, not a compliance claim)

- A tenant can operate one SG, one MY and one ID legal entity with **separate**
  ledgers, tax registrations, payroll runs, statutory submissions and document
  sequences.
- No cross-tenant or cross-legal-entity data access is possible (proven by tests).
- Every statutory calculation traces to a versioned, source-referenced rule set.
- No module is considered "done" on screens + CRUD alone (see PRODUCT_SCOPE.md).

## 7. Non-goals for the approved roadmap

- Additional countries, currencies or languages beyond SG/MY/ID and
  English / Bahasa Melayu / Bahasa Indonesia.
- Point-of-sale hardware, e-commerce storefront, or manufacturing MRP (not in the
  approved module list).
- Automated legal/tax advice. NoahArk records requirements and computes against
  configured, source-referenced rules; it does not replace a licensed specialist.

## 8. Brand & identity note

NoahArk has an independently designed identity. PMSuite is referenced only as a
public functional/feature checklist; none of its name, wording, assets,
screenshots, database structure or UI is copied (per CLAUDE.md).
