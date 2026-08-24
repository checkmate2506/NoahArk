import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { requireCurrentUser } from "@/lib/context";
import { DisableMfaSchema, disableMfa } from "@/lib/services/mfaService";

export const POST = apiHandler(async (req) => {
  const user = await requireCurrentUser();
  const body = await req.json().catch(() => null);
  const parsed = DisableMfaSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError("Invalid request");
  await disableMfa(user.id, parsed.data.password);
  return jsonOk({ disabled: true });
});
