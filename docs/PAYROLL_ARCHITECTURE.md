# NoahArk — Payroll Architecture

> Phase 0R. Design only. Per legal employer. Country payroll behind adapters.
> **No statutory formulas implemented.**

## 1. Domain separation (explicit)

These are **distinct** domains and must not be collapsed into one generic "time"
table:

| Concept | Owner | Notes |
|---|---|---|
| User account | Identity | Login identity |
| Person | HR | One per human; tenant-level |
| Employee / Employment | HR | **Employment** binds a person to **one legal employer** (effective-dated) |
| Legal employer | HR → legal entity | The employing legal entity (jurisdiction) |
| Work location / Department / Position / Reporting line | HR | Org structure |
| Payroll profile / Tax profile / Statutory-contribution profile | Payroll | Per employment, per jurisdiction |
| Bank-payment instruction | Payroll (sensitive) | Field-protected |
| Attendance / Shift | Time & Attendance | Presence, not project time |
| Timesheet / Time entry | Time | **Project** time; feeds costing/billing, not directly payroll unless configured |
| Leave request | Time & Attendance | Affects payroll inputs |
| Payroll input | Payroll | Aggregated inputs for a run |
| Payroll calculation | Payroll | Snapshotted, reproducible |
| Payroll run | Payroll | Per legal employer + period |
| Payslip | Payroll | Per employee per run |
| Payroll posting | Accounting | GL effect of a run |
| Statutory submission | Country adapter | CPF/EPF/BPJS/PCB/PPh, etc. |

## 2. Employment rules

- An employee **cannot be payroll-processed without an employment** tied to a legal
  employer (which fixes jurisdiction & currency).
- A person may have **multiple employments over time** (and, if a business rule
  allows, across entities) — each with its own legal employer, dates, classification,
  work location, payroll currency, payroll frequency, statutory profile, and
  **effective-dated** compensation and contribution attributes.

## 3. Reproducible, auditable calculation

Every payroll calculation must:

- **Snapshot its inputs** (earnings, attendance/leave, elections, employee statutory
  attributes) at calculation time.
- **Pin the statutory rule-set version** used (jurisdiction × domain × effective
  date) — so a run is reproducible exactly as computed, even after rules change.
- Support **review and approval** (SoD: preparer ≠ approver) before finalisation.
- Support **controlled recalculation** producing a new version, never silent
  mutation of a finalised run.
- **Prevent duplicates** via idempotency keys:
  - no duplicate finalisation of a run,
  - no duplicate GL posting,
  - no duplicate bank-payment generation.
- Enforce **field-level access** to compensation, statutory IDs and bank
  instructions, and emit **immutable audit events** for sensitive reads/mutations.

## 4. Country payroll adapters (SG / MY / ID)

Each jurisdiction's contributions/withholding are computed by its adapter from
**versioned, effective-dated, source-referenced** rule sets — never invented,
never hard-coded (REGULATORY_SOURCE_REGISTER.md).

**Scheme names in scope** (rates, tables, ceilings, thresholds and calculation
methods are deliberately **not stated here** — see the country requirement
documents for verification status):

- **SG**: CPF; Skills Development Levy; Foreign Worker Levy (where applicable);
  Self-Help Group contributions; annual employment-income reporting (IR8A/AIS).
- **MY**: EPF/KWSP; SOCSO/PERKESO; EIS; PCB/MTD withholding; HRD Corp levy
  (where applicable).
- **ID**: PPh 21 withholding; BPJS Kesehatan; BPJS Ketenagakerjaan; THR.

**Verification status.** Of the above, only **SG CPF contribution rates** have been
confirmed from a primary official source (CPF Board — see
REGULATORY_SOURCE_REGISTER.md §4 P1/P2). **Every other scheme's rates and method
are `RESEARCH REQUIRED`.** No adapter may be implemented for a scheme until its
rules are primary-sourced and specialist-confirmed.

The adapter interface returns statutory line items (employer + employee shares,
employer-only levies, withholding) that the payroll engine assembles into payslips
and posting instructions. **Statutory formulas are not part of this phase.**

## 5. Payroll → accounting

- A finalised run produces a **posting request** to Accounting (idempotent): salary
  expense, employer-contribution expense, statutory payable liabilities, net-pay
  payable — all within the legal employer's ledger and open period.
- Statutory payments and bank disbursement produce their own postings on settlement.

## 6. Statutory submissions

Contribution/withholding submissions (CPF, EPF, SOCSO, EIS, PCB, BPJS, PPh 21, IR8A)
are produced by the country adapter, retain the versioned rule set and source run,
carry idempotency + correlation IDs, and record authority responses — mirroring the
submission lifecycle in EINVOICING_ARCHITECTURE.md (states differ per authority).

## 7. Sensitive-data controls

- Compensation, statutory IDs and bank instructions are in separate protected
  tables with dedicated field permissions; masked by default; every access audited.
- Cross-legal-entity access to payroll/HR data requires explicit grant; cross-border
  personal-data handling is assessed against SG/MY/ID data-protection law
  (`SPECIALIST CONFIRMATION REQUIRED`).

## 8. Testing (payroll-specific gates)

- Reproducibility: same inputs + pinned rule version ⇒ identical result.
- Idempotency: no duplicate finalisation / posting / bank file.
- Isolation: payroll data scoped per legal entity; field-level masking enforced.
- Rule-version selection: a run uses the rule set effective on the run's date;
  retrospective recalculation uses the correct historical version.
- (Statutory value correctness is validated later against official examples once
  rules are verified — not in Phase 0R.)
