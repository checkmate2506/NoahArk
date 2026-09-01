/** Locale-pinned search term. Host LANG (including tr_TR) must not change results. */
export function normaliseSearchTerm(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}
