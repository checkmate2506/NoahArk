import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "@noahark/audit";

const srcRoot = fileURLToPath(new URL(".", import.meta.url));

const CUSTOM_FIELD_ACTIONS = [
  AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_CREATED,
  AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_UPDATED,
  AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_DEACTIVATED,
  AUDIT_ACTIONS.CUSTOM_FIELD_DEFINITION_ACTIVATED,
  AUDIT_ACTIONS.CUSTOM_FIELD_VALUE_CREATED,
  AUDIT_ACTIONS.CUSTOM_FIELD_VALUE_UPDATED,
] as const;

const SERVICE_FILES = ["customFieldDefinitionService.ts", "customFieldValueService.ts"];

function walkProductionTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...walkProductionTs(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("custom-field audit actions", () => {
  const production = walkProductionTs(srcRoot)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const serviceSource = SERVICE_FILES.map((name) =>
    readFileSync(new URL(`./${name}`, import.meta.url), "utf8"),
  ).join("\n");

  it("references each of the six custom-field constants from production services", () => {
    expect(CUSTOM_FIELD_ACTIONS).toHaveLength(6);
    for (const action of CUSTOM_FIELD_ACTIONS) {
      const constName = Object.entries(AUDIT_ACTIONS).find(([, v]) => v === action)?.[0];
      expect(constName).toBeDefined();
      expect(serviceSource).toContain(`AUDIT_ACTIONS.${constName}`);
    }
  });

  it("does not define deleted, cleared or archived custom-field actions", () => {
    expect("CUSTOM_FIELD_DEFINITION_DELETED" in AUDIT_ACTIONS).toBe(false);
    expect("CUSTOM_FIELD_VALUE_DELETED" in AUDIT_ACTIONS).toBe(false);
    expect("CUSTOM_FIELD_VALUE_CLEARED" in AUDIT_ACTIONS).toBe(false);
    expect("CUSTOM_FIELD_DEFINITION_ARCHIVED" in AUDIT_ACTIONS).toBe(false);
    expect(production).not.toContain("custom_field_definition.deleted");
    expect(production).not.toContain("custom_field_value.deleted");
    expect(production).not.toContain("custom_field_value.cleared");
    expect(production).not.toContain("custom_field_definition.archived");
  });

  it("uses constants at every writeAuditEvent call site", () => {
    const sites = [
      ...serviceSource.matchAll(/writeAuditEvent\s*\([\s\S]*?action:\s*([^\n,]+)/g),
    ];
    expect(sites.length).toBeGreaterThan(0);
    for (const site of sites) {
      expect(site[1]?.trim()).toMatch(/^AUDIT_ACTIONS\./);
    }
  });
});
