import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * P1E-2 (Phase 1F): builds a matched pair of rules — `no-restricted-imports`
 * for static `import ... from "..."` (both the bare package subpath and any
 * relative path ending in systemClient/workerClient, e.g.
 * `../../../packages/db/src/systemClient`), and `no-restricted-syntax` for
 * the two forms `no-restricted-imports` cannot see at all: dynamic
 * `import("@noahark/db/system")` and `require("@noahark/db/system")` (and
 * the equivalent relative-path forms) — Phase 1E's live probe confirmed
 * both were live bypasses of the Phase 1D rule. One AST selector per form
 * because esquery doesn't support alternation across argument shapes.
 */
function buildPrivilegedClientBoundary({
  files,
  ignores,
  restrictSystem,
  restrictWorker,
}) {
  const targets = [
    ...(restrictSystem
      ? [
          {
            specifier: "@noahark/db/system",
            label: "owner/migration",
            envVar: "DATABASE_MIGRATION_URL",
          },
        ]
      : []),
    ...(restrictWorker
      ? [
          {
            specifier: "@noahark/db/worker",
            label: "worker-role",
            envVar: "DATABASE_WORKER_URL",
          },
        ]
      : []),
  ];
  if (targets.length === 0) return [];

  const relativePathPatternFor = (specifier) => {
    const clientFile = specifier.endsWith("/system") ? "systemClient" : "workerClient";
    return { group: [`**/${clientFile}`, `**/${clientFile}.ts`, `**/${clientFile}.js`] };
  };

  // esquery parses the selector as a STRING first — a literal "/" inside
  // the embedded /pattern/ form looks like the closing delimiter to ITS
  // parser (not to the underlying JS RegExp engine), so "/" must be
  // escaped as "\/" here in addition to normal regex metacharacters.
  const escapeForEsquerySelector = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const dynamicOrRequireSelectors = targets.flatMap(({ specifier, label, envVar }) => {
    const clientFile = specifier.endsWith("/system") ? "systemClient" : "workerClient";
    const valuePattern = `/^(${escapeForEsquerySelector(specifier)}|.*\\/${clientFile}(\\.(ts|js))?)$/`;
    const message =
      `Restricted from importing the ${label} Prisma client via a dynamic import()/require() ` +
      `(P1E-2, Phase 1F) — it requires ${envVar}. Static analysis cannot see through these forms, ` +
      `so they are blocked explicitly; use the RLS-enforced @noahark/db client instead.`;
    return [
      {
        selector: `ImportExpression[source.value=${valuePattern}]`,
        message,
      },
      {
        selector: `CallExpression[callee.name='require'] > Literal[value=${valuePattern}]`,
        message,
      },
    ];
  });

  return [
    {
      files,
      ...(ignores ? { ignores } : {}),
      rules: {
        "no-restricted-imports": [
          "error",
          {
            paths: targets.map(({ specifier, label, envVar }) => ({
              name: specifier,
              message:
                `Restricted from importing the ${label} Prisma client (P1E-2, Phase 1F) — it requires ` +
                `${envVar}, which this code must not need. See eslint.config.mjs for the exact boundary.`,
            })),
            patterns: targets.map(({ specifier }) => relativePathPatternFor(specifier)),
          },
        ],
        "no-restricted-syntax": ["error", ...dynamicOrRequireSelectors],
      },
    },
  ];
}

/**
 * P1G-3 (Phase 1H): `packages/jobs/src/**` is allowed to IMPORT the
 * worker-role Prisma client (`buildPrivilegedClientBoundary` above exempts
 * it, since queue.ts/outbox.ts's claim/complete/fail/reap logic genuinely
 * needs it) — but nothing stops it from RE-EXPORTING that same binding
 * through its own public barrel (`index.ts`'s `export *` pattern), which
 * would hand the privileged worker client to any ordinary app code that
 * imports `@noahark/jobs` (allowed everywhere — see the boundary above,
 * which does NOT restrict `@noahark/jobs` itself). Today nothing does this
 * (confirmed: queue.ts/outbox.ts import `getWorkerClient` but never export
 * it — see packages/jobs/src/jobsPublicSurface.test.ts for the structural
 * proof), but nothing STRUCTURALLY prevented it either. These selectors
 * forbid the two ways that could happen: re-exporting directly from
 * `@noahark/db/worker`/`@noahark/db/system`, or re-exporting a local
 * binding under one of the specific privileged-client names. Internal
 * `import { getWorkerClient } from "@noahark/db/worker"` USE within
 * packages/jobs is untouched — only `export` forms are restricted here.
 *
 * IMPORTANT: appended into the SAME `no-restricted-syntax` array as the
 * dynamic-import/require selectors `buildPrivilegedClientBoundary` already
 * produces for this exact `files` glob below, not a separate config
 * object — ESLint flat config replaces (does not merge) a rule's setting
 * when two config objects matching the same file both set it, so a
 * second, later object setting `no-restricted-syntax` for
 * `packages/jobs/src/**` would silently discard the dynamic-import
 * restriction instead of adding to it.
 */
const JOBS_EXPORT_BOUNDARY_SELECTORS = [
  {
    selector: "ExportNamedDeclaration[source.value=/^@noahark\\/db\\/(worker|system)$/]",
    message:
      "packages/jobs must not re-export from the privileged @noahark/db/worker or " +
      "@noahark/db/system entry points (P1G-3, Phase 1H) — that would hand a privileged " +
      "Prisma client to any code importing @noahark/jobs, which is unrestricted.",
  },
  {
    selector: "ExportAllDeclaration[source.value=/^@noahark\\/db\\/(worker|system)$/]",
    message:
      "packages/jobs must not re-export (export *) from the privileged @noahark/db/worker " +
      "or @noahark/db/system entry points (P1G-3, Phase 1H).",
  },
  {
    selector:
      "ExportSpecifier[exported.name=/^(getWorkerClient|workerClient|getSystemClient|systemClient|createSystemClient|disconnectWorkerClient|disconnectSystemClient)$/]",
    message:
      "packages/jobs must not re-export a privileged Prisma client binding under its own " +
      "name (P1G-3, Phase 1H) — internal use of getWorkerClient() inside packages/jobs is " +
      "fine; exporting it through this package's public surface is not.",
  },
];

export default tseslint.config(
  {
    ignores: [
      "**/.next/**",
      "**/dist/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/prisma/generated/**",
      "**/.embedded-postgres/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  ...buildPrivilegedClientBoundary({
    files: [
      "apps/web/app/**/*.{ts,tsx}",
      "apps/web/lib/**/*.{ts,tsx}",
      "apps/web/components/**/*.{ts,tsx}",
      "apps/web/middleware.ts",
    ],
    restrictSystem: true,
    restrictWorker: true,
  }),
  // P1E-2 (Phase 1F): the same boundary extended to every OTHER workspace
  // package's own source — none of core/config/authz/audit/auth/files/
  // notifications/ui/workflow has any legitimate reason to touch the
  // owner/migration or worker-role Prisma clients; only packages/jobs does
  // (its queue.ts/outbox.ts ARE the worker's claim/complete/fail logic —
  // see their own doc comments), and only for the worker client, never the
  // owner one. packages/db/src/** itself is excluded — it's the package
  // that DEFINES these clients, and its internal files legitimately
  // reference each other directly.
  ...buildPrivilegedClientBoundary({
    files: ["packages/*/src/**/*.{ts,tsx}"],
    ignores: ["packages/db/src/**", "packages/jobs/src/**"],
    restrictSystem: true,
    restrictWorker: true,
  }),
  ...(() => {
    const [jobsBoundary] = buildPrivilegedClientBoundary({
      files: ["packages/jobs/src/**/*.{ts,tsx}"],
      restrictSystem: true,
      restrictWorker: false,
    });
    // See JOBS_EXPORT_BOUNDARY_SELECTORS's own comment: appended into this
    // SAME array (not a separate config object) so both sets of
    // no-restricted-syntax selectors apply to packages/jobs/src/**.
    jobsBoundary.rules["no-restricted-syntax"] = [
      "error",
      ...jobsBoundary.rules["no-restricted-syntax"].slice(1),
      ...JOBS_EXPORT_BOUNDARY_SELECTORS,
    ];
    return [jobsBoundary];
  })(),
);
