import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateNormalizedResults, type NormalizedResult } from "../src/generate/record.js";

function record(overrides: Partial<NormalizedResult>): NormalizedResult {
  return {
    schema: "ax.normalized-result/v1",
    surface: "api",
    product: "supabase",
    harness: "claude-code",
    standard_set_version: "daeb-v1",
    generated_at: "2026-07-18T00:00:00.000Z",
    tasks_total: 7,
    tasks_passed: 7,
    pass_at_1: 1,
    pass_at_k: 1,
    attempts: 1,
    discovery_score: null,
    content_quality: null,
    profiles: ["high"],
    best_profile: "high",
    model: "claude-sonnet-5",
    harness_version_raw: "2.1.5 (Claude Code)",
    harness_version_semver: "2.1.5",
    run_batch_id: "batch-a",
    ...overrides,
  };
}

describe("normalized operational metrics", () => {
  it("uses median successful latency and sums total duration, tokens, and native cost", () => {
    const aggregate = aggregateNormalizedResults([
      record({ latency_ms: 300, total_duration_ms: 500, cost_usd: 0.1, token_usage: { input_tokens: 100, output_tokens: 10 } }),
      record({ latency_ms: 100, total_duration_ms: 100, cost_usd: 0.2, token_usage: { input_tokens: 200, output_tokens: 20 } }),
      record({ latency_ms: 200, total_duration_ms: 250, cost_usd: 0.3, token_usage: { input_tokens: 300, output_tokens: 30 } }),
    ]);
    expect(aggregate.latency_ms).toBe(200);
    expect(aggregate.total_duration_ms).toBe(850);
    expect(aggregate.cost_usd).toBeCloseTo(0.6);
    expect(aggregate.token_usage).toEqual({ input_tokens: 600, output_tokens: 60 });
    expect(aggregate.tokens_in).toBe(600);
    expect(aggregate.tokens_out).toBe(60);
    expect(aggregate.harness_version_semver).toBe("2.1.5");
    expect(aggregate.run_batch_id).toBe("batch-a");
  });

  it("ships an additive public schema that marks mean-cubed reliability deprecated", () => {
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), "schemas", "normalized-result.v1.json"), "utf8"));
    expect(schema.properties.schema.const).toBe("ax.normalized-result/v1");
    expect(schema.properties.pass_hat_3.deprecated).toBe(true);
    for (const field of ["harness_version_raw", "harness_version_semver", "run_batch_id", "cost_usd", "pass_3_tasks", "pass_3_tasks_total"]) {
      expect(schema.properties).toHaveProperty(field);
    }
  });
});
