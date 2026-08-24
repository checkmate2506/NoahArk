import { ValidationError } from "./errors";

/** The only three supported jurisdictions — CLAUDE.md "Geographic product
 * scope". Adding a fourth is a product decision, not a config toggle. */
export const JURISDICTIONS = ["SG", "MY", "ID"] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

export const CURRENCIES = ["SGD", "MYR", "IDR"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const LANGUAGES = ["EN", "MS", "ID"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Every legal entity's functional currency is fixed by its jurisdiction —
 * LEGAL_ENTITY_ARCHITECTURE.md §2. There is no free choice here. */
export const JURISDICTION_FUNCTIONAL_CURRENCY: Record<Jurisdiction, Currency> = {
  SG: "SGD",
  MY: "MYR",
  ID: "IDR",
};

export function isJurisdiction(value: unknown): value is Jurisdiction {
  return (
    typeof value === "string" && (JURISDICTIONS as readonly string[]).includes(value)
  );
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === "string" && (CURRENCIES as readonly string[]).includes(value);
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

export function functionalCurrencyFor(jurisdiction: Jurisdiction): Currency {
  return JURISDICTION_FUNCTIONAL_CURRENCY[jurisdiction];
}

/** Throws unless `currency` is the one and only functional currency
 * permitted for `jurisdiction`. This is the app-layer mirror of the
 * database CHECK constraint on legal_entity — see the RLS/constraints
 * migration. Both must independently reject the same invalid input. */
export function assertJurisdictionCurrencyCompatible(
  jurisdiction: Jurisdiction,
  currency: Currency,
): void {
  const expected = functionalCurrencyFor(jurisdiction);
  if (currency !== expected) {
    throw new ValidationError(
      `Jurisdiction ${jurisdiction} requires functional currency ${expected}, got ${currency}`,
      { jurisdiction, currency, expected },
    );
  }
}
