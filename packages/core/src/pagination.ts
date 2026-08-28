import { ValidationError } from "./errors";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export function boundPageSize(limit: number | undefined): number {
  const n = limit ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(n) || n < 1) {
    throw new ValidationError("Page size must be a positive integer");
  }
  return Math.min(n, MAX_PAGE_SIZE);
}

export interface CreatedAtIdCursor {
  createdAt: Date;
  id: string;
}

export function encodeCreatedAtIdCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

export function decodeCreatedAtIdCursor(cursor: string): CreatedAtIdCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new ValidationError("Invalid pagination cursor");
  }
  const sep = decoded.lastIndexOf("|");
  if (sep <= 0 || sep === decoded.length - 1) {
    throw new ValidationError("Invalid pagination cursor");
  }
  const iso = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  const createdAt = new Date(iso);
  if (!id || Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) {
    throw new ValidationError("Invalid pagination cursor");
  }
  return { createdAt, id };
}

export function afterCreatedAtId(cursor: CreatedAtIdCursor): {
  createdAt: Date;
  id: string;
} {
  return cursor;
}
