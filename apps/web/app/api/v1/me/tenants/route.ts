import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { requireCurrentUser, listMyTenants } from "@/lib/context";

export const GET = apiHandler(async () => {
  const user = await requireCurrentUser();
  const tenants = await listMyTenants(user.id);
  return jsonOk({ tenants });
});
