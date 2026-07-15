import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { aggregateNormalizedResults, type NormalizedResult } from "../src/generate/record.js";
import {
  archiveDaebDebugArtifacts,
  daebProductionVendorOrder,
  defaultProductionRunRoot,
  productionAggregateDir,
  productionTrialDir,
  writeArchiveManifest,
  writeProductionAggregate,
} from "../src/generate/production-run.js";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "ax-production-"));
  dirs.push(dir);
  return dir;
}

function makeRecord(overrides: Partial<NormalizedResult> = {}): NormalizedResult {
  return {
    schema: "ax.normalized-result/v1",
    surface: "api",
    product: "supabase",
    harness: "codex",
    standard_set_version: "DAEB-1-v3",
    generated_at: "2026-07-05T00:00:00.000Z",
    tasks_total: 10,
    tasks_passed: 8,
    pass_at_1: 0.8,
    pass_at_k: 0.8,
    attempts: 1,
    discovery_score: 0.7,
    content_quality: 0.8,
    profiles: ["medium"],
    best_profile: "medium",
    model: "gpt-5.4",
    latency_ms: 1000,
    tool_call_count: 5,
    token_usage: { input: 100, output: 50 },
    token_cost: 0.1,
    validity_status: "valid",
    first_action_latency_ms: 100,
    transcript_event_count: 12,
    action_occurred: true,
    summary_kind: "single",
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("production rerun helpers", () => {
  it("returns the benchmark vendor order and clean default root", () => {
    expect(daebProductionVendorOrder()).toEqual([
      "neon",
      "cockroachdb",
      "turso",
      "convex",
      "supabase",
      "mongodb-atlas",
      "insforge",
    ]);
    expect(defaultProductionRunRoot("/repo")).toBe("/repo/results/runs/daeb-1-v4-production");
    expect(productionTrialDir("/repo/results/runs/daeb-1-v4-production", "neon", "api", "codex", 2))
      .toBe("/repo/results/runs/daeb-1-v4-production/neon/api/codex/trial-2");
    expect(productionAggregateDir("/repo/results/runs/daeb-1-v4-production", "neon", "api", "codex"))
      .toBe("/repo/results/runs/daeb-1-v4-production/neon/api/codex/aggregate");
  });

  it("aggregates three trial records into mean/range/reliability output", () => {
    const aggregate = aggregateNormalizedResults([
      makeRecord({ pass_at_1: 0.6, pass_at_k: 0.6, latency_ms: 900 }),
      makeRecord({ pass_at_1: 0.8, pass_at_k: 0.8, latency_ms: 1000 }),
      makeRecord({ pass_at_1: 1.0, pass_at_k: 1.0, latency_ms: 1200 }),
    ], ["trial-1.json", "trial-2.json", "trial-3.json"]);
    expect(aggregate.summary_kind).toBe("aggregate");
    expect(aggregate.trial_count).toBe(3);
    expect(aggregate.mean_pass_rate).toBeCloseTo(0.8);
    expect(aggregate.range_pass_rate).toEqual({ min: 0.6, max: 1 });
    expect(aggregate.pass_hat_3).toBeCloseTo(0.8 ** 3);
    expect(aggregate.task_consistency_at_3).toBeNull();
    expect(aggregate.pass_all_3).toBe(0);
    expect(aggregate.source_records).toEqual(["trial-1.json", "trial-2.json", "trial-3.json"]);
  });

  it("writes aggregate artifacts for one production cell", () => {
    const runRoot = freshDir();
    for (const trial of [1, 2, 3]) {
      const trialDir = resolve(runRoot, "supabase", "api", "codex", `trial-${trial}`);
      mkdirSync(trialDir, { recursive: true });
      writeFileSync(resolve(trialDir, "generated-eval.snapshot.json"), JSON.stringify({
        runs: [{
          outcomes: [
            { taskId: "db-T01", success: true, na: false },
            { taskId: "db-T02", success: trial !== 2, na: false },
            { taskId: "db-T03", success: false, na: false },
          ],
        }],
      }, null, 2));
    }
    const manifest = writeProductionAggregate({
      runRoot,
      vendor: "supabase",
      surface: "api",
      harness: "codex",
      model: "gpt-5.4",
      trials: [
        {
          trial: 1,
          trial_dir: resolve(runRoot, "supabase", "api", "codex", "trial-1"),
          normalized_record: "trial-1/codex.api.normalized.json",
          snapshot_path: resolve(runRoot, "supabase", "api", "codex", "trial-1", "generated-eval.snapshot.json"),
          result_paths: ["trial-1/run-codex-medium.json"],
        },
        {
          trial: 2,
          trial_dir: resolve(runRoot, "supabase", "api", "codex", "trial-2"),
          normalized_record: "trial-2/codex.api.normalized.json",
          snapshot_path: resolve(runRoot, "supabase", "api", "codex", "trial-2", "generated-eval.snapshot.json"),
          result_paths: ["trial-2/run-codex-medium.json"],
        },
        {
          trial: 3,
          trial_dir: resolve(runRoot, "supabase", "api", "codex", "trial-3"),
          normalized_record: "trial-3/codex.api.normalized.json",
          snapshot_path: resolve(runRoot, "supabase", "api", "codex", "trial-3", "generated-eval.snapshot.json"),
          result_paths: ["trial-3/run-codex-medium.json"],
        },
      ],
      records: [
        makeRecord({ pass_at_1: 0.7 }),
        makeRecord({ pass_at_1: 0.8 }),
        makeRecord({ pass_at_1: 0.9 }),
      ],
    });
    expect(manifest.trial_count).toBe(3);
    const saved = JSON.parse(readFileSync(resolve(runRoot, "supabase", "api", "codex", "aggregate", "codex.api.aggregate.normalized.json"), "utf8"));
    expect(saved.mean_pass_rate).toBeCloseTo(0.8);
    expect(saved.range_pass_rate).toEqual({ min: 0.7, max: 0.9 });
    expect(saved.task_consistency_at_3).toBeCloseTo(1 / 3);
  });

  it("archives known debug artifacts into a separate manifest", () => {
    const root = freshDir();
    const archiveRoot = resolve(root, "results", "runs", "daeb-1-v4-production", "_archive", "pre-production");
    const previewDir = resolve(root, "results", "runs", "daeb-1-v3", "low-pass");
    mkdirSync(resolve(root, "results", "runs", "daeb-1-v3", "targeted-low"), { recursive: true });
    mkdirSync(previewDir, { recursive: true });
    writeFileSync(resolve(previewDir, "competitive-matrix-preview-v2.html"), "<html></html>\n");
    const entries = archiveDaebDebugArtifacts(root, archiveRoot);
    const manifestPath = writeArchiveManifest(archiveRoot, entries);
    expect(entries.some((entry) => entry.status === "archived")).toBe(true);
    expect(readFileSync(manifestPath, "utf8")).toContain("ax.daeb-production-archive/v1");
  });
});
