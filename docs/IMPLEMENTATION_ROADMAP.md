# NoahArk — Implementation Roadmap

> Phase 0R. Design only. Country support introduced deliberately, entity-scoped.

## 1. Assessment of the proposed 22-phase sequence

The proposed sequence is sound in principle (foundation → parties → CRM → sales →
projects → HR → attendance → accounting → AR → AP → country finance → country
payroll → consolidation → workspace → reporting → API → billing → hardening).
**Recommended adjustments:**

1. **Move the accounting foundation earlier — before sales invoicing.** Original
   puts Accounting at Phase 8 but Sales/AR at 9. Invoicing that posts to a ledger
   needs the ledger, periods and posting controls first. **Recommendation:** deliver
   the **accounting core (ledger, periods, journals, posting, FX scaffold)** as
   Phase 4, before Quotations/Sales-orders/Invoicing. Sales documents can be
   designed in parallel but invoice **posting** depends on it.
2. **Country tax config is a prerequisite for that country's invoicing**, not a
   later add-on. Keep country finance phases (11–13) but ensure each country's
   **tax determination + numbering** lands with, or immediately before, that
   country's first posted statutory invoice.
3. **Cross-cutting engines are Phase 1, not late.** Approvals, audit, notifications,
   files, outbox/jobs must exist in the foundation because later financial/payroll
   modules depend on them.
4. **Consolidation (17)** correctly stays late (needs ≥2 entities' ledgers), but the
   **intercompany link** primitives should be defined with the accounting core.
5. **Reporting engine** primitives (read models/outbox projections) start in the
   foundation; **statutory reports** land with each country phase.

The revised roadmap below folds these in while preserving the intent and numbering
spirit.

## 2. Revised phase list

| Phase | Objective | Country impact |
|---|---|---|
| **1** | Platform foundation: tenant, legal entity, users, RBAC, field policies, audit, approvals, notifications, files, jobs/outbox, API framework, settings, CI/CD | Framework only (SG/MY/ID enums) |
| **2** | Shared parties & catalog: customers, contacts, vendors, products/services, price lists, per-legal-entity assignments, custom fields | Tax-mapping placeholders |
| **3** | CRM: leads, opportunities, activities, pipeline | None |
| **4** | **Accounting core**: CoA per entity, fiscal year/periods, period locks, journals, posting, reversal, dimensions, FX scaffold, intercompany primitives | Per-entity ledger |
| **5** | Quotations, sales orders & commercial workflow (approvals, numbering shell) | Numbering rules per entity |
| **6** | Projects, tasks, Kanban, Gantt, milestones, time tracking & timesheets | None |
| **7** | HR core: person, employment, org structure, positions, sensitive-data field permissions | Statutory-ID attributes per jurisdiction |
| **8** | Attendance, shifts, leave & public-holiday calendars | Holiday calendars SG/MY(state)/ID |
| **9** | AR: invoicing, credit/debit notes, collections, receipts (posts to Phase-4 ledger) | Statutory invoice content per entity |
| **10** | AP: vendor bills, expenses/claims, purchasing, payments, 3-way match | WHT placeholders |
| **11** | **SG finance**: GST determination, tax invoice/credit note, GST reporting, **InvoiceNow** | SG |
| **12** | **MY finance**: SST determination, invoice rules, **MyInvois** | MY |
| **13** | **ID finance**: PPN + withholding, Faktur Pajak, **Coretax** | ID |
| **14** | **SG payroll**: CPF, SDL, FWL, SHG, IR8A/AIS | SG |
| **15** | **MY payroll**: EPF, SOCSO, EIS, PCB/MTD, HRD Corp | MY |
| **16** | **ID payroll**: PPh 21 (TER), BPJS Kesehatan & Ketenagakerjaan, THR | ID |
| **17** | Multi-currency depth, intercompany processing, group consolidation & elimination | All |
| **18** | Workspace, tickets, documents, asset assignments | None |
| **19** | Dashboards, management & statutory reporting | Per-country statutory reports |
| **20** | API, webhooks, imports/exports, external integrations | None |
| **21** | SaaS billing, plans, provisioning, tenant administration, entitlement enforcement | None |
| **22** | Security hardening, performance, DR, production readiness | All |

## 3. Per-phase specification template

Every phase must document: **Objective · Included capabilities · Explicit
exclusions · Schema impact · API impact · Security impact · Country impact · Test
gates · Regulatory-research prerequisites · Completion criteria · Rollback/recovery.**

Illustrative entries:

### Phase 1 — Foundation (detail in PHASE_01_FOUNDATION.md)
- **Objective**: prove tenant + legal-entity isolation, RBAC, audit, approvals,
  jobs, files end-to-end via a thin tenant/legal-entity/user/role admin slice.
- **Exclusions**: no country tax/payroll/e-invoicing; no financial documents.
- **Schema**: shared/identity/tenant/legal-entity/audit/workflow tables + RLS.
- **Security**: dual-axis RLS, six-check authZ, immutable audit, MFA.
- **Country impact**: SG/MY/ID as enums + legal-entity country contract fields only.
- **Test gates**: tenant- **and** legal-entity-isolation suites; authZ; audit
  immutability; migration integrity. **All green to exit.**
- **Rollback**: forward-only migrations with tested down paths in dev; feature
  flags; no destructive data ops.

### Phase 11 — SG finance (illustrative country phase)
- **Regulatory prerequisites**: GST rate & treatments, tax-invoice content, GST
  return format, InvoiceNow/PINT SG schema and the mandate/notification mechanism —
  each retrieved from a **primary official source** and specialist-confirmed
  (REGULATORY_SOURCE_REGISTER.md §7).
- **Current status: NOT MET.** None of the above is verified today; the GST rate
  itself is `RESEARCH REQUIRED`.
- **Completion**: SG entity issues a compliant tax invoice, posts GST correctly,
  and produces a valid InvoiceNow submission in sandbox, with audit + tests.

### Regulatory gate (applies to Phases 11–16 without exception)

A country phase **must not start** until every statutory item it depends on is
`PRIMARY OFFICIAL` **and** specialist-confirmed. Consequences of the Phase 0R.1
remediation:

| Phase | Blocking unknowns (today) |
|---|---|
| 11 SG finance | GST rate & treatments; InvoiceNow phases; PINT SG version |
| 12 MY finance | Service-tax rates & thresholds; MyInvois phases, document types, lifecycle, API version |
| 13 ID finance | **PPN rate + effective-rate (DPP) mechanism**; Coretax schema/NSFP/lifecycle; withholding categories |
| 14 SG payroll | CPF wage ceilings; SDL; FWL; SHG; IR8A/AIS spec (**CPF rates themselves are verified**) |
| 15 MY payroll | EPF, SOCSO, EIS, PCB/MTD, HRD Corp schedules |
| 16 ID payroll | PPh 21 method & tables; BPJS rates; THR |

**Phases 1–10 carry no statutory dependency** and are therefore unblocked. The
ledger (Phase 4) and AR/AP (Phases 9–10) must be buildable and testable with
**synthetic** tax rates so that financial-engine progress never waits on statutory
verification.

## 4. Dependency notes

- Country finance phases (11–13) depend on Phase 4 (ledger) + Phase 9 (AR).
- Country payroll phases (14–16) depend on Phase 7 (HR employment) + Phase 8
  (attendance/leave) + Phase 4 (posting).
- Consolidation (17) depends on ≥2 country ledgers + intercompany primitives.
- No country phase starts before its regulatory prerequisites are `VERIFIED` or
  `SPECIALIST`-confirmed.

## 5. Release discipline

Each phase ships behind flags, with its test gates as CI blockers, and leaves prior
phases' isolation/audit/accounting invariants intact (regression-gated).
