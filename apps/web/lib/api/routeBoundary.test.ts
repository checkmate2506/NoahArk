import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  tenantReadPostRoute,
  tenantReadRoute,
  tenantWriteRoute,
  type TenantBoundRouteConfig,
} from "./tenantRoute";
import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TENANT_API_ROOT = "app/api/v1/tenants/[tenantId]";

/** Committed Phase-1 tenant routes. Any other discovered tenant route.ts is Phase-2. */
export const PHASE_1_TENANT_ROUTE_PATHS: ReadonlySet<string> = new Set([
  "app/api/v1/tenants/[tenantId]/route.ts",
  "app/api/v1/tenants/[tenantId]/approvals/route.ts",
  "app/api/v1/tenants/[tenantId]/approvals/[requestId]/decide/route.ts",
  "app/api/v1/tenants/[tenantId]/audit/route.ts",
  "app/api/v1/tenants/[tenantId]/files/route.ts",
  "app/api/v1/tenants/[tenantId]/files/[fileId]/route.ts",
  "app/api/v1/tenants/[tenantId]/invitations/route.ts",
  "app/api/v1/tenants/[tenantId]/invitations/[invitationId]/route.ts",
  "app/api/v1/tenants/[tenantId]/legal-entities/route.ts",
  "app/api/v1/tenants/[tenantId]/legal-entities/[legalEntityId]/route.ts",
  "app/api/v1/tenants/[tenantId]/legal-entities/[legalEntityId]/access/route.ts",
  "app/api/v1/tenants/[tenantId]/legal-entities/[legalEntityId]/access/[userId]/route.ts",
  "app/api/v1/tenants/[tenantId]/legal-entities/[legalEntityId]/settings/route.ts",
  "app/api/v1/tenants/[tenantId]/memberships/route.ts",
  "app/api/v1/tenants/[tenantId]/memberships/[membershipId]/route.ts",
  "app/api/v1/tenants/[tenantId]/notifications/route.ts",
  "app/api/v1/tenants/[tenantId]/notifications/[notificationId]/read/route.ts",
  "app/api/v1/tenants/[tenantId]/role-assignments/route.ts",
  "app/api/v1/tenants/[tenantId]/role-assignments/[assignmentId]/route.ts",
  "app/api/v1/tenants/[tenantId]/roles/route.ts",
  "app/api/v1/tenants/[tenantId]/roles/[roleId]/route.ts",
  "app/api/v1/tenants/[tenantId]/settings/route.ts",
]);

/** Only planned genuinely read-only POST exception. The file does not exist yet. */
export const READ_ONLY_POST_ROUTE_PATHS: ReadonlySet<string> = new Set([
  "app/api/v1/tenants/[tenantId]/parties/duplicate-candidates/route.ts",
]);

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const BANNED_IMPORTS = new Set(["@noahark/db/system", "@noahark/db/worker"]);
const BANNED_IDENTIFIERS = new Set([
  "createSystemClient",
  "createWorkerClient",
  "driverAdapterError",
  "originalCode",
  "sqlState",
]);
const REQUEST_AUTHORITY_IDENTIFIERS = new Set([
  "actingUserId",
  "permissionKeys",
  "legalEntityIds",
]);
const BANNED_STRINGS = new Set([
  "23P01",
  "23505",
  "23514",
  "42501",
  "P2002",
  "P2003",
  "P2025",
  "P2039",
]);

function listRouteTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listRouteTsFiles(full));
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

function isRouteFile(label: string): boolean {
  return /(^|\/)route\.ts$/.test(label.replace(/\\/g, "/"));
}

function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return expr.expression.text;
  }
  return undefined;
}

function collectLocalInitializers(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const locals = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          locals.set(decl.name.text, decl.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return locals;
}

function resolveConstructor(
  name: string,
  locals: Map<string, ts.Expression>,
  seen: Set<string> = new Set(),
): string | undefined {
  if (seen.has(name)) return undefined;
  seen.add(name);
  const init = locals.get(name);
  if (!init) return undefined;
  const direct = calleeName(init);
  if (direct) return direct;
  if (ts.isIdentifier(init)) return resolveConstructor(init.text, locals, seen);
  return undefined;
}

function isZodObjectCallee(expr: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    return expr.expression.text === "z" && expr.name.text === "object";
  }
  if (ts.isIdentifier(expr) && /Schema$/.test(expr.text)) return true;
  return false;
}

function isPermissionsInRequestSchema(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  let objectLiteral: ts.ObjectLiteralExpression | undefined;
  while (current) {
    if (ts.isObjectLiteralExpression(current) && !objectLiteral) {
      objectLiteral = current;
    }
    if (
      objectLiteral &&
      ts.isCallExpression(current) &&
      current.arguments.some((arg) => arg === objectLiteral) &&
      isZodObjectCallee(current.expression)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isPermissionsBindingFromRequest(node: ts.BindingElement): boolean {
  const stmt = node.parent?.parent;
  if (!stmt || !ts.isVariableDeclaration(stmt) || !stmt.initializer) return false;
  const init = stmt.initializer;
  if (ts.isAwaitExpression(init) && ts.isCallExpression(init.expression)) {
    const callee = init.expression.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === "json") {
      return true;
    }
  }
  return false;
}

export function scanPhase2RouteSource(source: string, fileLabel: string): string[] {
  const offenders: string[] = [];
  const sourceFile = ts.createSourceFile(
    fileLabel,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const locals = collectLocalInitializers(sourceFile);
  const exportedMethods = new Map<
    string,
    { constructorName?: string | undefined; form: string }
  >();

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (BANNED_IMPORTS.has(node.moduleSpecifier.text)) {
        offenders.push(`${fileLabel} — ${node.moduleSpecifier.text}`);
      }
    }

    if (ts.isIdentifier(node)) {
      if (BANNED_IDENTIFIERS.has(node.text)) {
        offenders.push(`${fileLabel} — ${node.text}`);
      }
      if (REQUEST_AUTHORITY_IDENTIFIERS.has(node.text)) {
        offenders.push(`${fileLabel} — request-defined ${node.text}`);
      }
      if (node.text === "AccessContext") {
        let current: ts.Node | undefined = node.parent;
        while (current) {
          if (ts.isCallExpression(current) && isZodObjectCallee(current.expression)) {
            offenders.push(`${fileLabel} — AccessContext inside a request schema`);
            break;
          }
          current = current.parent;
        }
      }
      if (node.text === "$transaction") {
        offenders.push(`${fileLabel} — route-level transaction`);
      }
    }

    if (ts.isStringLiteral(node) && BANNED_STRINGS.has(node.text)) {
      const label =
        node.text.startsWith("P") && node.text.length === 5
          ? `Prisma ${node.text}`
          : `SQLSTATE ${node.text}`;
      offenders.push(`${fileLabel} — ${label}`);
    }

    if (ts.isBindingElement(node) && node.name.getText(sourceFile) === "permissions") {
      if (isPermissionsBindingFromRequest(node)) {
        offenders.push(`${fileLabel} — request-defined permissions field`);
      }
    }

    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "permissions" &&
      isPermissionsInRequestSchema(node)
    ) {
      offenders.push(`${fileLabel} — request-defined permissions field`);
    }

    if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && !node.exportClause) {
        offenders.push(`${fileLabel} — star re-export`);
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const spec of node.exportClause.elements) {
          const exported = spec.name.text;
          if (!HTTP_METHODS.has(exported)) continue;
          const local = (spec.propertyName ?? spec.name).text;
          exportedMethods.set(exported, {
            constructorName: resolveConstructor(local, locals),
            form: `export { ${local} as ${exported} }`,
          });
        }
      }
    }

    if (ts.isFunctionDeclaration(node)) {
      const exported =
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
      if (exported && node.name && HTTP_METHODS.has(node.name.text)) {
        exportedMethods.set(node.name.text, {
          form: node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
            ? `export async function ${node.name.text}`
            : `export function ${node.name.text}`,
        });
      }
    }

    if (ts.isVariableStatement(node)) {
      const exported =
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
      if (exported) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name) || !HTTP_METHODS.has(decl.name.text)) continue;
          exportedMethods.set(decl.name.text, {
            constructorName: decl.initializer ? calleeName(decl.initializer) : undefined,
            form: `export const ${decl.name.text}`,
          });
        }
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (exportedMethods.has("DELETE")) {
    offenders.push(`${fileLabel} — Phase-2 DELETE export`);
  }

  if (isRouteFile(fileLabel)) {
    const rel = fileLabel.replace(/\\/g, "/");
    for (const [method, meta] of exportedMethods) {
      if (method === "DELETE") continue;
      if (method === "GET") {
        if (meta.constructorName !== "tenantReadRoute") {
          offenders.push(`${fileLabel} — GET must use tenantReadRoute`);
        }
        continue;
      }
      if (method === "POST") {
        if (meta.constructorName === "tenantWriteRoute") continue;
        if (
          meta.constructorName === "tenantReadPostRoute" &&
          READ_ONLY_POST_ROUTE_PATHS.has(rel)
        ) {
          continue;
        }
        offenders.push(`${fileLabel} — POST must use tenantWriteRoute`);
        continue;
      }
      if (method === "PUT" || method === "PATCH") {
        if (meta.constructorName !== "tenantWriteRoute") {
          offenders.push(`${fileLabel} — ${method} must use tenantWriteRoute`);
        }
      }
    }
  }

  return offenders;
}

export function scanPhase2RouteTree(root: string): string[] {
  const offenders: string[] = [];
  for (const file of listRouteTsFiles(join(root, TENANT_API_ROOT))) {
    const rel = relative(root, file).replace(/\\/g, "/");
    if (PHASE_1_TENANT_ROUTE_PATHS.has(rel)) continue;
    offenders.push(...scanPhase2RouteSource(readFileSync(file, "utf8"), rel));
  }
  return offenders;
}

function writeTenantRoute(root: string, namespace: string, source: string): string {
  const dir = join(root, TENANT_API_ROOT, namespace);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "route.ts");
  writeFileSync(file, source);
  return relative(root, file).replace(/\\/g, "/");
}

describe("Phase-2 route boundary scanner", () => {
  it("finds no Phase-2 offenders among discovered tenant routes (none exist yet)", () => {
    expect(scanPhase2RouteTree(WEB_ROOT)).toEqual([]);
  });

  it("scans an arbitrary previously unknown namespace automatically", () => {
    const dir = mkdtempSync(join(tmpdir(), "noahark-p2d1-discover-"));
    try {
      const rel = writeTenantRoute(
        dir,
        "never-listed-ns",
        `export const DELETE = async () => jsonOk({});\n`,
      );
      const hits = scanPhase2RouteTree(dir);
      expect(hits.some((h) => h.includes(rel) && h.includes("DELETE"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not flag a legitimate path parameter tenantId or ctx.permissions", () => {
    const source = `
      import { tenantReadRoute } from "@/lib/api/tenantRoute";
      import { PERMISSIONS } from "@noahark/authz";
      export const GET = tenantReadRoute({
        permission: PERMISSIONS.PARTY_READ,
        handler: async (req, requestId, params, ctx) => {
          return jsonOk({ tenantId: params.tenantId, actor: ctx.userId, held: [...ctx.permissions] });
        },
      });
    `;
    expect(
      scanPhase2RouteSource(source, "app/api/v1/tenants/[tenantId]/parties/route.ts"),
    ).toEqual([]);
  });

  it("does not flag an unrelated internal permissions property", () => {
    const source = `
      import { tenantReadRoute } from "@/lib/api/tenantRoute";
      import { PERMISSIONS } from "@noahark/authz";
      type ResultDto = { permissions: string[] };
      export const GET = tenantReadRoute({
        permission: PERMISSIONS.PARTY_READ,
        handler: async () => {
          const dto: ResultDto = { permissions: ["internal"] };
          return jsonOk(dto);
        },
      });
    `;
    expect(
      scanPhase2RouteSource(source, "app/api/v1/tenants/[tenantId]/parties/route.ts"),
    ).toEqual([]);
  });

  it("rejects every DELETE export form", () => {
    const forms = [
      {
        file: "export const DELETE = ...",
        source: `export const DELETE = apiHandler(async () => jsonOk({}));\n`,
      },
      {
        file: "export function DELETE",
        source: `export function DELETE() { return jsonOk({}); }\n`,
      },
      {
        file: "export async function DELETE",
        source: `export async function DELETE() { return jsonOk({}); }\n`,
      },
      {
        file: "export { handler as DELETE }",
        source: `const handler = async () => jsonOk({});\nexport { handler as DELETE };\n`,
      },
      {
        file: "re-exported DELETE alias",
        source: `const remove = async () => jsonOk({});\nexport { remove as DELETE };\n`,
      },
    ];
    for (const form of forms) {
      const hits = scanPhase2RouteSource(
        form.source,
        `app/api/v1/tenants/[tenantId]/parties/${form.file}/route.ts`,
      );
      expect(
        hits.some((h) => h.includes("Phase-2 DELETE export")),
        `${form.file} must be rejected`,
      ).toBe(true);
    }
  });

  it("enforces GET/read, read-only POST allowlist, and write constructors", () => {
    const getWrong = scanPhase2RouteSource(
      `export const GET = tenantWriteRoute({ permission: PERMISSIONS.PARTY_READ, handler: async () => jsonOk({}) });\n`,
      "app/api/v1/tenants/[tenantId]/parties/route.ts",
    );
    expect(getWrong.some((h) => h.includes("GET must use tenantReadRoute"))).toBe(true);

    const postRead = scanPhase2RouteSource(
      `export const POST = tenantReadPostRoute({ permission: PERMISSIONS.PARTY_READ, handler: async () => jsonOk({}) });\n`,
      "app/api/v1/tenants/[tenantId]/parties/route.ts",
    );
    expect(postRead.some((h) => h.includes("POST must use tenantWriteRoute"))).toBe(true);

    const duplicateOk = scanPhase2RouteSource(
      `export const POST = tenantReadPostRoute({ permission: PERMISSIONS.PARTY_READ, handler: async () => jsonOk({}) });\n`,
      "app/api/v1/tenants/[tenantId]/parties/duplicate-candidates/route.ts",
    );
    expect(duplicateOk).toEqual([]);

    const putWrong = scanPhase2RouteSource(
      `export const PUT = tenantReadRoute({ permission: PERMISSIONS.PARTY_READ, handler: async () => jsonOk({}) });\n`,
      "app/api/v1/tenants/[tenantId]/parties/route.ts",
    );
    expect(putWrong.some((h) => h.includes("PUT must use tenantWriteRoute"))).toBe(true);

    const patchOk = scanPhase2RouteSource(
      `export const PATCH = tenantWriteRoute({ permission: PERMISSIONS.PARTY_UPDATE, handler: async () => jsonOk({}) });\n`,
      "app/api/v1/tenants/[tenantId]/parties/route.ts",
    );
    expect(patchOk).toEqual([]);
  });

  it("detects banned privileged clients, request-defined identity, SQLSTATE, Prisma codes, and transactions", () => {
    const dir = mkdtempSync(join(tmpdir(), "noahark-p2d1-route-"));
    try {
      const probes: Array<{ ns: string; source: string; label: string }> = [
        {
          ns: "system-client",
          source: `import { createSystemClient } from "@noahark/db/system";\nexport const GET = tenantReadRoute({ permission: PERMISSIONS.PARTY_READ, handler: async () => jsonOk({}) });\n`,
          label: "@noahark/db/system",
        },
        {
          ns: "worker-client",
          source: `import { createWorkerClient } from "@noahark/db/worker";\nexport const GET = tenantReadRoute({ permission: PERMISSIONS.PARTY_READ, handler: async () => jsonOk({}) });\n`,
          label: "@noahark/db/worker",
        },
        {
          ns: "acting",
          source: `import { tenantReadRoute } from "@/lib/api/tenantRoute";\nconst body = z.object({ actingUserId: z.string() });\nexport const GET = tenantReadRoute({ permission: PERMISSIONS.PARTY_READ, handler: async () => jsonOk({}) });\n`,
          label: "request-defined actingUserId",
        },
        {
          ns: "entities",
          source: `import { tenantReadRoute } from "@/lib/api/tenantRoute";\nconst body = z.object({ legalEntityIds: z.array(z.string()) });\nexport const GET = tenantReadRoute({ permission: PERMISSIONS.PARTY_READ, handler: async () => jsonOk({}) });\n`,
          label: "request-defined legalEntityIds",
        },
        {
          ns: "perms",
          source: `import { tenantReadRoute } from "@/lib/api/tenantRoute";\nconst body = z.object({ permissions: z.array(z.string()) });\nexport const GET = tenantReadRoute({ permission: PERMISSIONS.PARTY_READ, handler: async () => jsonOk({}) });\n`,
          label: "request-defined permissions field",
        },
        {
          ns: "sqlstate",
          source: `import { tenantReadRoute } from "@/lib/api/tenantRoute";\nif (err.code === "23P01") throw e;\nexport const GET = tenantReadRoute({ permission: PERMISSIONS.PARTY_READ, handler: async () => jsonOk({}) });\n`,
          label: "SQLSTATE 23P01",
        },
        {
          ns: "prisma",
          source: `import { tenantReadRoute } from "@/lib/api/tenantRoute";\nif (err.code === "P2002") throw e;\nexport const GET = tenantReadRoute({ permission: PERMISSIONS.PARTY_READ, handler: async () => jsonOk({}) });\n`,
          label: "Prisma P2002",
        },
        {
          ns: "tx",
          source: `import { tenantReadRoute } from "@/lib/api/tenantRoute";\nawait db.$transaction(async (tx) => tx);\nexport const GET = tenantReadRoute({ permission: PERMISSIONS.PARTY_READ, handler: async () => jsonOk({}) });\n`,
          label: "route-level transaction",
        },
        {
          ns: "schema-ctx",
          source: `import { tenantReadRoute } from "@/lib/api/tenantRoute";\nconst Body = z.object({ AccessContext: z.any() });\nexport const GET = tenantReadRoute({ permission: PERMISSIONS.PARTY_READ, handler: async () => jsonOk({}) });\n`,
          label: "AccessContext inside a request schema",
        },
      ];
      const hits: string[] = [];
      for (const probe of probes) {
        const rel = writeTenantRoute(dir, probe.ns, probe.source);
        hits.push(...scanPhase2RouteSource(probe.source, rel));
      }
      expect(scanPhase2RouteTree(dir).length).toBeGreaterThan(0);
      for (const probe of probes) {
        expect(
          hits.some((h) => h.includes(probe.ns) && h.includes(probe.label)),
          `probe ${probe.ns} must fail the guard`,
        ).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tenant route structural contract", () => {
  it("requires an explicit permission on every constructor", () => {
    const required: Array<keyof TenantBoundRouteConfig> = ["permission", "handler"];
    expect(required).toEqual(["permission", "handler"]);
    expect(() =>
      tenantReadRoute({
        permission: undefined as never,
        handler: async () => jsonOk({}),
      }),
    ).toThrow(/permission/);
    expect(() =>
      tenantWriteRoute({
        permission: PERMISSIONS.PARTY_CREATE,
        handler: undefined as never,
      }),
    ).toThrow(/handler/);
    expect(() =>
      tenantReadPostRoute({
        permission: undefined as never,
        handler: async () => jsonOk({}),
      }),
    ).toThrow(/permission/);
  });

  it("binds methods structurally and keeps the write limiter on the write constructor only", () => {
    const source = readFileSync(join(WEB_ROOT, "lib/api/tenantRoute.ts"), "utf8");
    expect(source).toMatch(/export function tenantReadRoute/);
    expect(source).toMatch(/export function tenantReadPostRoute/);
    expect(source).toMatch(/export function tenantWriteRoute/);
    expect(source).not.toMatch(/export function tenantRoute/);
    expect(source).not.toMatch(/operation:\s*"read"\s*\|\s*"write"/);
    expect(source).toMatch(/kind === "write"/);
    expect(source).toMatch(/enforceTenantWriteRateLimit/);
    expect(source).toMatch(/!allowedMethods\.has\(req\.method\)/);
    expect(source).toMatch(/authorize\(ctx, \{ permission: config\.permission/);
    expect(source).not.toMatch(/legalEntityIds/);
    expect(source).not.toMatch(/any accessible entity/);
    expect(source).not.toMatch(/for \(const .+ of ctx\.legalEntityIds/);
    expect(source).not.toMatch(/permission\s*=\s*PERMISSIONS/);
    expect(source).not.toMatch(/createSystemClient|createWorkerClient/);
    expect(source).toMatch(/req\.clone\(\)/);
    expect(source).toMatch(/resolveTenantContext\(req, requestId, tenantId\)/);
  });
});
