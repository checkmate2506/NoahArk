-- P2D.0 custom-field hardening (T-5, ADR-79 D-1/D-3).
-- Forward-only. Does not rewrite migrations 00001–00004.

-- 4.1 Revoke surviving Phase 1 DELETE grants. Phase 2 services never delete
-- custom-field rows; a raw noahark_app DELETE must fail closed (SQLSTATE 42501).
REVOKE DELETE ON "custom_field_definition" FROM noahark_app;
REVOKE DELETE ON "custom_field_value" FROM noahark_app;
REVOKE DELETE ON "custom_field_definition" FROM noahark_worker;
REVOKE DELETE ON "custom_field_value" FROM noahark_worker;
REVOKE DELETE ON "custom_field_definition" FROM PUBLIC;
REVOKE DELETE ON "custom_field_value" FROM PUBLIC;

-- 4.2 Shared-master owner-write floor. party / catalog_item / price_list
-- accept NEW.legal_entity_id only when it equals the master's current
-- owner_legal_entity_id. The assignment-based alternative is removed from
-- those three branches only. Entity-scoped targets and party_contact's
-- existing parent-party rule are preserved.
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
           AND p."owner_legal_entity_id" = NEW."legal_entity_id"
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
           AND i."owner_legal_entity_id" = NEW."legal_entity_id"
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
           AND l."owner_legal_entity_id" = NEW."legal_entity_id"
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
