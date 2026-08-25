-- ---------------------------------------------------------------------------
-- P2A independent-audit remediation (ADR-73).
--
-- Independent Sonnet audit of Phase 2A returned FAIL. This additive
-- migration closes the blocking findings without rewriting migrations 1-3
-- (already applied to local verification databases):
--
--   F-1 HIGH  shared-master cross-entity mutation (assignment USING +
--             tenant-only WITH CHECK let entity B UPDATE a master it
--             could merely read)
--   F-2 HIGH  INSERT/UPDATE RLS was not proven (SELECT-only tests)
--   F-3 MED   custom-field auth denylist bypassable by whitespace and
--             unenumerated names; the migration-3 comment that targeting
--             was "absolute" was false
--   F-4 MED   shared-master mutation ownership was undocumented
--   F-6 HIGH  CustomFieldValue polymorphic target was unenforced
--
-- F-5 (identifier-based monetary-float guard) is documented and tightened
-- in tests, not in this SQL. Schema-level NUMERIC remains load-bearing.
--
-- Bootstrap contract CHANGE (documented, not silent):
--   Was: "invisible orphan" — INSERT allowed, USING hid the row from
--        everyone including the creator until the first assignment.
--   Now: "owner-visible unassigned master pending atomic assignment" —
--        INSERT requires ownerLegalEntityId in app.legal_entity_ids;
--        the owner may SELECT the new master immediately; assigned
--        non-owners still cannot see it until assigned; P2B must still
--        create master + first assignment atomically so a failed
--        transaction rolls both back. No client-supplied owner id can
--        bypass the server-derived legal-entity context (WITH CHECK).
--
-- Squashing 00003+00004 into one migration would be possible on a never-
-- deployed greenfield repository. It is NOT done here: 00003 is already
-- applied to local verification databases and rewriting it would drift
-- checksums. Migrations 1-3 remain byte-identical to their pre-remediation
-- state.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. Shared-master owner legal entity
-- ===========================================================================

-- 1a. Add nullable owner columns. Backfill is deterministic: a master with
--     exactly one legal-entity assignment takes that assignment's entity as
--     owner. Zero or multiple assignments cannot infer a single owner
--     without guessing, so the migration fails with the offending ids
--     rather than picking one.
ALTER TABLE "party" ADD COLUMN "owner_legal_entity_id" TEXT;
ALTER TABLE "catalog_item" ADD COLUMN "owner_legal_entity_id" TEXT;
ALTER TABLE "price_list" ADD COLUMN "owner_legal_entity_id" TEXT;

DO $$
DECLARE
  ambiguous TEXT;
  orphan TEXT;
BEGIN
  -- party
  SELECT string_agg(p.id, ', ' ORDER BY p.id) INTO ambiguous
    FROM "party" p
   WHERE (SELECT count(*) FROM "party_legal_entity_assignment" a WHERE a."party_id" = p."id") > 1;
  IF ambiguous IS NOT NULL THEN
    RAISE EXCEPTION
      'p2a_audit_hardening: cannot infer party.owner_legal_entity_id for multi-assigned parties (%). Collapse to a single assignment before applying this migration.',
      ambiguous;
  END IF;
  SELECT string_agg(p.id, ', ' ORDER BY p.id) INTO orphan
    FROM "party" p
   WHERE NOT EXISTS (SELECT 1 FROM "party_legal_entity_assignment" a WHERE a."party_id" = p."id");
  IF orphan IS NOT NULL THEN
    RAISE EXCEPTION
      'p2a_audit_hardening: cannot infer party.owner_legal_entity_id for unassigned parties (%). Assign each master to exactly one legal entity before applying this migration.',
      orphan;
  END IF;
  UPDATE "party" p
     SET "owner_legal_entity_id" = a."legal_entity_id"
    FROM "party_legal_entity_assignment" a
   WHERE a."party_id" = p."id";

  -- catalog_item
  ambiguous := NULL;
  orphan := NULL;
  SELECT string_agg(i.id, ', ' ORDER BY i.id) INTO ambiguous
    FROM "catalog_item" i
   WHERE (SELECT count(*) FROM "catalog_item_legal_entity_assignment" a WHERE a."catalog_item_id" = i."id") > 1;
  IF ambiguous IS NOT NULL THEN
    RAISE EXCEPTION
      'p2a_audit_hardening: cannot infer catalog_item.owner_legal_entity_id for multi-assigned items (%). Collapse to a single assignment before applying this migration.',
      ambiguous;
  END IF;
  SELECT string_agg(i.id, ', ' ORDER BY i.id) INTO orphan
    FROM "catalog_item" i
   WHERE NOT EXISTS (SELECT 1 FROM "catalog_item_legal_entity_assignment" a WHERE a."catalog_item_id" = i."id");
  IF orphan IS NOT NULL THEN
    RAISE EXCEPTION
      'p2a_audit_hardening: cannot infer catalog_item.owner_legal_entity_id for unassigned items (%). Assign each master to exactly one legal entity before applying this migration.',
      orphan;
  END IF;
  UPDATE "catalog_item" i
     SET "owner_legal_entity_id" = a."legal_entity_id"
    FROM "catalog_item_legal_entity_assignment" a
   WHERE a."catalog_item_id" = i."id";

  -- price_list
  ambiguous := NULL;
  orphan := NULL;
  SELECT string_agg(l.id, ', ' ORDER BY l.id) INTO ambiguous
    FROM "price_list" l
   WHERE (SELECT count(*) FROM "price_list_legal_entity_assignment" a WHERE a."price_list_id" = l."id") > 1;
  IF ambiguous IS NOT NULL THEN
    RAISE EXCEPTION
      'p2a_audit_hardening: cannot infer price_list.owner_legal_entity_id for multi-assigned lists (%). Collapse to a single assignment before applying this migration.',
      ambiguous;
  END IF;
  SELECT string_agg(l.id, ', ' ORDER BY l.id) INTO orphan
    FROM "price_list" l
   WHERE NOT EXISTS (SELECT 1 FROM "price_list_legal_entity_assignment" a WHERE a."price_list_id" = l."id");
  IF orphan IS NOT NULL THEN
    RAISE EXCEPTION
      'p2a_audit_hardening: cannot infer price_list.owner_legal_entity_id for unassigned lists (%). Assign each master to exactly one legal entity before applying this migration.',
      orphan;
  END IF;
  UPDATE "price_list" l
     SET "owner_legal_entity_id" = a."legal_entity_id"
    FROM "price_list_legal_entity_assignment" a
   WHERE a."price_list_id" = l."id";
END
$$;

ALTER TABLE "party" ALTER COLUMN "owner_legal_entity_id" SET NOT NULL;
ALTER TABLE "catalog_item" ALTER COLUMN "owner_legal_entity_id" SET NOT NULL;
ALTER TABLE "price_list" ALTER COLUMN "owner_legal_entity_id" SET NOT NULL;

CREATE INDEX "party_tenant_id_owner_legal_entity_id_idx"
  ON "party"("tenant_id", "owner_legal_entity_id");
CREATE INDEX "catalog_item_tenant_id_owner_legal_entity_id_idx"
  ON "catalog_item"("tenant_id", "owner_legal_entity_id");
CREATE INDEX "price_list_tenant_id_owner_legal_entity_id_idx"
  ON "price_list"("tenant_id", "owner_legal_entity_id");

-- Composite FKs: tenant_id + owner_legal_entity_id must identify a real
-- LegalEntity of the SAME tenant. ON DELETE NO ACTION: a standalone
-- legal-entity DELETE is rejected while it still owns masters (checked at
-- statement end). Owner deactivation (status) never deletes the master.
-- Tenant-level CASCADE still tears down the tenant's masters in the same
-- statement, so test-fixture cleanup is not blocked. RESTRICT would race
-- the tenant cascade order. Ownership transfer is explicit (P2B will
-- permission-gate and audit it).
ALTER TABLE "party"
  ADD CONSTRAINT "party_owner_legal_entity_id_tenant_id_fkey"
  FOREIGN KEY ("owner_legal_entity_id", "tenant_id")
  REFERENCES "legal_entity"("id", "tenant_id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "catalog_item"
  ADD CONSTRAINT "catalog_item_owner_legal_entity_id_tenant_id_fkey"
  FOREIGN KEY ("owner_legal_entity_id", "tenant_id")
  REFERENCES "legal_entity"("id", "tenant_id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "price_list"
  ADD CONSTRAINT "price_list_owner_legal_entity_id_tenant_id_fkey"
  FOREIGN KEY ("owner_legal_entity_id", "tenant_id")
  REFERENCES "legal_entity"("id", "tenant_id")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- ===========================================================================
-- 2. Shared-master RLS — owner mutation boundary (F-1)
--
-- Separate command policies. A single USING (owner OR assignment) plus
-- WITH CHECK (owner) is not enough: PostgreSQL applies USING to the
-- existing UPDATE row, so an assigned non-owner would pass USING and could
-- steal ownership by setting owner_legal_entity_id to themselves.
--
--   SELECT  tenant + (owner in context OR assignment visible)
--   INSERT  tenant + resulting owner in context
--   UPDATE  USING:  tenant + current owner in context
--           CHECK:  tenant + resulting owner in context
--                   (transfer therefore requires A+B in the same context)
--   DELETE  no grant, no policy
--   Worker  still has no grant on any Phase 2 table
-- ===========================================================================

DROP POLICY IF EXISTS tenant_and_assignment_isolation ON "party";
DROP POLICY IF EXISTS tenant_and_assignment_isolation ON "catalog_item";
DROP POLICY IF EXISTS tenant_and_assignment_isolation ON "price_list";
DROP POLICY IF EXISTS tenant_and_assignment_isolation ON "party_contact";
DROP POLICY IF EXISTS tenant_and_assignment_isolation ON "party_address";

-- ---- party ---------------------------------------------------------------
CREATE POLICY shared_master_select ON "party"
  FOR SELECT
  USING (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND (
      "owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
      OR EXISTS (
        SELECT 1 FROM "party_legal_entity_assignment" a
         WHERE a."party_id" = "party"."id"
           AND a."legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
      )
    )
  );

CREATE POLICY shared_master_insert ON "party"
  FOR INSERT
  WITH CHECK (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND "owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
  );

CREATE POLICY shared_master_update ON "party"
  FOR UPDATE
  USING (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND "owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
  )
  WITH CHECK (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND "owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
  );

-- ---- catalog_item --------------------------------------------------------
CREATE POLICY shared_master_select ON "catalog_item"
  FOR SELECT
  USING (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND (
      "owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
      OR EXISTS (
        SELECT 1 FROM "catalog_item_legal_entity_assignment" a
         WHERE a."catalog_item_id" = "catalog_item"."id"
           AND a."legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
      )
    )
  );

CREATE POLICY shared_master_insert ON "catalog_item"
  FOR INSERT
  WITH CHECK (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND "owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
  );

CREATE POLICY shared_master_update ON "catalog_item"
  FOR UPDATE
  USING (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND "owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
  )
  WITH CHECK (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND "owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
  );

-- ---- price_list ----------------------------------------------------------
CREATE POLICY shared_master_select ON "price_list"
  FOR SELECT
  USING (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND (
      "owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
      OR EXISTS (
        SELECT 1 FROM "price_list_legal_entity_assignment" a
         WHERE a."price_list_id" = "price_list"."id"
           AND a."legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
      )
    )
  );

CREATE POLICY shared_master_insert ON "price_list"
  FOR INSERT
  WITH CHECK (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND "owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
  );

CREATE POLICY shared_master_update ON "price_list"
  FOR UPDATE
  USING (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND "owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
  )
  WITH CHECK (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND "owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
  );

-- ---- party_contact / party_address (shared children) ---------------------
-- SELECT follows Party visibility (owner OR assignment).
-- INSERT/UPDATE require access to Party.owner_legal_entity_id.
-- Assignment-only readers cannot mutate shared contacts or addresses.
-- No other shared child table exists (catalog/price children are
-- entity-scoped via their own legal_entity_id).

CREATE POLICY shared_child_select ON "party_contact"
  FOR SELECT
  USING (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "party" p
       WHERE p."id" = "party_contact"."party_id"
         AND p."tenant_id" = "party_contact"."tenant_id"
         AND (
           p."owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
           OR EXISTS (
             SELECT 1 FROM "party_legal_entity_assignment" a
              WHERE a."party_id" = p."id"
                AND a."legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
           )
         )
    )
  );

CREATE POLICY shared_child_insert ON "party_contact"
  FOR INSERT
  WITH CHECK (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "party" p
       WHERE p."id" = "party_contact"."party_id"
         AND p."tenant_id" = "party_contact"."tenant_id"
         AND p."owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
    )
  );

CREATE POLICY shared_child_update ON "party_contact"
  FOR UPDATE
  USING (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "party" p
       WHERE p."id" = "party_contact"."party_id"
         AND p."tenant_id" = "party_contact"."tenant_id"
         AND p."owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
    )
  )
  WITH CHECK (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "party" p
       WHERE p."id" = "party_contact"."party_id"
         AND p."tenant_id" = "party_contact"."tenant_id"
         AND p."owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
    )
  );

CREATE POLICY shared_child_select ON "party_address"
  FOR SELECT
  USING (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "party" p
       WHERE p."id" = "party_address"."party_id"
         AND p."tenant_id" = "party_address"."tenant_id"
         AND (
           p."owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
           OR EXISTS (
             SELECT 1 FROM "party_legal_entity_assignment" a
              WHERE a."party_id" = p."id"
                AND a."legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
           )
         )
    )
  );

CREATE POLICY shared_child_insert ON "party_address"
  FOR INSERT
  WITH CHECK (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "party" p
       WHERE p."id" = "party_address"."party_id"
         AND p."tenant_id" = "party_address"."tenant_id"
         AND p."owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
    )
  );

CREATE POLICY shared_child_update ON "party_address"
  FOR UPDATE
  USING (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "party" p
       WHERE p."id" = "party_address"."party_id"
         AND p."tenant_id" = "party_address"."tenant_id"
         AND p."owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
    )
  )
  WITH CHECK (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "party" p
       WHERE p."id" = "party_address"."party_id"
         AND p."tenant_id" = "party_address"."tenant_id"
         AND p."owner_legal_entity_id" = ANY (string_to_array(current_setting('app.legal_entity_ids', true), ','))
    )
  );

-- No DELETE grant is issued. Existing SELECT/INSERT/UPDATE grants on
-- noahark_app stand. noahark_worker remains un-granted on every Phase 2
-- table (no new GRANT in this migration).

-- ===========================================================================
-- 3. Custom-field fail-closed allowlist (F-3) and target integrity (F-6)
--
-- Enumerated entityType uses before this change:
--   production / seed: none (models only; Phase 1 comment was "no business
--     entities to attach to yet")
--   tests: party, catalog_item, demo_approval_subject
--   P2A schema/docs: party, party_contact, party_address, catalog_item,
--     price_list
--
-- Allowlist (canonical lowercase snake_case, exact match, must equal its
-- trimmed form). Auth/security names are rejected because they are ABSENT,
-- not because every possible name was predicted. party_address is NOT
-- included — no demonstrated custom-field requirement. price_list_entry,
-- catalog_category and unit_of_measure are likewise excluded.
--
--   Phase 2: party, party_contact, party_legal_entity_assignment,
--            customer_role, vendor_role, catalog_item,
--            catalog_item_legal_entity_assignment, price_list,
--            price_list_legal_entity_assignment
--   Legacy:  demo_approval_subject (JSON storage, no parent-table proof;
--            must not masquerade as a Phase 2 typed target)
-- ===========================================================================

ALTER TABLE "custom_field_definition"
  DROP CONSTRAINT IF EXISTS "custom_field_definition_no_auth_target_check";
ALTER TABLE "custom_field_value"
  DROP CONSTRAINT IF EXISTS "custom_field_value_no_auth_target_check";

ALTER TABLE "custom_field_definition"
  ADD CONSTRAINT "custom_field_definition_entity_type_allowlist_check"
  CHECK (
    "entity_type" = btrim("entity_type")
    AND "entity_type" IN (
      'party',
      'party_contact',
      'party_legal_entity_assignment',
      'customer_role',
      'vendor_role',
      'catalog_item',
      'catalog_item_legal_entity_assignment',
      'price_list',
      'price_list_legal_entity_assignment',
      'demo_approval_subject'
    )
  );

ALTER TABLE "custom_field_value"
  ADD CONSTRAINT "custom_field_value_entity_type_allowlist_check"
  CHECK (
    "entity_type" = btrim("entity_type")
    AND "entity_type" IN (
      'party',
      'party_contact',
      'party_legal_entity_assignment',
      'customer_role',
      'vendor_role',
      'catalog_item',
      'catalog_item_legal_entity_assignment',
      'price_list',
      'price_list_legal_entity_assignment',
      'demo_approval_subject'
    )
  );

-- Expand Phase 2 typed-storage requirement to every allowlisted Phase 2
-- type (not the legacy target). party_address is no longer a Phase 2
-- custom-field target.
ALTER TABLE "custom_field_value"
  DROP CONSTRAINT IF EXISTS "custom_field_value_phase2_typed_check";

ALTER TABLE "custom_field_value"
  ADD CONSTRAINT "custom_field_value_phase2_typed_check"
  CHECK (
    "entity_type" = 'demo_approval_subject'
    OR (
      "legal_entity_id" IS NOT NULL
      AND "value" IS NULL
      AND (
        ("value_text"    IS NOT NULL)::int +
        ("value_integer" IS NOT NULL)::int +
        ("value_decimal" IS NOT NULL)::int +
        ("value_boolean" IS NOT NULL)::int +
        ("value_date"    IS NOT NULL)::int +
        ("value_option"  IS NOT NULL)::int
      ) = 1
    )
  );

-- Typed-column / dataType agreement. Phase 2 types only; legacy
-- demo_approval_subject keeps untyped JSON. Inactive definitions reject
-- NEW values of every type.
CREATE OR REPLACE FUNCTION custom_field_value_typed_guard() RETURNS trigger AS $$
DECLARE
  def_type    "CustomFieldDataType";
  def_active  BOOLEAN;
  def_tenant  TEXT;
  def_entity  TEXT;
  is_phase2   BOOLEAN;
BEGIN
  is_phase2 := NEW."entity_type" IN (
    'party',
    'party_contact',
    'party_legal_entity_assignment',
    'customer_role',
    'vendor_role',
    'catalog_item',
    'catalog_item_legal_entity_assignment',
    'price_list',
    'price_list_legal_entity_assignment'
  );

  SELECT d."data_type", d."is_active", d."tenant_id", d."entity_type"
    INTO def_type, def_active, def_tenant, def_entity
    FROM "custom_field_definition" d
   WHERE d."id" = NEW."definition_id";

  IF def_type IS NULL THEN
    RAISE EXCEPTION 'custom field definition % not found', NEW."definition_id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF def_tenant IS DISTINCT FROM NEW."tenant_id" THEN
    RAISE EXCEPTION 'custom field value tenant does not match its definition'
      USING ERRCODE = 'check_violation';
  END IF;

  IF def_entity IS DISTINCT FROM NEW."entity_type" THEN
    RAISE EXCEPTION 'custom field value entity_type does not match its definition'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT def_active THEN
    RAISE EXCEPTION 'custom field definition % is inactive', NEW."definition_id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT is_phase2 THEN
    RETURN NEW; -- legacy demo_approval_subject: untyped JSON permitted
  END IF;

  IF NOT (
    (def_type = 'STRING'        AND NEW."value_text"    IS NOT NULL) OR
    (def_type = 'INTEGER'       AND NEW."value_integer" IS NOT NULL) OR
    (def_type = 'DECIMAL'       AND NEW."value_decimal" IS NOT NULL) OR
    (def_type = 'BOOLEAN'       AND NEW."value_boolean" IS NOT NULL) OR
    (def_type = 'DATE'          AND NEW."value_date"    IS NOT NULL) OR
    (def_type = 'SINGLE_SELECT' AND NEW."value_option"  IS NOT NULL)
  ) THEN
    RAISE EXCEPTION
      'custom field value does not match definition data type % (NUMBER and MULTI_SELECT are not valid Phase 2 types)',
      def_type USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Polymorphic target integrity. Explicit CASE over the allowlist — never
-- dynamic SQL on untrusted entity_type. A Phase 2 value must identify a
-- real row of the stated type that belongs to the same tenant and is
-- visible to the stated legal entity (owned by it or assigned to it).
-- demo_approval_subject is legacy-only: its parent is not proven here and
-- this function must not claim referential enforcement for it.
CREATE OR REPLACE FUNCTION custom_field_value_target_integrity() RETURNS trigger AS $$
DECLARE
  ok BOOLEAN := FALSE;
BEGIN
  IF NEW."entity_type" = 'demo_approval_subject' THEN
    RETURN NEW;
  END IF;

  IF NEW."legal_entity_id" IS NULL THEN
    RAISE EXCEPTION 'Phase 2 custom field value requires legal_entity_id'
      USING ERRCODE = 'check_violation';
  END IF;

  CASE NEW."entity_type"
    WHEN 'party' THEN
      SELECT EXISTS (
        SELECT 1 FROM "party" p
         WHERE p."id" = NEW."entity_id"
           AND p."tenant_id" = NEW."tenant_id"
           AND (
             p."owner_legal_entity_id" = NEW."legal_entity_id"
             OR EXISTS (
               SELECT 1 FROM "party_legal_entity_assignment" a
                WHERE a."party_id" = p."id"
                  AND a."tenant_id" = p."tenant_id"
                  AND a."legal_entity_id" = NEW."legal_entity_id"
             )
           )
      ) INTO ok;

    WHEN 'party_contact' THEN
      SELECT EXISTS (
        SELECT 1 FROM "party_contact" c
         JOIN "party" p ON p."id" = c."party_id" AND p."tenant_id" = c."tenant_id"
         WHERE c."id" = NEW."entity_id"
           AND c."tenant_id" = NEW."tenant_id"
           AND (
             p."owner_legal_entity_id" = NEW."legal_entity_id"
             OR EXISTS (
               SELECT 1 FROM "party_legal_entity_assignment" a
                WHERE a."party_id" = p."id"
                  AND a."tenant_id" = p."tenant_id"
                  AND a."legal_entity_id" = NEW."legal_entity_id"
             )
           )
      ) INTO ok;

    WHEN 'party_legal_entity_assignment' THEN
      SELECT EXISTS (
        SELECT 1 FROM "party_legal_entity_assignment" a
         WHERE a."id" = NEW."entity_id"
           AND a."tenant_id" = NEW."tenant_id"
           AND a."legal_entity_id" = NEW."legal_entity_id"
      ) INTO ok;

    WHEN 'customer_role' THEN
      SELECT EXISTS (
        SELECT 1 FROM "customer_role" r
         WHERE r."id" = NEW."entity_id"
           AND r."tenant_id" = NEW."tenant_id"
           AND r."legal_entity_id" = NEW."legal_entity_id"
      ) INTO ok;

    WHEN 'vendor_role' THEN
      SELECT EXISTS (
        SELECT 1 FROM "vendor_role" r
         WHERE r."id" = NEW."entity_id"
           AND r."tenant_id" = NEW."tenant_id"
           AND r."legal_entity_id" = NEW."legal_entity_id"
      ) INTO ok;

    WHEN 'catalog_item' THEN
      SELECT EXISTS (
        SELECT 1 FROM "catalog_item" i
         WHERE i."id" = NEW."entity_id"
           AND i."tenant_id" = NEW."tenant_id"
           AND (
             i."owner_legal_entity_id" = NEW."legal_entity_id"
             OR EXISTS (
               SELECT 1 FROM "catalog_item_legal_entity_assignment" a
                WHERE a."catalog_item_id" = i."id"
                  AND a."tenant_id" = i."tenant_id"
                  AND a."legal_entity_id" = NEW."legal_entity_id"
             )
           )
      ) INTO ok;

    WHEN 'catalog_item_legal_entity_assignment' THEN
      SELECT EXISTS (
        SELECT 1 FROM "catalog_item_legal_entity_assignment" a
         WHERE a."id" = NEW."entity_id"
           AND a."tenant_id" = NEW."tenant_id"
           AND a."legal_entity_id" = NEW."legal_entity_id"
      ) INTO ok;

    WHEN 'price_list' THEN
      SELECT EXISTS (
        SELECT 1 FROM "price_list" l
         WHERE l."id" = NEW."entity_id"
           AND l."tenant_id" = NEW."tenant_id"
           AND (
             l."owner_legal_entity_id" = NEW."legal_entity_id"
             OR EXISTS (
               SELECT 1 FROM "price_list_legal_entity_assignment" a
                WHERE a."price_list_id" = l."id"
                  AND a."tenant_id" = l."tenant_id"
                  AND a."legal_entity_id" = NEW."legal_entity_id"
             )
           )
      ) INTO ok;

    WHEN 'price_list_legal_entity_assignment' THEN
      SELECT EXISTS (
        SELECT 1 FROM "price_list_legal_entity_assignment" a
         WHERE a."id" = NEW."entity_id"
           AND a."tenant_id" = NEW."tenant_id"
           AND a."legal_entity_id" = NEW."legal_entity_id"
      ) INTO ok;

    ELSE
      RAISE EXCEPTION 'custom field entity_type % is not an allowlisted Phase 2 target',
        NEW."entity_type" USING ERRCODE = 'check_violation';
  END CASE;

  IF NOT ok THEN
    RAISE EXCEPTION
      'custom field value target %/% does not exist in tenant % for legal entity %',
      NEW."entity_type", NEW."entity_id", NEW."tenant_id", NEW."legal_entity_id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS custom_field_value_target_integrity_trg ON "custom_field_value";
CREATE TRIGGER custom_field_value_target_integrity_trg
  BEFORE INSERT OR UPDATE ON "custom_field_value"
  FOR EACH ROW EXECUTE FUNCTION custom_field_value_target_integrity();

-- entityType and dataType become immutable once any value exists, so a
-- definition change cannot invalidate stored typed columns or retarget
-- existing values onto a different master kind.
CREATE OR REPLACE FUNCTION custom_field_definition_immutability() RETURNS trigger AS $$
BEGIN
  IF NEW."entity_type" IS DISTINCT FROM OLD."entity_type"
     OR NEW."data_type" IS DISTINCT FROM OLD."data_type" THEN
    IF EXISTS (
      SELECT 1 FROM "custom_field_value" v WHERE v."definition_id" = OLD."id"
    ) THEN
      RAISE EXCEPTION
        'custom field definition entity_type and data_type are immutable once values exist'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS custom_field_definition_immutability_trg ON "custom_field_definition";
CREATE TRIGGER custom_field_definition_immutability_trg
  BEFORE UPDATE ON "custom_field_definition"
  FOR EACH ROW EXECUTE FUNCTION custom_field_definition_immutability();

-- Re-validate existing values against the new triggers. Empty tables are a
-- no-op. Invalid leftover rows fail the migration rather than remaining as
-- unenforced polymorphic pointers (F-6). The legacy JSON column is not
-- dropped.
UPDATE "custom_field_value" SET "version" = "version";
