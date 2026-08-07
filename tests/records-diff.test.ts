import { describe, expect, it } from "vitest";
import { renderRecordsDiffMarkdown } from "../src/generate/records-diff.js";
import type { NormalizedResult } from "../src/generate/record.js";

function record(overrides: Partial<NormalizedResult> = {}): NormalizedResult {
  return {
    schema: "ax.normalized-result/v2",
    surface: "api",
    product: "neon",
    harness: "codex",
    standard_set_version: "axarena-database-v1",
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
    effort: "high",
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
    expect(markdown).toContain("## ✅ PASS — No correctness regression detected");
    expect(markdown).toContain("Compared 3 baseline surface cell(s)");
    expect(markdown).toContain("| neon | axarena-database-v1 | codex | gpt-5.6-terra | high | 70.0% | 90.0% | +20.0 pp | 50.0% (5/10) | 80.0% (8/10) | 2 |");
    expect(markdown).toContain("| neon | axarena-database-v1 | claude-code | claude-sonnet-5 | high | 90.0% | 90.0% | +0.0 pp");
    expect(markdown).toContain("42.9% (3/7)");
    expect(markdown).toContain("Operational metrics are context only");
  });

  it("fails fast when a correctness score regresses", () => {
    const base = [record({ pass_at_1: 5 / 7, task_consistency_at_3: 3 / 7 })];
    const head = [record({ pass_at_1: 4 / 7, task_consistency_at_3: 2 / 7 })];

    const markdown = renderRecordsDiffMarkdown(base, head);
    expect(markdown).toContain("## ❌ FAIL — Correctness regression detected");
    expect(markdown).toContain("Found 2 regression signal(s) across 1 baseline surface cell(s)");
    expect(markdown).toContain("`neon / axarena-database-v1 / codex / gpt-5.6-terra / high / api`: pass@1 71.4% → 57.1% (-14.3 pp)");
    expect(markdown).toContain("`neon / axarena-database-v1 / codex / gpt-5.6-terra / high / api`: pass³ 42.9% → 28.6% (-14.3 pp)");
  });

  it("fails when a baseline cell disappears or becomes blocked", () => {
    const markdown = renderRecordsDiffMarkdown([record()], [record({ blocked: true, blocked_reason: "auth" })]);

    expect(markdown).toContain("## ❌ FAIL — Correctness regression detected");
    expect(markdown).toContain("`neon / axarena-database-v1 / codex / gpt-5.6-terra / high / api`: baseline cell disappeared or became blocked.");
  });

  it("does not fold two models or efforts running under one harness", () => {
    const base = [
      record({ model: "gpt-a", effort: "medium", pass_at_1: 0.5 }),
      record({ model: "gpt-b", effort: "medium", pass_at_1: 0.6 }),
      record({ model: "gpt-a", effort: "high", pass_at_1: 0.7 }),
    ];
    const markdown = renderRecordsDiffMarkdown(base, base);
    expect(markdown).toContain("Compared 3 baseline surface cell(s)");
    expect(markdown).toContain("| neon | axarena-database-v1 | codex | gpt-a | medium |");
    expect(markdown).toContain("| neon | axarena-database-v1 | codex | gpt-b | medium |");
    expect(markdown).toContain("| neon | axarena-database-v1 | codex | gpt-a | high |");
  });

  it("does not compare correctness across standard-set versions", () => {
    const markdown = renderRecordsDiffMarkdown(
      [record({ standard_set_version: "set-v1", pass_at_1: 0.9 })],
      [record({ standard_set_version: "set-v2", pass_at_1: 0.1 })],
    );

    expect(markdown).toContain("`neon / set-v1 / codex / gpt-5.6-terra / high / api`: baseline cell disappeared or became blocked.");
    expect(markdown).not.toContain("pass@1 90.0% → 10.0%");
    expect(markdown).toContain("| neon | set-v1 | codex |");
    expect(markdown).toContain("| neon | set-v2 | codex |");
  });
});
