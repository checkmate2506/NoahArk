/** Stable, client-safe error codes. Never leak stack traces or internals. */
export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "STALE_VERSION"
  | "RATE_LIMITED"
  | "IDEMPOTENCY_MISMATCH"
  | "MODULE_DISABLED"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly httpStatus: number;
  // Explicit `| undefined` (not `details?:`) so assigning a possibly-
  // undefined constructor argument type-checks under exactOptionalPropertyTypes
  // — the field genuinely may hold `undefined`, it isn't "absent".
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: AppErrorCode,
    message: string,
    httpStatus: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = "Authentication required") {
    super("UNAUTHENTICATED", message, 401);
  }
}

/** Thrown by every authorization check. Never distinguishes "not found" from
 * "not permitted" in its message — callers must not use it to enumerate
 * resources that exist in another tenant/legal entity. */
export class ForbiddenError extends AppError {
  constructor(message = "Not permitted") {
    super("FORBIDDEN", message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super("NOT_FOUND", `${resource} not found`, 404);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_FAILED", message, 422, details);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super("CONFLICT", message, 409);
  }
}

/** N-1 (Phase 1D): a dedicated class for the RATE_LIMITED code, matching
 * every other AppErrorCode's own class — previously constructed ad hoc
 * (`new AppError("RATE_LIMITED", ..., 429)`) at each call site (sign-in,
 * now also the MFA challenge path). */
export class RateLimitedError extends AppError {
  constructor(message = "Too many attempts — try again later") {
    super("RATE_LIMITED", message, 429);
  }
}

/** Optimistic-concurrency failure — the caller's `version` no longer matches. */
export class StaleVersionError extends AppError {
  constructor(resource: string) {
    super(
      "STALE_VERSION",
      `${resource} was modified by someone else — reload and retry`,
      409,
    );
  }
}

export class IdempotencyMismatchError extends AppError {
  constructor() {
    super(
      "IDEMPOTENCY_MISMATCH",
      "This idempotency key was already used with a different request body",
      422,
    );
  }
}

/** Distinct from ForbiddenError: the caller might otherwise be fully
 * permitted, but the tenant has this module/feature switched off. */
export class ModuleDisabledError extends AppError {
  constructor(moduleKey: string) {
    super(
      "MODULE_DISABLED",
      `The "${moduleKey}" module is not enabled for this tenant`,
      403,
      {
        moduleKey,
      },
    );
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Converts any thrown value into a safe, client-facing shape. Never include
 * `e.stack` or raw driver error messages in the output. */
export function toSafeErrorResponse(e: unknown): {
  code: AppErrorCode;
  message: string;
  details: Record<string, unknown> | undefined;
  httpStatus: number;
} {
  if (isAppError(e)) {
    return {
      code: e.code,
      message: e.message,
      details: e.details,
      httpStatus: e.httpStatus,
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred",
    details: undefined,
    httpStatus: 500,
  };
}
