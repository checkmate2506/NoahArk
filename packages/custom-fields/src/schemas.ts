import { z } from "zod";

export const PHASE2_ENTITY_TYPES = [
  "party",
  "party_contact",
  "party_legal_entity_assignment",
  "customer_role",
  "vendor_role",
  "catalog_item",
  "catalog_item_legal_entity_assignment",
  "price_list",
  "price_list_legal_entity_assignment",
] as const;

export const SUPPORTED_DATA_TYPES = [
  "STRING",
  "INTEGER",
  "DECIMAL",
  "BOOLEAN",
  "DATE",
  "SINGLE_SELECT",
] as const;

export type Phase2EntityType = (typeof PHASE2_ENTITY_TYPES)[number];
export type SupportedDataType = (typeof SUPPORTED_DATA_TYPES)[number];

const EntityTypeSchema = z.enum(PHASE2_ENTITY_TYPES);
const DataTypeSchema = z.enum(SUPPORTED_DATA_TYPES);

export const CreateCustomFieldDefinitionSchema = z
  .object({
    entityType: EntityTypeSchema,
    key: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(200),
    dataType: DataTypeSchema,
    isRequired: z.boolean().optional(),
    displayOrder: z.number().int().optional(),
    options: z.array(z.string()).optional(),
  })
  .strict();

export const UpdateCustomFieldDefinitionSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    label: z.string().trim().min(1).max(200).optional(),
    isRequired: z.boolean().optional(),
    displayOrder: z.number().int().optional(),
    options: z.array(z.string()).optional(),
  })
  .strict();

export const ListCustomFieldDefinitionsSchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.number().int().optional(),
    entityType: EntityTypeSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const CustomFieldDefinitionIdVersionSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
  })
  .strict();

export const TypedValueEnvelopeSchema = z.discriminatedUnion("dataType", [
  z.object({ dataType: z.literal("STRING"), value: z.string() }).strict(),
  z.object({ dataType: z.literal("INTEGER"), value: z.number() }).strict(),
  z.object({ dataType: z.literal("DECIMAL"), value: z.string() }).strict(),
  z.object({ dataType: z.literal("BOOLEAN"), value: z.boolean() }).strict(),
  z.object({ dataType: z.literal("DATE"), value: z.string() }).strict(),
  z.object({ dataType: z.literal("SINGLE_SELECT"), value: z.string() }).strict(),
]);

export const SetCustomFieldValueSchema = z
  .object({
    definitionId: z.string().min(1).max(64),
    entityId: z.string().min(1).max(64),
    value: TypedValueEnvelopeSchema,
  })
  .strict();

export const ListCustomFieldValuesSchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.number().int().optional(),
    definitionId: z.string().min(1).max(64).optional(),
    entityType: EntityTypeSchema.optional(),
    entityId: z.string().min(1).max(64).optional(),
  })
  .strict();
