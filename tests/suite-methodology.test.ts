import { describe, expect, it } from "vitest";
import { defaultSuiteMethodology, SuiteMethodologySchema } from "../src/generate/suite-methodology.js";

describe("default suite methodology", () => {
  it("keeps database production scope narrow and reviewable", () => {
    const methodology = defaultSuiteMethodology("database", 10);
    expect(methodology.surface_scope).toEqual(["api", "cli"]);
    expect(methodology.target_task_count).toBe(10);
    expect(methodology).not.toHaveProperty("capability_families");
    expect(methodology).not.toHaveProperty("family_diversity_cap");
    expect(methodology.human_review_checkpoints.join(" ")).toMatch(/oracle/i);
  });

  it("rejects duplicate surface policy entries", () => {
    const methodology = defaultSuiteMethodology("database", 10);
    expect(SuiteMethodologySchema.safeParse({ ...methodology, surface_scope: ["api", "api"] }).success).toBe(false);
  });
});
