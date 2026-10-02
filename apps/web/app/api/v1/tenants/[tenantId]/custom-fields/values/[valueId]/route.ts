import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import { tenantReadRoute } from "@/lib/api/tenantRoute";
import {
  getCustomFieldValue,
  toPublicCustomFieldValue,
} from "@/lib/services/customFieldDomain";

type Params = { tenantId: string; valueId: string };

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.CUSTOM_FIELD_VALUE_READ,
  handler: async (_req, _requestId, params, ctx) => {
    const value = await getCustomFieldValue(ctx, params.valueId);
    return jsonOk({ value: toPublicCustomFieldValue(value) });
  },
});
