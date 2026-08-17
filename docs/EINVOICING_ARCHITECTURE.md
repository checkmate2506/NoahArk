# NoahArk — E-Invoicing Architecture

> Phase 0R. Design only. Shared orchestration + **country-owned adapters**.
> One generic connector that hides country behaviour is explicitly rejected.

## 1. Pattern

```
Sales/AR document (per legal entity)
  → E-invoicing orchestrator (shared: lifecycle, retries, storage, audit, idempotency)
     → country adapter (SG InvoiceNow | MY MyInvois | ID Coretax)
        → authority network/API
```

- The **orchestrator** owns the parts that are genuinely common: building a
  submission record, idempotency, retry/backoff, payload storage, correlation,
  status tracking, audit, and operator visibility.
- The **country adapter** owns everything jurisdiction-specific: payload schema &
  version, transport/API, identifier validation, clearance/reporting semantics, and
  the **state model** (which differs per country).

## 2. Country integrations (separate)

| Country | Authority | System | Confirmed from primary source | Class |
|---|---|---|---|---|
| SG | IRAS + IMDA | **InvoiceNow** (Peppol-based) | IMDA operates the nationwide e-invoicing initiative; IRAS publishes an extension of the GST InvoiceNow requirement to all GST-registered businesses **by April 2031** (title-level). **Peppol PINT SG version and intermediate phase dates: not recorded.** | RESEARCH REQUIRED + SPECIALIST |
| MY | LHDN/HASiL (IRBM) | **MyInvois** | An official SDK documents APIs for taxpayer ERP integration. **Phases, thresholds, document types, cancellation window and lifecycle: not recorded** (SDK sub-pages returned 404/403). | RESEARCH REQUIRED + SPECIALIST |
| ID | DJP | **Coretax** (Faktur Pajak) | Coretax is operational at DJP. **Clearance mechanics, schema, NSFP numbering, channels and cut-over dates: not recorded.** | RESEARCH REQUIRED + SPECIALIST |

**No mandate dates, thresholds, schema versions or lifecycle windows are asserted
in this document.** All previously listed values were secondary-sourced and have
been removed (REGULATORY_SOURCE_REGISTER.md §6). Each country adapter is blocked
until its schema and lifecycle are retrieved from the authority's own
specification/SDK and specialist-confirmed.

## 3. Submission record (retained per submission)

Each submission persists: `legal_entity_id`, `country`, `source_document` (invoice/
credit/debit note), `submission_type`, `schema_version`, **exact submitted payload
or tamper-evident representation** (e.g. stored payload + hash), `submitted_at`,
`idempotency_key`, `correlation_id`, `authority_id` (assigned reference),
`status`, `validation_errors`, `authority_response`, `cancellation/rejection_state`,
`correction_relationship` (links replacement ↔ original), `retry_history`, and
linked `audit_event`s.

## 4. Lifecycle (do not assume identical across countries)

A **superset** state model; each adapter maps to its authority's real states:

```
prepared → submitted → (accepted|cleared) → [cancelled | rejected | corrected]
                     ↘ (validation_failed → corrected → resubmitted)
```

- **SG (InvoiceNow/Peppol)**: network delivery plus GST reporting semantics.
- **MY (MyInvois)**: validation/clearance with rejection/correction flows and a
  cancellation window whose **duration is not recorded**.
- **ID (Coretax)**: clearance-oriented model with replacement-document corrections
  and NSFP numbering constraints.

> The three descriptions above are **structural expectations to be confirmed**, not
> verified specifications. Each adapter's real state model must be taken from its
> authority's specification before implementation.

Adapters must not force these into one uniform state machine beyond the shared
storage/audit envelope.

## 5. Reliability & idempotency

- Submissions are enqueued via the **transactional outbox** (committed with the
  document) and dispatched by a job worker.
- **Idempotency-Key** + correlation ID guarantee retries never double-submit.
- Backoff with capped retries; poison handling surfaces to operators.
- Authority responses (accept/clear/reject) update status and, where relevant,
  trigger downstream effects (e.g. allow posting/settlement, or block on rejection).

## 6. Security & audit

- Credentials/keys per legal entity stored in the secrets manager; never in the DB
  in plaintext.
- Access to submit/cancel/correct is an **approval-authorised** action (SoD).
- Every submission, response and state change emits an immutable audit event.
- Payload retention respects each jurisdiction's statutory retention (`RESEARCH`).

## 7. Testing

- Adapter contract tests against **sandbox** endpoints where available (SG/MY/ID).
- Idempotency/retry tests (no duplicate submissions).
- Lifecycle tests per country (accept, reject, cancel-within-window, correct).
- Isolation: submissions and sequences are per legal entity; no cross-entity leakage.
- Golden-payload tests validate schema conformance once versions are confirmed.

## 8. Explicit non-goals

- No single "universal e-invoice" abstraction that erases country semantics.
- No invented schemas or numbering rules; all come from verified authority specs.
