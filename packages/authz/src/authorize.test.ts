import { describe, expect, it } from "vitest";
import type { AccessContext } from "@noahark/core";
import {
  authorize,
  can,
  authorizeField,
  isFieldProtected,
  maskProtectedFields,
  assertCanAssignRole,
  assertCanGrantLegalEntityAccess,
  type FieldPolicyRule,
} from "./authorize";
import { PERMISSIONS } from "./permissions";

function ctx(overrides: Partial<AccessContext> = {}): AccessContext {
  return {
    requestId: "req-1",
    userId: "user-1",
    tenantId: "tenant-1",
    legalEntityIds: new Set(["le-sg"]),
    permissions: new Set([PERMISSIONS.TENANT_READ]),
    legalEntityPermissions: new Map([
      ["le-sg", new Set([PERMISSIONS.LEGAL_ENTITY_READ])],
    ]),
    roleIds: new Set(),
    legalEntityRoleIds: new Map(),
    ...overrides,
  };
}

describe("authorize — module permission (check 3)", () => {
  it("allows an action the caller has permission for", () => {
    expect(() => authorize(ctx(), { permission: PERMISSIONS.TENANT_READ })).not.toThrow();
  });

  it("rejects an action the caller lacks permission for", () => {
    expect(() => authorize(ctx(), { permission: PERMISSIONS.TENANT_UPDATE })).toThrow(
      /Missing permission/,
    );
  });
});

describe("authorize — legal-entity access (check 2)", () => {
  it("allows a legal-entity-scoped permission the caller holds within that entity", () => {
    expect(() =>
      authorize(ctx(), {
        permission: PERMISSIONS.LEGAL_ENTITY_READ,
        legalEntityId: "le-sg",
      }),
    ).not.toThrow();
  });

  it("rejects access to a legal entity the caller has no membership in", () => {
    expect(() =>
      authorize(ctx(), {
        permission: PERMISSIONS.LEGAL_ENTITY_READ,
        legalEntityId: "le-my",
      }),
    ).toThrow(/No access to this legal entity/);
  });

  it("does not let entity-scoped permissions leak into a different entity", () => {
    const c = ctx({
      legalEntityIds: new Set(["le-sg", "le-my"]),
      legalEntityPermissions: new Map([
        ["le-sg", new Set([PERMISSIONS.LEGAL_ENTITY_UPDATE])],
      ]),
    });
    expect(() =>
      authorize(c, {
        permission: PERMISSIONS.LEGAL_ENTITY_UPDATE,
        legalEntityId: "le-my",
      }),
    ).toThrow(/Missing permission/);
  });
});

describe("authorize — record scope (check 4)", () => {
  it("rejects when the record-scope predicate returns false", () => {
    expect(() =>
      authorize(ctx(), {
        permission: PERMISSIONS.TENANT_READ,
        recordScope: () => false,
      }),
    ).toThrow(/outside your access scope/);
  });

  it("allows when the record-scope predicate returns true", () => {
    expect(() =>
      authorize(ctx(), {
        permission: PERMISSIONS.TENANT_READ,
        recordScope: () => true,
      }),
    ).not.toThrow();
  });
});

describe("can()", () => {
  it("returns false instead of throwing", () => {
    expect(can(ctx(), { permission: PERMISSIONS.TENANT_UPDATE })).toBe(false);
    expect(can(ctx(), { permission: PERMISSIONS.TENANT_READ })).toBe(true);
  });
});

describe("field-level access (check 5)", () => {
  const policies: FieldPolicyRule[] = [
    {
      entityType: "demo",
      fieldName: "secret",
      requiredPermission: PERMISSIONS.DEMO_PROTECTED_FIELD_READ,
    },
  ];

  it("treats an unregistered field as unprotected", () => {
    expect(isFieldProtected(policies, "demo", "public")).toBe(false);
    expect(() => authorizeField(ctx(), policies, "demo", "public")).not.toThrow();
  });

  it("rejects a protected field without the required permission", () => {
    expect(() => authorizeField(ctx(), policies, "demo", "secret")).toThrow(
      /Missing permission/,
    );
  });

  it("allows a protected field with the required permission", () => {
    const c = ctx({ permissions: new Set([PERMISSIONS.DEMO_PROTECTED_FIELD_READ]) });
    expect(() => authorizeField(c, policies, "demo", "secret")).not.toThrow();
  });

  it("masks protected fields the caller cannot see", () => {
    const record = { public: "ok", secret: "hidden" };
    const masked = maskProtectedFields(ctx(), policies, "demo", record);
    expect(masked.public).toBe("ok");
    expect("secret" in masked).toBe(false);
  });

  it("keeps protected fields visible when the caller has the permission", () => {
    const c = ctx({ permissions: new Set([PERMISSIONS.DEMO_PROTECTED_FIELD_READ]) });
    const record = { public: "ok", secret: "visible" };
    const masked = maskProtectedFields(c, policies, "demo", record);
    expect(masked.secret).toBe("visible");
  });
});

describe("self-escalation guards", () => {
  it("rejects assigning a role to yourself", () => {
    const c = ctx({ permissions: new Set([PERMISSIONS.ROLE_ASSIGN]) });
    expect(() =>
      assertCanAssignRole(c, {
        targetUserId: "user-1",
        rolePermissions: [PERMISSIONS.TENANT_READ],
      }),
    ).toThrow(/cannot change your own role/);
  });

  it("rejects granting a role with permissions the actor lacks", () => {
    const c = ctx({ permissions: new Set([PERMISSIONS.ROLE_ASSIGN]) });
    expect(() =>
      assertCanAssignRole(c, {
        targetUserId: "user-2",
        rolePermissions: [PERMISSIONS.TENANT_UPDATE],
      }),
    ).toThrow(/permissions you do not hold/);
  });

  it("allows assigning a role the actor could grant to someone else", () => {
    const c = ctx({
      permissions: new Set([PERMISSIONS.ROLE_ASSIGN, PERMISSIONS.TENANT_READ]),
    });
    expect(() =>
      assertCanAssignRole(c, {
        targetUserId: "user-2",
        rolePermissions: [PERMISSIONS.TENANT_READ],
      }),
    ).not.toThrow();
  });

  it("rejects an unauthorised actor assigning any role", () => {
    const c = ctx({ permissions: new Set() });
    expect(() =>
      assertCanAssignRole(c, {
        targetUserId: "user-2",
        rolePermissions: [PERMISSIONS.TENANT_READ],
      }),
    ).toThrow(/Missing permission/);
  });

  it("rejects granting yourself legal-entity access", () => {
    const c = ctx({
      legalEntityPermissions: new Map([
        ["le-sg", new Set([PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_GRANT])],
      ]),
    });
    expect(() =>
      assertCanGrantLegalEntityAccess(c, {
        targetUserId: "user-1",
        legalEntityId: "le-sg",
      }),
    ).toThrow(/cannot grant yourself/);
  });

  it("allows granting another user legal-entity access", () => {
    const c = ctx({
      legalEntityPermissions: new Map([
        ["le-sg", new Set([PERMISSIONS.LEGAL_ENTITY_MEMBERSHIP_GRANT])],
      ]),
    });
    expect(() =>
      assertCanGrantLegalEntityAccess(c, {
        targetUserId: "user-2",
        legalEntityId: "le-sg",
      }),
    ).not.toThrow();
  });
});
