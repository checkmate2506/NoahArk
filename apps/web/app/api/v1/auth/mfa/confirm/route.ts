import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { requireCurrentUser } from "@/lib/context";
import {
  ConfirmMfaEnrollmentSchema,
  confirmMfaEnrollment,
} from "@/lib/services/mfaService";

export const POST = apiHandler(async (req) => {
  const user = await requireCurrentUser();
  const body = await req.json().catch(() => null);
  const parsed = ConfirmMfaEnrollmentSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid confirmation request");
  const result = await confirmMfaEnrollment(user.id, parsed.data.code);
  return jsonOk(result);
});
