import { timestampToIso } from "@/lib/api/dto";

export {
  ExpectedVersionBodySchema,
  parseJsonBody,
  parseWithSchema,
} from "@/lib/api/schemas/partySchemas";

function optionalTimestamp(value: Date | null | undefined): string | null {
  if (value == null) return null;
  return timestampToIso(value);
}

export function toPublicCatalogCategory(row: {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.isActive,
    version: row.version,
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export function toPublicUnitOfMeasure(row: {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.isActive,
    version: row.version,
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export function toPublicCatalogItem(item: {
  id: string;
  ownerLegalEntityId: string;
  code: string;
  itemType: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  baseUomId: string;
  taxCategoryCode: string | null;
  isSellable: boolean;
  isPurchasable: boolean;
  status: string;
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: item.id,
    ownerLegalEntityId: item.ownerLegalEntityId,
    code: item.code,
    itemType: item.itemType,
    name: item.name,
    description: item.description,
    categoryId: item.categoryId,
    baseUomId: item.baseUomId,
    taxCategoryCode: item.taxCategoryCode,
    isSellable: item.isSellable,
    isPurchasable: item.isPurchasable,
    status: item.status,
    archivedAt: optionalTimestamp(item.archivedAt),
    version: item.version,
    createdAt: timestampToIso(item.createdAt),
    updatedAt: timestampToIso(item.updatedAt),
  };
}

export function toPublicCatalogItemAssignment(assignment: {
  id: string;
  catalogItemId: string;
  legalEntityId: string;
  entityItemCode: string | null;
  status: string;
  assignedAt: Date;
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: assignment.id,
    catalogItemId: assignment.catalogItemId,
    legalEntityId: assignment.legalEntityId,
    entityItemCode: assignment.entityItemCode,
    status: assignment.status,
    assignedAt: timestampToIso(assignment.assignedAt),
    archivedAt: optionalTimestamp(assignment.archivedAt),
    version: assignment.version,
    createdAt: timestampToIso(assignment.createdAt),
    updatedAt: timestampToIso(assignment.updatedAt),
  };
}
