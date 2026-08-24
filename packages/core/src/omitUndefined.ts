/**
 * Strips keys whose value is `undefined` from a partial-update object
 * before handing it to Prisma. Under `exactOptionalPropertyTypes`, Prisma's
 * generated `*UpdateInput`/`*CreateInput` types require an optional field,
 * if the key is present at all, to hold its real type — never `undefined`
 * — so a zod `.optional()` schema's unset fields (which ARE `undefined`,
 * not omitted, once parsed) must be dropped before the object reaches
 * `prisma.model.update({ data: ... })`.
 *
 * The return type maps each property to `Exclude<T[K], undefined>` (not
 * `Partial<T>`) so the result's static type genuinely says "if present,
 * never undefined" — a plain `Partial<T>` would keep `| undefined` in the
 * value type even after the runtime filtering, which still fails
 * assignability against Prisma's input types.
 */
export function omitUndefined<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const result: { [K in keyof T]?: Exclude<T[K], undefined> } = {};
  for (const key of Object.keys(obj) as Array<keyof T>) {
    const value = obj[key];
    if (value !== undefined) {
      result[key] = value as Exclude<T[typeof key], undefined>;
    }
  }
  return result;
}
