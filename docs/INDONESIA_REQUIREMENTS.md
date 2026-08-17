# NoahArk — Indonesia (ID) Requirements

> Phase 0R.1 (source-remediated). Design-only requirement register.
> **No statutory formulas implemented.** Verification attempted 2026-08-17.
> Only rows marked `VERIFIED` have a retrieved **primary official** source that
> directly supports them (REGULATORY_SOURCE_REGISTER.md §4).
> **Indonesia carries the highest unverified-risk of the three jurisdictions.**

## 1. Business & legal identity

| Requirement | Detail | Authority | Class |
|---|---|---|---|
| Business identifiers | NIB / company registration | OSS / relevant ministry | RESEARCH REQUIRED |
| Legal & trading name | Registered + trading name | — | RESEARCH REQUIRED |
| **NPWP / NIK** | Taxpayer number format and the use of NIK as NPWP for resident individuals — **format, digit length and effective date NOT recorded** (previously listed values were secondary) | DJP | **RESEARCH REQUIRED** |
| NITKU | Branch/sub-location identifier | DJP | RESEARCH REQUIRED |
| PKP status | Taxable-entrepreneur (VAT) status | DJP | RESEARCH REQUIRED |
| Registered & operating addresses | Province → regency/city → district → village hierarchy | — | PRELIMINARY (address structure) |

## 2. Finance & tax

| Requirement | Detail | Authority | Class |
|---|---|---|---|
| Functional currency | IDR; decimal/rounding behaviour **not recorded** | — | RESEARCH REQUIRED + SPECIALIST |
| **PPN (VAT)** | **Rate and the effective-rate (DPP nilai lain) mechanism are NOT recorded.** Previously listed headline and effective percentages were secondary-sourced and have been removed. This is the **highest-risk item**: headline rate and the basis used to compute the taxable amount must both come from DJP/MoF regulation text. | DJP | **RESEARCH REQUIRED** + **SPECIALIST CONFIRMATION REQUIRED** |
| Withholding taxes | PPh 21 / 23 / 26 / 4(2) categories; rates and bukti potong requirements **not recorded** | DJP | RESEARCH REQUIRED |
| **Coretax** | **VERIFIED from DJP**: Coretax is the DJP system in operational use (annual return filing via Coretax; taxpayer account activation). **The e-Faktur transition mechanics, clearance model details and cut-over dates are NOT recorded** — previously listed dates were secondary. | DJP | **VERIFIED** (existence/operational status only); mechanics **RESEARCH REQUIRED** |
| Tax invoice (Faktur Pajak) | Electronic tax invoice requirements, schema, NSFP numbering | DJP | RESEARCH REQUIRED |
| Credit / correction documents | Nota retur / faktur pengganti / cancellation | DJP | RESEARCH REQUIRED |
| Submission versioning | Retain submitted payload + DJP response, versioned | DJP | PRELIMINARY (platform capability) |
| Rejection / correction / cancellation | Per Coretax lifecycle | DJP | RESEARCH REQUIRED |
| Accounting period controls & audit trail | Period locks; source→submission linkage | — | COMMON PLATFORM |

## 3. HR & payroll

> **All contribution percentages, TER details, PTKP thresholds and effective dates
> previously listed here were secondary-sourced and have been removed.**

| Requirement | Detail | Authority | Class |
|---|---|---|---|
| PPh 21 | Employee income-tax withholding. The monthly calculation method (TER / average effective rate), its tables, PTKP thresholds and the year-end recalculation rule are **not recorded** — regulation text required | DJP / MoF | **RESEARCH REQUIRED** + SPECIALIST |
| BPJS Kesehatan | Health insurance; employer/employee shares and wage cap **not recorded** (authority page returned 404) | BPJS Kesehatan | RESEARCH REQUIRED |
| BPJS Ketenagakerjaan | JHT / JP / JKK / JKM; shares **not recorded** (authority page returned 404) | BPJS Ketenagakerjaan | RESEARCH REQUIRED |
| THR | Religious-holiday allowance; calculation and timing **not recorded** | Kemnaker | RESEARCH REQUIRED |
| Employee tax & identity info | NPWP/NIK, PTKP status, BPJS numbers | DJP / BPJS | RESEARCH REQUIRED |
| Payroll cut-off & approval | Configurable; SoD enforced | — | COMMON PLATFORM |
| Payslips | Statutory payslip items | Kemnaker | RESEARCH REQUIRED |
| Leave & attendance | Manpower-law entitlements | Kemnaker | RESEARCH REQUIRED |
| Public & collective holidays | National holidays + **cuti bersama** (structure is a design requirement; calendars not recorded) | Government joint decree | RESEARCH REQUIRED |

## 4. Platform defaults (architectural, not statutory)

Currency IDR · Time zones Asia/Jakarta (WIB), Asia/Makassar (WITA), Asia/Jayapura
(WIT) · Country code ID · Languages English + Bahasa Indonesia · Indonesian address
hierarchy.

## 5. Personal data

Personal Data Protection Law (UU PDP). **Enactment/transition/enforcement dates and
sanction levels are not recorded** — previously listed values were secondary
(law-firm commentary). Obligations incl. **cross-border transfer** require the
legislation text. `RESEARCH REQUIRED` + `SPECIALIST CONFIRMATION REQUIRED`.

## 6. Must be confirmed before Phase 13 (ID finance) / Phase 16 (ID payroll)

See REGULATORY_SOURCE_REGISTER.md §7 (Indonesia). Highest priority: **PPN rate and
effective-rate mechanism**; Coretax schema/NSFP/lifecycle; withholding categories;
PPh 21 method and tables; BPJS rates; THR; NPWP/NIK/NITKU; UU PDP obligations;
IDR rounding; retention.

## 7. Authorities

Direktorat Jenderal Pajak (DJP) · Coretax official documentation · Ministry of
Finance · BPJS Kesehatan · BPJS Ketenagakerjaan · Ministry of Manpower (Kemnaker) ·
official legislation portals.

> **No compliance is claimed.** Specialist (tax/payroll/legal) confirmation is
> required before any ID statutory calculation or submission.
