# NoahArk — Accounting Architecture

> Phase 0R. Design only. Double-entry, per legal entity, three jurisdictions.

## 1. Principles

- **Ledger is per legal entity.** Each legal entity has its own chart of accounts
  instance, journals, periods, sequences and reconciliations. Entities never share
  journals (see LEGAL_ENTITY_ARCHITECTURE.md §3).
- **Double-entry, always balanced.** Every journal's debits equal its credits.
- **Immutable after posting.** Posted journals are never edited or deleted;
  corrections are controlled reversals or adjusting entries.
- **Country tax must not alter debit/credit invariants.** Tax is represented as tax
  lines/accounts; it never breaks balancing.

## 2. Core entities

`gl_account` · `fiscal_year` · `accounting_period` · `period_lock` · `journal`
(header) · `journal_line` (debit **or** credit, with account + dimensions + optional
tax link) · `tax_code` · `tax_line` · `ar_customer` / `ap_vendor` control links ·
`payment` · `payment_allocation` · `bank_account` · `bank_statement` /
`bank_reconciliation` · `dimension` (cost centre / department / project) ·
`intercompany_link` · `consolidation_mapping` · `fx_rate`.

Each journal records: `legal_entity_id`, `posting_date`, `document_date`, and
`tax_date` where the jurisdiction requires it; `functional_currency` (entity) and,
per line, `transaction_currency` + `exchange_rate` when different.

## 3. Mandatory controls (invariants)

| Control | Mechanism |
|---|---|
| Every posting balances | Deferred constraint / trigger: Σ debits = Σ credits per journal |
| Posted journals immutable | No UPDATE/DELETE for app role on posted rows; state machine draft→posted→reversed |
| Corrections via reversal | Reversal creates a new linked journal; original preserved |
| Posting is idempotent | `idempotency_key` per posting request; retries never double-post |
| Multi-record posting transactional | All lines + subledger + tax commit in one DB tx |
| Period locks enforced server-side | Cannot post into a locked/closed period; lock respects entity's fiscal calendar |
| Cross-entity effects explicit | Only via `intercompany_link`; no implicit cross-entity journals |
| Statutory linkage retained | Postings link to source document and any statutory submission |
| Source-document linkage | Every posting references its originating document (invoice, bill, payroll, expense, payment) |

## 4. Subledgers (AR / AP)

- Sales invoices/credit notes post to AR control + revenue + tax; vendor
  bills/expenses post to AP control + expense/asset + tax (+ withholding where the
  jurisdiction requires — ID PPh, MY WHT).
- `payment` + `payment_allocation` settle open items; over/under/partial allocations
  supported; unallocated cash tracked. Subledgers reconcile to their control
  accounts.

## 5. Currency & FX

- **One functional currency per legal entity** (SGD / MYR / IDR).
- Transactions may be in SGD / MYR / IDR; foreign-currency lines carry an exchange
  rate with an **effective date** from a configured **rate source**.
- **Rates lock on posting** — a posted transaction's rate is immutable.
- **Realised FX** gain/loss on settlement; **unrealised FX** revaluation of open
  monetary balances at period end (reversing).
- Manual rate entry is permission-gated and audited.
- Rounding is currency-appropriate (IDR zero-decimal handling — confirm rules;
  `SPECIALIST`). No unrestricted global currency catalogue.

## 6. Tax representation

- Tax is computed by the **country adapter** (`country-sg|my|id`) from the legal
  entity's registrations, the product/service tax mapping, the party's tax
  treatment and the transaction date's effective rule set.
- Tax appears as `tax_line`s posting to jurisdiction tax accounts (GST output/input,
  SST, PPN, WHT). Tax computation is **versioned & effective-dated**, never
  hard-coded (see REGULATORY_SOURCE_REGISTER.md).
- **No tax rate is stated in this document.** Rates, bases and thresholds for all
  three jurisdictions are held in the country rule sets and are currently
  `RESEARCH REQUIRED` (Indonesia's PPN rate **and** its effective-rate/DPP basis
  are the highest-risk items). The ledger engine must be implementable and testable
  with **synthetic** tax rates so that Phase 4 does not depend on statutory
  verification.

## 7. Dimensions & analysis

Journal lines carry optional dimensions: cost centre, department, project. These
feed management reporting and per-project/entity P&L without breaking the ledger.

## 8. Intercompany & consolidation

- **Intercompany**: a transaction affecting two legal entities creates matched
  entries in each entity's ledger via `intercompany_link`, with reciprocal
  intercompany accounts. No single journal spans two entities.
- **Consolidation**: group reporting in a **tenant-selected group reporting
  currency** — one of SGD, MYR or IDR, **defaulting to SGD** (decision AD-7).
  Changing it after consolidated reporting has begun requires a controlled
  migration plus an audit record. Consolidation comprises:
  - `consolidation_mapping` (entity accounts → group accounts),
  - translation of each entity's functional-currency balances to group currency
    (with translation adjustment / CTA),
  - **elimination** of intercompany balances and transactions.
- Consolidation is a **reporting** function (read models); it never posts to a
  legal entity's statutory ledger.

## 9. Fixed assets — deferred (AD-8)

The complete fixed-asset register and depreciation engine is **deferred until the
core accounting, AR and AP modules are stable**, and is **not in Phase 1**.
Architecture extension points are preserved: asset-related postings use the same
journal/dimension model, so the module can be added without altering the ledger.
Jurisdiction tax-depreciation rules remain `RESEARCH REQUIRED` and stay separate
from book depreciation.

## 10. Testing (accounting-specific gates)

- Property tests: journals always balance; postings idempotent (retry = no double
  effect); reversal restores balances.
- Period-lock tests (cannot post into locked period).
- Legal-entity isolation tests (no cross-entity journal/sequence/lock leakage).
- FX tests: rate lock on posting; realised/unrealised computation.
- Intercompany + consolidation elimination tests.
