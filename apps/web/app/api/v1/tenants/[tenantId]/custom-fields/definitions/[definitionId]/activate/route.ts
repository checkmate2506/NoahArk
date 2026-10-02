import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  ExpectedVersionBodySchema,
  parseJsonBody,
  parseWithSchema,
} from "@/lib/api/schemas/partySchemas";
import { tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  activateCustomFieldDefinition,
  toPublicCustomFieldDefinition,
} from "@/lib/services/customFieldDomain";

type Params = { tenantId: string; definitionId: string };

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.CUSTOM_FIELD_DEFINITION_SET_STATUS,
  handler: async (req, _requestId, params, ctx) => {
    const body = parseWithSchema(ExpectedVersionBodySchema, await parseJsonBody(req));
    const definition = await activateCustomFieldDefinition(
      ctx,
      params.definitionId,
      body,
    );
    return jsonOk({ definition: toPublicCustomFieldDefinition(definition) });
  },
});
