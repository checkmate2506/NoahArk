import { randomBytes } from "node:crypto";
import type { AccessContext } from "@noahark/core";
import {
  createCatalogItem,
  createPriceList,
  createUnitOfMeasure,
} from "../../lib/services/catalogDomain";
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

export type PricingDomainFixture = CatalogDomainFixture;

export async function setupPricingDomainFixture(): Promise<PricingDomainFixture> {
  return setupCatalogDomainFixture();
}

export async function createTestItem(
  ctx: AccessContext,
  ownerLegalEntityId: string,
  baseUomId: string,
  name = "Item",
) {
  return createCatalogItem(ctx, {
    ownerLegalEntityId,
    code: catalogCode("SKU"),
    itemType: "PRODUCT",
    name,
    baseUomId,
  });
}

export async function createTestPriceList(
  ctx: AccessContext,
  ownerLegalEntityId: string,
  currency: "SGD" | "MYR" | "IDR" = "SGD",
  name = "List",
) {
  return createPriceList(ctx, {
    ownerLegalEntityId,
    code: catalogCode("PL"),
    name,
    currency,
  });
}

export function pricingCode(prefix = "P"): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`.slice(0, 32);
}

export {
  catalogCode,
  contextWithEntities,
  createTestCategory,
  createTestUom,
  createUnitOfMeasure,
  grantLe,
  uniqueSlug,
};
