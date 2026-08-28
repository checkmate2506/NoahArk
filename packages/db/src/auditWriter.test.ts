import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildAuditEventRow,
  chainKeyForTenant,
  type AuditEventInput,
} from "@noahark/audit";
import { Prisma } from "./client";
import { writeAuditEventInTx } from "./auditWriter";

/**
 * Captured persistence mapping from the pre-extraction web and CRM writers
 * (byte-equivalent algorithms). Used as the deterministic differential
 * oracle — not a second database execution.
 */
function capturedLegacyCreatePayload(
  input: AuditEventInput,
  latest: { hash: string; sequence: bigint } | null,
) {
  const chainKey = chainKeyForTenant(input.tenantId ?? null);
  const nextSequence = (latest?.sequence ?? 0n) + 1n;
  const prevHash = latest?.hash ?? null;
  const row = buildAuditEventRow(input, prevHash, nextSequence);
  return {
    chainKey,
    findFirst: {
      where: { chainKey },
      orderBy: { sequence: "desc" as const },
      select: { hash: true, sequence: true },
    },
    nextSequence,
    prevHash,
    data: {
      tenantId: row.tenantId,
      legalEntityId: row.legalEntityId,
      actorUserId: row.actorUserId,
      actorType: row.actorType,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      beforeData:
        row.beforeData === null
          ? Prisma.JsonNull
          : (row.beforeData as Prisma.InputJsonValue),
      afterData:
        row.afterData === null
          ? Prisma.JsonNull
          : (row.afterData as Prisma.InputJsonValue),
      requestId: row.requestId,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      outcome: row.outcome,
      chainKey: row.chainKey,
      sequence: row.sequence,
      prevHash: row.prevHash,
      hash: row.hash,
      createdAt: row.createdAt,
    },
  };
}

function recordingTx(
  latest: { hash: string; sequence: bigint } | null,
  createImpl?: (data: unknown) => unknown,
) {
  const calls: {
    lockValues: unknown[];
    lockSql: string;
    findFirstArgs: unknown;
    createData: unknown;
  } = {
    lockValues: [],
    lockSql: "",
    findFirstArgs: undefined,
    createData: undefined,
  };
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.lockSql = strings.join("");
      calls.lockValues = values;
      return 1;
    },
    auditEvent: {
      findFirst: async (args: unknown) => {
        calls.findFirstArgs = args;
        return latest;
      },
      create: async ({ data }: { data: unknown }) => {
        calls.createData = data;
        if (createImpl) return createImpl(data);
        return { id: "evt_recorded", ...(data as object) };
      },
    },
  };
  return { tx, calls };
}

const FIXED = new Date("2026-08-27T07:30:43.000Z");
const SAMPLE_INPUT: AuditEventInput = {
  tenantId: "tenant_p2c0r",
  legalEntityId: "le_1",
  actorUserId: "user_1",
  action: "party.created",
  entityType: "party",
  entityId: "party_1",
  requestId: "req_1",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function freezeClock() {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED);
}

describe("writeAuditEventInTx", () => {
  it("matches the captured legacy persistence mapping (differential proof)", async () => {
    freezeClock();
    const latest = { hash: "prevhash0001", sequence: 4n };
    const expected = capturedLegacyCreatePayload(SAMPLE_INPUT, latest);
    const { tx, calls } = recordingTx(latest);
    const created = await writeAuditEventInTx(tx as never, SAMPLE_INPUT);
    expect(calls.lockSql).toContain("pg_advisory_xact_lock");
    expect(calls.lockSql).toContain("hashtext");
    expect(calls.lockValues).toEqual([expected.chainKey]);
    expect(calls.findFirstArgs).toEqual(expected.findFirst);
    expect(calls.createData).toEqual(expected.data);
    expect(created.hash).toBe(expected.data.hash);
    expect(created.sequence).toBe(5n);
    expect(created.prevHash).toBe("prevhash0001");
  });

  it("writes sequence 1 and null prevHash for the first event", async () => {
    freezeClock();
    const { tx, calls } = recordingTx(null);
    const created = await writeAuditEventInTx(tx as never, SAMPLE_INPUT);
    expect(created.sequence).toBe(1n);
    expect(created.prevHash).toBeNull();
    expect(
      (calls.createData as { sequence: bigint; prevHash: string | null }).sequence,
    ).toBe(1n);
    expect((calls.createData as { prevHash: string | null }).prevHash).toBeNull();
  });

  it("selects the predecessor by sequence DESC and uses that hash", async () => {
    freezeClock();
    const latest = { hash: "abc123", sequence: 9n };
    const { tx, calls } = recordingTx(latest);
    const created = await writeAuditEventInTx(tx as never, SAMPLE_INPUT);
    expect(calls.findFirstArgs).toEqual({
      where: { chainKey: chainKeyForTenant("tenant_p2c0r") },
      orderBy: { sequence: "desc" },
      select: { hash: true, sequence: true },
    });
    expect(created.sequence).toBe(10n);
    expect(created.prevHash).toBe("abc123");
  });

  it("locks the advisory key for the tenant chain", async () => {
    const { tx, calls } = recordingTx(null);
    await writeAuditEventInTx(tx as never, SAMPLE_INPUT);
    expect(calls.lockValues).toEqual([chainKeyForTenant("tenant_p2c0r")]);
  });

  it("produces a stable hash literal under a fixed clock", async () => {
    freezeClock();
    const expected = buildAuditEventRow(SAMPLE_INPUT, null, 1n, { now: () => FIXED });
    const { tx } = recordingTx(null);
    const created = await writeAuditEventInTx(tx as never, SAMPLE_INPUT);
    expect(created.hash).toBe(expected.hash);
    expect(created.hash).toBe(
      "a8a4475837f7b9e13febd12b4edded135ad4b675afe7c2d14bb1a6aa4b64853c",
    );
  });

  it("maps omitted before/after data to Prisma.JsonNull", async () => {
    freezeClock();
    const { tx, calls } = recordingTx(null);
    await writeAuditEventInTx(tx as never, SAMPLE_INPUT);
    const data = calls.createData as { beforeData: unknown; afterData: unknown };
    expect(data.beforeData).toBe(Prisma.JsonNull);
    expect(data.afterData).toBe(Prisma.JsonNull);
  });

  it("returns the created row from the transaction client", async () => {
    const returned = { id: "evt_return", hash: "h", sequence: 1n };
    const { tx } = recordingTx(null, () => returned);
    const created = await writeAuditEventInTx(tx as never, SAMPLE_INPUT);
    expect(created).toBe(returned);
  });

  it("does not swallow database errors", async () => {
    const failure = new Error("insert failed");
    const { tx } = recordingTx(null, () => {
      throw failure;
    });
    await expect(writeAuditEventInTx(tx as never, SAMPLE_INPUT)).rejects.toBe(failure);
  });
});
