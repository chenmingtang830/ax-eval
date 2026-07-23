import { describe, expect, it } from "vitest";
import { defaultSuiteMethodology } from "../src/authoring/methodology-policy.js";

describe("arena suite methodology policy", () => {
  it("keeps DAEB v1 on api/cli while other categories retain the generic engine surfaces", () => {
    const database = defaultSuiteMethodology("database");
    expect(database.surface_scope).toEqual(["api", "cli"]);
    expect(database.target_task_count).toBe(7);
    expect(database.min_vendor_coverage_pct).toBe(0.75);
    expect(database.static_ax.dimensions).toContain("discoverability");
    expect(database.behavioral.source_of_truth).toMatch(/world state/i);

    const generic = defaultSuiteMethodology("crm");
    expect(generic.surface_scope).toEqual(["api", "sdk", "cli"]);
    expect(generic.target_task_count).toBe(10);
  });
});
