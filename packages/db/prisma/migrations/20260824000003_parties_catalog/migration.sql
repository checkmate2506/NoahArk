-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('ORGANISATION', 'INDIVIDUAL');

-- CreateEnum
CREATE TYPE "PartyAddressType" AS ENUM ('BILLING', 'SHIPPING', 'REGISTERED', 'GENERAL');

-- CreateEnum
CREATE TYPE "PartyStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CatalogItemType" AS ENUM ('PRODUCT', 'SERVICE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CustomFieldDataType" ADD VALUE 'INTEGER';
ALTER TYPE "CustomFieldDataType" ADD VALUE 'DECIMAL';
ALTER TYPE "CustomFieldDataType" ADD VALUE 'SINGLE_SELECT';

-- AlterTable
ALTER TABLE "custom_field_definition" ADD COLUMN     "display_order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "custom_field_value" ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "legal_entity_id" TEXT,
ADD COLUMN     "value_boolean" BOOLEAN,
ADD COLUMN     "value_date" DATE,
ADD COLUMN     "value_decimal" DECIMAL(23,6),
ADD COLUMN     "value_integer" INTEGER,
ADD COLUMN     "value_option" TEXT,
ADD COLUMN     "value_text" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "value" DROP NOT NULL;

-- CreateTable
CREATE TABLE "party" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "party_type" "PartyType" NOT NULL,
    "legal_name" TEXT,
    "trading_name" TEXT,
    "given_name" TEXT,
    "family_name" TEXT,
    "normalised_name" TEXT NOT NULL,
    "tax_identifier" TEXT,
    "status" "PartyStatus" NOT NULL DEFAULT 'ACTIVE',
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party_contact" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "given_name" TEXT NOT NULL,
    "family_name" TEXT,
    "job_title" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "normalised_email" TEXT,
    "status" "PartyStatus" NOT NULL DEFAULT 'ACTIVE',
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "party_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party_address" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "address_type" "PartyAddressType" NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "line3" TEXT,
    "city" TEXT,
    "region" TEXT,
    "postal_code" TEXT,
    "country_code" CHAR(2) NOT NULL,
    "status" "PartyStatus" NOT NULL DEFAULT 'ACTIVE',
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "party_address_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party_legal_entity_assignment" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "party_id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "party_legal_entity_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_role" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "default_currency" "Currency",
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_role" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "default_currency" "Currency",
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vendor_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_category" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalog_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unit_of_measure" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "unit_of_measure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_item" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "item_type" "CatalogItemType" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category_id" TEXT,
    "base_uom_id" TEXT NOT NULL,
    "tax_category_code" TEXT,
    "is_sellable" BOOLEAN NOT NULL DEFAULT true,
    "is_purchasable" BOOLEAN NOT NULL DEFAULT true,
    "status" "PartyStatus" NOT NULL DEFAULT 'ACTIVE',
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalog_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_item_legal_entity_assignment" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "catalog_item_id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "entity_item_code" TEXT,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "catalog_item_legal_entity_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "status" "PartyStatus" NOT NULL DEFAULT 'ACTIVE',
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "price_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list_legal_entity_assignment" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "price_list_id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "assigned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "price_list_legal_entity_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_list_entry" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "legal_entity_id" TEXT NOT NULL,
    "price_list_assignment_id" TEXT NOT NULL,
    "catalog_item_assignment_id" TEXT NOT NULL,
    "unit_price" DECIMAL(23,6) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "price_list_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "party_tenant_id_status_idx" ON "party"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "party_tenant_id_normalised_name_idx" ON "party"("tenant_id", "normalised_name");

-- CreateIndex
CREATE INDEX "party_tenant_id_tax_identifier_idx" ON "party"("tenant_id", "tax_identifier");

-- CreateIndex
CREATE UNIQUE INDEX "party_tenant_id_code_key" ON "party"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "party_id_tenant_id_key" ON "party"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "party_contact_tenant_id_idx" ON "party_contact"("tenant_id");

-- CreateIndex
CREATE INDEX "party_contact_party_id_idx" ON "party_contact"("party_id");

-- CreateIndex
CREATE INDEX "party_contact_tenant_id_normalised_email_idx" ON "party_contact"("tenant_id", "normalised_email");

-- CreateIndex
CREATE INDEX "party_address_tenant_id_idx" ON "party_address"("tenant_id");

-- CreateIndex
CREATE INDEX "party_address_party_id_idx" ON "party_address"("party_id");

-- CreateIndex
CREATE INDEX "party_legal_entity_assignment_tenant_id_legal_entity_id_idx" ON "party_legal_entity_assignment"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "party_legal_entity_assignment_party_id_legal_entity_id_idx" ON "party_legal_entity_assignment"("party_id", "legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "party_legal_entity_assignment_party_id_legal_entity_id_key" ON "party_legal_entity_assignment"("party_id", "legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "party_legal_entity_assignment_id_legal_entity_id_key" ON "party_legal_entity_assignment"("id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "customer_role_tenant_id_legal_entity_id_idx" ON "customer_role"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_role_assignment_id_key" ON "customer_role"("assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_role_assignment_id_legal_entity_id_key" ON "customer_role"("assignment_id", "legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_role_legal_entity_id_code_key" ON "customer_role"("legal_entity_id", "code");

-- CreateIndex
CREATE INDEX "vendor_role_tenant_id_legal_entity_id_idx" ON "vendor_role"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_role_assignment_id_key" ON "vendor_role"("assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_role_assignment_id_legal_entity_id_key" ON "vendor_role"("assignment_id", "legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_role_legal_entity_id_code_key" ON "vendor_role"("legal_entity_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_category_tenant_id_code_key" ON "catalog_category"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_category_id_tenant_id_key" ON "catalog_category"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "unit_of_measure_tenant_id_code_key" ON "unit_of_measure"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "unit_of_measure_id_tenant_id_key" ON "unit_of_measure"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "catalog_item_tenant_id_status_idx" ON "catalog_item"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "catalog_item_tenant_id_item_type_idx" ON "catalog_item"("tenant_id", "item_type");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_item_tenant_id_code_key" ON "catalog_item"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_item_id_tenant_id_key" ON "catalog_item"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "catalog_item_legal_entity_assignment_tenant_id_legal_entity_idx" ON "catalog_item_legal_entity_assignment"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "catalog_item_legal_entity_assignment_catalog_item_id_legal__idx" ON "catalog_item_legal_entity_assignment"("catalog_item_id", "legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_item_legal_entity_assignment_catalog_item_id_legal__key" ON "catalog_item_legal_entity_assignment"("catalog_item_id", "legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_item_legal_entity_assignment_id_legal_entity_id_key" ON "catalog_item_legal_entity_assignment"("id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "price_list_tenant_id_status_idx" ON "price_list"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_tenant_id_code_key" ON "price_list"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_id_tenant_id_key" ON "price_list"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "price_list_legal_entity_assignment_tenant_id_legal_entity_i_idx" ON "price_list_legal_entity_assignment"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_legal_entity_assignment_price_list_id_legal_enti_key" ON "price_list_legal_entity_assignment"("price_list_id", "legal_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_list_legal_entity_assignment_id_legal_entity_id_key" ON "price_list_legal_entity_assignment"("id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "price_list_entry_tenant_id_legal_entity_id_idx" ON "price_list_entry"("tenant_id", "legal_entity_id");

-- CreateIndex
CREATE INDEX "price_list_entry_price_list_assignment_id_catalog_item_assi_idx" ON "price_list_entry"("price_list_assignment_id", "catalog_item_assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "legal_entity_id_tenant_id_key" ON "legal_entity"("id", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definition_id_tenant_id_key" ON "custom_field_definition"("id", "tenant_id");

-- CreateIndex
CREATE INDEX "custom_field_value_entity_type_entity_id_idx" ON "custom_field_value"("entity_type", "entity_id");

-- AddForeignKey
ALTER TABLE "custom_field_value" ADD CONSTRAINT "custom_field_value_legal_entity_id_fkey" FOREIGN KEY ("legal_entity_id") REFERENCES "legal_entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party" ADD CONSTRAINT "party_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_contact" ADD CONSTRAINT "party_contact_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_contact" ADD CONSTRAINT "party_contact_party_id_tenant_id_fkey" FOREIGN KEY ("party_id", "tenant_id") REFERENCES "party"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_address" ADD CONSTRAINT "party_address_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_address" ADD CONSTRAINT "party_address_party_id_tenant_id_fkey" FOREIGN KEY ("party_id", "tenant_id") REFERENCES "party"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_legal_entity_assignment" ADD CONSTRAINT "party_legal_entity_assignment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_legal_entity_assignment" ADD CONSTRAINT "party_legal_entity_assignment_party_id_tenant_id_fkey" FOREIGN KEY ("party_id", "tenant_id") REFERENCES "party"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_legal_entity_assignment" ADD CONSTRAINT "party_legal_entity_assignment_legal_entity_id_tenant_id_fkey" FOREIGN KEY ("legal_entity_id", "tenant_id") REFERENCES "legal_entity"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_role" ADD CONSTRAINT "customer_role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_role" ADD CONSTRAINT "customer_role_legal_entity_id_tenant_id_fkey" FOREIGN KEY ("legal_entity_id", "tenant_id") REFERENCES "legal_entity"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_role" ADD CONSTRAINT "customer_role_assignment_id_legal_entity_id_fkey" FOREIGN KEY ("assignment_id", "legal_entity_id") REFERENCES "party_legal_entity_assignment"("id", "legal_entity_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_role" ADD CONSTRAINT "vendor_role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_role" ADD CONSTRAINT "vendor_role_legal_entity_id_tenant_id_fkey" FOREIGN KEY ("legal_entity_id", "tenant_id") REFERENCES "legal_entity"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_role" ADD CONSTRAINT "vendor_role_assignment_id_legal_entity_id_fkey" FOREIGN KEY ("assignment_id", "legal_entity_id") REFERENCES "party_legal_entity_assignment"("id", "legal_entity_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_category" ADD CONSTRAINT "catalog_category_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "unit_of_measure" ADD CONSTRAINT "unit_of_measure_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_category_id_tenant_id_fkey" FOREIGN KEY ("category_id", "tenant_id") REFERENCES "catalog_category"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_base_uom_id_tenant_id_fkey" FOREIGN KEY ("base_uom_id", "tenant_id") REFERENCES "unit_of_measure"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_legal_entity_assignment" ADD CONSTRAINT "catalog_item_legal_entity_assignment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_legal_entity_assignment" ADD CONSTRAINT "catalog_item_legal_entity_assignment_catalog_item_id_tenan_fkey" FOREIGN KEY ("catalog_item_id", "tenant_id") REFERENCES "catalog_item"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_legal_entity_assignment" ADD CONSTRAINT "catalog_item_legal_entity_assignment_legal_entity_id_tenan_fkey" FOREIGN KEY ("legal_entity_id", "tenant_id") REFERENCES "legal_entity"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list" ADD CONSTRAINT "price_list_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_legal_entity_assignment" ADD CONSTRAINT "price_list_legal_entity_assignment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_legal_entity_assignment" ADD CONSTRAINT "price_list_legal_entity_assignment_price_list_id_tenant_id_fkey" FOREIGN KEY ("price_list_id", "tenant_id") REFERENCES "price_list"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_legal_entity_assignment" ADD CONSTRAINT "price_list_legal_entity_assignment_legal_entity_id_tenant__fkey" FOREIGN KEY ("legal_entity_id", "tenant_id") REFERENCES "legal_entity"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_entry" ADD CONSTRAINT "price_list_entry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_entry" ADD CONSTRAINT "price_list_entry_legal_entity_id_tenant_id_fkey" FOREIGN KEY ("legal_entity_id", "tenant_id") REFERENCES "legal_entity"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_entry" ADD CONSTRAINT "price_list_entry_price_list_assignment_id_legal_entity_id_fkey" FOREIGN KEY ("price_list_assignment_id", "legal_entity_id") REFERENCES "price_list_legal_entity_assignment"("id", "legal_entity_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_list_entry" ADD CONSTRAINT "price_list_entry_catalog_item_assignment_id_legal_entity_i_fkey" FOREIGN KEY ("catalog_item_assignment_id", "legal_entity_id") REFERENCES "catalog_item_legal_entity_assignment"("id", "legal_entity_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- Phase 2A - Shared parties & catalog: invariants, RLS and grants
--
-- Everything below this line is hand-written. The DDL above was generated by
-- `prisma migrate diff`; Prisma cannot express partial unique indexes,
-- exclusion constraints, CHECK constraints, triggers, RLS policies or grants.
--
-- Phase 1's two migrations are NOT touched by this file. This migration is
-- additive: the only relaxation above is `custom_field_value.value` losing
-- NOT NULL (the expand step of expand/migrate/contract), and no column or
-- table is dropped anywhere in Phase 2.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Extension required by the price-effective-period exclusion constraint.
--    btree_gist supplies GiST operator classes for the scalar (text) columns
--    that the EXCLUDE constraint combines with a range column. Idempotent, and
--    available on PostgreSQL 16 (verified in P2A against 16.14).
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- 1. Party invariants
-- ---------------------------------------------------------------------------

-- An ORGANISATION is identified by legal_name; an INDIVIDUAL by given_name.
-- Enforced here rather than in a service so a raw-SQL writer cannot create a
-- nameless or mis-typed counterparty.
ALTER TABLE "party" ADD CONSTRAINT "party_name_by_type_check"
  CHECK (
    ("party_type" = 'ORGANISATION' AND "legal_name" IS NOT NULL AND btrim("legal_name") <> ''
       AND "given_name" IS NULL AND "family_name" IS NULL)
    OR
    ("party_type" = 'INDIVIDUAL' AND "given_name" IS NOT NULL AND btrim("given_name") <> ''
       AND "legal_name" IS NULL AND "trading_name" IS NULL)
  );

ALTER TABLE "party" ADD CONSTRAINT "party_code_not_blank_check"
  CHECK (btrim("code") <> '');

-- Archive semantics are explicit and symmetric on every archivable Phase 2
-- master/assignment: ARCHIVED <-> archived_at IS NOT NULL.
ALTER TABLE "party" ADD CONSTRAINT "party_archived_at_check"
  CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL));

-- At most ONE primary contact per party. A partial unique index is the only
-- correct shape here: non-primary contacts must remain unconstrained.
CREATE UNIQUE INDEX "party_contact_one_primary_per_party"
  ON "party_contact" ("party_id") WHERE "is_primary";

ALTER TABLE "party_contact" ADD CONSTRAINT "party_contact_archived_at_check"
  CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL));

-- ISO 3166-1 alpha-2 SHAPE only. Deliberately not a membership test against a
-- country list: NoahArk does not localise for counterparty countries, it only
-- records them descriptively, and a hard-coded country list would rot.
ALTER TABLE "party_address" ADD CONSTRAINT "party_address_country_code_shape_check"
  CHECK ("country_code" ~ '^[A-Z]{2}$');

ALTER TABLE "party_address" ADD CONSTRAINT "party_address_archived_at_check"
  CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL));

ALTER TABLE "party_legal_entity_assignment" ADD CONSTRAINT "party_assignment_archived_at_check"
  CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL));

ALTER TABLE "customer_role" ADD CONSTRAINT "customer_role_archived_at_check"
  CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL));
ALTER TABLE "customer_role" ADD CONSTRAINT "customer_role_code_not_blank_check"
  CHECK (btrim("code") <> '');

ALTER TABLE "vendor_role" ADD CONSTRAINT "vendor_role_archived_at_check"
  CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL));
ALTER TABLE "vendor_role" ADD CONSTRAINT "vendor_role_code_not_blank_check"
  CHECK (btrim("code") <> '');

-- ---------------------------------------------------------------------------
-- 2. Catalog invariants
-- ---------------------------------------------------------------------------

ALTER TABLE "catalog_category" ADD CONSTRAINT "catalog_category_code_not_blank_check"
  CHECK (btrim("code") <> '');
ALTER TABLE "unit_of_measure" ADD CONSTRAINT "unit_of_measure_code_not_blank_check"
  CHECK (btrim("code") <> '');

ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_code_not_blank_check"
  CHECK (btrim("code") <> '');
ALTER TABLE "catalog_item" ADD CONSTRAINT "catalog_item_archived_at_check"
  CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL));

ALTER TABLE "catalog_item_legal_entity_assignment"
  ADD CONSTRAINT "catalog_item_assignment_archived_at_check"
  CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL));

-- Entity-local item code, unique per legal entity only where supplied.
CREATE UNIQUE INDEX "catalog_item_assignment_entity_code_unique"
  ON "catalog_item_legal_entity_assignment" ("legal_entity_id", "entity_item_code")
  WHERE "entity_item_code" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Price-list invariants
-- ---------------------------------------------------------------------------

ALTER TABLE "price_list" ADD CONSTRAINT "price_list_code_not_blank_check"
  CHECK (btrim("code") <> '');
ALTER TABLE "price_list" ADD CONSTRAINT "price_list_archived_at_check"
  CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL));

ALTER TABLE "price_list_legal_entity_assignment"
  ADD CONSTRAINT "price_list_assignment_archived_at_check"
  CHECK (("status" = 'ARCHIVED') = ("archived_at" IS NOT NULL));

-- At most one ACTIVE default price list per legal entity. Scoped to ACTIVE so
-- an archived former default never blocks a new one.
CREATE UNIQUE INDEX "price_list_assignment_one_default_per_entity"
  ON "price_list_legal_entity_assignment" ("legal_entity_id")
  WHERE "is_default" AND "status" = 'ACTIVE';

-- Exact-decimal money invariants. There is no currency conversion, no
-- discount and no tax-inclusive arithmetic in Phase 2: a price is simply an
-- exact non-negative NUMERIC(23,6) in the price list's own currency.
ALTER TABLE "price_list_entry" ADD CONSTRAINT "price_list_entry_unit_price_non_negative_check"
  CHECK ("unit_price" >= 0);

ALTER TABLE "price_list_entry" ADD CONSTRAINT "price_list_entry_effective_range_check"
  CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");

-- Overlapping effective periods for the same (price-list assignment, catalog-item
-- assignment) pair are rejected by PostgreSQL itself, not by a service. Both
-- assignment ids already carry legal_entity_id in their composite foreign keys,
-- so this exclusion is inherently entity-scoped.
--
-- The range is INCLUSIVE on both ends ('[]') because effective_to is an
-- inclusive last-effective-day; a NULL upper bound yields an unbounded range,
-- which is exactly the open-ended-price semantics we want.
ALTER TABLE "price_list_entry" ADD CONSTRAINT "price_list_entry_no_overlap"
  EXCLUDE USING gist (
    "price_list_assignment_id" WITH =,
    "catalog_item_assignment_id" WITH =,
    daterange("effective_from", "effective_to", '[]') WITH &&
  );

-- ---------------------------------------------------------------------------
-- 4. Custom fields - security hardening and typed expansion
--
-- Phase 1 shipped custom_field_definition/custom_field_value with an untyped
-- `value Json` column, an UNCONSTRAINED `entity_type`, and a tenant-only RLS
-- policy. At Phase 1 that was inert - the schema's own comment recorded "no
-- business entities to attach to yet" and a repository-wide search finds no
-- production, seed or test code that ever created a definition or a value.
-- Phase 2 is where those tables gain real targets, so the three latent gaps
-- are closed here BEFORE anything can attach to them.
-- ---------------------------------------------------------------------------

-- 4a. Authentication/security models can NEVER be custom-field targets.
--     Written as a denylist rather than an allowlist so that a deployed
--     database carrying pre-existing (non-auth) foundation definitions is not
--     invalidated by this migration - see the Phase 2 implementation record's
--     "custom-field migration safety" section. Auth targeting is absolute.
ALTER TABLE "custom_field_definition"
  ADD CONSTRAINT "custom_field_definition_no_auth_target_check"
  CHECK (lower("entity_type") NOT IN (
    'user', 'account', 'session', 'user_credential', 'mfa_credential',
    'mfa_recovery_code', 'verification_token', 'auth_rate_limit_bucket',
    'permission', 'role', 'role_permission', 'membership_role',
    'field_policy', 'audit_event', 'idempotency_key'
  ));

ALTER TABLE "custom_field_value"
  ADD CONSTRAINT "custom_field_value_no_auth_target_check"
  CHECK (lower("entity_type") NOT IN (
    'user', 'account', 'session', 'user_credential', 'mfa_credential',
    'mfa_recovery_code', 'verification_token', 'auth_rate_limit_bucket',
    'permission', 'role', 'role_permission', 'membership_role',
    'field_policy', 'audit_event', 'idempotency_key'
  ));

-- 4b. Phase 2 target types must use TYPED storage, must be legal-entity
--     scoped, and must never write the legacy JSON column. Legacy rows
--     (any other entity_type) are left entirely alone.
ALTER TABLE "custom_field_value"
  ADD CONSTRAINT "custom_field_value_phase2_typed_check"
  CHECK (
    lower("entity_type") NOT IN ('party','party_contact','party_address','catalog_item','price_list')
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

-- 4c. The populated typed column must agree with the definition's data type,
--     and the definition must still be active. A CHECK constraint cannot read
--     another table, so this is a trigger - the only mechanism that makes
--     database and application validation genuinely agree.
CREATE OR REPLACE FUNCTION custom_field_value_typed_guard() RETURNS trigger AS $$
DECLARE
  def_type  "CustomFieldDataType";
  def_active BOOLEAN;
  def_tenant TEXT;
  is_phase2 BOOLEAN;
BEGIN
  is_phase2 := lower(NEW."entity_type") IN
    ('party','party_contact','party_address','catalog_item','price_list');
  IF NOT is_phase2 THEN
    RETURN NEW; -- legacy foundation row: unchanged Phase 1 behaviour
  END IF;

  SELECT d."data_type", d."is_active", d."tenant_id"
    INTO def_type, def_active, def_tenant
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

  IF NOT def_active THEN
    RAISE EXCEPTION 'custom field definition % is inactive', NEW."definition_id"
      USING ERRCODE = 'check_violation';
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

CREATE TRIGGER custom_field_value_typed_guard_trg
  BEFORE INSERT OR UPDATE ON "custom_field_value"
  FOR EACH ROW EXECUTE FUNCTION custom_field_value_typed_guard();

-- ---------------------------------------------------------------------------
-- 5. Row-Level Security
--
-- Two policy classes, deliberately different:
--
--   (a) ASSIGNMENT/ENTITY-SCOPED tables carry legal_entity_id directly and
--       reuse Phase 1's proven dual-axis template verbatim.
--
--   (b) SHARED MASTERS (party, party_contact, party_address, catalog_item,
--       price_list) carry NO legal_entity_id. A plain tenant policy would make
--       every tenant party visible to every legal-entity user - exactly the
--       leak LEGAL_ENTITY_ARCHITECTURE.md forbids. They instead use an
--       ASSIGNMENT-EXISTENCE policy.
--
--   Bootstrap: WITH CHECK on the masters validates tenant context only, so a
--   master can be INSERTed before its first assignment exists. USING requires
--   assignment visibility, so an unassigned master is invisible to everyone
--   (including its creator) until the assignment lands. P2B creates master +
--   first assignment atomically in one transaction; a failed creation
--   therefore leaves no VISIBLE orphan, and any invisible orphan is
--   unreachable rather than leaked.
--
--   No DELETE grant is issued on any Phase 2 business table, so there is no
--   hard-delete path to police with a DELETE policy: archival is the only
--   removal semantics.
-- ---------------------------------------------------------------------------

-- 5a. Entity-scoped tables - Phase 1 dual-axis template.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'party_legal_entity_assignment', 'customer_role', 'vendor_role',
    'catalog_item_legal_entity_assignment', 'price_list_legal_entity_assignment',
    'price_list_entry'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $fmt$CREATE POLICY tenant_and_legal_entity_isolation ON %I
        USING (
          tenant_id = current_setting('app.tenant_id', true)
          AND legal_entity_id = ANY(string_to_array(current_setting('app.legal_entity_ids', true), ','))
        )
        WITH CHECK (
          tenant_id = current_setting('app.tenant_id', true)
          AND legal_entity_id = ANY(string_to_array(current_setting('app.legal_entity_ids', true), ','))
        )$fmt$,
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO noahark_app', t);
  END LOOP;
END
$$;

-- 5b. Shared masters - assignment-existence policies.
ALTER TABLE "party" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "party" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_and_assignment_isolation ON "party"
  USING (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "party_legal_entity_assignment" a
       WHERE a."party_id" = "party"."id"
         AND a."legal_entity_id" = ANY(string_to_array(current_setting('app.legal_entity_ids', true), ','))
    )
  )
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE ON "party" TO noahark_app;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['party_contact', 'party_address']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $fmt$CREATE POLICY tenant_and_assignment_isolation ON %I
        USING (
          tenant_id = current_setting('app.tenant_id', true)
          AND EXISTS (
            SELECT 1 FROM "party_legal_entity_assignment" a
             WHERE a."party_id" = %I."party_id"
               AND a."legal_entity_id" = ANY(string_to_array(current_setting('app.legal_entity_ids', true), ','))
          )
        )
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true))$fmt$,
      t, t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO noahark_app', t);
  END LOOP;
END
$$;

ALTER TABLE "catalog_item" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "catalog_item" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_and_assignment_isolation ON "catalog_item"
  USING (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "catalog_item_legal_entity_assignment" a
       WHERE a."catalog_item_id" = "catalog_item"."id"
         AND a."legal_entity_id" = ANY(string_to_array(current_setting('app.legal_entity_ids', true), ','))
    )
  )
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE ON "catalog_item" TO noahark_app;

ALTER TABLE "price_list" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_list" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_and_assignment_isolation ON "price_list"
  USING (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND EXISTS (
      SELECT 1 FROM "price_list_legal_entity_assignment" a
       WHERE a."price_list_id" = "price_list"."id"
         AND a."legal_entity_id" = ANY(string_to_array(current_setting('app.legal_entity_ids', true), ','))
    )
  )
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true));
GRANT SELECT, INSERT, UPDATE ON "price_list" TO noahark_app;

-- 5c. Tenant-visible reference data. catalog_category and unit_of_measure hold
--     no entity-specific commercial term - a category name or a unit code is
--     classification metadata, not a price, code or trading relationship - so
--     tenant-wide visibility leaks nothing an entity user should not see. This
--     mirrors the deliberate Phase 1 decision for `legal_entity` itself.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['catalog_category', 'unit_of_measure']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $fmt$CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = current_setting('app.tenant_id', true))
        WITH CHECK (tenant_id = current_setting('app.tenant_id', true))$fmt$,
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO noahark_app', t);
  END LOOP;
END
$$;

-- 5d. custom_field_value: upgrade Phase 1's tenant-only policy to the
--     nullable-legal-entity dual-axis shape already used elsewhere in Phase 1
--     (approval_policy, outbox_event, file_object, ...). Legacy rows keep
--     legal_entity_id NULL and behave exactly as before; every Phase 2 row is
--     forced NOT NULL by custom_field_value_phase2_typed_check, so guessing an
--     entity_id from another legal entity reveals nothing.
DROP POLICY IF EXISTS tenant_isolation ON "custom_field_value";
CREATE POLICY tenant_and_legal_entity_isolation ON "custom_field_value"
  USING (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND ("legal_entity_id" IS NULL
         OR "legal_entity_id" = ANY(string_to_array(current_setting('app.legal_entity_ids', true), ',')))
  )
  WITH CHECK (
    "tenant_id" = current_setting('app.tenant_id', true)
    AND ("legal_entity_id" IS NULL
         OR "legal_entity_id" = ANY(string_to_array(current_setting('app.legal_entity_ids', true), ',')))
  );

-- ---------------------------------------------------------------------------
-- 6. Worker least privilege.
--    noahark_worker receives NO grant on any Phase 2 business table. It is
--    scoped to the queue tables and the two SECURITY DEFINER cleanup
--    functions established in Phase 1, and Phase 2 does not widen it. The
--    absence is asserted directly by the P2A worker-isolation test.
-- ---------------------------------------------------------------------------
