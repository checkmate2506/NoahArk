#!/usr/bin/env node
/**
 * F-4 (Phase 1B): environment provisioning, separated from the Prisma
 * migration chain.
 *
 * Creates (idempotently) the two application-facing Postgres roles
 * (noahark_app, noahark_worker) and grants them CONNECT on the target
 * database and USAGE on the public schema. This is deliberately NOT a
 * Prisma migration:
 *   - Role creation and GRANT CONNECT ON DATABASE are environment-level
 *     operations, not schema changes — they must run once per database
 *     instance, not once per migration history.
 *   - CREATE ROLE requires CREATEROLE-equivalent privilege. On Azure
 *     Database for PostgreSQL Flexible Server the admin login is a member
 *     of azure_pg_admin (not a real superuser) — it CAN create ordinary
 *     roles, but MUST NOT be asked to grant BYPASSRLS (it cannot, and the
 *     roles this script creates deliberately never request it — see F-12
 *     in the RLS migration for why noahark_worker no longer needs it).
 *   - The target database name is read from the connection string itself,
 *     never hardcoded, so this works against any database name.
 *
 * Run this BEFORE `prisma migrate deploy` in any environment (the RLS
 * migration GRANTs privileges to these roles by name and will fail if they
 * do not already exist).
 *
 * Usage:
 *   DATABASE_MIGRATION_URL=... \
 *   NOAHARK_APP_DB_PASSWORD=... \
 *   NOAHARK_WORKER_DB_PASSWORD=... \
 *   node provisioning/provision-roles.mjs
 *
 * Password env vars are REQUIRED outside development/test (see
 * assertPasswordSourceIsSafe below) — this script refuses to fall back to
 * the well-known local dev passwords (matching .env.example /
 * docker-compose.yml) anywhere else.
 */
import "dotenv/config";
import pg from "pg";
import { pathToFileURL } from "node:url";

const { Client } = pg;

const DEV_DEFAULT_APP_PASSWORD = "noahark_app";
const DEV_DEFAULT_WORKER_PASSWORD = "noahark_worker";

export function resolveRolePasswords(env = process.env) {
  const nodeEnv = env.NODE_ENV ?? "development";
  const appPassword = env.NOAHARK_APP_DB_PASSWORD;
  const workerPassword = env.NOAHARK_WORKER_DB_PASSWORD;

  if (nodeEnv === "production") {
    if (!appPassword || !workerPassword) {
      throw new Error(
        "NOAHARK_APP_DB_PASSWORD and NOAHARK_WORKER_DB_PASSWORD are required when NODE_ENV=production " +
          "— refusing to fall back to the well-known development role passwords in a production environment.",
      );
    }
    return { appPassword, workerPassword };
  }

  return {
    appPassword: appPassword ?? DEV_DEFAULT_APP_PASSWORD,
    workerPassword: workerPassword ?? DEV_DEFAULT_WORKER_PASSWORD,
  };
}

export function parseDatabaseName(connectionString) {
  const url = new URL(connectionString);
  const name = url.pathname.replace(/^\//, "");
  if (!name) throw new Error("DATABASE_MIGRATION_URL has no database name in its path");
  return name;
}

/**
 * N-7 (Phase 1D): creates `roleName` with `password` if it does not already
 * exist, or re-asserts its non-secret attributes (never its password) if it
 * does — idempotent either way. `roleName` is always one of this script's
 * own two fixed literals (never external input) but is still passed through
 * `escapeIdentifier()` for defense-in-depth/symmetry with the DATABASE
 * GRANTs below. `password` is passed through `escapeLiteral()`, which
 * correctly SQL-escapes embedded quotes AND backslashes per
 * `standard_conforming_strings` (unlike a naive `.replace(/'/g, "''")`) —
 * and, critically, this statement is issued on its own, never inside a
 * dollar-quoted `DO $$ ... $$` block, so a password containing `$$` cannot
 * terminate anything early.
 */
export async function ensureRole(client, roleName, password) {
  const ident = client.escapeIdentifier(roleName);
  const { rows } = await client.query(
    "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
    [roleName],
  );
  if (rows.length === 0) {
    const lit = client.escapeLiteral(password);
    await client.query(
      `CREATE ROLE ${ident} LOGIN PASSWORD ${lit} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
  } else {
    await client.query(
      `ALTER ROLE ${ident} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
  }
}

/**
 * P1G-6/P1G-7 (Phase 1H): idempotently creates the NOLOGIN role that owns
 * the cross-tenant SECURITY DEFINER maintenance functions (see the RLS
 * migration's "Cross-tenant maintenance role" / "Worker DELETE hardening"
 * sections). NOLOGIN means this role has no password and nothing can ever
 * authenticate as it directly — it exists purely to be a function owner.
 * Mirrors ensureRole's idempotency (re-asserts non-secret attributes on
 * every run) but has no PASSWORD clause at all, so there is nothing to
 * escape/interpolate here.
 */
export async function ensureNoLoginRole(client, roleName) {
  const ident = client.escapeIdentifier(roleName);
  const { rows } = await client.query(
    "SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1",
    [roleName],
  );
  if (rows.length === 0) {
    await client.query(
      `CREATE ROLE ${ident} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
  } else {
    await client.query(
      `ALTER ROLE ${ident} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
  }
}

async function main() {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  if (!migrationUrl) throw new Error("DATABASE_MIGRATION_URL is not set");

  const { appPassword, workerPassword } = resolveRolePasswords();
  const databaseName =
    process.env.NOAHARK_APP_DATABASE_NAME ?? parseDatabaseName(migrationUrl);

  const client = new Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    console.warn(`Provisioning roles for database "${databaseName}"...`);

    // Idempotent: the PASSWORD is only set at creation time — this script
    // never resets a password that may have already been rotated by an
    // operator after initial provisioning. The non-secret attributes
    // (NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS) ARE re-asserted via
    // ALTER ROLE every run even for a pre-existing role, so provisioning
    // converges an older role (e.g. one created before F-12 removed
    // BYPASSRLS from noahark_worker) to today's intended state rather than
    // silently leaving stale privilege attributes in place.
    //
    // N-7 (Phase 1D): previously interpolated the password directly into a
    // `DO $$ ... $$` PL/pgSQL block with only `'` doubled — CREATE/ALTER
    // ROLE's PASSWORD clause grammatically requires a plain string literal
    // (Postgres has no parameterized-query support for it; verified
    // directly against a live server: `PASSWORD $1` is a syntax error), so
    // full literal-safety was never optional. But quote-doubling alone does
    // not protect a value embedded inside `$$ ... $$` dollar-quoting — a
    // password containing the literal substring `$$` would terminate the
    // block early and let the remainder of the password be parsed as SQL.
    // The fix here is not a smarter escape function; it is removing the
    // dollar-quoted block for these two statements entirely. Existence is
    // checked from JS (a plain SELECT, no interpolation), and each
    // CREATE/ALTER ROLE is issued as its own top-level statement using
    // `client.escapeLiteral()` — the same correctly-implemented escaping
    // node-postgres already uses for identifiers via `escapeIdentifier()`
    // below, verified directly against a live server across quotes,
    // `$$`, semicolons, backslashes, and literal SQL-injection payloads
    // (see provision-roles.live.test.ts's PASSWORD_CASES).
    await ensureRole(client, "noahark_app", appPassword);
    await ensureRole(client, "noahark_worker", workerPassword);
    // P1G-6/P1G-7 (Phase 1H): the NOLOGIN owner of the cross-tenant
    // SECURITY DEFINER maintenance functions — see the RLS migration. No
    // CONNECT grant needed below (NOLOGIN roles can never open a session
    // to connect with in the first place).
    await ensureNoLoginRole(client, "noahark_maintenance_definer");

    // GRANT CONNECT/USAGE use quoted identifiers built from a value parsed
    // out of our OWN connection string, not user-supplied request input —
    // still passed through pg's identifier quoting rather than naive string
    // interpolation.
    await client.query(
      `GRANT CONNECT ON DATABASE ${client.escapeIdentifier(databaseName)} TO noahark_app`,
    );
    await client.query(
      `GRANT CONNECT ON DATABASE ${client.escapeIdentifier(databaseName)} TO noahark_worker`,
    );
    await client.query("GRANT USAGE ON SCHEMA public TO noahark_app");
    await client.query("GRANT USAGE ON SCHEMA public TO noahark_worker");
    await client.query("GRANT USAGE ON SCHEMA public TO noahark_maintenance_definer");

    // Phase 1H.2: sets this DATABASE's default session `TimeZone` to UTC —
    // applies to every NEW session any role opens against it from now on
    // (including the migration/system role, which this script does not
    // otherwise touch). This is not merely a display-formatting
    // preference: Phase 1H.2's live investigation found `@prisma/adapter-pg`
    // (used by every Prisma client in this codebase) serializes a JS `Date`
    // written to a genuine `timestamptz` column INCORRECTLY whenever the
    // connection's session `TimeZone` is not UTC — verified directly, the
    // stored instant comes out shifted by exactly the session's UTC offset
    // (e.g. a job meant to run in 1 hour was stored 8 hours in the past
    // under a UTC+8 session). This is a genuine defect in that third-party
    // adapter's write path, not something `AT TIME ZONE` casts on the read
    // side can fix — the value is already wrong by the time it reaches
    // disk. Database-level (not role-level) so it covers every role,
    // including whichever credential DATABASE_MIGRATION_URL happens to use
    // in a given environment (locally `postgres`; on Azure Database for
    // PostgreSQL Flexible Server, the `azure_pg_admin`-derived admin login)
    // — a role this script does not create and should not assume it may
    // ALTER ROLE. Requires only database-owner privilege (this script's
    // own credential already owns every database it provisions, having
    // created it), unlike ALTER ROLE ... SET on a role outside this
    // script's control. `ALTER DATABASE ... SET` only affects sessions
    // opened AFTER this statement runs — this script always runs before
    // any application/worker/test connection, so every real session sees
    // the corrected default.
    await client.query(
      `ALTER DATABASE ${client.escapeIdentifier(databaseName)} SET timezone TO 'UTC'`,
    );

    console.warn(
      "Provisioning complete: noahark_app, noahark_worker, noahark_maintenance_definer roles ready.",
    );
    console.warn(
      "Next: run `pnpm db:migrate:deploy` to apply the schema and RLS migrations.",
    );
  } finally {
    await client.end();
  }
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
