import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EvaluationCellSchema,
  NormalizedCellRecordSchema,
  TargetPackSchema,
} from "ax-eval";
import {
  buildBatchCompletion,
  resolveBatchIdentity,
  writeBatchCompletion,
} from "../src/controller/batch.js";
import type { ArenaCellExecution } from "../src/controller/cell.js";
import {
  ArenaCellCleanupSchema,
  type ArenaBatchConfiguration,
  type ArenaBatchManifest,
} from "../src/controller/schemas.js";

function configuration(): ArenaBatchConfiguration {
  return {
    command: "daeb-low-pass",
    suite: { name: "DAEB-1", version: 1, file_hash: "1".repeat(64) },
    packs: [{
      vendor: "neon",
      file_hash: "2".repeat(64),
      surfaces: ["api"],
      standard_set_version: "database-v1",
      host_credential_names: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
      verification_credential_names: ["DATABASE_URL"],
      reset_credential_names: ["DATABASE_URL"],
      sandbox_scope_names: [],
    }],
    cells: [
      {
        key: "neon/api/codex/trial-1",
        vendor: "neon",
        surface: "api",
        harness: "codex",
        profile: "medium",
        effort: "medium",
        model: "model-codex",
        trial: 1,
        host_credential_names: ["OPENAI_API_KEY"],
        verification_credential_names: ["DATABASE_URL"],
        reset_credential_names: ["DATABASE_URL"],
        sandbox_scope_names: [],
      },
      {
        key: "neon/api/claude-code/trial-1",
        vendor: "neon",
        surface: "api",
        harness: "claude-code",
        profile: "medium",
        effort: "medium",
        model: "model-claude",
        trial: 1,
        host_credential_names: ["ANTHROPIC_API_KEY"],
        verification_credential_names: ["DATABASE_URL"],
        reset_credential_names: ["DATABASE_URL"],
        sandbox_scope_names: [],
      },
    ],
    harnesses: [
      { harness: "codex", version_raw: "codex 1.2.3", version_semver: "1.2.3" },
      { harness: "claude-code", version_raw: "claude-code 1.2.3", version_semver: "1.2.3" },
    ],
    reset_required: true,
    invoke_timeout_seconds: 900,
    first_action_timeout_seconds: 180,
    invoke_retries: 0,
  };
}

function tursoConfiguration(root: string): { configuration: ArenaBatchConfiguration; binary: string } {
  const installRoot = resolve(root, "tools");
  const binary = resolve(installRoot, "turso");
  mkdirSync(installRoot, { recursive: true });
  writeFileSync(binary, "pinned-turso-binary");
  const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
  const base = configuration();
  return {
    binary,
    configuration: {
      ...base,
      packs: [{
        ...base.packs[0]!,
        vendor: "turso",
        surfaces: ["cli"],
      }],
      cells: base.cells.map((cell) => ({
        ...cell,
        key: `turso/cli/${cell.harness}/trial-1`,
        vendor: "turso",
        surface: "cli" as const,
      })),
      turso_cli: { install_root: installRoot, version: "0.100.0", sha256 },
    },
  };
}

function execution(
  root: string,
  batch: ArenaBatchManifest,
  harness: "codex" | "claude-code",
  model: string,
  overrides: { actualModel?: string; version?: string; cleanup?: "confirmed" | "skipped" } = {},
): ArenaCellExecution {
  const configured = batch.configuration.cells.find((cell) => cell.harness === harness)!;
  const configuredPack = batch.configuration.packs.find((pack) => pack.vendor === configured.vendor)!;
  const directory = resolve(root, configured.vendor, configured.surface, harness, "trial-1");
  mkdirSync(resolve(directory, "artifacts"), { recursive: true });
  const recordPath = resolve(directory, "record.json");
  const cleanupPath = resolve(directory, "cleanup.json");
  const pack = TargetPackSchema.parse({
    name: configured.vendor,
    standard_set_version: configuredPack.standard_set_version,
    auth: { type: "none" },
    tasks: [],
  });
  const cell = EvaluationCellSchema.parse({
    schema: "ax.evaluation-cell/v1",
    cell_id: `cell-${harness}`,
    batch_id: batch.batch_id,
    evaluation_set_id: batch.configuration.suite.name,
    evaluation_set_version: configuredPack.standard_set_version,
    target_id: configured.vendor,
    pack: { path: "pack.yaml", content_hash: configuredPack.file_hash },
    surface: configured.surface,
    harness: { id: harness, profile: configured.profile, model, effort: configured.effort },
    trial: configured.trial,
    source_commit_sha: batch.source_commit_sha,
    required_credentials: configured.host_credential_names,
    run_context: {
      cwd: directory,
      artifact_dir: "artifacts",
      invoke_timeout_ms: batch.configuration.invoke_timeout_seconds * 1_000,
      first_action_timeout_ms: batch.configuration.first_action_timeout_seconds * 1_000,
      invoke_retries: batch.configuration.invoke_retries,
    },
  });
  const version = overrides.version ?? "1.2.3";
  const record = NormalizedCellRecordSchema.parse({
    schema: "ax.normalized-cell-record/v1",
    surface: configured.surface,
    product: configured.vendor,
    harness,
    standard_set_version: configuredPack.standard_set_version,
    generated_at: "2026-07-21T00:00:00.000Z",
    tasks_total: 0,
    tasks_passed: 0,
    pass_at_1: 0,
    pass_at_k: 0,
    attempts: 1,
    discovery_score: null,
    content_quality: null,
    profiles: [configured.profile],
    best_profile: configured.profile,
    model: overrides.actualModel ?? model,
    harness_version_raw: `${harness} ${version}`,
    harness_version_semver: version,
    run_batch_id: batch.batch_id,
    latency_ms: 1,
    total_duration_ms: 1,
    tool_call_count: 0,
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
    evaluation_set_id: batch.configuration.suite.name,
    evaluation_set_version: configuredPack.standard_set_version,
    pack_content_hash: configuredPack.file_hash,
    source_commit_sha: batch.source_commit_sha,
    execution_namespace: `ns-${harness}`,
    target_id: configured.vendor,
    trial: configured.trial,
    effort: configured.effort,
    requested_model: model,
    started_at: "2026-07-21T00:00:00.000Z",
    completed_at: "2026-07-21T00:00:01.000Z",
    status: "completed",
    error: null,
    ...(configured.vendor === "turso" && configured.surface === "cli"
      ? { provider_provenance: [{ kind: "provisioning", id: "ax-arena-turso-cli", version: "1.0.0" }] }
      : {}),
    task_results: [],
    artifacts: {
      base_dir: resolve(directory, "artifacts"),
      results: "results.json",
      trace: "trace.json",
      transcript: "transcript.jsonl",
      invoke_metadata: "invoke.json",
    },
  });
  const recordBytes = `${JSON.stringify(record, null, 2)}\n`;
  const recordSha256 = createHash("sha256").update(recordBytes).digest("hex");
  const cleanup = ArenaCellCleanupSchema.parse(overrides.cleanup === "skipped" ? {
    schema: "ax.arena-cell-cleanup/v1",
    cell_id: cell.cell_id,
    record_path: recordPath,
    record_sha256: recordSha256,
    generated_at: "2026-07-21T00:00:02.000Z",
    status: "skipped",
    namespace: `ns-${harness}`,
    message: "skip-reset requested",
    errors: [],
  } : {
    schema: "ax.arena-cell-cleanup/v1",
    cell_id: cell.cell_id,
    record_path: recordPath,
    record_sha256: recordSha256,
    generated_at: "2026-07-21T00:00:02.000Z",
    status: "confirmed",
    provider: { id: "reset", version: "1.0.0" },
    namespace: `ns-${harness}`,
    plan: { summary: "one", resources: [`resource:ns-${harness}`] },
    evidence: {
      supported: true,
      message: "deleted",
      deleted: [`resource:ns-${harness}`],
      errors: [],
    },
    message: "deleted",
    errors: [],
  });
  writeFileSync(recordPath, recordBytes);
  writeFileSync(cleanupPath, `${JSON.stringify(cleanup, null, 2)}\n`);
  if (configured.vendor === "turso" && configured.surface === "cli") {
    const pin = batch.configuration.turso_cli!;
    writeFileSync(resolve(directory, "artifacts", "invoke.json"), JSON.stringify({
      provisioning: {
        extension_provider: { id: "ax-arena-turso-cli", version: "1.0.0" },
        extension_metadata: {
          cli_binary: resolve(pin.install_root, "turso"),
          cli_version: pin.version,
          cli_sha256: pin.sha256,
        },
      },
    }));
  }
  return {
    cell,
    pack,
    credentialNames: {
      host: [...configured.host_credential_names],
      verification: [...configured.verification_credential_names],
      reset: [...configured.reset_credential_names],
    },
    record,
    recordPath,
    cleanup,
    cleanupPath,
  };
}

describe("arena batch comparability", () => {
  it("persists one batch identity and rejects source or configuration drift", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-batch-"));
    const config = configuration();
    const first = resolveBatchIdentity(root, "a".repeat(40), new Date("2026-07-21T01:02:03.000Z"), config);
    const resumed = resolveBatchIdentity(root, "a".repeat(40), new Date("2026-07-22T01:02:03.000Z"), config);

    expect(resumed).toEqual(first);
    expect(first.batch_id).toContain("20260721010203");
    expect(first.batch_id).not.toBe(resolveBatchIdentity(
      mkdtempSync(resolve(tmpdir(), "ax-arena-batch-")),
      "a".repeat(40),
      new Date("2026-07-21T01:02:03.000Z"),
      config,
    ).batch_id);
    expect(() => resolveBatchIdentity(root, "b".repeat(40), new Date(), config)).toThrow(/source SHA mismatch/);
    expect(() => resolveBatchIdentity(root, "a".repeat(40), new Date(), {
      ...config,
      cells: [{ ...config.cells[0]!, model: "different-model" }, config.cells[1]!],
    })).toThrow(/configuration mismatch/);
    expect(resolveBatchIdentity(
      mkdtempSync(resolve(tmpdir(), "ax-arena-batch-sha256-")),
      "b".repeat(64),
      new Date(),
      config,
    ).source_commit_sha).toBe("b".repeat(64));
    expect(() => resolveBatchIdentity(mkdtempSync(resolve(tmpdir(), "ax-arena-empty-")), "a".repeat(40), new Date(), {
      ...config,
      packs: [],
      cells: [],
      harnesses: [],
    })).toThrow();
    expect(() => resolveBatchIdentity(mkdtempSync(resolve(tmpdir(), "ax-arena-env-name-")), "a".repeat(40), new Date(), {
      ...config,
      packs: [{ ...config.packs[0]!, host_credential_names: ["A\0B"] }],
      cells: config.cells.map((cell) => ({ ...cell, host_credential_names: ["A", "B"] })),
    })).toThrow();
  });

  it("rejects forged, inconsistent, or symlinked manifests", () => {
    for (const mode of ["hash", "expected", "format", "symlink", "dangling-symlink"] as const) {
      const root = mkdtempSync(resolve(tmpdir(), `ax-arena-batch-forged-${mode}-`));
      const config = configuration();
      resolveBatchIdentity(root, "a".repeat(40), new Date("2026-07-21T01:02:03.000Z"), config);
      const path = resolve(root, "batch.json");
      const forged = JSON.parse(readFileSync(path, "utf8"));
      if (mode === "hash") {
        forged.configuration.suite.name = "forged-suite";
        writeFileSync(path, `${JSON.stringify(forged, null, 2)}\n`);
      } else if (mode === "expected") {
        forged.expected_cells = ["forged/cell"];
        writeFileSync(path, `${JSON.stringify(forged, null, 2)}\n`);
      } else if (mode === "format") {
        writeFileSync(path, `${JSON.stringify(forged, null, 2)}\n\n`);
      } else {
        const outside = resolve(root, "outside.json");
        if (mode === "symlink") writeFileSync(outside, JSON.stringify(forged));
        rmSync(path);
        symlinkSync(outside, path);
      }
      expect(() => resolveBatchIdentity(root, "a".repeat(40), new Date(), config))
        .toThrow(/configuration hash mismatch|valid immutable arena batch manifest|canonical immutable|regular file/);
    }
  });

  it("accepts only the exact comparable cell set", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-batch-completion-"));
    const batch = resolveBatchIdentity(root, "a".repeat(40), new Date(), configuration());
    const executions = [
      execution(root, batch, "codex", "model-codex"),
      execution(root, batch, "claude-code", "model-claude"),
    ];
    expect(buildBatchCompletion(root, batch, executions, new Date()).cells).toHaveLength(2);
    expect(() => buildBatchCompletion(root, batch, executions.slice(0, 1), new Date())).toThrow(/incomplete or non-comparable/);
    expect(() => buildBatchCompletion(root, batch, [executions[0]!, executions[0]!], new Date())).toThrow(/incomplete or non-comparable/);

    const modelRoot = mkdtempSync(resolve(tmpdir(), "ax-arena-batch-model-"));
    const modelBatch = resolveBatchIdentity(modelRoot, "a".repeat(40), new Date(), configuration());
    const modelExecutions = [
      execution(modelRoot, modelBatch, "codex", "model-codex", { actualModel: "drifted-model" }),
      execution(modelRoot, modelBatch, "claude-code", "model-claude"),
    ];
    expect(() => buildBatchCompletion(modelRoot, modelBatch, modelExecutions, new Date()))
      .toThrow(/non-comparable.*requested_model/s);

    const versionRoot = mkdtempSync(resolve(tmpdir(), "ax-arena-batch-version-"));
    const versionBatch = resolveBatchIdentity(versionRoot, "a".repeat(40), new Date(), configuration());
    const versionExecutions = [
      execution(versionRoot, versionBatch, "codex", "model-codex", { version: "9.9.9" }),
      execution(versionRoot, versionBatch, "claude-code", "model-claude"),
    ];
    expect(() => buildBatchCompletion(versionRoot, versionBatch, versionExecutions, new Date()))
      .toThrow(/configured harness, model, and version pin/);

    const cleanupRoot = mkdtempSync(resolve(tmpdir(), "ax-arena-batch-cleanup-"));
    const cleanupBatch = resolveBatchIdentity(cleanupRoot, "a".repeat(40), new Date(), configuration());
    const cleanupExecutions = [
      execution(cleanupRoot, cleanupBatch, "codex", "model-codex", { cleanup: "skipped" }),
      execution(cleanupRoot, cleanupBatch, "claude-code", "model-claude"),
    ];
    expect(() => buildBatchCompletion(cleanupRoot, cleanupBatch, cleanupExecutions, new Date()))
      .toThrow(/non-comparable.*cleanup/s);
  });

  it("derives hashes from regular persisted sidecars and rejects identity or path forgery", () => {
    for (const mode of ["record", "credential", "timeout", "namespace", "bytes", "missing", "symlink"] as const) {
      const root = mkdtempSync(resolve(tmpdir(), `ax-arena-batch-sidecar-${mode}-`));
      const batch = resolveBatchIdentity(root, "a".repeat(40), new Date(), configuration());
      const codex = execution(root, batch, "codex", "model-codex");
      const claude = execution(root, batch, "claude-code", "model-claude");
      if (mode === "record") {
        codex.record.record_id = "forged-record";
        writeFileSync(codex.recordPath, `${JSON.stringify(codex.record, null, 2)}\n`);
      } else if (mode === "credential") {
        codex.credentialNames.host = ["EXTRA_TOKEN"];
        codex.cell.required_credentials = ["EXTRA_TOKEN"];
      } else if (mode === "timeout") {
        codex.cell.run_context.invoke_retries = 1;
      } else if (mode === "namespace") {
        codex.cleanup.namespace = "different-ns";
        writeFileSync(codex.cleanupPath, `${JSON.stringify(codex.cleanup, null, 2)}\n`);
      } else if (mode === "bytes") {
        writeFileSync(codex.recordPath, `${JSON.stringify(codex.record, null, 2)}\n\n`);
      } else if (mode === "missing") {
        rmSync(codex.recordPath);
      } else {
        const outside = resolve(root, "outside-record.json");
        writeFileSync(outside, readFileSync(codex.recordPath));
        rmSync(codex.recordPath);
        symlinkSync(outside, codex.recordPath);
      }
      expect(() => buildBatchCompletion(root, batch, [codex, claude], new Date())).toThrow();
    }
  });

  it("requires and re-attests the pinned Turso CLI binary", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-batch-turso-"));
    const fixture = tursoConfiguration(root);
    expect(() => resolveBatchIdentity(root, "a".repeat(40), new Date(), {
      ...fixture.configuration,
      turso_cli: undefined,
    })).toThrow(/Turso CLI pin/);
    const runRoot = resolve(root, "run");
    const batch = resolveBatchIdentity(runRoot, "a".repeat(40), new Date(), fixture.configuration);
    const executions = [
      execution(runRoot, batch, "codex", "model-codex"),
      execution(runRoot, batch, "claude-code", "model-claude"),
    ];
    expect(buildBatchCompletion(runRoot, batch, executions, new Date()).cells).toHaveLength(2);
    writeFileSync(fixture.binary, "tampered-binary");
    expect(() => buildBatchCompletion(runRoot, batch, executions, new Date())).toThrow(/SHA-256 pin/);
  });

  it("writes completion once and refuses manifest tampering or overwrite", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-batch-write-"));
    const batch = resolveBatchIdentity(root, "a".repeat(40), new Date(), configuration());
    const executions = [
      execution(root, batch, "codex", "model-codex"),
      execution(root, batch, "claude-code", "model-claude"),
    ];
    expect(writeBatchCompletion(root, batch, executions, new Date()).batch_id).toBe(batch.batch_id);
    expect(() => writeBatchCompletion(root, batch, executions, new Date())).toThrow(/EEXIST|exist/i);

    const manifestPath = resolve(root, "batch.json");
    writeFileSync(manifestPath, `${JSON.stringify({ ...batch, batch_id: "tampered" }, null, 2)}\n`);
    expect(() => writeBatchCompletion(root, batch, executions, new Date())).toThrow(/manifest changed/);
  });
});
