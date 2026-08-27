import type { PartyStatus, TransactionClient } from "@noahark/db";

export interface LockedPartyRow {
  id: string;
  status: PartyStatus;
  ownerLegalEntityId: string;
}

/** Serializes mutations that must observe the party's assignment set
 * (last-assignment revoke, transfer, primary-contact change). RLS still
 * applies: an invisible party yields no row. Callers that need mutation
 * authority must SELECT (visibility) and owner-check BEFORE this
 * FOR UPDATE — assigned non-owners can read but UPDATE RLS hides the
 * lock row. Archive status on the returned row is authoritative. */
export async function lockPartyRow(
  tx: TransactionClient,
  tenantId: string,
  partyId: string,
): Promise<LockedPartyRow | null> {
  const rows = await tx.$queryRaw<LockedPartyRow[]>`
    SELECT id, status, owner_legal_entity_id AS "ownerLegalEntityId"
    FROM party
    WHERE id = ${partyId} AND tenant_id = ${tenantId}
    FOR UPDATE`;
  return rows[0] ?? null;
}

export async function lockPartyAssignments(
  tx: TransactionClient,
  tenantId: string,
  partyId: string,
): Promise<void> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`party-assignments:${tenantId}:${partyId}`}))`;
}
