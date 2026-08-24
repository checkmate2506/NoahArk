import { z } from "zod";
import { ValidationError, LANGUAGES } from "@noahark/core";

/**
 * Registry of known, typed settings keys. TenantSetting/LegalEntitySetting
 * store an opaque JSON value in the database (so new keys never require a
 * migration), but every key the application actually reads or writes must
 * be registered here with a schema — this is what "typed validation"
 * (PHASE_01_FOUNDATION §12) means in practice: the DB column is untyped,
 * the application boundary is not.
 */
const TENANT_SETTINGS_SCHEMAS = {
  "ui.defaultLanguage": z.enum(LANGUAGES),
} as const;

const LEGAL_ENTITY_SETTINGS_SCHEMAS = {
  "documents.numberingPrefix": z.string().min(1).max(10),
} as const;

export type TenantSettingKey = keyof typeof TENANT_SETTINGS_SCHEMAS;
export type LegalEntitySettingKey = keyof typeof LEGAL_ENTITY_SETTINGS_SCHEMAS;

export function validateTenantSettingValue(key: string, value: unknown): unknown {
  const schema = (TENANT_SETTINGS_SCHEMAS as Record<string, z.ZodType>)[key];
  if (!schema) {
    throw new ValidationError(`Unknown tenant setting key: ${key}`);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`Invalid value for tenant setting ${key}`, {
      issues: result.error.issues,
    });
  }
  return result.data;
}

export function validateLegalEntitySettingValue(key: string, value: unknown): unknown {
  const schema = (LEGAL_ENTITY_SETTINGS_SCHEMAS as Record<string, z.ZodType>)[key];
  if (!schema) {
    throw new ValidationError(`Unknown legal-entity setting key: ${key}`);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`Invalid value for legal-entity setting ${key}`, {
      issues: result.error.issues,
    });
  }
  return result.data;
}

export function isKnownTenantSettingKey(key: string): key is TenantSettingKey {
  return key in TENANT_SETTINGS_SCHEMAS;
}

export function isKnownLegalEntitySettingKey(key: string): key is LegalEntitySettingKey {
  return key in LEGAL_ENTITY_SETTINGS_SCHEMAS;
}
