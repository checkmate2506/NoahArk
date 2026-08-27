import type { AccessContext } from "@noahark/core";
import type { TransactionClient } from "@noahark/db";
import { normaliseEmail, normaliseText } from "./normalize";

export type DuplicateMatchReason = "name" | "email" | "tax_identifier";

export interface DuplicateCandidate {
  partyId: string;
  partyType: "ORGANISATION" | "INDIVIDUAL";
  matchReasons: DuplicateMatchReason[];
}

export const MAX_DUPLICATE_CANDIDATES = 10;

/** Locale-pinned, code-point-stable ordering. CUID ids are ASCII; a secondary
 * partyType then matchReasons key keeps equal-id fixtures deterministic. */
export function compareDuplicateCandidates(
  a: DuplicateCandidate,
  b: DuplicateCandidate,
): number {
  const byId = a.partyId.localeCompare(b.partyId, "en-US");
  if (byId !== 0) return byId;
  const byType = a.partyType.localeCompare(b.partyType, "en-US");
  if (byType !== 0) return byType;
  return a.matchReasons.join(",").localeCompare(b.matchReasons.join(","), "en-US");
}

/** Sort the full candidate set, then apply the bound. Eligibility is unchanged. */
export function boundDuplicateCandidates(
  candidates: DuplicateCandidate[],
): DuplicateCandidate[] {
  return [...candidates]
    .sort(compareDuplicateCandidates)
    .slice(0, MAX_DUPLICATE_CANDIDATES);
}

/** Advisory only. Never auto-merges. RLS hides parties the caller cannot
 * see. Results omit emails, phones, assignments, roles and entity codes. */
export async function findDuplicateCandidates(
  tx: TransactionClient,
  ctx: AccessContext,
  input: {
    normalisedName: string;
    taxIdentifier?: string | null | undefined;
    contactEmail?: string | null | undefined;
    excludePartyId?: string | undefined;
  },
): Promise<DuplicateCandidate[]> {
  const name = normaliseText(input.normalisedName);
  const tax = input.taxIdentifier?.trim() ? input.taxIdentifier.trim() : null;
  const email = input.contactEmail?.trim() ? normaliseEmail(input.contactEmail) : null;

  const orFilters: Array<Record<string, unknown>> = [];
  if (name) orFilters.push({ normalisedName: name });
  if (tax) orFilters.push({ taxIdentifier: tax });

  const byNameOrTax =
    orFilters.length === 0
      ? []
      : await tx.party.findMany({
          where: {
            tenantId: ctx.tenantId,
            status: "ACTIVE",
            ...(input.excludePartyId ? { id: { not: input.excludePartyId } } : {}),
            OR: orFilters,
          },
          select: {
            id: true,
            partyType: true,
            normalisedName: true,
            taxIdentifier: true,
          },
          take: MAX_DUPLICATE_CANDIDATES,
          orderBy: { id: "asc" },
        });

  const byEmail =
    email === null
      ? []
      : await tx.partyContact.findMany({
          where: {
            tenantId: ctx.tenantId,
            status: "ACTIVE",
            normalisedEmail: email,
            party: {
              status: "ACTIVE",
              ...(input.excludePartyId ? { id: { not: input.excludePartyId } } : {}),
            },
          },
          select: { partyId: true, party: { select: { partyType: true } } },
          take: MAX_DUPLICATE_CANDIDATES,
          orderBy: { partyId: "asc" },
        });

  const reasons = new Map<string, DuplicateCandidate>();
  for (const row of byNameOrTax) {
    const matchReasons: DuplicateMatchReason[] = [];
    if (row.normalisedName === name) matchReasons.push("name");
    if (tax && row.taxIdentifier === tax) matchReasons.push("tax_identifier");
    reasons.set(row.id, {
      partyId: row.id,
      partyType: row.partyType,
      matchReasons,
    });
  }
  for (const row of byEmail) {
    const existing = reasons.get(row.partyId);
    if (existing) {
      if (!existing.matchReasons.includes("email")) existing.matchReasons.push("email");
    } else {
      reasons.set(row.partyId, {
        partyId: row.partyId,
        partyType: row.party.partyType,
        matchReasons: ["email"],
      });
    }
  }

  return boundDuplicateCandidates(Array.from(reasons.values()));
}
