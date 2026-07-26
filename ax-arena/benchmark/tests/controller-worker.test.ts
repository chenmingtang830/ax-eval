import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  EvaluationCellSchema,
  NormalizedCellRecordSchema,
  TargetPackSchema,
} from "ax-eval";
import {
  buildBatchCompletion,
  resolveBatchIdentity,
  writeBatchPlan,
} from "../src/controller/batch.js";
import type { ArenaCellExecution } from "../src/controller/cell.js";
import {
  ArenaCellCleanupSchema,
  type ArenaBatchConfiguration,
  type ArenaBatchManifest,
  type ArenaBatchPlan,
} from "../src/controller/schemas.js";
import {
  arenaCellResultPath,
  ArenaCellResultSchema,
  arenaWorkerCredentialNames,
  buildBatchCompletionFromResults,
  deriveArenaCellSpec,
  executeArenaWorkerCell,
  loadArenaCellResult,
  selectArenaWorkerCell,
  writeArenaCellResult,
} from "../src/controller/worker.js";

interface Fixture {
  root: string;
  runRoot: string;
  packPath: string;
  batch: ArenaBatchManifest;
  plan: ArenaBatchPlan;
  executions: ArenaCellExecution[];
  resultPaths: string[];
}

function packBytes(vendor: string): string {
  return [
    `name: ${vendor}`,
    "standard_set_version: database-v1",
    "auth:",
    "  type: none",
    "sandbox_scope:",
    "  - name: sandbox_id",
    "    env: SANDBOX_ID",
    "    required: true",
    "tasks: []",
    "",
  ].join("\n");
}

function configuration(
  vendor: string,
  fileHash: string,
  harnesses: readonly ("codex" | "claude-code")[],
  resetRequired = true,
  pinnedLocal = false,
): ArenaBatchConfiguration {
  const hostNames = harnesses.map((harness) => harness === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
  return {
    command: "daeb-low-pass",
    execution: pinnedLocal
      ? { runtime_backend: "pinned-oci", trust_level: "local" }
      : { runtime_backend: "native", trust_level: "local" },
    ...(pinnedLocal ? { sandbox: {
      kind: "bubblewrap" as const,
      policy_version: "ax.arena-bubblewrap/v2",
      runtime_lock_sha256: "5".repeat(64),
      sysroot: "/opt/ax-arena-runtime/rootfs",
      executable: "/opt/ax-arena-tools/bubblewrap/usr/bin/bwrap",
      executable_sha256: "6".repeat(64),
      runtime_roots: ["/usr", "/opt/ax-arena-tools"],
    } } : {}),
    suite: { name: "DAEB-1", version: 1, file_hash: "1".repeat(64) },
    packs: [{
      vendor,
      file_hash: fileHash,
      surfaces: ["api"],
      standard_set_version: "database-v1",
      host_credential_names: [...hostNames, "SANDBOX_ID"],
      verification_credential_names: ["DATABASE_URL", "SANDBOX_ID"],
      reset_credential_names: ["DATABASE_URL"],
      sandbox_scope_names: ["SANDBOX_ID"],
    }],
    cells: harnesses.map((harness) => ({
      key: `${vendor}/api/${harness}/trial-1`,
      vendor,
      surface: "api" as const,
      harness,
      profile: "medium" as const,
      effort: "medium" as const,
      model: harness === "codex" ? "model-codex" : "model-claude",
      trial: 1,
      host_credential_names: [harness === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY", "SANDBOX_ID"],
      verification_credential_names: ["DATABASE_URL", "SANDBOX_ID"],
      reset_credential_names: ["DATABASE_URL"],
      sandbox_scope_names: ["SANDBOX_ID"],
      provider_pins: [],
      reset_provider: { id: "reset", version: "1.0.0" },
    })),
    harnesses: harnesses.map((harness) => ({
      harness,
      version_raw: `${harness} 1.2.3`,
      version_semver: "1.2.3",
    })),
    reset_required: resetRequired,
    invoke_timeout_seconds: 900,
    first_action_timeout_seconds: 180,
    invoke_retries: 0,
  };
}

function execution(root: string, batch: ArenaBatchManifest, harness: "codex" | "claude-code"): ArenaCellExecution {
  const configured = batch.configuration.cells.find((cell) => cell.harness === harness)!;
  const configuredPack = batch.configuration.packs[0]!;
  const directory = resolve(root, "cells", ...configured.key.split("/"));
  const workspace = resolve(directory, "workspace");
  mkdirSync(resolve(workspace, "artifacts"), { recursive: true });
  const recordPath = resolve(directory, "record.normalized.json");
  const cleanupPath = resolve(directory, "cleanup.json");
  const pack = TargetPackSchema.parse({
    name: configured.vendor,
    standard_set_version: configuredPack.standard_set_version,
    auth: { type: "none" },
    sandbox_scope: [{ name: "sandbox_id", env: "SANDBOX_ID", required: true }],
    tasks: [],
  });
  const cell = EvaluationCellSchema.parse({
    schema: "ax.evaluation-cell/v1",
    cell_id: `cell-${configured.vendor}-${harness}`,
    batch_id: batch.batch_id,
    evaluation_set_id: batch.configuration.suite.name,
    evaluation_set_version: configuredPack.standard_set_version,
    target_id: configured.vendor,
    pack: { path: "input/pack.yaml", content_hash: configuredPack.file_hash },
    surface: configured.surface,
    harness: {
      id: harness,
      profile: configured.profile,
      model: configured.model,
      effort: configured.effort,
    },
    trial: configured.trial,
    source_commit_sha: batch.source_commit_sha,
    required_credentials: configured.host_credential_names,
    run_context: {
      cwd: workspace,
      artifact_dir: "artifacts",
      invoke_timeout_ms: batch.configuration.invoke_timeout_seconds * 1_000,
      first_action_timeout_ms: batch.configuration.first_action_timeout_seconds * 1_000,
      invoke_retries: batch.configuration.invoke_retries,
    },
  });
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
    model: configured.model,
    harness_version_raw: `${harness} 1.2.3`,
    harness_version_semver: "1.2.3",
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
    requested_model: configured.model,
    started_at: "2026-07-21T00:00:00.000Z",
    completed_at: "2026-07-21T00:00:01.000Z",
    status: "completed",
    error: null,
    task_results: [],
    artifacts: {
      base_dir: resolve(workspace, "artifacts"),
      results: "results.json",
      trace: "trace.json",
      transcript: "transcript.jsonl",
      invoke_metadata: "invoke.json",
    },
  });
  const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
  for (const [name, value] of [
    ["results.json", "{}\n"],
    ["trace.json", "[]\n"],
    ["transcript.jsonl", '{"event":"completed"}\n'],
    ["invoke.json", '{"exit_code":0}\n'],
  ] as const) writeFileSync(resolve(workspace, "artifacts", name), value);
  const cleanup = ArenaCellCleanupSchema.parse({
    schema: "ax.arena-cell-cleanup/v1",
    cell_id: cell.cell_id,
    record_path: recordPath,
    record_sha256: createHash("sha256").update(recordBytes).digest("hex"),
    generated_at: "2026-07-21T00:00:02.000Z",
    status: batch.configuration.reset_required ? "confirmed" : "skipped",
    ...(batch.configuration.reset_required ? { provider: { id: "reset", version: "1.0.0" } } : {}),
    namespace: `ns-${harness}`,
    ...(batch.configuration.reset_required ? {
      plan: { summary: "one", resources: [`resource:ns-${harness}`] },
      evidence: {
        supported: true,
        message: "deleted",
        deleted: [`resource:ns-${harness}`],
        errors: [],
      },
    } : {}),
    message: batch.configuration.reset_required ? "deleted" : "skip-reset requested",
    errors: [],
  });
  writeFileSync(recordPath, recordBytes);
  writeFileSync(cleanupPath, `${JSON.stringify(cleanup, null, 2)}\n`);
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

function fixture(
  vendor = "neon",
  harnesses: readonly ("codex" | "claude-code")[] = ["codex", "claude-code"],
  root = mkdtempSync(resolve(tmpdir(), "ax-arena-worker-")),
  runRoot = resolve(root, "run"),
  resetRequired = true,
  pinnedLocal = false,
): Fixture {
  const packPath = resolve(root, "packs", vendor, "pack.yaml");
  mkdirSync(dirname(packPath), { recursive: true });
  writeFileSync(packPath, packBytes(vendor));
  const fileHash = createHash("sha256").update(readFileSync(packPath)).digest("hex");
  const batch = resolveBatchIdentity(
    runRoot,
    "a".repeat(40),
    new Date("2026-07-21T00:00:00.000Z"),
    configuration(vendor, fileHash, harnesses, resetRequired, pinnedLocal),
  );
  const plan = writeBatchPlan(runRoot, batch);
  const executions = harnesses.map((harness) => execution(runRoot, batch, harness));
  const resultPaths = executions.map((item, index) => {
    const descriptor = plan.cells[index]!;
    const path = arenaCellResultPath(runRoot, descriptor);
    writeArenaCellResult(
      runRoot,
      batch,
      descriptor,
      item,
      new Date("2026-07-21T00:00:03.000Z"),
      path,
      pinnedLocal ? "9".repeat(64) : null,
    );
    return path;
  });
  return { root, runRoot, packPath, batch, plan, executions, resultPaths };
}

describe("arena fan-out cell results", () => {
  it("derives one exact cell spec and exposes only that descriptor's credential names", () => {
    const value = fixture();
    execFileSync("git", ["init"], { cwd: value.root, stdio: "ignore" });
    const codex = selectArenaWorkerCell(value.plan, "neon/api/codex/trial-1");
    const claude = selectArenaWorkerCell(value.plan, "neon/api/claude-code/trial-1");
    expect(arenaWorkerCredentialNames(codex)).toEqual(["DATABASE_URL", "OPENAI_API_KEY", "SANDBOX_ID"]);
    expect(arenaWorkerCredentialNames(codex)).not.toContain("ANTHROPIC_API_KEY");
    expect(arenaWorkerCredentialNames(claude)).not.toContain("OPENAI_API_KEY");
    expect(arenaWorkerCredentialNames(codex)).toContain("SANDBOX_ID");

    const spec = deriveArenaCellSpec(value.batch, codex, value.runRoot, value.packPath);
    expect(spec).toMatchObject({
      cwd: realpathSync(value.root),
      batchId: value.batch.batch_id,
      targetId: "neon",
      harness: "codex",
      model: "model-codex",
      invokeTimeoutMs: 900_000,
      firstActionTimeoutMs: 180_000,
      skipReset: false,
    });
    expect(spec.recordPath).toBe(resolve(realpathSync(value.runRoot), "cells/neon/api/codex/trial-1/record.normalized.json"));
    expect(() => selectArenaWorkerCell(value.plan, "neon/api/codex/trial-2")).toThrow(/exactly one descriptor/);
    expect(() => deriveArenaCellSpec(value.batch, { ...codex, model: "drift" }, value.runRoot, value.packPath))
      .toThrow(/drifted from the immutable batch/);
  });

  it("matches serial completion under simulated fan-out and emits names, never credential values", () => {
    const value = fixture();
    const now = new Date("2026-07-21T00:00:04.000Z");
    const serial = buildBatchCompletion(value.runRoot, value.batch, value.executions, now);
    const fanout = buildBatchCompletionFromResults({
      runRoot: value.runRoot,
      batch: value.batch,
      plan: value.plan,
      resultPaths: [...value.resultPaths].reverse(),
      canonicalPackPaths: { neon: value.packPath },
      now,
    });
    expect(fanout).toEqual(serial);

    const result = loadArenaCellResult(value.runRoot, value.resultPaths[0]!);
    const encoded = JSON.stringify(result);
    expect(result.batch_plan_sha256).toBe(createHash("sha256")
      .update(readFileSync(resolve(value.runRoot, "batch-plan.json")))
      .digest("hex"));
    expect(result.cell_descriptor_sha256).toBe(createHash("sha256")
      .update(`${JSON.stringify(value.plan.cells[0], null, 2)}\n`)
      .digest("hex"));
    expect(result.runtime_manifest_sha256).toBeNull();
    expect(fanout.runtime_manifest_sha256).toBeNull();
    expect(result.credential_names.sandbox_scope).toEqual(["SANDBOX_ID"]);
    expect(result.artifacts.map((artifact) => artifact.name)).toEqual([
      "invoke_metadata",
      "results",
      "trace",
      "transcript",
    ]);
    expect(fanout.cells.find((cell) => cell.key === result.cell_key)!.artifacts).toEqual(result.artifacts);
    expect(encoded).toContain("OPENAI_API_KEY");
    expect(encoded).toContain("DATABASE_URL");
    expect(encoded).not.toContain("codex-secret-value");
    expect(encoded).not.toContain("database-secret-value");
    expect(ArenaCellResultSchema.safeParse({
      ...result,
      credential_names: { ...result.credential_names, values: { OPENAI_API_KEY: "codex-secret-value" } },
    }).success).toBe(false);

    const schema = JSON.parse(readFileSync(resolve(import.meta.dirname, "../schemas/arena-cell-result.v1.json"), "utf8"));
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(result)).toBe(true);
    const lowercaseCredential = {
      ...result,
      cell: { ...result.cell, required_credentials: ["lowercase"] },
    };
    expect(validate(lowercaseCredential)).toBe(false);
    expect(ArenaCellResultSchema.safeParse(lowercaseCredential).success).toBe(false);
    const longCoreCellString = {
      ...result,
      cell: { ...result.cell, cell_id: "x".repeat(5_000) },
    };
    expect(validate(longCoreCellString)).toBe(true);
    expect(ArenaCellResultSchema.safeParse(longCoreCellString).success).toBe(true);
  });

  it("requires and propagates runtime evidence for pinned-oci local execution", () => {
    const value = fixture("neon", ["codex", "claude-code"], undefined, undefined, true, true);
    const runtimeManifestSha256 = "9".repeat(64);
    expect(loadArenaCellResult(value.runRoot, value.resultPaths[0]!).runtime_manifest_sha256)
      .toBe(runtimeManifestSha256);
    expect(() => buildBatchCompletionFromResults({
      runRoot: value.runRoot,
      batch: value.batch,
      plan: value.plan,
      resultPaths: value.resultPaths,
      canonicalPackPaths: { neon: value.packPath },
      now: new Date("2026-07-21T00:00:04.000Z"),
    })).toThrow(/pinned-oci.*runtime manifest/);
    rmSync(value.resultPaths[0]!);
    expect(() => writeArenaCellResult(
      value.runRoot,
      value.batch,
      value.plan.cells[0]!,
      value.executions[0]!,
      new Date("2026-07-21T00:00:04.000Z"),
      value.resultPaths[0]!,
    )).toThrow(/pinned-oci.*runtime manifest/);
  });

  it("assembles downloaded cells without trusting source-runner absolute paths", () => {
    const value = fixture();
    for (const resultPath of value.resultPaths) {
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      const recordPath = resolve(value.runRoot, result.record.path);
      const cleanupPath = resolve(value.runRoot, result.cleanup.path);
      const record = JSON.parse(readFileSync(recordPath, "utf8"));
      const cleanup = JSON.parse(readFileSync(cleanupPath, "utf8"));
      const foreignWorkspace = resolve("/foreign-runner/work", ...result.cell_key.split("/"), "workspace");
      record.artifacts.base_dir = resolve(foreignWorkspace, "artifacts");
      result.cell.run_context.cwd = foreignWorkspace;
      cleanup.record_path = resolve("/foreign-runner/work", result.record.path);
      const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);
      cleanup.record_sha256 = createHash("sha256").update(recordBytes).digest("hex");
      const cleanupBytes = Buffer.from(`${JSON.stringify(cleanup, null, 2)}\n`);
      writeFileSync(recordPath, recordBytes);
      writeFileSync(cleanupPath, cleanupBytes);
      result.record.sha256 = cleanup.record_sha256;
      result.cleanup.sha256 = createHash("sha256").update(cleanupBytes).digest("hex");
      writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    }
    expect(buildBatchCompletionFromResults({
      runRoot: value.runRoot,
      batch: value.batch,
      plan: value.plan,
      resultPaths: value.resultPaths,
      canonicalPackPaths: { neon: value.packPath },
      now: new Date("2026-07-21T00:00:04.000Z"),
    }).cells).toHaveLength(2);
  });

  it("matches serial completion when cleanup is explicitly skipped but its provider remains pinned", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-worker-skip-reset-"));
    const value = fixture("neon", ["codex", "claude-code"], root, resolve(root, "run"), false);
    expect(value.plan.cells[0]!.reset_provider).toEqual({ id: "reset", version: "1.0.0" });
    expect(value.executions[0]!.cleanup.status).toBe("skipped");
    expect(value.executions[0]!.cleanup.provider).toBeUndefined();
    const now = new Date("2026-07-21T00:00:04.000Z");
    expect(buildBatchCompletionFromResults({
      runRoot: value.runRoot,
      batch: value.batch,
      plan: value.plan,
      resultPaths: value.resultPaths,
      canonicalPackPaths: { neon: value.packPath },
      now,
    })).toEqual(buildBatchCompletion(value.runRoot, value.batch, value.executions, now));
  });

  it("seals early unconfirmed cleanup evidence before any reset provider was selected", () => {
    const value = fixture();
    const execution = value.executions[0]!;
    const { provider: _provider, plan: _plan, evidence: _evidence, ...cleanupBase } = execution.cleanup;
    execution.cleanup = ArenaCellCleanupSchema.parse({
      ...cleanupBase,
      status: "unconfirmed",
      message: "reset provider selection failed",
      errors: ["reset provider selection failed"],
    });
    writeFileSync(execution.cleanupPath, `${JSON.stringify(execution.cleanup, null, 2)}\n`);
    rmSync(value.resultPaths[0]!);
    const result = writeArenaCellResult(
      value.runRoot,
      value.batch,
      value.plan.cells[0]!,
      execution,
      new Date("2026-07-21T00:00:04.000Z"),
      value.resultPaths[0]!,
    );
    expect(result.cleanup_status).toBe("unconfirmed");
    expect(loadArenaCellResult(value.runRoot, value.resultPaths[0]!).cleanup_status).toBe("unconfirmed");
  });

  it("rejects missing, duplicate, extra, and descriptor-drifted result sets", () => {
    const value = fixture();
    const options = {
      runRoot: value.runRoot,
      batch: value.batch,
      plan: value.plan,
      canonicalPackPaths: { neon: value.packPath },
      now: new Date("2026-07-21T00:00:04.000Z"),
    };
    expect(() => buildBatchCompletionFromResults({ ...options, resultPaths: value.resultPaths.slice(0, 1) }))
      .toThrow(/not exact.*missing/s);
    expect(() => buildBatchCompletionFromResults({ ...options, resultPaths: [value.resultPaths[0]!, value.resultPaths[0]!] }))
      .toThrow(/duplicate arena cell result/);

    const foreignRoot = resolve(value.runRoot, "foreign-run");
    const foreign = fixture("other", ["codex", "claude-code"], value.root, foreignRoot);
    const foreignResult = JSON.parse(readFileSync(foreign.resultPaths[0]!, "utf8"));
    foreignResult.record.path = `foreign-run/${foreignResult.record.path}`;
    foreignResult.cleanup.path = `foreign-run/${foreignResult.cleanup.path}`;
    foreignResult.artifacts = foreignResult.artifacts.map((artifact: { path: string }) => ({
      ...artifact,
      path: `foreign-run/${artifact.path}`,
    }));
    const foreignResultPath = resolve(value.runRoot, "foreign-cell-result.json");
    writeFileSync(foreignResultPath, `${JSON.stringify(foreignResult, null, 2)}\n`);
    expect(() => buildBatchCompletionFromResults({
      ...options,
      resultPaths: [...value.resultPaths, foreignResultPath],
    })).toThrow(/not exact.*extra other\/api\/codex\/trial-1/s);

    const driftedPath = resolve(value.runRoot, "drifted-cell-result.json");
    const drifted = JSON.parse(readFileSync(value.resultPaths[0]!, "utf8"));
    drifted.cell_descriptor_sha256 = "f".repeat(64);
    writeFileSync(driftedPath, `${JSON.stringify(drifted, null, 2)}\n`);
    expect(() => buildBatchCompletionFromResults({
      ...options,
      resultPaths: [driftedPath, value.resultPaths[1]!],
    })).toThrow(/drifted from its immutable descriptor/);
    expect(() => buildBatchCompletionFromResults({
      ...options,
      resultPaths: value.resultPaths,
      runtimeManifestSha256: "a".repeat(64),
    })).toThrow(/native.*runtime manifest/);
  });

  it("loads canonical envelopes and sidecars without following symlinks", () => {
    const value = fixture();
    const resultPath = value.resultPaths[0]!;
    const planted = resolve(value.runRoot, "planted-result.json");
    writeFileSync(planted, readFileSync(resultPath));
    rmSync(resultPath);
    symlinkSync(planted, resultPath);
    expect(() => loadArenaCellResult(value.runRoot, resultPath)).toThrow(/symlink|ELOOP/i);
  });

  it("rejects a runtime artifact changed after the worker sealed its result", () => {
    const value = fixture();
    const result = loadArenaCellResult(value.runRoot, value.resultPaths[0]!);
    const artifact = resolve(value.runRoot, result.artifacts[0]!.path);
    writeFileSync(artifact, "tampered after worker result\n");
    expect(() => loadArenaCellResult(value.runRoot, value.resultPaths[0]!))
      .toThrow(/artifact seal mismatch/);
  });

  it("rejects persisted plan drift before entering the live cell lifecycle", async () => {
    const value = fixture();
    const planPath = resolve(value.runRoot, "batch-plan.json");
    const forged = JSON.parse(readFileSync(planPath, "utf8"));
    forged.cells[0].model = "drifted-before-execution";
    writeFileSync(planPath, `${JSON.stringify(forged, null, 2)}\n`);
    await expect(executeArenaWorkerCell(
      value.batch,
      value.plan.cells[0]!,
      value.runRoot,
      value.packPath,
      {
        credentials: {
          OPENAI_API_KEY: "codex-secret",
          DATABASE_URL: "database-secret",
          SANDBOX_ID: "sandbox-secret",
        },
        now: () => new Date(),
        async createRegistry() {
          throw new Error("live lifecycle must not start");
        },
      },
    )).rejects.toThrow(/batch plan|plan drifted/i);
  });
});
