import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { describe, expect, it } from "vitest";
import {
  EvaluationCellSchema,
  NormalizedCellRecordSchema,
  TargetPackSchema,
  packFileContentHash,
  type HarnessProbe,
} from "ax-eval";
import { resolveBatchIdentity, writeBatchCompletion } from "../src/controller/batch.js";
import { arenaCellId } from "../src/controller/cell.js";
import { writeRuntimeReportingBundle } from "../src/controller/reporting.js";
import { ArenaCellCleanupSchema, type ArenaBatchConfiguration } from "../src/controller/schemas.js";

function fixture() {
  const runRoot = mkdtempSync(resolve(tmpdir(), "ax-arena-reporting-"));
  const packPath = resolve(runRoot, "canonical-pack.yaml");
  const pack = TargetPackSchema.parse({
    name: "neon",
    standard_set_version: "database-v1",
    auth: { type: "none" },
    tasks: [],
  });
  writeFileSync(packPath, yamlStringify(pack));
  const configuration: ArenaBatchConfiguration = {
    command: "daeb-low-pass",
    suite: { name: "DAEB-1", version: 1, file_hash: "1".repeat(64) },
    packs: [{
      vendor: "neon",
      file_hash: packFileContentHash(packPath),
      standard_set_version: "database-v1",
      surfaces: ["api"],
      host_credential_names: ["OPENAI_API_KEY"],
      verification_credential_names: [],
      reset_credential_names: [],
      sandbox_scope_names: [],
    }],
    cells: [{
      key: "neon/api/codex/trial-1",
      vendor: "neon",
      surface: "api",
      harness: "codex",
      profile: "medium",
      effort: "medium",
      model: "model-codex",
      trial: 1,
      host_credential_names: ["OPENAI_API_KEY"],
      verification_credential_names: [],
      reset_credential_names: [],
      sandbox_scope_names: [],
    }],
    harnesses: [{ harness: "codex", version_raw: "codex 1.2.3", version_semver: "1.2.3" }],
    reset_required: true,
    invoke_timeout_seconds: 900,
    first_action_timeout_seconds: 180,
    invoke_retries: 0,
  };
  const batch = resolveBatchIdentity(runRoot, "a".repeat(40), new Date("2026-07-21T00:00:00.000Z"), configuration);
  const directory = resolve(runRoot, "neon", "api", "codex", "trial-1");
  const artifacts = resolve(directory, "artifacts");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(resolve(artifacts, "results.json"), JSON.stringify({ ns: "cell-ns", results: {} }));
  writeFileSync(resolve(artifacts, "trace.json"), JSON.stringify([
    { step: 1, taskId: "discovery", action: "GET", method: "GET", path: "/" },
  ]));
  writeFileSync(resolve(artifacts, "transcript.jsonl"), "");
  writeFileSync(resolve(artifacts, "invoke.json"), "{}");
  const recordPath = resolve(directory, "record.json");
  const cleanupPath = resolve(directory, "cleanup.json");
  const cellId = arenaCellId({
    batchId: batch.batch_id,
    evaluationSetId: "DAEB-1",
    targetId: "neon",
    surface: "api",
    harness: "codex",
    profile: "medium",
    model: "model-codex",
    effort: "medium",
    trial: 1,
    sourceCommitSha: batch.source_commit_sha,
  }, configuration.packs[0]!.file_hash);
  const cell = EvaluationCellSchema.parse({
    schema: "ax.evaluation-cell/v1",
    cell_id: cellId,
    batch_id: batch.batch_id,
    evaluation_set_id: "DAEB-1",
    evaluation_set_version: "database-v1",
    target_id: "neon",
    pack: { path: "pack.yaml", content_hash: configuration.packs[0]!.file_hash },
    surface: "api",
    harness: { id: "codex", profile: "medium", model: "model-codex", effort: "medium" },
    trial: 1,
    source_commit_sha: batch.source_commit_sha,
    required_credentials: ["OPENAI_API_KEY"],
    run_context: {
      cwd: directory,
      artifact_dir: "artifacts",
      invoke_timeout_ms: 900_000,
      first_action_timeout_ms: 180_000,
      invoke_retries: 0,
    },
  });
  const record = NormalizedCellRecordSchema.parse({
    schema: "ax.normalized-cell-record/v1",
    surface: "api",
    product: "neon",
    harness: "codex",
    standard_set_version: "database-v1",
    generated_at: "2026-07-21T00:00:00.000Z",
    tasks_total: 0,
    tasks_passed: 0,
    pass_at_1: 0,
    pass_at_k: 0,
    attempts: 1,
    discovery_score: null,
    content_quality: null,
    profiles: ["medium"],
    best_profile: "medium",
    model: "model-codex",
    harness_version_raw: "codex 1.2.3",
    harness_version_semver: "1.2.3",
    run_batch_id: batch.batch_id,
    latency_ms: 1,
    total_duration_ms: 1,
    tool_call_count: 1,
    token_usage: null,
    token_cost: null,
    cost_usd: null,
    tokens_in: null,
    tokens_out: null,
    validity_status: "valid",
    first_action_latency_ms: 1,
    transcript_event_count: 1,
    action_occurred: true,
    summary_kind: "single",
    record_id: cell.cell_id,
    cell_id: cell.cell_id,
    batch_id: batch.batch_id,
    evaluation_set_id: "DAEB-1",
    evaluation_set_version: "database-v1",
    pack_content_hash: configuration.packs[0]!.file_hash,
    source_commit_sha: batch.source_commit_sha,
    execution_namespace: "cell-ns",
    target_id: "neon",
    trial: 1,
    effort: "medium",
    requested_model: "model-codex",
    started_at: "2026-07-21T00:00:00.000Z",
    completed_at: "2026-07-21T00:00:01.000Z",
    status: "completed",
    error: null,
    task_results: [],
    artifacts: {
      base_dir: artifacts,
      results: "results.json",
      trace: "trace.json",
      transcript: "transcript.jsonl",
      invoke_metadata: "invoke.json",
    },
  });
  const cleanup = ArenaCellCleanupSchema.parse({
    schema: "ax.arena-cell-cleanup/v1",
    cell_id: cell.cell_id,
    record_path: recordPath,
    generated_at: "2026-07-21T00:00:02.000Z",
    status: "confirmed",
    provider: { id: "reset", version: "1.0.0" },
    namespace: "cell-ns",
    plan: { summary: "one", resources: ["resource:cell-ns"] },
    evidence: { supported: true, message: "deleted", deleted: ["resource:cell-ns"], errors: [] },
    message: "deleted",
    errors: [],
  });
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(cleanupPath, `${JSON.stringify(cleanup, null, 2)}\n`);
  writeBatchCompletion(runRoot, batch, [{
    cell,
    pack,
    credentialNames: { host: ["OPENAI_API_KEY"], verification: [], reset: [] },
    record,
    recordPath,
    cleanup,
    cleanupPath,
  }], new Date("2026-07-21T00:00:03.000Z"));
  const harness: HarnessProbe = {
    host: "ci",
    hostLabel: "AXArena test",
    model: null,
    confidence: "high",
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    detectedAt: "2026-07-21T00:00:03.000Z",
    signals: ["CI"],
    suggestion: { profiles: ["medium"], matrix: false, reason: "test" },
  };
  const run = (minPassRate?: number) => writeRuntimeReportingBundle({
    runRoot,
    batch,
    packPaths: { neon: packPath },
    harness,
    now: new Date("2026-07-21T00:00:04.000Z"),
    ...(minPassRate === undefined ? {} : { minPassRate }),
  });
  return { runRoot, recordPath, cleanupPath, completionPath: resolve(runRoot, "batch-completion.json"), run };
}

describe("arena runtime reporting", () => {
  it("writes contained reports and aggregates from a completed batch", () => {
    const test = fixture();
    const report = test.run();
    expect(report.surface_reports).toHaveLength(1);
    expect(report.aggregates).toHaveLength(1);
    expect(report.surface_reports[0]!.snapshot_path).toBe("neon/api/reporting/generated-eval.snapshot.json");
    expect(JSON.parse(readFileSync(resolve(test.runRoot, "runtime-reporting.json"), "utf8"))).toEqual(report);
    const html = readFileSync(resolve(test.runRoot, report.surface_reports[0]!.html_path), "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("2026-07-21T00:00:04.000Z");
    expect(readFileSync(resolve(test.runRoot, report.surface_reports[0]!.failure_review_path), "utf8"))
      .toContain("failed_tasks: none");
    const snapshot = JSON.parse(readFileSync(resolve(test.runRoot, report.surface_reports[0]!.snapshot_path), "utf8"));
    expect(snapshot.runs[0].evidence.results[0]).not.toMatch(/^\//);
  });

  it("rejects post-completion record drift", () => {
    const test = fixture();
    writeFileSync(test.recordPath, `${readFileSync(test.recordPath, "utf8")}\n`);
    expect(test.run).toThrow(/sidecar hash drifted/);
  });

  it("refuses to overwrite an existing reporting bundle", () => {
    const test = fixture();
    test.run();
    expect(test.run).toThrow(/exist/i);
  });

  it("rejects invalid report gates before writing output", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
      const test = fixture();
      expect(() => test.run(value)).toThrow(/finite number from 0 to 1/);
      expect(existsSync(resolve(test.runRoot, "runtime-reporting.json"))).toBe(false);
    }
  });

  it("preflights every output before publishing any report", () => {
    const test = fixture();
    const collision = resolve(test.runRoot, "neon/api/codex/aggregate/trial-manifest.json");
    mkdirSync(resolve(collision, ".."), { recursive: true });
    writeFileSync(collision, "already exists\n");
    expect(test.run).toThrow(/refusing to overwrite/);
    expect(existsSync(resolve(test.runRoot, "neon/api/reporting/generated-eval.snapshot.json"))).toBe(false);
  });

  it("rejects a rehashed record that substitutes evidence outside its artifact directory", () => {
    const test = fixture();
    const record = JSON.parse(readFileSync(test.recordPath, "utf8"));
    record.artifacts.results = "../other-results.json";
    writeFileSync(resolve(record.artifacts.base_dir, "..", "other-results.json"), "{}");
    const bytes = `${JSON.stringify(record, null, 2)}\n`;
    writeFileSync(test.recordPath, bytes);
    const completion = JSON.parse(readFileSync(test.completionPath, "utf8"));
    completion.cells[0].record_hash = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(test.completionPath, `${JSON.stringify(completion, null, 2)}\n`);
    expect(test.run).toThrow(/direct relative file name/);
  });

  it("rejects rehashed record and cleanup sidecars with a substituted cell id", () => {
    const test = fixture();
    const record = JSON.parse(readFileSync(test.recordPath, "utf8"));
    const cleanup = JSON.parse(readFileSync(test.cleanupPath, "utf8"));
    record.cell_id = "forged-cell";
    cleanup.cell_id = "forged-cell";
    const recordBytes = `${JSON.stringify(record, null, 2)}\n`;
    const cleanupBytes = `${JSON.stringify(cleanup, null, 2)}\n`;
    writeFileSync(test.recordPath, recordBytes);
    writeFileSync(test.cleanupPath, cleanupBytes);
    const completion = JSON.parse(readFileSync(test.completionPath, "utf8"));
    completion.cells[0].record_hash = createHash("sha256").update(recordBytes).digest("hex");
    completion.cells[0].cleanup_hash = createHash("sha256").update(cleanupBytes).digest("hex");
    writeFileSync(test.completionPath, `${JSON.stringify(completion, null, 2)}\n`);
    expect(test.run).toThrow(/sidecars do not match completion cell/);
  });
});
