# NoahArk — Country Compatibility Matrix (SG / MY / ID)

> Phase 0R.1 (source-remediated). Design only. Verification attempted 2026-08-17.
> **Statutory rates, thresholds and mandate dates that lacked a retrieved primary
> official source have been removed from this matrix.** Only items citing
> REGULATORY_SOURCE_REGISTER.md §4 are `VERIFIED`.
> Row classification: `COMMON` · `SG` · `MY` · `ID` · `RESEARCH` (research
> required) · `SPECIALIST` (specialist confirmation required) · `OUT` (out of scope).

## 1. Structural / platform dimensions (architectural — safe to design against)

| Dimension | Singapore | Malaysia | Indonesia | Class |
|---|---|---|---|---|
| Country code | SG | MY | ID | COMMON |
| Functional currency (one per legal entity) | SGD | MYR | IDR | COMMON |
| Currency precision / rounding | 2 dp | 2 dp | IDR precision & rounding **not recorded** | COMMON / ID + RESEARCH |
| Time zone(s) | Asia/Singapore | Asia/Kuala_Lumpur | Asia/Jakarta, Asia/Makassar, Asia/Jayapura | COMMON |
| Languages | English | English, Bahasa Melayu | English, Bahasa Indonesia | COMMON (scoped) |
| Address hierarchy | SG format + postal code | State / federal territory + postcode | Province → regency/city → district → village | SG/MY/ID |
| Fiscal year | Configurable per legal entity | Configurable per legal entity | Configurable per legal entity | COMMON |
| Ledger / periods / period locks | Per legal entity | Per legal entity | Per legal entity | COMMON |
| Document numbering | Per legal entity sequences | Per legal entity sequences | Per legal entity sequences | COMMON |
| Public-holiday **structure** | National | **Federal + state-specific** | National + **collective leave (cuti bersama)** | SG/MY/ID |
| Proposed implementation phase | P11 finance, P14 payroll | P12 finance, P15 payroll | P13 finance, P16 payroll | COMMON |

## 2. Statutory dimensions (verification status — **not** implementation-ready)

| Dimension | Singapore | Malaysia | Indonesia | Class |
|---|---|---|---|---|
| Legal-entity types (initial scope) | not recorded | not recorded | not recorded | RESEARCH |
| Business identifier | UEN (ACRA) | Registration no. (SSM) | NIB / company reg. | RESEARCH |
| Taxpayer identifier | GST reg. no. | TIN (LHDN); SST reg. (RMCD) | NPWP / NIK / NITKU — **format & dates not recorded** | RESEARCH |
| **Indirect tax** | GST — **rate not recorded** (IRAS page not retrieved) | **VERIFIED (MOF)**: from 1 Jul 2025 sales tax unchanged for essential goods, **5% or 10%** on discretionary/non-essential; service tax scope expanded (leasing/rental, construction, financial services, private healthcare, education, beauty). **Service-tax rates & thresholds not recorded.** | PPN — **rate and effective-rate (DPP) mechanism not recorded** | SG RESEARCH / MY partly VERIFIED / ID RESEARCH + SPECIALIST |
| Indirect-tax transition relief | — | **VERIFIED (MOF)**: no prosecution/penalties until 31 Dec 2025 for complying businesses | — | MY VERIFIED |
| Withholding tax | Limited cases — not recorded | WHT categories — not recorded | PPh 21/23/26/4(2) — not recorded | RESEARCH |
| Statutory invoice / credit note / debit note | Content rules not recorded | Content rules not recorded | Faktur Pajak requirements not recorded | RESEARCH |
| **E-invoicing authority** | IRAS + IMDA | LHDN/HASiL (IRBM) | DJP | COMMON (authority identity) |
| **E-invoicing system** | InvoiceNow (Peppol); **PINT SG version not confirmed** | MyInvois (**official SDK exists**) | Coretax (**VERIFIED operational**) | SG/MY/ID |
| **E-invoicing timeline** | IRAS publishes extension to all GST-registered businesses **by April 2031** (title-level); **intermediate phases not recorded** | **Phases, thresholds, exemptions and relaxation periods not recorded** (SDK sub-pages 404/403) | **Transition mechanics & cut-over dates not recorded** | RESEARCH + SPECIALIST |
| E-invoicing lifecycle (cancel/reject/correct) | not recorded | not recorded | not recorded | RESEARCH |
| **Employer contributions** | **CPF VERIFIED** (see §3); SDL, FWL not recorded | EPF, SOCSO, EIS, HRD Corp — **not recorded** | BPJS Kesehatan, BPJS Ketenagakerjaan — **not recorded** | SG partly VERIFIED / MY, ID RESEARCH |
| **Employee contributions** | **CPF VERIFIED** (see §3); SHG not recorded | EPF, SOCSO, EIS — not recorded | BPJS, PPh 21 — not recorded | as above |
| Payroll withholding | No monthly income-tax withholding; annual IR8A/AIS — **spec not recorded** | PCB/MTD — spec not recorded | PPh 21 method & tables — not recorded | RESEARCH |
| Payslip requirements | not recorded | not recorded | not recorded | RESEARCH |
| Public-holiday calendars (actual dates) | not recorded | not recorded | not recorded | RESEARCH |
| Personal-data law | PDPA (PDPC) — obligations not recorded | PDPA as amended (JPDP) — dates not recorded | UU PDP — dates/sanctions not recorded | RESEARCH + SPECIALIST |
| Cross-border transfer rules | not recorded | not recorded | not recorded | RESEARCH + SPECIALIST |
| Record retention | not recorded | not recorded | not recorded | RESEARCH |

## 3. The only VERIFIED statutory values in this matrix

| Country | Item | Value | Primary source |
|---|---|---|---|
| SG | CPF contribution rates, effective **1 Jan 2026**, wages > $750 | ≤55: 17%/20% (37%) · >55–60: 16%/18% (34%) · >60–65: 12.5%/12.5% (25%) · >65–70: 9%/7.5% (16.5%) · >70: 7.5%/5% (12.5%); new rates apply from the first day of the month after the relevant birthday | CPF Board |
| SG | CPF further increase | **from 1 Jan 2027** | CPF Board |
| MY | SST from 1 Jul 2025 | sales tax unchanged for essentials; 5% or 10% on discretionary/non-essential; service tax scope expanded; penalty relief to 31 Dec 2025 | MOF / RMCD |
| ID | Coretax | operational DJP system | DJP |

All other statutory values are **unverified** and must not be implemented.

## 4. Common vs country-specific split (unchanged architectural conclusion)

- **COMMON PLATFORM**: tenancy, legal-entity framework, RBAC, audit, approvals,
  CRM, projects, catalog, sales-document workflow shell, double-entry ledger
  engine, AR/AP mechanics, files, notifications, reporting engine, import/export,
  API/webhooks, billing.
- **COUNTRY-SPECIFIC** (adapters `country-sg|my|id`): tax determination, statutory
  invoice/e-invoice format & submission, document numbering rules, payroll
  statutory contributions & withholding, public-holiday calendars, address format,
  statutory reports, retention policy, identifier validation.

## 5. Explicit OUT OF SCOPE

Any jurisdiction other than SG/MY/ID; currencies beyond SGD/MYR/IDR as baseline;
languages beyond EN/MS/ID; generic worldwide statutory configuration.
