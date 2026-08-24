import { createHash } from "node:crypto";

/** Deterministic JSON stringify (keys sorted at every level) so the same
 * logical payload always hashes to the same value regardless of key
 * insertion order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** The literal chainKey used for pre-tenant-selection events (sign-in,
 * sign-out, failed login) — distinct from any real tenant id (cuid()s never
 * produce this string). */
export const PLATFORM_CHAIN_KEY = "__platform__";

/** Derives the chain identity for a given tenant id (or the platform chain
 * for `null`). Centralised so every caller (write path, verification
 * tooling, tests) agrees on the mapping. */
export function chainKeyForTenant(tenantId: string | null): string {
  return tenantId ?? PLATFORM_CHAIN_KEY;
}

export interface HashableAuditPayload {
  /** null = a platform-level event (e.g. sign-in, before any tenant is
   * selected) — chained separately from any tenant's chain. */
  tenantId: string | null;
  legalEntityId: string | null;
  actorUserId: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string | null;
  beforeData: unknown;
  afterData: unknown;
  outcome: string;
  createdAt: string; // ISO — pinned at write time so the hash is stable
  // F-2/F-6: the chain's explicit identity and this event's monotonic
  // position within it are hashed IN, not just stored alongside the hash —
  // an attacker who edited sequence/chainKey directly in storage (bypassing
  // the append-only trigger via some future bug, or restoring from a
  // tampered backup) would still be caught by hash recomputation, not just
  // by a separate uniqueness check.
  chainKey: string;
  sequence: string; // BigInt serialized as a decimal string for stable JSON
}

/**
 * `hash = SHA-256(prevHash + canonicalJSON(payload))`. Chains are identified
 * by `payload.chainKey` (a tenant id, or PLATFORM_CHAIN_KEY for events
 * before any tenant is selected). Each chain's first event (`sequence = 1`)
 * links from `null`. Verifying a chain means recomputing this exact
 * function over its rows *ordered by `sequence`* (never `createdAt` — see
 * the module doc in auditWriter.ts for why) and confirming each row's
 * `prevHash` matches the previous row's `hash`, each row's `hash` matches
 * its own recomputed value, and `sequence` is gapless from 1.
 */
export function computeAuditHash(
  prevHash: string | null,
  payload: HashableAuditPayload,
): string {
  const hash = createHash("sha256");
  hash.update(prevHash ?? "");
  hash.update(canonicalJson(payload));
  return hash.digest("hex");
}

export interface AuditChainLink {
  prevHash: string | null;
  hash: string;
  sequence: bigint;
  payload: HashableAuditPayload;
}

export interface ChainVerificationResult {
  valid: boolean;
  /** Index into the input array (not the sequence number) of the first
   * invalid link, or -1 if the chain is fully valid. */
  firstInvalidIndex: number;
  reason?: "empty" | "sequence_gap" | "prev_hash_mismatch" | "hash_mismatch";
}

/** Verifies one chain (identified by a single chainKey) is intact,
 * gapless, and unmodified. Events MUST be supplied ordered by `sequence`
 * ascending — the caller (the DB query or a test fixture) is responsible
 * for that ordering; this function does not re-sort, so a caller that
 * accidentally orders by `createdAt` again would be caught by the gap/prev
 * hash checks rather than silently passing. */
export function verifyAuditChain(
  events: readonly AuditChainLink[],
): ChainVerificationResult {
  let expectedPrevHash: string | null = null;
  let expectedSequence = 1n;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event) return { valid: false, firstInvalidIndex: i, reason: "empty" };
    if (event.sequence !== expectedSequence) {
      return { valid: false, firstInvalidIndex: i, reason: "sequence_gap" };
    }
    if (event.prevHash !== expectedPrevHash) {
      return { valid: false, firstInvalidIndex: i, reason: "prev_hash_mismatch" };
    }
    const recomputed = computeAuditHash(event.prevHash, event.payload);
    if (recomputed !== event.hash) {
      return { valid: false, firstInvalidIndex: i, reason: "hash_mismatch" };
    }
    expectedPrevHash = event.hash;
    expectedSequence += 1n;
  }
  return { valid: true, firstInvalidIndex: -1 };
}
