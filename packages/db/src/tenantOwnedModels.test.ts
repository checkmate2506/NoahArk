import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TENANT_SCOPED_MODELS,
  LEGAL_ENTITY_SCOPED_MODELS,
  GLOBAL_MODELS,
  isTenantOwnedModel,
  isLegalEntityRequiredModel,
} from "./tenantOwnedModels";

/** Reads model names directly from schema.prisma (the source of truth),
 * rather than the generated client's internals — Prisma 7's generated
 * client does not expose a stable public DMMF accessor, and parsing the
 * schema itself is both simpler and more meaningful: it's what a reviewer
 * diffing this list against the RLS migration's table groups would also
 * read. */
function readModelNamesFromSchema(): string[] {
  const schemaPath = fileURLToPath(new URL("../prisma/schema.prisma", import.meta.url));
  const text = readFileSync(schemaPath, "utf8");
  const names: string[] = [];
  for (const match of text.matchAll(/^model\s+(\w+)\s*\{/gm)) {
    const name = match[1];
    if (name) names.push(name);
  }
  return names;
}

describe("tenantOwnedModels classification (F-3C)", () => {
  it("partitions every model in schema.prisma into exactly one of the three lists", () => {
    const allModelNames = readModelNamesFromSchema();
    expect(allModelNames.length).toBeGreaterThan(0);

    const missing: string[] = [];
    const duplicated: string[] = [];
    for (const name of allModelNames) {
      const inTenant = TENANT_SCOPED_MODELS.has(name);
      const inLegalEntity = LEGAL_ENTITY_SCOPED_MODELS.has(name);
      const inGlobal = GLOBAL_MODELS.has(name);
      const count = [inTenant, inLegalEntity, inGlobal].filter(Boolean).length;
      if (count === 0) missing.push(name);
      if (count > 1) duplicated.push(name);
    }

    expect(
      missing,
      `Models missing from every classification list: ${missing.join(", ")}`,
    ).toEqual([]);
    expect(
      duplicated,
      `Models classified in more than one list: ${duplicated.join(", ")}`,
    ).toEqual([]);
  });

  it("does not list a model that no longer exists in the schema", () => {
    const allModelNames = new Set(readModelNamesFromSchema());
    const extra = [
      ...TENANT_SCOPED_MODELS,
      ...LEGAL_ENTITY_SCOPED_MODELS,
      ...GLOBAL_MODELS,
    ].filter((name) => !allModelNames.has(name));
    expect(
      extra,
      `Classified models that no longer exist in schema.prisma: ${extra.join(", ")}`,
    ).toEqual([]);
  });

  it("isTenantOwnedModel is true for every tenant/legal-entity model and false for global models", () => {
    for (const name of TENANT_SCOPED_MODELS) expect(isTenantOwnedModel(name)).toBe(true);
    for (const name of LEGAL_ENTITY_SCOPED_MODELS)
      expect(isTenantOwnedModel(name)).toBe(true);
    for (const name of GLOBAL_MODELS) expect(isTenantOwnedModel(name)).toBe(false);
  });

  it("isLegalEntityRequiredModel matches only org-structure models with a non-nullable legal_entity_id", () => {
    expect(isLegalEntityRequiredModel("BusinessUnit")).toBe(true);
    expect(isLegalEntityRequiredModel("Department")).toBe(true);
    // ApprovalRequest has a NULLABLE legal_entity_id — must not be flagged required.
    expect(isLegalEntityRequiredModel("ApprovalRequest")).toBe(false);
    expect(isLegalEntityRequiredModel("Tenant")).toBe(false);
  });
});
