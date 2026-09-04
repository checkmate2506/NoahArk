import { ValidationError } from "@noahark/core";
import { z } from "zod";
import { formatCivilDate, parseCivilDate } from "./civilDate";
import { parseDecimalString } from "./pricingDecimal";

const civilDateString = z.string().superRefine((value, ctx) => {
  try {
    parseCivilDate(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid civil date" });
  }
});

const unitPriceString = z.string().superRefine((value, ctx) => {
  try {
    parseDecimalString(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid unit price" });
  }
});

export const CreatePriceListSchema = z.object({
  ownerLegalEntityId: z.string().min(1).max(64),
  code: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  currency: z.enum(["SGD", "MYR", "IDR"]),
});

export const UpdatePriceListSchema = z.object({
  expectedVersion: z.number().int().min(1),
  code: z.string().trim().min(1).max(64).optional(),
  name: z.string().trim().min(1).max(200).optional(),
});

export const ListPriceListsSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().optional(),
  status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
  includeArchived: z.boolean().optional(),
  currency: z.enum(["SGD", "MYR", "IDR"]).optional(),
  q: z.string().trim().max(200).optional(),
});

export const TransferPriceListOwnershipSchema = z.object({
  newOwnerLegalEntityId: z.string().min(1).max(64),
  expectedVersion: z.number().int().min(1),
});

export const CreatePriceListAssignmentSchema = z.object({
  priceListId: z.string().min(1).max(64),
  legalEntityId: z.string().min(1).max(64),
});

export const UpdatePriceListAssignmentSchema = z.object({
  expectedVersion: z.number().int().min(1),
  status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
});

export const ListPriceListAssignmentsSchema = z.object({
  priceListId: z.string().min(1).max(64).optional(),
  legalEntityId: z.string().min(1).max(64).optional(),
});

export const SetDefaultPriceListSchema = z
  .object({
    legalEntityId: z.string().min(1).max(64),
    priceListId: z.string().min(1).max(64).nullable(),
  })
  .strict();

export const CreatePriceListEntrySchema = z
  .object({
    priceListAssignmentId: z.string().min(1).max(64),
    catalogItemAssignmentId: z.string().min(1).max(64),
    unitPrice: unitPriceString,
    effectiveFrom: civilDateString,
    effectiveTo: civilDateString.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.effectiveTo === null) return;
    if (value.effectiveTo < value.effectiveFrom) {
      ctx.addIssue({
        code: "custom",
        message: "effectiveTo must be on or after effectiveFrom",
        path: ["effectiveTo"],
      });
    }
  });

export const UpdatePriceListEntrySchema = z.object({
  expectedVersion: z.number().int().min(1),
  unitPrice: unitPriceString.optional(),
  effectiveFrom: civilDateString.optional(),
  effectiveTo: civilDateString.nullable().optional(),
});

export const ClosePriceListEntrySchema = z.object({
  expectedVersion: z.number().int().min(1),
  effectiveTo: civilDateString,
});

export const ListPriceListEntriesSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().optional(),
  priceListAssignmentId: z.string().min(1).max(64).optional(),
  catalogItemAssignmentId: z.string().min(1).max(64).optional(),
  legalEntityId: z.string().min(1).max(64).optional(),
});

export const ResolveEffectivePriceSchema = z.object({
  legalEntityId: z.string().min(1).max(64),
  catalogItemId: z.string().min(1).max(64),
  onDate: civilDateString,
  priceListId: z.string().min(1).max(64).optional(),
});

export interface EffectiveFromIdCursor {
  effectiveFrom: Date;
  id: string;
}

export function encodeEffectiveFromIdCursor(effectiveFrom: Date, id: string): string {
  return Buffer.from(`${formatCivilDate(effectiveFrom)}|${id}`, "utf8").toString(
    "base64url",
  );
}

export function decodeEffectiveFromIdCursor(cursor: string): EffectiveFromIdCursor {
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
  const datePart = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  let effectiveFrom: Date;
  try {
    effectiveFrom = parseCivilDate(datePart);
  } catch {
    throw new ValidationError("Invalid pagination cursor");
  }
  if (!id || formatCivilDate(effectiveFrom) !== datePart) {
    throw new ValidationError("Invalid pagination cursor");
  }
  return { effectiveFrom, id };
}
