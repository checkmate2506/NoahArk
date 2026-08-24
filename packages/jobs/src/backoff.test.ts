import { describe, expect, it } from "vitest";
import { computeBackoffMs } from "./backoff";

describe("computeBackoffMs", () => {
  it("grows exponentially with attempt number", () => {
    const noJitter = () => 0.5; // midpoint => exact 1x multiplier
    const a1 = computeBackoffMs(1, { baseMs: 1000, random: noJitter });
    const a2 = computeBackoffMs(2, { baseMs: 1000, random: noJitter });
    const a3 = computeBackoffMs(3, { baseMs: 1000, random: noJitter });
    expect(a1).toBe(1000);
    expect(a2).toBe(2000);
    expect(a3).toBe(4000);
  });

  it("caps at maxMs regardless of how large the attempt number is", () => {
    const noJitter = () => 0.5;
    const result = computeBackoffMs(20, {
      baseMs: 1000,
      maxMs: 60_000,
      random: noJitter,
    });
    expect(result).toBe(60_000);
  });

  it("applies jitter within +/-20% of the capped value", () => {
    const low = computeBackoffMs(1, { baseMs: 1000, random: () => 0 });
    const high = computeBackoffMs(1, { baseMs: 1000, random: () => 0.999999 });
    expect(low).toBeGreaterThanOrEqual(800);
    expect(low).toBeLessThan(1000);
    expect(high).toBeGreaterThan(1000);
    expect(high).toBeLessThanOrEqual(1200);
  });

  it("never produces a negative or zero delay", () => {
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(computeBackoffMs(attempt)).toBeGreaterThan(0);
    }
  });
});
