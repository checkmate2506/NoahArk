import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  LIST_QUERY_INTEGER,
  LIST_QUERY_STRING,
  parseListQuery,
} from "@/lib/api/listQuery";
import { parseJsonBody, parseWithSchema } from "@/lib/api/schemas/partySchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  ListCustomFieldValuesSchema,
  listCustomFieldValues,
  setCustomFieldValue,
  toPublicCustomFieldValue,
} from "@/lib/services/customFieldDomain";

type Params = { tenantId: string };

const LIST_SPEC = {
  cursor: LIST_QUERY_STRING,
  limit: LIST_QUERY_INTEGER,
  definitionId: LIST_QUERY_STRING,
  entityType: LIST_QUERY_STRING,
  entityId: LIST_QUERY_STRING,
} as const;

function listQuery(req: Request) {
  return parseWithSchema(
    ListCustomFieldValuesSchema,
    parseListQuery(new URL(req.url).searchParams, LIST_SPEC),
  );
}

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.CUSTOM_FIELD_VALUE_READ,
  handler: async (req, _requestId, _params, ctx) => {
    const result = await listCustomFieldValues(ctx, listQuery(req));
    return jsonOk({
      values: result.values.map(toPublicCustomFieldValue),
      nextCursor: result.nextCursor,
    });
  },
});

export const PUT = tenantWriteRoute<Params>({
  permission: PERMISSIONS.CUSTOM_FIELD_VALUE_WRITE,
  handler: async (req, _requestId, _params, ctx) => {
    const value = await setCustomFieldValue(ctx, await parseJsonBody(req));
    return jsonOk({ value: toPublicCustomFieldValue(value) });
  },
});
