import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AccessContext } from "@noahark/core";
import { authorize } from "./authorize";
import {
  EXCLUDED_PHASE_2_ARCHIVE_KEYS,
  MEMBER_PERMISSION_KEYS,
  PERMISSION_CATALOG,
  PERMISSIONS,
  PHASE_1_PERMISSION_KEYS,
  PHASE_2_PERMISSION_KEYS,
  SYSTEM_ROLES,
  type PermissionKey,
} from "./permissions";

const pkgRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

function ctx(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    requestId: "req-1",
    userId: "user-1",
    tenantId: "tenant-1",
    legalEntityIds: new Set(["le-sg"]),
    permissions: new Set([PERMISSIONS.TENANT_READ]),
    legalEntityPermissions: new Map(),
    roleIds: new Set(),
    legalEntityRoleIds: new Map(),
    ...overrides,
  };
}

describe("P2D.0 permission catalogue", () => {
  it("has unique keys and matching PERMISSIONS / PERMISSION_CATALOG", () => {
    const keys = PERMISSION_CATALOG.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual([...Object.values(PERMISSIONS)].slice().sort());
  });

  it("uses resource:action keys and excludes deferred master archives", () => {
    for (const key of PERMISSION_CATALOG.map((p) => p.key)) {
      expect(key).toMatch(/^[a-z][a-z0-9_.]*:[a-z][a-z0-9_:]*$/);
    }
    const keySet = new Set<string>(PERMISSION_CATALOG.map((p) => p.key));
    for (const excluded of EXCLUDED_PHASE_2_ARCHIVE_KEYS) {
      expect(keySet.has(excluded)).toBe(false);
    }
  });

  it("contains exactly 33 Phase-1 keys and 63 Phase-2 keys", () => {
    expect(PHASE_1_PERMISSION_KEYS).toHaveLength(33);
    expect(PHASE_2_PERMISSION_KEYS).toHaveLength(63);
    expect(PERMISSION_CATALOG).toHaveLength(96);
    expect(PHASE_2_PERMISSION_KEYS).toEqual(
      expect.arrayContaining([
        PERMISSIONS.PARTY_CONTACT_EMAIL_READ,
        PERMISSIONS.PARTY_CONTACT_PHONE_READ,
        PERMISSIONS.PRICE_RESOLVE,
        PERMISSIONS.CUSTOM_FIELD_VALUE_WRITE,
      ]),
    );
    expect(PHASE_2_PERMISSION_KEYS).not.toEqual(
      expect.arrayContaining([...EXCLUDED_PHASE_2_ARCHIVE_KEYS]),
    );
  });

  it("grants tenant_admin every catalogue key and leaves member at nine Phase-1 keys", () => {
    expect(SYSTEM_ROLES.TENANT_ADMIN.permissions).toEqual(
      PERMISSION_CATALOG.map((p) => p.key),
    );
    expect(SYSTEM_ROLES.MEMBER.permissions).toEqual([...MEMBER_PERMISSION_KEYS]);
    expect(SYSTEM_ROLES.MEMBER.permissions).toEqual([
      PERMISSIONS.TENANT_READ,
      PERMISSIONS.LEGAL_ENTITY_READ,
      PERMISSIONS.MEMBERSHIP_READ,
      PERMISSIONS.ROLE_READ,
      PERMISSIONS.SETTINGS_READ,
      PERMISSIONS.APPROVAL_SUBMIT,
      PERMISSIONS.APPROVAL_READ,
      PERMISSIONS.FILE_UPLOAD,
      PERMISSIONS.FILE_READ,
    ]);
  });

  it("authorize matches exact keys and does not treat prefixes as wildcards", () => {
    const c = ctx({
      permissions: new Set<PermissionKey>([PERMISSIONS.PARTY_READ]),
    });
    expect(() => authorize(c, { permission: PERMISSIONS.PARTY_READ })).not.toThrow();
    expect(() => authorize(c, { permission: PERMISSIONS.PARTY_UPDATE })).toThrow(
      /Missing permission/,
    );
    expect(() =>
      authorize(c, { permission: PERMISSIONS.PARTY_CONTACT_EMAIL_READ }),
    ).toThrow(/Missing permission/);
  });

  it("does not import @noahark/db (sync lives in apps/web to keep the DAG acyclic)", () => {
    const files = walkTsFiles(join(pkgRoot, "src")).filter(
      (f) => !f.endsWith(".test.ts"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/@noahark\/db/);
    }
    const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).toEqual({ "@noahark/core": "workspace:*" });
  });
});
