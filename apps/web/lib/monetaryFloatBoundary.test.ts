import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

/**
 * Phase 2A (ADR-71, ADR-73 F-5): monetary and price values are exact
 * `NUMERIC(23,6)` in PostgreSQL and `Prisma.Decimal` in TypeScript.
 *
 * THIS GUARD IS DEFENSE IN DEPTH, not complete semantic proof. It is
 * identifier-based: a rename to an unlisted local (`x`, `qty`, `n`) will
 * bypass it. Independent Sonnet audit F-5 recorded that limitation; it is
 * not concealed. The load-bearing control is the schema — there is no
 * `real` / `double precision` monetary column, and `unit_price` is
 * `DECIMAL(23,6)`.
 *
 * Scope: float COERCION and statically identifiable arithmetic on known
 * money-named identifiers. A blanket ban on `+` in files that mention
 * "price" would flag `priceList.length + 1` and train people to work
 * around the guard.
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
 * Word-boundary money identifiers, including common aliases and renamed
 * variables. Bare `price` / `amount` are whole words so `priceList` and
 * `amountOf` are not matched (false-positive avoidance).
 */
const MONEY_TOKEN = String.raw`(?:unitPrice|unit_price|listPrice|list_price|netPrice|net_price|grossPrice|gross_price|totalPrice|total_price|linePrice|line_price|extendedPrice|extended_price|unitAmount|unit_amount|lineAmount|line_amount|netAmount|net_amount|grossAmount|gross_amount|taxAmount|tax_amount|discountAmount|discount_amount|lineTotal|line_total|unitCost|unit_cost|monetaryValue|monetary_value|currencyValue|currency_value|valueDecimal|value_decimal|unitPrice|\bprice\b|\bamount\b|\bmoney\b)`;

const FLOAT_COERCIONS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  {
    label: "Number() over a monetary value",
    pattern: new RegExp(String.raw`\bNumber\s*\(\s*${MONEY_TOKEN}`, "i"),
  },
  {
    label: "parseFloat() over a monetary value",
    pattern: new RegExp(String.raw`\bparseFloat\s*\(\s*${MONEY_TOKEN}`, "i"),
  },
  {
    label: "parseInt() over a monetary value",
    pattern: new RegExp(String.raw`\bparseInt\s*\(\s*${MONEY_TOKEN}`, "i"),
  },
  {
    label: "unary + coercion of a monetary value",
    pattern: new RegExp(
      String.raw`[=(,\[]\s*\+\s*[A-Za-z_$][A-Za-z0-9_$.]*(?:Price|Amount|price|amount|Money)\b`,
    ),
  },
  {
    label: "Math.* over a monetary value",
    pattern: new RegExp(
      String.raw`\bMath\.(?:round|floor|ceil|abs|trunc|max|min)\s*\(\s*${MONEY_TOKEN}`,
      "i",
    ),
  },
  {
    label: "arithmetic on a known monetary identifier",
    pattern: new RegExp(
      String.raw`(?:${MONEY_TOKEN})\s*(?:\+\+|--|[+\-*/]=|[+\-*/])|(?:\+\+|--|[+\-*/]=|[+\-*/])\s*(?:${MONEY_TOKEN})`,
      "i",
    ),
  },
  {
    label: "float SQL/Prisma type for a monetary column",
    pattern:
      /@db\.(?:DoublePrecision|Real|Float)|\bFloat\b\s*@map\(\s*["'](?:unit_price|price|amount)/,
  },
];

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

/** Exported so the adversarial test below can point it at a synthetic tree. */
export function scanForMonetaryFloatUse(roots: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of listFilesRecursive(root)) {
      const content = readFileSync(file, "utf8");
      const relPath = relative(REPO_ROOT, file).replace(/\\/g, "/");
      if (ALLOWED_RELATIVE_PATHS.has(relPath)) continue;
      for (const { label, pattern } of FLOAT_COERCIONS) {
        if (pattern.test(content)) {
          offenders.push(`${relPath} — ${label}`);
          break;
        }
      }
    }
  }
  return offenders;
}

describe("monetary float boundary (Phase 2A, ADR-71 / ADR-73 F-5)", () => {
  it("no production source file coerces a monetary value into a JS float", () => {
    expect(
      scanForMonetaryFloatUse(SCAN_ROOTS),
      "Monetary values must stay exact: use Prisma.Decimal / NUMERIC(23,6) and " +
        "transport decimals as validated strings. Never Number()/parseFloat()/parseInt()/unary + / " +
        "Math.* or arithmetic over a known price or amount identifier. This scan is defense in depth, not complete proof.",
    ).toEqual([]);
  });

  it("the schema declares no floating-point monetary column (load-bearing control)", () => {
    const schema = readFileSync(
      join(REPO_ROOT, "packages", "db", "prisma", "schema.prisma"),
      "utf8",
    );
    expect(schema).not.toMatch(/@db\.DoublePrecision/);
    expect(schema).not.toMatch(/@db\.Real/);
    expect(schema).toMatch(
      /unitPrice\s+Decimal\s+@map\("unit_price"\)\s+@db\.Decimal\(23, 6\)/,
    );
    expect(schema).toMatch(
      /valueDecimal\s+Decimal\?\s+@map\("value_decimal"\)\s+@db\.Decimal\(23, 6\)/,
    );
  });

  it("does not flag legitimate non-monetary arithmetic or priceList identifiers", () => {
    const dir = mkdtempSync(join(tmpdir(), "noahark-money-ok-"));
    try {
      writeFileSync(
        join(dir, "ok.ts"),
        [
          "const n = priceList.length + 1;",
          "const pages = displayOrder + 1;",
          "const version = row.version + 1;",
          "const max = Math.max(count, 0);",
          "const id = Number(priceListId);",
        ].join("\n"),
        "utf8",
      );
      expect(scanForMonetaryFloatUse([dir])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects aliases, parseInt, Math, Number, parseFloat and identifiable arithmetic (non-vacuous)", () => {
    const dir = mkdtempSync(join(tmpdir(), "noahark-money-bad-"));
    const probes: Array<{ file: string; source: string; label: string }> = [
      {
        file: "number.ts",
        source: "const n = Number(unitPrice);",
        label: "Number() over a monetary value",
      },
      {
        file: "pfloat.ts",
        source: "const n = parseFloat(netAmount);",
        label: "parseFloat() over a monetary value",
      },
      {
        file: "pint.ts",
        source: "const n = parseInt(lineTotal, 10);",
        label: "parseInt() over a monetary value",
      },
      {
        file: "math.ts",
        source: "const n = Math.round(listPrice);",
        label: "Math.* over a monetary value",
      },
      {
        file: "unary.ts",
        source: "const n = +row.unitPrice;",
        label: "unary + coercion of a monetary value",
      },
      {
        file: "add.ts",
        source: "const n = unitPrice + taxAmount;",
        label: "arithmetic on a known monetary identifier",
      },
      {
        file: "alias.ts",
        source: "const n = Number(grossAmount);",
        label: "Number() over a monetary value",
      },
      {
        file: "cost.ts",
        source: "const n = parseFloat(unitCost);",
        label: "parseFloat() over a monetary value",
      },
    ];
    try {
      for (const p of probes) {
        writeFileSync(join(dir, p.file), p.source, "utf8");
      }
      const hits = scanForMonetaryFloatUse([dir]);
      for (const p of probes) {
        expect(
          hits.some((h) => h.includes(p.file) && h.includes(p.label)),
          `probe ${p.file} (${p.source}) must fail the guard`,
        ).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
