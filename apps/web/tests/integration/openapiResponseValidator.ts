import { expect } from "vitest";
import { load as loadYaml } from "js-yaml";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type OpenApiSchema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema;
  items?: OpenApiSchema;
  enum?: unknown[];
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
};

type OpenApiDoc = {
  components?: { schemas?: Record<string, OpenApiSchema> };
  paths: Record<string, Record<string, unknown>>;
};

export const OPENAPI_DOC = loadYaml(
  readFileSync(join(process.cwd(), "openapi.yaml"), "utf8"),
) as OpenApiDoc;

export function resolveOpenApiSchema(
  doc: OpenApiDoc,
  schema: OpenApiSchema | undefined,
): OpenApiSchema {
  if (!schema?.$ref) return schema ?? {};
  const prefix = "#/components/schemas/";
  if (!schema.$ref.startsWith(prefix)) {
    throw new Error(`Unsupported OpenAPI $ref ${schema.$ref}`);
  }
  const name = schema.$ref.slice(prefix.length);
  const resolved = doc.components?.schemas?.[name];
  if (!resolved) throw new Error(`Missing OpenAPI schema ${name}`);
  return resolved;
}

function jsonTypeNames(value: unknown): string[] {
  if (value === null) return ["null"];
  if (Array.isArray(value)) return ["array"];
  if (typeof value === "number") {
    return Number.isInteger(value) ? ["integer", "number"] : ["number"];
  }
  return [typeof value];
}

function typeAllowed(schemaType: string | string[] | undefined, value: unknown): boolean {
  if (schemaType === undefined) return true;
  const allowed = Array.isArray(schemaType) ? schemaType : [schemaType];
  const actual = jsonTypeNames(value);
  return allowed.some((type) => actual.includes(type));
}

export function validateOpenApiValue(
  doc: OpenApiDoc,
  schema: OpenApiSchema | undefined,
  value: unknown,
  path: string,
): string[] {
  const resolved = resolveOpenApiSchema(doc, schema);
  if (resolved.oneOf) {
    const branchErrors = resolved.oneOf.map((branch) =>
      validateOpenApiValue(doc, branch, value, path),
    );
    if (branchErrors.some((errors) => errors.length === 0)) return [];
    return [`${path}: no oneOf branch matched`];
  }
  if (resolved.anyOf) {
    const branchErrors = resolved.anyOf.map((branch) =>
      validateOpenApiValue(doc, branch, value, path),
    );
    if (branchErrors.some((errors) => errors.length === 0)) return [];
    return [`${path}: no anyOf branch matched`];
  }
  const errors: string[] = [];
  if (!typeAllowed(resolved.type, value)) {
    errors.push(`${path}: expected type ${JSON.stringify(resolved.type)}`);
    return errors;
  }
  if (resolved.enum) {
    const matched = resolved.enum.some((item) => Object.is(item, value));
    if (!matched) errors.push(`${path}: value not in enum`);
  }
  if (value === null || typeof value !== "object") return errors;
  if (Array.isArray(value)) {
    const itemSchema = resolved.items;
    value.forEach((item, index) => {
      errors.push(...validateOpenApiValue(doc, itemSchema, item, `${path}[${index}]`));
    });
    return errors;
  }
  const rec = value as Record<string, unknown>;
  for (const key of resolved.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(rec, key)) {
      errors.push(`${path}: missing required ${key}`);
    }
  }
  const additional = resolved.additionalProperties;
  for (const [key, child] of Object.entries(rec)) {
    const property = resolved.properties?.[key];
    if (property) {
      errors.push(...validateOpenApiValue(doc, property, child, `${path}.${key}`));
      continue;
    }
    if (additional === false) {
      errors.push(`${path}: additional property ${key}`);
    } else if (additional && typeof additional === "object") {
      errors.push(...validateOpenApiValue(doc, additional, child, `${path}.${key}`));
    }
  }
  return errors;
}

function openApiSuccessSchema(operationId: string): OpenApiSchema {
  for (const pathItem of Object.values(OPENAPI_DOC.paths)) {
    for (const op of Object.values(pathItem)) {
      if (!op || typeof op !== "object" || Array.isArray(op)) continue;
      const rec = op as {
        operationId?: string;
        responses?: Record<
          string,
          { content?: { "application/json"?: { schema?: OpenApiSchema } } }
        >;
      };
      if (rec.operationId !== operationId) continue;
      const success = rec.responses?.["200"] ?? rec.responses?.["201"];
      const schema = success?.content?.["application/json"]?.schema;
      if (!schema) throw new Error(`OpenAPI operation ${operationId} has no 2xx schema`);
      return schema;
    }
  }
  throw new Error(`OpenAPI operation ${operationId} not found`);
}

function assertHasKeys(label: string, value: unknown, keys: string[]) {
  expect(value, label).toBeTruthy();
  expect(typeof value, label).toBe("object");
  const rec = value as Record<string, unknown>;
  for (const key of keys) {
    expect(Object.prototype.hasOwnProperty.call(rec, key), `${label}.${key}`).toBe(true);
  }
}

function assertEnvelope(
  label: string,
  body: Record<string, unknown>,
  dataKeys: string[],
) {
  expect(Object.prototype.hasOwnProperty.call(body, "data"), `${label} data`).toBe(true);
  assertHasKeys(`${label}.data`, body.data, dataKeys);
}

export function assertMatchesOpenApi(
  operationId: string,
  body: Record<string, unknown>,
  dataKeys: string[],
) {
  assertEnvelope(operationId, body, dataKeys);
  const schema = openApiSuccessSchema(operationId);
  const errors = validateOpenApiValue(OPENAPI_DOC, schema, body, operationId);
  expect(errors, `${operationId} nested OpenAPI`).toEqual([]);
  expect(schema.required, `${operationId} OpenAPI envelope`).toEqual(["data"]);
  expect(
    [
      ...(resolveOpenApiSchema(OPENAPI_DOC, schema.properties?.data).required ?? []),
    ].sort(),
    `${operationId} OpenAPI data keys`,
  ).toEqual([...dataKeys].sort());
}
