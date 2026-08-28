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

describe("@noahark/core dependency boundary", () => {
  it("has no runtime dependencies in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it("contains no @noahark/*, database, or web imports in src", () => {
    const files = walkTsFiles(join(pkgRoot, "src"));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(".test.ts")) continue;
      const text = readFileSync(file, "utf8");
      const importHits = [
        ...text.matchAll(
          /(?:from|import)\s+["']([^"']+)["']|require\(["']([^"']+)["']\)/g,
        ),
      ].map((m) => m[1] ?? m[2] ?? "");
      if (
        importHits.some(
          (spec) =>
            spec.startsWith("@noahark/") ||
            spec === "pg" ||
            spec.startsWith("@prisma/") ||
            spec === "next" ||
            spec.includes("apps/web"),
        )
      ) {
        offenders.push(file.replace(pkgRoot, "packages/core"));
      }
    }
    expect(offenders).toEqual([]);
  });
});
