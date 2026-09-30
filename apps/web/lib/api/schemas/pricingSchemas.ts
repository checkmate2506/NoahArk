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

export function toPublicPriceList(row: {
  id: string;
  ownerLegalEntityId: string;
  code: string;
  name: string;
  currency: string;
  status: string;
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    ownerLegalEntityId: row.ownerLegalEntityId,
    code: row.code,
    name: row.name,
    currency: row.currency,
    status: row.status,
    archivedAt: optionalTimestamp(row.archivedAt),
    version: row.version,
    createdAt: timestampToIso(row.createdAt),
    updatedAt: timestampToIso(row.updatedAt),
  };
}

export function toPublicPriceListAssignment(assignment: {
  id: string;
  priceListId: string;
  legalEntityId: string;
  isDefault: boolean;
  status: string;
  assignedAt: Date;
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: assignment.id,
    priceListId: assignment.priceListId,
    legalEntityId: assignment.legalEntityId,
    isDefault: assignment.isDefault,
    status: assignment.status,
    assignedAt: timestampToIso(assignment.assignedAt),
    archivedAt: optionalTimestamp(assignment.archivedAt),
    version: assignment.version,
    createdAt: timestampToIso(assignment.createdAt),
    updatedAt: timestampToIso(assignment.updatedAt),
  };
}

export function toPublicPriceListEntry(entry: {
  id: string;
  legalEntityId: string;
  priceListAssignmentId: string;
  catalogItemAssignmentId: string;
  unitPrice: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: entry.id,
    legalEntityId: entry.legalEntityId,
    priceListAssignmentId: entry.priceListAssignmentId,
    catalogItemAssignmentId: entry.catalogItemAssignmentId,
    unitPrice: entry.unitPrice,
    effectiveFrom: entry.effectiveFrom,
    effectiveTo: entry.effectiveTo,
    version: entry.version,
    createdAt: timestampToIso(entry.createdAt),
    updatedAt: timestampToIso(entry.updatedAt),
  };
}

export function toPublicDefaultPriceListSelection(result: {
  legalEntityId: string;
  previousPriceListId: string | null;
  priceListId: string | null;
}) {
  return {
    legalEntityId: result.legalEntityId,
    previousPriceListId: result.previousPriceListId,
    priceListId: result.priceListId,
  };
}

type ResolvedEffectivePrice = {
  resolved: true;
  unitPrice: string;
  currency: string;
  priceListId: string;
  priceListAssignmentId: string;
  catalogItemAssignmentId: string;
  legalEntityId: string;
  onDate: string;
  entryId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
};

type UnresolvedEffectivePrice = {
  resolved: false;
  unitPrice: null;
  currency: string;
  priceListId: string;
  priceListAssignmentId: string;
  catalogItemAssignmentId: string;
  legalEntityId: string;
  onDate: string;
};

export function toPublicEffectivePrice(
  result: ResolvedEffectivePrice | UnresolvedEffectivePrice,
) {
  if (result.resolved) {
    return {
      resolved: true as const,
      unitPrice: result.unitPrice,
      currency: result.currency,
      priceListId: result.priceListId,
      priceListAssignmentId: result.priceListAssignmentId,
      catalogItemAssignmentId: result.catalogItemAssignmentId,
      legalEntityId: result.legalEntityId,
      onDate: result.onDate,
      entryId: result.entryId,
      effectiveFrom: result.effectiveFrom,
      effectiveTo: result.effectiveTo,
    };
  }
  return {
    resolved: false as const,
    unitPrice: null,
    currency: result.currency,
    priceListId: result.priceListId,
    priceListAssignmentId: result.priceListAssignmentId,
    catalogItemAssignmentId: result.catalogItemAssignmentId,
    legalEntityId: result.legalEntityId,
    onDate: result.onDate,
    entryId: null,
    effectiveFrom: null,
    effectiveTo: null,
  };
}
