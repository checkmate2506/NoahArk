import { ValidationError } from "@noahark/core";

const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Parses YYYY-MM-DD as a UTC civil date. Rejects non-calendar days. */
export function parseCivilDate(raw: string): Date {
  if (!CIVIL_DATE_PATTERN.test(raw)) {
    throw new ValidationError("Invalid civil date");
  }
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new ValidationError("Invalid civil date");
  }
  return utc;
}

export function formatCivilDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
