/** Injectable clock so time-dependent logic (approval timeouts, job
 * scheduling, audit ordering) is deterministically testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(at: Date): Clock {
  return { now: () => at };
}
