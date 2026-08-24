import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import {
  ConfirmEmailVerificationSchema,
  confirmEmailVerification,
} from "@/lib/services/emailVerificationService";

/** Public — no session required (the token itself is the authorization
 * artifact, same pattern as invitation acceptance and signed file URLs). */
export const POST = apiHandler(async (req) => {
  const body = await req.json().catch(() => null);
  const parsed = ConfirmEmailVerificationSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid verification request");
  await confirmEmailVerification(parsed.data.token);
  return jsonOk({ verified: true });
});
