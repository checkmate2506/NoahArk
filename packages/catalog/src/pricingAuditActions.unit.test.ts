import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "@noahark/audit";

const srcRoot = fileURLToPath(new URL(".", import.meta.url));

const PRICING_ACTIONS = [
  AUDIT_ACTIONS.PRICE_LIST_CREATED,
  AUDIT_ACTIONS.PRICE_LIST_UPDATED,
  AUDIT_ACTIONS.PRICE_LIST_OWNERSHIP_TRANSFERRED,
  AUDIT_ACTIONS.PRICE_LIST_ASSIGNMENT_CREATED,
  AUDIT_ACTIONS.PRICE_LIST_ASSIGNMENT_UPDATED,
  AUDIT_ACTIONS.PRICE_LIST_ASSIGNMENT_ARCHIVED,
  AUDIT_ACTIONS.PRICE_LIST_DEFAULT_CHANGED,
  AUDIT_ACTIONS.PRICE_LIST_ENTRY_CREATED,
  AUDIT_ACTIONS.PRICE_LIST_ENTRY_UPDATED,
  AUDIT_ACTIONS.PRICE_LIST_ENTRY_CLOSED,
] as const;

const PRICING_FILES = [
  "priceListService.ts",
  "priceListAssignmentService.ts",
  "priceListEntryService.ts",
];

function walkProductionTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...walkProductionTs(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("pricing audit actions", () => {
  const production = walkProductionTs(srcRoot)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const pricingSource = PRICING_FILES.map((name) =>
    readFileSync(new URL(`./${name}`, import.meta.url), "utf8"),
  ).join("\n");

  it("references each of the ten pricing constants from production services", () => {
    expect(PRICING_ACTIONS).toHaveLength(10);
    for (const action of PRICING_ACTIONS) {
      const constName = Object.entries(AUDIT_ACTIONS).find(([, v]) => v === action)?.[0];
      expect(constName).toBeDefined();
      expect(pricingSource).toContain(`AUDIT_ACTIONS.${constName}`);
    }
  });

  it("does not define PRICE_LIST_ARCHIVED", () => {
    expect("PRICE_LIST_ARCHIVED" in AUDIT_ACTIONS).toBe(false);
    expect(production).not.toContain("PRICE_LIST_ARCHIVED");
    expect(production).not.toContain("price_list.archived");
  });

  it("uses constants at every writeAuditEvent call site", () => {
    const sites = [
      ...pricingSource.matchAll(/writeAuditEvent\s*\([\s\S]*?action:\s*([^\n,]+)/g),
    ];
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(site[1]?.trim()).toMatch(/^AUDIT_ACTIONS\./);
    }
  });
});
