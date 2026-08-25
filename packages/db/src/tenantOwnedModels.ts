/**
 * F-3C (Phase 1B): the authoritative classification of every Prisma model
 * by tenant/legal-entity ownership, used by guardExtension.ts. Kept as an
 * explicit list (not derived from the DMMF at runtime) so a reviewer can
 * diff it directly against schema.prisma's own table-grouping comments in
 * the RLS migration — the two lists SHOULD always describe the same
 * partition of models. `tenantOwnedModels.test.ts` cross-checks this list
 * against the live Prisma DMMF so it cannot silently drift as new models
 * are added.
 *
 * Global/identity models (User, UserCredential, Account, Session,
 * VerificationToken, Permission) are deliberately NOT listed here — they
 * have no tenant_id column and no RLS policy by design (see
 * packages/db/src/client.ts's getIdentityClient doc comment).
 */

/** Requires ONLY a tenant context (no legal_entity_id column, or the
 * column is present but access is intentionally tenant-wide — see
 * schema.prisma's comment on the `legal_entity` model itself). */
export const TENANT_SCOPED_MODELS: ReadonlySet<string> = new Set([
  "Tenant",
  "TenantEntitlement",
  "TenantSetting",
  "LegalEntity",
  "Role",
  "RolePermission",
  "IdempotencyKey",
  "ApprovalStep",
  "ApprovalDecision",
  "Attachment",
  "NotificationPreference",
  "MembershipRole",
  "TenantMembership",
  "LegalEntityMembership",
  "FieldPolicy",
  "AuditEvent",
  "MembershipInvitation",
  // Phase 2A - tenant-owned shared masters and reference data.
  // Party/CatalogItem/PriceList carry `owner_legal_entity_id` for mutation
  // ownership (ADR-73) but remain in this partition: they are still
  // tenant-level shared masters. Visibility is owner-OR-assignment, not
  // dual-axis restriction to a single legal entity, so they are not
  // LEGAL_ENTITY_REQUIRED. CatalogCategory and UnitOfMeasure have no owner
  // column; they stay tenant-visible reference data.
  "Party",
  "PartyContact",
  "PartyAddress",
  "CatalogCategory",
  "UnitOfMeasure",
  "CatalogItem",
  "PriceList",
]);

/** Requires tenant context AND a non-null legal_entity_id on every row —
 * org-structure tables. A caller with ZERO legal-entity grants can never
 * legitimately create one of these rows (there is no "tenant-wide" case),
 * so the guard extension additionally blocks writes here when the active
 * scope's legalEntityIds set is empty — a heuristic that is always
 * correct for this group specifically (see guardExtension.ts). */
export const LEGAL_ENTITY_REQUIRED_MODELS: ReadonlySet<string> = new Set([
  "LegalEntitySetting",
  "BusinessUnit",
  "Department",
  "Team",
  "Branch",
  "Warehouse",
  "CostCentre",
  // Phase 2A - entity-scoped assignments and roles. Every row carries a
  // non-null legal_entity_id and is protected by the dual-axis policy.
  "PartyLegalEntityAssignment",
  "CustomerRole",
  "VendorRole",
  "CatalogItemLegalEntityAssignment",
  "PriceListLegalEntityAssignment",
  "PriceListEntry",
]);

/** Requires tenant context; legal_entity_id is NULLABLE (a null value
 * legitimately means "tenant-wide", e.g. a demo approval submitted by a
 * user with no legal-entity grants at all) — the guard extension must NOT
 * apply the empty-legalEntityIds write heuristic here, since a caller with
 * zero grants can still legitimately write a tenant-wide row. Per-row
 * legal-entity correctness for these models is enforced by authorize() and
 * RLS's WITH CHECK, not by this app-layer guard. */
export const LEGAL_ENTITY_NULLABLE_MODELS: ReadonlySet<string> = new Set([
  "ApprovalPolicy",
  "ApprovalRequest",
  "DemoApprovalSubject",
  "OutboxEvent",
  "BackgroundJob",
  "Notification",
  "FileObject",
  "CustomFieldDefinition",
  // Phase 2A: CustomFieldValue gained a NULLABLE legal_entity_id (mandatory
  // for Phase 2 target types, NULL for legacy foundation rows), so it moves
  // from the tenant-only partition into the nullable-entity partition to
  // match its upgraded dual-axis RLS policy.
  "CustomFieldValue",
]);

export const LEGAL_ENTITY_SCOPED_MODELS: ReadonlySet<string> = new Set([
  ...LEGAL_ENTITY_REQUIRED_MODELS,
  ...LEGAL_ENTITY_NULLABLE_MODELS,
]);

/** Global identity tables with no RLS — deliberately reachable without any
 * tenant scope (see getIdentityClient). Listed explicitly so the DMMF
 * cross-check test can confirm nothing is missing from either list. */
export const GLOBAL_MODELS: ReadonlySet<string> = new Set([
  "User",
  "UserCredential",
  "Account",
  "Session",
  "VerificationToken",
  "Permission",
  "MfaCredential",
  "MfaRecoveryCode",
  "AuthRateLimitBucket",
  "TestEmailCapture",
]);

export function isTenantOwnedModel(model: string): boolean {
  return TENANT_SCOPED_MODELS.has(model) || LEGAL_ENTITY_SCOPED_MODELS.has(model);
}

export function isLegalEntityRequiredModel(model: string): boolean {
  return LEGAL_ENTITY_REQUIRED_MODELS.has(model);
}
