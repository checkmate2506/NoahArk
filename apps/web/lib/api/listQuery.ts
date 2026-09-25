import { ValidationError } from "@noahark/core";

export const LIST_QUERY_STRING = "string";
export const LIST_QUERY_INTEGER = "integer";
export const LIST_QUERY_BOOLEAN = "boolean";

export type ListQueryFieldKind =
  typeof LIST_QUERY_STRING | typeof LIST_QUERY_INTEGER | typeof LIST_QUERY_BOOLEAN;

export type ListQuerySpec = Readonly<Record<string, ListQueryFieldKind>>;

export type ListQueryValue = string | number | boolean;

const INTEGER_PATTERN = /^-?(?:0|[1-9][0-9]*)$/;

function uniqueKeys(searchParams: URLSearchParams): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const key of searchParams.keys()) {
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function singletonValue(searchParams: URLSearchParams, key: string): string {
  const values = searchParams.getAll(key);
  if (values.length !== 1) {
    throw new ValidationError(`Query parameter "${key}" must be supplied at most once`);
  }
  const value = values[0];
  if (value === undefined || value === "") {
    throw new ValidationError(`Query parameter "${key}" must not be empty`);
  }
  return value;
}

function coerceInteger(key: string, raw: string): number {
  if (!INTEGER_PATTERN.test(raw)) {
    throw new ValidationError(`Query parameter "${key}" must be an integer`);
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(n)) {
    throw new ValidationError(`Query parameter "${key}" must be an integer`);
  }
  return n;
}

function coerceBoolean(key: string, raw: string): boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new ValidationError(`Query parameter "${key}" must be true or false`);
}

/**
 * Converts URL query strings into values domain Zod schemas already expect.
 * Domain schemas remain authoritative for bounds (for example limit 1–100).
 * This helper never uses `z.coerce`, never treats `"1"` as boolean true,
 * and never silently accepts partial numbers.
 */
export function parseListQuery(
  searchParams: URLSearchParams,
  spec: ListQuerySpec,
): Record<string, ListQueryValue> {
  const allowed = new Set(Object.keys(spec));
  for (const key of uniqueKeys(searchParams)) {
    if (!allowed.has(key)) {
      throw new ValidationError(`Unknown query parameter "${key}"`);
    }
  }

  const result: Record<string, ListQueryValue> = {};
  for (const [key, kind] of Object.entries(spec)) {
    if (!searchParams.has(key)) continue;
    const raw = singletonValue(searchParams, key);
    if (kind === LIST_QUERY_INTEGER) {
      result[key] = coerceInteger(key, raw);
      continue;
    }
    if (kind === LIST_QUERY_BOOLEAN) {
      result[key] = coerceBoolean(key, raw);
      continue;
    }
    result[key] = raw;
  }
  return result;
}
