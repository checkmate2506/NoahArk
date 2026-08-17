# NoahArk — Malaysia (MY) Requirements

> Phase 0R.1 (source-remediated). Design-only requirement register.
> **No statutory formulas implemented.** Verification attempted 2026-08-17.
> Only rows marked `VERIFIED` have a retrieved **primary official** source that
> directly supports them (REGULATORY_SOURCE_REGISTER.md §4).
> Note: indirect tax (SST) is administered by **RMCD**, while income tax and
> MyInvois are **LHDN/HASiL** — two authorities, two integrations.

## 1. Business & legal identity

| Requirement | Detail | Authority | Class |
|---|---|---|---|
| Business registration identifiers | Company/business registration number | SSM | RESEARCH REQUIRED |
| Legal & trading name | Registered + trading name | SSM | RESEARCH REQUIRED |
| Tax Identification Number (TIN) | Entity TIN | LHDN | RESEARCH REQUIRED |
| SST registration | Sales-tax and/or service-tax registration | RMCD | RESEARCH REQUIRED |
| Registered & operating addresses | State / federal-territory codes + postcode | SSM | RESEARCH REQUIRED |

## 2. Finance & tax

| Requirement | Detail | Authority | Class |
|---|---|---|---|
| Functional currency | MYR (2 dp) | — | PRELIMINARY (platform default) |
| **SST changes effective 1 Jul 2025** | **VERIFIED from MOF**: Sales Tax **unchanged for essential goods**; **5% or 10%** applies to discretionary/non-essential goods. Service Tax scope **expanded** to **leasing/rental, construction, financial services, private healthcare, education, beauty services**. **No prosecution or penalties until 31 Dec 2025** for businesses taking compliance steps. MOF states detailed thresholds/exemptions follow in subsidiary legislation and RMCD guidelines. | MOF / RMCD | **VERIFIED REQUIREMENT** (as stated) |
| SST framework update date | **VERIFIED from RMCD**: from **1 July 2025** the SST framework is updated to broaden the tax base | RMCD (MySST) | **VERIFIED** (date/intent) |
| **Service tax rates by group** | **NOT recorded** — the specific percentage rates per service group (previously listed from secondary sources) are removed pending RMCD subsidiary legislation/guides | RMCD | **RESEARCH REQUIRED** |
| **SST registration thresholds** | **NOT recorded** — MOF release explicitly defers thresholds to subsidiary legislation | RMCD | **RESEARCH REQUIRED** |
| Tax-inclusive/exclusive pricing | Both supported by platform | — | PRELIMINARY (platform capability) |
| Invoice / credit / debit / refund notes | Statutory content + SST treatment | RMCD/LHDN | RESEARCH REQUIRED |
| **MyInvois e-Invoice** | Official SDK exists and documents APIs for taxpayer ERP integration with MyInvois. **Phase dates, turnover thresholds, any exemption, and any relaxation/transition period are NOT recorded** — all previously listed values were secondary and have been removed; SDK sub-pages returned 404/403. | LHDN/HASiL (IRBM) | **RESEARCH REQUIRED** + SPECIALIST CONFIRMATION REQUIRED |
| MyInvois document types | Invoice / credit note / debit note / refund note set — **not confirmed** | LHDN | RESEARCH REQUIRED |
| MyInvois lifecycle | Validation, TIN validation, **cancellation window**, rejection, correction, consolidated scenarios — **not confirmed** | LHDN | RESEARCH REQUIRED |
| Submission versioning | Retain submitted payload + authority response, versioned | LHDN | PRELIMINARY (platform capability) |
| Accounting period controls & audit trail | Period locks; source→submission linkage | — | COMMON PLATFORM |

## 3. HR & payroll

> **All contribution percentages, wage ceilings and thresholds previously listed
> here were secondary-sourced and have been removed.** None may be implemented.

| Requirement | Detail | Authority | Class |
|---|---|---|---|
| EPF / KWSP | Employer + employee contributions; rates/ceilings **not recorded** | KWSP/EPF | RESEARCH REQUIRED |
| SOCSO / PERKESO | Employment Injury + Invalidity; rates/insured-wage ceiling **not recorded** | PERKESO | RESEARCH REQUIRED |
| EIS | Employment Insurance System; rates **not recorded** | PERKESO | RESEARCH REQUIRED |
| PCB / MTD | Monthly tax deduction withheld & remitted; calculation spec **not recorded** | LHDN | RESEARCH REQUIRED |
| HRD Corp levy | Applicability (sectors, headcount) and rate **not recorded** | HRD Corp | RESEARCH REQUIRED |
| Employee tax & statutory identifiers | TIN, EPF/SOCSO numbers, MyKad/passport | LHDN/KWSP/PERKESO | RESEARCH REQUIRED |
| Payroll cut-off & approval | Remittance deadlines **not recorded** | — | RESEARCH REQUIRED |
| Payslips | Statutory payslip items | MOHR | RESEARCH REQUIRED |
| Leave & attendance | Employment Act entitlements | MOHR | RESEARCH REQUIRED |
| Public holidays | **Federal + state-specific** calendars (structure confirmed as a design requirement; calendars not recorded) | — | RESEARCH REQUIRED |

## 4. Platform defaults (architectural, not statutory)

Currency MYR · Time zone Asia/Kuala_Lumpur · Country code MY · Languages English +
Bahasa Melayu · Malaysian address + state structure.

## 5. Personal data

PDPA as amended. Obligations (DPO, breach notification, portability, cross-border
transfer) and **commencement dates are not recorded** — previously listed phase
dates were secondary. Authority: JPDP. `RESEARCH REQUIRED` +
`SPECIALIST CONFIRMATION REQUIRED`.

## 6. Must be confirmed before Phase 12 (MY finance) / Phase 15 (MY payroll)

See REGULATORY_SOURCE_REGISTER.md §7 (Malaysia): service-tax rates & thresholds;
sales-tax application by goods class; MyInvois phases/document types/lifecycle/API
version; EPF/SOCSO/EIS/PCB/HRD Corp schedules; PDPA & retention.

## 7. Authorities

LHDN/HASiL · MyInvois portal & SDK · RMCD (MySST) · KWSP/EPF · PERKESO/SOCSO ·
EIS · HRD Corp · SSM · JPDP · federal legislation portals.

> **No compliance is claimed.** Specialist (tax/payroll/legal) confirmation is
> required before any MY statutory calculation or submission.
