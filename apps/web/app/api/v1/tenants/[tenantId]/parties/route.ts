import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  LIST_QUERY_BOOLEAN,
  LIST_QUERY_INTEGER,
  LIST_QUERY_STRING,
  parseListQuery,
} from "@/lib/api/listQuery";
import {
  parseJsonBody,
  parseWithSchema,
  toDuplicateCandidate,
  toPublicAssignment,
  toPublicParty,
  toPublicRole,
} from "@/lib/api/schemas/partySchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  CreatePartySchema,
  ListPartiesSchema,
  createParty,
  listParties,
} from "@/lib/services/partyDomain";

type Params = { tenantId: string };

const LIST_SPEC = {
  cursor: LIST_QUERY_STRING,
  limit: LIST_QUERY_INTEGER,
  partyType: LIST_QUERY_STRING,
  status: LIST_QUERY_STRING,
  includeArchived: LIST_QUERY_BOOLEAN,
  q: LIST_QUERY_STRING,
} as const;

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.PARTY_READ,
  handler: async (req, _requestId, _params, ctx) => {
    const query = parseWithSchema(
      ListPartiesSchema,
      parseListQuery(new URL(req.url).searchParams, LIST_SPEC),
    );
    const result = await listParties(ctx, query);
    return jsonOk({
      parties: result.parties.map(toPublicParty),
      nextCursor: result.nextCursor,
    });
  },
});

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PARTY_CREATE,
  legalEntityIdFrom: async (req) => {
    const body = await parseJsonBody(req);
    return parseWithSchema(CreatePartySchema, body).ownerLegalEntityId;
  },
  handler: async (req, _requestId, _params, ctx) => {
    const body = await parseJsonBody(req);
    const created = await createParty(ctx, body);
    return jsonOk(
      {
        party: toPublicParty(created.party),
        assignment: toPublicAssignment(created.assignment),
        customerRole: toPublicRole(created.customerRole),
        vendorRole: toPublicRole(created.vendorRole),
        duplicateCandidates: created.duplicateCandidates.map(toDuplicateCandidate),
      },
      { status: 201 },
    );
  },
});
