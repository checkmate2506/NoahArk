import { describe, expect, it } from "vitest";
import {
  computeAuditHash,
  verifyAuditChain,
  canonicalJson,
  chainKeyForTenant,
  PLATFORM_CHAIN_KEY,
  type HashableAuditPayload,
  type AuditChainLink,
} from "./hashChain";

function payload(overrides: Partial<HashableAuditPayload> = {}): HashableAuditPayload {
  return {
    tenantId: "t1",
    legalEntityId: null,
    actorUserId: "u1",
    actorType: "USER",
    action: "tenant.updated",
    entityType: "tenant",
    entityId: "t1",
    beforeData: { name: "Old" },
    afterData: { name: "New" },
    outcome: "SUCCESS",
    createdAt: "2026-01-01T00:00:00.000Z",
    chainKey: "t1",
    sequence: "1",
    ...overrides,
  };
}

/** Builds a valid chain of `n` links in order, mirroring how auditService
 * would allocate sequence 1, 2, 3, ... under its advisory lock. */
function buildChain(n: number, chainKey = "t1"): AuditChainLink[] {
  const links: AuditChainLink[] = [];
  let prevHash: string | null = null;
  for (let i = 1; i <= n; i++) {
    const p = payload({ chainKey, sequence: String(i), action: `a${i}` });
    const hash = computeAuditHash(prevHash, p);
    links.push({ prevHash, hash, sequence: BigInt(i), payload: p });
    prevHash = hash;
  }
  return links;
}

describe("chainKeyForTenant", () => {
  it("maps a tenant id to itself", () => {
    expect(chainKeyForTenant("tenant-abc")).toBe("tenant-abc");
  });
  it("maps null to the platform chain key", () => {
    expect(chainKeyForTenant(null)).toBe(PLATFORM_CHAIN_KEY);
  });
});

describe("canonicalJson", () => {
  it("produces identical output regardless of key insertion order", () => {
    const a = canonicalJson({ b: 1, a: 2 });
    const b = canonicalJson({ a: 2, b: 1 });
    expect(a).toBe(b);
  });
});

describe("computeAuditHash", () => {
  it("is deterministic for identical inputs", () => {
    const h1 = computeAuditHash(null, payload());
    const h2 = computeAuditHash(null, payload());
    expect(h1).toBe(h2);
  });

  it("changes when the payload changes", () => {
    const h1 = computeAuditHash(null, payload());
    const h2 = computeAuditHash(null, payload({ action: "tenant.deleted" }));
    expect(h1).not.toBe(h2);
  });

  it("changes when prevHash changes, even with identical payload", () => {
    const h1 = computeAuditHash(null, payload());
    const h2 = computeAuditHash("some-other-prev-hash", payload());
    expect(h1).not.toBe(h2);
  });

  it("changes when sequence changes with an otherwise identical payload (F-6)", () => {
    const h1 = computeAuditHash(null, payload({ sequence: "1" }));
    const h2 = computeAuditHash(null, payload({ sequence: "2" }));
    expect(h1).not.toBe(h2);
  });

  it("changes when chainKey changes with an otherwise identical payload", () => {
    const h1 = computeAuditHash(null, payload({ chainKey: "tenant-a" }));
    const h2 = computeAuditHash(null, payload({ chainKey: "tenant-b" }));
    expect(h1).not.toBe(h2);
  });
});

describe("verifyAuditChain", () => {
  it("reports valid for a correctly-sequenced chain", () => {
    const result = verifyAuditChain(buildChain(2));
    expect(result).toEqual({ valid: true, firstInvalidIndex: -1 });
  });

  it("reports valid for a chain of several hundred events built in a tight loop (F-6)", () => {
    const chain = buildChain(500);
    const result = verifyAuditChain(chain);
    expect(result).toEqual({ valid: true, firstInvalidIndex: -1 });
  });

  it("detects a tampered payload (hash no longer matches)", () => {
    const [link] = buildChain(1);
    const result = verifyAuditChain([
      { ...link!, payload: { ...link!.payload, afterData: { name: "Tampered" } } },
    ]);
    expect(result).toEqual({
      valid: false,
      firstInvalidIndex: 0,
      reason: "hash_mismatch",
    });
  });

  it("detects a missing/reordered link (prevHash mismatch)", () => {
    const chain = buildChain(3);
    // event #2 is missing — #3's prevHash won't match #1's hash
    const result = verifyAuditChain([chain[0]!, chain[2]!]);
    expect(result).toEqual({
      valid: false,
      firstInvalidIndex: 1,
      reason: "sequence_gap",
    });
  });

  it("detects a sequence gap even when prevHash happens to chain correctly", () => {
    const chain = buildChain(3);
    // Same prevHash/hash pairing as a valid 2-link chain, but sequence jumps 1 -> 3.
    const tampered: AuditChainLink = { ...chain[2]!, sequence: 3n };
    const result = verifyAuditChain([chain[0]!, tampered]);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("sequence_gap");
  });

  it("accepts an empty chain", () => {
    expect(verifyAuditChain([])).toEqual({ valid: true, firstInvalidIndex: -1 });
  });

  it("keeps two chainKeys' verification independent (tenant chains do not interfere)", () => {
    const chainA = buildChain(3, "tenant-a");
    const chainB = buildChain(3, "tenant-b");
    expect(verifyAuditChain(chainA).valid).toBe(true);
    expect(verifyAuditChain(chainB).valid).toBe(true);
  });

  it("keeps the platform chain independently valid", () => {
    const platformChain = buildChain(3, PLATFORM_CHAIN_KEY);
    expect(verifyAuditChain(platformChain)).toEqual({
      valid: true,
      firstInvalidIndex: -1,
    });
  });
});
