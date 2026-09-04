import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findBannedTokens } from "./bannedTokenScan";
import * as catalog from "./index";

const srcRoot = fileURLToPath(new URL(".", import.meta.url));

const PRICING_FILES = [
  "pricingSchemas.ts",
  "pricingDecimal.ts",
  "civilDate.ts",
  "pricingLocking.ts",
  "priceListService.ts",
  "priceListAssignmentService.ts",
  "priceListEntryService.ts",
] as const;

const BANNED = [
  "set_config",
  "app.tenant_id",
  "app.legal_entity_ids",
  "archivePriceList",
  "archiveCatalogItem",
  "cascade",
  "enforceLastActiveRule",
  "deleteMany",
  "buildAuditEventRow",
  "tx.legalEntity.findMany",
  "FROM legal_entity",
  "Date.now",
  "new Date()",
  "parseFloat",
  "parseInt",
  "toLocaleDateString",
  "getTimezoneOffset",
  "customField",
  "customFieldValue",
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

function functionBody(source: string, name: string): string {
  const marker = `export async function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const next = source.indexOf("export async function", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

const PRICING_EXPORTS = [
  "createPriceList",
  "getPriceList",
  "listPriceLists",
  "updatePriceList",
  "transferPriceListOwnership",
  "createPriceListAssignment",
  "getPriceListAssignment",
  "listPriceListAssignments",
  "updatePriceListAssignment",
  "archivePriceListAssignment",
  "setDefaultPriceList",
  "createPriceListEntry",
  "getPriceListEntry",
  "listPriceListEntries",
  "updatePriceListEntry",
  "closePriceListEntry",
  "resolveEffectivePrice",
] as const;

describe("pricing production source scope", () => {
  const files = PRICING_FILES.map((name) => join(srcRoot, name));
  const combined = files.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");

  it("contains none of the banned tokens", () => {
    expect(
      findBannedTokens(
        combined,
        BANNED.filter((t) => t !== "new Date()"),
      ),
    ).toEqual([]);
    expect(combined).not.toContain("new Date()");
    expect(combined).not.toMatch(/\.delete\s*\(/);
    expect(combined).not.toMatch(
      /\bNumber\s*\(\s*(?:unitPrice|unit_price|\bprice\b|\bamount\b)/i,
    );
    expect(combined).not.toMatch(/\b(?:exchange|fx|convert|discount|promotion|tier)\b/i);
  });

  it("only uses pricing advisory keys", () => {
    const lockHits = combined.match(/pg_advisory_xact_lock[\s\S]{0,200}/g) ?? [];
    expect(lockHits.length).toBeGreaterThan(0);
    for (const hit of lockHits) {
      const allowed =
        hit.includes("price-list-assignments:") ||
        hit.includes("price-list-default:") ||
        (hit.includes('"price"') && hit.includes("-list-assignments")) ||
        (hit.includes('"price"') && hit.includes("-list-default"));
      expect(allowed).toBe(true);
      expect(hit).not.toContain("catalog-item-assignments:");
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

  it("createPriceListAssignment does not lock the master row", () => {
    const source = stripComments(
      readFileSync(join(srcRoot, "priceListAssignmentService.ts"), "utf8"),
    );
    const body = functionBody(source, "createPriceListAssignment");
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/FOR UPDATE/);
    expect(body).not.toMatch(/FOR SHARE/);
    expect(body).not.toMatch(/lockPriceListRow/);
  });

  it("createPriceListEntry shares assignments in order and does not lock masters", () => {
    const source = stripComments(
      readFileSync(join(srcRoot, "priceListEntryService.ts"), "utf8"),
    );
    const body = functionBody(source, "createPriceListEntry");
    expect(body.length).toBeGreaterThan(0);
    const plaShare = body.indexOf("price_list_legal_entity_assignment");
    const ciaShare = body.indexOf("catalog_item_legal_entity_assignment");
    expect(plaShare).toBeGreaterThanOrEqual(0);
    expect(ciaShare).toBeGreaterThan(plaShare);
    expect(body.indexOf("FOR SHARE")).toBeGreaterThanOrEqual(0);
    expect(body.indexOf("FOR SHARE")).toBeLessThan(body.lastIndexOf("FOR SHARE"));
    expect(body).not.toMatch(/FROM price_list\s/);
    expect(body).not.toMatch(/FROM catalog_item\s/);
    expect(body).not.toMatch(/lockPriceListRow/);
    expect(body).not.toMatch(/lockCatalogItemRow/);
  });

  it("setDefaultPriceList takes the default key first and does not lock the master", () => {
    const source = stripComments(
      readFileSync(join(srcRoot, "priceListAssignmentService.ts"), "utf8"),
    );
    const body = functionBody(source, "setDefaultPriceList");
    expect(body.length).toBeGreaterThan(0);
    const defaultAt = body.indexOf("lockPriceListDefault(");
    const assignmentAt = body.indexOf("lockPriceListAssignments(");
    expect(defaultAt).toBeGreaterThanOrEqual(0);
    expect(assignmentAt).toBeGreaterThan(defaultAt);
    expect(body).not.toMatch(/lockPriceListRow/);
    expect(body).not.toMatch(/FOR UPDATE[\s\S]{0,80}price_list[^\w]/);
    expect(body).not.toMatch(/FOR SHARE[\s\S]{0,80}price_list[^\w]/);
  });

  it("transferPriceListOwnership takes the advisory key before the master row lock", () => {
    const source = stripComments(
      readFileSync(join(srcRoot, "priceListService.ts"), "utf8"),
    );
    const body = functionBody(source, "transferPriceListOwnership");
    expect(body.length).toBeGreaterThan(0);
    const keyAt = body.indexOf("price-list-assignments:");
    const lockCallAt = body.indexOf("lockPriceListAssignments(");
    const rowLockAt = body.indexOf("lockPriceListRow(");
    expect(lockCallAt).toBeGreaterThanOrEqual(0);
    expect(rowLockAt).toBeGreaterThan(lockCallAt);
    expect(keyAt === -1 || keyAt < rowLockAt).toBe(true);
  });

  it("closePriceListEntry takes no advisory lock, no FOR SHARE, and no master or assignment tables", () => {
    const source = stripComments(
      readFileSync(join(srcRoot, "priceListEntryService.ts"), "utf8"),
    );
    const body = functionBody(source, "closePriceListEntry");
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/pg_advisory_xact_lock/);
    expect(body).not.toMatch(/FOR SHARE/);
    expect(body).not.toContain("price_list_legal_entity_assignment");
    expect(body).not.toContain("catalog_item_legal_entity_assignment");
    expect(body).not.toMatch(/price_list[^\w]/);
    expect(body).not.toMatch(/catalog_item[^\w]/);
  });
});

describe("public barrel", () => {
  it("exports pricing functions and omits archive and delete surfaces", () => {
    for (const name of PRICING_EXPORTS) {
      expect(catalog, name).toHaveProperty(name);
    }
    expect(catalog).not.toHaveProperty("archivePriceList");
    expect(catalog).not.toHaveProperty("deletePriceListEntry");
    expect(catalog).not.toHaveProperty("archivePriceListEntry");
    expect(catalog).not.toHaveProperty("lockPriceListRow");
    expect(Object.keys(catalog).filter((k) => k.startsWith("delete"))).toEqual([]);
  });
});
