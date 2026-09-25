import { ValidationError } from "@noahark/core";

const DECIMAL_STRING_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

function isDecimalCompatible(value: unknown): value is { toString(): string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Date) &&
    typeof (value as { toString?: unknown }).toString === "function"
  );
}

function assertValidDecimalString(raw: string): string {
  if (!DECIMAL_STRING_PATTERN.test(raw)) {
    throw new ValidationError("Invalid decimal value");
  }
  return raw;
}

/**
 * Prisma Decimal / decimal-compatible values become an exact decimal string.
 * JavaScript `number` is rejected so monetary values never pass through IEEE
 * floats. Locale formatting is not applied.
 */
export function decimalToString(value: unknown): string {
  if (typeof value === "number") {
    throw new ValidationError("Monetary values cannot be JavaScript numbers");
  }
  if (typeof value === "string") {
    return assertValidDecimalString(value);
  }
  if (!isDecimalCompatible(value)) {
    throw new ValidationError("Invalid decimal value");
  }
  return assertValidDecimalString(value.toString());
}

function assertValidDate(value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new ValidationError("Invalid date");
  }
  return value;
}

/**
 * Civil calendar date using UTC components only: `YYYY-MM-DD`.
 * Distinct from `timestampToIso` — timestamps are never rewritten as civil
 * dates by a generic walker.
 */
export function civilDateToString(value: unknown): string {
  const date = assertValidDate(value);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const yyyy = String(year).padStart(4, "0");
  return `${yyyy}-${month}-${day}`;
}

/** Instant timestamp as ISO-8601 (`Date.prototype.toISOString()`). */
export function timestampToIso(value: unknown): string {
  return assertValidDate(value).toISOString();
}
