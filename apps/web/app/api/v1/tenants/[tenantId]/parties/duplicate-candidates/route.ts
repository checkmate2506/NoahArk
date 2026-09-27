import { PERMISSIONS } from "@noahark/authz";
import { omitUndefined } from "@noahark/core";
import { jsonOk } from "@/lib/apiHandler";
import {
  DuplicateCandidateRequestSchema,
  parseJsonBody,
  parseWithSchema,
  toDuplicateCandidate,
} from "@/lib/api/schemas/partySchemas";
import { tenantReadPostRoute } from "@/lib/api/tenantRoute";
import { listDuplicateCandidates } from "@/lib/services/partyDomain";

type Params = { tenantId: string };

export const POST = tenantReadPostRoute<Params>({
  permission: PERMISSIONS.PARTY_READ,
  handler: async (req, _requestId, _params, ctx) => {
    const body = parseWithSchema(
      DuplicateCandidateRequestSchema,
      await parseJsonBody(req),
    );
    const candidates = await listDuplicateCandidates(ctx, omitUndefined(body));
    return jsonOk({
      candidates: candidates.map(toDuplicateCandidate),
    });
  },
});
