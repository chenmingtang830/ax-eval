import { describe, expect, it } from "vitest";
import {
  aggregateNormalizedResults,
  classifyTrialStabilityAt3,
  NORMALIZED_RESULT_SCHEMA,
  type NormalizedResult,
} from "../src/generate/record.js";

function trial(overrides: Partial<NormalizedResult> = {}): NormalizedResult {
  return {
    schema: NORMALIZED_RESULT_SCHEMA,
    surface: "api",
    product: "acme",
    harness: "codex",
    standard_set_version: "suite-v1",
    generated_at: "2026-07-16T00:00:00.000Z",
    tasks_total: 4,
    tasks_passed: 4,
    pass_at_1: 1,
    pass_at_k: 1,
    attempts: 1,
    discovery_score: 0.8,
    content_quality: 0.9,
    profiles: ["medium"],
    best_profile: "medium",
    model: "model-a",
    latency_ms: 1000,
    first_action_latency_ms: 100,
    transcript_event_count: 10,
    action_occurred: true,
    validity_status: "valid",
    summary_kind: "single",
    ...overrides,
  };
}

describe("aggregateNormalizedResults", () => {
  it("aggregates three comparable trials deterministically", () => {
    const aggregate = aggregateNormalizedResults(
      [
        trial(),
        trial({ pass_at_1: 0.5, pass_at_k: 0.75, tasks_passed: 2, latency_ms: 2000 }),
        trial({ pass_at_1: 0, pass_at_k: 0.25, tasks_passed: 0, latency_ms: null, validity_status: "partial" }),
      ],
      ["trial-1.json", "trial-2.json", "trial-3.json"],
      { now: () => new Date("2026-07-16T12:00:00.000Z") },
    );

    expect(aggregate.generated_at).toBe("2026-07-16T12:00:00.000Z");
    expect(aggregate.summary_kind).toBe("aggregate");
    expect(aggregate.trial_count).toBe(3);
    expect(aggregate.trial_values).toEqual([1, 0.5, 0]);
    expect(aggregate.mean_pass_rate).toBe(0.5);
    expect(aggregate.range_pass_rate).toEqual({ min: 0, max: 1 });
    expect(aggregate.pass_at_1).toBe(0.5);
    expect(aggregate.pass_at_k).toBeCloseTo(2 / 3);
    expect(aggregate.latency_ms).toBe(1500);
    expect(aggregate.validity_status).toBe("mixed");
    expect(aggregate.pass_hat_3).toBe(0.125);
    expect(aggregate.pass_all_3).toBe(0);
    expect(aggregate.trial_stability_at_3).toBe("inconsistent");
    expect(aggregate.source_records).toEqual(["trial-1.json", "trial-2.json", "trial-3.json"]);
  });

  it("rejects records from different benchmark cells", () => {
    expect(() => aggregateNormalizedResults([trial(), trial({ surface: "cli" })])).toThrow(/surface/);
    expect(() => aggregateNormalizedResults([trial(), trial({ model: "model-b" })])).toThrow(/model/);
    expect(() => aggregateNormalizedResults([trial(), trial({ standard_set_version: "suite-v2" })])).toThrow(/standard_set_version/);
  });

  it("rejects blocked, pre-aggregated, invalid, and mislabelled inputs", () => {
    expect(() => aggregateNormalizedResults([])).toThrow(/at least one/);
    expect(() => aggregateNormalizedResults([trial({ blocked: "invoke-failed" })])).toThrow(/blocked/);
    expect(() => aggregateNormalizedResults([trial({ summary_kind: "aggregate" })])).toThrow(/already an aggregate/);
    expect(() => aggregateNormalizedResults([trial({ pass_at_1: 1.2 })])).toThrow(/invalid pass_at_1/);
    expect(() => aggregateNormalizedResults([trial({ pass_at_k: 0.5 })])).toThrow(/invalid pass_at_k/);
    expect(() => aggregateNormalizedResults([trial({ tasks_passed: 3 })])).toThrow(/does not match pass_at_1/);
    expect(() => aggregateNormalizedResults([trial(), trial()], ["one.json"])).toThrow(/source record count/);
  });
});

describe("classifyTrialStabilityAt3", () => {
  it("classifies only exact three-trial cohorts", () => {
    expect(classifyTrialStabilityAt3([1, 1, 1])).toBe("all_pass");
    expect(classifyTrialStabilityAt3([0, 0, 0])).toBe("all_fail");
    expect(classifyTrialStabilityAt3([1, 0.5, 0])).toBe("inconsistent");
    expect(classifyTrialStabilityAt3([1, 1])).toBeNull();
  });
});
