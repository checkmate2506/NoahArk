import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("@noahark/catalog package boundary", () => {
  it("has exactly the allowed runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({
      "@noahark/audit": "workspace:*",
      "@noahark/core": "workspace:*",
      "@noahark/db": "workspace:*",
      zod: "4.4.3",
    });
  });

  it("does not import forbidden packages or escape the package", () => {
    const files = walkTsFiles(join(pkgRoot, "src")).filter(
      (f) => !f.endsWith(".test.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const specs = [
        ...text.matchAll(
          /(?:from|import)\s+["']([^"']+)["']|require\(["']([^"']+)["']\)/g,
        ),
      ].map((m) => m[1] ?? m[2] ?? "");
      if (
        specs.some(
          (spec) =>
            spec.startsWith("@noahark/crm") ||
            spec.startsWith("@noahark/purchasing") ||
            spec.startsWith("@noahark/authz") ||
            spec === "@noahark/db/system" ||
            spec === "@noahark/db/worker" ||
            spec.includes("apps/web") ||
            spec.startsWith("../../"),
        )
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
