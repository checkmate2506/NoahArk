import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { PERMISSION_CATALOG, PERMISSIONS, SYSTEM_ROLES } from "@noahark/authz";
import { createSystemClient } from "@noahark/db/system";
import {
  syncPermissionCatalogue,
  syncPermissionCatalogueInTx,
} from "../../scripts/syncPermissionCatalogue";
import {
  createDisposableTestDatabase,
  dropDisposableTestDatabase,
} from "../testDbLifecycle";
import { cleanupTenant, cleanupUser, setupTestTenant, uniqueSlug } from "./testHelpers";

const DB_PACKAGE_DIR = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../packages/db",
);
const MIGRATION_00005 = "20260914000005_p2d0_custom_field_hardening";
const EXPECTED_MIGRATIONS = [
  "20260817000001_init",
  "20260817000002_rls_and_constraints",
  "20260824000003_parties_catalog",
  "20260824000004_p2a_audit_hardening",
  MIGRATION_00005,
];

describe("P2D.0 permission catalogue sync", () => {
  let extraTenantId: string | undefined;
  let extraUserId: string | undefined;

  afterEach(async () => {
    if (extraTenantId) {
      await cleanupTenant(extraTenantId).catch(() => undefined);
      extraTenantId = undefined;
    }
    if (extraUserId) {
      await cleanupUser(extraUserId).catch(() => undefined);
      extraUserId = undefined;
    }
  });

  it("inserts missing catalogue rows and is idempotent on a second run", async () => {
    const db = createSystemClient();
    const existingKeys = new Set(
      (await db.permission.findMany({ select: { key: true } })).map((row) => row.key),
    );
    const missing = PERMISSION_CATALOG.filter((p) => !existingKeys.has(p.key)).length;

    const first = await syncPermissionCatalogue();
    expect(first.permissionsInserted).toBe(missing);
    expect(
      first.permissionsInserted + first.permissionsUpdated + first.permissionsUnchanged,
    ).toBe(PERMISSION_CATALOG.length);
    const second = await syncPermissionCatalogue();
    expect(second.permissionsInserted).toBe(0);
    expect(second.permissionsUpdated).toBe(0);
    expect(second.permissionsUnchanged).toBe(PERMISSION_CATALOG.length);
    const keys = await db.permission.findMany({ select: { key: true } });
    const catalogKeys = new Set<string>(PERMISSION_CATALOG.map((p) => p.key));
    expect(keys.filter((row) => catalogKeys.has(row.key))).toHaveLength(
      PERMISSION_CATALOG.length,
    );
  });

  it("backfills tenant_admin only and leaves member and custom roles unchanged", async () => {
    const db = createSystemClient();
    const setup = await setupTestTenant();
    extraTenantId = setup.tenantId;
    extraUserId = setup.adminUserId;

    const custom = await db.role.create({
      data: {
        tenantId: setup.tenantId,
        key: uniqueSlug("custom"),
        name: "Custom",
        isSystem: false,
        rolePermissions: {
          create: {
            tenantId: setup.tenantId,
            permissionId: (
              await db.permission.findUniqueOrThrow({
                where: { key: PERMISSIONS.TENANT_READ },
              })
            ).id,
          },
        },
      },
    });

    const adminBefore = await db.rolePermission.count({
      where: { roleId: setup.adminRoleId },
    });
    await db.rolePermission.deleteMany({
      where: {
        roleId: setup.adminRoleId,
        permission: { key: { in: PERMISSION_CATALOG.slice(33).map((p) => p.key) } },
      },
    });
    const memberBefore = await db.rolePermission.count({
      where: { roleId: setup.memberRoleId },
    });
    const customBefore = await db.rolePermission.count({
      where: { roleId: custom.id },
    });

    const result = await syncPermissionCatalogue();
    expect(result.tenantAdminGrantsInserted).toBeGreaterThan(0);

    const adminAfter = await db.rolePermission.count({
      where: { roleId: setup.adminRoleId },
    });
    expect(adminAfter).toBe(PERMISSION_CATALOG.length);
    expect(adminAfter).toBeGreaterThan(adminBefore - PERMISSION_CATALOG.slice(33).length);
    expect(await db.rolePermission.count({ where: { roleId: setup.memberRoleId } })).toBe(
      memberBefore,
    );
    expect(await db.rolePermission.count({ where: { roleId: custom.id } })).toBe(
      customBefore,
    );
    expect(memberBefore).toBe(SYSTEM_ROLES.MEMBER.permissions.length);
  });

  it("rolls back the catalogue write when the transaction throws", async () => {
    const db = createSystemClient();
    const marker = `p2d0-rollback-${uniqueSlug("k")}`;
    const before = await db.permission.findUnique({ where: { key: "party:read" } });
    await expect(
      db.$transaction(async (tx) => {
        await syncPermissionCatalogueInTx(tx);
        await tx.permission.update({
          where: { key: "party:read" },
          data: { description: marker },
        });
        throw new Error("forced rollback");
      }),
    ).rejects.toThrow("forced rollback");
    const after = await db.permission.findUnique({ where: { key: "party:read" } });
    expect(after?.description).toBe(before?.description);
    expect(after?.description).not.toBe(marker);
  });

  it("fresh integration DB has 00001-00005 and upgrades from 00004 to 00005", async () => {
    const current = new pg.Client({
      connectionString: process.env.DATABASE_MIGRATION_URL,
    });
    await current.connect();
    try {
      const version = await current.query<{ version: string }>("SELECT version()");
      expect(version.rows[0]?.version).toMatch(/PostgreSQL (16\.14|18\.4)/);
      const applied = await current.query<{ migration_name: string }>(
        "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at",
      );
      expect(applied.rows.map((row) => row.migration_name)).toEqual(EXPECTED_MIGRATIONS);
    } finally {
      await current.end();
    }

    const src = path.join(DB_PACKAGE_DIR, "prisma", "migrations", MIGRATION_00005);
    const parkRoot = path.join(DB_PACKAGE_DIR, ".p2d0-park");
    const parked = path.join(parkRoot, MIGRATION_00005);
    mkdirSync(parkRoot, { recursive: true });
    renameSync(src, parked);
    let extra: Awaited<ReturnType<typeof createDisposableTestDatabase>> | undefined;
    try {
      extra = await createDisposableTestDatabase(
        "p2d0upgrade",
        process.env.DATABASE_MIGRATION_URL ?? "",
      );
      const before = new pg.Client({ connectionString: extra.migrationUrl });
      await before.connect();
      try {
        const names = await before.query<{ migration_name: string }>(
          "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at",
        );
        expect(names.rows.map((row) => row.migration_name)).toEqual(
          EXPECTED_MIGRATIONS.slice(0, 4),
        );
      } finally {
        await before.end();
      }
    } finally {
      if (existsSync(parked)) renameSync(parked, src);
      rmSync(parkRoot, { recursive: true, force: true });
    }

    if (!extra) throw new Error("upgrade database was not created");
    try {
      const first = spawnSync("npx", ["prisma", "migrate", "deploy"], {
        cwd: DB_PACKAGE_DIR,
        env: { ...process.env, DATABASE_MIGRATION_URL: extra.migrationUrl },
        shell: true,
        encoding: "utf8",
      });
      expect(first.status, first.stdout + first.stderr).toBe(0);
      const after = new pg.Client({ connectionString: extra.migrationUrl });
      await after.connect();
      try {
        const names = await after.query<{ migration_name: string }>(
          "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at",
        );
        expect(names.rows.map((row) => row.migration_name)).toEqual(EXPECTED_MIGRATIONS);
      } finally {
        await after.end();
      }
      const second = spawnSync("npx", ["prisma", "migrate", "deploy"], {
        cwd: DB_PACKAGE_DIR,
        env: { ...process.env, DATABASE_MIGRATION_URL: extra.migrationUrl },
        shell: true,
        encoding: "utf8",
      });
      expect(second.status, second.stdout + second.stderr).toBe(0);
      expect(`${second.stdout}\n${second.stderr}`).toMatch(
        /No pending migrations|already in sync/i,
      );
    } finally {
      await dropDisposableTestDatabase(extra);
    }
  });
});
