import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIT_ACTIONS } from "@noahark/audit";

const { writeAuditEventInTx, withTenantContext, withPlatformAuditContext } = vi.hoisted(
  () => ({
    writeAuditEventInTx: vi.fn(),
    withTenantContext: vi.fn(),
    withPlatformAuditContext: vi.fn(),
  }),
);

vi.mock("@noahark/db", () => ({
  writeAuditEventInTx,
  withTenantContext,
  withPlatformAuditContext,
}));

import { recordJobContextFailure } from "./context";

const FAKE_TX = { kind: "existing-tx" };
const RETURNED = { id: "evt_jobs", hash: "h1", sequence: 1n };

afterEach(() => {
  vi.clearAllMocks();
});

function stubContexts() {
  withTenantContext.mockImplementation(
    async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn(FAKE_TX),
  );
  withPlatformAuditContext.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn(FAKE_TX),
  );
  writeAuditEventInTx.mockResolvedValue(RETURNED);
}

describe("Jobs audit-writer compatibility delegate (ADR-76)", () => {
  it("contains no local audit_event persistence body", () => {
    const src = readFileSync(
      join(fileURLToPath(new URL(".", import.meta.url)), "context.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/auditEvent\.create/);
    expect(src).not.toMatch(/pg_advisory_xact_lock/);
    expect(src).not.toMatch(/buildAuditEventRow/);
    expect(src).not.toMatch(/Prisma\.JsonNull/);
    expect(src).toMatch(/return writeAuditEventInTx\(tx, input\)/);
  });

  it("forwards the caller's tenant TransactionClient and input unchanged", async () => {
    stubContexts();
    await recordJobContextFailure({
      jobId: "job_1",
      jobKind: "job",
      jobType: "test.context",
      ownership: { tenantId: "tenant_1", legalEntityId: "le_1" },
      reason: "cross-tenant legal entity",
    });

    expect(withPlatformAuditContext).not.toHaveBeenCalled();
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    expect(withTenantContext.mock.calls[0]?.[0]).toEqual({
      tenantId: "tenant_1",
      legalEntityIds: new Set(),
    });
    expect(writeAuditEventInTx).toHaveBeenCalledTimes(1);
    expect(writeAuditEventInTx).toHaveBeenCalledWith(FAKE_TX, {
      tenantId: "tenant_1",
      legalEntityId: "le_1",
      actorUserId: null,
      actorType: "SYSTEM",
      action: AUDIT_ACTIONS.JOB_CONTEXT_REJECTED,
      entityType: "job",
      entityId: "job_1",
      afterData: { jobType: "test.context", reason: "cross-tenant legal entity" },
      outcome: "DENIED",
    });
  });

  it("forwards the caller's platform TransactionClient when tenantId is null", async () => {
    stubContexts();
    await recordJobContextFailure({
      jobId: "job_2",
      jobKind: "outbox_event",
      jobType: "test.outbox",
      ownership: { tenantId: null, legalEntityId: null },
      reason: "missing tenant",
    });

    expect(withTenantContext).not.toHaveBeenCalled();
    expect(withPlatformAuditContext).toHaveBeenCalledTimes(1);
    expect(writeAuditEventInTx).toHaveBeenCalledWith(FAKE_TX, {
      tenantId: null,
      legalEntityId: null,
      actorUserId: null,
      actorType: "SYSTEM",
      action: AUDIT_ACTIONS.JOB_CONTEXT_REJECTED,
      entityType: "outbox_event",
      entityId: "job_2",
      afterData: { jobType: "test.outbox", reason: "missing tenant" },
      outcome: "DENIED",
    });
  });

  it("does not open its own transaction — the context callback supplies tx", async () => {
    stubContexts();
    await recordJobContextFailure({
      jobId: "job_3",
      jobKind: "job",
      jobType: "t",
      ownership: { tenantId: "tenant_1", legalEntityId: null },
      reason: "x",
    });
    const suppliedTx = writeAuditEventInTx.mock.calls[0]?.[0];
    expect(suppliedTx).toBe(FAKE_TX);
  });

  it("swallows writer failures so job handling still proceeds", async () => {
    stubContexts();
    const failure = new Error("insert failed");
    writeAuditEventInTx.mockRejectedValue(failure);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      recordJobContextFailure({
        jobId: "job_4",
        jobKind: "job",
        jobType: "t",
        ownership: { tenantId: "tenant_1", legalEntityId: null },
        reason: "x",
      }),
    ).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
