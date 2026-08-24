import { z } from "zod";
import { NotFoundError, ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { isTestEmailCaptureActive, readCapturedEmails } from "@/lib/testEmailCapture";

/**
 * E2E test-safe notification capture (F-14/E2E, Phase 1B.1). Deliberately
 * OUTSIDE the documented public API contract (openapi.yaml) — see
 * tests/integration/openApiConformance.test.ts, which explicitly excludes
 * `app/api/v1/test/**` from route-inventory coverage rather than
 * pretending a test-only debug endpoint is part of the real product
 * surface. See lib/testEmailCapture.ts for the double activation gate
 * (and N-6, Phase 1D, for a correction to a previously-inaccurate claim
 * about this route's 404 shape) — this route is 404 (not merely empty)
 * whenever that gate is inactive, including in every real deployment,
 * since NODE_ENV=production alone disables it regardless of any other
 * configuration.
 *
 * P1E-3 (Phase 1F): the gate is now checked BEFORE query validation, not
 * after — previously a malformed query returned 422 even with the gate
 * closed, which let a caller distinguish "closed but exists" (422) from
 * "closed, query happened to be well-formed" (404), a route-existence
 * oracle N-6's own test coverage never actually exercised. With the gate
 * checked first, every request gets the identical 404 whenever it's
 * closed — malformed and well-formed alike — and neither
 * `QuerySchema.safeParse` nor `readCapturedEmails` (hence no database
 * query) ever runs at all in that case.
 */
const QuerySchema = z.object({ to: z.email() });

export const GET = apiHandler(async (req) => {
  if (!isTestEmailCaptureActive()) throw new NotFoundError("Route");

  const url = new URL(req.url);
  const parsed = QuerySchema.safeParse({ to: url.searchParams.get("to") });
  if (!parsed.success) throw new ValidationError("Invalid query");

  const captures = await readCapturedEmails(parsed.data.to);
  return jsonOk({ captures: captures ?? [] });
});
