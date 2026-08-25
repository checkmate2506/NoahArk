import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 2A: `party_address.country_code` records a counterparty's postal
 * country descriptively — an SG company routinely invoices customers outside
 * SG/MY/ID, and refusing to store that would make the product unusable for its
 * own target market.
 *
 * The risk is not STORING a foreign country; it is INFERRING localisation from
 * one. NoahArk localises for exactly three jurisdictions, and jurisdiction is a
 * property of the LEGAL ENTITY (`legal_entity.jurisdiction`, the `Jurisdiction`
 * enum), never of a counterparty's address. If `countryCode` were ever allowed
 * to select a tax, payroll, holiday, language, numbering or statutory adapter,
 * NoahArk would be silently claiming compliance for a country it has never
 * verified — the exact failure PRODUCT_VISION.md §3 forbids.
 *
 * Two independent defences exist:
 *   1. TYPE — `PartyAddress.countryCode` is a plain `String @db.Char(2)`,
 *      deliberately NOT the `Jurisdiction` enum, so the two cannot be
 *      interchanged by accident.
 *   2. THIS GUARD — production source must not mention an address country code
 *      in the same construct as adapter/jurisdiction resolution.
 */
const REPO_ROOT = join(__dirname, "..", "..", "..");

const SCAN_ROOTS = [
  join(REPO_ROOT, "apps", "web", "app"),
  join(REPO_ROOT, "apps", "web", "components"),
  join(REPO_ROOT, "apps", "web", "lib"),
  join(REPO_ROOT, "apps", "web", "scripts"),
  join(REPO_ROOT, "packages"),
];

/** No production call site is currently allowlisted. */
const ALLOWED_RELATIVE_PATHS = new Set<string>();

/**
 * An address-country identifier appearing within the same expression as an
 * adapter/jurisdiction lookup. Matched on a single line deliberately: the aim
 * is to catch `resolveAdapter(address.countryCode)`-shaped code, not to ban the
 * two words from ever coexisting in a file.
 */
const ADAPTER_SELECTORS =
  /(adapter|jurisdiction|taxRule|taxRuleset|payrollRule|holidayCalendar|statutor|localis|localiz|countryRuleSet)/i;
const ADDRESS_COUNTRY =
  /(address[A-Za-z]*\.countryCode|countryCode\s*:\s*address|party[A-Za-z]*\.countryCode|country_code)/i;

function isTestFile(fileName: string): boolean {
  return /\.test\.(ts|tsx)$/.test(fileName);
}

function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    if (entry === "generated") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else if (/\.(ts|tsx|mjs)$/.test(entry) && !isTestFile(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Exported so the adversarial proof can point it at a synthetic tree. */
export function scanForAddressCountryAdapterUse(roots: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of listFilesRecursive(root)) {
      const relPath = relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (ALLOWED_RELATIVE_PATHS.has(relPath)) continue;
      const content = readFileSync(file, "utf8");
      for (const line of content.split(/\r?\n/)) {
        if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) {
          continue; // prose, not code
        }
        if (ADDRESS_COUNTRY.test(line) && ADAPTER_SELECTORS.test(line)) {
          offenders.push(`${relPath}: ${line.trim().slice(0, 120)}`);
          break;
        }
      }
    }
  }
  return offenders;
}

describe("address-country adapter boundary (Phase 2A)", () => {
  it("no production source resolves a localisation adapter from an address country code", () => {
    expect(
      scanForAddressCountryAdapterUse(SCAN_ROOTS),
      "A counterparty's address country is DESCRIPTIVE only. Localisation, tax, " +
        "payroll, holiday, language and statutory behaviour resolve from the legal " +
        "entity's `jurisdiction` (SG/MY/ID), never from an address.",
    ).toEqual([]);
  });

  it("PartyAddress.countryCode is not typed as the Jurisdiction enum", () => {
    const schema = readFileSync(
      join(REPO_ROOT, "packages", "db", "prisma", "schema.prisma"),
      "utf8",
    );
    const model = /model PartyAddress \{[\s\S]*?\n\}/.exec(schema)?.[0] ?? "";
    expect(model, "PartyAddress model not found in schema").not.toBe("");
    expect(model).toMatch(
      /countryCode\s+String\s+@map\("country_code"\)\s+@db\.Char\(2\)/,
    );
    expect(
      model,
      "countryCode must never be the Jurisdiction enum — that would conflate a " +
        "counterparty's postal country with a NoahArk operating jurisdiction",
    ).not.toMatch(/countryCode\s+Jurisdiction/);
  });

  it("the Jurisdiction enum remains exactly SG/MY/ID", () => {
    const schema = readFileSync(
      join(REPO_ROOT, "packages", "db", "prisma", "schema.prisma"),
      "utf8",
    );
    const enumBlock = /enum Jurisdiction \{([\s\S]*?)\}/.exec(schema)?.[1] ?? "";
    const members = enumBlock
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//"));
    expect(members).toEqual(["SG", "MY", "ID"]);
  });
});
