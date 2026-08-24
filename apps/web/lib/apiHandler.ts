import { NextResponse } from "next/server";
import { newRequestId, toSafeErrorResponse } from "@noahark/core";
import { assertTrustedOrigin } from "@/lib/csrf";

/** Consistent response envelope: `{ data }` on success, `{ error }` on
 * failure — never a bare array/object, so clients can distinguish the two
 * without inspecting the HTTP status. Every error response carries a stable
 * `code` (packages/core's AppErrorCode) and the request's correlation id. */
export function jsonOk<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ data }, init);
}

export function jsonError(e: unknown, requestId: string): NextResponse {
  const safe = toSafeErrorResponse(e);
  if (safe.code === "INTERNAL_ERROR") {
    // Server-side log only — never sent to the client (no stack traces or
    // driver error text ever leave the process).
    console.error(`[requestId=${requestId}]`, e);
  }
  return NextResponse.json(
    {
      error: { code: safe.code, message: safe.message, details: safe.details, requestId },
    },
    { status: safe.httpStatus },
  );
}

/** Wraps a route handler: assigns/propagates a correlation id, awaits and
 * forwards Next.js's dynamic route params, and converts any thrown AppError
 * (or unknown error) into the safe envelope above. Every /api/v1 route must
 * be written as `apiHandler(async (req, requestId, params) => ...)`. */
export function apiHandler<
  TParams extends Record<string, string | string[]> = Record<string, never>,
>(handler: (req: Request, requestId: string, params: TParams) => Promise<NextResponse>) {
  return async (
    req: Request,
    context: { params: Promise<TParams> },
  ): Promise<NextResponse> => {
    const requestId = req.headers.get("x-request-id") ?? newRequestId();
    try {
      assertTrustedOrigin(req);
      const params = await context.params;
      const response = await handler(req, requestId, params);
      response.headers.set("x-request-id", requestId);
      return response;
    } catch (e) {
      return jsonError(e, requestId);
    }
  };
}
