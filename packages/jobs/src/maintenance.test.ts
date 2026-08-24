import { describe, expect, it, vi } from "vitest";
import { runMaintenanceTasks } from "./maintenance";

describe("runMaintenanceTasks (N-5, Phase 1D)", () => {
  it("runs every supplied task", async () => {
    const a = vi.fn().mockResolvedValue(3);
    const b = vi.fn().mockResolvedValue(0);
    await runMaintenanceTasks({ a, b });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("a failing task does not prevent the others from running", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const succeeding = vi.fn().mockResolvedValue(1);
    await runMaintenanceTasks({ failing, succeeding });
    expect(succeeding).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("resolves cleanly with zero tasks", async () => {
    await expect(runMaintenanceTasks({})).resolves.toBeUndefined();
  });

  it("logs a summary when a task reports rows cleaned, stays quiet when it reports zero", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runMaintenanceTasks({
      cleaned: vi.fn().mockResolvedValue(5),
      noop: vi.fn().mockResolvedValue(0),
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain("cleaned");
    warnSpy.mockRestore();
  });
});
