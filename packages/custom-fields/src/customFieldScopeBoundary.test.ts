import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findBannedTokens } from "./bannedTokenScan";
import * as customFields from "./index";

const srcRoot = fileURLToPath(new URL(".", import.meta.url));

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

const BANNED = [
  "set_config",
  "app.tenant_id",
  "app.legal_entity_ids",
  "deleteMany",
  "clearCustomFieldValue",
  "unsetCustomFieldValue",
  "deleteCustomFieldValue",
  "archiveCustomField",
  "getSystemClient",
  "getWorkerClient",
  "createSystemClient",
  "buildAuditEventRow",
  "Date.now",
  "new Date()",
  "parseFloat",
  "parseInt",
  "demo_approval_subject",
  "MULTI_SELECT",
  "catalog-item-assignments:",
  "price-list-assignments:",
  "price-list-default:",
];

const PRODUCTION_FILES = [
  "index.ts",
  "schemas.ts",
  "typedValue.ts",
  "targets.ts",
  "locking.ts",
  "errors.ts",
  "audit.ts",
  "bannedTokenScan.ts",
  "customFieldDefinitionService.ts",
  "customFieldValueService.ts",
] as const;

const SERVICE_EXPORTS = [
  "createCustomFieldDefinition",
  "getCustomFieldDefinition",
  "listCustomFieldDefinitions",
  "updateCustomFieldDefinition",
  "deactivateCustomFieldDefinition",
  "activateCustomFieldDefinition",
  "setCustomFieldValue",
  "getCustomFieldValue",
  "listCustomFieldValues",
] as const;

function walkProductionTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) out.push(...walkProductionTs(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("findBannedTokens", () => {
  it("uses word boundaries and is non-vacuous", () => {
    expect(findBannedTokens("hello set_config world", ["set_config", "absent"])).toEqual([
      "set_config",
    ]);
    expect(findBannedTokens("clean source", ["set_config"])).toEqual([]);
    expect(
      findBannedTokens("deleteCustomFieldValue(", ["deleteCustomFieldValue"]),
    ).toEqual(["deleteCustomFieldValue"]);
    expect(
      findBannedTokens("deleteCustomFieldValueRow", ["deleteCustomFieldValue"]),
    ).toEqual([]);
  });
});

describe("custom-fields production source scope", () => {
  const files = PRODUCTION_FILES.map((name) => join(srcRoot, name));
  const combined = files.map((f) => stripComments(readFileSync(f, "utf8"))).join("\n");

  it("scans a non-empty production file list", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => !f.endsWith(".test.ts"))).toBe(true);
  });

  it("contains none of the banned tokens", () => {
    expect(findBannedTokens(combined, BANNED)).toEqual([]);
    expect(combined).not.toMatch(/\.delete\s*\(/);
    expect(combined).not.toMatch(/\bNUMBER\b/);
  });

  it("does not persist a second audit writer", () => {
    const audit = readFileSync(join(srcRoot, "audit.ts"), "utf8");
    expect(audit).toContain("writeAuditEventInTx");
    expect(audit).not.toContain("tx.auditEvent.create");
  });

  it("does not expose OpenAPI, permission or UI surfaces", () => {
    expect(combined).not.toMatch(/\bopenapi\b/i);
    expect(combined).not.toMatch(/\bpermission\b/);
    expect(combined).not.toMatch(/\bjsx\b/i);
  });

  it("setCustomFieldValue lock order is advisory, definition, target, value, audit", () => {
    const source = stripComments(
      readFileSync(join(srcRoot, "customFieldValueService.ts"), "utf8"),
    );
    const body = functionBody(source, "setCustomFieldValue");
    expect(body.length).toBeGreaterThan(0);
    const advisoryAt = body.indexOf("acquireCustomFieldValueLock(");
    const definitionAt = body.indexOf("lockDefinitionForShare(");
    const targetAt = body.indexOf("shareAndResolveTarget(");
    const valueAt = body.indexOf("lockCustomFieldValueForUpdate(");
    const auditAt = body.indexOf("writeAuditEvent(");
    expect(advisoryAt).toBeGreaterThanOrEqual(0);
    expect(definitionAt).toBeGreaterThan(advisoryAt);
    expect(targetAt).toBeGreaterThan(definitionAt);
    expect(valueAt).toBeGreaterThan(targetAt);
    expect(auditAt).toBeGreaterThan(valueAt);
    expect(body).not.toMatch(/catalog-item-assignments:/);
    expect(body).not.toMatch(/price-list-assignments:/);
    expect(body).not.toMatch(/price-list-default:/);
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

  it("production files do not mention a JSON public contract", () => {
    const production = walkProductionTs(srcRoot)
      .filter((f) => !f.endsWith("bannedTokenScan.ts"))
      .map((f) => stripComments(readFileSync(f, "utf8")))
      .join("\n");
    expect(production).not.toMatch(/legacy JSON/i);
    expect(production).not.toMatch(/valueJson/);
  });
});

describe("public barrel", () => {
  it("exports the approved service surface and not deletion primitives", () => {
    for (const name of SERVICE_EXPORTS) {
      expect(customFields, name).toHaveProperty(name);
    }
    expect(SERVICE_EXPORTS).toHaveLength(9);
    expect(customFields).not.toHaveProperty("clearCustomFieldValue");
    expect(customFields).not.toHaveProperty("deleteCustomFieldValue");
    expect(customFields).not.toHaveProperty("unsetCustomFieldValue");
    expect(customFields).not.toHaveProperty("findBannedTokens");
    expect(Object.keys(customFields).filter((k) => k.startsWith("delete"))).toEqual([]);
    expect(Object.keys(customFields).filter((k) => k.startsWith("clear"))).toEqual([]);
  });
});
