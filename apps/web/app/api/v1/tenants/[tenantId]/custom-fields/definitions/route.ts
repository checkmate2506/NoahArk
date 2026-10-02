import { PERMISSIONS } from "@noahark/authz";
import { jsonOk } from "@/lib/apiHandler";
import {
  LIST_QUERY_BOOLEAN,
  LIST_QUERY_INTEGER,
  LIST_QUERY_STRING,
  parseListQuery,
} from "@/lib/api/listQuery";
import { parseJsonBody, parseWithSchema } from "@/lib/api/schemas/partySchemas";
import { tenantReadRoute, tenantWriteRoute } from "@/lib/api/tenantRoute";
import {
  ListCustomFieldDefinitionsSchema,
  createCustomFieldDefinition,
  listCustomFieldDefinitions,
  toPublicCustomFieldDefinition,
} from "@/lib/services/customFieldDomain";

type Params = { tenantId: string };

const LIST_SPEC = {
  cursor: LIST_QUERY_STRING,
  limit: LIST_QUERY_INTEGER,
  entityType: LIST_QUERY_STRING,
  isActive: LIST_QUERY_BOOLEAN,
} as const;

function listQuery(req: Request) {
  return parseWithSchema(
    ListCustomFieldDefinitionsSchema,
    parseListQuery(new URL(req.url).searchParams, LIST_SPEC),
  );
}

export const GET = tenantReadRoute<Params>({
  permission: PERMISSIONS.CUSTOM_FIELD_DEFINITION_READ,
  handler: async (req, _requestId, _params, ctx) => {
    const result = await listCustomFieldDefinitions(ctx, listQuery(req));
    return jsonOk({
      definitions: result.definitions.map(toPublicCustomFieldDefinition),
      nextCursor: result.nextCursor,
    });
  },
});

export const POST = tenantWriteRoute<Params>({
  permission: PERMISSIONS.CUSTOM_FIELD_DEFINITION_CREATE,
  handler: async (req, _requestId, _params, ctx) => {
    const definition = await createCustomFieldDefinition(ctx, await parseJsonBody(req));
    return jsonOk(
      { definition: toPublicCustomFieldDefinition(definition) },
      { status: 201 },
    );
  },
});
