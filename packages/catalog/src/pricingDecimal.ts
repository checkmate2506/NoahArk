import { ValidationError } from "@noahark/core";
import type { Prisma } from "@noahark/db";

const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,16})(?:\.[0-9]{1,6})?$/;

/** Accepts a canonical NUMERIC(23,6) decimal string after trim. */
export function parseDecimalString(raw: string): string {
  const trimmed = raw.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new ValidationError("Invalid unit price");
  }
  return trimmed;
}

/** Canonical 6-decimal string. A price value never uses binary float. */
export function formatDecimal(value: Prisma.Decimal): string {
  return value.toFixed(6);
}
