import { timestampToIso } from "@/lib/api/dto";

export {
  createCustomFieldDefinition,
  getCustomFieldDefinition,
  listCustomFieldDefinitions,
  updateCustomFieldDefinition,
  deactivateCustomFieldDefinition,
  activateCustomFieldDefinition,
  setCustomFieldValue,
  getCustomFieldValue,
  listCustomFieldValues,
} from "@noahark/custom-fields";

export {
  CreateCustomFieldDefinitionSchema,
  UpdateCustomFieldDefinitionSchema,
  ListCustomFieldDefinitionsSchema,
  CustomFieldDefinitionIdVersionSchema,
  SetCustomFieldValueSchema,
  ListCustomFieldValuesSchema,
  TypedValueEnvelopeSchema,
  PHASE2_ENTITY_TYPES,
  SUPPORTED_DATA_TYPES,
} from "@noahark/custom-fields/src/schemas";

export type PublicCustomFieldTypedValue =
  | { dataType: "STRING"; value: string }
  | { dataType: "INTEGER"; value: number }
  | { dataType: "DECIMAL"; value: string }
  | { dataType: "BOOLEAN"; value: boolean }
  | { dataType: "DATE"; value: string }
  | { dataType: "SINGLE_SELECT"; value: string };

function toPublicTypedValue(typedValue: {
  dataType: string;
  value: unknown;
}): PublicCustomFieldTypedValue {
  switch (typedValue.dataType) {
    case "STRING":
      if (typeof typedValue.value !== "string") {
        throw new Error("Custom field STRING envelope is not a string");
      }
      return { dataType: "STRING", value: typedValue.value };
    case "INTEGER":
      if (typeof typedValue.value !== "number" || !Number.isInteger(typedValue.value)) {
        throw new Error("Custom field INTEGER envelope is not an integer");
      }
      return { dataType: "INTEGER", value: typedValue.value };
    case "DECIMAL":
      if (typeof typedValue.value !== "string") {
        throw new Error("Custom field DECIMAL envelope is not a string");
      }
      return { dataType: "DECIMAL", value: typedValue.value };
    case "BOOLEAN":
      if (typeof typedValue.value !== "boolean") {
        throw new Error("Custom field BOOLEAN envelope is not a boolean");
      }
      return { dataType: "BOOLEAN", value: typedValue.value };
    case "DATE":
      if (typeof typedValue.value !== "string") {
        throw new Error("Custom field DATE envelope is not a civil-date string");
      }
      return { dataType: "DATE", value: typedValue.value };
    case "SINGLE_SELECT":
      if (typeof typedValue.value !== "string") {
        throw new Error("Custom field SINGLE_SELECT envelope is not a string");
      }
      return { dataType: "SINGLE_SELECT", value: typedValue.value };
    default:
      throw new Error("Custom field typed envelope is not supported");
  }
}

export function toPublicCustomFieldDefinition(row: {
  id: string;
  legalEntityId: string | null;
  entityType: string;
  key: string;
  label: string;
  dataType: string;
  isRequired: boolean;
  options: string[] | null;
  isActive: boolean;
  displayOrder: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    legalEntityId: row.legalEntityId,
    entityType: row.entityType,
    key: row.key,
    label: row.label,
    dataType: row.dataType,
    isRequired: row.isRequired,
    options: row.options,
    isActive: row.isActive,
    displayOrder: row.displayOrder,
    version: row.version,
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export function toPublicCustomFieldValue(row: {
  id: string;
  legalEntityId: string | null;
  definitionId: string;
  entityType: string;
  entityId: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  typedValue: { dataType: string; value: unknown };
}) {
  return {
    id: row.id,
    legalEntityId: row.legalEntityId,
    definitionId: row.definitionId,
    entityType: row.entityType,
    entityId: row.entityId,
    version: row.version,
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
    typedValue: toPublicTypedValue(row.typedValue),
  };
}
