import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NormalizedCellRecordSchema, loadPack, loadSuite, packFileContentHash } from "ax-eval";
import { buildArenaPublicationBundle } from "../src/publication/bundle.js";
import { buildArenaPublicationExport } from "../src/publication/export.js";
import {
  ArenaBatchConfigurationSchema,
  ArenaBatchCompletionSchema,
  ArenaBatchManifestSchema,
  ArenaCellCleanupSchema,
  ArenaRuntimeReportSchema,
  arenaBatchConfigurationHash,
  type ArenaBatchConfiguration,
} from "../src/controller/schemas.js";
import { bubblewrapPolicyHash } from "../src/controller/sandbox.js";
import { aggregateArenaCellRecords, writeRuntimeReportingBundle } from "../src/controller/reporting.js";
import { arenaCellId } from "../src/controller/cell.js";

vi.mock("../src/publication/attestation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/publication/attestation.js")>();
  return {
    ...actual,
    verifyHostedRunAttestation: (runRoot: string) => actual.verifyHostedRunAttestationWithVerifier(
      runRoot,
      () => ({
        sha256: "f".repeat(64),
        version: "gh version 2.80.0 (test fixture)",
        detachedBundles: Buffer.from('{"mediaType":"application/vnd.dev.sigstore.bundle.v0.3+json"}\n'),
      }),
    ),
    verifyBundledHostedAttestation: () => ({ sha256: "f".repeat(64), version: "gh version 2.80.0 (test fixture)" }),
  };
});

vi.mock("../src/publication/competitive.js", () => ({
  renderArenaCompetitiveReport: () => "<!doctype html><title>fixture competition</title>\n",
}));

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const BENCHMARK_ROOT = resolve(ROOT, "ax-arena/benchmark/daeb");
const GENERATED_AT = "2026-07-21T12:00:00.000Z";

function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function writeCanonical(path: string, value: unknown): Buffer {
  const bytes = canonical(value);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, bytes);
  return bytes;
}

function fixture(production: boolean, emptyEvidence = false, duplicateTrialEvidence = false) {
  const root = mkdtempSync(resolve(ROOT, ".arena-publication-test-"));
  const runRoot = resolve(root, "run");
  const outDir = resolve(root, "bundle");
  mkdirSync(runRoot, { recursive: true });
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const suitePath = resolve(BENCHMARK_ROOT, "v1/suite.yaml");
  const packPath = resolve(BENCHMARK_ROOT, "v1/packs/neon/pack.yaml");
  const runtimeLockPath = resolve(ROOT, "ax-arena/benchmark/trusted-runtime/runtime-lock.json");
  const runtimeLockBytes = readFileSync(runtimeLockPath);
  const runtimeLock = JSON.parse(runtimeLockBytes.toString("utf8"));
  const sandbox = {
    kind: "bubblewrap" as const,
    policy_version: "ax.arena-bubblewrap/v2" as const,
    runtime_lock_sha256: hash(runtimeLockBytes),
    sysroot: "/opt/ax-arena-runtime/rootfs" as const,
    executable: runtimeLock.bubblewrap.executable_path,
    executable_sha256: runtimeLock.bubblewrap.executable_sha256,
    runtime_roots: ["/usr", "/opt/ax-arena-tools"] as ["/usr", "/opt/ax-arena-tools"],
  };
  const suite = loadSuite(suitePath);
  const pack = loadPack(packPath);
  const harnesses = ["codex", "claude-code"] as const;
  const trials = production ? [1, 2, 3] : [1];
  const profile = production ? "high" as const : "medium" as const;
  const cells = harnesses.flatMap((harness) => trials.map((trial) => ({
    key: `neon/api/${harness}/trial-${trial}`,
    vendor: "neon",
    surface: "api" as const,
    harness,
    profile,
    effort: profile,
    model: harness === "codex" ? (production ? "gpt-5.6-terra" : "model-codex") : "claude-sonnet-5",
    trial,
    host_credential_names: [] as string[],
    verification_credential_names: [] as string[],
    reset_credential_names: [] as string[],
    sandbox_scope_names: [] as string[],
    provider_pins: [] as const,
    reset_provider: { id: "reset", version: "1.0.0" },
  })));
  const configuration: ArenaBatchConfiguration = ArenaBatchConfigurationSchema.parse({
    command: production ? "daeb-production-rerun" : "daeb-low-pass",
    execution: { runtime_backend: "pinned-oci", trust_level: "hosted-trusted" },
    sandbox,
    suite: { name: suite.name, version: suite.version, file_hash: hash(readFileSync(suitePath)) },
    packs: [{
      vendor: "neon",
      file_hash: packFileContentHash(packPath),
      standard_set_version: pack.standard_set_version,
      surfaces: ["api"],
      host_credential_names: [],
      verification_credential_names: [],
      reset_credential_names: [],
      sandbox_scope_names: [],
    }],
    cells,
    harnesses: harnesses.map((harness) => ({
      harness,
      version_raw: harness === "codex" ? "codex 1.2.3" : "claude 2.3.4",
      version_semver: harness === "codex" ? "1.2.3" : "2.3.4",
    })),
    reset_required: true,
    invoke_timeout_seconds: 900,
    first_action_timeout_seconds: production ? 240 : 180,
    invoke_retries: 0,
  });
  const batch = ArenaBatchManifestSchema.parse({
    schema: "ax.arena-batch/v1",
    batch_id: production ? "publication-production" : "publication-low-pass",
    source_commit_sha: sourceSha,
    created_at: "2026-07-21T11:00:00.000Z",
    configuration_hash: arenaBatchConfigurationHash(configuration),
    configuration,
    expected_cells: configuration.cells.map((cell) => cell.key),
  });
  const batchBytes = writeCanonical(resolve(runRoot, "batch.json"), batch);
  const completionCells = configuration.cells.map((cell) => {
    const recordPath = `${cell.key}/record.json`;
    const cleanupPath = `${cell.key}/cleanup.json`;
    const artifactRoot = resolve(runRoot, cell.key, "artifacts");
    const artifactValues = {
      results: Buffer.from('{"results":{}}\n'),
      trace: Buffer.from('[{"step":1,"taskId":"db-T01-access-control","action":"verified task","method":"POST","path":"/projects"}]\n'),
      transcript: Buffer.from(`${JSON.stringify(cell.harness === "codex" ? {
        type: "item.completed",
        item: { type: "command_execution", command: "curl -X POST https://example.test/projects", status: "completed", exit_code: 0 },
      } : {
        role: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", input: { command: "curl -X POST https://example.test/projects" } }] },
      })}\n`),
      invoke_metadata: Buffer.from('{"exit_code":0}\n'),
    };
    const artifactFiles = {
      results: "results.json",
      trace: "trace.json",
      transcript: "transcript.jsonl",
      invoke_metadata: "invoke.json",
    } as const;
    mkdirSync(artifactRoot, { recursive: true });
    for (const name of Object.keys(artifactValues) as Array<keyof typeof artifactValues>) {
      writeFileSync(resolve(artifactRoot, artifactFiles[name]), artifactValues[name]);
    }
    const pin = configuration.harnesses.find((candidate) => candidate.harness === cell.harness)!;
    const recordId = arenaCellId({
      batchId: batch.batch_id,
      evaluationSetId: suite.name,
      targetId: cell.vendor,
      surface: cell.surface,
      harness: cell.harness,
      profile: cell.profile,
      model: cell.model,
      effort: cell.effort,
      trial: cell.trial,
      sourceCommitSha: batch.source_commit_sha,
    }, configuration.packs[0]!.file_hash);
    const recordValue = NormalizedCellRecordSchema.parse({
      schema: "ax.normalized-cell-record/v1",
      surface: cell.surface,
      product: cell.vendor,
      harness: cell.harness,
      standard_set_version: pack.standard_set_version,
      generated_at: GENERATED_AT,
      tasks_total: 1,
      tasks_passed: 1,
      pass_at_1: 1,
      pass_at_k: 1,
      attempts: 1,
      discovery_score: 1,
      content_quality: 1,
      profiles: [cell.profile],
      best_profile: cell.profile,
      model: cell.model,
      harness_version_raw: pin.version_raw,
      harness_version_semver: pin.version_semver,
      run_batch_id: batch.batch_id,
      latency_ms: 10,
      total_duration_ms: 20,
      first_action_latency_ms: 1,
      tool_call_count: 2,
      token_usage: { input_tokens: 10, output_tokens: 2 },
      token_cost: cell.harness === "claude-code" ? 0.01 : null,
      cost_usd: cell.harness === "claude-code" ? 0.01 : null,
      tokens_in: 10,
      tokens_out: 2,
      validity_status: "valid",
      transcript_event_count: 1,
      action_occurred: true,
      summary_kind: "single",
      record_id: recordId,
      cell_id: recordId,
      batch_id: batch.batch_id,
      evaluation_set_id: suite.name,
      evaluation_set_version: pack.standard_set_version,
      pack_content_hash: configuration.packs[0]!.file_hash,
      source_commit_sha: batch.source_commit_sha,
      execution_namespace: `namespace-${cell.harness}-${cell.trial}`,
      target_id: cell.vendor,
      trial: cell.trial,
      effort: cell.effort,
      requested_model: cell.model,
      started_at: "2026-07-21T11:00:00.000Z",
      completed_at: "2026-07-21T11:01:00.000Z",
      status: "completed",
      error: null,
      provider_provenance: [],
      sandbox_provenance: {
        id: "ax-arena-bubblewrap",
        version: "ax.arena-bubblewrap/v2",
        implementation_sha256: sandbox.executable_sha256,
        policy_sha256: bubblewrapPolicyHash(sandbox),
      },
      task_results: [{
        taskId: "db-T01-access-control",
        difficulty: "medium",
        profile: cell.profile,
        success: true,
        oracleResults: [{ type: "read-back", passed: true, detail: "verified" }],
        error: null,
        na: false,
      }],
      artifacts: {
        base_dir: artifactRoot,
        ...artifactFiles,
      },
    });
    const record = writeCanonical(resolve(runRoot, recordPath), recordValue);
    const cleanupValue = ArenaCellCleanupSchema.parse({
      schema: "ax.arena-cell-cleanup/v1",
      cell_id: recordId,
      record_path: resolve(runRoot, recordPath),
      record_sha256: hash(record),
      generated_at: "2026-07-21T11:02:00.000Z",
      status: "confirmed",
      provider: { id: "reset", version: "1.0.0" },
      namespace: recordValue.execution_namespace,
      plan: { summary: "cleanup", resources: [recordValue.execution_namespace] },
      evidence: { supported: true, message: "deleted", deleted: [recordValue.execution_namespace], errors: [] },
      message: "deleted",
      errors: [],
    });
    const cleanup = writeCanonical(resolve(runRoot, cleanupPath), cleanupValue);
    return {
      key: cell.key,
      record_id: recordId,
      record_path: recordPath,
      record_hash: hash(record),
      cleanup_path: cleanupPath,
      cleanup_hash: hash(cleanup),
      harness: cell.harness,
      requested_model: cell.model,
      actual_model: cell.model,
      harness_version_raw: pin.version_raw,
      harness_version_semver: pin.version_semver,
      status: "completed" as const,
      cleanup_status: "confirmed" as const,
      artifacts: (["invoke_metadata", "results", "trace", "transcript"] as const).map((name) => ({
        name,
        path: `${cell.key}/artifacts/${artifactFiles[name]}`,
        sha256: hash(artifactValues[name]),
      })),
    };
  });
  const runtimeManifest = {
    schema: "ax.arena-trusted-runtime-manifest/v1",
    platform: "linux/amd64",
    runtime_lock_path: "ax-arena/benchmark/trusted-runtime/runtime-lock.json",
    runtime_lock_sha256: sandbox.runtime_lock_sha256,
    sysroot: "/opt/ax-arena-runtime/rootfs",
    container: runtimeLock.container,
    node_executable_sha256: "a".repeat(64),
    tools_tree_sha256: "b".repeat(64),
    entries: [],
  };
  const completion = ArenaBatchCompletionSchema.parse({
    schema: "ax.arena-batch-completion/v1",
    batch_id: batch.batch_id,
    source_commit_sha: batch.source_commit_sha,
    configuration_hash: batch.configuration_hash,
    runtime_manifest_sha256: hash(Buffer.from(`${JSON.stringify(runtimeManifest, null, 2)}\n`)),
    completed_at: GENERATED_AT,
    cells: completionCells,
  });
  const completionBytes = writeCanonical(resolve(runRoot, "batch-completion.json"), completion);
  const reportDir = resolve(runRoot, "neon/api/reporting");
  const snapshotPath = "neon/api/reporting/generated-eval.snapshot.json";
  const htmlPath = "neon/api/reporting/generated-eval.html";
  const failurePath = "neon/api/reporting/failure-review.md";
  const snapshotBytes = writeCanonical(resolve(runRoot, snapshotPath), {
    schema: "ax.generated-report-snapshot/v1",
    pack,
    runs: emptyEvidence ? [] : configuration.cells.map((configuredCell) => {
      const cell = duplicateTrialEvidence
        ? configuration.cells.find((candidate) => candidate.harness === configuredCell.harness && candidate.trial === 1)!
        : configuredCell;
      return {
        cell_key: cell.key,
        trial: cell.trial,
        profile: cell.profile,
        harness: cell.harness,
        model: cell.model,
        surface: cell.surface,
        outcomes: JSON.parse(readFileSync(resolve(runRoot, `${cell.key}/record.json`), "utf8")).task_results,
        trace: [{
          step: 1,
          taskId: "db-T01-access-control",
          action: "verified task",
          method: "POST",
          path: "/projects",
        }],
        evidence: {
          results: [`${cell.key}/artifacts/results.json`],
          trace: [`${cell.key}/artifacts/trace.json`],
          transcript: `${cell.key}/artifacts/transcript.jsonl`,
        },
      };
    }),
    harness: {},
    warnings: [],
    minPassRate: 0.8,
    generatedAt: GENERATED_AT,
  });
  mkdirSync(reportDir, { recursive: true });
  const htmlBytes = Buffer.from("<html><body>verified report</body></html>\n");
  const failureBytes = Buffer.from("# failures\n\n- none\n");
  writeFileSync(resolve(runRoot, htmlPath), htmlBytes);
  writeFileSync(resolve(runRoot, failurePath), failureBytes);
  const aggregates = harnesses.map((harness) => {
    const cohort = configuration.cells.filter((cell) => cell.harness === harness);
    const aggregatePath = `neon/api/${harness}/aggregate/${harness}.api.aggregate.normalized.json`;
    const trialManifestPath = `neon/api/${harness}/aggregate/trial-manifest.json`;
    const sourceRecords = cohort.map((cell) => completionCells.find((candidate) => candidate.key === cell.key)!.record_path);
    const sourceValues = sourceRecords.map((path) => JSON.parse(readFileSync(resolve(runRoot, path), "utf8")));
    const aggregateBytes = writeCanonical(
      resolve(runRoot, aggregatePath),
      aggregateArenaCellRecords(sourceValues, sourceRecords, GENERATED_AT),
    );
    const trialBytes = writeCanonical(resolve(runRoot, trialManifestPath), {
      schema: "ax.arena-runtime-trials/v1",
      batch_id: batch.batch_id,
      vendor: "neon",
      surface: "api",
      harness,
      generated_at: GENERATED_AT,
      trials: cohort.map((cell) => {
        const completed = completionCells.find((candidate) => candidate.key === cell.key)!;
        return { trial: cell.trial, record_path: completed.record_path, record_hash: completed.record_hash };
      }),
    });
    return {
      vendor: "neon",
      surface: "api" as const,
      harness,
      trial_count: cohort.length,
      aggregate_record_path: aggregatePath,
      aggregate_record_sha256: hash(aggregateBytes),
      trial_manifest_path: trialManifestPath,
      trial_manifest_sha256: hash(trialBytes),
    };
  });
  const report = ArenaRuntimeReportSchema.parse({
    schema: "ax.arena-runtime-report/v1",
    batch_id: batch.batch_id,
    configuration_hash: batch.configuration_hash,
    source_commit_sha: batch.source_commit_sha,
    batch_manifest_sha256: hash(batchBytes),
    batch_completion_sha256: hash(completionBytes),
    execution: { runtime_backend: "pinned-oci", trust_level: "hosted-trusted" },
    sandbox_provenance: {
      id: "ax-arena-bubblewrap",
      version: "ax.arena-bubblewrap/v2",
      runtime_lock_sha256: sandbox.runtime_lock_sha256,
      implementation_sha256: sandbox.executable_sha256,
      policy_sha256: bubblewrapPolicyHash(sandbox),
    },
    generated_at: GENERATED_AT,
    surface_reports: [{
      vendor: "neon",
      surface: "api",
      snapshot_path: snapshotPath,
      snapshot_sha256: hash(snapshotBytes),
      html_path: htmlPath,
      html_sha256: hash(htmlBytes),
      failure_review_path: failurePath,
      failure_review_sha256: hash(failureBytes),
    }],
    aggregates,
  });
  writeCanonical(resolve(runRoot, "runtime-reporting.json"), report);
  rmSync(reportDir, { recursive: true, force: true });
  for (const harness of harnesses) rmSync(resolve(runRoot, `neon/api/${harness}/aggregate`), { recursive: true, force: true });
  rmSync(resolve(runRoot, "runtime-reporting.json"));
  const canonicalReport = writeRuntimeReportingBundle({
    runRoot,
    batch,
    packPaths: { neon: packPath },
    now: new Date(GENERATED_AT),
  });
  if (emptyEvidence || duplicateTrialEvidence) {
    const snapshotEntry = canonicalReport.surface_reports[0]!;
    const canonicalSnapshotPath = resolve(runRoot, snapshotEntry.snapshot_path);
    const canonicalSnapshot = JSON.parse(readFileSync(canonicalSnapshotPath, "utf8"));
    if (emptyEvidence) canonicalSnapshot.runs = [];
    if (duplicateTrialEvidence) canonicalSnapshot.runs[1] = structuredClone(canonicalSnapshot.runs[0]);
    const changedSnapshot = writeCanonical(canonicalSnapshotPath, canonicalSnapshot);
    snapshotEntry.snapshot_sha256 = hash(changedSnapshot);
    writeCanonical(resolve(runRoot, "runtime-reporting.json"), canonicalReport);
  }
  const configurationBytes = writeCanonical(resolve(runRoot, "configuration.json"), configuration);
  const runtimeManifestBytes = writeCanonical(resolve(runRoot, "runtime-manifest.json"), runtimeManifest);
  const sourceArtifacts = execFileSync("git", ["ls-files", "ax-arena/benchmark/daeb"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean).sort().map((path) => ({ path, sha256: hash(readFileSync(resolve(ROOT, path))) }));
  writeCanonical(resolve(runRoot, "trusted-run-subject.json"), {
    schema: "ax.arena-trusted-run-subject/v1",
    repository: "chenmingtang830/ax-eval",
    source_commit_sha: sourceSha,
    protected_default_branch: "main",
    workflow: {
      ref: "chenmingtang830/ax-eval/.github/workflows/trusted-sandbox-records.yml@refs/heads/main",
      sha: sourceSha,
      run_id: "12345",
      run_attempt: "1",
      environment: "trusted-sandbox",
    },
    runtime: {
      lock_path: "ax-arena/benchmark/trusted-runtime/runtime-lock.json",
      lock_sha256: sandbox.runtime_lock_sha256,
      container_digest: runtimeLock.container.digest,
      tools_tree_sha256: runtimeManifest.tools_tree_sha256,
      manifest: { path: "runtime-manifest.json", sha256: hash(runtimeManifestBytes) },
    },
    configuration: { path: "configuration.json", sha256: hash(configurationBytes) },
    batch: {
      id: batch.batch_id,
      configuration_hash: batch.configuration_hash,
      completed_cells: completion.cells.length,
      manifest: { path: "batch.json", sha256: hash(batchBytes) },
      completion: { path: "batch-completion.json", sha256: hash(completionBytes) },
    },
    source_artifacts: sourceArtifacts,
  });
  return { root, runRoot, outDir, aggregatePath: resolve(runRoot, canonicalReport.aggregates[0]!.aggregate_record_path) };
}

describe("arena publication bundle", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("freezes a hash-bound production-ready bundle from the fixed allowlist", () => {
    const test = fixture(true);
    roots.push(test.root);
    const bundle = buildArenaPublicationBundle({
      runRoot: test.runRoot,
      outDir: test.outDir,
      benchmarkRoot: BENCHMARK_ROOT,
      generatedAt: new Date(GENERATED_AT),
    });
    expect(bundle.publication_readiness).toBe("publication_ready");
    const schema = JSON.parse(readFileSync(resolve(ROOT, "ax-arena/benchmark/schemas/publication-bundle.v2.json"), "utf8"));
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(bundle), JSON.stringify(validate.errors)).toBe(true);
    expect(bundle.expected_matrix).toMatchObject({
      surfaces: ["api"], harnesses: ["codex", "claude-code"], effort_profiles: ["high"], expected_cells: 2,
    });
    expect(readFileSync(resolve(test.outDir, "suite/suite.yaml"))).toEqual(readFileSync(resolve(BENCHMARK_ROOT, "v1/suite.yaml")));
    expect(readFileSync(resolve(test.outDir, "vendors/neon/compiled-pack.yaml"))).toEqual(readFileSync(resolve(BENCHMARK_ROOT, "v1/packs/neon/pack.yaml")));
    expect(readFileSync(resolve(test.outDir, "vendors/neon/pack.approval.json"))).toEqual(readFileSync(resolve(BENCHMARK_ROOT, "v1/packs/neon/pack.approval.json")));
    expect(existsSync(resolve(test.outDir, "competitive.html"))).toBe(true);
    expect(bundle.integrity.attestation).toMatchObject({
      subject_path: "provenance/trusted-run-subject.json",
      detached_bundles_path: "provenance/github-attestation-bundles.jsonl",
      workflow_ref: "chenmingtang830/ax-eval/.github/workflows/trusted-sandbox-records.yml@refs/heads/main",
    });
    expect(bundle.integrity!.files.length).toBeGreaterThan(0);
    for (const file of bundle.integrity!.files) {
      const bytes = readFileSync(resolve(test.outDir, file.path));
      expect(hash(bytes)).toBe(file.sha256);
      expect(bytes.length).toBe(file.bytes);
    }
    const exported = buildArenaPublicationExport({
      root: ROOT,
      bundleDir: test.outDir,
      outDir: resolve(test.root, "export"),
      generatedAt: new Date("2026-07-21T14:00:00.000Z"),
    });
    expect(exported.files).toHaveLength(7);
    for (const file of exported.files) expect(existsSync(resolve(test.root, "export", file.path))).toBe(true);
    expect(JSON.parse(readFileSync(resolve(test.root, "export/tasks.json"), "utf8")).tasks.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(resolve(test.root, "export/trials.json"), "utf8")).task_results.length).toBeGreaterThan(0);
  });

  it("rejects a completed low-pass batch instead of producing a publishable draft", () => {
    const test = fixture(false);
    roots.push(test.root);
    expect(() => buildArenaPublicationBundle({
      runRoot: test.runRoot,
      outDir: test.outDir,
      benchmarkRoot: BENCHMARK_ROOT,
      generatedAt: new Date(GENERATED_AT),
    })).toThrow(/hosted-trusted pinned-OCI production run/);
    expect(existsSync(test.outDir)).toBe(false);
  });

  it("rejects missing or non-protected-main attestation subjects", () => {
    const missing = fixture(true);
    roots.push(missing.root);
    rmSync(resolve(missing.runRoot, "trusted-run-subject.json"));
    expect(() => buildArenaPublicationBundle({
      runRoot: missing.runRoot, outDir: missing.outDir, benchmarkRoot: BENCHMARK_ROOT,
    })).toThrow();
    expect(existsSync(missing.outDir)).toBe(false);

    const unprotected = fixture(true);
    roots.push(unprotected.root);
    const subjectPath = resolve(unprotected.runRoot, "trusted-run-subject.json");
    const subject = JSON.parse(readFileSync(subjectPath, "utf8"));
    subject.workflow.ref = "chenmingtang830/ax-eval/.github/workflows/trusted-sandbox-records.yml@refs/heads/feature";
    writeCanonical(subjectPath, subject);
    expect(() => buildArenaPublicationBundle({
      runRoot: unprotected.runRoot, outDir: unprotected.outDir, benchmarkRoot: BENCHMARK_ROOT,
    })).toThrow();
    expect(existsSync(unprotected.outDir)).toBe(false);
  });

  it("rejects a run root that escapes through an intermediate symlink", () => {
    const outside = mkdtempSync(resolve(tmpdir(), "ax-arena-publication-outside-"));
    const link = resolve(ROOT, `.arena-publication-link-${Date.now()}`);
    roots.push(link, outside);
    mkdirSync(resolve(outside, "run"));
    symlinkSync(outside, link);
    expect(() => buildArenaPublicationBundle({
      runRoot: resolve(link, "run"),
      outDir: resolve(ROOT, `.arena-publication-output-${Date.now()}`),
      benchmarkRoot: BENCHMARK_ROOT,
    })).toThrow(/physical repository root/);
  });

  it("rejects a production snapshot with no run evidence", () => {
    const test = fixture(true, true);
    roots.push(test.root);
    expect(() => buildArenaPublicationBundle({
      runRoot: test.runRoot, outDir: test.outDir, benchmarkRoot: BENCHMARK_ROOT,
    })).toThrow(/at least 1|too_small|runtime snapshot/i);
    expect(existsSync(test.outDir)).toBe(false);
  });

  it("rejects duplicated trial evidence in a production snapshot", () => {
    const test = fixture(true, false, true);
    roots.push(test.root);
    expect(() => buildArenaPublicationBundle({
      runRoot: test.runRoot, outDir: test.outDir, benchmarkRoot: BENCHMARK_ROOT,
    })).toThrow(/snapshot evidence does not match/);
    expect(existsSync(test.outDir)).toBe(false);
  });

  it("recomputes aggregate scores from attested cells before publication readiness", () => {
    const test = fixture(true);
    roots.push(test.root);
    const changed = JSON.parse(readFileSync(test.aggregatePath, "utf8"));
    changed.pass_at_1 = 0;
    changed.mean_pass_rate = 0;
    changed.trial_values = [0, 0, 0];
    changed.range_pass_rate = { min: 0, max: 0 };
    changed.tasks_passed = 0;
    changed.task_consistency_at_3 = 0;
    changed.pass_3_tasks = 0;
    changed.pass_all_3 = 0;
    changed.trial_stability_at_3 = "all_fail";
    const aggregateBytes = writeCanonical(test.aggregatePath, changed);
    const reportPath = resolve(test.runRoot, "runtime-reporting.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.aggregates[0].aggregate_record_sha256 = hash(aggregateBytes);
    writeCanonical(reportPath, report);
    expect(() => buildArenaPublicationBundle({
      runRoot: test.runRoot, outDir: test.outDir, benchmarkRoot: BENCHMARK_ROOT,
    })).toThrow(/aggregate metrics do not match completed trials|aggregate does not match attested-cell recomputation|reporting manifest does not match exact attested-cell recomputation/);
    expect(existsSync(test.outDir)).toBe(false);
  });

  it("recomputes aggregate efficiency from attested cells before publication readiness", () => {
    const test = fixture(true);
    roots.push(test.root);
    const changed = JSON.parse(readFileSync(test.aggregatePath, "utf8"));
    changed.latency_ms = 999_999;
    changed.cost_usd = 999;
    changed.token_usage = { input_tokens: 999_999, output_tokens: 999_999 };
    const aggregateBytes = writeCanonical(test.aggregatePath, changed);
    const reportPath = resolve(test.runRoot, "runtime-reporting.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.aggregates[0].aggregate_record_sha256 = hash(aggregateBytes);
    writeCanonical(reportPath, report);
    expect(() => buildArenaPublicationBundle({
      runRoot: test.runRoot, outDir: test.outDir, benchmarkRoot: BENCHMARK_ROOT,
    })).toThrow(/aggregate metrics do not match completed trials|aggregate does not match attested-cell recomputation|reporting manifest does not match exact attested-cell recomputation/);
    expect(existsSync(test.outDir)).toBe(false);
  });

  it("recomputes snapshot trace and HTML bytes from attested transcripts", () => {
    const html = fixture(true);
    roots.push(html.root);
    const reportPath = resolve(html.runRoot, "runtime-reporting.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const htmlPath = resolve(html.runRoot, report.surface_reports[0].html_path);
    const htmlBytes = Buffer.from("<!doctype html><title>forged process report</title>\n");
    writeFileSync(htmlPath, htmlBytes);
    report.surface_reports[0].html_sha256 = hash(htmlBytes);
    writeCanonical(reportPath, report);
    expect(() => buildArenaPublicationBundle({
      runRoot: html.runRoot, outDir: html.outDir, benchmarkRoot: BENCHMARK_ROOT,
    })).toThrow(/HTML report does not match attested-cell recomputation|reporting manifest does not match exact attested-cell recomputation/);

    const trace = fixture(true);
    roots.push(trace.root);
    const traceReportPath = resolve(trace.runRoot, "runtime-reporting.json");
    const traceReport = JSON.parse(readFileSync(traceReportPath, "utf8"));
    const snapshotPath = resolve(trace.runRoot, traceReport.surface_reports[0].snapshot_path);
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    snapshot.runs[0].trace = [{ step: 1, taskId: "forged", action: "forged" }];
    const snapshotBytes = writeCanonical(snapshotPath, snapshot);
    traceReport.surface_reports[0].snapshot_sha256 = hash(snapshotBytes);
    writeCanonical(traceReportPath, traceReport);
    expect(() => buildArenaPublicationBundle({
      runRoot: trace.runRoot, outDir: trace.outDir, benchmarkRoot: BENCHMARK_ROOT,
    })).toThrow(/snapshot does not match attested-cell recomputation|reporting manifest does not match exact attested-cell recomputation/);
  });

  it("rejects post-construction rewrites of signed source artifacts and manifest metadata", () => {
    const source = fixture(true);
    roots.push(source.root);
    buildArenaPublicationBundle({ runRoot: source.runRoot, outDir: source.outDir, benchmarkRoot: BENCHMARK_ROOT });
    const sourceManifestPath = resolve(source.outDir, "manifest.json");
    const sourceManifest = JSON.parse(readFileSync(sourceManifestPath, "utf8"));
    const suitePath = resolve(source.outDir, "suite/suite.yaml");
    const changedSuite = Buffer.from("name: forged\nversion: 1\n");
    writeFileSync(suitePath, changedSuite);
    const suiteEntry = sourceManifest.integrity.files.find((entry: { path: string }) => entry.path === "suite/suite.yaml");
    suiteEntry.sha256 = hash(changedSuite);
    suiteEntry.bytes = changedSuite.length;
    writeCanonical(sourceManifestPath, sourceManifest);
    expect(() => buildArenaPublicationExport({
      root: ROOT, bundleDir: source.outDir, outDir: resolve(source.root, "forged-source-export"),
    })).toThrow(/signed protected-main source artifact/);

    const metadata = fixture(true);
    roots.push(metadata.root);
    buildArenaPublicationBundle({ runRoot: metadata.runRoot, outDir: metadata.outDir, benchmarkRoot: BENCHMARK_ROOT });
    const metadataManifestPath = resolve(metadata.outDir, "manifest.json");
    const metadataManifest = JSON.parse(readFileSync(metadataManifestPath, "utf8"));
    metadataManifest.category = "forged-category";
    writeCanonical(metadataManifestPath, metadataManifest);
    expect(() => buildArenaPublicationExport({
      root: ROOT, bundleDir: metadata.outDir, outDir: resolve(metadata.root, "forged-metadata-export"),
    })).toThrow(/manifest metadata is not the canonical derivation/);
  });

  it("rejects post-construction report rewrites and noncanonical bundle inventories", () => {
    const duplicate = fixture(true);
    roots.push(duplicate.root);
    buildArenaPublicationBundle({ runRoot: duplicate.runRoot, outDir: duplicate.outDir, benchmarkRoot: BENCHMARK_ROOT });
    const duplicateManifestPath = resolve(duplicate.outDir, "manifest.json");
    const duplicateManifest = JSON.parse(readFileSync(duplicateManifestPath, "utf8"));
    const duplicateSnapshotPath = duplicateManifest.vendors[0].artifacts.snapshots[0];
    const duplicateSnapshotFile = resolve(duplicate.outDir, duplicateSnapshotPath);
    const duplicateSnapshot = JSON.parse(readFileSync(duplicateSnapshotFile, "utf8"));
    duplicateSnapshot.runs[0].trace = [{ step: 1, taskId: "forged-duplicate", action: "forged" }];
    const duplicateSnapshotBytes = writeCanonical(duplicateSnapshotFile, duplicateSnapshot);
    const duplicateEntry = duplicateManifest.integrity.files.find((entry: { path: string }) => entry.path === duplicateSnapshotPath);
    duplicateEntry.sha256 = hash(duplicateSnapshotBytes);
    duplicateEntry.bytes = duplicateSnapshotBytes.length;
    writeCanonical(duplicateManifestPath, duplicateManifest);
    expect(() => buildArenaPublicationExport({
      root: ROOT, bundleDir: duplicate.outDir, outDir: resolve(duplicate.root, "forged-duplicate-export"),
    })).toThrow(/publication duplicate does not match its canonical runtime artifact/);

    const report = fixture(true);
    roots.push(report.root);
    buildArenaPublicationBundle({ runRoot: report.runRoot, outDir: report.outDir, benchmarkRoot: BENCHMARK_ROOT });
    const manifestPath = resolve(report.outDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const runtimeReportPath = resolve(report.outDir, manifest.integrity.runtime_report_path);
    const runtimeReport = JSON.parse(readFileSync(runtimeReportPath, "utf8"));
    const snapshotPath = resolve(report.outDir, runtimeReport.surface_reports[0].snapshot_path);
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    snapshot.runs[0].trace = [{ step: 1, taskId: "forged", action: "forged" }];
    const snapshotBytes = writeCanonical(snapshotPath, snapshot);
    runtimeReport.surface_reports[0].snapshot_sha256 = hash(snapshotBytes);
    const runtimeReportBytes = writeCanonical(runtimeReportPath, runtimeReport);
    for (const [path, bytes] of [
      [runtimeReport.surface_reports[0].snapshot_path, snapshotBytes],
      [manifest.integrity.runtime_report_path, runtimeReportBytes],
    ] as Array<[string, Buffer]>) {
      const entry = manifest.integrity.files.find((candidate: { path: string }) => candidate.path === path);
      entry.sha256 = hash(bytes);
      entry.bytes = bytes.length;
    }
    manifest.integrity.runtime_report_sha256 = hash(runtimeReportBytes);
    writeCanonical(manifestPath, manifest);
    expect(() => buildArenaPublicationExport({
      root: ROOT, bundleDir: report.outDir, outDir: resolve(report.root, "forged-report-export"),
    })).toThrow(/reporting manifest does not match exact attested-cell recomputation/);

    const inventory = fixture(true);
    roots.push(inventory.root);
    buildArenaPublicationBundle({ runRoot: inventory.runRoot, outDir: inventory.outDir, benchmarkRoot: BENCHMARK_ROOT });
    writeFileSync(resolve(inventory.outDir, "payload.html"), "<script>forged</script>\n");
    expect(() => buildArenaPublicationExport({
      root: ROOT, bundleDir: inventory.outDir, outDir: resolve(inventory.root, "unlisted-export"),
    })).toThrow(/physical files do not exactly match/);
    const inventoryManifestPath = resolve(inventory.outDir, "manifest.json");
    const inventoryManifest = JSON.parse(readFileSync(inventoryManifestPath, "utf8"));
    const payload = readFileSync(resolve(inventory.outDir, "payload.html"));
    inventoryManifest.integrity.files.push({ path: "payload.html", sha256: hash(payload), bytes: payload.length });
    inventoryManifest.integrity.files.sort((left: { path: string }, right: { path: string }) => left.path.localeCompare(right.path));
    writeCanonical(inventoryManifestPath, inventoryManifest);
    expect(() => buildArenaPublicationExport({
      root: ROOT, bundleDir: inventory.outDir, outDir: resolve(inventory.root, "listed-export"),
    })).toThrow(/exact canonical signed-cohort artifact set/);
  }, 20_000);

  it("rejects drift and symlink substitution without leaving partial output", () => {
    const drift = fixture(true);
    roots.push(drift.root);
    const changed = JSON.parse(readFileSync(drift.aggregatePath, "utf8"));
    changed.pass_at_1 = 0;
    writeCanonical(drift.aggregatePath, changed);
    expect(() => buildArenaPublicationBundle({
      runRoot: drift.runRoot, outDir: drift.outDir, benchmarkRoot: BENCHMARK_ROOT,
    })).toThrow(/aggregate artifact hash drifted|runtime aggregate/);
    expect(existsSync(drift.outDir)).toBe(false);

    const linked = fixture(true);
    roots.push(linked.root);
    const original = `${linked.aggregatePath}.original`;
    renameSync(linked.aggregatePath, original);
    symlinkSync(original, linked.aggregatePath);
    expect(() => buildArenaPublicationBundle({
      runRoot: linked.runRoot, outDir: linked.outDir, benchmarkRoot: BENCHMARK_ROOT,
    })).toThrow(/symlink/);
    expect(existsSync(linked.outDir)).toBe(false);
  });
});
