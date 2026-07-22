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

function fixture(options: { codexTranscript?: string; codexTrace?: unknown } = {}) {
  const runRoot = mkdtempSync(resolve(tmpdir(), "ax-arena-reporting-"));
  const packPath = resolve(runRoot, "canonical-pack.yaml");
  const pack = TargetPackSchema.parse({
    name: "neon",
    standard_set_version: "database-v1",
    auth: { type: "none" },
    base_url: "https://api.example.test",
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
      host_credential_names: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
      verification_credential_names: [],
      reset_credential_names: [],
      sandbox_scope_names: [],
    }],
    cells: (["codex", "claude-code"] as const).map((harness) => ({
      key: `neon/api/${harness}/trial-1`,
      vendor: "neon",
      surface: "api" as const,
      harness,
      profile: "medium" as const,
      effort: "medium" as const,
      model: harness === "codex" ? "model-codex" : "model-claude",
      trial: 1,
      host_credential_names: [harness === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"],
      verification_credential_names: [],
      reset_credential_names: [],
      sandbox_scope_names: [],
      provider_pins: [],
      reset_provider: { id: "reset", version: "1.0.0" },
    })),
    harnesses: [
      { harness: "codex", version_raw: "codex 1.2.3", version_semver: "1.2.3" },
      { harness: "claude-code", version_raw: "claude-code 1.2.3", version_semver: "1.2.3" },
    ],
    reset_required: true,
    invoke_timeout_seconds: 900,
    first_action_timeout_seconds: 180,
    invoke_retries: 0,
  };
  const batch = resolveBatchIdentity(runRoot, "a".repeat(40), new Date("2026-07-21T00:00:00.000Z"), configuration);
  const executions = (["codex", "claude-code"] as const).map((harnessId) => {
    const model = harnessId === "codex" ? "model-codex" : "model-claude";
    const credential = harnessId === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    const namespace = `cell-${harnessId}`;
    const directory = resolve(runRoot, "neon", "api", harnessId, "trial-1");
    const artifacts = resolve(directory, "artifacts");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(resolve(artifacts, "results.json"), JSON.stringify({ ns: namespace, results: {} }));
    writeFileSync(resolve(artifacts, "trace.json"), JSON.stringify(harnessId === "codex" && options.codexTrace
      ? options.codexTrace
      : [{ step: 1, taskId: "discovery", action: "GET", method: "GET", path: "/" }]));
    writeFileSync(resolve(artifacts, "transcript.jsonl"), harnessId === "codex" ? options.codexTranscript ?? "" : "");
    writeFileSync(resolve(artifacts, "invoke.json"), "{}");
    const recordPath = resolve(directory, "record.json");
    const cleanupPath = resolve(directory, "cleanup.json");
    const cellId = arenaCellId({
      batchId: batch.batch_id,
      evaluationSetId: "DAEB-1",
      targetId: "neon",
      surface: "api",
      harness: harnessId,
      profile: "medium",
      model,
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
      harness: { id: harnessId, profile: "medium", model, effort: "medium" },
      trial: 1,
      source_commit_sha: batch.source_commit_sha,
      required_credentials: [credential],
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
      harness: harnessId,
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
      model,
      harness_version_raw: `${harnessId} 1.2.3`,
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
      execution_namespace: namespace,
      target_id: "neon",
      trial: 1,
      effort: "medium",
      requested_model: model,
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
    const recordBytes = `${JSON.stringify(record, null, 2)}\n`;
    const cleanup = ArenaCellCleanupSchema.parse({
      schema: "ax.arena-cell-cleanup/v1",
      cell_id: cell.cell_id,
      record_path: recordPath,
      record_sha256: createHash("sha256").update(recordBytes).digest("hex"),
      generated_at: "2026-07-21T00:00:02.000Z",
      status: "confirmed",
      provider: { id: "reset", version: "1.0.0" },
      namespace,
      plan: { summary: "one", resources: [`resource:${namespace}`] },
      evidence: { supported: true, message: "deleted", deleted: [`resource:${namespace}`], errors: [] },
      message: "deleted",
      errors: [],
    });
    writeFileSync(recordPath, recordBytes);
    writeFileSync(cleanupPath, `${JSON.stringify(cleanup, null, 2)}\n`);
    return {
      cell,
      pack,
      credentialNames: { host: [credential], verification: [], reset: [] },
      record,
      recordPath,
      cleanup,
      cleanupPath,
    };
  });
  writeBatchCompletion(runRoot, batch, executions, new Date("2026-07-21T00:00:03.000Z"));
  const codex = executions[0]!;
  const artifacts = codex.record.artifacts.base_dir;
  const recordPath = codex.recordPath;
  const cleanupPath = codex.cleanupPath;
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
  return {
    runRoot,
    recordPath,
    cleanupPath,
    tracePath: resolve(artifacts, "trace.json"),
    transcriptPath: resolve(artifacts, "transcript.jsonl"),
    completionPath: resolve(runRoot, "batch-completion.json"),
    run,
  };
}

describe("arena runtime reporting", () => {
  it("writes contained reports and aggregates from a completed batch", () => {
    const test = fixture();
    const report = test.run();
    expect(report.surface_reports).toHaveLength(1);
    expect(report.aggregates).toHaveLength(2);
    expect(report.surface_reports[0]!.snapshot_path).toBe("neon/api/reporting/generated-eval.snapshot.json");
    expect(JSON.parse(readFileSync(resolve(test.runRoot, "runtime-reporting.json"), "utf8"))).toEqual(report);
    const html = readFileSync(resolve(test.runRoot, report.surface_reports[0]!.html_path), "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("2026-07-21T00:00:04.000Z");
    expect(readFileSync(resolve(test.runRoot, report.surface_reports[0]!.failure_review_path), "utf8"))
      .toContain("failed_tasks: none");
    const snapshot = JSON.parse(readFileSync(resolve(test.runRoot, report.surface_reports[0]!.snapshot_path), "utf8"));
    expect(snapshot.runs.every((run: { evidence: { results: string[] } }) =>
      !run.evidence.results[0]!.startsWith("/"))).toBe(true);
  });

  it.each([
    ["Codex", JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "curl -X POST https://api.example.test/native" },
    })],
    ["Claude Code", JSON.stringify({
      message: {
        content: [{
          type: "tool_use",
          name: "Bash",
          input: { command: "curl -X POST https://api.example.test/native" },
        }],
      },
    })],
  ])("derives process evidence from the native %s transcript", (_harness, event) => {
    const test = fixture({
      codexTrace: [{ step: 1, taskId: "forged", action: "GET", method: "GET", path: "/model-authored" }],
      codexTranscript: `${event}\n`,
    });

    const report = test.run();
    const snapshot = JSON.parse(readFileSync(
      resolve(test.runRoot, report.surface_reports[0]!.snapshot_path),
      "utf8",
    ));
    const run = snapshot.runs.find((candidate: { harness: string }) => candidate.harness === "codex");
    expect(run.trace).toEqual([expect.objectContaining({
      method: "POST",
      path: "/native",
    })]);
    expect(JSON.stringify(run.trace)).not.toContain("model-authored");
  });

  it("rejects post-completion record drift", () => {
    const test = fixture();
    writeFileSync(test.recordPath, `${readFileSync(test.recordPath, "utf8")}\n`);
    expect(test.run).toThrow(/sidecar hash drifted/);
  });

  it("rejects post-completion native transcript drift", () => {
    const test = fixture();
    writeFileSync(test.transcriptPath, JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", command: "curl -X POST https://api.example.test/forged" },
    }));
    expect(test.run).toThrow(/transcript artifact hash drifted/);
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
    const cleanup = JSON.parse(readFileSync(test.cleanupPath, "utf8"));
    cleanup.record_sha256 = createHash("sha256").update(bytes).digest("hex");
    const cleanupBytes = `${JSON.stringify(cleanup, null, 2)}\n`;
    writeFileSync(test.cleanupPath, cleanupBytes);
    const completion = JSON.parse(readFileSync(test.completionPath, "utf8"));
    const cell = completion.cells.find((candidate: { key: string }) => candidate.key.includes("/codex/"));
    cell.record_hash = createHash("sha256").update(bytes).digest("hex");
    cell.cleanup_hash = createHash("sha256").update(cleanupBytes).digest("hex");
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
    cleanup.record_sha256 = createHash("sha256").update(recordBytes).digest("hex");
    const cleanupBytes = `${JSON.stringify(cleanup, null, 2)}\n`;
    writeFileSync(test.recordPath, recordBytes);
    writeFileSync(test.cleanupPath, cleanupBytes);
    const completion = JSON.parse(readFileSync(test.completionPath, "utf8"));
    const cell = completion.cells.find((candidate: { key: string }) => candidate.key.includes("/codex/"));
    cell.record_hash = createHash("sha256").update(recordBytes).digest("hex");
    cell.cleanup_hash = createHash("sha256").update(cleanupBytes).digest("hex");
    writeFileSync(test.completionPath, `${JSON.stringify(completion, null, 2)}\n`);
    expect(test.run).toThrow(/sidecars do not match completion cell/);
  });

  it("rejects cleanup evidence bound to different record bytes", () => {
    const test = fixture();
    const cleanup = JSON.parse(readFileSync(test.cleanupPath, "utf8"));
    cleanup.record_sha256 = "f".repeat(64);
    const cleanupBytes = `${JSON.stringify(cleanup, null, 2)}\n`;
    writeFileSync(test.cleanupPath, cleanupBytes);
    const completion = JSON.parse(readFileSync(test.completionPath, "utf8"));
    const cell = completion.cells.find((candidate: { key: string }) => candidate.key.includes("/codex/"));
    cell.cleanup_hash = createHash("sha256").update(cleanupBytes).digest("hex");
    writeFileSync(test.completionPath, `${JSON.stringify(completion, null, 2)}\n`);
    expect(test.run).toThrow(/sidecars do not match completion cell/);
  });
});
