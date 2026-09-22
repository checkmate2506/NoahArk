import type { FieldPolicyRule } from "@noahark/authz";
import { maskProtectedFields } from "@noahark/authz";
import type { AccessContext } from "@noahark/core";

/**
 * Party-contact field-policy keys (T-7 / T-12). The strings match the
 * P2D.0 catalogue. `tenant_admin` receives them via PERMISSION_CATALOG;
 * `member` and custom roles do not, so email/phone stay masked unless
 * those roles are granted the keys.
 */
export const PENDING_PARTY_CONTACT_PERMISSIONS = {
  EMAIL_READ: "party_contact:email:read",
  PHONE_READ: "party_contact:phone:read",
} as const;

export const PARTY_CONTACT_FIELD_POLICIES: readonly FieldPolicyRule[] = [
  {
    entityType: "party_contact",
    fieldName: "email",
    requiredPermission: PENDING_PARTY_CONTACT_PERMISSIONS.EMAIL_READ,
  },
  {
    entityType: "party_contact",
    fieldName: "phone",
    requiredPermission: PENDING_PARTY_CONTACT_PERMISSIONS.PHONE_READ,
  },
];

const MASKED = null;

export type MaskableContact = {
  email: string | null;
  phone: string | null;
  [key: string]: unknown;
};

export function maskPartyContact<T extends MaskableContact>(
  ctx: AccessContext,
  record: T,
  legalEntityId?: string | null,
): T {
  const masked = maskProtectedFields(
    ctx,
    PARTY_CONTACT_FIELD_POLICIES,
    "party_contact",
    record as Record<string, unknown>,
    legalEntityId ?? null,
  ) as T;
  if (!("email" in masked) || masked.email === undefined) {
    masked.email = MASKED;
  }
  if (!("phone" in masked) || masked.phone === undefined) {
    masked.phone = MASKED;
  }
  return masked;
}
