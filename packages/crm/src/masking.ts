import type { FieldPolicyRule } from "@noahark/authz";
import { maskProtectedFields } from "@noahark/authz";
import type { AccessContext } from "@noahark/core";

/**
 * Declared P2D permission keys. They are NOT in the Phase 1 catalogue and
 * are not seeded. Until P2D adds them to PERMISSIONS / SYSTEM_ROLES, no
 * production role holds them — email/phone stay masked (fail-closed).
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
