import { describe, expect, it } from "vitest";
import { renderRecordsDiffMarkdown } from "../src/generate/records-diff.js";
import type { NormalizedResult } from "../src/generate/record.js";

function record(overrides: Partial<NormalizedResult> = {}): NormalizedResult {
  return {
    schema: "ax.normalized-result/v1",
    surface: "api",
    product: "neon",
    harness: "codex",
    standard_set_version: "daeb-v1",
    generated_at: "2026-07-18T00:00:00.000Z",
    tasks_total: 7,
    tasks_passed: 5,
    pass_at_1: 5 / 7,
    pass_at_k: 5 / 7,
    attempts: 1,
    discovery_score: null,
    content_quality: null,
    profiles: ["high"],
    best_profile: "high",
    model: "gpt-5.6-terra",
    summary_kind: "aggregate",
    trial_count: 3,
    task_consistency_at_3: 3 / 7,
    pass_3_tasks: 3,
    pass_3_tasks_total: 7,
    latency_ms: 1000,
    cost_usd: null,
    token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    harness_version_semver: "0.121.0",
    ...overrides,
  };
}

describe("records diff markdown", () => {
  it("keeps agents separate and macro-averages participating surfaces", () => {
    const base = [
      record({ surface: "api", pass_at_1: 0.6, task_consistency_at_3: 0.5, pass_3_tasks: 2, pass_3_tasks_total: 4 }),
      record({ surface: "cli", pass_at_1: 0.8, task_consistency_at_3: 0.5, pass_3_tasks: 3, pass_3_tasks_total: 6 }),
      record({ harness: "claude-code", model: "claude-sonnet-5", pass_at_1: 0.9, cost_usd: 0.3 }),
    ];
    const head = [
      record({ surface: "api", pass_at_1: 0.8, task_consistency_at_3: 0.75, pass_3_tasks: 3, pass_3_tasks_total: 4 }),
      record({ surface: "cli", pass_at_1: 1, task_consistency_at_3: 5 / 6, pass_3_tasks: 5, pass_3_tasks_total: 6 }),
      record({ harness: "claude-code", model: "claude-sonnet-5", pass_at_1: 0.9, cost_usd: 0.4 }),
    ];

    const markdown = renderRecordsDiffMarkdown(base, head);
    expect(markdown).toContain("| neon | codex | 70.0% | 90.0% | +20.0 pp | 50.0% (5/10) | 80.0% (8/10) | 2 |");
    expect(markdown).toContain("| neon | claude-code | 90.0% | 90.0% | +0.0 pp");
    expect(markdown).toContain("42.9% (3/7)");
    expect(markdown).toContain("Operational metrics are context only");
  });
});
