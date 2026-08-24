/**
 * Development/demo seed. Runs against DATABASE_MIGRATION_URL (owner role,
 * bypasses RLS) — never used by the running application. Seeds:
 *   - the platform permission catalogue
 *   - one demo tenant with a SG + MY + ID legal entity each
 *   - the two system roles (tenant_admin, member) with their permissions
 *   - one demo admin user, tenant membership, and access to all three entities
 *   - a demo approval policy exercising the neutral DemoApprovalSubject flow
 *
 * SAFETY (F-1): this script plants a known-structure administrator account
 * and must never run against a real environment. It refuses to run unless
 * BOTH of the following hold:
 *   - ALLOW_DEMO_SEED=1 is set explicitly (opt-in, not opt-out)
 *   - NODE_ENV is not "production"
 *   - DATABASE_MIGRATION_URL does not look like a production target (see
 *     assertSeedTargetIsSafe below — a heuristic backstop, not a substitute
 *     for the two checks above)
 *
 * The admin password is randomly generated per run, printed ONCE to the
 * invoking terminal, and never written to a file, log, or this source. If
 * the admin user already exists, its password is left untouched (idempotent
 * re-seeding must never silently reset a credential that may have already
 * been changed by whoever received the original printed password).
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { PERMISSION_CATALOG, SYSTEM_ROLES } from "@noahark/authz";
import { hashPassword } from "@noahark/auth";
import { assertDatabaseTargetIsSafe } from "../src/safety";
import { createSystemClient } from "../src/systemClient";

/** Heuristic backstop only — the authoritative gate is ALLOW_DEMO_SEED +
 * NODE_ENV (see assertSeedIsAllowed below). Delegates the "does this look
 * like production" check to the shared helper also used by the Playwright
 * E2E global setup (F-24) — see packages/db/src/safety.ts. */
export function assertSeedTargetIsSafe(databaseUrl: string): void {
  assertDatabaseTargetIsSafe(databaseUrl, "Refusing to seed");
}

/** The authoritative, explicit-opt-in gate. Both checks are mandatory. */
export function assertSeedIsAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to seed: NODE_ENV=production. Seeding is a development/test-only operation.",
    );
  }
  if (env.ALLOW_DEMO_SEED !== "1") {
    throw new Error(
      "Refusing to seed: set ALLOW_DEMO_SEED=1 to explicitly confirm this is a development/test database. " +
        "This is required every run — it is not a one-time setup flag.",
    );
  }
}

function generateDemoPassword(): string {
  // 24 random bytes -> 32 base64url chars, well above the 12-char minimum
  // and never written anywhere but this run's stdout.
  return randomBytes(24).toString("base64url");
}

async function main() {
  assertSeedIsAllowed();
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  if (!migrationUrl) throw new Error("DATABASE_MIGRATION_URL is not set");
  assertSeedTargetIsSafe(migrationUrl);

  const db = createSystemClient();

  console.warn("Seeding permission catalogue...");
  for (const permission of PERMISSION_CATALOG) {
    await db.permission.upsert({
      where: { key: permission.key },
      create: permission,
      update: { category: permission.category, description: permission.description },
    });
  }

  console.warn("Seeding demo tenant...");
  const tenant = await db.tenant.upsert({
    where: { slug: "acme-group" },
    create: { name: "Acme Group", slug: "acme-group" },
    update: {},
  });

  console.warn("Seeding legal entities (SG / MY / ID)...");
  const [sg, my, id] = await Promise.all([
    db.legalEntity.upsert({
      where: { id: "seed-le-sg" },
      create: {
        id: "seed-le-sg",
        tenantId: tenant.id,
        name: "Acme Singapore Pte Ltd",
        jurisdiction: "SG",
        functionalCurrency: "SGD",
        timeZone: "Asia/Singapore",
        defaultLanguage: "EN",
      },
      update: {},
    }),
    db.legalEntity.upsert({
      where: { id: "seed-le-my" },
      create: {
        id: "seed-le-my",
        tenantId: tenant.id,
        name: "Acme Malaysia Sdn Bhd",
        jurisdiction: "MY",
        functionalCurrency: "MYR",
        timeZone: "Asia/Kuala_Lumpur",
        defaultLanguage: "MS",
      },
      update: {},
    }),
    db.legalEntity.upsert({
      where: { id: "seed-le-id" },
      create: {
        id: "seed-le-id",
        tenantId: tenant.id,
        name: "PT Acme Indonesia",
        jurisdiction: "ID",
        functionalCurrency: "IDR",
        timeZone: "Asia/Jakarta",
        defaultLanguage: "ID",
      },
      update: {},
    }),
  ]);

  console.warn("Seeding system roles...");
  const allPermissions = await db.permission.findMany();
  const permissionByKey = new Map(allPermissions.map((p) => [p.key, p.id]));

  const tenantAdminRole = await db.role.upsert({
    where: { tenantId_key: { tenantId: tenant.id, key: SYSTEM_ROLES.TENANT_ADMIN.key } },
    create: {
      tenantId: tenant.id,
      key: SYSTEM_ROLES.TENANT_ADMIN.key,
      name: SYSTEM_ROLES.TENANT_ADMIN.name,
      isSystem: true,
    },
    update: {},
  });
  const memberRole = await db.role.upsert({
    where: { tenantId_key: { tenantId: tenant.id, key: SYSTEM_ROLES.MEMBER.key } },
    create: {
      tenantId: tenant.id,
      key: SYSTEM_ROLES.MEMBER.key,
      name: SYSTEM_ROLES.MEMBER.name,
      isSystem: true,
    },
    update: {},
  });

  for (const [role, def] of [
    [tenantAdminRole, SYSTEM_ROLES.TENANT_ADMIN],
    [memberRole, SYSTEM_ROLES.MEMBER],
  ] as const) {
    for (const permKey of def.permissions) {
      const permissionId = permissionByKey.get(permKey);
      if (!permissionId) continue;
      await db.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        create: { tenantId: tenant.id, roleId: role.id, permissionId },
        update: {},
      });
    }
  }

  console.warn("Seeding demo admin user...");
  const existingAdmin = await db.user.findUnique({
    where: { email: "admin@noahark.demo" },
    include: { credential: true },
  });

  const adminUser = await db.user.upsert({
    where: { email: "admin@noahark.demo" },
    create: {
      email: "admin@noahark.demo",
      name: "Demo Admin",
      emailVerified: new Date(),
    },
    update: {},
  });

  // Idempotent: never reset a password that may already have been changed
  // by whoever received the originally printed credential.
  let generatedPassword: string | null = null;
  if (!existingAdmin?.credential) {
    generatedPassword = generateDemoPassword();
    const passwordHash = await hashPassword(generatedPassword);
    await db.userCredential.upsert({
      where: { userId: adminUser.id },
      create: { userId: adminUser.id, passwordHash, algorithm: "argon2id" },
      update: { passwordHash, algorithm: "argon2id" },
    });
  }

  const membership = await db.tenantMembership.upsert({
    where: { tenantId_userId: { tenantId: tenant.id, userId: adminUser.id } },
    create: { tenantId: tenant.id, userId: adminUser.id, status: "ACTIVE" },
    update: { status: "ACTIVE" },
  });

  for (const legalEntity of [sg, my, id]) {
    await db.legalEntityMembership.upsert({
      where: {
        legalEntityId_userId: { legalEntityId: legalEntity.id, userId: adminUser.id },
      },
      create: {
        tenantId: tenant.id,
        legalEntityId: legalEntity.id,
        userId: adminUser.id,
        status: "ACTIVE",
      },
      update: { status: "ACTIVE" },
    });
  }

  const existingAssignment = await db.membershipRole.findFirst({
    where: {
      tenantMembershipId: membership.id,
      roleId: tenantAdminRole.id,
      legalEntityId: null,
    },
  });
  if (!existingAssignment) {
    await db.membershipRole.create({
      data: {
        tenantId: tenant.id,
        tenantMembershipId: membership.id,
        roleId: tenantAdminRole.id,
        legalEntityId: null,
        assignedByUserId: adminUser.id,
      },
    });
  }

  console.warn("Seeding demo approval policy...");
  const policy = await db.approvalPolicy.findFirst({
    where: { tenantId: tenant.id, subjectType: "demo.approval_subject" },
  });
  const approvalPolicy =
    policy ??
    (await db.approvalPolicy.create({
      data: {
        tenantId: tenant.id,
        subjectType: "demo.approval_subject",
        name: "Demo approval (single step)",
        isActive: true,
      },
    }));
  const existingStep = await db.approvalStep.findFirst({
    where: { approvalPolicyId: approvalPolicy.id, stepOrder: 1 },
  });
  if (!existingStep) {
    await db.approvalStep.create({
      data: {
        tenantId: tenant.id,
        approvalPolicyId: approvalPolicy.id,
        stepOrder: 1,
        approverRoleId: tenantAdminRole.id,
        name: "Admin approval",
      },
    });
  }

  console.warn("Seed complete.");
  console.warn(`  Tenant: ${tenant.name} (${tenant.slug})`);
  if (generatedPassword) {
    console.warn("");
    console.warn("  ================================================================");
    console.warn("  Demo admin credential (shown ONCE — not stored anywhere else):");
    console.warn(`    email:    admin@noahark.demo`);
    console.warn(`    password: ${generatedPassword}`);
    console.warn("  ================================================================");
    console.warn("");
  } else {
    console.warn("  Admin: admin@noahark.demo (existing credential left unchanged)");
  }
  await db.$disconnect();
}

// Guarded so importing this module (e.g. from seed.test.ts, to unit-test the
// pure guard functions above) never triggers a live seed run as a side
// effect of the import itself. Compares resolved file:// URLs (not raw path
// strings) so this is robust to Windows path separators/drive-letter casing.
const isDirectlyExecuted =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectlyExecuted) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
