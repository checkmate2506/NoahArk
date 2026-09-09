import { ValidationError } from "@noahark/core";
import { Prisma, type CustomFieldValue } from "@noahark/db";
import type { SupportedDataType } from "./schemas";

const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SIGNED_DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]{0,16})(?:\.[0-9]{1,6})?$/;
const INT4_MIN = -2147483648;
const INT4_MAX = 2147483647;
const STRING_MAX = 2000;

export type TypedValueEnvelope =
  | { dataType: "STRING"; value: string }
  | { dataType: "INTEGER"; value: number }
  | { dataType: "DECIMAL"; value: string }
  | { dataType: "BOOLEAN"; value: boolean }
  | { dataType: "DATE"; value: string }
  | { dataType: "SINGLE_SELECT"; value: string };

export type TypedStorageColumns = {
  value: typeof Prisma.DbNull;
  valueText: string | null;
  valueInteger: number | null;
  valueDecimal: Prisma.Decimal | null;
  valueBoolean: boolean | null;
  valueDate: Date | null;
  valueOption: string | null;
};

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

export function parseSignedDecimalString(raw: string): string {
  if (typeof raw !== "string") {
    throw new ValidationError("Invalid decimal value");
  }
  if (/\s/.test(raw) || raw.includes(",") || /[eE]/.test(raw)) {
    throw new ValidationError("Invalid decimal value");
  }
  if (!SIGNED_DECIMAL_PATTERN.test(raw)) {
    throw new ValidationError("Invalid decimal value");
  }
  if (/^-0(?:\.0+)?$/.test(raw)) {
    throw new ValidationError("Invalid decimal value");
  }
  return raw;
}

export function formatDecimal(value: Prisma.Decimal): string {
  return value.toFixed(6);
}

export function canonicalizeOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new ValidationError("Custom field options must be a list of strings");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new ValidationError("Custom field options must be a list of strings");
    }
    const trimmed = item.trim();
    if (!trimmed) {
      throw new ValidationError("Custom field options cannot be blank");
    }
    if (seen.has(trimmed)) {
      throw new ValidationError("Custom field options must be unique");
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  if (out.length === 0) {
    throw new ValidationError("Custom field options cannot be empty");
  }
  return out;
}

export function readOptions(raw: unknown): string[] | null {
  if (raw === null || raw === undefined) return null;
  return canonicalizeOptions(raw);
}

export function assertOptionsAddOnly(previous: string[], next: string[]): void {
  for (const option of previous) {
    if (!next.includes(option)) {
      throw new ValidationError("Custom field options cannot be removed");
    }
  }
}

function canonicalString(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ValidationError("Invalid string value");
  }
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > STRING_MAX) {
    throw new ValidationError("Invalid string value");
  }
  return trimmed;
}

function canonicalInteger(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new ValidationError("Invalid integer value");
  }
  if (raw < INT4_MIN || raw > INT4_MAX) {
    throw new ValidationError("Invalid integer value");
  }
  return raw;
}

function canonicalBoolean(raw: unknown): boolean {
  if (typeof raw !== "boolean") {
    throw new ValidationError("Invalid boolean value");
  }
  return raw;
}

export function canonicalizeEnvelope(
  envelope: TypedValueEnvelope,
  lockedDataType: SupportedDataType,
  options: string[] | null,
): TypedValueEnvelope {
  if (envelope.dataType !== lockedDataType) {
    throw new ValidationError("Custom field value type does not match the definition");
  }
  switch (envelope.dataType) {
    case "STRING":
      return { dataType: "STRING", value: canonicalString(envelope.value) };
    case "INTEGER":
      return { dataType: "INTEGER", value: canonicalInteger(envelope.value) };
    case "DECIMAL":
      return { dataType: "DECIMAL", value: parseSignedDecimalString(envelope.value) };
    case "BOOLEAN":
      return { dataType: "BOOLEAN", value: canonicalBoolean(envelope.value) };
    case "DATE":
      parseCivilDate(envelope.value);
      return { dataType: "DATE", value: envelope.value };
    case "SINGLE_SELECT": {
      if (typeof envelope.value !== "string") {
        throw new ValidationError("Invalid single-select value");
      }
      if (!options || !options.includes(envelope.value)) {
        throw new ValidationError("Invalid single-select value");
      }
      return { dataType: "SINGLE_SELECT", value: envelope.value };
    }
  }
}

export function envelopeToStorage(envelope: TypedValueEnvelope): TypedStorageColumns {
  const empty: TypedStorageColumns = {
    value: Prisma.DbNull,
    valueText: null,
    valueInteger: null,
    valueDecimal: null,
    valueBoolean: null,
    valueDate: null,
    valueOption: null,
  };
  switch (envelope.dataType) {
    case "STRING":
      return { ...empty, valueText: envelope.value };
    case "INTEGER":
      return { ...empty, valueInteger: envelope.value };
    case "DECIMAL":
      return { ...empty, valueDecimal: new Prisma.Decimal(envelope.value) };
    case "BOOLEAN":
      return { ...empty, valueBoolean: envelope.value };
    case "DATE":
      return { ...empty, valueDate: parseCivilDate(envelope.value) };
    case "SINGLE_SELECT":
      return { ...empty, valueOption: envelope.value };
  }
}

export function rowToEnvelope(row: CustomFieldValue): TypedValueEnvelope {
  if (row.valueText !== null) return { dataType: "STRING", value: row.valueText };
  if (row.valueInteger !== null) return { dataType: "INTEGER", value: row.valueInteger };
  if (row.valueDecimal !== null) {
    return { dataType: "DECIMAL", value: formatDecimal(row.valueDecimal) };
  }
  if (row.valueBoolean !== null) return { dataType: "BOOLEAN", value: row.valueBoolean };
  if (row.valueDate !== null)
    return { dataType: "DATE", value: formatCivilDate(row.valueDate) };
  if (row.valueOption !== null)
    return { dataType: "SINGLE_SELECT", value: row.valueOption };
  throw new ValidationError("Custom field value is not readable");
}
