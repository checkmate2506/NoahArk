import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createAppClient, withTenantContext, type AppClient } from "@noahark/db";
import { createSystemClient } from "@noahark/db/system";
import {
  setupTestTenant,
  cleanupTenant,
  cleanupUser,
  createTestLegalEntity,
  type TestTenantSetup,
} from "./testHelpers";

/**
 * F-22 (Phase 1B.1): proves the RLS session-variable pattern
 * (`set_config('app.tenant_id', value, true)` — the `true` is `is_local`,
 * meaning "SET LOCAL" semantics: visible only inside the current
 * transaction, discarded on commit/rollback) cannot leak between requests
 * on a POOLED, REUSED physical connection. Every test here uses a
 * dedicated `AppClient` built with `{ max: 1 }` (via createAppClient — see
 * its doc comment in packages/db/src/client.ts) so there is only ONE
 * physical connection in the pool: every `withTenantContext` call in a
 * given test is GUARANTEED to reuse the exact same connection, which is
 * what makes "no leak" a real proof rather than a coincidence of pool
 * scheduling. If `set_config` were ever changed from `is_local=true` to
 * `is_local=false` (SET, not SET LOCAL — session-scoped, survives commit),
 * the very first test below would start failing, because tenant A's
 * context would still be readable after its transaction committed.
 */
describe("RLS pooled-connection isolation (F-22, real Postgres, forced single connection)", () => {
  let pooledClient: AppClient;
  let setups: TestTenantSetup[] = [];

  afterEach(async () => {
    if (pooledClient) {
      await pooledClient.$disconnect();
    }
    for (const setup of setups) {
      await cleanupTenant(setup.tenantId);
      await cleanupUser(setup.adminUserId);
    }
    setups = [];
  });

  function newPooledClient(): AppClient {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    pooledClient = createAppClient(url, { max: 1 });
    return pooledClient;
  }

  async function newSetup() {
    const setup = await setupTestTenant();
    setups.push(setup);
    return setup;
  }

  it("alternating tenants on a max-1-connection pool never see each other's tenant row", async () => {
    const setupA = await newSetup();
    const setupB = await newSetup();
    const client = newPooledClient();

    for (let i = 0; i < 6; i++) {
      await withTenantContext(
        { tenantId: setupA.tenantId, legalEntityIds: new Set() },
        async (tx) => {
          const rows = await tx.tenant.findMany({});
          expect(rows.map((r) => r.id)).toEqual([setupA.tenantId]);
        },
        client,
      );
      await withTenantContext(
        { tenantId: setupB.tenantId, legalEntityIds: new Set() },
        async (tx) => {
          const rows = await tx.tenant.findMany({});
          expect(rows.map((r) => r.id)).toEqual([setupB.tenantId]);
        },
        client,
      );
    }
  });

  it("context is removed after a COMMIT — the same physical connection shows no leftover app.tenant_id", async () => {
    const setup = await newSetup();
    const client = newPooledClient();

    await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set() },
      async (tx) => {
        await tx.tenant.findMany({});
      },
      client,
    );

    // Raw query, deliberately OUTSIDE withTenantContext, on the SAME
    // single-connection pool — current_setting(..., true) returns NULL if
    // never set OR '' if set-then-reset-by-commit (see the F-7 comment in
    // the RLS migration on this exact NULL-vs-'' distinction); either way
    // proves the value is gone, not "still A".
    const rows = await client.$queryRaw<Array<{ v: string | null }>>`
      SELECT current_setting('app.tenant_id', true) AS v
    `;
    expect(rows[0]?.v ?? null).not.toBe(setup.tenantId);
  });

  it("context is removed after an explicit thrown-error ROLLBACK", async () => {
    const setup = await newSetup();
    const client = newPooledClient();

    await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set() },
      async () => {
        throw new Error("deliberate rollback trigger");
      },
      client,
    ).catch(() => undefined);

    const rows = await client.$queryRaw<Array<{ v: string | null }>>`
      SELECT current_setting('app.tenant_id', true) AS v
    `;
    expect(rows[0]?.v ?? null).not.toBe(setup.tenantId);
  });

  it("context is removed after a DATABASE-LEVEL failed transaction (constraint violation, not a JS throw)", async () => {
    const setup = await newSetup();
    const client = newPooledClient();

    await withTenantContext(
      { tenantId: setup.tenantId, legalEntityIds: new Set() },
      async (tx) => {
        // A duplicate primary key — Postgres itself aborts the transaction
        // (25P02 on any subsequent statement, then rollback on commit
        // attempt) rather than JS ever throwing synchronously.
        await tx.$executeRawUnsafe(
          `INSERT INTO "tenant" (id, name, slug, status, created_at, updated_at) VALUES ($1, 'dup', 'dup-slug', 'ACTIVE', now(), now())`,
          setup.tenantId, // reuses an existing id -> PK violation
        );
      },
      client,
    ).catch(() => undefined);

    const rows = await client.$queryRaw<Array<{ v: string | null }>>`
      SELECT current_setting('app.tenant_id', true) AS v
    `;
    expect(rows[0]?.v ?? null).not.toBe(setup.tenantId);
  });

  it("missing context (no withTenantContext at all) fails closed even though real data exists", async () => {
    const setup = await newSetup();
    const client = newPooledClient();

    // Prove the row genuinely exists via the system (RLS-bypassing) client
    // first — otherwise "zero rows" would just mean "table is empty",
    // which is NOT proof of enforcement (see this file's own doc comment
    // and the review's explicit warning about that false proof).
    const system = createSystemClient();
    const exists = await system.tenant.findUnique({ where: { id: setup.tenantId } });
    expect(exists).not.toBeNull();

    // Raw query through the pooled app-role client with NO scope ever set
    // on this connection — RLS must filter it to zero rows regardless.
    const rows = await client.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "tenant" WHERE id = ${setup.tenantId}
    `;
    expect(rows).toHaveLength(0);
  });

  it("an empty legal_entity_ids set fails closed at the RLS layer itself (WITH CHECK), not merely the app-level guard", async () => {
    const setup = await newSetup();
    const legalEntity = await createTestLegalEntity(setup.tenantId, "SG");
    const client = newPooledClient();

    // Raw SQL bypasses the JS-level tenant guard extension entirely (it
    // only wraps Prisma MODEL operations, not $executeRaw) — so a rejection
    // here can only come from Postgres's own RLS WITH CHECK clause on
    // business_unit (tenant_id required, legal_entity_id required,
    // filtered by `legal_entity_id = ANY(string_to_array(app.legal_entity_ids, ','))`
    // — an empty app.legal_entity_ids string_to_array's to `['']`, which no
    // real legal_entity_id ever equals).
    await expect(
      withTenantContext(
        { tenantId: setup.tenantId, legalEntityIds: new Set() },
        (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO "business_unit" (id, tenant_id, legal_entity_id, name, created_at) VALUES ($1, $2, $3, 'test', now())`,
            randomUUID(),
            setup.tenantId,
            legalEntity.id,
          ),
        client,
      ),
    ).rejects.toThrow();
  });

  it("a NON-empty legal_entity_ids set that DOES include the target entity succeeds (control case)", async () => {
    const setup = await newSetup();
    const legalEntity = await createTestLegalEntity(setup.tenantId, "MY");
    const client = newPooledClient();

    await expect(
      withTenantContext(
        { tenantId: setup.tenantId, legalEntityIds: new Set([legalEntity.id]) },
        (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO "business_unit" (id, tenant_id, legal_entity_id, name, created_at) VALUES ($1, $2, $3, 'test', now())`,
            randomUUID(),
            setup.tenantId,
            legalEntity.id,
          ),
        client,
      ),
    ).resolves.toBe(1);
  });
});
