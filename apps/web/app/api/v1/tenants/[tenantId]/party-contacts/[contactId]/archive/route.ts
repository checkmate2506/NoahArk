import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  ExpectedVersionBodySchema,
  parseJsonBody,
  parseWithSchema,
  toPublicContact,
} from "@/lib/api/schemas/partySchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import { archiveContact } from "@/lib/services/partyDomain";

type Params = { tenantId: string; contactId: string };

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.PARTY_CONTACT_ARCHIVE,
  handler: async (req, _requestId, params, ctx) => {
    const body = parseWithSchema(ExpectedVersionBodySchema, await parseJsonBody(req));
    const contact = await archiveContact(ctx, params.contactId, body.expectedVersion);
    return jsonOk({ contact: toPublicContact(contact) });
  },
});
