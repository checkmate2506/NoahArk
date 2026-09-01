import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "@noahark/audit";

const srcRoot = fileURLToPath(new URL(".", import.meta.url));

const CATALOG_ACTIONS = [
  AUDIT_ACTIONS.CATALOG_CATEGORY_CREATED,
  AUDIT_ACTIONS.CATALOG_CATEGORY_UPDATED,
  AUDIT_ACTIONS.CATALOG_CATEGORY_DEACTIVATED,
  AUDIT_ACTIONS.CATALOG_CATEGORY_ACTIVATED,
  AUDIT_ACTIONS.UNIT_OF_MEASURE_CREATED,
  AUDIT_ACTIONS.UNIT_OF_MEASURE_UPDATED,
  AUDIT_ACTIONS.UNIT_OF_MEASURE_DEACTIVATED,
  AUDIT_ACTIONS.UNIT_OF_MEASURE_ACTIVATED,
  AUDIT_ACTIONS.CATALOG_ITEM_CREATED,
  AUDIT_ACTIONS.CATALOG_ITEM_UPDATED,
  AUDIT_ACTIONS.CATALOG_ITEM_OWNERSHIP_TRANSFERRED,
  AUDIT_ACTIONS.CATALOG_ITEM_ASSIGNMENT_CREATED,
  AUDIT_ACTIONS.CATALOG_ITEM_ASSIGNMENT_UPDATED,
  AUDIT_ACTIONS.CATALOG_ITEM_ASSIGNMENT_ARCHIVED,
] as const;

function walkProductionTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkProductionTs(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("catalog audit actions", () => {
  const production = walkProductionTs(srcRoot)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  it("references each of the 14 catalog constants from production services", () => {
    expect(CATALOG_ACTIONS).toHaveLength(14);
    for (const action of CATALOG_ACTIONS) {
      const constName = Object.entries(AUDIT_ACTIONS).find(([, v]) => v === action)?.[0];
      expect(constName).toBeDefined();
      expect(production).toContain(`AUDIT_ACTIONS.${constName}`);
    }
  });

  it("does not define CATALOG_ITEM_ARCHIVED", () => {
    expect("CATALOG_ITEM_ARCHIVED" in AUDIT_ACTIONS).toBe(false);
    expect(production).not.toContain("CATALOG_ITEM_ARCHIVED");
    expect(production).not.toContain("catalog_item.archived");
  });

  it("uses constants at every writeAuditEvent call site", () => {
    const sites = [
      ...production.matchAll(/writeAuditEvent\s*\([\s\S]*?action:\s*([^\n,]+)/g),
    ];
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(site[1]?.trim()).toMatch(/^AUDIT_ACTIONS\./);
    }
  });
});
