import { describe, expect, it } from "vitest";
import { defaultSuiteMethodology } from "../src/generate/suite-methodology.js";

describe("default suite methodology", () => {
  it("keeps database production scope narrow and reviewable", () => {
    const methodology = defaultSuiteMethodology("database", 10);
    expect(methodology.surface_scope).toEqual(["api", "cli"]);
    expect(methodology.target_task_count).toBe(10);
    expect(methodology.capability_families).toContain("recovery");
    expect(methodology.human_review_checkpoints.join(" ")).toMatch(/oracle/i);
  });
});
