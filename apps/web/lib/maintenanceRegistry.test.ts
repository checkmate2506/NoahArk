import { describe, expect, it } from "vitest";
import {
  MAINTENANCE_TASKS,
  DOCUMENTED_MAINTENANCE_CATEGORIES,
} from "./maintenanceRegistry";

/**
 * P1E-4 (Phase 1F): fails if a documented retention category is not
 * actually registered with the worker's maintenance sweep — the exact gap
 * N-5/P1E-4 both exist to close. Checks against
 * `DOCUMENTED_MAINTENANCE_CATEGORIES`, not `MAINTENANCE_TASKS`'s own keys,
 * so simply renaming/removing a task can never silently "pass" by
 * shrinking the thing being checked against.
 */
describe("worker maintenance sweep — category inventory (P1E-4)", () => {
  it("registers a real task function for every documented category", () => {
    for (const [category, taskKey] of Object.entries(DOCUMENTED_MAINTENANCE_CATEGORIES)) {
      expect(
        MAINTENANCE_TASKS,
        `category "${category}" maps to task key "${taskKey}"`,
      ).toHaveProperty(taskKey);
      expect(
        typeof MAINTENANCE_TASKS[taskKey],
        `category "${category}"'s task ("${taskKey}") must be a function`,
      ).toBe("function");
    }
  });

  it("covers all 9 documented categories required by Phase 1F's P1E-4 (email-verification and MFA-challenge tokens are 2 categories sharing 1 task)", () => {
    const required = [
      "expired rate-limit buckets",
      "expired email-verification tokens",
      "expired MFA challenges",
      "expired sessions",
      "expired/revoked/consumed membership invitations",
      "expired test email captures",
      "terminal SUCCEEDED/DEAD background jobs",
      "terminal PROCESSED/FAILED outbox events",
      "Deleted-file physical storage purge",
    ];
    for (const category of required) {
      expect(DOCUMENTED_MAINTENANCE_CATEGORIES, category).toHaveProperty(category);
    }
  });
});
