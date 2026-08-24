import { ValidationError } from "@noahark/core";
import { apiHandler, jsonOk } from "@/lib/apiHandler";
import { resolveTenantContext } from "@/lib/context";
import { uploadFile, UploadFileSchema } from "@/lib/services/fileServiceWrapper";

type Params = { tenantId: string };

export const POST = apiHandler<Params>(async (req, requestId, { tenantId }) => {
  const ctx = await resolveTenantContext(req, requestId, tenantId);

  const formData = await req.formData().catch(() => null);
  if (!formData) throw new ValidationError("Expected multipart/form-data");

  const file = formData.get("file");
  if (!(file instanceof File)) throw new ValidationError("Missing file field");

  const parsed = UploadFileSchema.safeParse({
    ownerEntityType: formData.get("ownerEntityType"),
    ownerEntityId: formData.get("ownerEntityId"),
    legalEntityId: formData.get("legalEntityId") || null,
  });
  if (!parsed.success) {
    throw new ValidationError("Invalid request body", { issues: parsed.error.issues });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const fileObject = await uploadFile(ctx, parsed.data, {
    originalFilename: file.name,
    buffer,
  });
  return jsonOk({ file: fileObject }, { status: 201 });
});
