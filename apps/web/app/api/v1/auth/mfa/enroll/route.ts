import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { requireCurrentUser } from "@/lib/context";
import { enrollMfa } from "@/lib/services/mfaService";

export const POST = apiHandler(async () => {
  const user = await requireCurrentUser();
  const result = await enrollMfa(user.id);
  return jsonOk(result);
});
