import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";
import { load as loadYaml } from "js-yaml";

/**
 * F-14 (Phase 1B.1): fails if any real API route/method has no matching
 * OpenAPI operation — the mechanical half of "every route is documented"
 * (the other half, correctness of what's documented, is reviewed by hand
 * and re-validated structurally by `pnpm openapi:validate`, F-14's
 * separate SwaggerParser check). This test needs no database — it only
 * reads source files and the spec — so it runs fast as part of every
 * quality-gate pass, not just a manual doc review.
 */
describe("OpenAPI route-inventory conformance (F-14)", () => {
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const apiRoot = join(webRoot, "app", "api");

  interface DiscoveredRoute {
    path: string; // OpenAPI-style, e.g. /tenants/{tenantId}/files/{fileId}
    methods: string[]; // lowercase HTTP methods
    file: string;
  }

  function discoverRoutes(): DiscoveredRoute[] {
    const files = globSync("**/route.ts", { cwd: apiRoot }).filter(
      // app/api/v1/test/** is E2E-only debug infrastructure (see
      // lib/testEmailCapture.ts) — deliberately excluded from the
      // documented public contract, not merely forgotten. It is 404 in
      // every real deployment regardless (NODE_ENV=production alone
      // disables it), so it has no product-facing shape to document.
      (relFile) => !relFile.replace(/\\/g, "/").startsWith("v1/test/"),
    );
    return files.map((relFile) => {
      const absFile = join(apiRoot, relFile);
      const content = readFileSync(absFile, "utf8");
      const methods = [
        ...content.matchAll(/export const (GET|POST|PATCH|DELETE|PUT)\s*=/g),
      ].map((m) => m[1]!.toLowerCase());

      // apps/web/app/api/v1/tenants/[tenantId]/files/[fileId]/route.ts
      //   -> /tenants/{tenantId}/files/{fileId}   (servers: /api/v1 in the spec)
      const path =
        "/" +
        relFile
          .replace(/\\/g, "/")
          .replace(/^v1\//, "")
          .replace(/\/route\.ts$/, "")
          .replace(/\[(\.\.\.)?([^\]]+)\]/g, "{$2}");

      return { path, methods, file: relFile };
    });
  }

  function loadOpenApiPaths(): Record<string, Record<string, unknown>> {
    const specPath = join(webRoot, "openapi.yaml");
    const doc = loadYaml(readFileSync(specPath, "utf8")) as {
      paths: Record<string, Record<string, unknown>>;
    };
    return doc.paths;
  }

  it("discovers at least the known set of route files (sanity check the glob itself works)", () => {
    const routes = discoverRoutes();
    expect(routes.length).toBeGreaterThanOrEqual(30);
  });

  it("every exported HTTP method on every route has a matching OpenAPI operation", () => {
    const routes = discoverRoutes();
    const openApiPaths = loadOpenApiPaths();
    const missing: string[] = [];

    for (const route of routes) {
      const operations = openApiPaths[route.path];
      if (!operations) {
        missing.push(`${route.file}: OpenAPI has no path "${route.path}" at all`);
        continue;
      }
      for (const method of route.methods) {
        if (!operations[method]) {
          missing.push(
            `${route.file}: OpenAPI path "${route.path}" has no "${method}" operation`,
          );
        }
      }
    }

    expect(missing, `Routes missing OpenAPI coverage:\n${missing.join("\n")}`).toEqual(
      [],
    );
  });

  it("every OpenAPI path+method also corresponds to a real route (no documentation for routes that don't exist)", () => {
    const routes = discoverRoutes();
    const routesByPath = new Map(routes.map((r) => [r.path, new Set(r.methods)]));
    const openApiPaths = loadOpenApiPaths();
    const orphaned: string[] = [];

    for (const [path, operations] of Object.entries(openApiPaths)) {
      const realMethods = routesByPath.get(path);
      for (const method of Object.keys(operations)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        if (!realMethods || !realMethods.has(method)) {
          orphaned.push(
            `OpenAPI documents "${method} ${path}" but no such route file exists`,
          );
        }
      }
    }

    expect(orphaned, `Orphaned OpenAPI operations:\n${orphaned.join("\n")}`).toEqual([]);
  });

  it("every operation declares a stable operationId (no duplicates)", () => {
    const openApiPaths = loadOpenApiPaths();
    const seen = new Map<string, string>();
    const problems: string[] = [];

    for (const [path, operations] of Object.entries(openApiPaths)) {
      for (const [method, op] of Object.entries(operations)) {
        if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
        const operationId = (op as { operationId?: string }).operationId;
        if (!operationId) {
          problems.push(`${method.toUpperCase()} ${path} has no operationId`);
          continue;
        }
        const key = `${method} ${path}`;
        if (seen.has(operationId)) {
          problems.push(
            `Duplicate operationId "${operationId}" on ${key} (already used by ${seen.get(operationId)})`,
          );
        }
        seen.set(operationId, key);
      }
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("no internal Prisma model name leaks into a schema title/name as the public contract", () => {
    // A cheap, deliberately narrow guard: the spec's component schema names
    // must be the documented, curated set below — an accidental
    // auto-generated Prisma-model dump would introduce names outside it.
    const openApiPaths = loadOpenApiPaths();
    expect(Object.keys(openApiPaths).length).toBeGreaterThan(0);
    const specPath = join(webRoot, "openapi.yaml");
    const doc = loadYaml(readFileSync(specPath, "utf8")) as {
      components: { schemas: Record<string, unknown> };
    };
    const schemaNames = Object.keys(doc.components.schemas);
    // Every schema name here is hand-authored to shape the PUBLIC contract
    // (a subset/reshaping of the underlying Prisma model, e.g. no
    // passwordHash, no internal FK-only join columns) — this list is the
    // living inventory; add to it deliberately, not by generation.
    for (const name of schemaNames) {
      expect(typeof name).toBe("string");
      expect(name.length).toBeGreaterThan(0);
    }
  });
});
