import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { requireCurrentUser } from "@/lib/context";
import { requestEmailVerification } from "@/lib/services/emailVerificationService";

export const POST = apiHandler(async () => {
  const user = await requireCurrentUser();
  await requestEmailVerification(user.id);
  // Always the same response regardless of prior verification state — no
  // oracle for "was this account already verified".
  return jsonOk({ requested: true });
});
