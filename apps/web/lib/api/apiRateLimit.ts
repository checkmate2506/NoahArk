import { RateLimitedError, type AccessContext } from "@noahark/core";
import {
  consumeApiWriteAllowance,
  type ConsumeApiWriteAllowanceOptions,
} from "@/lib/rateLimiter";

/**
 * Shared P2D.1 write-limiter adapter. Every `tenantWriteRoute` calls this
 * once, after authorization, so an unauthorised caller cannot consume
 * another tenant's bucket. There is no per-route copy.
 *
 * Exhaustion throws `RateLimitedError` (HTTP 429 via `jsonError`). Only a
 * recognised limiter infrastructure failure is fail-open inside
 * `consumeApiWriteAllowance`.
 */
export async function enforceTenantWriteRateLimit(
  ctx: AccessContext,
  options: ConsumeApiWriteAllowanceOptions = {},
): Promise<void> {
  const result = await consumeApiWriteAllowance(
    { tenantId: ctx.tenantId, userId: ctx.userId },
    options,
  );
  if (result === "limited") {
    throw new RateLimitedError("Too many write attempts — try again later");
  }
}
