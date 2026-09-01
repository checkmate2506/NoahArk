import { ConflictError, NotFoundError, ValidationError } from "@noahark/core";
import { Prisma } from "@noahark/db";
import type { z } from "zod";

export function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid input", { issues: parsed.error.issues });
  }
  return parsed.data;
}

function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const rec = current as { code?: unknown; cause?: unknown };
    if (typeof rec.code === "string" && /^\d{5}$/.test(rec.code)) {
      return rec.code;
    }
    current = rec.cause;
  }
  return undefined;
}

function p2002Target(error: Prisma.PrismaClientKnownRequestError): string {
  const target = error.meta?.target;
  if (Array.isArray(target)) return target.map(String).join(",");
  if (typeof target === "string") return target;
  return "";
}

/**
 * A real duplicate insert through the installed Prisma driver adapter raises
 * PrismaClientKnownRequestError with code P2002. `sqlState()` walks the `.cause`
 * chain; the underlying 23505 lives at meta.driverAdapterError.cause.originalCode,
 * which that walk does NOT traverse — so the SQLSTATE branch does not fire and
 * the mapper reaches the P2002 branch. `meta.target` is absent under this adapter
 * (meta is modelName + driverAdapterError), so target refinement yields nothing
 * and the GENERIC P2002 conflict message is the normal path. The nested
 * originalCode is never surfaced to a caller. Do not change the production mapping
 * merely to get a more specific message.
 */
export function mapCatalogDbError(error: unknown, resource: string): never {
  const state = sqlState(error);

  if (state === "42501") {
    throw new NotFoundError(resource);
  }
  if (state === "23505") {
    throw new ConflictError(`${resource} conflicts with an existing record`);
  }
  if (state === "23503") {
    throw new ValidationError(`${resource} references an invalid related record`);
  }
  if (state === "23514") {
    throw new ValidationError(`${resource} failed a database constraint`);
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      const target = p2002Target(error);
      if (target.includes("catalog_item_tenant_id_code")) {
        throw new ConflictError("Catalog item code is already in use");
      }
      if (target.includes("entity_item_code")) {
        throw new ConflictError(
          "Entity item code is already in use for this legal entity",
        );
      }
      if (target.includes("catalog_item_id") && target.includes("legal_entity_id")) {
        throw new ConflictError(
          "This catalog item is already assigned to that legal entity",
        );
      }
      if (target.includes("catalog_category_tenant_id_code")) {
        throw new ConflictError("Category code is already in use");
      }
      if (target.includes("unit_of_measure_tenant_id_code")) {
        throw new ConflictError("Unit of measure code is already in use");
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
