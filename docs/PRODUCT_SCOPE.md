# NoahArk — Product Scope

> Phase 0R. Design only. Scope is **Singapore, Malaysia, Indonesia** only.

## 1. Supported jurisdictions

- **SG** — Singapore
- **MY** — Malaysia
- **ID** — Indonesia

Each **legal entity** has exactly one jurisdiction. A tenant may hold legal
entities from any combination of the three.

## 2. Explicit out-of-scope

- Any country other than SG/MY/ID (no worldwide/generic-country support).
- Arbitrary currencies beyond SGD/MYR/IDR (a limited extra *transaction* currency,
  if ever needed, is a future controlled extension — not baseline).
- Languages beyond English, Bahasa Melayu, Bahasa Indonesia.
- User-editable statutory formulas for arbitrary jurisdictions.
- POS hardware, storefront/e-commerce, manufacturing/MRP, and any module not in §4.

## 3. Definition of "done" (applies to every module)

A capability is complete only when it has **all** of:

1. Tenant- and legal-entity-scoped schema with DB constraints for invariants.
2. Server-side service enforcing RBAC, record scope and (where relevant)
   field-level permissions.
3. Transactional, idempotent writes for multi-record / financial / statutory ops.
4. Immutable audit events for sensitive mutations.
5. Automated tests including **tenant-isolation** and **legal-entity-isolation**.
6. Where country-sensitive: a versioned, source-referenced rule set (no invented
   formulas) and an explicit research/verification status.

Screens + CRUD APIs alone are **not** "done".

## 4. Functional module map

| # | Module | Bounded context (owner) | Country-sensitive? |
|---|---|---|---|
| 1 | CRM & sales | CRM | No (docs language only) |
| 2 | Customers & contacts | CRM | No |
| 3 | Leads & opportunities | CRM | No |
| 4 | Products, services & price lists | Catalog & Pricing | Partial (tax code mapping) |
| 5 | Quotations & sales orders | Sales | Partial (tax, numbering) |
| 6 | Projects, tasks, Kanban, Gantt | Projects | No |
| 7 | Time tracking & timesheets | Time | No |
| 8 | HR & employee administration | HR | Yes (statutory IDs) |
| 9 | Organisation structures | HR / Tenant-Org | No |
| 10 | Attendance, shifts & leave | Time & Attendance | Yes (holiday calendars) |
| 11 | Payroll | Payroll | **Yes (per legal employer)** |
| 12 | Expenses & employee claims | Expenses | Partial (tax) |
| 13 | Vendors & purchasing | Purchasing | Partial (tax, WHT) |
| 14 | Invoicing & collections | Sales + Accounting | **Yes (statutory invoice/e-invoice)** |
| 15 | Credit/debit notes & refunds | Sales + Accounting | **Yes** |
| 16 | Double-entry accounting | Accounting/Ledger | **Yes (per legal entity)** |
| 17 | Cash & bank management | Accounting | Yes (per entity reconciliation) |
| 18 | Fixed assets (where approved) | Accounting | Partial |
| 19 | Tax & statutory reporting | Accounting + Country adapters | **Yes** |
| 20 | Team workspace & announcements | Workspace | No |
| 21 | Support tickets | Workspace | No |
| 22 | Documents & asset assignments | Files + Workspace | No |
| 23 | Dashboards & reporting | Reporting | Partial (consolidation) |
| 24 | REST APIs & webhooks | Integration | No |
| 25 | Data import & export | Integration | No |
| 26 | SaaS subscription & tenant admin | Billing + Tenant-Org | No |
| 27 | RBAC, approvals & audit | Access + Workflow + Audit (cross-cutting) | No |

## 5. Cross-cutting capabilities (every module inherits)

RBAC + field-level permissions · approval workflows · immutable audit · attachments
· comments/activity · notifications · custom fields · import/export · webhooks.

## 6. Country-sensitivity summary

Country rules attach at the **legal entity**, not the tenant. The country-sensitive
surfaces are: tax determination, statutory invoice/e-invoice format & submission,
document numbering, functional currency, fiscal calendar & period locks, payroll
statutory contributions & withholding, public-holiday calendars, address format,
statutory reporting and retention. See COUNTRY_COMPATIBILITY_MATRIX.md.

## 7. Phasing pointer

Delivery sequence and per-phase gates are in IMPLEMENTATION_ROADMAP.md. Country
finance/payroll capabilities are introduced deliberately, country by country,
after the shared foundation and accounting core exist.
