/**
 * Permission catalogue. `key` is the value stored in Permission.key and
 * referenced from RolePermission. This is the single source of truth —
 * packages/db's seed script, the P2D.0 production sync command, and every
 * authorize() call site import from here rather than re-typing literals.
 *
 * Phase 1 (platform foundation) plus Phase 2 (party / catalog / pricing /
 * custom fields). `catalog_item:archive` and `price_list:archive` are
 * deliberately absent (T-1 / T-2).
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

  PARTY_READ: "party:read",
  PARTY_CREATE: "party:create",
  PARTY_UPDATE: "party:update",
  PARTY_ARCHIVE: "party:archive",
  PARTY_TRANSFER_OWNERSHIP: "party:transfer_ownership",
  PARTY_CONTACT_READ: "party_contact:read",
  PARTY_CONTACT_CREATE: "party_contact:create",
  PARTY_CONTACT_UPDATE: "party_contact:update",
  PARTY_CONTACT_ARCHIVE: "party_contact:archive",
  PARTY_CONTACT_EMAIL_READ: "party_contact:email:read",
  PARTY_CONTACT_PHONE_READ: "party_contact:phone:read",
  PARTY_ADDRESS_READ: "party_address:read",
  PARTY_ADDRESS_CREATE: "party_address:create",
  PARTY_ADDRESS_UPDATE: "party_address:update",
  PARTY_ADDRESS_ARCHIVE: "party_address:archive",
  PARTY_ASSIGNMENT_READ: "party_assignment:read",
  PARTY_ASSIGNMENT_CREATE: "party_assignment:create",
  PARTY_ASSIGNMENT_UPDATE: "party_assignment:update",
  PARTY_ASSIGNMENT_REVOKE: "party_assignment:revoke",
  CUSTOMER_ROLE_READ: "customer_role:read",
  CUSTOMER_ROLE_CREATE: "customer_role:create",
  CUSTOMER_ROLE_UPDATE: "customer_role:update",
  CUSTOMER_ROLE_ARCHIVE: "customer_role:archive",
  VENDOR_ROLE_READ: "vendor_role:read",
  VENDOR_ROLE_CREATE: "vendor_role:create",
  VENDOR_ROLE_UPDATE: "vendor_role:update",
  VENDOR_ROLE_ARCHIVE: "vendor_role:archive",

  CATALOG_CATEGORY_READ: "catalog_category:read",
  CATALOG_CATEGORY_CREATE: "catalog_category:create",
  CATALOG_CATEGORY_UPDATE: "catalog_category:update",
  CATALOG_CATEGORY_SET_STATUS: "catalog_category:set_status",
  UNIT_OF_MEASURE_READ: "unit_of_measure:read",
  UNIT_OF_MEASURE_CREATE: "unit_of_measure:create",
  UNIT_OF_MEASURE_UPDATE: "unit_of_measure:update",
  UNIT_OF_MEASURE_SET_STATUS: "unit_of_measure:set_status",
  CATALOG_ITEM_READ: "catalog_item:read",
  CATALOG_ITEM_CREATE: "catalog_item:create",
  CATALOG_ITEM_UPDATE: "catalog_item:update",
  CATALOG_ITEM_TRANSFER_OWNERSHIP: "catalog_item:transfer_ownership",
  CATALOG_ITEM_ASSIGNMENT_READ: "catalog_item_assignment:read",
  CATALOG_ITEM_ASSIGNMENT_CREATE: "catalog_item_assignment:create",
  CATALOG_ITEM_ASSIGNMENT_UPDATE: "catalog_item_assignment:update",
  CATALOG_ITEM_ASSIGNMENT_ARCHIVE: "catalog_item_assignment:archive",

  PRICE_LIST_READ: "price_list:read",
  PRICE_LIST_CREATE: "price_list:create",
  PRICE_LIST_UPDATE: "price_list:update",
  PRICE_LIST_TRANSFER_OWNERSHIP: "price_list:transfer_ownership",
  PRICE_LIST_ASSIGNMENT_READ: "price_list_assignment:read",
  PRICE_LIST_ASSIGNMENT_CREATE: "price_list_assignment:create",
  PRICE_LIST_ASSIGNMENT_UPDATE: "price_list_assignment:update",
  PRICE_LIST_ASSIGNMENT_ARCHIVE: "price_list_assignment:archive",
  PRICE_LIST_ASSIGNMENT_SET_DEFAULT: "price_list_assignment:set_default",
  PRICE_LIST_ENTRY_READ: "price_list_entry:read",
  PRICE_LIST_ENTRY_CREATE: "price_list_entry:create",
  PRICE_LIST_ENTRY_UPDATE: "price_list_entry:update",
  PRICE_LIST_ENTRY_CLOSE: "price_list_entry:close",
  PRICE_RESOLVE: "price:resolve",

  CUSTOM_FIELD_DEFINITION_READ: "custom_field_definition:read",
  CUSTOM_FIELD_DEFINITION_CREATE: "custom_field_definition:create",
  CUSTOM_FIELD_DEFINITION_UPDATE: "custom_field_definition:update",
  CUSTOM_FIELD_DEFINITION_SET_STATUS: "custom_field_definition:set_status",
  CUSTOM_FIELD_VALUE_READ: "custom_field_value:read",
  CUSTOM_FIELD_VALUE_WRITE: "custom_field_value:write",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Intentionally not catalogued in P2D.0 (T-1 / T-2). */
export const EXCLUDED_PHASE_2_ARCHIVE_KEYS = [
  "catalog_item:archive",
  "price_list:archive",
] as const;

const PHASE_1_PERMISSION_KEY_LIST = [
  PERMISSIONS.TENANT_READ,
  PERMISSIONS.TENANT_UPDATE,
  PERMISSIONS.LEGAL_ENTITY_READ,
  PERMISSIONS.LEGAL_ENTITY_CREATE,
  PERMISSIONS.LEGAL_ENTITY_UPDATE,
  PERMISSIONS.MEMBERSHIP_READ,
  PERMISSIONS.MEMBERSHIP_INVITE,
  PERMISSIONS.MEMBERSHIP_UPDATE,
  PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_READ,
  PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_GRANT,
  PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_REVOKE,
  PERMISSIONS.ROLE_READ,
  PERMISSIONS.ROLE_CREATE,
  PERMISSIONS.ROLE_UPDATE,
  PERMISSIONS.ROLE_DELETE,
  PERMISSIONS.ROLE_ASSIGN,
  PERMISSIONS.SETTINGS_READ,
  PERMISSIONS.SETTINGS_UPDATE,
  PERMISSIONS.APPROVAL_POLICY_MANAGE,
  PERMISSIONS.APPROVAL_SUBMIT,
  PERMISSIONS.APPROVAL_DECIDE,
  PERMISSIONS.APPROVAL_READ,
  PERMISSIONS.AUDIT_READ,
  PERMISSIONS.FILE_UPLOAD,
  PERMISSIONS.FILE_READ,
  PERMISSIONS.FILE_DELETE,
  PERMISSIONS.FILE_ADMINISTER,
  PERMISSIONS.JOB_READ,
  PERMISSIONS.JOB_ADMINISTER,
  PERMISSIONS.OUTBOX_READ,
  PERMISSIONS.OUTBOX_ADMINISTER,
  PERMISSIONS.FIELD_POLICY_MANAGE,
  PERMISSIONS.DEMO_PROTECTED_FIELD_READ,
] as const satisfies readonly PermissionKey[];

export const PHASE_1_PERMISSION_KEYS: readonly PermissionKey[] =
  PHASE_1_PERMISSION_KEY_LIST;

export const MEMBER_PERMISSION_KEYS = [
  PERMISSIONS.TENANT_READ,
  PERMISSIONS.LEGAL_ENTITY_READ,
  PERMISSIONS.MEMBERSHIP_READ,
  PERMISSIONS.ROLE_READ,
  PERMISSIONS.SETTINGS_READ,
  PERMISSIONS.APPROVAL_SUBMIT,
  PERMISSIONS.APPROVAL_READ,
  PERMISSIONS.FILE_UPLOAD,
  PERMISSIONS.FILE_READ,
] as const satisfies readonly PermissionKey[];

function entry(
  key: PermissionKey,
  category: string,
  description: string,
): { key: PermissionKey; category: string; description: string } {
  return { key, category, description };
}

export const PERMISSION_CATALOG: ReadonlyArray<{
  key: PermissionKey;
  category: string;
  description: string;
}> = [
  entry(PERMISSIONS.TENANT_READ, "tenant", "View tenant details"),
  entry(PERMISSIONS.TENANT_UPDATE, "tenant", "Update tenant details and status"),
  entry(PERMISSIONS.LEGAL_ENTITY_READ, "legal_entity", "View legal entities"),
  entry(PERMISSIONS.LEGAL_ENTITY_CREATE, "legal_entity", "Create a legal entity"),
  entry(PERMISSIONS.LEGAL_ENTITY_UPDATE, "legal_entity", "Update a legal entity"),
  entry(PERMISSIONS.MEMBERSHIP_READ, "membership", "View tenant memberships"),
  entry(PERMISSIONS.MEMBERSHIP_INVITE, "membership", "Invite a user to the tenant"),
  entry(
    PERMISSIONS.MEMBERSHIP_UPDATE,
    "membership",
    "Suspend/reactivate a tenant membership",
  ),
  entry(
    PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_READ,
    "membership",
    "View legal-entity access grants",
  ),
  entry(
    PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_GRANT,
    "membership",
    "Grant a user access to a legal entity",
  ),
  entry(
    PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_REVOKE,
    "membership",
    "Revoke a user's legal-entity access",
  ),
  entry(PERMISSIONS.ROLE_READ, "role", "View roles and permissions"),
  entry(PERMISSIONS.ROLE_CREATE, "role", "Create a custom role"),
  entry(PERMISSIONS.ROLE_UPDATE, "role", "Update a non-system role's permissions"),
  entry(PERMISSIONS.ROLE_DELETE, "role", "Delete a non-system role"),
  entry(PERMISSIONS.ROLE_ASSIGN, "role", "Assign a role to a membership"),
  entry(PERMISSIONS.SETTINGS_READ, "settings", "View tenant/legal-entity settings"),
  entry(PERMISSIONS.SETTINGS_UPDATE, "settings", "Update tenant/legal-entity settings"),
  entry(
    PERMISSIONS.APPROVAL_POLICY_MANAGE,
    "approval",
    "Manage approval policies and steps",
  ),
  entry(PERMISSIONS.APPROVAL_SUBMIT, "approval", "Submit a request for approval"),
  entry(
    PERMISSIONS.APPROVAL_DECIDE,
    "approval",
    "Approve, reject or cancel an approval request",
  ),
  entry(PERMISSIONS.APPROVAL_READ, "approval", "View approval requests and history"),
  entry(PERMISSIONS.AUDIT_READ, "audit", "View audit events"),
  entry(PERMISSIONS.FILE_UPLOAD, "file", "Upload a file"),
  entry(PERMISSIONS.FILE_READ, "file", "Read/download a file"),
  entry(PERMISSIONS.FILE_DELETE, "file", "Delete (soft) a file"),
  entry(PERMISSIONS.FILE_ADMINISTER, "file", "Administer files across the tenant"),
  entry(PERMISSIONS.JOB_READ, "job", "View background job status"),
  entry(PERMISSIONS.JOB_ADMINISTER, "job", "Retry/cancel background jobs"),
  entry(PERMISSIONS.OUTBOX_READ, "job", "View outbox event status"),
  entry(PERMISSIONS.OUTBOX_ADMINISTER, "job", "Administer outbox events"),
  entry(
    PERMISSIONS.FIELD_POLICY_MANAGE,
    "field_policy",
    "Manage field-level access policies",
  ),
  entry(
    PERMISSIONS.DEMO_PROTECTED_FIELD_READ,
    "demo",
    "Read the demo protected field (Phase 1 field-level-control proof)",
  ),

  entry(PERMISSIONS.PARTY_READ, "party", "View parties"),
  entry(PERMISSIONS.PARTY_CREATE, "party", "Create a party"),
  entry(PERMISSIONS.PARTY_UPDATE, "party", "Update a party"),
  entry(PERMISSIONS.PARTY_ARCHIVE, "party", "Archive a party"),
  entry(PERMISSIONS.PARTY_TRANSFER_OWNERSHIP, "party", "Transfer party ownership"),
  entry(PERMISSIONS.PARTY_CONTACT_READ, "party_contact", "View party contacts"),
  entry(PERMISSIONS.PARTY_CONTACT_CREATE, "party_contact", "Create a party contact"),
  entry(PERMISSIONS.PARTY_CONTACT_UPDATE, "party_contact", "Update a party contact"),
  entry(PERMISSIONS.PARTY_CONTACT_ARCHIVE, "party_contact", "Archive a party contact"),
  entry(
    PERMISSIONS.PARTY_CONTACT_EMAIL_READ,
    "party_contact",
    "Read a party contact email",
  ),
  entry(
    PERMISSIONS.PARTY_CONTACT_PHONE_READ,
    "party_contact",
    "Read a party contact phone number",
  ),
  entry(PERMISSIONS.PARTY_ADDRESS_READ, "party_address", "View party addresses"),
  entry(PERMISSIONS.PARTY_ADDRESS_CREATE, "party_address", "Create a party address"),
  entry(PERMISSIONS.PARTY_ADDRESS_UPDATE, "party_address", "Update a party address"),
  entry(PERMISSIONS.PARTY_ADDRESS_ARCHIVE, "party_address", "Archive a party address"),
  entry(
    PERMISSIONS.PARTY_ASSIGNMENT_READ,
    "party_assignment",
    "View party legal-entity assignments",
  ),
  entry(
    PERMISSIONS.PARTY_ASSIGNMENT_CREATE,
    "party_assignment",
    "Create a party legal-entity assignment",
  ),
  entry(
    PERMISSIONS.PARTY_ASSIGNMENT_UPDATE,
    "party_assignment",
    "Update a party legal-entity assignment",
  ),
  entry(
    PERMISSIONS.PARTY_ASSIGNMENT_REVOKE,
    "party_assignment",
    "Revoke a party legal-entity assignment",
  ),
  entry(PERMISSIONS.CUSTOMER_ROLE_READ, "customer_role", "View customer roles"),
  entry(PERMISSIONS.CUSTOMER_ROLE_CREATE, "customer_role", "Create a customer role"),
  entry(PERMISSIONS.CUSTOMER_ROLE_UPDATE, "customer_role", "Update a customer role"),
  entry(PERMISSIONS.CUSTOMER_ROLE_ARCHIVE, "customer_role", "Archive a customer role"),
  entry(PERMISSIONS.VENDOR_ROLE_READ, "vendor_role", "View vendor roles"),
  entry(PERMISSIONS.VENDOR_ROLE_CREATE, "vendor_role", "Create a vendor role"),
  entry(PERMISSIONS.VENDOR_ROLE_UPDATE, "vendor_role", "Update a vendor role"),
  entry(PERMISSIONS.VENDOR_ROLE_ARCHIVE, "vendor_role", "Archive a vendor role"),

  entry(PERMISSIONS.CATALOG_CATEGORY_READ, "catalog_category", "View catalog categories"),
  entry(
    PERMISSIONS.CATALOG_CATEGORY_CREATE,
    "catalog_category",
    "Create a catalog category",
  ),
  entry(
    PERMISSIONS.CATALOG_CATEGORY_UPDATE,
    "catalog_category",
    "Update a catalog category",
  ),
  entry(
    PERMISSIONS.CATALOG_CATEGORY_SET_STATUS,
    "catalog_category",
    "Activate or deactivate a catalog category",
  ),
  entry(PERMISSIONS.UNIT_OF_MEASURE_READ, "unit_of_measure", "View units of measure"),
  entry(
    PERMISSIONS.UNIT_OF_MEASURE_CREATE,
    "unit_of_measure",
    "Create a unit of measure",
  ),
  entry(
    PERMISSIONS.UNIT_OF_MEASURE_UPDATE,
    "unit_of_measure",
    "Update a unit of measure",
  ),
  entry(
    PERMISSIONS.UNIT_OF_MEASURE_SET_STATUS,
    "unit_of_measure",
    "Activate or deactivate a unit of measure",
  ),
  entry(PERMISSIONS.CATALOG_ITEM_READ, "catalog_item", "View catalog items"),
  entry(PERMISSIONS.CATALOG_ITEM_CREATE, "catalog_item", "Create a catalog item"),
  entry(PERMISSIONS.CATALOG_ITEM_UPDATE, "catalog_item", "Update a catalog item"),
  entry(
    PERMISSIONS.CATALOG_ITEM_TRANSFER_OWNERSHIP,
    "catalog_item",
    "Transfer catalog item ownership",
  ),
  entry(
    PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_READ,
    "catalog_item_assignment",
    "View catalog item assignments",
  ),
  entry(
    PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_CREATE,
    "catalog_item_assignment",
    "Create a catalog item assignment",
  ),
  entry(
    PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_UPDATE,
    "catalog_item_assignment",
    "Update a catalog item assignment",
  ),
  entry(
    PERMISSIONS.CATALOG_ITEM_ASSIGNMENT_ARCHIVE,
    "catalog_item_assignment",
    "Archive a catalog item assignment",
  ),

  entry(PERMISSIONS.PRICE_LIST_READ, "price_list", "View price lists"),
  entry(PERMISSIONS.PRICE_LIST_CREATE, "price_list", "Create a price list"),
  entry(PERMISSIONS.PRICE_LIST_UPDATE, "price_list", "Update a price list"),
  entry(
    PERMISSIONS.PRICE_LIST_TRANSFER_OWNERSHIP,
    "price_list",
    "Transfer price list ownership",
  ),
  entry(
    PERMISSIONS.PRICE_LIST_ASSIGNMENT_READ,
    "price_list_assignment",
    "View price list assignments",
  ),
  entry(
    PERMISSIONS.PRICE_LIST_ASSIGNMENT_CREATE,
    "price_list_assignment",
    "Create a price list assignment",
  ),
  entry(
    PERMISSIONS.PRICE_LIST_ASSIGNMENT_UPDATE,
    "price_list_assignment",
    "Update a price list assignment",
  ),
  entry(
    PERMISSIONS.PRICE_LIST_ASSIGNMENT_ARCHIVE,
    "price_list_assignment",
    "Archive a price list assignment",
  ),
  entry(
    PERMISSIONS.PRICE_LIST_ASSIGNMENT_SET_DEFAULT,
    "price_list_assignment",
    "Set the default price list for a legal entity",
  ),
  entry(PERMISSIONS.PRICE_LIST_ENTRY_READ, "price_list_entry", "View price list entries"),
  entry(
    PERMISSIONS.PRICE_LIST_ENTRY_CREATE,
    "price_list_entry",
    "Create a price list entry",
  ),
  entry(
    PERMISSIONS.PRICE_LIST_ENTRY_UPDATE,
    "price_list_entry",
    "Update a price list entry",
  ),
  entry(
    PERMISSIONS.PRICE_LIST_ENTRY_CLOSE,
    "price_list_entry",
    "Close a price list entry",
  ),
  entry(PERMISSIONS.PRICE_RESOLVE, "price", "Resolve a selling price"),

  entry(
    PERMISSIONS.CUSTOM_FIELD_DEFINITION_READ,
    "custom_field_definition",
    "View custom field definitions",
  ),
  entry(
    PERMISSIONS.CUSTOM_FIELD_DEFINITION_CREATE,
    "custom_field_definition",
    "Create a custom field definition",
  ),
  entry(
    PERMISSIONS.CUSTOM_FIELD_DEFINITION_UPDATE,
    "custom_field_definition",
    "Update a custom field definition",
  ),
  entry(
    PERMISSIONS.CUSTOM_FIELD_DEFINITION_SET_STATUS,
    "custom_field_definition",
    "Activate or deactivate a custom field definition",
  ),
  entry(
    PERMISSIONS.CUSTOM_FIELD_VALUE_READ,
    "custom_field_value",
    "Read custom field values",
  ),
  entry(
    PERMISSIONS.CUSTOM_FIELD_VALUE_WRITE,
    "custom_field_value",
    "Write custom field values",
  ),
];

const PHASE_1_KEY_SET = new Set<string>(PHASE_1_PERMISSION_KEYS);

export const PHASE_2_PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_CATALOG.map(
  (p) => p.key,
).filter((key) => !PHASE_1_KEY_SET.has(key));

/** Seeded per tenant at provisioning. `tenant_admin` holds every catalogue
 * permission; `member` holds only the original nine self-service/read
 * Phase-1 keys. Both are `isSystem = true` and therefore protected from
 * permission edits/deletion. */
export const SYSTEM_ROLES = {
  TENANT_ADMIN: {
    key: "tenant_admin",
    name: "Tenant Administrator",
    permissions: PERMISSION_CATALOG.map((p) => p.key),
  },
  MEMBER: {
    key: "member",
    name: "Member",
    permissions: [...MEMBER_PERMISSION_KEYS] as PermissionKey[],
  },
} as const;
