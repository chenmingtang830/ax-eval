import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runArenaCli, type CliIo } from "../src/cli.js";
import {
  ArenaBatchCompletionSchema,
  ArenaBatchManifestSchema,
  arenaBatchConfigurationHash,
  type ArenaBatchManifest,
} from "../src/controller/schemas.js";
import { renderArenaCompetitiveReport, writeArenaCompetitiveReport } from "../src/publication/competitive.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CORE_CLI = resolve(REPOSITORY_ROOT, "src", "cli.ts");
const TSX_LOADER = fileURLToPath(import.meta.resolve("tsx"));
const GENERATED_AT = new Date("2026-07-21T00:00:00.000Z");

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createBatch(root: string, betaSurfaces: Array<"api" | "cli"> = ["api", "cli"]): ArenaBatchManifest {
  const vendorSurfaces: Record<string, Array<"api" | "cli">> = {
    alpha: ["api", "cli"],
    beta: betaSurfaces,
  };
  const cells = Object.entries(vendorSurfaces).flatMap(([vendor, surfaces]) => surfaces.flatMap((surface) =>
    (["codex", "claude-code"] as const).flatMap((harness) => [1, 2, 3].map((trial) => ({
      key: `${vendor}/${surface}/${harness}/trial-${trial}`,
      vendor,
      surface,
      harness,
      profile: "high" as const,
      effort: "high" as const,
      model: harness === "codex" ? "gpt-5.6-terra" : "claude-sonnet-5",
      trial,
      host_credential_names: [],
      verification_credential_names: [],
      reset_credential_names: [],
      sandbox_scope_names: [],
      provider_pins: [],
      reset_provider: { id: `fixture-${vendor}-reset`, version: "1.0.0" },
    })))));
  const configuration = {
    command: "daeb-production-rerun" as const,
    suite: { name: "DAEB-1", version: 1, file_hash: "e".repeat(64) },
    packs: Object.entries(vendorSurfaces).map(([vendor, surfaces]) => ({
      vendor,
      file_hash: (vendor === "alpha" ? "1" : "2").repeat(64),
      standard_set_version: "DAEB-1-v1",
      surfaces,
      host_credential_names: [],
      verification_credential_names: [],
      reset_credential_names: [],
      sandbox_scope_names: [],
    })),
    cells,
    harnesses: [
      { harness: "codex" as const, version_raw: "codex-cli 1.2.3", version_semver: "1.2.3" },
      { harness: "claude-code" as const, version_raw: "claude-code 2.3.4", version_semver: "2.3.4" },
    ],
    reset_required: true,
    invoke_timeout_seconds: 900,
    first_action_timeout_seconds: 120,
    invoke_retries: 0,
  };
  const batch = ArenaBatchManifestSchema.parse({
    schema: "ax.arena-batch/v1",
    batch_id: "batch-1",
    source_commit_sha: "a".repeat(40),
    created_at: "2026-07-20T00:00:00.000Z",
    configuration_hash: arenaBatchConfigurationHash(configuration),
    configuration,
    expected_cells: cells.map((cell) => cell.key),
  });
  writeJson(resolve(root, "batch.json"), batch);
  return batch;
}

function record(input: {
  product: string;
  surface: "api" | "cli";
  harness: "codex" | "claude-code";
  rate: number;
  overrides?: Record<string, unknown>;
}): any {
  return {
    schema: "ax.normalized-result/v1",
    surface: input.surface,
    product: input.product,
    harness: input.harness,
    standard_set_version: "DAEB-1-v1",
    generated_at: "2026-07-20T01:00:00.000Z",
    tasks_total: 100,
    tasks_passed: Math.round(input.rate * 100),
    pass_at_1: input.rate,
    pass_at_k: input.rate,
    attempts: 1,
    discovery_score: null,
    content_quality: null,
    profiles: ["high"],
    best_profile: "high",
    model: input.harness === "codex" ? "gpt-5.6-terra" : "claude-sonnet-5",
    harness_version_raw: input.harness === "codex" ? "codex-cli 1.2.3" : "claude-code 2.3.4",
    harness_version_semver: input.harness === "codex" ? "1.2.3" : "2.3.4",
    run_batch_id: "batch-1",
    validity_status: "valid",
    summary_kind: "aggregate",
    trial_count: 3,
    trial_values: [input.rate, input.rate, input.rate],
    mean_pass_rate: input.rate,
    range_pass_rate: { min: input.rate, max: input.rate },
    task_consistency_at_3: input.rate,
    pass_3_tasks: Math.round(input.rate * 100),
    pass_3_tasks_total: 100,
    pass_all_3: input.rate === 1 ? 1 : 0,
    trial_stability_at_3: input.rate === 1 ? "all_pass" : "inconsistent",
    source_records: ["trial-1.json", "trial-2.json", "trial-3.json"],
    ...input.overrides,
  };
}

function createRecords(root: string, batch: ArenaBatchManifest): { paths: string[]; records: any[] } {
  const rates: Record<string, number> = {
    "alpha/api/codex": 0.8,
    "alpha/cli/codex": 0.6,
    "alpha/api/claude-code": 0.7,
    "alpha/cli/claude-code": 0.65,
    "beta/api/codex": 0.9,
    "beta/cli/codex": 0.7,
    "beta/api/claude-code": 0.75,
    "beta/cli/claude-code": 0.55,
  };
  const records = batch.configuration.packs.flatMap((pack) => pack.surfaces.flatMap((surface) =>
    batch.configuration.harnesses.map(({ harness }) => record({
      product: pack.vendor,
      surface: surface as "api" | "cli",
      harness,
      rate: rates[`${pack.vendor}/${surface}/${harness}`]!,
    }))));
  const paths = records.map((value, index) => {
    const path = `records/aggregate-${index}.json`;
    writeJson(resolve(root, path), value);
    return path;
  });
  return { paths, records };
}

function createSealedBundle(
  root: string,
  betaSurfaces: Array<"api" | "cli"> = ["api", "cli"],
): { batch: ArenaBatchManifest; records: any[]; bundleDir: string } {
  const batch = createBatch(root, betaSurfaces);
  const { records } = createRecords(root, batch);
  const bundleDir = "bundle";
  const bundle = resolve(root, bundleDir);
  const artifactPaths: string[] = [];
  const artifactJson = (path: string, value: unknown): void => {
    writeJson(resolve(bundle, path), value);
    artifactPaths.push(path);
  };
  const artifactText = (path: string, value: string): void => {
    mkdirSync(resolve(bundle, path, ".."), { recursive: true });
    writeFileSync(resolve(bundle, path), value);
    artifactPaths.push(path);
  };
  const completionCells: any[] = [];
  const sources = new Map<string, string[]>();
  for (const cell of batch.configuration.cells) {
    const aggregate = records.find((candidate) => candidate.product === cell.vendor
      && candidate.surface === cell.surface && candidate.harness === cell.harness)!;
    const base = `provenance/cells/${cell.key}`;
    const recordPath = `${base}/record.json`;
    const cleanupPath = `${base}/cleanup.json`;
    const recordId = `record-${cell.vendor}-${cell.surface}-${cell.harness}-${cell.trial}`;
    const taskResults = Array.from({ length: 100 }, (_, index) => ({
      taskId: `task-${String(index + 1).padStart(3, "0")}`,
      difficulty: "medium",
      profile: "high",
      success: index < aggregate.tasks_passed,
      oracleResults: [{ type: "fixture", passed: index < aggregate.tasks_passed, detail: "fixture" }],
      error: index < aggregate.tasks_passed ? null : "verification failed",
      na: false,
    }));
    artifactJson(recordPath, {
      schema: "ax.normalized-cell-record/v1",
      surface: cell.surface,
      product: cell.vendor,
      harness: cell.harness,
      standard_set_version: "DAEB-1-v1",
      generated_at: "2026-07-20T00:30:00.000Z",
      tasks_total: 100,
      tasks_passed: aggregate.tasks_passed,
      pass_at_1: aggregate.pass_at_1,
      pass_at_k: aggregate.pass_at_1,
      attempts: 1,
      discovery_score: null,
      content_quality: null,
      profiles: ["high"],
      best_profile: "high",
      model: cell.model,
      harness_version_raw: cell.harness === "codex" ? "codex-cli 1.2.3" : "claude-code 2.3.4",
      harness_version_semver: cell.harness === "codex" ? "1.2.3" : "2.3.4",
      run_batch_id: batch.batch_id,
      latency_ms: 100,
      total_duration_ms: 200,
      tool_call_count: 2,
      token_usage: null,
      token_cost: null,
      cost_usd: null,
      tokens_in: null,
      tokens_out: null,
      validity_status: "valid",
      first_action_latency_ms: 10,
      transcript_event_count: 2,
      action_occurred: true,
      summary_kind: "single",
      record_id: recordId,
      cell_id: recordId,
      batch_id: batch.batch_id,
      evaluation_set_id: "DAEB-1",
      evaluation_set_version: "DAEB-1-v1",
      pack_content_hash: (cell.vendor === "alpha" ? "1" : "2").repeat(64),
      source_commit_sha: batch.source_commit_sha,
      execution_namespace: `fixture-${cell.vendor}-${cell.surface}-${cell.harness}-${cell.trial}`,
      target_id: cell.vendor,
      trial: cell.trial,
      effort: "high",
      requested_model: cell.model,
      started_at: "2026-07-20T00:00:00.000Z",
      completed_at: "2026-07-20T00:30:00.000Z",
      status: "completed",
      error: null,
      provider_provenance: [],
      task_results: taskResults,
      artifacts: {
        base_dir: base,
        results: "results.json",
        trace: "trace.json",
        transcript: "transcript.jsonl",
        invoke_metadata: "invoke-metadata.json",
      },
    });
    const artifactSpecs = [
      ["invoke_metadata", `${base}/invoke-metadata.json`, { exit_code: 0 }],
      ["results", `${base}/results.json`, { ok: true }],
      ["trace", `${base}/trace.json`, []],
      ["transcript", `${base}/transcript.jsonl`, { event: "completed" }],
    ] as const;
    const seals = artifactSpecs.map(([name, path, value]) => {
      artifactText(path, `${JSON.stringify(value)}\n`);
      const bytes = readFileSync(resolve(bundle, path));
      return { name, path, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    const recordBytes = readFileSync(resolve(bundle, recordPath));
    const recordHash = createHash("sha256").update(recordBytes).digest("hex");
    artifactJson(cleanupPath, {
      schema: "ax.arena-cell-cleanup/v1",
      cell_id: recordId,
      record_path: recordPath,
      record_sha256: recordHash,
      generated_at: "2026-07-20T00:31:00.000Z",
      status: "confirmed",
      provider: cell.reset_provider,
      namespace: `fixture-${cell.vendor}-${cell.surface}-${cell.harness}-${cell.trial}`,
      plan: { summary: "fixture cleanup", resources: [`resource-${cell.trial}`] },
      evidence: { supported: true, message: "confirmed", deleted: [`resource-${cell.trial}`], errors: [] },
      message: "cleanup confirmed",
      errors: [],
    });
    const cleanupBytes = readFileSync(resolve(bundle, cleanupPath));
    completionCells.push({
      key: cell.key,
      record_id: recordId,
      record_path: recordPath,
      record_hash: recordHash,
      cleanup_path: cleanupPath,
      cleanup_hash: createHash("sha256").update(cleanupBytes).digest("hex"),
      artifacts: seals,
      harness: cell.harness,
      requested_model: cell.model,
      actual_model: cell.model,
      harness_version_raw: cell.harness === "codex" ? "codex-cli 1.2.3" : "claude-code 2.3.4",
      harness_version_semver: cell.harness === "codex" ? "1.2.3" : "2.3.4",
      status: "completed",
      cleanup_status: "confirmed",
    });
    const cohort = `${cell.vendor}/${cell.surface}/${cell.harness}`;
    sources.set(cohort, [...(sources.get(cohort) ?? []), recordPath]);
  }
  artifactJson("provenance/batch.json", batch);
  const completion = ArenaBatchCompletionSchema.parse({
    schema: "ax.arena-batch-completion/v1",
    batch_id: batch.batch_id,
    source_commit_sha: batch.source_commit_sha,
    configuration_hash: batch.configuration_hash,
    completed_at: "2026-07-20T01:00:00.000Z",
    cells: completionCells,
  });
  artifactJson("provenance/batch-completion.json", completion);

  const recordsByVendor: Record<string, string[]> = { alpha: [], beta: [] };
  for (const aggregate of records) {
    const cohort = `${aggregate.product}/${aggregate.surface}/${aggregate.harness}`;
    aggregate.source_records = sources.get(cohort)!;
    const path = `records/${aggregate.product}-${aggregate.surface}-${aggregate.harness}.json`;
    artifactJson(path, aggregate);
    recordsByVendor[aggregate.product]!.push(path);
  }
  for (const vendor of ["alpha", "beta"]) {
    const runs = completion.cells.filter((cell) => cell.key.startsWith(`${vendor}/`)).map((cell) => {
      const completedRecord = JSON.parse(readFileSync(resolve(bundle, cell.record_path), "utf8"));
      return {
        profile: completedRecord.best_profile,
        harness: completedRecord.harness,
        surface: completedRecord.surface,
        model: completedRecord.model,
        outcomes: completedRecord.task_results,
        evidence: {
          results: [cell.artifacts.find((artifact) => artifact.name === "results")!.path],
          trace: [cell.artifacts.find((artifact) => artifact.name === "trace")!.path],
          transcript: cell.artifacts.find((artifact) => artifact.name === "transcript")!.path,
        },
      };
    });
    artifactJson(`snapshots/${vendor}.json`, { runs });
  }
  artifactText("suite/daeb-1.yaml", "name: DAEB-1\nversion: 1\n");
  artifactText("methodology.md", "# Methodology\n");
  artifactText("competitive.html", "<html>previous</html>\n");
  const batchBytes = readFileSync(resolve(bundle, "provenance/batch.json"));
  const completionBytes = readFileSync(resolve(bundle, "provenance/batch-completion.json"));
  const vendorSurfaces = Object.fromEntries(batch.configuration.packs.map((pack) => [pack.vendor, pack.surfaces]));
  const manifest = {
    schema: "ax.publication-bundle/v2",
    benchmark: "DAEB-1",
    category: "database",
    suite: "suite/daeb-1.yaml",
    suite_version: 1,
    publication_readiness: "publication_ready",
    expected_matrix: {
      surfaces: [...new Set(batch.configuration.packs.flatMap((pack) => pack.surfaces))],
      harnesses: ["codex", "claude-code"],
      effort_profiles: ["high"],
      required_effort_profiles: ["high"],
      expected_cells: records.length,
    },
    quality_gates: [{ id: "records", label: "Records", status: "pass", detail: "complete" }],
    layers: {
      static_ax: { description: "static", methodology_artifacts: ["methodology.md"] },
      behavioral: { description: "behavioral", methodology_artifacts: ["methodology.md"] },
    },
    vendors: ["alpha", "beta"].map((vendor) => ({
      slug: vendor,
      expected_surfaces: vendorSurfaces[vendor],
      artifacts: { normalized_records: recordsByVendor[vendor], snapshots: [`snapshots/${vendor}.json`] },
    })),
    competitive_report: "competitive.html",
    integrity: {
      schema: "ax.publication-integrity/v1",
      source_commit_sha: batch.source_commit_sha,
      batch_id: batch.batch_id,
      configuration_hash: batch.configuration_hash,
      batch_manifest_path: "provenance/batch.json",
      batch_manifest_sha256: createHash("sha256").update(batchBytes).digest("hex"),
      batch_completion_path: "provenance/batch-completion.json",
      batch_completion_sha256: createHash("sha256").update(completionBytes).digest("hex"),
      files: [...new Set(artifactPaths)].sort().map((path) => {
        const bytes = readFileSync(resolve(bundle, path));
        return { path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
      }),
    },
  };
  writeJson(resolve(bundle, "manifest.json"), manifest);
  return { batch, records, bundleDir };
}

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) } };
}

function initializeRepository(root: string): void {
  writeFileSync(resolve(root, ".gitignore"), "results/\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init");
  git("config", "user.name", "Arena Test");
  git("config", "user.email", "arena@example.invalid");
  git("add", ".");
  git("-c", "commit.gpgSign=false", "commit", "-m", "competitive fixture");
}

describe("arena competitive reporting", () => {
  it("renders each harness dimension separately with deterministic surface order", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-competitive-render-"));
    try {
      const batch = createBatch(root);
      const { records } = createRecords(root, batch);
      const html = renderArenaCompetitiveReport(records, { batch, generatedAt: GENERATED_AT.toISOString() });
      expect(html.indexOf("api / codex leaderboard")).toBeLessThan(html.indexOf("cli / codex leaderboard"));
      expect(html).toContain("alpha / codex");
      expect(html).toContain("Cross-harness (same product + surface)");
      expect(html).toContain("batch-1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses deterministic shared ranks and highlights every tied winner", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-competitive-tie-"));
    try {
      const batch = createBatch(root);
      const { records } = createRecords(root, batch);
      const tied = records.map((value) => value.surface === "api" && value.harness === "codex"
        ? {
            ...value,
            tasks_passed: 80,
            pass_at_1: 0.8,
            pass_at_k: 0.8,
            mean_pass_rate: 0.8,
            trial_values: [0.8, 0.8, 0.8],
            range_pass_rate: { min: 0.8, max: 0.8 },
          }
        : value);
      const html = renderArenaCompetitiveReport(tied, { batch, generatedAt: GENERATED_AT.toISOString() });
      const apiCodex = html.match(/api \/ codex leaderboard<\/h3>[\s\S]*?<\/table>/)?.[0] ?? "";
      expect(apiCodex.match(/ax-rank--1/g)).toHaveLength(2);
      expect(apiCodex.match(/tied best/g)).toHaveLength(2);
      expect(apiCodex.indexOf("alpha")).toBeLessThan(apiCodex.indexOf("beta"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes structurally N/A matrices from the canonical batch", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-competitive-na-"));
    try {
      const { bundleDir } = createSealedBundle(root, ["api"]);
      initializeRepository(root);
      mkdirSync(resolve(root, "results"));
      writeArenaCompetitiveReport({
        root,
        bundleDir,
        outPath: "results/competitive.html",
        generatedAt: GENERATED_AT,
      });
      const html = readFileSync(resolve(root, "results/competitive.html"), "utf8");
      expect(html).toContain("beta / codex");
      expect(html).toContain("<dt>cells</dt><dd>6</dd>");
      const cliCodex = html.match(/cli \/ codex leaderboard<\/h3>[\s\S]*?<\/table>/)?.[0] ?? "";
      expect(cliCodex).toContain("alpha");
      expect(cliCodex).toContain("beta");
      expect(cliCodex).toContain("structural N/A");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the legacy core command functional for the compatibility period", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-competitive-legacy-"));
    try {
      const batch = createBatch(root);
      const { paths } = createRecords(root, batch);
      execFileSync(process.execPath, [
        "--import", TSX_LOADER, CORE_CLI,
        "competitive", ...paths.flatMap((path) => ["--results", path]), "--html", "legacy.html",
      ], { cwd: root, stdio: "pipe" });
      expect(readFileSync(resolve(root, "legacy.html"), "utf8")).toContain("competitive report");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("supports the sealed batch CLI, deterministic time, and ignored output roots", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-competitive-cli-"));
    try {
      const { bundleDir } = createSealedBundle(root);
      initializeRepository(root);
      mkdirSync(resolve(root, "results"));
      const output = capture();
      const code = await runArenaCli([
        "benchmark", "competitive", "--from", bundleDir,
        "--html", "results/report.html",
        "--generated-at", GENERATED_AT.toISOString(),
      ], output.io, root);
      expect(output.stderr).toEqual([]);
      expect(code).toBe(0);
      expect(output.stdout[0]).toContain("Saved competitive report");
      expect(readFileSync(resolve(root, "results/report.html"), "utf8")).toContain(GENERATED_AT.toISOString());

      const missing = capture();
      await expect(runArenaCli(["benchmark", "competitive"], missing.io, root)).resolves.toBe(1);
      expect(missing.stderr[0]).toContain("missing required flag --from");
      const unsafe = capture();
      await expect(runArenaCli([
        "benchmark", "competitive", "--from", bundleDir, "--html", "tracked.html",
      ], unsafe.io, root)).resolves.toBe(1);
      expect(unsafe.stderr[0]).toContain("repository-ignored");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects mixed, duplicate, incomplete, and non-production cohorts", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-competitive-cohort-"));
    try {
      const batch = createBatch(root);
      const { records } = createRecords(root, batch);
      const mixed = { ...records[0], run_batch_id: "different-batch" };
      expect(() => renderArenaCompetitiveReport([mixed, ...records.slice(1)], { batch }))
        .toThrow(/sealed batch ID/);

      expect(() => renderArenaCompetitiveReport([...records, records[0]], { batch }))
        .toThrow(/duplicate/);
      expect(() => renderArenaCompetitiveReport(records.slice(0, -1), { batch }))
        .toThrow(/complete product, harness, and surface matrix/);

      const single = { ...records[0], summary_kind: "single" };
      expect(() => renderArenaCompetitiveReport([single, ...records.slice(1)], { batch }))
        .toThrow(/three-trial high-effort aggregates/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects tampered bundles and unsafe public-writer outputs without side effects", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-competitive-safety-"));
    const outside = mkdtempSync(resolve(tmpdir(), "ax-arena-competitive-outside-"));
    try {
      const { bundleDir } = createSealedBundle(root);
      writeFileSync(resolve(root, "README.md"), "tracked\n");
      initializeRepository(root);
      mkdirSync(resolve(root, "results"));
      const manifest = JSON.parse(readFileSync(resolve(root, bundleDir, "manifest.json"), "utf8"));
      const aggregatePath = manifest.vendors[0].artifacts.normalized_records[0];
      const aggregateSource = readFileSync(resolve(root, bundleDir, aggregatePath));
      const aggregate = JSON.parse(aggregateSource.toString("utf8"));
      aggregate.pass_at_1 = 1;
      writeJson(resolve(root, bundleDir, aggregatePath), aggregate);
      expect(() => writeArenaCompetitiveReport({ root, bundleDir, outPath: "results/tampered.html" }))
        .toThrow(/byte length mismatch|SHA-256 mismatch/);
      expect(existsSync(resolve(root, "results/tampered.html"))).toBe(false);
      writeFileSync(resolve(root, bundleDir, aggregatePath), aggregateSource);

      symlinkSync(outside, resolve(root, "results/link"));
      expect(() => writeArenaCompetitiveReport({ root, bundleDir, outPath: "results/link/new/report.html" }))
        .toThrow(/real directory|symlink/);
      expect(existsSync(resolve(outside, "new"))).toBe(false);

      expect(() => writeArenaCompetitiveReport({ root, bundleDir, outPath: "README.md" }))
        .toThrow(/protected source path|repository-ignored/);
      expect(readFileSync(resolve(root, "README.md"), "utf8")).toBe("tracked\n");
      expect(() => writeArenaCompetitiveReport({ root, bundleDir, outPath: "results/missing/report.html" }))
        .toThrow(/ENOENT|existing regular directory/);
      expect(existsSync(resolve(root, "results/missing"))).toBe(false);
      expect(() => writeArenaCompetitiveReport({ root, bundleDir, outPath: "bundle/report.html" }))
        .toThrow(/must not overlap/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
