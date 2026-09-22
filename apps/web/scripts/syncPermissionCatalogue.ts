#!/usr/bin/env -S npx tsx
/**
 * Production permission-catalogue sync (P2D.0 / T-8).
 *
 * Upserts every `PERMISSION_CATALOG` row into `permission` and backfills
 * missing grants onto existing `is_system = true` `tenant_admin` roles.
 * Does not create tenants, users, or demo data. Does not grant Phase-2
 * keys to `member` or custom roles. Not invoked from request handling.
 *
 * Lives in apps/web because `@noahark/authz` must not depend on
 * `@noahark/db` (db already depends on authz). Uses the owner-role
 * system client so RLS cannot hide another tenant's system roles.
 */
import "dotenv/config";
import { pathToFileURL } from "node:url";
import { PERMISSION_CATALOG, SYSTEM_ROLES } from "@noahark/authz";
import { createSystemClient } from "@noahark/db/system";

export interface PermissionCatalogueSyncResult {
  permissionsInserted: number;
  permissionsUpdated: number;
  permissionsUnchanged: number;
  tenantAdminGrantsInserted: number;
  tenantAdminGrantsUnchanged: number;
}

type SystemClient = ReturnType<typeof createSystemClient>;
type SystemTx = Parameters<Parameters<SystemClient["$transaction"]>[0]>[0];

export async function syncPermissionCatalogueInTx(
  tx: SystemTx,
): Promise<PermissionCatalogueSyncResult> {
  const result: PermissionCatalogueSyncResult = {
    permissionsInserted: 0,
    permissionsUpdated: 0,
    permissionsUnchanged: 0,
    tenantAdminGrantsInserted: 0,
    tenantAdminGrantsUnchanged: 0,
  };

  for (const permission of PERMISSION_CATALOG) {
    const existing = await tx.permission.findUnique({
      where: { key: permission.key },
    });
    if (!existing) {
      await tx.permission.create({ data: permission });
      result.permissionsInserted += 1;
      continue;
    }
    if (
      existing.category === permission.category &&
      existing.description === permission.description
    ) {
      result.permissionsUnchanged += 1;
      continue;
    }
    await tx.permission.update({
      where: { key: permission.key },
      data: {
        category: permission.category,
        description: permission.description,
      },
    });
    result.permissionsUpdated += 1;
  }

  const permissionRows = await tx.permission.findMany({
    where: { key: { in: [...SYSTEM_ROLES.TENANT_ADMIN.permissions] } },
    select: { id: true, key: true },
  });
  const permissionByKey = new Map(permissionRows.map((row) => [row.key, row.id]));
  if (permissionByKey.size !== SYSTEM_ROLES.TENANT_ADMIN.permissions.length) {
    throw new Error(
      "Permission catalogue sync failed: tenant_admin keys are missing from permission after upsert",
    );
  }

  const adminRoles = await tx.role.findMany({
    where: { isSystem: true, key: SYSTEM_ROLES.TENANT_ADMIN.key },
    select: { id: true, tenantId: true },
  });

  for (const role of adminRoles) {
    for (const key of SYSTEM_ROLES.TENANT_ADMIN.permissions) {
      const permissionId = permissionByKey.get(key);
      if (!permissionId) {
        throw new Error(`Permission catalogue sync failed: missing permission ${key}`);
      }
      const existingGrant = await tx.rolePermission.findUnique({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
      });
      if (existingGrant) {
        result.tenantAdminGrantsUnchanged += 1;
        continue;
      }
      await tx.rolePermission.create({
        data: {
          tenantId: role.tenantId,
          roleId: role.id,
          permissionId,
        },
      });
      result.tenantAdminGrantsInserted += 1;
    }
  }

  return result;
}

export async function syncPermissionCatalogue(): Promise<PermissionCatalogueSyncResult> {
  const db = createSystemClient();
  try {
    return await db.$transaction((tx) => syncPermissionCatalogueInTx(tx));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Permission catalogue sync failed: ${message}`, { cause: error });
  }
}

async function main(): Promise<void> {
  const result = await syncPermissionCatalogue();
  console.warn("Permission catalogue sync complete.");
  console.warn(JSON.stringify(result));
}

const isDirectlyExecuted =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectlyExecuted) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
