import { ConflictError, NotFoundError, ValidationError } from "@noahark/core";
import { Prisma } from "@noahark/db";
import type { z } from "zod";

const MAX_PG_ERROR_DEPTH = 12;
const SQLSTATE_PATTERN = /^\d{5}$/;

export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid input", { issues: parsed.error.issues });
  }
  return parsed.data;
}

/**
 * Cycle-guarded, depth-bounded SQLSTATE extractor. Inspects only structured
 * fields: code, originalCode, cause, meta.driverAdapterError. Exact five-digit
 * SQLSTATE match. Does not read message text.
 */
export function pgErrorCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();

  function walk(node: unknown, depth: number): string | undefined {
    if (!node || typeof node !== "object" || depth > MAX_PG_ERROR_DEPTH) {
      return undefined;
    }
    if (seen.has(node)) return undefined;
    seen.add(node);
    const rec = node as {
      code?: unknown;
      originalCode?: unknown;
      cause?: unknown;
      meta?: { driverAdapterError?: unknown };
    };
    if (typeof rec.code === "string" && SQLSTATE_PATTERN.test(rec.code)) {
      return rec.code;
    }
    if (typeof rec.originalCode === "string" && SQLSTATE_PATTERN.test(rec.originalCode)) {
      return rec.originalCode;
    }
    const fromCause = walk(rec.cause, depth + 1);
    if (fromCause) return fromCause;
    return walk(rec.meta?.driverAdapterError, depth + 1);
  }

  return walk(error, 0);
}

function p2002Target(error: Prisma.PrismaClientKnownRequestError): string {
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.map(String).join(",");
  if (typeof target === "string") return target;
  return "";
}

export function mapCustomFieldDbError(error: unknown, resource: string): never {
  const state = pgErrorCode(error);

  if (state === "42501") {
    throw new NotFoundError(resource);
  }
  if (state === "23505") {
    throw new ConflictError(`${resource} conflicts with an existing record`);
  }
  if (state === "23514") {
    throw new ValidationError("Custom field value failed a storage constraint");
  }
  if (state === "23503") {
    throw new ValidationError(`${resource} references an invalid related record`);
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      const target = p2002Target(error);
      if (target.includes("custom_field_definition_tenant_id_entity_type_key")) {
        throw new ConflictError("Custom field key is already in use");
      }
      if (target.includes("custom_field_value_definition_id_entity_id")) {
        throw new ConflictError("A value already exists for that field and target");
      }
      throw new ConflictError(`${resource} conflicts with an existing record`);
    }
    if (error.code === "P2025") {
      throw new NotFoundError(resource);
    }
    if (error.code === "P2003") {
      throw new ValidationError(`${resource} references an invalid related record`);
    }
  }

  throw error;
}
