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

const EXCLUSION_MARKERS = new Set(["23P01", "exclusion_violation"]);
const MAX_EXCLUSION_DEPTH = 12;

/**
 * Dedicated detector for gist exclusion failures. Inspects only structured
 * fields demonstrated by the live Prisma adapter probe (P2039 wrapping
 * nested code/originalCode 23P01, kind postgres): code, originalCode,
 * kind, cause, and meta.driverAdapterError. Cycle-guarded and depth-bounded.
 * Does not substring-scan message text. Unrecognised shapes return false so
 * mapCatalogDbError rethrows unchanged. sqlState() is deliberately not used
 * and must remain byte-identical.
 */
function isExclusionViolation(error: unknown): boolean {
  const seen = new Set<unknown>();

  function walk(node: unknown, depth: number): boolean {
    if (!node || typeof node !== "object" || depth > MAX_EXCLUSION_DEPTH) {
      return false;
    }
    if (seen.has(node)) return false;
    seen.add(node);
    const rec = node as {
      code?: unknown;
      originalCode?: unknown;
      kind?: unknown;
      cause?: unknown;
      meta?: { driverAdapterError?: unknown };
    };
    if (typeof rec.code === "string" && EXCLUSION_MARKERS.has(rec.code)) return true;
    if (typeof rec.originalCode === "string" && EXCLUSION_MARKERS.has(rec.originalCode)) {
      return true;
    }
    if (typeof rec.kind === "string" && EXCLUSION_MARKERS.has(rec.kind)) return true;
    if (walk(rec.cause, depth + 1)) return true;
    if (walk(rec.meta?.driverAdapterError, depth + 1)) return true;
    return false;
  }

  return walk(error, 0);
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

  if (isExclusionViolation(error)) {
    throw new ConflictError("A price for this item already covers part of that period");
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
      if (target.includes("price_list_tenant_id_code")) {
        throw new ConflictError("Price list code is already in use");
      }
      if (target.includes("price_list_id") && target.includes("legal_entity_id")) {
        throw new ConflictError(
          "This price list is already assigned to that legal entity",
        );
      }
      if (target.includes("price_list_assignment_one_default_per_entity")) {
        throw new ConflictError("That legal entity already has a default price list");
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
