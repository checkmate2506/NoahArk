import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { NotFoundError } from "@noahark/core";
import {
  createCustomFieldDefinition,
  getCustomFieldDefinition,
  getCustomFieldValue,
  setCustomFieldValue,
} from "../../lib/services/customFieldDomain";
import * as customFieldDomain from "../../lib/services/customFieldDomain";
import { cleanupTenant, cleanupUser } from "./testHelpers";
import {
  createStringDefinition,
  createTestParty,
  fieldKey,
  setStringValue,
  setupCustomFieldDomainFixture,
  type CustomFieldDomainFixture,
} from "./customFieldDomainFixture";

async function asApp<T>(
  tenantId: string,
  legalEntityIds: string[],
  fn: (c: pg.Client) => Promise<T>,
): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
    await c.query("SELECT set_config('app.legal_entity_ids', $1, false)", [
      legalEntityIds.join(","),
    ]);
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function asWorker<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_WORKER_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe("P2C.3 — custom-field RLS adversarial probes", () => {
  let fixture: CustomFieldDomainFixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await cleanupTenant(fixture.setup.tenantId).catch(() => undefined);
      await cleanupUser(fixture.setup.adminUserId).catch(() => undefined);
      await cleanupUser(fixture.userAId).catch(() => undefined);
      await cleanupUser(fixture.userBId).catch(() => undefined);
      fixture = undefined;
    }
  });

  it("uses ordinary noahark_app RLS and does not widen context", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, ctxB, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definition = await createStringDefinition(ctxA, "party");
    const value = await setStringValue(ctxA, definition.id, party.party.id, "owner");

    const visibleToB = await asApp(ctxB.tenantId, [fixture.leB.id], async (c) => {
      const result = await c.query("SELECT id FROM custom_field_value WHERE id = $1", [
        value.id,
      ]);
      return result.rowCount;
    });
    expect(visibleToB).toBe(0);

    await expect(getCustomFieldValue(ctxB, value.id)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(customFieldDomain).not.toHaveProperty("getSystemClient");
  });

  it("fails closed when the target-integrity trigger is RLS-filtered", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const { ctxA, leA } = fixture;
    const party = await createTestParty(ctxA, leA.id);
    const definition = await createCustomFieldDefinition(ctxA, {
      entityType: "party",
      key: fieldKey("trg"),
      label: "Trigger",
      dataType: "STRING",
    });
    await expect(
      setCustomFieldValue(ctxA, {
        definitionId: definition.id,
        entityId: "missing-target-id-000",
        value: { dataType: "STRING", value: "x" },
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const stolen = await asApp(ctxA.tenantId, [leA.id], async (c) => {
      try {
        await c.query(
          `INSERT INTO custom_field_value (
             id, tenant_id, legal_entity_id, definition_id, entity_type, entity_id, value_text
           ) VALUES (
             $1, $2, $3, $4, 'party', $5, 'x'
           )`,
          [
            `cfv_${fieldKey("raw")}`,
            ctxA.tenantId,
            leA.id,
            definition.id,
            party.party.id + "-missing",
          ],
        );
        return "allowed";
      } catch (error) {
        return (error as { code?: string }).code ?? "unknown";
      }
    });
    expect(stolen).not.toBe("allowed");
    expect(["23514", "P0001", "23503", "42501"]).toContain(stolen);
  });

  it("denies noahark_worker on custom-field tables", async () => {
    fixture = await setupCustomFieldDomainFixture();
    const tables = ["custom_field_definition", "custom_field_value"];
    const denied: string[] = [];
    await asWorker(async (c) => {
      for (const t of tables) {
        for (const stmt of [
          `SELECT * FROM "${t}" LIMIT 1`,
          `DELETE FROM "${t}"`,
          `UPDATE "${t}" SET tenant_id = tenant_id`,
        ]) {
          try {
            await c.query(stmt);
          } catch (e) {
            if ((e as { code?: string }).code === "42501") denied.push(`${t}:${stmt[0]}`);
            continue;
          }
          throw new Error(`worker was ALLOWED to run: ${stmt}`);
        }
      }
    });
    expect(denied.length).toBe(tables.length * 3);
    await expect(
      getCustomFieldDefinition(fixture.ctxA, "does-not-exist"),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
