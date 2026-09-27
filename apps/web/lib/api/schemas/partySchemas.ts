import { z } from "zod";
import { ValidationError } from "@noahark/core";
import { timestampToIso } from "@/lib/api/dto";

export const ExpectedVersionBodySchema = z
  .object({
    expectedVersion: z.number().int().min(1),
  })
  .strict();

/** Matches `listDuplicateCandidates` input exactly. Extra keys fail closed. */
export const DuplicateCandidateRequestSchema = z
  .object({
    normalisedName: z.string().optional(),
    legalName: z.string().optional(),
    givenName: z.string().optional(),
    familyName: z.string().optional(),
    partyType: z.enum(["ORGANISATION", "INDIVIDUAL"]).optional(),
    taxIdentifier: z.string().nullable().optional(),
    contactEmail: z.string().nullable().optional(),
    excludePartyId: z.string().optional(),
  })
  .strict();

export async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new ValidationError("Malformed JSON");
  }
}

export function parseWithSchema<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError("Invalid request", { issues: parsed.error.issues });
  }
  return parsed.data;
}

export function withPathPartyId(pathPartyId: string, body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Invalid request body");
  }
  const rec = body as Record<string, unknown>;
  if ("partyId" in rec && rec.partyId !== pathPartyId) {
    throw new ValidationError("partyId in the body must match the path");
  }
  return { ...rec, partyId: pathPartyId };
}

function optionalTimestamp(value: Date | null | undefined): string | null {
  if (value == null) return null;
  return timestampToIso(value);
}

export function toPublicParty(party: {
  id: string;
  ownerLegalEntityId: string;
  code: string;
  partyType: "ORGANISATION" | "INDIVIDUAL";
  legalName: string | null;
  tradingName: string | null;
  givenName: string | null;
  familyName: string | null;
  taxIdentifier: string | null;
  status: string;
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: party.id,
    ownerLegalEntityId: party.ownerLegalEntityId,
    code: party.code,
    partyType: party.partyType,
    legalName: party.legalName,
    tradingName: party.tradingName,
    givenName: party.givenName,
    familyName: party.familyName,
    taxIdentifier: party.taxIdentifier,
    status: party.status,
    archivedAt: optionalTimestamp(party.archivedAt),
    version: party.version,
    createdAt: timestampToIso(party.createdAt),
    updatedAt: timestampToIso(party.updatedAt),
  };
}

export function toPublicAssignment(assignment: {
  id: string;
  partyId: string;
  legalEntityId: string;
  status: string;
  assignedAt: Date;
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: assignment.id,
    partyId: assignment.partyId,
    legalEntityId: assignment.legalEntityId,
    status: assignment.status,
    assignedAt: timestampToIso(assignment.assignedAt),
    archivedAt: optionalTimestamp(assignment.archivedAt),
    version: assignment.version,
    createdAt: timestampToIso(assignment.createdAt),
    updatedAt: timestampToIso(assignment.updatedAt),
  };
}

export function toPublicRole(
  role: {
    id: string;
    assignmentId: string;
    legalEntityId: string;
    code: string;
    defaultCurrency: string | null;
    status: string;
    archivedAt: Date | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  } | null,
) {
  if (!role) return null;
  return {
    id: role.id,
    assignmentId: role.assignmentId,
    legalEntityId: role.legalEntityId,
    code: role.code,
    defaultCurrency: role.defaultCurrency,
    status: role.status,
    archivedAt: optionalTimestamp(role.archivedAt),
    version: role.version,
    createdAt: timestampToIso(role.createdAt),
    updatedAt: timestampToIso(role.updatedAt),
  };
}

export function toPublicContact(contact: {
  id: string;
  partyId: string;
  givenName: string;
  familyName: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  status: string;
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: contact.id,
    partyId: contact.partyId,
    givenName: contact.givenName,
    familyName: contact.familyName,
    jobTitle: contact.jobTitle,
    email: contact.email,
    phone: contact.phone,
    isPrimary: contact.isPrimary,
    status: contact.status,
    archivedAt: optionalTimestamp(contact.archivedAt),
    version: contact.version,
    createdAt: timestampToIso(contact.createdAt),
    updatedAt: timestampToIso(contact.updatedAt),
  };
}

export function toPublicAddress(address: {
  id: string;
  partyId: string;
  addressType: string;
  line1: string;
  line2: string | null;
  line3: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
  status: string;
  archivedAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: address.id,
    partyId: address.partyId,
    addressType: address.addressType,
    line1: address.line1,
    line2: address.line2,
    line3: address.line3,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
    status: address.status,
    archivedAt: optionalTimestamp(address.archivedAt),
    version: address.version,
    createdAt: timestampToIso(address.createdAt),
    updatedAt: timestampToIso(address.updatedAt),
  };
}

export function toDuplicateCandidate(candidate: {
  partyId: string;
  partyType: "ORGANISATION" | "INDIVIDUAL";
  matchReasons: Array<"name" | "email" | "tax_identifier">;
}) {
  return {
    partyId: candidate.partyId,
    partyType: candidate.partyType,
    matchReasons: [...candidate.matchReasons],
  };
}
