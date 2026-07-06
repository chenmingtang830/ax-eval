import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildPublicationBundle } from "../src/generate/publication.js";
import { loadSuite } from "../src/generate/suite.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("publication bundle", () => {
  const dirs: string[] = [];

  function freshDir(prefix: string): string {
    const dir = mkdtempSync(resolve(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("treats low coverage as publication-critical and high coverage as optional", () => {
    const runDir = freshDir("ax-pub-run-");
    const outDir = freshDir("ax-pub-out-");
    const vendorDir = resolve(runDir, "supabase");
    const suitePath = "targets/suites/daeb-1-v3.yaml";
    const suite = loadSuite(resolve(ROOT, suitePath));
    mkdirSync(vendorDir, { recursive: true });

    const baseRecord = {
      schema: "ax.normalized-result/v1",
      standard_set_version: "DAEB-1-v3",
      generated_at: "2026-07-05T00:00:00.000Z",
      tasks_total: 10,
      tasks_passed: 8,
      pass_at_1: 0.8,
      pass_at_k: 0.8,
      attempts: 1,
      discovery_score: 0.75,
      content_quality: 0.8,
      profiles: ["low"],
      best_profile: "low",
      model: "test-model",
      latency_ms: 1234,
      tool_call_count: 5,
      token_usage: { input: 100, output: 50 },
      token_cost: 0.12,
      validity_status: "valid",
      first_action_latency_ms: 100,
      transcript_event_count: 12,
      action_occurred: true,
    };

    writeFileSync(resolve(vendorDir, "codex.api.normalized.json"), JSON.stringify({
      ...baseRecord,
      product: "supabase",
      harness: "codex",
      surface: "api",
    }, null, 2));
    writeFileSync(resolve(vendorDir, "claude-code.api.normalized.json"), JSON.stringify({
      ...baseRecord,
      product: "supabase",
      harness: "claude-code",
      surface: "api",
    }, null, 2));
    writeFileSync(resolve(vendorDir, "codex.cli.normalized.json"), JSON.stringify({
      ...baseRecord,
      product: "supabase",
      harness: "codex",
      surface: "cli",
    }, null, 2));
    writeFileSync(resolve(vendorDir, "claude-code.cli.normalized.json"), JSON.stringify({
      ...baseRecord,
      product: "supabase",
      harness: "claude-code",
      surface: "cli",
    }, null, 2));
    writeFileSync(resolve(vendorDir, "generated-eval.snapshot.json"), JSON.stringify({ runs: [] }, null, 2));
    writeFileSync(resolve(vendorDir, "generated-eval.html"), "<html><body>report</body></html>\n");
    writeFileSync(resolve(runDir, "competitive.html"), "<html><body>competitive</body></html>\n");

    const manifest = buildPublicationBundle({
      root: ROOT,
      suite,
      suitePath,
      vendors: ["supabase"],
      runDir,
      outDir,
    });

    expect(manifest.publication_readiness).toBe("publication_ready");
    expect(manifest.expected_matrix.surfaces).toEqual(["api", "cli"]);
    expect(manifest.expected_matrix.harnesses).toEqual(["codex", "claude-code"]);
    expect(manifest.expected_matrix.effort_profiles).toEqual(["low", "high"]);
    expect(manifest.expected_matrix.required_effort_profiles).toEqual(["low"]);
    expect(manifest.quality_gates.find((gate) => gate.id === "matrix-completeness")?.status).toBe("pass");
    expect(manifest.quality_gates.find((gate) => gate.id === "high-profile-coverage")?.status).toBe("warn");
    expect(manifest.notes.some((note) => note.includes("missing high coverage does not block"))).toBe(true);
  });

  it("can freeze a production bundle from aggregate-only medium records", () => {
    const runDir = freshDir("ax-pub-prod-run-");
    const outDir = freshDir("ax-pub-prod-out-");
    const aggregateDir = resolve(runDir, "supabase", "api", "codex", "aggregate");
    const suitePath = "targets/suites/daeb-1-v3.yaml";
    const suite = loadSuite(resolve(ROOT, suitePath));
    mkdirSync(aggregateDir, { recursive: true });

    writeFileSync(resolve(aggregateDir, "codex.api.aggregate.normalized.json"), JSON.stringify({
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
      discovery_score: 0.75,
      content_quality: 0.8,
      profiles: ["medium"],
      best_profile: "medium",
      model: "gpt-5.4",
      latency_ms: 1200,
      tool_call_count: 5,
      token_usage: { input: 100, output: 50 },
      token_cost: 0.12,
      validity_status: "valid",
      first_action_latency_ms: 100,
      transcript_event_count: 12,
      action_occurred: true,
      summary_kind: "aggregate",
      trial_count: 3,
      trial_values: [0.7, 0.8, 0.9],
      mean_pass_rate: 0.8,
      range_pass_rate: { min: 0.7, max: 0.9 },
      pass_all_3: 0,
    }, null, 2));
    mkdirSync(resolve(runDir, "supabase", "api", "claude-code", "aggregate"), { recursive: true });
    writeFileSync(resolve(runDir, "supabase", "api", "claude-code", "aggregate", "claude-code.api.aggregate.normalized.json"), JSON.stringify({
      schema: "ax.normalized-result/v1",
      surface: "api",
      product: "supabase",
      harness: "claude-code",
      standard_set_version: "DAEB-1-v3",
      generated_at: "2026-07-05T00:00:00.000Z",
      tasks_total: 10,
      tasks_passed: 7,
      pass_at_1: 0.7,
      pass_at_k: 0.7,
      attempts: 1,
      discovery_score: 0.7,
      content_quality: 0.8,
      profiles: ["medium"],
      best_profile: "medium",
      model: "sonnet",
      latency_ms: 1300,
      tool_call_count: 6,
      token_usage: { input: 110, output: 40 },
      token_cost: 0.11,
      validity_status: "valid",
      first_action_latency_ms: 120,
      transcript_event_count: 13,
      action_occurred: true,
    }, null, 2));
    mkdirSync(resolve(runDir, "supabase", "cli", "codex", "aggregate"), { recursive: true });
    writeFileSync(resolve(runDir, "supabase", "cli", "codex", "aggregate", "codex.cli.aggregate.normalized.json"), JSON.stringify({
      schema: "ax.normalized-result/v1",
      surface: "cli",
      product: "supabase",
      harness: "codex",
      standard_set_version: "DAEB-1-v3",
      generated_at: "2026-07-05T00:00:00.000Z",
      tasks_total: 10,
      tasks_passed: 6,
      pass_at_1: 0.6,
      pass_at_k: 0.6,
      attempts: 1,
      discovery_score: 0.7,
      content_quality: 0.8,
      profiles: ["medium"],
      best_profile: "medium",
      model: "gpt-5.4",
      latency_ms: 1400,
      tool_call_count: 7,
      token_usage: { input: 120, output: 60 },
      token_cost: 0.14,
      validity_status: "valid",
      first_action_latency_ms: 140,
      transcript_event_count: 14,
      action_occurred: true,
    }, null, 2));
    mkdirSync(resolve(runDir, "supabase", "cli", "claude-code", "aggregate"), { recursive: true });
    writeFileSync(resolve(runDir, "supabase", "cli", "claude-code", "aggregate", "claude-code.cli.aggregate.normalized.json"), JSON.stringify({
      schema: "ax.normalized-result/v1",
      surface: "cli",
      product: "supabase",
      harness: "claude-code",
      standard_set_version: "DAEB-1-v3",
      generated_at: "2026-07-05T00:00:00.000Z",
      tasks_total: 10,
      tasks_passed: 5,
      pass_at_1: 0.5,
      pass_at_k: 0.5,
      attempts: 1,
      discovery_score: 0.6,
      content_quality: 0.8,
      profiles: ["medium"],
      best_profile: "medium",
      model: "sonnet",
      latency_ms: 1500,
      tool_call_count: 8,
      token_usage: { input: 130, output: 70 },
      token_cost: 0.15,
      validity_status: "valid",
      first_action_latency_ms: 160,
      transcript_event_count: 15,
      action_occurred: true,
    }, null, 2));
    mkdirSync(resolve(runDir, "supabase", "api", "codex", "trial-1"), { recursive: true });
    writeFileSync(resolve(runDir, "supabase", "api", "codex", "trial-1", "generated-eval.snapshot.json"), JSON.stringify({ runs: [] }, null, 2));
    writeFileSync(resolve(runDir, "supabase", "api", "codex", "trial-1", "generated-eval.html"), "<html><body>report</body></html>\n");
    writeFileSync(resolve(runDir, "competitive.html"), "<html><body>competitive</body></html>\n");

    const manifest = buildPublicationBundle({
      root: ROOT,
      suite,
      suitePath,
      vendors: ["supabase"],
      runDir,
      outDir,
      effortProfiles: ["medium"],
      requiredEffortProfiles: ["medium"],
    });

    expect(manifest.publication_readiness).toBe("publication_ready");
    expect(manifest.expected_matrix.effort_profiles).toEqual(["medium"]);
    expect(manifest.expected_matrix.required_effort_profiles).toEqual(["medium"]);
    expect(manifest.quality_gates.find((gate) => gate.id === "matrix-completeness")?.status).toBe("pass");
    expect(manifest.vendors[0].artifacts.normalized_records.every((path) => path.includes("aggregate"))).toBe(true);
  });

  it("ignores harness home directories when collecting publication artifacts", () => {
    const runDir = freshDir("ax-pub-ignore-home-run-");
    const outDir = freshDir("ax-pub-ignore-home-out-");
    const suitePath = "targets/suites/daeb-1-v3.yaml";
    const suite = loadSuite(resolve(ROOT, suitePath));
    const aggregateDir = resolve(runDir, "supabase", "api", "codex", "aggregate");
    const hiddenDir = resolve(runDir, "supabase", "api", "codex", "trial-1", ".invoke-home", "run-codex-medium-api");

    mkdirSync(aggregateDir, { recursive: true });
    mkdirSync(hiddenDir, { recursive: true });

    const baseRecord = {
      schema: "ax.normalized-result/v1",
      standard_set_version: "DAEB-1-v3",
      generated_at: "2026-07-05T00:00:00.000Z",
      tasks_total: 10,
      tasks_passed: 8,
      pass_at_1: 0.8,
      pass_at_k: 0.8,
      attempts: 1,
      discovery_score: 0.75,
      content_quality: 0.8,
      model: "gpt-5.4",
      latency_ms: 1200,
      tool_call_count: 5,
      token_usage: { input: 100, output: 50 },
      token_cost: 0.12,
      validity_status: "valid",
      first_action_latency_ms: 100,
      transcript_event_count: 12,
      action_occurred: true,
    };

    writeFileSync(resolve(aggregateDir, "codex.api.aggregate.normalized.json"), JSON.stringify({
      ...baseRecord,
      product: "supabase",
      harness: "codex",
      surface: "api",
      profiles: ["medium"],
      best_profile: "medium",
    }, null, 2));
    writeFileSync(resolve(hiddenDir, "codex.api.debug.normalized.json"), JSON.stringify({
      ...baseRecord,
      product: "supabase",
      harness: "codex",
      surface: "api",
      profiles: ["low"],
      best_profile: "low",
    }, null, 2));
    mkdirSync(resolve(runDir, "supabase", "api", "claude-code", "aggregate"), { recursive: true });
    writeFileSync(resolve(runDir, "supabase", "api", "claude-code", "aggregate", "claude-code.api.aggregate.normalized.json"), JSON.stringify({
      ...baseRecord,
      product: "supabase",
      harness: "claude-code",
      surface: "api",
      profiles: ["medium"],
      best_profile: "medium",
      model: "sonnet",
    }, null, 2));
    mkdirSync(resolve(runDir, "supabase", "cli", "codex", "aggregate"), { recursive: true });
    writeFileSync(resolve(runDir, "supabase", "cli", "codex", "aggregate", "codex.cli.aggregate.normalized.json"), JSON.stringify({
      ...baseRecord,
      product: "supabase",
      harness: "codex",
      surface: "cli",
      profiles: ["medium"],
      best_profile: "medium",
    }, null, 2));
    mkdirSync(resolve(runDir, "supabase", "cli", "claude-code", "aggregate"), { recursive: true });
    writeFileSync(resolve(runDir, "supabase", "cli", "claude-code", "aggregate", "claude-code.cli.aggregate.normalized.json"), JSON.stringify({
      ...baseRecord,
      product: "supabase",
      harness: "claude-code",
      surface: "cli",
      profiles: ["medium"],
      best_profile: "medium",
      model: "sonnet",
    }, null, 2));
    mkdirSync(resolve(runDir, "supabase", "api", "codex", "trial-1"), { recursive: true });
    writeFileSync(resolve(runDir, "supabase", "api", "codex", "trial-1", "generated-eval.snapshot.json"), JSON.stringify({ runs: [] }, null, 2));
    writeFileSync(resolve(runDir, "supabase", "api", "codex", "trial-1", "generated-eval.html"), "<html><body>report</body></html>\n");
    writeFileSync(resolve(runDir, "competitive.html"), "<html><body>competitive</body></html>\n");

    const manifest = buildPublicationBundle({
      root: ROOT,
      suite,
      suitePath,
      vendors: ["supabase"],
      runDir,
      outDir,
      effortProfiles: ["medium"],
      requiredEffortProfiles: ["medium"],
    });

    expect(manifest.publication_readiness).toBe("publication_ready");
    expect(manifest.vendors[0].artifacts.normalized_records.some((record) => record.includes(".invoke-home"))).toBe(false);
  });
});
