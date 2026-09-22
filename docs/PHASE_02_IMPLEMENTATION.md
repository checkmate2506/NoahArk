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

## 18. P2C.2 — pricing domain services

P2A schema/RLS, P2B party services and P2C.1 catalog services are unchanged.
P2C.2 adds no migration and does not start P2C.3 (typed custom fields).
ADR-78 is authoritative for this slice.

### Services and package ownership

| Service                                     | Package                                  | Notes                                                                    |
| ------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| PriceList create/get/list/update/transfer   | `@noahark/catalog`                       | Atomic bootstrap returns `{ priceList, assignment }`; currency immutable |
| PriceListLegalEntityAssignment              | `@noahark/catalog`                       | Target-scoped, visibility-gated create; last-ACTIVE guard                |
| setDefaultPriceList                         | `@noahark/catalog`                       | Per-entity at-most-one ACTIVE default; no `expectedVersion`              |
| PriceListEntry create/get/list/update/close | `@noahark/catalog`                       | Gist exclusion is the overlap authority; close is strict-shrink          |
| resolveEffectivePrice                       | `@noahark/catalog`                       | Explicit `onDate`; read-only; no audit                                   |
| Thin re-export                              | `apps/web/lib/services/catalogDomain.ts` | Adds the pricing functions beside the P2C.1 barrel                       |

Transactional audit persistence uses `writeAuditEventInTx` via
`packages/catalog/src/audit.ts`. No fourth writer.

### Frozen contracts

- `requireNonEmptyLegalEntityScope` before every transaction.
- No `archivePriceList`. No DELETE on any pricing table.
- Currency and `ownerLegalEntityId` are omitted from the PriceList update schema.
- Entry `unitPrice` crosses every boundary as a decimal string; canonical
  output is always 6 fractional digits. Civil dates are `YYYY-MM-DD` only.
- `resolveEffectivePrice` has no implicit "today".
- Archiving an assignment permanently prevents re-assigning that price list
  to that legal entity (`(price_list_id, legal_entity_id)` UNIQUE, no status
  predicate). Entries remain readable and closeable, but are ineligible for
  resolution.

### Lock order

| Step | Resource                                                                                | Who takes it                                           |
| ---- | --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1    | advisory `price-list-default:<tenantId>:<legalEntityId>`                                | update/archive assignment, setDefault                  |
| 2    | advisory `price-list-assignments:<tenantId>:<priceListId>` (lexicographic when several) | create/update/archive assignment, transfer, setDefault |
| 3    | `price_list FOR UPDATE`                                                                 | updatePriceList, transferPriceListOwnership only       |
| 4    | assignment row `FOR UPDATE` / `FOR SHARE`                                               | mutating assignment vs entry create/update             |
| 5    | catalog-item assignment `FOR SHARE`                                                     | entry create/update, after step 4                      |
| 6    | `price_list_entry FOR UPDATE`                                                           | update, close                                          |
| 7    | audit chain                                                                             | `writeAuditEventInTx`, always last                     |

No pricing path takes `catalog-item-assignments:`. No master row lock on
entry, assignment-create or default paths.

Create versus assignment-suspend overlap: `createPriceListEntry` takes
`FOR SHARE` on the relevant assignment row and takes no advisory key.
`updatePriceListAssignment` / `updateCatalogItemAssignment` take `FOR UPDATE`
on that same row. An in-flight create that already holds `FOR SHARE` therefore
forces suspend to wait, and create always commits first. Suspend-first is
possible only when suspend commits before create acquires `FOR SHARE`; create
then fails closed with `ConflictError`, leaves no entry and no
`price_list_entry.created` event. Both orderings are proven with
`pg_stat_activity` lock waiters rather than `Promise.allSettled` races.

### Default semantics

Uniqueness is `legal_entity_id`, status-scoped: at most one ACTIVE default,
never exactly one. Two rejected no-ops (`VALIDATION_FAILED`, no write, no
audit): (1) setting the assignment that is already the ACTIVE default;
(2) clearing with `priceListId = null` when no ACTIVE default exists.
First-time set, swap and clear each write exactly one
`price_list_assignment.default_changed` event and increment each changed
assignment version once.

### Numeric and civil-date rules

`parseDecimalString` accepts only
`/^(?:0|[1-9][0-9]{0,16})(?:\.[0-9]{1,6})?$/` after trim.
`formatDecimal` always returns 6 fractional digits.
`parseCivilDate` requires `YYYY-MM-DD` and a real calendar day, constructed
as UTC. No `Date.now()` and no implicit today on any pricing semantic path.

### ADR-78 lifecycle

Assignment suspend/archive does not inspect entries. Close-on-inactive is
permitted and does not read masters or assignments. Status leaving ACTIVE
clears `isDefault` because the default index predicate is status-scoped.
`closePriceListEntry` is strict-shrink-only and cannot reopen.
`updatePriceListEntry` remains the general ACTIVE-state edit and may change
or clear `effectiveTo`, subject to validation and the gist exclusion
constraint.

### Error mapping and sanitized 23P01 shape

Existing SQLSTATE/Prisma branches are unchanged. Additive P2002 targets:
`price_list_tenant_id_code`, `(price_list_id, legal_entity_id)`,
`price_list_assignment_one_default_per_entity`.
`isExclusionViolation` maps a live gist exclusion to
`ConflictError("A price for this item already covers part of that period")`.
`sqlState()` is byte-identical.

Sanitized live Prisma-adapter shape captured through
`tx.priceListEntry.create` on a disposable database (SQL text, bound
parameters, stacks, connection details, constraint names, `message`,
`originalMessage`, `detail` and `hint` values redacted):

- class name: `PrismaClientKnownRequestError`
- top-level `code`: `P2039`
- top-level key names: `clientVersion`, `code`, `meta`, `name`
- `meta` key names: `driverAdapterError`, `modelName`
- nested `meta.driverAdapterError` class name: `DriverAdapterError`
- nested `driverAdapterError` key names: `cause`, `name`
- nested `cause` key names: `code`, `column`, `detail`, `hint`, `kind`,
  `message`, `originalCode`, `originalMessage`, `severity`
- nested `cause` structured values: `code` = `23P01`,
  `originalCode` = `23P01`, `kind` = `postgres`

The detector matches only the exact values `23P01` or
`exclusion_violation` on `code` / `originalCode` / `kind`. It does not
treat `kind` = `postgres` as a match (that would be far too broad). The
live mapping therefore fires on nested `code` / `originalCode` = `23P01`.

The detector inspects only `code`, `originalCode`, `kind`, `cause` and
`meta.driverAdapterError`, is cycle-guarded and depth-bounded, matches only
those exact values, and returns false for unrecognised shapes.

### Audit actions (10)

`price_list.created/updated/ownership_transferred`,
`price_list_assignment.created/updated/archived/default_changed`,
`price_list_entry.created/updated/closed`.
No `price_list.archived`. Monetary amounts in payloads are 6-decimal
strings; civil dates are `YYYY-MM-DD`.

### Tests

Exact counts from this working tree after the quality gates:

| Suite                                          | Result                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `@noahark/catalog` unit                        | **47/47** (7 files; 56/56 was inflated by 9 duplicated `catalogScopeBoundary` tests registered via a `*.test.ts` import) |
| `@noahark/audit` unit                          | **28/28** (2 files)                                                                                                      |
| `@noahark/web` unit                            | **64/64** (9 files)                                                                                                      |
| P2C.2 integration (`pricingDomain*.test.ts`)   | **14/14** (7 files)                                                                                                      |
| `pricingDomainConcurrency.test.ts` repeated 5× | **7/7** each run                                                                                                         |
| P2C.1 integration (`catalogDomain*.test.ts`)   | **18/18** (6 files), unweakened                                                                                          |
| P2A integration (six files)                    | **60/60**                                                                                                                |
| P2B integration (`partyDomain*.test.ts`)       | **34/34** (9 files)                                                                                                      |
| Phase 1 audit/security/concurrency subset      | **43/43** (5 files)                                                                                                      |
| Full `@noahark/web` integration                | **442/442** (59 files) on PostgreSQL **18.4**                                                                            |

Live audit-chain verification ran inside
`pricingDomainConcurrency.test.ts` on a disposable database:
`verifyAuditChain(...).valid === true` and sequences were gapless.

### PostgreSQL versions

PostgreSQL **18.4** (`x86_64-windows`, MSVC) via `embedded-postgres` on
port 55432. PostgreSQL **16.14 NOT RUN (UNVERIFIED)**.

### Initial gate failures

1. `SET TIME ZONE $1` is invalid PostgreSQL; the resolution timezone loop
   now uses an allowlisted `SET TIME ZONE '<zone>'` string.
2. Default/concurrency tests attempted to create an owner assignment that
   `createPriceList` already bootstraps; those duplicate creates were
   removed.
3. Last-ACTIVE assignment mutations after adding entity B must use
   `ctxAB`, not `ctxA` (ADR-77(c) over-refusal). Fixed.
4. Live 23P01 shape was first documented as `kind = exclusion_violation`.
   The Prisma adapter probe showed top-level `P2039` and nested
   `kind = postgres`; docs and ADR-78 were corrected to the live shape.
5. `@noahark/web` lint unused imports/bindings in two integration files;
   typecheck failed on Prisma spy assignments. Both were fixed.
6. Independent Sonnet pre-commit audit found that committed HEAD's
   `docs/DECISION_REGISTER.md` already passed Prettier; the working-tree
   failure was introduced by the ADR-78 row. Remediation ran
   `prettier --write` on that file (authorised Markdown-table realignment).
   ADR-71–77 wording is unchanged aside from wrapping; ADR-78 wording is
   unchanged. The earlier claim that committed wrapping already failed
   Prettier was incorrect.
7. Independent Sonnet audit of `pnpm audit --prod` reported two HIGH
   advisories (`deepmerge-ts` and `mysql2`), not one. A later re-run in
   this remediation reported six HIGH and one moderate, all pre-existing
   Prisma-transitive findings (`deepmerge-ts`, `mysql2`, and `fast-uri`
   via `@prisma/dev`); none were introduced by P2C.2 and no dependency
   was bumped.

## 19. P2C.3 — typed custom-field domain services

P2C.3 implements `@noahark/custom-fields` and a thin
`apps/web/lib/services/customFieldDomain.ts` re-export on the unchanged P2A
schema (ADR-79). Allowed runtime dependencies are `@noahark/core`,
`@noahark/db`, `@noahark/audit` and `zod`. The package does not import
CRM, Catalog, apps/web, Next.js, or system/worker clients.

### Public surface

Definitions: `createCustomFieldDefinition`, `getCustomFieldDefinition`,
`listCustomFieldDefinitions`, `updateCustomFieldDefinition`,
`deactivateCustomFieldDefinition`, `activateCustomFieldDefinition`.

Values: `setCustomFieldValue`, `getCustomFieldValue`,
`listCustomFieldValues`. There is no clear, delete, unset or archive
operation.

Every operation takes `AccessContext` first, calls
`requireNonEmptyLegalEntityScope` before opening a transaction, and uses
`withTenantContext` with ordinary `noahark_app` RLS.

Definitions persist `legalEntityId: null`. List order is `createdAt ASC,
id ASC`. `displayOrder` is returned and is not the pagination key.
`entityType`, `key` and `dataType` are absent from the update schema.

Supported tagged types: STRING, INTEGER, DECIMAL, BOOLEAN, DATE,
SINGLE_SELECT. Rejected: NUMBER, MULTI_SELECT, `demo_approval_subject`,
legacy JSON, untagged envelopes. DECIMAL is a signed NUMERIC(23,6)
string parser that does not reuse the non-negative pricing parser.
Storage writes exactly one typed column; the legacy JSON column stays
SQL NULL (`Prisma.DbNull`).

Targets: the nine Phase 2 types. Shared masters derive the owner legal
entity; assignments and roles use their own `legalEntityId`. ARCHIVED
targets are rejected. SUSPENDED entity-scoped targets remain writable.
Assigned non-owners of a shared master cannot read or write the owner's
value.

### Lock order (setCustomFieldValue)

1. advisory `custom-field-value:<tenantId>:<definitionId>:<entityId>`
2. definition FOR SHARE
3. target FOR SHARE
4. existing value FOR UPDATE
5. audit-chain advisory last (inside `writeAuditEventInTx`)

Definition mutations lock the definition FOR UPDATE. Catalog/pricing
assignment advisory keys are not taken.

### Audit

Six constants only: `custom_field_definition.created/updated/deactivated/activated`
and `custom_field_value.created/updated`. Definition events use
`legalEntityId: null`. Value events use the derived legal entity.
Payloads contain identifiers, type, lifecycle and version only — never
field values.

### Error mapping and sanitized 23514 shape

`pgErrorCode()` is cycle-guarded and depth-bounded over `code`,
`originalCode`, `cause` and `meta.driverAdapterError`. Exact five-digit
SQLSTATE match. No message-text scan.

Live probe: `tx.customFieldValue.create` with two typed columns set, on a
disposable database through the normal Prisma/adapter stack.

Sanitized live shape (SQL, parameters, stacks, connection details,
constraint names, `message` / `originalMessage` / `detail` / `hint`
redacted):

- class name: `PrismaClientKnownRequestError`
- nested structured `originalCode`: `23514`

Public mapping is the fixed service-authored
`ValidationError("Custom field value failed a storage constraint")`.

Other mappings: 42501 → NOT_FOUND; 23505 / P2002 → CONFLICT; 23503 /
P2003 → VALIDATION_FAILED; P2025 → NOT_FOUND; expected-version miss →
STALE_VERSION; inactive definition → CONFLICT; invisible target →
NOT_FOUND.

### Tests actually run

| Suite                                              | Result                                        |
| -------------------------------------------------- | --------------------------------------------- |
| `@noahark/custom-fields` unit                      | **35/35** (5 files)                           |
| `@noahark/catalog` unit                            | **47/47** (7 files)                           |
| `@noahark/audit` unit                              | **28/28** (2 files)                           |
| `@noahark/core` unit                               | **23/23** (4 files)                           |
| `@noahark/web` unit                                | **64/64** (9 files)                           |
| P2C.3 integration (`customFieldDomain*.test.ts`)   | **29/29** (8 files)                           |
| `customFieldDomainConcurrency.test.ts` repeated 5× | **7/7** each run                              |
| P2C.2 integration (`pricingDomain*.test.ts`)       | **14/14** (7 files)                           |
| P2C.1 integration (`catalogDomain*.test.ts`)       | **18/18** (6 files)                           |
| P2B integration (`partyDomain*.test.ts`)           | **34/34** (9 files)                           |
| P2A six-file subset                                | **60/60** (6 files; see breakdown below)      |
| Phase 1 audit/security/concurrency subset          | see clarification below                       |
| Full `@noahark/web` integration                    | **471/471** (67 files) on PostgreSQL **18.4** |

Canonical P2A six-file subset (independently verified; no P2A test was
removed, skipped, renamed or weakened — the earlier **59/59** figure was
a reporting/selection error only):

| File                                 | Tests  |
| ------------------------------------ | ------ |
| `partiesCatalogSchema.test.ts`       | 14     |
| `partiesCatalogRls.test.ts`          | 15     |
| `partiesCatalogOwnership.test.ts`    | 9      |
| `customFieldTargetIntegrity.test.ts` | 12     |
| `attachmentCatalogBoundary.test.ts`  | 3      |
| `temporalSchemaConformance.test.ts`  | 7      |
| **Total**                            | **60** |

Phase 1 subset clarification: the implementation run reported **43/43**
across five named files. The exact canonical five-file definition is not
recorded in this document. The independent Sonnet audit’s thematic
reconstruction passed **44/44**. The specifically named “Phase 1
five-file subset” therefore remains **UNVERIFIED** as a reproducible
fixed subset. Full `@noahark/web` integration still independently passed
**471/471**.

Live audit-chain verification ran inside
`customFieldDomainConcurrency.test.ts` and
`customFieldDomainAudit.test.ts` on disposable databases:
`verifyAuditChain(...).valid === true` and sequences were gapless.

### PostgreSQL versions

PostgreSQL **18.4** via `embedded-postgres` on disposable integration
databases (`SELECT version()` asserted in
`customFieldDomainErrorMapping.test.ts`). PostgreSQL **16.14 NOT RUN
(UNVERIFIED)**.

### Initial gate failures

1. Typecheck rejected JSON `null` assignments under Prisma 7's
   `exactOptionalPropertyTypes` contract. Production now writes SQL NULL
   for the unused JSON column and unused definition `options` via
   `Prisma.DbNull`.
2. Ownership-transfer-first versus `setCustomFieldValue` was first
   expected to surface `ForbiddenError`. After the holder commits the
   owner change, the waiter's target `FOR SHARE` is filtered by the
   owner-only UPDATE policy and returns no row, so the service fail-closes
   as `NotFoundError("Target")`. The concurrency test was corrected to
   that observed result. Assigned-non-owner writes that can still SELECT
   the master continue to fail as `ForbiddenError` from the owner check.
3. `@noahark/web` lint reported unused imports in
   `customFieldDomainIsolation.test.ts` and
   `customFieldDomainRlsAdversarial.test.ts`. Both were removed.

### Independent Sonnet P2C.3 audit

Independent Sonnet P2C.3 audit: **PASS**. No HIGH or MEDIUM defect was
found in the P2C.3 changeset.

The audit found that all 28 new files initially failed Prettier while
the five modified files already passed. Formatting was applied to those
28 files without semantic change. The audit’s required production
`next build` regenerated `apps/web/next-env.d.ts`; that generated file
was restored to HEAD. P2D was not started.

### Dependency security (`pnpm audit --prod`)

The implementation run could not complete `pnpm audit --prod` (registry
bulk-advisory request failed, then timed out). The independent audit
subsequently completed it and observed **10** vulnerabilities: **2**
critical, **7** high, **1** moderate. That result included a **direct**
Next.js 16.3.1 security advisory and other Prisma/Next.js-related
**transitive** findings.

P2C.3 introduced **no** external dependency version upgrade. These
advisories are not claimed to have been introduced by P2C.3, and the
counts are not claimed to be permanent. The Next.js runtime patch was
completed after P2C.3 landed; see **§20**. Remaining Prisma CLI and
dev-only findings are still deferred.

### P2D deferred work

- Permission-gate definition management.
- Decide whether APIs need an expanded assigned-reader value model and
  matching database policy.
- Clear/delete semantics together with DELETE-grant / RLS work.
- Master archival of custom-field targets.
- Display-specific definition ordering.
- NUMBER / MULTI_SELECT remain unsupported.
- Remaining Prisma CLI / dev-only advisories (see §20).

P2C.3 was committed and pushed as
`33a8566317213ae177d5184c26e7717ad623a7d5`.

## 20. Dependency-security remediation (pre-P2D)

Pre-P2D Next.js runtime security patch only. Prisma remains **7.9.1**.
No `pnpm` overrides, no audit suppression, no `.npmrc` change, no
`images.unoptimized`, no `localPatterns`, and no MIME/upload hardening.
No ADR. P2D was not started.

### Pre-change audit

Timestamp **2026-09-10T20:49:50+08:00** (`pnpm audit --prod`): **10**
findings, **2** critical, **7** high, **1** moderate.

Timestamp **2026-09-10T20:50:01+08:00** (`pnpm audit`): **13** findings,
**2** critical, **8** high, **3** moderate.

Direct Next.js critical advisories on `next@16.3.1`:

- `GHSA-p293-qw3h-jr36` — unauthenticated RCE on Windows-hosted servers
- `GHSA-2xp9-vwfh-vxw4` — unauthenticated RCE in Image Optimization when
  AVIF files are used

Transitive sharp advisory on `next > sharp@0.35.3`:

- `GHSA-rgj7-g3m4-5g8c` — libheif issues `GHSA-g89c-p67h-r497` and
  `GHSA-2jg2-4ch7-h545`

### Image-optimizer reachability before upgrade

`next.config.ts` does not set `images.unoptimized`. Middleware matcher
is `/app/:path*` only, so `/_next/image` is not covered.

On Next.js **16.3.1** at `http://localhost:3000`, unauthenticated
`GET /_next/image` (missing params, same-origin URL, and remote URL)
returned **HTTP 400** from the Image Optimization API with security
headers and **no** sign-in redirect. The optimizer path was therefore
reachable before the upgrade.

### Change

- `apps/web` `next` **16.3.1 → 16.3.4**
- transitive `sharp` **0.35.3 → 0.35.4**
- `@next/env` and `@next/swc-*` **16.3.4**
- `@img/sharp-*` **0.35.4**; `@img/sharp-libvips-*` **1.3.2 → 1.3.3**
  (Next 16.3.4 resolution)
- React **19.2.8**, TypeScript **5.9.3**, Prisma / `@prisma/client` /
  `@prisma/adapter-pg` **7.9.1** unchanged
- no override

`pnpm install --frozen-lockfile` succeeded. `pnpm why next --prod`
shows `next@16.3.4` under `@noahark/web`. `pnpm why sharp --prod`
shows `sharp@0.35.4` under `next@16.3.4`. Vulnerable `next@16.3.1` and
`sharp@0.35.3` are absent from the lockfile and the web production
graph.

### Post-change audit

Timestamp **2026-09-10T20:52:45+08:00** (`pnpm audit --prod`): **7**
findings, **0** critical, **6** high, **1** moderate.

Timestamp **2026-09-10T20:52:57+08:00** (`pnpm audit`): **10** findings,
**0** critical, **7** high, **3** moderate.

Removed: `GHSA-p293-qw3h-jr36`, `GHSA-2xp9-vwfh-vxw4`,
`GHSA-rgj7-g3m4-5g8c`.

These counts are point-in-time. The advisory database can change.

### Remaining production (`pnpm audit --prod`) findings

All seven remain because `@prisma/client@7.9.1` pulls `prisma@7.9.1` into
the production graph as an optional peer, so `pnpm audit --prod` surfaces
Prisma **CLI** packages (`@prisma/config`, `mysql2`, `@prisma/dev` /
`ajv` / `fast-uri`) that are not NoahArk request-path runtime drivers.
NoahArk uses PostgreSQL via `@prisma/adapter-pg` and `pg`, not `mysql2`.
P-2 keeps Prisma at 7.9.1; no compatible in-scope bump exists without
changing Prisma.

| Package        | Advisory              | Severity | Path (prod)                                                             | Class             | Upstream compatible fix outside this patch |
| -------------- | --------------------- | -------- | ----------------------------------------------------------------------- | ----------------- | ------------------------------------------ |
| `deepmerge-ts` | `GHSA-ggr8-5vv4-36mx` | high     | `@noahark/db` → `@prisma/client` → `prisma` → `@prisma/config`          | Prisma CLI / peer | `deepmerge-ts` ≥ 8.0.0 via Prisma          |
| `mysql2`       | `GHSA-3f6p-5ww8-9rcr` | high     | `@noahark/db` → `@prisma/client` → `prisma` → `mysql2`                  | Prisma CLI / peer | `mysql2` ≥ 3.22.0 via Prisma               |
| `fast-uri`     | `GHSA-5jgf-p345-68v8` | high     | `@noahark/db` → `@prisma/client` → `prisma` → `@prisma/dev` → … → `ajv` | Prisma CLI / peer | `fast-uri` ≥ 3.1.6 via Prisma              |
| `fast-uri`     | `GHSA-f65p-4m7j-42xc` | high     | same                                                                    | Prisma CLI / peer | `fast-uri` ≥ 3.1.6 via Prisma              |
| `fast-uri`     | `GHSA-fph4-wmhf-6fwf` | high     | same                                                                    | Prisma CLI / peer | `fast-uri` ≥ 3.1.6 via Prisma              |
| `fast-uri`     | `GHSA-jqff-g426-hqxp` | high     | same                                                                    | Prisma CLI / peer | `fast-uri` ≥ 3.1.6 via Prisma              |
| `mysql2`       | `GHSA-rgwj-5xj2-c3m3` | moderate | `@noahark/db` → `@prisma/client` → `prisma` → `mysql2`                  | Prisma CLI / peer | `mysql2` ≥ 3.23.1 via Prisma               |

### Remaining full-audit extra findings (dev-only; deferred)

- `js-yaml` `GHSA-2883-xcg3-v3hh` (high): `@noahark/web` **devDependency**
  `@apidevtools/swagger-parser`. OpenAPI validation tooling only.
- `vitest` / `@vitest/mocker` `GHSA-82fw-gwwq-j7x9` (moderate): test
  runner, patched ≥ 4.1.11. Vitest remains **4.1.10** in this patch.
- Additional `deepmerge-ts` / `mysql2` / `fast-uri` paths through the
  direct `packages/db` `prisma` CLI dependency (same Prisma 7.9.1 hold).

### Deployment constraints and deferred hardening

Production hosting is constrained to **Linux**. `GHSA-p293-qw3h-jr36` is
Windows-hosted; 16.3.4 is still the required runtime patch because it
also closes the AVIF/image-optimizer advisory and removes the Windows
RCE from the installed Next.js version.

The repository still lacks an enforced deployable production artifact.

Not changed in this patch (security/P2D backlog):

- unrestricted same-origin image optimizer path
- undefined `images.localPatterns`
- middleware not covering `/_next/image`
- no upload MIME allowlist

### Gates actually run

Node **v24.19.0**, pnpm **11.17.0**.

- Prettier check on the three authorised paths
- `git diff --check`
- `pnpm turbo run lint --force` — **16/16** packages
- `pnpm turbo run typecheck --force` — **16/16** packages
- `pnpm turbo run test --force` — **15** packages with a test task:
  `@noahark/core` **23/23**, `@noahark/auth` **42/42**, `@noahark/audit`
  **28/28**, `@noahark/files` **20/20**, `@noahark/authz` **20/20**,
  `@noahark/config` **15/15**, `@noahark/workflow` **19/19**,
  `@noahark/db` **43/43**, `@noahark/custom-fields` **35/35**,
  `@noahark/catalog` **47/47**, `@noahark/crm` **6/6**, `@noahark/jobs`
  **15/15**, `@noahark/web` **64/64**, plus `@noahark/notifications` and
  `@noahark/purchasing` with no unit files (`--passWithNoTests`)
- `pnpm --filter @noahark/web build` — Next.js **16.3.4**; restored
  generated `apps/web/next-env.d.ts` (`.next/dev/types` → `.next/types`
  only)
- Live error-shape files: `partyDomainErrorMapping.test.ts` (P2002),
  `pricingDomainEntry.test.ts` / `pricingDomainConcurrency.test.ts`
  (P2039 / SQLSTATE 23P01), `customFieldDomainErrorMapping.test.ts`
  (SQLSTATE 23514) — **11/11**
- P2C.3 `customFieldDomain*` **29/29** (8 files)
- P2C.2 `pricingDomain*` **14/14** (7 files)
- P2C.1 `catalogDomain*` **18/18** (6 files)
- P2B `partyDomain*` **34/34** (9 files)
- Canonical P2A six-file subset **60/60**
- Named Phase 1 security/audit/concurrency files (not a documented
  canonical five-file subset): `security.test.ts`,
  `temporalSecurityBoundaries.test.ts`, `concurrencyRaces.test.ts`,
  `auditPagination.test.ts`, `rlsPooledConnection.test.ts` — **44/44**
- Full `@noahark/web` integration **471/471** (67 files)
- Phase 1 Playwright E2E `foundation.spec.ts` **18/18**
- OpenAPI validate; `openapi.yaml` and `packages/db/prisma` unchanged

Live `verifyAuditChain(...).valid === true` in the concurrency/audit
suites above; sequences remain gapless.

PostgreSQL **18.4** via `embedded-postgres` on disposable databases
(`SELECT version()` in `customFieldDomainErrorMapping.test.ts`).
PostgreSQL **16.14 NOT RUN (UNVERIFIED)**. No writes to persistent
`noahark`. No migrate, reset, seed or deploy.

This slice remains **uncommitted**.

## 21. P2D.0 — custom-field hardening, catalogue, pagination, files

P2D.0 only. P2D.1–P2D.5 and P2E were not started. No public APIs, OpenAPI
operations, UI, `tenantRoute`, or idempotency keys were added. `schema.prisma`
and migrations `00001`–`00004` were not rewritten.

### T-decisions applied

| ID        | Decision                                                                                                                                                                                                                                                                                                                                                   |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-1 / T-2 | `archiveCatalogItem` / `archivePriceList` remain deferred. No services, APIs, permissions, or ADR-85. Phase-2 catalogue is **63** keys, not 65. `catalog_item:archive` and `price_list:archive` are excluded. Partial-scope RLS cannot prove assignment completeness, so an archive of a shared master would be unsafe without a later completeness proof. |
| T-3       | Tenant-wide grants only in P2D. Entity-scoped-only fail closed — **P2D.1**, not this slice.                                                                                                                                                                                                                                                                |
| T-4       | ADR-79 D-10 kept: assigned readers do not see owner custom-field values.                                                                                                                                                                                                                                                                                   |
| T-5       | Database owner-write floor on `party`, `catalog_item`, and `price_list`.                                                                                                                                                                                                                                                                                   |
| T-6       | Five previously unbounded lists are paginated.                                                                                                                                                                                                                                                                                                             |
| T-7       | `party_contact:email:read` and `party_contact:phone:read` are catalogued. `tenant_admin` receives every catalogue key via `PERMISSION_CATALOG.map`. `member` stays the original nine Phase-1 keys.                                                                                                                                                         |
| T-8       | Production permission-catalogue sync. No DAG reversal (`authz` still does not depend on `db`).                                                                                                                                                                                                                                                             |
| T-9       | Category and UOM stay tenant-wide with no owner column.                                                                                                                                                                                                                                                                                                    |
| T-10      | Later archive APIs must use `POST .../archive`, never DELETE. Not implemented here.                                                                                                                                                                                                                                                                        |
| T-11      | Write limiter is P2D.1.                                                                                                                                                                                                                                                                                                                                    |
| T-12      | Code-declared field policies remain authoritative; `FieldPolicy` table unused.                                                                                                                                                                                                                                                                             |
| T-13      | Image optimizer hardened with a production-runtime probe. Middleware matcher stays `/app/:path*`.                                                                                                                                                                                                                                                          |
| T-14      | Byte-authenticated MIME allowlist. OOXML deferred unless ZIP contents are proven.                                                                                                                                                                                                                                                                          |
| T-15      | Workspace-wide Vitest **4.1.11**. Fourteen package manifests that still pinned 4.1.10 were consolidated in the path-cap cleanup. `@noahark/web` was already 4.1.11 and received no further semantic change. No `pnpm audit --fix`. No Prisma bump.                                                                                                         |

### Permission catalogue (96 keys)

Phase 1 remains 33 keys. Phase 2 adds 63 literal `resource:action` keys
(party 27, catalog 16, pricing 14, custom fields 6). `authorize()` remains
exact `Set.has()` with no wildcards. `SYSTEM_ROLES.TENANT_ADMIN.permissions`
is `PERMISSION_CATALOG.map((p) => p.key)`. `SYSTEM_ROLES.MEMBER.permissions`
is unchanged: `tenant:read`, `legal_entity:read`, `membership:read`,
`role:read`, `settings:read`, `approval:submit`, `approval:read`,
`file:upload`, `file:read`.

### Permission sync

Executable: `apps/web/scripts/syncPermissionCatalogue.ts` (`pnpm --filter
@noahark/web permissions:sync`). Source of truth is `PERMISSION_CATALOG`,
not SQL copies of the 63 keys.

Behaviour: upsert every catalogue row into `permission`; backfill missing
grants onto existing `is_system = true` `tenant_admin` roles only; leave
`member` and custom roles unchanged; return inserted/updated/unchanged
counts; fail visibly; run in one owner-role transaction via
`createSystemClient()` / `DATABASE_MIGRATION_URL`. It does not create demo
tenants or users and does not use `assertSeedIsAllowed` / `ALLOW_DEMO_SEED`.
It is not invoked from ordinary requests.

Concurrency (informational; sync service not redesigned here): two
overlapping sync invocations cannot corrupt or duplicate `permission` or
`role_permission` rows because `permission.key` and
`(role_id, permission_id)` are unique and the work runs in one transaction
that rolls back on error. One racing invocation may still fail visibly
with a unique-constraint conflict (`23505`). Operators should retry the
failed run.

DAG: `authz` → `core` only. `db` already depends on `authz`. Putting sync
inside `authz` would cycle. Authz package-boundary test forbids
`@noahark/db` imports.

Deploy requirement: run the sync after migrate deploy so existing tenants'
`tenant_admin` roles receive Phase-2 keys. New tenants created through
`setupTestTenant` / seed already follow `SYSTEM_ROLES`.

### Migration `20260914000005_p2d0_custom_field_hardening`

Forward-only. Does not rewrite `00001`–`00004`.

**DELETE revoke.** Phase 1 granted `SELECT, INSERT, UPDATE, DELETE` on
`custom_field_value` and `custom_field_definition` to `noahark_app`. P2D.0
revokes `DELETE` from `noahark_app`, `noahark_worker`, and `PUBLIC`. A live
`noahark_app` `DELETE` must fail with SQLSTATE `42501`. No service or API
delete exists.

**Owner-write floor (T-5).** `custom_field_value_target_integrity()` is
replaced so the `party`, `catalog_item`, and `price_list` branches require
`NEW.legal_entity_id = master.owner_legal_entity_id`. The assignment
`OR EXISTS (...)` alternative is removed from those three branches only.
`party_contact` still allows owner **or** assignment (parent party).
Entity-scoped types, demo bypass, typed-value guard, definition
immutability, tenant matching, and the allowlist are unchanged.

Former squatting exploit (closed): an assigned legal entity B could insert
a `custom_field_value` against an A-owned `party` / `catalog_item` /
`price_list` with `legal_entity_id = B` because the trigger treated
assignment as sufficient. That write now fails SQLSTATE `23514`, inserts
no row, and writes no audit event. Owner-A writes via production
`setCustomFieldValue` still succeed. The old trigger is not reinstalled in
any permanent test.

### Pagination (intentional semantic change)

These five services now return `{ items, nextCursor }` ordered by
`(createdAt, id)` ascending, default page size 25 (max 100), invalid
cursor → `VALIDATION_FAILED`. Default is the first page of 25, not all
rows.

- `listContacts`
- `listAddresses`
- `listAssignments`
- `listCatalogItemAssignments`
- `listPriceListAssignments`

`listContacts` previously ordered by `isPrimary desc, createdAt asc`; it
now uses `(createdAt, id)` like the other four.

### Image optimizer

`apps/web/next.config.ts`:

```
images.unoptimized = true
images.localPatterns = []
images.remotePatterns = []
```

Middleware matcher is unchanged (`/app/:path*`). The `/_next/image` route
is **not** claimed removed unless a production probe returns 404 or the
route is absent. Exact probe statuses are recorded under Gates below after
the production-runtime run against Next.js **16.3.4** (`next start`, not
only `next dev`).

### MIME allowlist

25 MiB cap unchanged. `sniffMimeType` never trusts client Content-Type,
filename, or extension. After sniff, `assertAllowedUploadMime` allows only
PDF, PNG, JPEG, GIF, WebP, `text/plain`, and `text/csv`. HTML, SVG, XML,
JavaScript, executables, generic archives, OOXML/ZIP, and unknown bytes
are rejected with the existing `ValidationError`. Contents are not logged.
OOXML remains deferred until ZIP members can prove DOCX/XLSX/PPTX.

Independent Sonnet P2D.0 audit confirmed a **comment-prefixed SVG MIME
bypass**: `<!--x--><svg onload=alert(1)>` was classified as `text/plain`
and accepted because detection used `startsWith("<?xml"|"<svg")` on
`trimStart()` of the original sample and did not skip HTML/XML comments.
That bypass is closed. Download `Content-Type: application/octet-stream`
and `Content-Disposition: attachment` were not changed.

A later focused Sonnet audit returned **FAIL**: the first MIME remediation
applied `deniedTextPayload()` to every buffer, including PDF/PNG/JPEG/GIF/
WebP. Raw HTML/event-handler regexes then matched ordinary binary bytes.
Independent evidence included a `%PDF-1.4` file with `<<...>>` dictionaries
rejected, JPEG/PNG files with legitimate XMP rejected, and 289 of 300
valid random-pixel PNG samples rejected. Tiny header fixtures did not
expose this.

Correction: active-text heuristics run only for `text/plain` and
`text/csv`, against the complete bounded UTF-8 buffer (not the first 4096
bytes). Invalid UTF-8 on that path fails closed. Tag-wide event-handler
regexes were later removed; prose such as `onions = 3` and `online=true`
is accepted because those strings are not markup. `javascript:` is a
linear prefix check. Allowlisted binaries are checked with
narrow structural validators (PDF header + terminal `%%EOF`; PNG chunks
through IEND; JPEG SOI/markers/EOI; GIF through trailer; WebP
RIFF/WEBP length and chunks). Truncation and trailing bytes after a
completed structure are rejected. Filename and client MIME remain
irrelevant. The attachment integration fixture that used signature-plus-
IHDR-only PNG bytes had to be replaced with a complete 1×1 PNG; the
spoofed filename was kept. That extra path is
`apps/web/tests/integration/attachments.test.ts`.

Limitation (narrowed text grammar, fail-closed): arbitrary JavaScript
without markup, a shebang, `import`/`export`, or a `function` declaration
cannot be reliably distinguished from unrestricted plain text. The
classifier does not claim complete JavaScript detection. Comparison prose
such as `n < 10` and `a < b` remains eligible for `text/plain`.

A later focused Sonnet audit again returned **FAIL**. Remaining defects
were quadratic full-buffer tag regexes (`<[a-zA-Z][^>]*?...`) that
blocked the Node event loop (measured ~4.3s at 96 KB, ~12.4s on another
payload, ~17s at 192 KB; `file:upload` is on the default member role);
HTML5 comment-terminator bypasses (`--!>`, `<!-->`, `<!--->`, including
BOM/whitespace and mid-file forms); and a JPEG parser that stopped after
the first SOS, rejecting progressive and multi-scan files. Correction:
a small fixed number of linear O(n) text passes (not one decode-and-scan);
reject `<` immediately followed by an XML NameStart character, `!`, `?`
or `/` (so `<!--` and `<_:svg` are markup and comments are not
stripped); linear `javascript:` prefix check; unsafe C0 other than
TAB/LF/CR fail closed; JPEG marker walk continues after each entropy
scan until EOI; PNG requires exactly one first IHDR of length 13 with
non-zero dimensions, at least one IDAT, IEND length 0; GIF requires at
least one image descriptor. PNG CRCs remain unchecked. These are
framing checks, not complete media decoding.

### Dependency advisories (T-15)

Point-in-time `pnpm audit --prod` / `pnpm audit` **before** this slice
(2026-09-14T14:08:27+08:00):

- prod: **7** findings (0 critical, 6 high, 1 moderate) — Prisma CLI /
  `mysql2` / `fast-uri` / `deepmerge-ts` via Prisma **7.9.1**
- full: **10** findings (0 critical, 7 high, 3 moderate) — plus
  `js-yaml` (`@apidevtools/swagger-parser`) and `vitest` /
  `@vitest/mocker` `GHSA-82fw-gwwq-j7x9`

After the T-15 path-cap cleanup, every workspace `package.json` that
declares Vitest pins **4.1.11**. `pnpm-lock.yaml` resolves only
`vitest@4.1.11` and `@vitest/*@4.1.11` (15 importers). No catalogue or
lockfile entry still pins 4.1.10.

After workspace-wide **4.1.11**:

- prod: **7** findings (0 critical, 6 high, 1 moderate) — unchanged
  Prisma **7.9.1** CLI / `mysql2` / `fast-uri` / `deepmerge-ts`
- full: **8** findings (0 critical, 7 high, 1 moderate) —
  `GHSA-82fw-gwwq-j7x9` dropped with the 4.1.10 tree. Direct `js-yaml`
  via swagger-parser remains.

`@apidevtools/swagger-parser` stays `^12.1.0` unless a smallest
compatible release that drops vulnerable `js-yaml` is confirmed.
Prisma is not bumped. `pnpm audit --fix` is not used.

### SHA-256 of migrations 00001–00004 (before this slice)

```
F050BFB3878EDD524B82B4CBF82BA74AD6287FE7E8F8C97CA279C6915C6FA8AF  20260817000001_init/migration.sql
2FA6C9FCD0428FE84F816BEDD413E47FB7BE66FD3331796F1A8D69DCCEDB78F1  20260817000002_rls_and_constraints/migration.sql
0F0F5F931869168BEE0EAA7F44D5799882DBBED36F871A6864B65621F113367A  20260824000003_parties_catalog/migration.sql
443C6559115CBB359576D4095837AC0FBD54DC56FC417203D8C532768F5ED530  20260824000004_p2a_audit_hardening/migration.sql
```

After hashes and disposable PostgreSQL **18.4** / **16.14** deploys are
recorded under Gates once those commands have been run.

### Remaining risks

- Direct `js-yaml` `^5.3.0` remains for OpenAPI conformance.
  `@apidevtools/swagger-parser@12.1.0` has no `js-yaml` of its own; 13.0.0
  is a major and was not taken.
- Prisma CLI/dev advisories remain on 7.9.1.
- Independent Sonnet P2D.0 audit **initial disposition: FAIL** (comment-
  prefixed SVG MIME bypass, two genuine Prettier defects, system-client
  caller comment). Later focused audits also returned **FAIL** (binary
  text-regex false positives; then quadratic tag regexes, HTML5 comment
  terminators, and progressive JPEG). Remediations are in this working
  tree. A later three-file delta audit passed. **P2D.0 pre-commit
  readiness: YES. P2D.1 readiness: YES.** No HIGH or MEDIUM defect
  remains. P2D.1 implementation has not started.
- Arbitrary JavaScript without markup / shebang / `import`/`export` /
  `function` declaration may still sniff as `text/plain`. Download
  headers remain defense in depth.
- Permission-catalogue sync: a racing second invocation may fail visibly
  with unique-constraint `23505`; data is not duplicated. Not redesigned.
- Sonnet's PostgreSQL execution was blocked by an environmental
  `ECONNRESET`, not a confirmed product defect.
- Current working-tree footprint is **44** paths because structural PNG
  validation required a complete-PNG fixture in
  `apps/web/tests/integration/attachments.test.ts`.
- P2D.1+ and P2E are not started. Independent Sonnet later returned
  P2D.0 pre-commit **YES** and P2D.1 **YES** before this precision
  cleanup; P2D.1 implementation has still not started.

### Gates

Node **v24.19.0**, pnpm **11.17.0**, Prisma **7.9.1**.

00001–00004 SHA-256 **after** this slice (byte-identical to before):

```
F050BFB3878EDD524B82B4CBF82BA74AD6287FE7E8F8C97CA279C6915C6FA8AF  20260817000001_init/migration.sql
2FA6C9FCD0428FE84F816BEDD413E47FB7BE66FD3331796F1A8D69DCCEDB78F1  20260817000002_rls_and_constraints/migration.sql
0F0F5F931869168BEE0EAA7F44D5799882DBBED36F871A6864B65621F113367A  20260824000003_parties_catalog/migration.sql
443C6559115CBB359576D4095837AC0FBD54DC56FC417203D8C532768F5ED530  20260824000004_p2a_audit_hardening/migration.sql
```

- Workspace-wide Vitest **4.1.11** (fourteen manifests 4.1.10 → 4.1.11;
  `@noahark/web` already 4.1.11). Lockfile delta is Vitest specifier /
  resolution only. `pnpm install --frozen-lockfile` succeeded. Repo
  search: no `package.json` or lockfile pin of 4.1.10 remains.
- Prisma format / validate / generate (`schema.prisma` unchanged)
- Prettier on the P2D.0 footprint (SQL has no Prettier parser)
- `git diff --check` on the footprint
- `pnpm turbo run lint --force` — **16/16**
- `pnpm turbo run typecheck --force` — **16/16**
- `pnpm turbo run test --force` — 15 packages with a test task:
  `@noahark/core` **23/23**, `@noahark/auth` **42/42**, `@noahark/audit`
  **28/28**, `@noahark/files` **25/25**, `@noahark/authz` **26/26**,
  `@noahark/config` **15/15**, `@noahark/workflow` **19/19**,
  `@noahark/db` **43/43**, `@noahark/custom-fields` **35/35**,
  `@noahark/catalog` **47/47**, `@noahark/crm` **6/6**, `@noahark/jobs`
  **15/15**, `@noahark/web` **64/64**, plus `@noahark/notifications` and
  `@noahark/purchasing` (`--passWithNoTests`)
- Fresh deploy of 00001–00005 on disposable PostgreSQL **18.4**; second
  deploy idle
- Upgrade deploy: 00001–00004 then 00005 then second deploy, proven in
  `permissionCatalogueSync.test.ts`
- `noahark_app` `DELETE` on custom-field tables → SQLSTATE **42501**
- Assigned-entity insert on `party` / `catalog_item` / `price_list` →
  SQLSTATE **23514**, no row, no audit; owner `setCustomFieldValue` still
  succeeds
- Full `@noahark/web` integration on PostgreSQL **18.4**: **482/482**
  (69 files). Named subsets in that run: P2A six-file **61/61**
  (`customFieldTargetIntegrity` 13), partyDomain **35/35**, catalogDomain
  **19/19**, pricingDomain **15/15**, customFieldDomain **31/31**
- Production build Next.js **16.3.4**; image optimizer probes against
  `next start`: local **404**, remote **404**, query-string local **404**,
  unsupported quality **404**. None returned an optimized image or a
  sign-in redirect. Middleware matcher unchanged. `next-env.d.ts` restored
  to HEAD after the build rewrote `.next/dev/types` → `.next/types`
- Playwright `foundation.spec.ts` **18/18** (Chromium missing in the
  sandbox cache on the first attempt; environmental, then installed)
- OpenAPI validate; `openapi.yaml` byte-identical to HEAD; no new routes
- Live `verifyAuditChain` inside the passing concurrency/audit files
- Relevant concurrency files included once in the 482 (not repeated 5×)
- `pnpm audit --prod` after T-15 cleanup: **7** (0 critical, 6 high, 1
  moderate)
- `pnpm audit` after T-15 cleanup: **8** (0 critical, 7 high, 1 moderate)
- `customFieldDomainErrorMapping.test.ts` environment assertion is now
  `/PostgreSQL (16\.14|18\.4)/`. Error-mapping assertions unchanged.
  File **1/1** on PostgreSQL **18.4** and **1/1** on PostgreSQL **16.14**.
- PostgreSQL **16.14** via `embedded-postgres@16.14.0-beta.17` in TEMP on
  port 55433, then `pg_ctl -m fast` stopped: full `@noahark/web`
  integration **482/482** (69 files). Nothing listening on 55433
  afterward. Cluster default encoding remains WIN1252 (environmental).
- Full `@noahark/web` integration on PostgreSQL **18.4** was not re-run
  in the T-15 cleanup: web was already on Vitest 4.1.11 (**482/482**
  earlier this slice); the workspace-wide runner bump was proven by
  `pnpm turbo run test --force` (all packages **v4.1.11**) plus the
  mapping file **1/1** on 18.4. No unit or mapping regression.
- No writes to persistent `noahark`. No commit, push, or P2D.1.

### Initial gate failures

1. Empty-catalogue sync test expected 63 inserts on a database that also
   lacked Phase-1 keys (received 96). Fixed to insert whatever catalogue
   rows are missing, then prove a second run is idempotent.
2. `assertAllowedUploadMime` accepted empty `text/plain`. Empty buffers
   are now sniffed as `application/octet-stream` and rejected.
3. Authz typecheck: `Set.has` of excluded archive strings vs
   `PermissionKey`. Widened the set to `Set<string>`.
4. Web typecheck: `SYSTEM_ROLES.MEMBER.permissions[0]` possibly undefined.
   Replaced with `PERMISSIONS.TENANT_READ`.
5. ESLint `preserve-caught-error` on the sync wrapper and image-probe
   startup; unused `lastCursor` assignment. Fixed.
6. Playwright **18/18** first run failed because Chromium was not in the
   sandbox cache (`playwright install chromium` then **18/18**).
7. PostgreSQL **16.14** full suite **481/482** because
   `customFieldDomainErrorMapping.test.ts` pinned 18.4 only. Corrected
   in the T-15 path-cap cleanup to `/PostgreSQL (16\.14|18\.4)/` without
   weakening error-mapping assertions; re-run **482/482**.
8. Prettier `--check` on Windows reports CRLF vs LF for
   `packages/crm/package.json`, `packages/purchasing/package.json`,
   `imageOptimizerRuntime.test.ts`, and this document. Package manifests
   were not reformatted (T-15: version pin only). SQL has no Prettier
   parser. `git diff --check` flagged an extra blank line at EOF on this
   document before the cleanup edit.

This slice remains **uncommitted** and **unstaged**.

### Independent Sonnet P2D.0 audit (initial FAIL; remediation in this tree)

Independent Sonnet initial disposition: **FAIL**. P2D.1 was not started.

Confirmed medium: comment-prefixed SVG (`<!--x--><svg onload=alert(1)>`)
bypassed the byte allowlist as `text/plain`. Download
`application/octet-stream` + `attachment` mitigated inline rendering of a
stored file but did not stop the upload. `mimeSniff.ts` now skips BOM,
whitespace, and HTML/XML comments before classification and rejects the
active-content cases listed under MIME allowlist. Adversarial coverage is
in `mimeAllowlist.unit.test.ts`. Filename and client MIME remain
irrelevant.

Confirmed lows:

1. Genuine Prettier defects in
   `apps/web/tests/integration/imageOptimizerRuntime.test.ts` (mis-indented
   `catch` in `beforeAll`) and `docs/PHASE_02_IMPLEMENTATION.md`. A later
   default Prettier `--check` (no `--end-of-line` override) still failed
   on CRLF in `packages/crm/package.json` and
   `packages/purchasing/package.json`. Those two manifests were then
   written with the repository Prettier command so they use LF; the only
   semantic change remains `"vitest": "4.1.10"` → `"vitest": "4.1.11"`.
2. `packages/db/src/systemClient.ts` documentation comment omitted the
   permission-catalogue synchronization command from permitted owner-client
   callers. Comment only; no executable, export, client, or authorization
   change.

Informational: concurrent permission-sync executions cannot corrupt or
duplicate rows (unique constraints + transaction rollback); one racer may
fail visibly with `23505`. Sync service not redesigned.

Sonnet's PostgreSQL run was blocked by environmental `ECONNRESET`, not a
confirmed product defect.

`apps/web/next-env.d.ts` was a Sonnet-generated extra path and was
restored to HEAD. The newly authorised P2D.0 path is
`packages/db/src/systemClient.ts` (comment). After the SVG MIME
remediation the footprint was **43** paths. The focused binary
regression then required one extra existing test path,
`apps/web/tests/integration/attachments.test.ts` (complete 1×1 PNG
fixture; spoofed filename unchanged). Current footprint is **44**
paths. No final Sonnet PASS is claimed. P2D.1 remains not started.

Remediation gates (this pass):

- Default Prettier `--check` on the 43-path footprint (SQL/lockfile
  excluded) initially **exit 1** on CRLF in `packages/crm/package.json`
  and `packages/purchasing/package.json`. Those two files were then
  normalized with `prettier --write` (no `--end-of-line` override). Final
  default Prettier `--check` **exit 0**. `--end-of-line auto` is not the
  final gate.
- `git diff --check` **exit 0**
- `@noahark/files` lint / typecheck **exit 0**
- `pnpm turbo run lint --force` **16/16**
- `pnpm turbo run typecheck --force` **16/16**
- `@noahark/files` unit **37/37** (17 MIME allowlist tests). Adversarial
  MIME file **17/17** × **5** consecutive runs
- `pnpm turbo run test --force` — 15 packages with a test task; files
  **37/37**, authz **26/26**, web unit **64/64**
- File upload/download integration (`attachments` + `signedFileDelivery`)
  **18/18** on disposable PostgreSQL **18.4**
- Full `@noahark/web` integration on PostgreSQL **18.4**: **482/482**
  (69 files), disposable `noahark_test_integration_*`, dropped after
- Full `@noahark/web` integration on PostgreSQL **16.14**
  (`SELECT version()` = `PostgreSQL 16.14, compiled by Visual C++ build
1944, 64-bit`) via `embedded-postgres@16.14.0-beta.17` in TEMP on port
  **55433**: **482/482** (69 files), disposable DB dropped, then
  `pg_ctl -m fast` stop. Nothing listening on **55433** afterward.
  Encoding WIN1252 (environmental). Persistent `noahark` on **55432**
  was not written.
- Production build not re-run: `images.unoptimized` / empty
  `localPatterns` / `remotePatterns` unchanged; download headers
  unchanged. `imageOptimizerRuntime.test.ts` remains `skipIf` without
  `.next/BUILD_ID`.
- OpenAPI validate; `openapi.yaml` git hash identical to HEAD
  (`a49a31ab92759ba6763972cb154b2b47f4436896`); no `apps/web/app` diff
- `pnpm audit --prod`: **7** (0 critical, 6 high, 1 moderate)
- `pnpm audit`: **8** (0 critical, 7 high, 1 moderate)
- Migrations 00001–00004 SHA-256 unchanged; `schema.prisma` unchanged;
  download route still `Content-Type: application/octet-stream` and
  `Content-Disposition: attachment`
- Staging empty. Uncommitted.

Remediation initial failures (preserved):

1. Default Prettier `--check` **exit 1** on CRLF-only
   `packages/crm/package.json` and `packages/purchasing/package.json`.
   Those two manifests were later `prettier --write`'d (LF per committed
   config). Final default Prettier `--check` **exit 0**. `--end-of-line
auto` is not the final gate.
2. Short-signature unit test failed: `file-type` labelled a 4-byte PNG
   magic as `image/png` and the allowlist accepted it. Truncation floor
   added (`MIN_COMPLETE_BYTES`). A 3-byte ASCII `GIF` payload is genuine
   `text/plain` and was removed from that test. Re-run **37/37**.

### Focused Sonnet MIME binary-regression audit (FAIL; this pass)

Independent focused Sonnet audit: **FAIL**. P2D.1 was not started. No
final Sonnet PASS is claimed.

HIGH: `assertAllowedUploadMime` ran `deniedTextPayload()` on every
buffer. PDF dictionaries (`<<...>>`), JPEG/PNG XMP, and 289 of 300
valid random-pixel PNG samples were rejected. Tiny header fixtures did
not expose this. Text heuristics now run only for `text/plain` and
`text/csv` against the complete bounded UTF-8 buffer. Allowlisted
binaries use format-aware structural checks (PDF header + terminal
`%%EOF`; PNG chunks through IEND; JPEG SOI/markers/EOI; GIF through
trailer; WebP RIFF length and chunks). Truncation and trailing bytes
are rejected. Filename and client MIME remain ignored. Contents are
not logged.

LOW A: the event-handler tag regex was removed with the quadratic
scanner. `onions = 3` and `online=true` remain accepted because they
are not markup (`<` followed by a NameStart / `!` / `?` / `/`).

LOW B: accepted text is inspected in full (not the first 4096 bytes).
Invalid UTF-8 on the text path fails closed. Binary formats are not
decoded as text.

LOW: `imageOptimizerRuntime.test.ts` now spawns `process.execPath` plus
the resolved Next CLI with `shell: false`, keeps the server process
handle, and terminates the Windows PID tree (`taskkill /PID /T`, then
`/F` after a graceful deadline). It waits until the selected port is
closed. It does not use `taskkill /IM node.exe`. Production image
configuration was not changed.

Limitation: arbitrary JavaScript without markup, a shebang,
`import`/`export`, or a `function` declaration is outside this
classifier’s reliable scope.

Extra path (required): `apps/web/tests/integration/attachments.test.ts`
used a 29-byte signature-plus-IHDR PNG. Structural PNG validation
correctly rejects that truncation. The fixture is now the same complete
1×1 PNG already used in unit tests; the lying filename is unchanged.

Focused-pass gates:

- Default Prettier `--check` on the P2D.0 footprint (SQL/lockfile
  excluded) **exit 0**. `--end-of-line auto` is not the final gate.
- `git diff --check` **exit 0**
- `pnpm install --frozen-lockfile` **exit 0**
- `@noahark/files` lint / typecheck **exit 0**; `@noahark/web` lint /
  typecheck **exit 0**
- `@noahark/files` unit **46/46** (26 MIME allowlist tests). MIME file
  **26/26** × **5** consecutive runs
- `pnpm turbo run test --force` — 15 packages with a test task,
  including files **46/46** (PostgreSQL 18.4 on 55432 was restarted
  first after an `ECONNREFUSED` on `@noahark/db` provision-roles)
- File upload/download integration (`attachments` + `signedFileDelivery`)
  initially **17/18** on the truncated PNG fixture; after the complete
  1×1 PNG fixture **18/18** on disposable PostgreSQL **18.4**
- Image-optimizer runtime test **1/1** × **5** consecutive runs against
  existing `.next/BUILD_ID`. Server became reachable; all four
  `/_next/image` probes returned **404**; selected port closed after
  every run. No leftover listener attributable to the test.
- Full `@noahark/web` integration on PostgreSQL **18.4**: initially
  **481/482** (truncated PNG fixture), then **482/482** (69 files)
  after the fixture change. Disposable `noahark_test_integration_*`,
  dropped after. Persistent `noahark` was not written.
- Full `@noahark/web` integration on PostgreSQL **16.14**
  (`SELECT version()` = `PostgreSQL 16.14, compiled by Visual C++ build
1944, 64-bit`) via `embedded-postgres@16.14.0-beta.17` in TEMP on
  port **55433**: first run **481/482** (`pricingDomainConcurrency`
  overlap flake, unrelated to MIME). Isolated retry of that file
  **7/7**. Full re-run **482/482** (69 files). Disposable DB dropped,
  then `pg_ctl -m fast` stop. Nothing listening on **55433**
  afterward (`ECONNREFUSED`). Encoding WIN1252 (environmental).
- Production build not re-run: MIME lives in `@noahark/files` runtime
  and does not change the Next image graph. `images.unoptimized` /
  empty `localPatterns` / `remotePatterns` unchanged. Download headers
  unchanged (`application/octet-stream` + `attachment`).
  `apps/web/next-env.d.ts` remains clean vs HEAD.
- OpenAPI validate; `openapi.yaml` git hash identical to HEAD
  (`a49a31ab92759ba6763972cb154b2b47f4436896`); `schema.prisma`
  unchanged; migrations 00001–00004 SHA-256 unchanged
- `pnpm audit --prod`: **7** (0 critical, 6 high, 1 moderate)
- `pnpm audit`: **8** (0 critical, 7 high, 1 moderate)
- Staging empty. Uncommitted. P2D.1 not started.

Focused-pass initial failures (preserved):

1. `files` typecheck TS18048 on JPEG marker/next and GIF block size
   (`noUncheckedIndexedAccess`). Added undefined guards. Re-run
   typecheck **exit 0**.
2. GIF comment fixture used a block size that included the terminator.
   Corrected to `21 FE 04 "noah" 00`.
3. `a < b` classified as `application/xml` because `TAG_ANYWHERE`
   allowed whitespace after `<`. The pattern now requires a tag-like
   character immediately after `<`.
4. ASCII `"GIF89a"` / `"RIFF"` strings were accepted as `text/plain`.
   Truncation tests now use binary slices of real files.
5. `pnpm turbo run test --force` failed `@noahark/db`
   `provision-roles.live.test` with `ECONNREFUSED 127.0.0.1:55432`
   because PostgreSQL 18.4 was down. Restarted
   `packages/db/scripts/embedded-pg.mjs start`; workspace unit then
   **15/15**.
6. Attachment integration and first full PostgreSQL **18.4** suite
   **481/482**: `attachments.test.ts` still uploaded a truncated PNG.
   Extra path updated to a complete 1×1 PNG. Re-run attachments
   **18/18**, full 18.4 **482/482**.
7. First PostgreSQL **16.14** full suite **481/482** on
   `pricingDomainConcurrency` (`A price for this item already covers
part of that period`). MIME-unrelated flake. Isolated retry **7/7**;
   full re-run **482/482**.
8. Default Prettier `--check` **exit 1** on
   `docs/PHASE_02_IMPLEMENTATION.md` after the focused-pass §21
   append (wrap). `prettier --write` (no `--end-of-line` override)
   then default `--check` **exit 0**.

### Focused Sonnet MIME linearity / JPEG audit (FAIL; this pass)

Independent focused Sonnet audit: **FAIL**. The original binary
false-positive HIGH is closed. P2D.1 was not started. No final Sonnet
PASS is claimed.

HIGH: `EVENT_HANDLER_IN_TAG` and `JAVASCRIPT_ATTR` used
`<[a-zA-Z][^>]*?...` against the full 25 MiB-capped buffer. Independent
reproduction: ~4.3s at 96 KB, ~12.4s on another payload, ~17s at 192 KB,
approximately quadratic. `file:upload` is available to the default
member role, so this blocked the single Node event loop for every
tenant. Unbounded tag regexes and HTML/XML comment stripping are
removed. Accepted text is decoded with UTF-8 fatal and inspected with
a small fixed number of linear O(n) passes. A `<` immediately followed
by an XML NameStart character, `!`, `?` or `/` is rejected, including
comment openers and namespace-prefixed names. Comparison prose
(`a < b`, `Cost is < 10 SGD`) remains accepted. `javascript:` is a
linear prefix check. Unsafe C0 other than TAB/LF/CR fails closed.

MEDIUM: HTML5 comment-terminator bypasses
(`<!--c--!><svg...>`, `<!-->`, `<!--->`, BOM/whitespace and mid-file
forms) were accepted because comment stripping used `-->` only. The
linear markup-start rule rejects `<!--` immediately, so comment-closing
interpretation is irrelevant. Permanent tests cover those variants.

MEDIUM: the JPEG parser stopped after the first SOS (`return false` /
outer `break`), so 100/100 progressive JPEGs and mozjpeg/optimiseScans
output were rejected. It now returns to marker parsing after each
entropy-coded scan, honours `0xFF00` stuffing, restart markers
`0xFFD0–0xFFD7`, and fill `0xFF` bytes, requires EOI, and rejects
truncation, invalid lengths, trailing bytes and concatenated second
images. Baseline, progressive, multi-scan, EXIF, XMP, ICC and COM
are accepted. It does not search for the first `FFD9`.

LOW: PNG now requires exactly one first IHDR of length 13, non-zero
width/height, at least one IDAT, IEND length 0, and no bytes after
IEND. Duplicate IHDR is rejected. Chunk CRC values are **not**
verified. GIF requires at least one image descriptor; colour tables,
extensions and sub-blocks remain traversed. WebP/PDF framing checks
are unchanged and still reject trailing payloads. These are bounded
structural/framing checks, not complete media decoding.

LOW: image-optimizer cleanup checks `exitCode === null` and
`signalCode === null` before `taskkill /PID /T` of the spawned child
only. Never `/IM node.exe`.

Orphan `next start` processes from pre-fix test runs were re-queried
before stop. All six reported PIDs were still present and verified as
NoahArk `next start` on 127.0.0.1 ports 56913 / 49747 / 58755 (not a
developer `next dev`, not PostgreSQL 55432):

- 36076 (pnpm wrapper) / 9456 (`next` CLI) — port 56913
- 6556 / 34032 — port 49747
- 32640 / 29868 — port 58755

Those exact trees were stopped with `taskkill /PID /T /F`. Duplicate
child `/PID` calls then reported not found because `/T` had already
reaped them. Ports 56913 / 49747 / 58755 were closed afterward.
PostgreSQL 18.4 on 55432 remained listening.

Footprint remains **44** paths. `attachments.test.ts` was not further
modified.

Linearity / JPEG-pass gates:

- Default Prettier `--check` on the P2D.0 footprint (SQL/lockfile
  excluded) initially **exit 1** on `mimeSniff.ts` and
  `mimeAllowlist.unit.test.ts` (wrap). `prettier --write` then
  default `--check` **exit 0**. `--end-of-line auto` is not the final
  gate.
- `git diff --check` **exit 0**
- `pnpm install --frozen-lockfile` **exit 0**
- `@noahark/files` lint / typecheck **exit 0**; `@noahark/web` lint /
  typecheck **exit 0**
- `@noahark/files` unit **53/53** (33 MIME allowlist tests). MIME file
  **33/33** × **5** consecutive runs
- External linearity (same incomplete-tag shapes): 96 KB **3.1 ms**,
  192 KB **1.1 ms**, 1 MB **4.1 ms**; all `ValidationError`
- External binaries: **300/300** valid random-pixel PNGs; baseline,
  progressive and multi-scan JPEG; EXIF/XMP/ICC JPEG; PNG iTXt;
  GIF comment; static and animated WebP; PDF dictionaries/XMP
- `pnpm turbo run test --force` — 15 packages, files **53/53**
- File upload/download integration **18/18** on disposable PostgreSQL
  **18.4**
- Image-optimizer runtime **1/1** × **5**; `/_next/image` probes
  **404**; selected port closed after every run
- Full `@noahark/web` integration on PostgreSQL **18.4**: **482/482**
  (69 files). Disposable DB dropped. Persistent `noahark` not written.
- PostgreSQL **16.14** was not re-run (no database code in this pass).
  Previously verified **482/482**. Port **55433** remains closed.
- Production build not re-run: MIME is `@noahark/files` runtime; Next
  image graph and download headers unchanged. `next-env.d.ts` clean.
- OpenAPI validate; `openapi.yaml` hash identical to HEAD
  (`a49a31ab92759ba6763972cb154b2b47f4436896`); `schema.prisma`
  unchanged; migrations 00001–00004 SHA-256 unchanged
- `pnpm audit --prod`: **7** (0 critical, 6 high, 1 moderate)
- `pnpm audit`: **8** (0 critical, 7 high, 1 moderate)
- Staging empty. Uncommitted. P2D.1 not started.

Linearity / JPEG-pass initial failures (preserved):

1. C0-control test expected `text/csv` for a TAB-delimited sample
   with no comma. Fixture corrected to a CSV that also contains TAB,
   LF and CR. Re-run MIME **33/33**.
2. Default Prettier `--check` **exit 1** on `mimeSniff.ts` and
   `mimeAllowlist.unit.test.ts`. `prettier --write` then **exit 0**.
3. First orphan `taskkill` loop used PowerShell `$PID` (reserved).
   Re-issued as explicit `/PID` values after command-line verification.

### Focused Sonnet LOW precision cleanup (namespace-prefixed markup)

Independent Sonnet, after the linearity/JPEG pass, returned **P2D.0
pre-commit YES** and **P2D.1 YES**, with no HIGH or MEDIUM findings.
The subsequent namespace-prefixed markup cleanup was then
independently re-audited as a three-file delta.

LOW: `<_:svg xmlns:_="http://www.w3.org/2000/svg" onload="alert(1)"/>`
was accepted as `text/plain` because markup-start allowed only ASCII
letters, `!`, `?` and `/`. The linear scanner now also rejects `_`,
`:`, and non-ASCII XML 1.0 NameStart characters after `<`, including
supplementary-plane pairs in `U+10000`–`U+EFFFF`. Comparison prose
(`a < b`, `Cost is < 10 SGD`, `2 < 3`) remains accepted. Regex-based
comment stripping and wildcard tag regexes were not restored. Binary
validators are unchanged. PNG CRCs remain unchecked.

A permanent unit test forces a complete-buffer scan of a >512 KiB
benign comparison-prose payload (many `<` followed by space) with a 5 s
timeout so an accidental return to quadratic scanning would fail, without
a sub-millisecond assertion.

Decoding/scanning uses a small fixed number of linear passes over the
bounded buffer. Total complexity remains O(n), not a single
decode-and-scan.

Accepted deferred LOW risks until P2D.1:

- approximately 0.7–1.0 seconds of synchronous processing for a
  maximum-size 24–25 MiB text upload, until the P2D.1 write limiter;
- `permissionCatalogueSync.test.ts` temporarily parking migration 00005
  remains a test-harness hard-kill hazard and is deferred. The test was
  not modified.

Precision-cleanup gates:

- Default Prettier `--check` on the P2D.0 footprint **exit 0**
- `git diff --check` **exit 0**
- `@noahark/files` lint / typecheck **exit 0**
- `@noahark/files` unit **56/56** (36 MIME allowlist tests). MIME file
  **36/36** × **5**
- External namespace-prefixed SVG probes rejected (`_:svg`, `x:svg`,
  `_foo`, `:bar`, Greek NameStart). Comparison prose accepted. 1 MiB
  benign full-scan **67.1 ms**. Progressive JPEG, PNG and PDF
  dictionaries still accepted.
- OpenAPI hash identical to HEAD
  (`a49a31ab92759ba6763972cb154b2b47f4436896`); `schema.prisma`
  unchanged. Staging empty. Footprint **44** paths.
- No database or full integration re-run at cleanup time. P2D.1 not
  started.

Final independent Sonnet three-file delta audit: **passed**. P2D.0
pre-commit readiness: **YES**. P2D.1 readiness: **YES**. No HIGH or
MEDIUM defect remains. Namespace/Unicode differential sweep tested
**1,112,032** code points with **zero** mismatches. Named-payload
matrix **79/79**. Files unit **56/56**. MIME test **36/36** on five
consecutive runs. Previously verified PostgreSQL **18.4** integration
remains **482/482**. Previously verified PostgreSQL **16.14**
integration remains **482/482**. Accepted LOW risks remain: ~0.7–1.0 s
synchronous CPU for a maximum-size text upload pending the P2D.1 write
limiter; `permissionCatalogueSync.test.ts` temporarily parks migration
00005 and could leave it displaced after a hard kill; PNG CRC
validation remains out of scope. P2D.1 has not started.
