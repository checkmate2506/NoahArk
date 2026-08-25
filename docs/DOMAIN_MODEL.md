# NoahArk — Domain Model

> Phase 0R. Design only. Indicative schema; not final DDL. No migrations created.

## 1. Conventions

- Every tenant-owned table has `tenant_id`. Every country-sensitive / financial /
  HR row also has `legal_entity_id`.
- Audit columns: `created_at`, `created_by`, `updated_at`, `updated_by`.
- **Money and prices are stored as exact `NUMERIC(23,6)`** + `currency`, mapped in
  Prisma as `Decimal @db.Decimal(23, 6)` (ADR-71, Phase 2A). **Corrects the
  original Phase 0R statement that money used integer minor units and that IDR
  was necessarily zero-decimal** — neither is implemented, and the second was
  never verifiable.
  - Application code must **never** use JavaScript binary floating point for a
    monetary value. `Number()`, `parseFloat()`, `parseInt()`, unary `+`, `Math.*`
    and statically identifiable arithmetic over a known price/amount identifier
    are scanned by `apps/web/lib/monetaryFloatBoundary.test.ts`. That scan is
    **defense in depth** (identifier-based; a rename bypasses it — ADR-73 F-5).
    The load-bearing control is schema-level `NUMERIC(23,6)` / no
    `real`/`double precision` monetary columns.
  - Decimal values cross API boundaries as **validated decimal strings**, never
    JSON numbers (a JSON number deserializes as an IEEE-754 double).
  - Currency-specific **presentation and statutory rounding are adapter
    concerns**, separate from storage precision, and belong to the verified
    country adapters (Phases 11–16).
  - **IDR precision and rounding remain unverified** (`RESEARCH` in
    COUNTRY_COMPATIBILITY_MATRIX.md §1) and must not be invented. IDR is stored
    at full `NUMERIC(23,6)` precision like every other currency.
- Postable documents carry a `status` state machine and, once posted, are immutable.
- Soft-delete only where legally allowed; posted financial/statutory records are
  never destructively deleted.
- No foreign keys **across bounded contexts**; cross-context references are IDs.

## 2. Shared kernel & identity

| Table                                                                  | Purpose                               | Key scope                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| `tenant`                                                               | Subscribing customer / group          | root                                                                                |
| `legal_entity`                                                         | Jurisdiction-bound company            | `tenant_id`; `jurisdiction`, `functional_currency`, `time_zone`, `default_language` |
| `business_unit`,`department`,`team`,`branch`,`warehouse`,`cost_centre` | Org structure                         | `legal_entity_id`                                                                   |
| `user`                                                                 | Login identity (one per person)       | global identity, joined per tenant                                                  |
| `membership`                                                           | user × tenant                         | `tenant_id`                                                                         |
| `legal_entity_access`                                                  | user × legal entity (non-transitive)  | `tenant_id`,`legal_entity_id`                                                       |
| `role`,`permission`,`role_permission`,`user_role`                      | RBAC                                  | `tenant_id` (roles), platform (permission catalog)                                  |
| `field_policy`                                                         | field-level access rules (HR/payroll) | `tenant_id`                                                                         |
| `tenant_setting`,`legal_entity_setting`                                | configuration                         | scoped                                                                              |
| `custom_field_def`,`custom_field_value`                                | tenant/entity custom fields           | scoped                                                                              |
| `attachment`                                                           | file metadata (S3 key)                | `tenant_id` (+ owner ref)                                                           |
| `comment`,`activity`                                                   | polymorphic timeline                  | `tenant_id` (+ owner ref)                                                           |
| `audit_event`                                                          | append-only, hash-chained             | `tenant_id`                                                                         |
| `approval_request`,`approval_step`                                     | workflow                              | scoped                                                                              |
| `notification`,`notification_outbox`                                   | notifications                         | scoped                                                                              |
| `event_outbox`                                                         | domain events                         | `tenant_id`                                                                         |
| `idempotency_key`                                                      | idempotent ops                        | scoped                                                                              |
| `webhook_endpoint`,`webhook_delivery`                                  | integrations                          | `tenant_id`                                                                         |
| `import_batch`,`import_row`                                            | staged imports                        | scoped                                                                              |
| `plan`,`entitlement`,`subscription`,`usage_meter`                      | SaaS billing                          | `tenant_id`                                                                         |

## 3. CRM & Catalog

**As implemented in Phase 2A** (this supersedes the original `account` (customer)
naming, which collided with the Auth.js `Account` model already present in
`schema.prisma` — see ADR-71):

- `party` — ONE tenant-owned counterparty master (`ORGANISATION` or
  `INDIVIDUAL`), with `party_contact` and `party_address`, and an explicit
  managing `owner_legal_entity_id` (ADR-73). The owner mutates shared fields;
  assignments grant additional **read** visibility to other legal entities.
- `party_legal_entity_assignment` — extra read-visibility grant; a non-owner
  assigned entity may see the master but may not mutate shared fields.
- `customer_role` / `vendor_role` — per-legal-entity roles hung off that
  assignment. Customer and vendor are **roles, not separate masters**, so one
  organisation can be a customer of the SG entity and a vendor of the MY entity
  without duplication.
- `catalog_item` (one model, `PRODUCT` | `SERVICE`), `catalog_category`,
  `unit_of_measure`, `catalog_item_legal_entity_assignment`.
- `price_list`, `price_list_legal_entity_assignment`, `price_list_entry`.

Still design-only, later phases: `lead`, `opportunity`, `activity` (Phase 3);
`product_tax_mapping` (country phases — Phase 2 ships only the inert
`catalog_item.tax_category_code` placeholder).

## 4. Sales

`quote`,`quote_line` → `sales_order`,`sales_order_line` → `invoice`,`invoice_line`
→ `credit_note`/`debit_note`; `collection`/`receipt` links to Accounting payments.
Each sales document has `legal_entity_id`, tax lines, `document_number`
(from the entity's statutory sequence), `document_date`, and (where required)
`tax_date`. Invoices link to an e-invoice submission (see EINVOICING_ARCHITECTURE.md).

## 5. Purchasing & Expenses

`vendor`, `purchase_order`,`po_line`, `goods_receipt`, `vendor_bill`,`bill_line`,
`three_way_match`; `expense_claim`,`expense_line`. Withholding-tax lines where the
jurisdiction requires (ID PPh, MY WHT). All post to GL via Accounting.

## 6. Accounting / Ledger (per legal entity)

`gl_account` (per entity instance of a CoA), `fiscal_year`, `accounting_period`,
`period_lock`, `journal`, `journal_line` (debit **or** credit), `tax_code`,
`tax_line`, `ar_customer`, `ap_vendor`, `payment`, `payment_allocation`,
`bank_account`, `bank_statement`,`bank_reconciliation`, `dimension`
(cost_centre/department/project), `intercompany_link`, `consolidation_mapping`,
`fx_rate`. Invariants in ACCOUNTING_ARCHITECTURE.md.

## 7. HR, Time & Payroll (sensitive)

- HR: `person`, `employment` (person × legal employer, effective-dated),
  `position`, `reporting_line`, `work_location`, `compensation` (sensitive, separate
  table + field policy), `statutory_profile` (per jurisdiction: e.g. SG CPF status,
  MY EPF/SOCSO, ID BPJS/PPh21 attributes), `bank_payment_instruction` (sensitive).
- Time & Attendance: `attendance`, `shift`, `leave_type`, `leave_request`,
  `public_holiday_calendar`, `holiday`. Timesheets: `timesheet`, `timesheet_line`,
  `time_entry` (project time — a **distinct** domain from attendance & payroll).
- Payroll: `payroll_run` (per legal employer + period), `payroll_input`,
  `payroll_calculation` (with input + rule-version snapshot), `payslip`,
  `payroll_posting`, `statutory_submission`. See PAYROLL_ARCHITECTURE.md.

## 8. Country adapter data (platform-maintained, versioned)

`jurisdiction`, `statutory_ruleset` (jurisdiction × domain × version,
effective-dated, source-referenced), `tax_code_def`, `contribution_table`,
`einvoice_schema_version`, `numbering_rule`, `address_format`, `holiday_source`.
These are **platform-maintained** and protected from ordinary tenant modification
(REGULATORY_SOURCE_REGISTER.md governs provenance).

## 9. Shared-entity ownership (authoritative resolution)

| Entity                                      | Authoritative owner                                                                       | Reuse rule                                             |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Tenant                                      | Tenant & Org                                                                              | Root isolation boundary                                |
| Legal entity                                | Tenant & Org                                                                              | One jurisdiction; owns country contract                |
| User (login)                                | Identity & Access                                                                         | Access per entity, non-transitive                      |
| Person / Employee                           | HR                                                                                        | Employee needs a legal-employer employment for payroll |
| Customer                                    | Shared `party` master + per-entity `customer_role` (Accounting later holds `ar_customer`) | CRM = relationship; ledger = financial truth           |
| Contact                                     | CRM                                                                                       | —                                                      |
| Lead / Opportunity                          | CRM                                                                                       | —                                                      |
| Product/Service/Price                       | Catalog & Pricing                                                                         | Referenced by ID; tax mapping per jurisdiction         |
| Project / Cost centre                       | Projects owns project; Accounting owns cost-centre dimension                              | —                                                      |
| Timesheet / Attendance                      | Time owns timesheet; Attendance owns attendance                                           | Payroll consumes, never mutates                        |
| Quote / Order / Invoice / Credit-Debit note | Sales issues; **Accounting owns the posting**                                             | —                                                      |
| Payment / Allocation                        | Accounting (AR/AP)                                                                        | —                                                      |
| Supplier / Vendor                           | Shared `party` master + per-entity `vendor_role` (Accounting later holds `ap_vendor`)     | Same master as Customer; roles differ per legal entity |
| Purchase order                              | Purchasing                                                                                | —                                                      |
| Expense / Claim                             | Expenses                                                                                  | Posts to GL                                            |
| GL dimensions                               | Accounting                                                                                | Account, cost centre, department, project              |
| Bank account                                | Accounting (one legal entity)                                                             | Not shared across entities                             |
| Attachments                                 | Files                                                                                     | Tenant-scoped keys                                     |
| Comments / Activity                         | Workspace/Activity kernel                                                                 | Polymorphic, tenant-scoped                             |
| Approval requests                           | Workflow                                                                                  | Any module raises; engine owns state                   |
| Notifications                               | Notifications                                                                             | Outbox-driven                                          |
| Audit events                                | Audit                                                                                     | Append-only                                            |

## 10. Key state machines

- **Invoice**: draft → approved → posted → (e-invoice: submitted → cleared/rejected)
  → paid/partly-paid → closed; corrections via credit/debit note only.
- **Journal**: draft → posted (immutable) → reversed-by (new journal).
- **Payroll run**: draft → calculated → reviewed → approved → finalised
  (locked) → posted → paid; recalculation creates a controlled new version.
- **Approval request**: pending → (steps) → approved/rejected/withdrawn; subject
  stays non-effective until approved.
- **E-invoice submission**: prepared → submitted → accepted/cleared → (cancelled/
  rejected/corrected) — states differ per country (see EINVOICING_ARCHITECTURE.md).
