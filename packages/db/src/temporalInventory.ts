/**
 * Phase 1H.2: the authoritative, documented inventory of every temporal
 * column this schema owns (`packages/db/prisma/schema.prisma`'s `DateTime`
 * fields), each classified per the Phase 1H.2 brief's taxonomy:
 *
 *   1. ABSOLUTE_INSTANT   — a specific point in universal time (an event
 *      that happened, or a deadline that will happen, independent of any
 *      civil calendar/timezone). Stored as PostgreSQL `timestamptz`.
 *   2. LOCAL_CIVIL_DATE   — a calendar date with no time-of-day component,
 *      meaningful in a specific jurisdiction's civil calendar (e.g. a
 *      statutory filing date). Stored as PostgreSQL `date`.
 *   3. LOCAL_CIVIL_TIME   — a wall-clock time of day with no date, tied to
 *      a specific IANA timezone (e.g. a shop's opening time). Stored as
 *      PostgreSQL `time` plus an explicit timezone reference.
 *   4. REPORTING_PERIOD   — a country/legal-entity statutory period (e.g.
 *      a payroll month, a tax period).
 *   5. DURATION            — an elapsed span, not a point (e.g. a lease
 *      length). Stored as PostgreSQL `interval` or a plain numeric
 *      millisecond/second count.
 *
 * Phase 1 has no accounting/payroll/statutory business models yet (see
 * CLAUDE.md's phase gating and schema.prisma's own header comment — only
 * tenancy, identity, RBAC, audit, approvals, jobs/outbox, files, and
 * settings are modelled). Every temporal field in the CURRENT schema is,
 * without exception, an absolute instant: an audit/created/updated
 * timestamp, an expiry, a lease boundary, a scheduling instant, or a
 * revocation/deletion mark — never a jurisdiction-specific calendar date
 * or wall-clock time. This inventory therefore lists ABSOLUTE_INSTANT for
 * every entry; it is expected to gain LOCAL_CIVIL_DATE/LOCAL_CIVIL_TIME/
 * REPORTING_PERIOD entries only when a future phase introduces genuinely
 * local-date-shaped fields (e.g. a payroll pay-period date, a statutory
 * filing due date) — see this file's own doc comment at that point for
 * why a given new field is NOT an absolute instant, matching the Phase
 * 1H.2 brief's instruction not to convert genuine local dates/times into
 * instants without a documented reason.
 *
 * `apps/web/tests/integration/temporalSchemaConformance.test.ts` compares
 * this list directly against a fresh disposable database's
 * `information_schema.columns` — a schema change that silently reverts an
 * absolute-instant column back to naive `timestamp without time zone`
 * (Prisma's default when `@db.Timestamptz` is omitted) fails that test,
 * not just a manual review.
 */

export type TemporalClassification =
  | "ABSOLUTE_INSTANT"
  | "LOCAL_CIVIL_DATE"
  | "LOCAL_CIVIL_TIME"
  | "REPORTING_PERIOD"
  | "DURATION";

export interface TemporalColumn {
  table: string;
  column: string;
  classification: TemporalClassification;
  /** The PostgreSQL `data_type` this column must report in
   * `information_schema.columns` for its classification. */
  expectedPgType: string;
}

const ABSOLUTE_INSTANT_COLUMNS: ReadonlyArray<[table: string, column: string]> = [
  ["app_user", "created_at"],
  ["app_user", "email_verified"],
  ["app_user", "updated_at"],
  ["approval_decision", "decided_at"],
  ["approval_policy", "created_at"],
  ["approval_policy", "updated_at"],
  ["approval_request", "created_at"],
  ["approval_request", "decided_at"],
  ["approval_request", "submitted_at"],
  ["approval_request", "updated_at"],
  ["attachment", "created_at"],
  ["audit_event", "created_at"],
  ["auth_rate_limit_bucket", "updated_at"],
  ["auth_rate_limit_bucket", "window_start"],
  ["background_job", "created_at"],
  ["background_job", "heartbeat_at"],
  ["background_job", "lease_expires_at"],
  ["background_job", "locked_at"],
  ["background_job", "run_at"],
  ["background_job", "updated_at"],
  ["branch", "created_at"],
  ["business_unit", "created_at"],
  ["cost_centre", "created_at"],
  ["custom_field_definition", "created_at"],
  ["custom_field_definition", "updated_at"],
  ["custom_field_value", "updated_at"],
  ["demo_approval_subject", "created_at"],
  ["department", "created_at"],
  ["file_object", "created_at"],
  ["file_object", "deleted_at"],
  ["file_object", "revoked_at"],
  ["file_object", "storage_purged_at"],
  ["idempotency_key", "created_at"],
  ["legal_entity", "created_at"],
  ["legal_entity", "updated_at"],
  ["legal_entity_membership", "created_at"],
  ["legal_entity_membership", "updated_at"],
  ["legal_entity_setting", "updated_at"],
  ["membership_invitation", "accepted_at"],
  ["membership_invitation", "created_at"],
  ["membership_invitation", "expires_at"],
  ["membership_invitation", "revoked_at"],
  ["membership_role", "created_at"],
  ["mfa_credential", "confirmed_at"],
  ["mfa_credential", "created_at"],
  ["mfa_credential", "updated_at"],
  ["mfa_recovery_code", "created_at"],
  ["mfa_recovery_code", "used_at"],
  ["notification", "created_at"],
  ["notification", "read_at"],
  ["outbox_event", "created_at"],
  ["outbox_event", "heartbeat_at"],
  ["outbox_event", "lease_expires_at"],
  ["outbox_event", "locked_at"],
  ["outbox_event", "processed_at"],
  ["role", "created_at"],
  ["role", "updated_at"],
  ["session", "expires"],
  ["team", "created_at"],
  ["tenant", "created_at"],
  ["tenant", "updated_at"],
  ["tenant_entitlement", "updated_at"],
  ["tenant_membership", "created_at"],
  ["tenant_membership", "updated_at"],
  ["tenant_setting", "updated_at"],
  ["test_email_capture", "created_at"],
  ["user_credential", "updated_at"],
  ["verification_token", "expires"],
  ["warehouse", "created_at"],
];

/**
 * No LOCAL_CIVIL_DATE / LOCAL_CIVIL_TIME / REPORTING_PERIOD / DURATION
 * columns exist in the Phase 1 schema — see this file's own module doc
 * comment. Kept as an explicit, empty, typed list (rather than omitted)
 * so a future phase adding one has an obvious, already-wired place to
 * register it and extend the conformance test's coverage.
 */
const LOCAL_CIVIL_DATE_COLUMNS: ReadonlyArray<[table: string, column: string]> = [];

export const TEMPORAL_INVENTORY: readonly TemporalColumn[] = [
  ...ABSOLUTE_INSTANT_COLUMNS.map(([table, column]) => ({
    table,
    column,
    classification: "ABSOLUTE_INSTANT" as const,
    expectedPgType: "timestamp with time zone",
  })),
  ...LOCAL_CIVIL_DATE_COLUMNS.map(([table, column]) => ({
    table,
    column,
    classification: "LOCAL_CIVIL_DATE" as const,
    expectedPgType: "date",
  })),
];
