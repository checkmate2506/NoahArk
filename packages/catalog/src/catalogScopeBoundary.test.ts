import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as catalog from "./index";

const srcRoot = fileURLToPath(new URL(".", import.meta.url));

export function findBannedTokens(source: string, banned: string[]): string[] {
  return banned.filter((token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`).test(source);
  });
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

function walkProductionTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkProductionTs(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

function functionBody(source: string, name: string): string {
  const marker = `export async function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const next = source.indexOf("export async function", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

const BANNED = [
  "set_config",
  "app.legal_entity_ids",
  "app.tenant_id",
  "archiveCatalogItem",
  "cascade",
  "archiveAssignmentRow",
  "enforceLastActiveRule",
  "23P01",
  "exclusion",
  "effectiveFrom",
  "effectiveTo",
  "daterange",
  "priceList",
  "unitPrice",
  "parentId",
  "conversionFactor",
  "toBaseUom",
  "roundingMode",
  "barcode",
  "gtin",
  "ean",
  "upc",
  "stockQuantity",
  "isStockTracked",
  "costMethod",
  "buildAuditEventRow",
  "tx.legalEntity.findMany",
  "FROM legal_entity",
  "deleteMany",
];

const SERVICE_EXPORTS = [
  "createCatalogCategory",
  "getCatalogCategory",
  "listCatalogCategories",
  "updateCatalogCategory",
  "deactivateCatalogCategory",
  "activateCatalogCategory",
  "createUnitOfMeasure",
  "getUnitOfMeasure",
  "listUnitsOfMeasure",
  "updateUnitOfMeasure",
  "deactivateUnitOfMeasure",
  "activateUnitOfMeasure",
  "createCatalogItem",
  "getCatalogItem",
  "listCatalogItems",
  "updateCatalogItem",
  "transferCatalogItemOwnership",
  "createCatalogItemAssignment",
  "getCatalogItemAssignment",
  "listCatalogItemAssignments",
  "updateCatalogItemAssignment",
  "archiveCatalogItemAssignment",
] as const;

describe("findBannedTokens", () => {
  it("is non-vacuous against in-memory fixtures only", () => {
    expect(findBannedTokens("hello set_config world", ["set_config", "absent"])).toEqual([
      "set_config",
    ]);
    expect(findBannedTokens("clean source", ["set_config"])).toEqual([]);
    expect(findBannedTokens("archiveCatalogItem(", ["archiveCatalogItem"])).toEqual([
      "archiveCatalogItem",
    ]);
    expect(
      findBannedTokens("archiveCatalogItemAssignment", ["archiveCatalogItem"]),
    ).toEqual([]);
  });
});

describe("catalog production source scope", () => {
  const files = walkProductionTs(srcRoot);
  const combined = files.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");

  it("scans a non-empty production file list", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => !f.endsWith(".test.ts"))).toBe(true);
  });

  it("contains none of the banned tokens", () => {
    expect(findBannedTokens(combined, BANNED)).toEqual([]);
    expect(combined).not.toMatch(/\bparent\b/);
    expect(combined).not.toMatch(/\bdepth\b/);
    expect(combined).not.toMatch(/\bancestors\b/);
    expect(combined).not.toMatch(/\bratio\b/);
    expect(combined).not.toMatch(/\.delete\s*\(/);
    expect(combined).not.toMatch(/if\s*\([^)]*taxCategoryCode/);
    expect(combined).not.toMatch(/switch\s*\([^)]*taxCategoryCode/);
  });

  it("only uses the assignment advisory key", () => {
    const lockHits = combined.match(/pg_advisory_xact_lock[\s\S]{0,200}/g) ?? [];
    expect(lockHits.length).toBeGreaterThan(0);
    for (const hit of lockHits) {
      expect(hit).toContain("catalog-item-assignments:");
    }
  });

  it("does not acquire a lock after writeAuditEvent in the same function", () => {
    for (const file of files) {
      const source = stripComments(readFileSync(file, "utf8"));
      const fns = source.split(/export async function /).slice(1);
      for (const fn of fns) {
        const auditAt = fn.lastIndexOf("writeAuditEvent(");
        if (auditAt < 0) continue;
        const after = fn.slice(auditAt);
        expect(after).not.toMatch(/pg_advisory_xact_lock|FOR UPDATE|FOR SHARE/);
      }
    }
  });

  it("createCatalogItemAssignment has no FOR UPDATE on catalog_item", () => {
    const source = stripComments(
      readFileSync(join(srcRoot, "catalogAssignmentService.ts"), "utf8"),
    );
    const body = functionBody(source, "createCatalogItemAssignment");
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/FOR UPDATE/);
    expect(body).not.toMatch(/lockCatalogItemRow/);
  });

  it("transferCatalogItemOwnership takes the assignment advisory key before FOR UPDATE", () => {
    const source = stripComments(
      readFileSync(join(srcRoot, "catalogItemService.ts"), "utf8"),
    );
    const body = functionBody(source, "transferCatalogItemOwnership");
    expect(body.length).toBeGreaterThan(0);
    const keyAt = body.indexOf("catalog-item-assignments:");
    const lockCallAt = body.indexOf("lockCatalogItemAssignments(");
    const rowLockAt = body.indexOf("lockCatalogItemRow(");
    expect(lockCallAt).toBeGreaterThanOrEqual(0);
    expect(rowLockAt).toBeGreaterThan(lockCallAt);
    expect(keyAt === -1 || keyAt < rowLockAt).toBe(true);
  });
});

describe("public barrel", () => {
  it("exports exactly the 22 named functions and none of the banned symbols", () => {
    for (const name of SERVICE_EXPORTS) {
      expect(catalog, name).toHaveProperty(name);
    }
    expect(SERVICE_EXPORTS).toHaveLength(22);
    expect(catalog).not.toHaveProperty("archiveCatalogItem");
    expect(catalog).not.toHaveProperty("lockCatalogItemRow");
    expect(catalog).not.toHaveProperty("lockCatalogItemAssignments");
    expect(catalog).not.toHaveProperty("cascade");
    expect(Object.keys(catalog).filter((k) => k.startsWith("delete"))).toEqual([]);
  });
});
