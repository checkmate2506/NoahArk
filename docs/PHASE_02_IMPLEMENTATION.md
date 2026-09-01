# NoahArk — Phase 2 Implementation Record (Shared Parties & Catalog)

> Status: **P2C.1 implemented, uncommitted.** Independent Sonnet P2B audit:
> **PASS** (no HIGH/MEDIUM). Two confirmed LOW findings and one plausible
> LOW/informational finding were remediated or investigated in this working
> tree (see §16). P2A schema/RLS/migrations remain authoritative. P2C–P2E have
> **not** started. Phase 2 is "Shared Parties & Catalog" per
> `IMPLEMENTATION_ROADMAP.md` §2. **Accounting remains Phase 4.**

Independent Sonnet auditing of the first P2A landing returned **FAIL / not P2B-ready**.
The defects (F-1 through F-6) are recorded in ADR-73 and closed in the committed
P2A tree. They are not concealed.

## 1. P2A objective

Establish the database foundation for shared parties and catalog: Prisma schema,
one additive migration, Row-Level Security, database constraints and triggers,
and adversarial database tests. **No domain services, APIs, OpenAPI routes,
permissions, UI, imports or exports** — those are P2B–P2E.

## 2. Decisions implemented (ADR-71, ADR-72)

| Area            | Decision                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Party model     | One tenant-owned `party` master (`ORGANISATION` \| `INDIVIDUAL`). Customer and vendor are per-legal-entity **roles**, not separate masters. One party may hold both roles for the same entity.                                                                                                                                                         |
| Contacts        | `party_contact` belongs to exactly one party. No many-to-many sharing. **Never an authentication identity.**                                                                                                                                                                                                                                           |
| Addresses       | Foreign counterparty countries permitted descriptively; uppercase two-letter shape; never selects an adapter.                                                                                                                                                                                                                                          |
| Catalog         | One `catalog_item` with `PRODUCT` \| `SERVICE`. Flat categories. One base UOM, no conversion. No inventory, costing, variants or accounting mapping. No `isStockTracked`.                                                                                                                                                                              |
| Tax placeholder | `catalog_item.tax_category_code`, nullable and **inert** — required by the roadmap's "Tax-mapping placeholders" note. No Phase 2 code reads it.                                                                                                                                                                                                        |
| Pricing         | `NUMERIC(23,6)` exact decimal. `unit_price >= 0`. Effective dates are civil `date`. Overlaps rejected by PostgreSQL. One default price list per legal entity.                                                                                                                                                                                          |
| Custom fields   | Phase 1 mechanism **extended**: typed columns, mandatory legal entity for Phase 2 targets, fail-closed entityType **allowlist** (ADR-73; the original denylist was bypassable — F-3), polymorphic target-integrity trigger (F-6), type-agreement trigger, definition `entityType`/`dataType` immutable once values exist. Legacy JSON column retained. |
| Deletion        | **No hard-delete path.** `noahark_app` receives no `DELETE` grant on any Phase 2 business table; archival is the only removal semantics.                                                                                                                                                                                                               |

## 3. Identity boundary (four distinct concepts)

| Concept                       | Model                             | Authenticates?                      | Scope                              |
| ----------------------------- | --------------------------------- | ----------------------------------- | ---------------------------------- |
| Platform **User**             | `User` (Phase 1)                  | **Yes** — Auth.js, credentials, MFA | Global identity, joined per tenant |
| Employee / **Person**         | future HR `person` + `employment` | No                                  | Phase 7                            |
| Business **Contact**          | `PartyContact` (Phase 2A)         | **No**                              | A person _at a counterparty_       |
| Counterparty **organisation** | `Party` (Phase 2A)                | No                                  | The trading entity itself          |

`PartyContact` has no relation to `User`, `UserCredential`, `Session` or
`Account`, and its email is deliberately not unique against `User.email`.

## 4. Schema

New models: `Party`, `PartyContact`, `PartyAddress`,
`PartyLegalEntityAssignment`, `CustomerRole`, `VendorRole`, `CatalogCategory`,
`UnitOfMeasure`, `CatalogItem`, `CatalogItemLegalEntityAssignment`, `PriceList`,
`PriceListLegalEntityAssignment`, `PriceListEntry` (13).

New enums: `PartyType`, `PartyAddressType`, `PartyStatus`, `AssignmentStatus`,
`CatalogItemType`. `CustomFieldDataType` gains `INTEGER`, `DECIMAL`,
`SINGLE_SELECT` (`NUMBER` retained but deprecated for migration compatibility;
`MULTI_SELECT` excluded).

Extended: `CustomFieldDefinition` (+`is_active`, `display_order`, `version`),
`CustomFieldValue` (+`legal_entity_id`, six typed value columns, `version`,
`created_at`), `LegalEntity` (+`@@unique([id, tenantId])` as a composite-FK
target).

**Naming note:** the counterparty master is `Party`, **not** `Account` —
`model Account` already exists as the Auth.js OAuth account. `DOMAIN_MODEL.md`
§3 was corrected accordingly.

## 5. Row-Level Security

Four policy classes after ADR-73:

1. **Entity-scoped (dual-axis, Phase 1 template verbatim)** —
   `party_legal_entity_assignment`, `customer_role`, `vendor_role`,
   `catalog_item_legal_entity_assignment`,
   `price_list_legal_entity_assignment`, `price_list_entry`.
2. **Shared masters (owner mutation + assignment read)** — `party`,
   `catalog_item`, `price_list`. Each has `owner_legal_entity_id` (composite
   FK with `tenant_id`). Independent Sonnet F-1: the first P2A landing used a
   single assignment-existence USING plus tenant-only WITH CHECK, so an
   assigned non-owner could UPDATE shared fields. Split policies now:
   - SELECT: tenant match AND (owner in `app.legal_entity_ids` OR assignment visible)
   - INSERT WITH CHECK: tenant match AND owner in context
   - UPDATE USING: tenant match AND **current** owner in context
   - UPDATE WITH CHECK: tenant match AND **resulting** owner in context
     (ownership transfer therefore requires A+B in the same context)
3. **Shared children** — `party_contact`, `party_address`. SELECT follows
   party visibility; INSERT/UPDATE require access to `party.owner_legal_entity_id`.
   Assignment-only readers cannot mutate contacts or addresses. No other
   shared child table exists; price-list/catalog assignment rows and
   `price_list_entry` stay on their own `legal_entity_id`.
4. **Tenant-visible reference data** — `catalog_category`, `unit_of_measure`.

`custom_field_value` keeps the nullable-legal-entity dual-axis shape.

**Bootstrap (changed by ADR-73).** The first landing hid unassigned masters
from everyone including the creator ("invisible orphan"). That is withdrawn.
The owner may INSERT (owner id must be in the server-derived
`app.legal_entity_ids` — no client-supplied owner can bypass context) and
may SELECT the new master immediately ("owner-visible unassigned master
pending atomic assignment"). Other entities of the same tenant cannot see it
until assigned. **P2B must still create master + first assignment atomically**;
a failed transaction rolls both back. No circular "at least one assignment"
database constraint was introduced.

**DELETE.** No DELETE grant on any Phase 2 business table.

**Worker.** `noahark_worker` receives **no** grant on any Phase 2 table.

## 6. Constraints and triggers

| Kind           | Invariant                                                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CHECK          | Organisation/individual name shape; non-blank codes; `status = ARCHIVED` ⟺ `archived_at IS NOT NULL`; `country_code ~ '^[A-Z]{2}$'`; `unit_price >= 0`; `effective_to >= effective_from`; custom-field **allowlist** (not denylist); Phase 2 typed-value rules |
| Composite FK   | `(party_id, tenant_id)`, `(legal_entity_id, tenant_id)`, `(owner_legal_entity_id, tenant_id)`, `(assignment_id, legal_entity_id)`, `(price_list_assignment_id, legal_entity_id)`, `(catalog_item_assignment_id, legal_entity_id)`                              |
| Partial UNIQUE | One primary contact per party; entity item code unique per entity when present; one ACTIVE default price list per entity                                                                                                                                       |
| EXCLUDE (gist) | No overlapping price-effective periods per (price-list assignment, catalog-item assignment) — requires `btree_gist`                                                                                                                                            |
| Trigger        | `custom_field_value_typed_guard_trg`; `custom_field_value_target_integrity_trg` (explicit CASE, no dynamic SQL); `custom_field_definition_immutability_trg`                                                                                                    |
| RESTRICT FK    | Referenced category/UOM cannot be destructively deleted                                                                                                                                                                                                        |
| NO ACTION FK   | Owner FK `ON DELETE NO ACTION ON UPDATE CASCADE`. ON DELETE NO ACTION prevents standalone deletion of an owner legal entity while owned masters remain. Its statement-end constraint behaviour also permits the intended tenant-level cascade.                 |

## 7. Price-list legal-entity boundary

`PriceListEntry` carries `legal_entity_id` **and** two composite foreign keys
that each include it:

```
(price_list_assignment_id,   legal_entity_id) -> price_list_legal_entity_assignment(id, legal_entity_id)
(catalog_item_assignment_id, legal_entity_id) -> catalog_item_legal_entity_assignment(id, legal_entity_id)
```

A row can therefore only reference a price-list assignment and a catalog-item
assignment belonging to the **same** legal entity as the row itself. A caller
cannot price an item assigned only to another entity, even through raw SQL —
proven in both directions by `partiesCatalogSchema.test.ts`. RLS is enforceable
directly from `price_list_entry.legal_entity_id`, with no join required.

## 8. Temporal classification

| Field                                                                         | Classification       | PostgreSQL       | Prisma                        |
| ----------------------------------------------------------------------------- | -------------------- | ---------------- | ----------------------------- |
| `created_at`, `updated_at`, `archived_at`, `assigned_at` (all Phase 2 tables) | ABSOLUTE_INSTANT     | `timestamptz(3)` | `DateTime @db.Timestamptz(3)` |
| `price_list_entry.effective_from` / `effective_to`                            | **LOCAL_CIVIL_DATE** | **`date`**       | `DateTime @db.Date`           |
| `custom_field_value.value_date`                                               | **LOCAL_CIVIL_DATE** | **`date`**       | `DateTime @db.Date`           |

These are the codebase's first non-instant temporal columns. A price effective
"1 July" must mean 1 July for every reader; stored as `timestamptz` a value
written at 00:00 Asia/Jakarta reads as 30 June at UTC and could select the wrong
price on a boundary day. `temporalSchemaConformance.test.ts` now asserts
`LOCAL_CIVIL_DATE → date` and **fails** if such a column becomes
`timestamp`/`timestamptz`, and proves identical civil dates under UTC,
Asia/Singapore, Asia/Kuala_Lumpur, Asia/Jakarta, Asia/Jayapura and Etc/GMT+5.

## 9. Migration approach

Additive migrations:

- `20260824000003_parties_catalog` — first P2A landing (byte-identical to its
  pre-remediation state; **not edited**).
- `20260824000004_p2a_audit_hardening` — independent-audit remediation (ADR-73).
  Adds `owner_legal_entity_id`, replaces shared-master RLS, replaces the
  custom-field denylist with an allowlist, and adds target-integrity plus
  definition-immutability triggers.

Phase 1's two migrations are **untouched**. Squashing 00003+00004 into one
migration would be possible on a never-deployed greenfield repository; it is
not done because 00003 is already applied to local verification databases and
rewriting it would drift checksums. The persistent `noahark` database is not
reset.

- Nothing is dropped. The single relaxation remains
  `custom_field_value.value DROP NOT NULL` from 00003. The legacy JSON column
  is retained.
- Role provisioning is unchanged; no DELETE grant; worker still un-granted.

## 10. Custom-field migration safety

Before the first P2A landing, every existing use was enumerated: production
and seed created **no** `CustomFieldDefinition` / `CustomFieldValue`. Tests
used `party`, `catalog_item` and `demo_approval_subject`. Schema/docs also
mentioned `party_contact` and `party_address`.

Independent Sonnet F-3: the migration-3 **denylist** (and its comment that
auth targeting was "absolute") was false. Leading/trailing whitespace and
unenumerated auth-adjacent names bypassed `lower(entity_type) NOT IN (...)`.
ADR-73 replaces it with a fail-closed **allowlist**. Canonical form is
lowercase snake_case exact match; `entity_type` must equal `btrim(entity_type)`.
Unknown, whitespace, case, plural and table/model-name variants are rejected
because they are absent from the list.

Allowlist:

- Phase 2: `party`, `party_contact`, `party_legal_entity_assignment`,
  `customer_role`, `vendor_role`, `catalog_item`,
  `catalog_item_legal_entity_assignment`, `price_list`,
  `price_list_legal_entity_assignment`
- Legacy-only: `demo_approval_subject` (JSON storage; **no** parent-table
  referential claim; must not masquerade as a Phase 2 typed target)

Not included: `user` / `account` / `session` / credentials / MFA / permissions /
audit / idempotency, `party_address`, `price_list_entry`, categories, UOM.

Independent Sonnet F-6 (blocking because Phase 2 is the first phase attaching
custom fields to real masters): polymorphic `(entity_type, entity_id)` is
enforced by `custom_field_value_target_integrity_trg` — an explicit CASE, never
dynamic SQL on untrusted `entityType`. Phase 2 values must name a real row of
the stated type that belongs to the same tenant and is owned by or assigned to
the stated legal entity. `entityType` and `dataType` cannot change once values
exist.

## 11. Attachment boundary — PROHIBITED (see ADR-72)

`attachment` has tenant-only RLS and no `legal_entity_id`. Proven live: an
entity-A session **can** read the attachment metadata row of a record owned only
by entity B. File content stays protected (`file_object` is dual-axis scoped),
but the metadata still discloses that entity B holds a document against a
specific record. **Catalog and party attachments are therefore prohibited in
Phase 2**: `catalog_item` has no image/attachment column and no Phase 2 code
creates an attachment for a Phase 2 owner type. Both are asserted by
`attachmentCatalogBoundary.test.ts`. Hardening `attachment` is deferred and must
be done with the Phase 1 file workflows in scope.

## 12. Tests added

| File                                                   | Coverage                                                                                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/integration/partiesCatalogSchema.test.ts`       | Party/catalog/pricing invariants; raw-SQL adversarial probes                                                                            |
| `tests/integration/partiesCatalogRls.test.ts`          | SELECT isolation; bootstrap owner-visible unassigned master; worker denial; custom-field typed rules                                    |
| `tests/integration/partiesCatalogOwnership.test.ts`    | INSERT/UPDATE owner boundary for Party, CatalogItem, PriceList; contact/address mutation; ownership transfer A+B; wrong-tenant owner FK |
| `tests/integration/customFieldTargetIntegrity.test.ts` | Allowlist, whitespace/case/plural/auth rejection, every Phase 2 target, cross-tenant/entity, definition immutability, legacy JSON       |
| `tests/integration/attachmentCatalogBoundary.test.ts`  | Attachment leak demonstration + prohibition locks (ADR-72, still deferred)                                                              |
| `lib/monetaryFloatBoundary.test.ts`                    | Defense-in-depth identifier scan; schema NUMERIC is load-bearing (F-5)                                                                  |
| `lib/addressCountryAdapterBoundary.test.ts`            | Address country never selects an adapter                                                                                                |

Both structural guards were proven **non-vacuous** with disposable injected
violations, which were removed afterwards.

## 13. Explicit P2A exclusions

No domain services, API routes, OpenAPI changes, permissions, UI, import/export,
CRM pipeline, sales, purchasing, accounting, inventory, tax logic, e-invoicing,
payroll, Phase 2 jobs, or any country outside SG/MY/ID. No Phase 1 migration was
edited and no Phase 1 security control was weakened.

## 14. Deferred / unresolved

| Item                                               | Disposition                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------ |
| `attachment` RLS hardening                         | Deferred (ADR-72); catalog attachments prohibited meanwhile              |
| Custom-field **contract** step (drop `value Json`) | Deferred to a later phase                                                |
| Ownership transfer UX / permissions / audit        | Explicit, permission-gated and audited in **P2B** — not implemented here |
| "At least one assignment" rule                     | Service-enforced in P2B; deliberately not a circular DB constraint       |
| Category hierarchy                                 | Flat in Phase 2; nullable `parent_id` addable non-destructively          |
| UOM conversion                                     | Out of scope                                                             |
| Import/export                                      | Import out of scope; export deferred to the API phase                    |
| Seed/template data                                 | None                                                                     |
| Retention/anonymisation                            | Structure only (`archived_at`); no automated erasure                     |
| IDR rounding                                       | Unverified; not invented                                                 |
| Monetary-float identifier scan                     | Defense in depth only (F-5); schema NUMERIC is load-bearing              |

## 15. Independent Sonnet P2A audit (closed in this working tree)

| ID  | Severity | Finding                                       | Closure                                          |
| --- | -------- | --------------------------------------------- | ------------------------------------------------ |
| F-1 | HIGH     | Shared-master cross-entity mutation           | `owner_legal_entity_id` + split RLS              |
| F-2 | HIGH     | Missing INSERT/UPDATE RLS tests               | `partiesCatalogOwnership.test.ts`                |
| F-3 | MED      | Denylist bypassable; "absolute" comment false | Fail-closed allowlist in 00004                   |
| F-4 | MED      | Mutation ownership undocumented               | ADR-71, ADR-73, this record, schema              |
| F-5 | LOW      | Identifier-based monetary scan                | Documented as defense in depth; aliases expanded |
| F-6 | HIGH     | Polymorphic custom-field target unenforced    | Target-integrity trigger + tests                 |

P2B domain services are implemented in this working tree (see §16). P2C–P2E have
**not** started.

## 16. P2B — party domain services

P2A schema, migrations 00003–00004, ownership RLS and target-integrity controls
are unchanged. P2B adds no migration.

### Services and package ownership (ADR-74)

| Service                                                                                                    | Package                                | Notes                                                   |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------- |
| Party, including atomic bootstrap, list/get/update/archive, ownership transfer, duplicate-candidate lookup | `@noahark/crm`                         | Shared master                                           |
| PartyContact, PartyAddress                                                                                 | `@noahark/crm`                         | Mutation follows Party owner                            |
| PartyLegalEntityAssignment                                                                                 | `@noahark/crm`                         | Entity-scoped; last ACTIVE assignment cannot be revoked |
| CustomerRole                                                                                               | `@noahark/crm`                         | One per assignment                                      |
| VendorRole                                                                                                 | `@noahark/purchasing`                  | One per assignment; identity remains the shared Party   |
| Thin re-export                                                                                             | `apps/web/lib/services/partyDomain.ts` | For later P2D routes                                    |

Purchasing does not duplicate Party logic; it imports assignment/context/audit helpers from CRM.

### Trusted context

Every operation takes server-derived `AccessContext`. Tenant id, legal-entity
set, actor and permissions are never taken from the request body. Business
writes run inside `withTenantContext` on the RLS-enforced `noahark_app` client.
Empty legal-entity scope fails closed. P2D must add `party:*` permission
catalogue entries and call `authorize()` on API routes — P2B does not seed
permissions.

### Atomic bootstrap

`createParty` inserts Party (owner = proposed legal entity) and the first
`PartyLegalEntityAssignment` for that same entity in one transaction, then
optional customer/vendor roles, then audit events. Assignment or role failure
rolls the Party back. The public service never returns an unassigned Party.

### Ownership and transfer

`ownerLegalEntityId` remains the mutation gate (ADR-73). Assigned non-owners
may read. `transferPartyOwnership` reads the locked current owner, requires
both old and new owners in trusted context, is version-gated, and writes
`party.ownership_transferred` with old/new owner ids only. It does not create,
revoke or modify assignments.

### At-least-one-assignment

Enforced in the service under `pg_advisory_xact_lock` + `SELECT … FOR UPDATE`
on the party. Revoking or suspending the last ACTIVE assignment is a
`CONFLICT`. Concurrent revokes cannot leave zero ACTIVE rows. No hard delete.

### Customer / vendor dual role

Both roles may exist on the same assignment with independent codes, unique per
legal entity. Role updates never write Party master fields. Cross-entity
assignment-id substitution returns `NOT_FOUND`.

### Masking boundary

Email and phone use Phase 1 `maskProtectedFields` with declared keys
`party_contact:email:read` and `party_contact:phone:read`. Those keys are **not**
in the Phase 1 catalogue (P2D work). Until seeded, every production role lacks
them, so reads are fail-closed (values replaced with `null`). Duplicate
candidates never include email, phone, assignments, roles or entity-specific
codes. P2D must: add the keys to `PERMISSIONS` / `PERMISSION_CATALOG` /
system roles as product policy requires; optionally persist `FieldPolicy` rows;
audit sensitive unmasked reads if the API layer requires it.

### Audit events

Hash-chained `writeAuditEvent` in `@noahark/crm` mirrors the Phase 1 writer
(advisory lock + sequence). Actions: `party.created/updated/archived`,
`party.ownership_transferred`, contact/address created/updated/archived,
assignment created/updated/revoked, customer_role and vendor_role
created/updated/archived. Metadata omits email/phone and secrets.

### Exclusions

No catalog, pricing, custom-field services, permissions, API routes, OpenAPI,
UI, import/export, attachments, CRM pipeline, quotations/orders, purchasing
documents, accounting, inventory, tax adapters, e-invoicing, payroll, workers,
or schema/migration/RLS changes. CountryCode on addresses remains descriptive
shape only.

### Tests

Exact counts from this working tree (post low-finding remediation):

| Suite                                                                   | Result                                                                                        |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `@noahark/crm` unit                                                     | **6/6** (includes locale-pinned duplicate ordering)                                           |
| `@noahark/authz` unit (includes fail-closed pending field key)          | 20/20                                                                                         |
| `@noahark/web` unit                                                     | 64/64                                                                                         |
| P2B integration (`partyDomain*.test.ts`, 9 files)                       | **34/34** (original 31, plus 2 archive-create lock races and 1 Prisma unique-violation shape) |
| P2A integration (schema/RLS/ownership/custom-field/attachment/temporal) | **60/60** (6 files; independently verified P2A database/integration subset; not weakened)     |
| Full integration (web + workspace packages)                             | **474/474** (55 files) on PostgreSQL **18.4**                                                 |

Original P2B implementation first run was 28/31 (assigned non-owner `SELECT FOR UPDATE`
mapped to NOT_FOUND; fixed to SELECT-then-Forbidden). This remediation's L-3 shape
probe first asserted `meta.target` as present; the live adapter result was
`target` absent (`undefined`). Production mapping was not changed.

The first L-2 concurrency-test execution passed its 8/8 assertions, but Vitest
nevertheless reported two unhandled `VALIDATION_FAILED` promise rejections. That
was a test-harness promise-handling issue, not a production defect: `.rejects`
handlers were attached after the create promises could settle. The correction is
to attach the rejection assertions synchronously before releasing the row-lock
holder. Subsequent execution passed without unhandled rejections. Independent
Sonnet repeated the final test 5 times, all clean.

PostgreSQL **16.14 was not personally re-run in this session (UNVERIFIED)**.

P2A integration tests were not weakened.

### Independent Sonnet P2B audit (PASS) and LOW remediation

Independent Sonnet P2B audit: **PASS**, no HIGH or MEDIUM findings.

| ID  | Severity          | Finding                                                                               | Closure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L-1 | LOW               | Duplicate-candidate `localeCompare` used the default locale                           | `compareDuplicateCandidates` pins `en-US`, adds partyType/matchReasons secondary keys, and `boundDuplicateCandidates` sorts before slicing to 10. Permanent CRM unit test. Matching eligibility unchanged.                                                                                                                                                                                                                                                                                                                      |
| L-2 | LOW               | `createContact`/`createAddress` checked Party archive status from a pre-lock snapshot | Archive status is taken from the `SELECT … FOR UPDATE` row after owner-authoritative SELECT (non-owner still Forbidden without requiring UPDATE RLS). Concurrent archive-while-create-waits rejects with no contact/address row and no create audit. Opposite lock order: create commits, then archive succeeds; audit chain remains valid.                                                                                                                                                                                     |
| L-3 | LOW/informational | `mapPartyDbError` might let SQLSTATE `23505` shadow Prisma `P2002` target metadata    | **Not confirmed.** A real duplicate `customerRole.create` yields `PrismaClientKnownRequestError` `P2002`. `meta.target` is absent (`meta` is `modelName` + `driverAdapterError`). `23505` lives at `meta.driverAdapterError.cause.originalCode`, not on the `.cause` chain `sqlState()` walks, so P2002 is reached. Production mapping was **not** changed. Mapped application error remains `CONFLICT` with the generic unique-violation message; no Prisma/SQL internals leak. Permanent integration test records this shape. |

`42501 → NOT_FOUND` remains the deliberate fail-closed anti-enumeration mapping. It was not changed.

Hash-chained audit writing is still duplicated between `apps/web/lib/services/auditService.ts` and `packages/crm/src/audit.ts`. That duplication is an **informational drift risk** and was not refactored in this narrow task.

### Remaining risks

- P2D must connect permission catalogue and API authorization.
- Field masking is fail-closed until those permissions exist; tenant_admin
  cannot see contact email/phone until P2D grants the pending keys.
- Last-assignment enforcement is service-layer (deliberately not a circular
  DB constraint).
- Duplicate detection is advisory prefix/exact match on committed normalised
  fields only.
- Prisma adapter unique violations do not populate `meta.target`, so P2B
  conflict messages stay generic unless P2D later maps adapter constraint
  metadata without leaking internals.
- Duplicated audit writers remain an informational drift risk.

P2C–P2E have **not** started.

## 17. P2C.1 — catalog domain services

P2A schema/RLS and P2B party services are unchanged. P2C.1 adds no migration
and does not start P2C.2 (pricing) or P2C.3 (custom fields). ADR-77 is
authoritative for this slice and supersedes ADR-75's archival clause for
P2C.1 only.

### Services and package ownership

| Service                                     | Package                                  | Notes                                           |
| ------------------------------------------- | ---------------------------------------- | ----------------------------------------------- |
| CatalogCategory, UnitOfMeasure              | `@noahark/catalog`                       | Tenant-wide reference data; `code` immutable    |
| CatalogItem create/get/list/update/transfer | `@noahark/catalog`                       | Atomic bootstrap returns `{ item, assignment }` |
| CatalogItemLegalEntityAssignment            | `@noahark/catalog`                       | Target-scoped, visibility-gated create          |
| Thin re-export (22 functions only)          | `apps/web/lib/services/catalogDomain.ts` | For later P2D routes                            |

Trusted-context helpers and pagination are imported from `@noahark/core`.
Transactional audit persistence uses `writeAuditEventInTx` from `@noahark/db`
via a thin `packages/catalog/src/audit.ts` delegate. No fourth writer.

Every public operation takes server-derived `AccessContext` first.
`requireNonEmptyLegalEntityScope` runs before the transaction, including on
Category/UOM reads. Services never call `set_config` and never widen
`ctx.legalEntityIds`. Transactions use PostgreSQL default isolation (READ
COMMITTED): a statement issued after a competing commit sees that commit.

Category and UOM tables have tenant-only RLS and no owner column, so an
empty-legal-entity-scope session could write them at the database layer.
The service-layer empty-scope check is the current fail-closed control.
P2D must add permission catalogue entries and decide whether a database
owner boundary is required.

### Atomic bootstrap

`createCatalogItem` takes `FOR SHARE` on an optional category then the
required UOM (both must exist and be active), inserts the item, inserts
the owner assignment, and writes `catalog_item.created` plus
`catalog_item_assignment.created` in one transaction. Failure rolls back
the whole unit. There is no advisory lock: the item id does not exist yet.

### Ownership transfer and the advisory-lock requirement

`transferCatalogItemOwnership` requires the current owner and the new
owner in trusted context. It acquires
`catalog-item-assignments:<tenantId>:<catalogItemId>` **before** the master
`FOR UPDATE`, then re-checks owner from the locked row. Assignments are
not touched. After A→B the assignment set remains `{A}` while owner is B.
That state is an input to `shared_master_select`, so transfer participates
in the same visibility decision assignment creation relies on.

`updateCatalogItem` never changes `owner_legal_entity_id` and does not
take the advisory key. Owner authority is checked from the SELECT snapshot
**before** `FOR UPDATE` so an assigned non-owner is `FORBIDDEN`, not a
false `NOT_FOUND`.

### 1-A deactivation and change-detected references

`isActive = false` means unavailable for newly introduced or changed
references. Existing CatalogItem rows that already reference an inactive
Category or UOM remain valid. Deactivate/activate lock the reference row
`FOR UPDATE` and do **not** count items: Probe A showed a reference-count
guard is blind under partial legal-entity scope.

`updateCatalogItem` validates a category/UOM only when the payload
introduces or changes the id relative to the **locked** row. Absent field:
no write. Echo of the same id: no `FOR SHARE` (must succeed even if the
row is now inactive). `null` categoryId clears without an active check.
`null` versus absent stay distinguishable.

### Assignment creation — target-scoped and visibility-gated

Assignment creation is **not** self-service and **not** unrestricted
self-assignment. Both conditions are required: the target legal entity is
in `ctx.legalEntityIds`, **and** the CatalogItem is already visible through
the ordinary owner-or-assigned SELECT policy. A B-only context cannot
assign B to an item owned by and assigned only to A (`NOT_FOUND`, no row,
no audit event). An assigned non-owner whose context also holds C may
extend coverage to C. No explicit owner check is imposed. No master
`FOR UPDATE` is taken on this path, because PostgreSQL would apply UPDATE
`USING` expressions and silently impose owner-only authority.

### Shared advisory key and the transfer/create TOCTOU

Both `createCatalogItemAssignment` (before its visibility `findFirst`) and
`transferCatalogItemOwnership` (before its master row lock) acquire
`catalog-item-assignments:<tenantId>:<catalogItemId>`. Under READ
COMMITTED the post-lock visibility read sees any transfer that committed
while the create waited:

- **Create-first:** the C assignment commits, then B→D transfer succeeds,
  C remains ACTIVE.
- **Transfer-first:** the create re-reads visibility after B→D, sees owner
  D with assignments `{A}`, and returns `NOT_FOUND` with no C row and no
  create audit event.

Any future operation that changes `catalog_item.owner_legal_entity_id`
must take this key first. Deadlock: every two-resource path takes advisory
first; `updateCatalogItem` takes only the master row.

### Last-ACTIVE guard

Unconditional. `visibleActive` is an RLS-filtered lower bound, so a
partial-scope caller can be refused even when another entity's ACTIVE
assignment exists. That over-refusal is accepted (ADR-77(c)). Archived
`entityItemCode` values remain reserved by the non-ACTIVE-scoped unique
index; that is preserved, not "fixed".

### `archiveCatalogItem` deferred

No public archive, no internal cascade primitive, no `CATALOG_ITEM_ARCHIVED`
action. P2D owns master archival together with the permission model.

### Audit actions (14)

`catalog_category.created/updated/deactivated/activated`,
`unit_of_measure.created/updated/deactivated/activated`,
`catalog_item.created/updated/ownership_transferred`,
`catalog_item_assignment.created/updated/archived`.
Metadata: `legalEntityId` is owner for the item, the row's entity for
assignments, `null` for Category/UOM.

### Error mapping

Same shape as P2B: `42501` → `NOT_FOUND` (fail-closed anti-enumeration);
`23505`/`P2002` → `CONFLICT`; `23503`/`P2003`/`23514` → `VALIDATION_FAILED`;
`P2025` → `NOT_FOUND`; unknown rethrown. No `23P01` branch. Recorded P2B
L-3 driver behaviour is unchanged: a real duplicate through the installed
adapter raises `P2002`; `sqlState()` does not see `originalCode` nested
under `meta.driverAdapterError`; `meta.target` is absent, so the generic
P2002 conflict message is the normal path.

### Tests

Exact counts from this working tree after the quality gates (remediation
session, including the C-18 supplementary production-transfer probe):

| Suite                                                                   | Result                                                                             |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `@noahark/catalog` unit                                                 | **22/22** (4 files)                                                                |
| P2C.1 integration (`catalogDomain*.test.ts`, 6 files)                   | **18/18**                                                                          |
| `catalogDomainConcurrency.test.ts` repeated 5×                          | **12/12** each run (C-18 both orderings + production-transfer advisory-lock probe) |
| P2A integration (schema/RLS/ownership/custom-field/attachment/temporal) | **60/60** (6 files; not weakened)                                                  |
| P2B integration (`partyDomain*.test.ts`, 9 files)                       | **34/34**                                                                          |
| Full `@noahark/web` integration                                         | **428/428** (52 files) on PostgreSQL **18.4**                                      |

C-18 remains the decisive TOCTOU regression for both transfer/create
orderings. The supplementary probe holds
`catalog-item-assignments:<tenantId>:<catalogItemId>` from a raw
`noahark_app` transaction and starts the real `transferCatalogItemOwnership`
service: the service is proven blocked on that advisory lock (ownership and
transfer audit unchanged while held), then succeeds after release with one
owner change, one version increment, unchanged assignments, exactly one
`catalog_item.ownership_transferred` event, and a valid audit chain.

C-16 (in-suite) reads the tenant chain ordered by `sequence`, asserts
gapless sequences and `verifyAuditChain(links).valid === true`. That test
writes five catalog-domain events on the chain (`unit_of_measure.created`,
`catalog_item.created`, `catalog_item_assignment.created`,
`catalog_item.updated`, `catalog_item.ownership_transferred`) plus any
earlier events from the same tenant; all were verified before the
disposable database was dropped.

### Independent Sonnet P2C.1 audit (initial NO) and remediation

Independent Sonnet P2C.1 audit: **NO** for merge/readiness. Findings:

| ID       | Severity  | Finding                                                                                                                                                        | Closure                                                                                                                                                                                     |
| -------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —        | —         | No production-code defect                                                                                                                                      | Unchanged. Services were not modified in remediation.                                                                                                                                       |
| C-18 gap | Test      | Transfer-first race mutates ownership with raw SQL; missing live black-box proof that the real `transferCatalogItemOwnership` waits on the shared advisory key | Supplementary probe added to `catalogDomainConcurrency.test.ts`. The real service blocked on the externally held key, then committed correctly after release. 5× concurrency repeats clean. |
| Docs     | Editorial | Test-results table was not formatted as a markdown table                                                                                                       | Reformatted in the Tests table above with exact post-remediation counts.                                                                                                                    |
| Docs     | Editorial | Duplicated closing sentence “P2C.2 and P2C.3 have not started.”                                                                                                | Duplicate removed.                                                                                                                                                                          |

The auditor accidentally applied already-committed migrations
`20260824000003_parties_catalog` and `20260824000004_p2a_audit_hardening`
to the persistent `noahark` database. No P2C.1 schema exists or was
applied. No existing business-row data was altered as part of P2C.1. The
database is now at committed migrations 00001–00004
(`20260817000001_init`, `20260817000002_rls_and_constraints`,
`20260824000003_parties_catalog`, `20260824000004_p2a_audit_hardening`).
It was not reset or rolled back. Read-only `prisma migrate status` reports
the schema up to date. Disposable `noahark_test_integration_*` databases
are created and dropped per suite; none remain after teardown.

### PostgreSQL versions

PostgreSQL **18.4** (`x86_64-windows`, MSVC) via `embedded-postgres`.
PostgreSQL **16.14 was not run in this session (UNVERIFIED)**.

### Initial gate failures

1. `catalogScopeBoundary` first run: `findBannedTokens` used substring
   `includes()`, so `archiveCatalogItemAssignment` matched banned
   `archiveCatalogItem` and `means` in stripped-then-rescanned comments
   matched `ean`. Corrected to word-boundary matching; in-memory fixtures
   prove `archiveCatalogItem(` is still detected.
2. Repo-wide `pnpm format:check` fails on many pre-existing files outside
   this slice. P2C.1 paths were formatted and pass `prettier --check`.
3. `pnpm audit --prod` reports a pre-existing high in Prisma's
   `deepmerge-ts` (not introduced here; no version bump).

P2C.2 and P2C.3 have **not** started.
