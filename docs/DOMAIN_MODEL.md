# NoahArk — Domain Model

> Phase 0R. Design only. Indicative schema; not final DDL. No migrations created.

## 1. Conventions

- Every tenant-owned table has `tenant_id`. Every country-sensitive / financial /
  HR row also has `legal_entity_id`.
- Audit columns: `created_at`, `created_by`, `updated_at`, `updated_by`.
- Money stored as integer **minor units** + `currency` (ISO-4217). IDR handled as a
  zero-decimal currency (see COUNTRY_COMPATIBILITY_MATRIX.md; verify rounding).
- Postable documents carry a `status` state machine and, once posted, are immutable.
- Soft-delete only where legally allowed; posted financial/statutory records are
  never destructively deleted.
- No foreign keys **across bounded contexts**; cross-context references are IDs.

## 2. Shared kernel & identity

| Table | Purpose | Key scope |
|---|---|---|
| `tenant` | Subscribing customer / group | root |
| `legal_entity` | Jurisdiction-bound company | `tenant_id`; `jurisdiction`, `functional_currency`, `time_zone`, `default_language` |
| `business_unit`,`department`,`team`,`branch`,`warehouse`,`cost_centre` | Org structure | `legal_entity_id` |
| `user` | Login identity (one per person) | global identity, joined per tenant |
| `membership` | user × tenant | `tenant_id` |
| `legal_entity_access` | user × legal entity (non-transitive) | `tenant_id`,`legal_entity_id` |
| `role`,`permission`,`role_permission`,`user_role` | RBAC | `tenant_id` (roles), platform (permission catalog) |
| `field_policy` | field-level access rules (HR/payroll) | `tenant_id` |
| `tenant_setting`,`legal_entity_setting` | configuration | scoped |
| `custom_field_def`,`custom_field_value` | tenant/entity custom fields | scoped |
| `attachment` | file metadata (S3 key) | `tenant_id` (+ owner ref) |
| `comment`,`activity` | polymorphic timeline | `tenant_id` (+ owner ref) |
| `audit_event` | append-only, hash-chained | `tenant_id` |
| `approval_request`,`approval_step` | workflow | scoped |
| `notification`,`notification_outbox` | notifications | scoped |
| `event_outbox` | domain events | `tenant_id` |
| `idempotency_key` | idempotent ops | scoped |
| `webhook_endpoint`,`webhook_delivery` | integrations | `tenant_id` |
| `import_batch`,`import_row` | staged imports | scoped |
| `plan`,`entitlement`,`subscription`,`usage_meter` | SaaS billing | `tenant_id` |

## 3. CRM & Catalog

`account` (customer), `contact`, `lead`, `opportunity`, `activity`;
`product`, `service`, `price_list`, `price_list_item`, `product_tax_mapping`
(product × jurisdiction × tax code). Shared master; per-entity binding via
assignment bridges.

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

| Entity | Authoritative owner | Reuse rule |
|---|---|---|
| Tenant | Tenant & Org | Root isolation boundary |
| Legal entity | Tenant & Org | One jurisdiction; owns country contract |
| User (login) | Identity & Access | Access per entity, non-transitive |
| Person / Employee | HR | Employee needs a legal-employer employment for payroll |
| Customer/Account | CRM (Accounting holds `ar_customer`) | CRM = relationship; ledger = financial truth |
| Contact | CRM | — |
| Lead / Opportunity | CRM | — |
| Product/Service/Price | Catalog & Pricing | Referenced by ID; tax mapping per jurisdiction |
| Project / Cost centre | Projects owns project; Accounting owns cost-centre dimension | — |
| Timesheet / Attendance | Time owns timesheet; Attendance owns attendance | Payroll consumes, never mutates |
| Quote / Order / Invoice / Credit-Debit note | Sales issues; **Accounting owns the posting** | — |
| Payment / Allocation | Accounting (AR/AP) | — |
| Supplier / Vendor | Purchasing (Accounting holds `ap_vendor`) | — |
| Purchase order | Purchasing | — |
| Expense / Claim | Expenses | Posts to GL |
| GL dimensions | Accounting | Account, cost centre, department, project |
| Bank account | Accounting (one legal entity) | Not shared across entities |
| Attachments | Files | Tenant-scoped keys |
| Comments / Activity | Workspace/Activity kernel | Polymorphic, tenant-scoped |
| Approval requests | Workflow | Any module raises; engine owns state |
| Notifications | Notifications | Outbox-driven |
| Audit events | Audit | Append-only |

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
