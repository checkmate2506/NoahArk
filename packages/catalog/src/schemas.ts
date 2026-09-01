import { z } from "zod";

export const CreateCatalogCategorySchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(120),
});

export const UpdateCatalogCategorySchema = z.object({
  expectedVersion: z.number().int().min(1),
  name: z.string().trim().min(1).max(120).optional(),
});

export const ListCatalogCategoriesSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().optional(),
  isActive: z.boolean().optional(),
  q: z.string().trim().max(200).optional(),
});

export const CatalogCategoryIdVersionSchema = z.object({
  expectedVersion: z.number().int().min(1),
});

export const CreateUnitOfMeasureSchema = z.object({
  code: z.string().trim().min(1).max(32),
  name: z.string().trim().min(1).max(120),
});

export const UpdateUnitOfMeasureSchema = z.object({
  expectedVersion: z.number().int().min(1),
  name: z.string().trim().min(1).max(120).optional(),
});

export const ListUnitsOfMeasureSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().optional(),
  isActive: z.boolean().optional(),
  q: z.string().trim().max(200).optional(),
});

export const UnitOfMeasureIdVersionSchema = z.object({
  expectedVersion: z.number().int().min(1),
});

export const CreateCatalogItemSchema = z.object({
  ownerLegalEntityId: z.string().min(1).max(64),
  code: z.string().trim().min(1).max(64),
  itemType: z.enum(["PRODUCT", "SERVICE"]),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  categoryId: z.string().min(1).max(64).optional(),
  baseUomId: z.string().min(1).max(64),
  taxCategoryCode: z.string().trim().max(64).optional(),
  isSellable: z.boolean().optional(),
  isPurchasable: z.boolean().optional(),
  entityItemCode: z.string().trim().min(1).max(64).optional(),
});

export const UpdateCatalogItemSchema = z.object({
  expectedVersion: z.number().int().min(1),
  code: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  categoryId: z.string().min(1).max(64).nullable().optional(),
  baseUomId: z.string().min(1).max(64).optional(),
  taxCategoryCode: z.string().trim().max(64).nullable().optional(),
  isSellable: z.boolean().optional(),
  isPurchasable: z.boolean().optional(),
});

export const ListCatalogItemsSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().optional(),
  itemType: z.enum(["PRODUCT", "SERVICE"]).optional(),
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  includeArchived: z.boolean().optional(),
  categoryId: z.string().min(1).max(64).optional(),
  q: z.string().trim().max(200).optional(),
});

export const TransferCatalogItemOwnershipSchema = z.object({
  newOwnerLegalEntityId: z.string().min(1).max(64),
  expectedVersion: z.number().int().min(1),
});

export const CreateCatalogItemAssignmentSchema = z.object({
  catalogItemId: z.string().min(1).max(64),
  legalEntityId: z.string().min(1).max(64),
  entityItemCode: z.string().trim().min(1).max(64).optional(),
});

export const UpdateCatalogItemAssignmentSchema = z.object({
  expectedVersion: z.number().int().min(1),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  entityItemCode: z.string().trim().min(1).max(64).nullable().optional(),
});

export const ListCatalogItemAssignmentsSchema = z.object({
  catalogItemId: z.string().min(1).max(64).optional(),
  legalEntityId: z.string().min(1).max(64).optional(),
});
