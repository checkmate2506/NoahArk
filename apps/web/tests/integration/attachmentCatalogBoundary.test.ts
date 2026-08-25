import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createSystemClient } from "@noahark/db/system";
import {
  setupTestTenant,
  createTestLegalEntity,
  cleanupTenant,
  cleanupUser,
} from "./testHelpers";

/**
 * Phase 2A — Attachment cross-entity boundary assessment (prompt section 14).
 *
 * FINDING, proven below: `attachment` carries a Phase 1 TENANT-ONLY RLS policy
 * and a polymorphic `(owner_entity_type, owner_entity_id)` owner reference. It
 * has no `legal_entity_id` of its own, so the policy cannot tell that an
 * attachment belongs to a record only one legal entity may see.
 *
 * Consequence: if a catalog item assigned ONLY to entity B carried an
 * attachment, an entity-A session could read that attachment's METADATA row
 * (its id, file-object id, uploader and timestamp) even though the catalog
 * item itself is correctly invisible to it. The file CONTENT stays protected —
 * `file_object` has the dual-axis policy and signed delivery is separately
 * gated — but the metadata leak alone discloses that entity B holds a document
 * against a specific record, and who uploaded it when.
 *
 * DISPOSITION: catalog attachments are PROHIBITED in Phase 2. `CatalogItem`
 * deliberately has no image/attachment field and no Phase 2 code creates an
 * attachment row for a Phase 2 owner type. Hardening `attachment` itself would
 * mean rewriting a Phase 1 policy that the signed-file delivery workflow
 * depends on — a change materially larger than P2A's remit, and one that
 * should be made deliberately with the file workflows in scope rather than
 * bundled into a schema phase.
 *
 * This test LOCKS that decision in two directions: it proves the leak is real
 * (so the finding cannot be quietly forgotten), and it proves Phase 2 does not
 * rely on the leaking path (no Phase 2 owner type is attachable today).
 */

function code(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

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

describe("Phase 2A — attachment cross-entity boundary (assessment)", () => {
  let setup: Awaited<ReturnType<typeof setupTestTenant>> | undefined;

  afterEach(async () => {
    if (setup) {
      await cleanupTenant(setup.tenantId).catch(() => undefined);
      await cleanupUser(setup.adminUserId).catch(() => undefined);
      setup = undefined;
    }
  });

  it("DEMONSTRATES the leak: attachment metadata for an entity-B-owned record is readable from an entity-A session", async () => {
    const db = createSystemClient();
    const s = await setupTestTenant();
    setup = s;
    const leA = await createTestLegalEntity(s.tenantId, "SG");
    const leB = await createTestLegalEntity(s.tenantId, "MY");

    // A file correctly scoped to entity B.
    const file = await db.fileObject.create({
      data: {
        tenantId: s.tenantId,
        legalEntityId: leB.id,
        storageKey: code("key"),
        originalFilename: "b-only.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        sha256: randomBytes(32).toString("hex"),
        uploadedByUserId: s.adminUserId,
      },
    });
    // An attachment hanging off a hypothetical entity-B catalog item.
    const attachment = await db.attachment.create({
      data: {
        tenantId: s.tenantId,
        fileObjectId: file.id,
        ownerEntityType: "catalog_item",
        ownerEntityId: code("itemB"),
        createdByUserId: s.adminUserId,
      },
    });

    const fromA = await asApp(s.tenantId, [leA.id], async (c) => ({
      // file_object is dual-axis scoped — correctly invisible.
      file: (await c.query("SELECT id FROM file_object WHERE id = $1", [file.id]))
        .rowCount,
      // attachment is tenant-only scoped — THIS is the leak.
      attachment: (
        await c.query("SELECT id FROM attachment WHERE id = $1", [attachment.id])
      ).rowCount,
    }));

    expect(fromA.file, "file content reference is correctly entity-scoped").toBe(0);
    expect(
      fromA.attachment,
      "KNOWN GAP (Phase 2A finding): attachment metadata is tenant-only scoped. " +
        "This is why catalog attachments are prohibited until `attachment` is hardened.",
    ).toBe(1);
  });

  it("Phase 2 does not depend on the leaking path: CatalogItem has no attachment or image field", async () => {
    const db = createSystemClient();
    const cols = await db.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='catalog_item'`,
    );
    const names = cols.map((c) => c.column_name);
    for (const forbidden of [
      "image_file_id",
      "image_url",
      "attachment_id",
      "primary_image_id",
      "file_object_id",
    ]) {
      expect(names, `catalog_item must not reference files in Phase 2`).not.toContain(
        forbidden,
      );
    }
  });

  it("no Phase 2 source code creates an attachment for a Phase 2 owner type", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const roots = [
      join(__dirname, "..", "..", "app"),
      join(__dirname, "..", "..", "lib"),
      join(__dirname, "..", "..", "components"),
    ];
    const phase2Owners = [
      "party",
      "party_contact",
      "party_address",
      "catalog_item",
      "price_list",
    ];
    const offenders: string[] = [];
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(dir)) {
        if (e === "node_modules" || e === ".next") continue;
        const full = join(dir, e);
        if (statSync(full).isDirectory()) out.push(...walk(full));
        else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(full);
      }
      return out;
    };
    for (const root of roots) {
      for (const f of walk(root)) {
        const content = readFileSync(f, "utf8");
        if (!/ownerEntityType/.test(content)) continue;
        for (const owner of phase2Owners) {
          if (new RegExp(`ownerEntityType\\s*:\\s*["'\`]${owner}["'\`]`).test(content)) {
            offenders.push(`${f}: ${owner}`);
          }
        }
      }
    }
    expect(
      offenders,
      "Catalog/party attachments are prohibited in Phase 2 — see this file's header",
    ).toEqual([]);
  });
});
