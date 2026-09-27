import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody, toPublicContact } from "@/lib/api/schemas/partySchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import { getContact, updateContact } from "@/lib/services/partyDomain";

type Params = { tenantId: string; contactId: string };

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.PARTY_CONTACT_READ,
  handler: async (_req, _requestId, params, ctx) => {
    const contact = await getContact(ctx, params.contactId);
    return jsonOk({ contact: toPublicContact(contact) });
  },
});

export const PATCH = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PARTY_CONTACT_UPDATE,
  handler: async (req, _requestId, params, ctx) => {
    const body = await parseJsonBody(req);
    const contact = await updateContact(ctx, params.contactId, body);
    return jsonOk({ contact: toPublicContact(contact) });
  },
});
