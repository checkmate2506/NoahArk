/** Deterministic, locale-stable normalisation for duplicate detection.
 * Uses NFKC + en-US lowercasing so host locale cannot change results. */
export function normaliseText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function normaliseEmail(value: string): string {
  return normaliseText(value);
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailShape(value: string): boolean {
  return EMAIL_SHAPE.test(normaliseEmail(value));
}

export function partyDisplayName(input: {
  partyType: "ORGANISATION" | "INDIVIDUAL";
  legalName?: string | null | undefined;
  givenName?: string | null | undefined;
  familyName?: string | null | undefined;
}): string {
  if (input.partyType === "ORGANISATION") {
    return (input.legalName ?? "").trim();
  }
  return [input.givenName, input.familyName]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ")
    .trim();
}
