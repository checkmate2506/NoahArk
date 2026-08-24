#!/usr/bin/env -S npx tsx
/**
 * F-14 (Phase 1B.1): validates openapi.yaml with a maintained, real OpenAPI
 * parser (@apidevtools/swagger-parser — dereferences every $ref and
 * validates against the OpenAPI 3.1 schema itself, not a hand-rolled
 * check). Exit code 0 = valid. Exit code 1 = invalid or a read error.
 *
 * This is deliberately separate from the route-inventory conformance test
 * (tests/integration/openApiConformance.test.ts, no DB needed either) —
 * that test proves every ROUTE has a matching OpenAPI operation; this
 * script proves the SPEC ITSELF is a well-formed, internally-consistent
 * OpenAPI document (no dangling $refs, valid schema shapes, etc).
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";

async function main(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const specPath = join(__dirname, "..", "openapi.yaml");
  await SwaggerParser.validate(specPath);
  console.warn("openapi.yaml is valid.");
}

main().catch((e) => {
  console.error("openapi.yaml is INVALID:");
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
