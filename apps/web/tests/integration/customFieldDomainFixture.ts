import { randomBytes } from "node:crypto";
import type { AccessContext } from "@noahark/core";
import {
  createAssignment,
  createContact,
  createCustomerRole,
  createParty,
  createVendorRole,
} from "../../lib/services/partyDomain";
import {
  createCatalogItemAssignment,
  createPriceListAssignment,
} from "../../lib/services/catalogDomain";
import {
  createCustomFieldDefinition,
  setCustomFieldValue,
} from "../../lib/services/customFieldDomain";
import {
  catalogCode,
  contextWithEntities,
  createTestCategory,
  createTestUom,
  grantLe,
  setupCatalogDomainFixture,
  uniqueSlug,
  type CatalogDomainFixture,
} from "./catalogDomainFixture";
import { createTestItem, createTestPriceList } from "./pricingDomainFixture";

export type CustomFieldDomainFixture = CatalogDomainFixture;

export async function setupCustomFieldDomainFixture(): Promise<CustomFieldDomainFixture> {
  return setupCatalogDomainFixture();
}

export function fieldKey(prefix = "cf"): string {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export async function createTestParty(
  ctx: AccessContext,
  ownerLegalEntityId: string,
  name = "Party",
) {
  return createParty(ctx, {
    ownerLegalEntityId,
    code: catalogCode("PTY"),
    partyType: "ORGANISATION",
    legalName: name,
  });
}

export async function createStringDefinition(
  ctx: AccessContext,
  entityType: string,
  key = fieldKey(),
) {
  return createCustomFieldDefinition(ctx, {
    entityType,
    key,
    label: key,
    dataType: "STRING",
  });
}

export async function setStringValue(
  ctx: AccessContext,
  definitionId: string,
  entityId: string,
  value = "hello",
) {
  return setCustomFieldValue(ctx, {
    definitionId,
    entityId,
    value: { dataType: "STRING", value },
  });
}

export async function createAssignedPartyGraph(
  ctx: AccessContext,
  ownerLegalEntityId: string,
  assignedLegalEntityId: string,
) {
  const created = await createTestParty(ctx, ownerLegalEntityId);
  const assignmentB = await createAssignment(ctx, {
    partyId: created.party.id,
    legalEntityId: assignedLegalEntityId,
  });
  const contact = await createContact(ctx, {
    partyId: created.party.id,
    givenName: "Pat",
  });
  const customerRole = await createCustomerRole(ctx, {
    assignmentId: created.assignment.id,
    code: catalogCode("CUST"),
  });
  const vendorRole = await createVendorRole(ctx, {
    assignmentId: created.assignment.id,
    code: catalogCode("VEND"),
  });
  return {
    party: created.party,
    ownerAssignment: created.assignment,
    assignmentB,
    contact,
    customerRole,
    vendorRole,
  };
}

export async function createAssignedCatalogGraph(
  ctx: AccessContext,
  ownerLegalEntityId: string,
  assignedLegalEntityId: string,
) {
  const uom = await createTestUom(ctx);
  const item = await createTestItem(ctx, ownerLegalEntityId, uom.id);
  const itemAssignmentB = await createCatalogItemAssignment(ctx, {
    catalogItemId: item.item.id,
    legalEntityId: assignedLegalEntityId,
  });
  const priceList = await createTestPriceList(ctx, ownerLegalEntityId);
  const priceAssignmentB = await createPriceListAssignment(ctx, {
    priceListId: priceList.priceList.id,
    legalEntityId: assignedLegalEntityId,
  });
  return {
    uom,
    item: item.item,
    itemOwnerAssignment: item.assignment,
    itemAssignmentB,
    priceList: priceList.priceList,
    priceOwnerAssignment: priceList.assignment,
    priceAssignmentB,
  };
}

export {
  catalogCode,
  contextWithEntities,
  createTestCategory,
  createTestUom,
  createTestItem,
  createTestPriceList,
  grantLe,
  uniqueSlug,
};
