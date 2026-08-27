import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  StaleVersionError,
  ValidationError,
} from "@noahark/core";
import { Prisma } from "@noahark/db";

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

export function mapPartyDbError(error: unknown, resource: string): never {
  const state = sqlState(error);

  if (state === "42501") {
    throw new NotFoundError(resource);
  }
  if (state === "23505") {
    throw new ConflictError(`${resource} conflicts with an existing record`);
  }
  if (state === "23514") {
    throw new ValidationError(`${resource} failed a database constraint`);
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      const target = p2002Target(error);
      if (target.includes("code")) {
        throw new ConflictError(`${resource} code is already in use`);
      }
      if (target.includes("is_primary") || target.includes("party_contact_one_primary")) {
        throw new ConflictError("A party may have only one primary contact");
      }
      if (target.includes("party_id") && target.includes("legal_entity_id")) {
        throw new ConflictError("This party is already assigned to that legal entity");
      }
      if (target.includes("assignment_id")) {
        throw new ConflictError(`${resource} already exists for this assignment`);
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

export function staleOrNotFound(
  visible: { version: number } | null,
  expectedVersion: number,
  resource: string,
  canMutate: boolean,
): never {
  if (!visible) throw new NotFoundError(resource);
  if (visible.version !== expectedVersion) throw new StaleVersionError(resource);
  if (!canMutate) throw new ForbiddenError("Not permitted");
  throw new StaleVersionError(resource);
}
