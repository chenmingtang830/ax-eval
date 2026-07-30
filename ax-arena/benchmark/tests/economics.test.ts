import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NormalizedResult } from "ax-eval";
import { describe, expect, it } from "vitest";
import {
  PricingSnapshotSchema,
  ProviderModelRosterSchema,
  buildArenaEconomicsReport,
  estimateRecordEconomics,
  parsePricingSnapshot,
  parseProviderModelRoster,
} from "../src/publication/economics.js";

const root = resolve(process.cwd(), "daeb/v1");
const roster = parseProviderModelRoster(readFileSync(resolve(root, "provider-model-roster.yaml"), "utf8"));
const pricing = parsePricingSnapshot(readFileSync(resolve(root, "pricing-snapshot.yaml"), "utf8"));

function record(overrides: Partial<NormalizedResult> = {}): NormalizedResult {
  return {
    schema: "ax.normalized-result/v2",
    product: "neon",
    surface: "api",
    harness: "codex",
    model: "gpt-5.6-terra",
    effort: "high",
    standard_set_version: "AXArena-Database-v1",
    generated_at: "2026-07-27T00:00:00.000Z",
    tasks_total: 2,
    tasks_passed: 1,
    pass_at_1: 0.5,
    pass_at_k: 0.5,
    attempts: 1,
    discovery_score: null,
    content_quality: null,
    profiles: ["high"],
    best_profile: "high",
    summary_kind: "aggregate",
    trial_count: 3,
    trial_values: [0.5, 1, 0],
    token_usage: {
      input_tokens: 1_000_000,
      cached_input_tokens: 200_000,
      cache_write_input_tokens: 100_000,
      output_tokens: 100_000,
    },
    cost_usd: null,
    ...overrides,
  };
}

describe("provider/model pricing economics", () => {
  it("loads the committed production roster and dated price snapshot", () => {
    expect(roster.entries.map((entry) => `${entry.provider}/${entry.model}`)).toEqual([
      "openai/gpt-5.6-terra",
      "anthropic/claude-sonnet-5",
    ]);
    expect(pricing.snapshot_id).toBe("axarena-api-list-pricing-2026-07-27");
    expect(pricing.rates.every((rate) => rate.source_url.startsWith("https://"))).toBe(true);
  });

  it("prices OpenAI cached input as a subset and divides by successful task runs", () => {
    const economics = estimateRecordEconomics(record(), roster, pricing);
    expect(economics.status).toBe("priced");
    expect(economics.tokens).toEqual({
      uncached_input: 700_000,
      cached_input: 200_000,
      cache_write_5m: 100_000,
      output: 100_000,
    });
    expect(economics.estimated_cost_usd).toBeCloseTo(3.6125);
    expect(economics.task_runs_passed).toBe(3);
    expect(economics.task_runs_total).toBe(6);
    expect(economics.cost_per_success_usd).toBeCloseTo(3.6125 / 3);
  });

  it("does not claim an exact OpenAI estimate without cache-write telemetry", () => {
    const economics = estimateRecordEconomics(record({
      token_usage: { input_tokens: 1_000_000, cached_input_tokens: 200_000, output_tokens: 100_000 },
    }), roster, pricing);

    expect(economics.status).toBe("unavailable");
    expect(economics.reason).toContain("no cache-write token usage");
    expect(economics.estimated_cost_usd).toBeNull();
  });

  it("prices Anthropic cache tokens separately and retains native cost as context", () => {
    const economics = estimateRecordEconomics(record({
      harness: "claude-code",
      model: "claude-sonnet-5",
      token_usage: {
        input_tokens: 500_000,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 50_000,
        output_tokens: 100_000,
      },
      cost_usd: 1.75,
    }), roster, pricing);
    expect(economics.native_cost_usd).toBe(1.75);
    expect(economics.estimated_cost_usd).toBeCloseTo(2.145);
    expect(economics.tokens?.uncached_input).toBe(500_000);
  });

  it("does not manufacture cost per success for zero-pass or unrostered cells", () => {
    expect(estimateRecordEconomics(record({ trial_values: [0, 0, 0] }), roster, pricing).cost_per_success_usd).toBeNull();
    const unavailable = estimateRecordEconomics(record({ model: "gpt-unlisted" }), roster, pricing);
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.reason).toContain("not present");
  });

  it("emits deterministic economics cells without affecting score fields", () => {
    const report = buildArenaEconomicsReport([
      record({ product: "beta", surface: "cli" }),
      record({ product: "alpha", surface: "api" }),
    ], roster, pricing);
    expect(report.cells.map((cell) => cell.product)).toEqual(["alpha", "beta"]);
    expect(report.cost_basis).toContain("list-price estimate");
  });

  it("rejects ambiguous rosters and snapshots outside rate validity", () => {
    expect(ProviderModelRosterSchema.safeParse({
      ...roster,
      entries: [...roster.entries, roster.entries[0]],
    }).success).toBe(false);
    expect(PricingSnapshotSchema.safeParse({ ...pricing, as_of: "2026-09-01" }).success).toBe(false);
  });
});
