/**
 * Foundation permission catalogue. `key` is the value stored in Permission.key
 * and referenced from RolePermission / FieldPolicy. This is the single
 * source of truth — packages/db's seed script and every authorize() call
 * site import from here rather than re-typing string literals.
 *
 * Only Phase 1 (platform foundation) permissions exist. Business-module
 * permissions (CRM, accounting, payroll, ...) are added in later phases.
 */
export const PERMISSIONS = {
  TENANT_READ: "tenant:read",
  TENANT_UPDATE: "tenant:update",
  LEGAL_ENTITY_READ: "legal_entity:read",
  LEGAL_ENTITY_CREATE: "legal_entity:create",
  LEGAL_ENTITY_UPDATE: "legal_entity:update",
  MEMBERSHIP_READ: "membership:read",
  MEMBERSHIP_INVITE: "membership:invite",
  MEMBERSHIP_UPDATE: "membership:update",
  LEGAL_ENTITY_MEMBERSHIP_READ: "legal_entity_membership:read",
  LEGAL_ENTITY_MEMBERSHIP_GRANT: "legal_entity_membership:grant",
  LEGAL_ENTITY_MEMBERSHIP_REVOKE: "legal_entity_membership:revoke",
  ROLE_READ: "role:read",
  ROLE_CREATE: "role:create",
  ROLE_UPDATE: "role:update",
  ROLE_DELETE: "role:delete",
  ROLE_ASSIGN: "role:assign",
  SETTINGS_READ: "settings:read",
  SETTINGS_UPDATE: "settings:update",
  APPROVAL_POLICY_MANAGE: "approval_policy:manage",
  APPROVAL_SUBMIT: "approval:submit",
  APPROVAL_DECIDE: "approval:decide",
  APPROVAL_READ: "approval:read",
  AUDIT_READ: "audit:read",
  FILE_UPLOAD: "file:upload",
  FILE_READ: "file:read",
  FILE_DELETE: "file:delete",
  FILE_ADMINISTER: "file:administer",
  JOB_READ: "job:read",
  JOB_ADMINISTER: "job:administer",
  OUTBOX_READ: "outbox:read",
  OUTBOX_ADMINISTER: "outbox:administer",
  FIELD_POLICY_MANAGE: "field_policy:manage",
  /** Demo-only: gates a synthetic protected field used to prove field-level
   * masking end-to-end without inventing real HR/payroll data in Phase 1. */
  DEMO_PROTECTED_FIELD_READ: "demo.protected_field:read",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_CATALOG: ReadonlyArray<{
  key: PermissionKey;
  category: string;
  description: string;
}> = [
  {
    key: PERMISSIONS.TENANT_READ,
    category: "tenant",
    description: "View tenant details",
  },
  {
    key: PERMISSIONS.TENANT_UPDATE,
    category: "tenant",
    description: "Update tenant details and status",
  },
  {
    key: PERMISSIONS.LEGAL_ENTITY_READ,
    category: "legal_entity",
    description: "View legal entities",
  },
  {
    key: PERMISSIONS.LEGAL_ENTITY_CREATE,
    category: "legal_entity",
    description: "Create a legal entity",
  },
  {
    key: PERMISSIONS.LEGAL_ENTITY_UPDATE,
    category: "legal_entity",
    description: "Update a legal entity",
  },
  {
    key: PERMISSIONS.MEMBERSHIP_READ,
    category: "membership",
    description: "View tenant memberships",
  },
  {
    key: PERMISSIONS.MEMBERSHIP_INVITE,
    category: "membership",
    description: "Invite a user to the tenant",
  },
  {
    key: PERMISSIONS.MEMBERSHIP_UPDATE,
    category: "membership",
    description: "Suspend/reactivate a tenant membership",
  },
  {
    key: PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_READ,
    category: "membership",
    description: "View legal-entity access grants",
  },
  {
    key: PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_GRANT,
    category: "membership",
    description: "Grant a user access to a legal entity",
  },
  {
    key: PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_REVOKE,
    category: "membership",
    description: "Revoke a user's legal-entity access",
  },
  {
    key: PERMISSIONS.ROLE_READ,
    category: "role",
    description: "View roles and permissions",
  },
  { key: PERMISSIONS.ROLE_CREATE, category: "role", description: "Create a custom role" },
  {
    key: PERMISSIONS.ROLE_UPDATE,
    category: "role",
    description: "Update a non-system role's permissions",
  },
  {
    key: PERMISSIONS.ROLE_DELETE,
    category: "role",
    description: "Delete a non-system role",
  },
  {
    key: PERMISSIONS.ROLE_ASSIGN,
    category: "role",
    description: "Assign a role to a membership",
  },
  {
    key: PERMISSIONS.SETTINGS_READ,
    category: "settings",
    description: "View tenant/legal-entity settings",
  },
  {
    key: PERMISSIONS.SETTINGS_UPDATE,
    category: "settings",
    description: "Update tenant/legal-entity settings",
  },
  {
    key: PERMISSIONS.APPROVAL_POLICY_MANAGE,
    category: "approval",
    description: "Manage approval policies and steps",
  },
  {
    key: PERMISSIONS.APPROVAL_SUBMIT,
    category: "approval",
    description: "Submit a request for approval",
  },
  {
    key: PERMISSIONS.APPROVAL_DECIDE,
    category: "approval",
    description: "Approve, reject or cancel an approval request",
  },
  {
    key: PERMISSIONS.APPROVAL_READ,
    category: "approval",
    description: "View approval requests and history",
  },
  { key: PERMISSIONS.AUDIT_READ, category: "audit", description: "View audit events" },
  { key: PERMISSIONS.FILE_UPLOAD, category: "file", description: "Upload a file" },
  { key: PERMISSIONS.FILE_READ, category: "file", description: "Read/download a file" },
  { key: PERMISSIONS.FILE_DELETE, category: "file", description: "Delete (soft) a file" },
  {
    key: PERMISSIONS.FILE_ADMINISTER,
    category: "file",
    description: "Administer files across the tenant",
  },
  {
    key: PERMISSIONS.JOB_READ,
    category: "job",
    description: "View background job status",
  },
  {
    key: PERMISSIONS.JOB_ADMINISTER,
    category: "job",
    description: "Retry/cancel background jobs",
  },
  {
    key: PERMISSIONS.OUTBOX_READ,
    category: "job",
    description: "View outbox event status",
  },
  {
    key: PERMISSIONS.OUTBOX_ADMINISTER,
    category: "job",
    description: "Administer outbox events",
  },
  {
    key: PERMISSIONS.FIELD_POLICY_MANAGE,
    category: "field_policy",
    description: "Manage field-level access policies",
  },
  {
    key: PERMISSIONS.DEMO_PROTECTED_FIELD_READ,
    category: "demo",
    description: "Read the demo protected field (Phase 1 field-level-control proof)",
  },
];

/** Seeded per tenant at provisioning. `tenant_admin` holds every foundation
 * permission; `member` holds only self-service/read permissions. Both are
 * `isSystem = true` and therefore protected from permission edits/deletion. */
export const SYSTEM_ROLES = {
  TENANT_ADMIN: {
    key: "tenant_admin",
    name: "Tenant Administrator",
    permissions: PERMISSION_CATALOG.map((p) => p.key),
  },
  MEMBER: {
    key: "member",
    name: "Member",
    permissions: [
      PERMISSIONS.TENANT_READ,
      PERMISSIONS.LEGAL_ENTITY_READ,
      PERMISSIONS.MEMBERSHIP_READ,
      PERMISSIONS.ROLE_READ,
      PERMISSIONS.SETTINGS_READ,
      PERMISSIONS.APPROVAL_SUBMIT,
      PERMISSIONS.APPROVAL_READ,
      PERMISSIONS.FILE_UPLOAD,
      PERMISSIONS.FILE_READ,
    ] as PermissionKey[],
  },
} as const;
