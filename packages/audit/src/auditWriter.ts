import type { Clock } from "@noahark/core";
import { systemClock } from "@noahark/core";
import { sanitizeForAudit } from "./sanitize";
import {
  computeAuditHash,
  chainKeyForTenant,
  type HashableAuditPayload,
} from "./hashChain";

export type AuditActorType = "USER" | "SYSTEM";
export type AuditOutcome = "SUCCESS" | "FAILURE" | "DENIED";

// Optional fields declare `| undefined` explicitly (not bare `?:`) because
// call sites build this object by spreading values straight from
// AccessContext (ipAddress/userAgent are themselves `string | undefined`,
// from a possibly-missing header) — under exactOptionalPropertyTypes, a
// present key's value must exactly match the declared type, so "optional
// string-or-null" must say so, not just allow omission. See packages/core's
// errors.ts for the fuller explanation of this pattern.
export interface AuditEventInput {
  /** null for platform-level events (sign-in/sign-out/failed-login) that
   * happen before any tenant is selected. */
  tenantId: string | null;
  legalEntityId?: string | null | undefined;
  actorUserId?: string | null | undefined;
  actorType?: AuditActorType | undefined;
  action: string;
  entityType: string;
  entityId?: string | null | undefined;
  beforeData?: unknown;
  afterData?: unknown;
  requestId?: string | null | undefined;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
  outcome?: AuditOutcome | undefined;
}

/** The exact row shape ready for `prisma.auditEvent.create({ data: ... })`.
 * Callers must supply `prevHash` AND `sequence` (the chain's next position,
 * allocated while holding the advisory lock for `chainKey` — see the db
 * package's audit service) so the chain stays gap-free and deterministic
 * even under concurrent writers (F-2/F-6: `createdAt` ordering alone is not
 * sufficient — see hashChain.ts's module doc). */
export interface AuditEventRow {
  tenantId: string | null;
  legalEntityId: string | null;
  actorUserId: string | null;
  actorType: AuditActorType;
  action: string;
  entityType: string;
  entityId: string | null;
  beforeData: unknown;
  afterData: unknown;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  outcome: AuditOutcome;
  chainKey: string;
  sequence: bigint;
  prevHash: string | null;
  hash: string;
  createdAt: Date;
}

export function buildAuditEventRow(
  input: AuditEventInput,
  prevHash: string | null,
  sequence: bigint,
  clock: Clock = systemClock,
): AuditEventRow {
  const createdAt = clock.now();
  const beforeData =
    input.beforeData !== undefined ? sanitizeForAudit(input.beforeData) : null;
  const afterData =
    input.afterData !== undefined ? sanitizeForAudit(input.afterData) : null;
  const chainKey = chainKeyForTenant(input.tenantId);

  const hashable: HashableAuditPayload = {
    tenantId: input.tenantId,
    legalEntityId: input.legalEntityId ?? null,
    actorUserId: input.actorUserId ?? null,
    actorType: input.actorType ?? "USER",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    beforeData,
    afterData,
    outcome: input.outcome ?? "SUCCESS",
    createdAt: createdAt.toISOString(),
    chainKey,
    sequence: sequence.toString(),
  };

  return {
    tenantId: hashable.tenantId,
    legalEntityId: hashable.legalEntityId,
    actorUserId: hashable.actorUserId,
    actorType: hashable.actorType as AuditActorType,
    action: hashable.action,
    entityType: hashable.entityType,
    entityId: hashable.entityId,
    beforeData: hashable.beforeData,
    afterData: hashable.afterData,
    requestId: input.requestId ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    outcome: hashable.outcome as AuditOutcome,
    chainKey,
    sequence,
    prevHash,
    hash: computeAuditHash(prevHash, hashable),
    createdAt,
  };
}

/** The list of actions Phase 1 must audit (SECTION 8 of the Phase 1 spec).
 * Service code should use these constants rather than free-text strings so
 * the audit-coverage test can assert every listed action is reachable. */
export const AUDIT_ACTIONS = {
  TENANT_CREATED: "tenant.created",
  TENANT_UPDATED: "tenant.updated",
  LEGAL_ENTITY_CREATED: "legal_entity.created",
  LEGAL_ENTITY_UPDATED: "legal_entity.updated",
  TENANT_MEMBERSHIP_CREATED: "tenant_membership.created",
  TENANT_MEMBERSHIP_UPDATED: "tenant_membership.updated",
  MEMBERSHIP_INVITATION_CREATED: "membership_invitation.created",
  MEMBERSHIP_INVITATION_ACCEPTED: "membership_invitation.accepted",
  MEMBERSHIP_INVITATION_REVOKED: "membership_invitation.revoked",
  EMAIL_VERIFICATION_REQUESTED: "email_verification.requested",
  EMAIL_VERIFIED: "email_verification.verified",
  MFA_ENROLLED: "mfa.enrolled",
  MFA_DISABLED: "mfa.disabled",
  MFA_CHALLENGE_SUCCEEDED: "mfa.challenge_succeeded",
  MFA_CHALLENGE_FAILED: "mfa.challenge_failed",
  MFA_RECOVERY_CODE_USED: "mfa.recovery_code_used",
  LEGAL_ENTITY_MEMBERSHIP_GRANTED: "legal_entity_membership.granted",
  LEGAL_ENTITY_MEMBERSHIP_REVOKED: "legal_entity_membership.revoked",
  ROLE_CREATED: "role.created",
  ROLE_UPDATED: "role.updated",
  ROLE_DELETED: "role.deleted",
  ROLE_ASSIGNED: "role.assigned",
  ROLE_UNASSIGNED: "role.unassigned",
  SETTINGS_UPDATED: "settings.updated",
  APPROVAL_SUBMITTED: "approval.submitted",
  APPROVAL_DECIDED: "approval.decided",
  FILE_UPLOADED: "file.uploaded",
  FILE_DELETED: "file.deleted",
  FILE_QUARANTINED: "file.quarantined",
  FILE_ACCESS_REVOKED: "file.access_revoked",
  FILE_CONTENT_REPLACED: "file.content_replaced",
  FILE_ACCESS_DENIED: "file.access_denied",
  AUTH_SIGN_IN: "auth.sign_in",
  AUTH_SIGN_IN_FAILED: "auth.sign_in_failed",
  AUTH_SIGN_OUT: "auth.sign_out",
  AUTHORIZATION_DENIED: "authorization.denied",
  JOB_CONTEXT_REJECTED: "job.context_rejected",
  PARTY_CREATED: "party.created",
  PARTY_UPDATED: "party.updated",
  PARTY_ARCHIVED: "party.archived",
  PARTY_OWNERSHIP_TRANSFERRED: "party.ownership_transferred",
  PARTY_CONTACT_CREATED: "party_contact.created",
  PARTY_CONTACT_UPDATED: "party_contact.updated",
  PARTY_CONTACT_ARCHIVED: "party_contact.archived",
  PARTY_ADDRESS_CREATED: "party_address.created",
  PARTY_ADDRESS_UPDATED: "party_address.updated",
  PARTY_ADDRESS_ARCHIVED: "party_address.archived",
  PARTY_ASSIGNMENT_CREATED: "party_assignment.created",
  PARTY_ASSIGNMENT_UPDATED: "party_assignment.updated",
  PARTY_ASSIGNMENT_REVOKED: "party_assignment.revoked",
  CUSTOMER_ROLE_CREATED: "customer_role.created",
  CUSTOMER_ROLE_UPDATED: "customer_role.updated",
  CUSTOMER_ROLE_ARCHIVED: "customer_role.archived",
  VENDOR_ROLE_CREATED: "vendor_role.created",
  VENDOR_ROLE_UPDATED: "vendor_role.updated",
  VENDOR_ROLE_ARCHIVED: "vendor_role.archived",
  CATALOG_CATEGORY_CREATED: "catalog_category.created",
  CATALOG_CATEGORY_UPDATED: "catalog_category.updated",
  CATALOG_CATEGORY_DEACTIVATED: "catalog_category.deactivated",
  CATALOG_CATEGORY_ACTIVATED: "catalog_category.activated",
  UNIT_OF_MEASURE_CREATED: "unit_of_measure.created",
  UNIT_OF_MEASURE_UPDATED: "unit_of_measure.updated",
  UNIT_OF_MEASURE_DEACTIVATED: "unit_of_measure.deactivated",
  UNIT_OF_MEASURE_ACTIVATED: "unit_of_measure.activated",
  CATALOG_ITEM_CREATED: "catalog_item.created",
  CATALOG_ITEM_UPDATED: "catalog_item.updated",
  CATALOG_ITEM_OWNERSHIP_TRANSFERRED: "catalog_item.ownership_transferred",
  CATALOG_ITEM_ASSIGNMENT_CREATED: "catalog_item_assignment.created",
  CATALOG_ITEM_ASSIGNMENT_UPDATED: "catalog_item_assignment.updated",
  CATALOG_ITEM_ASSIGNMENT_ARCHIVED: "catalog_item_assignment.archived",
} as const;
