# NoahArk — Singapore (SG) Requirements

> Phase 0R.1 (source-remediated). Design-only requirement register.
> **No statutory formulas implemented.** Verification attempted 2026-08-17.
> Only rows marked `VERIFIED` have a retrieved **primary official** source that
> directly supports them (see REGULATORY_SOURCE_REGISTER.md §4). Everything else
> is **unverified and must not be implemented**.

## 1. Business & legal identity

| Requirement | Detail | Authority | Class |
|---|---|---|---|
| Business identifier | UEN | ACRA | RESEARCH REQUIRED |
| Legal & trading name | Registered + trading name | ACRA | RESEARCH REQUIRED |
| Registered address | SG address format + postal code | ACRA | RESEARCH REQUIRED |
| GST registration status | Registered / not; voluntary vs compulsory | IRAS | RESEARCH REQUIRED |
| GST registration number | Where registered | IRAS | RESEARCH REQUIRED |

## 2. Finance & tax

| Requirement | Detail | Authority | Class |
|---|---|---|---|
| Functional currency | SGD (2 dp) | — | PRELIMINARY (platform default) |
| **GST rate** | Rate and treatment categories (standard/zero/exempt/out-of-scope). **The specific current rate is NOT recorded here** — the IRAS rates page could not be retrieved, and no secondary figure may be used. | IRAS | **RESEARCH REQUIRED** (primary retrieval pending) |
| Tax-inclusive/exclusive pricing | Both supported by platform | — | PRELIMINARY (platform capability) |
| Tax invoice / credit note / debit note content | Statutory content rules | IRAS | RESEARCH REQUIRED |
| Customer/supplier tax treatment | Per-party GST treatment | IRAS | RESEARCH REQUIRED |
| GST return (F5) | Structure and filing cadence | IRAS | RESEARCH REQUIRED |
| GST audit trail | Retain source→return linkage | IRAS | PRELIMINARY (platform capability) |
| Accounting period controls | Period locks, closing | — | COMMON PLATFORM |
| **InvoiceNow / GST InvoiceNow** | IRAS has published an extension of the GST InvoiceNow requirement **to all GST-registered businesses by April 2031** (IRAS page title; body not retrieved). **Intermediate phase dates are NOT recorded** — previously listed dates came from secondary sources and have been removed. | IRAS + IMDA | **PRELIMINARY / FUTURE-DATED** + SPECIALIST CONFIRMATION REQUIRED |
| InvoiceNow network | IMDA operates the Nationwide E-Invoicing Initiative (InvoiceNow); a Technical Playbook exists. **Peppol PINT SG version not confirmed.** | IMDA | PRELIMINARY |
| Submission versioning | Retain submitted payload + response, versioned | IRAS/IMDA | PRELIMINARY (platform capability) |
| Rejection/cancellation/correction | Per network rules | IRAS/IMDA | RESEARCH REQUIRED |

## 3. HR & payroll

| Requirement | Detail | Authority | Class |
|---|---|---|---|
| **CPF contribution rates** | **VERIFIED from CPF Board**, effective **1 Jan 2026**, monthly wages > $750: ≤55 → **17% employer / 20% employee (37%)**; >55–60 → **16% / 18% (34%)**; >60–65 → **12.5% / 12.5% (25%)**; >65–70 → **9% / 7.5% (16.5%)**; >70 → **7.5% / 5% (12.5%)**. New rates apply from the first day of the month after the 55th/60th/65th/70th birthday. | CPF Board | **VERIFIED REQUIREMENT** (rates) + SPECIALIST CONFIRMATION REQUIRED (application) |
| CPF future change | CPF Board states a further rate increase **from 1 Jan 2027** | CPF Board | **VERIFIED / FUTURE-DATED** |
| CPF wage ceilings | Ordinary Wage / Additional Wage ceilings — **values NOT recorded** (CPF rate-table PDF not parsed; previously listed figures were secondary and removed) | CPF Board | **RESEARCH REQUIRED** |
| Skills Development Levy (SDL) | Monthly levy on wages; rate/cap not recorded | SSG | RESEARCH REQUIRED |
| Foreign Worker Levy (FWL) | Where applicable (Work Permit / S Pass); rates not recorded | MOM | RESEARCH REQUIRED |
| Self-Help Group (SHG) contributions | CDAC/ECF/MBMF/SINDA; schedules not recorded | Respective SHGs | RESEARCH REQUIRED |
| Employment-income reporting | IR8A / Auto-Inclusion Scheme (AIS); field spec not recorded | IRAS | RESEARCH REQUIRED |
| Employee classifications | Citizen / PR / foreigner; residency drives CPF & tax treatment | CPF Board / IRAS / MOM | RESEARCH REQUIRED |
| Payroll cut-off & approval | Configurable; SoD enforced | — | COMMON PLATFORM |
| Payslips | Itemised payslip statutory items | MOM | RESEARCH REQUIRED |
| Leave & attendance | Statutory leave entitlements | MOM | RESEARCH REQUIRED |
| Public holidays | Gazetted holidays (per year) | MOM | RESEARCH REQUIRED |

## 4. Platform defaults (architectural, not statutory)

Currency SGD · Time zone Asia/Singapore · Country code SG · Primary language English
· SG address format.

## 5. Personal data

PDPA, administered by PDPC. Obligations (consent, access/correction, breach
notification, **cross-border transfer**) and statutory retention periods are
**not recorded here** — primary sources not retrieved.
`RESEARCH REQUIRED` + `SPECIALIST CONFIRMATION REQUIRED`.

## 6. Must be confirmed before Phase 11 (SG finance) / Phase 14 (SG payroll)

See REGULATORY_SOURCE_REGISTER.md §7 (Singapore). In summary: GST rate &
treatments; GST InvoiceNow phased dates; PINT SG specification version; CPF wage
ceilings; SDL/FWL/SHG schedules; IR8A/AIS spec; PDPA & retention.

## 7. Authorities

IRAS · CPF Board · MOM · IMDA · SkillsFuture Singapore · ACRA · PDPC ·
Singapore Statutes Online.

> **No compliance is claimed.** Specialist (tax/payroll/legal) confirmation is
> required before NoahArk performs any SG statutory calculation or submission.
