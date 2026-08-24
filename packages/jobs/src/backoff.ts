/** Exponential backoff with a cap and +/-20% jitter, seeded so it is
 * deterministically testable via an injectable random function. */
export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  random?: () => number; // [0, 1)
}

const DEFAULT_BASE_MS = 1_000;
const DEFAULT_MAX_MS = 5 * 60_000;

export function computeBackoffMs(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const random = options.random ?? Math.random;

  const exponential = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, maxMs);
  const jitterFactor = 0.8 + random() * 0.4; // 0.8x .. 1.2x
  return Math.round(capped * jitterFactor);
}
