import { describe, expect, it } from "vitest";
import { classifyHealthCheckSignals } from "../src/target/health-check.js";

describe("health-check signals", () => {
  it("flags leftover candidates as namespace pollution risk", () => {
    expect(classifyHealthCheckSignals({
      candidates: 3,
      errors: [],
      message: "found 3 probe resources",
    })).toEqual({
      namespace_pollution_risk: true,
      quota_pressure_hint: false,
      leftover_candidates: 3,
    });
  });

  it("flags quota/rate-limit wording", () => {
    expect(classifyHealthCheckSignals({
      candidates: 0,
      errors: ["HTTP 429 Too Many Requests: quota exceeded"],
      message: "list failed",
    })).toMatchObject({
      namespace_pollution_risk: false,
      quota_pressure_hint: true,
      leftover_candidates: 0,
    });
  });
});
