import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { parseJsonBody } from "@/lib/api/schemas/partySchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  getCustomFieldDefinition,
  toPublicCustomFieldDefinition,
  updateCustomFieldDefinition,
} from "@/lib/services/customFieldDomain";

type Params = { tenantId: string; definitionId: string };

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.CUSTOM_FIELD_DEFINITION_READ,
  handler: async (_req, _requestId, params, ctx) => {
    const definition = await getCustomFieldDefinition(ctx, params.definitionId);
    return jsonOk({ definition: toPublicCustomFieldDefinition(definition) });
  },
});

export const PATCH = tenantWriteRoute<Params>({
  permission: PERMISSIONS.CUSTOM_FIELD_DEFINITION_UPDATE,
  handler: async (req, _requestId, params, ctx) => {
    const definition = await updateCustomFieldDefinition(
      ctx,
      params.definitionId,
      await parseJsonBody(req),
    );
    return jsonOk({ definition: toPublicCustomFieldDefinition(definition) });
  },
});
