import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  LIST_QUERY_INTEGER,
  LIST_QUERY_STRING,
  parseListQuery,
} from "@/lib/api/listQuery";
import {
  parseJsonBody,
  parseWithSchema,
  toPublicContact,
  withPathPartyId,
} from "@/lib/api/schemas/partySchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  ListContactsSchema,
  createContact,
  listContacts,
} from "@/lib/services/partyDomain";

type Params = { tenantId: string; partyId: string };

const LIST_SPEC = {
  cursor: LIST_QUERY_STRING,
  limit: LIST_QUERY_INTEGER,
} as const;

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.PARTY_CONTACT_READ,
  handler: async (req, _requestId, params, ctx) => {
    const query = parseWithSchema(
      ListContactsSchema,
      parseListQuery(new URL(req.url).searchParams, LIST_SPEC),
    );
    const result = await listContacts(ctx, params.partyId, query);
    return jsonOk({
      contacts: result.items.map(toPublicContact),
      nextCursor: result.nextCursor,
    });
  },
});

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PARTY_CONTACT_CREATE,
  handler: async (req, _requestId, params, ctx) => {
    const body = withPathPartyId(params.partyId, await parseJsonBody(req));
    const contact = await createContact(ctx, body);
    return jsonOk({ contact: toPublicContact(contact) }, { status: 201 });
  },
});
