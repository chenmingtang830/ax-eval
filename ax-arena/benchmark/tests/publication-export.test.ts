import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
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
} from "../src/controller/schemas.js";
import { buildArenaPublicationExport } from "../src/publication/export.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CORE_CLI = resolve(REPOSITORY_ROOT, "src", "cli.ts");
const TSX_LOADER = fileURLToPath(import.meta.resolve("tsx"));
const GENERATED_AT = new Date("2026-07-21T00:00:00.000Z");

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function record(input: {
  product: string;
  surface: "api" | "cli";
  harness: "codex" | "claude-code";
  rate: number;
  generatedAt: string;
  sourceRecords: string[];
}): Record<string, unknown> {
  return {
    schema: "ax.normalized-result/v1",
    surface: input.surface,
    product: input.product,
    harness: input.harness,
    standard_set_version: "DAEB-1-v1",
    generated_at: input.generatedAt,
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
    trial_stability_at_3: input.rate === 1 ? "all_pass" : input.rate === 0 ? "all_fail" : "inconsistent",
    source_records: input.sourceRecords,
  };
}

function createBundle(root: string, options: { betaSurfaces?: Array<"api" | "cli"> } = {}): string {
  const bundle = resolve(root, "bundle");
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
  const harnesses = ["codex", "claude-code"] as const;
  const vendorSurfaces: Record<string, Array<"api" | "cli">> = {
    alpha: ["api", "cli"],
    beta: options.betaSurfaces ?? ["api", "cli"],
  };
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
  const batchCells: Array<Record<string, unknown>> = [];
  const completionCells: Array<Record<string, any>> = [];
  const sourceRecords = new Map<string, string[]>();
  for (const [vendor, surfaces] of Object.entries(vendorSurfaces)) {
    for (const surface of surfaces) {
      for (const harness of harnesses) {
        for (const trial of [1, 2, 3]) {
          const key = `${vendor}/${surface}/${harness}/trial-${trial}`;
          const base = `provenance/cells/${key}`;
          const recordPath = `${base}/record.json`;
          const cleanupPath = `${base}/cleanup.json`;
          const cohort = `${vendor}/${surface}/${harness}`;
          const rate = rates[cohort]!;
          const recordId = `record-${vendor}-${surface}-${harness}-${trial}`;
          const artifactSpecs = [
            ["invoke_metadata", `${base}/invoke-metadata.json`, { exit_code: 0 }],
            ["results", `${base}/results.json`, { ok: true }],
            ["trace", `${base}/trace.json`, []],
            ["transcript", `${base}/transcript.jsonl`, { event: "completed" }],
          ] as const;
          const taskResults = Array.from({ length: 100 }, (_, index) => ({
            taskId: `task-${String(index + 1).padStart(3, "0")}`,
            difficulty: "medium",
            profile: "high",
            success: index < Math.round(rate * 100),
            oracleResults: [{ type: "fixture", passed: index < Math.round(rate * 100), detail: "fixture" }],
            error: index < Math.round(rate * 100) ? null : "verification failed",
            na: false,
          }));
          artifactJson(recordPath, {
            schema: "ax.normalized-cell-record/v1",
            surface,
            product: vendor,
            harness,
            standard_set_version: "DAEB-1-v1",
            generated_at: "2026-07-20T00:30:00.000Z",
            tasks_total: 100,
            tasks_passed: Math.round(rate * 100),
            pass_at_1: rate,
            pass_at_k: rate,
            attempts: 1,
            discovery_score: null,
            content_quality: null,
            profiles: ["high"],
            best_profile: "high",
            model: harness === "codex" ? "gpt-5.6-terra" : "claude-sonnet-5",
            harness_version_raw: harness === "codex" ? "codex-cli 1.2.3" : "claude-code 2.3.4",
            harness_version_semver: harness === "codex" ? "1.2.3" : "2.3.4",
            run_batch_id: "batch-1",
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
            batch_id: "batch-1",
            evaluation_set_id: "DAEB-1",
            evaluation_set_version: "DAEB-1-v1",
            pack_content_hash: (vendor === "alpha" ? "1" : "2").repeat(64),
            source_commit_sha: "a".repeat(40),
            execution_namespace: `fixture-${vendor}-${surface}-${harness}-${trial}`,
            target_id: vendor,
            trial,
            effort: "high",
            requested_model: harness === "codex" ? "gpt-5.6-terra" : "claude-sonnet-5",
            started_at: "2026-07-20T00:00:00.000Z",
            completed_at: "2026-07-20T00:30:00.000Z",
            status: "completed",
            error: null,
            provider_provenance: [{ kind: "oracle", id: "fixture-oracle", version: "1.0.0" }],
            task_results: taskResults,
            artifacts: {
              base_dir: base,
              results: "results.json",
              trace: "trace.json",
              transcript: "transcript.jsonl",
              invoke_metadata: "invoke-metadata.json",
            },
          });
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
            provider: { id: `fixture-${vendor}-reset`, version: "1.0.0" },
            namespace: `fixture-${vendor}-${surface}-${harness}-${trial}`,
            plan: { summary: "fixture cleanup", resources: [`resource-${trial}`] },
            evidence: {
              supported: true,
              message: "fixture cleanup confirmed",
              deleted: [`resource-${trial}`],
              errors: [],
            },
            message: "cleanup confirmed",
            errors: [],
          });
          const cleanupBytes = readFileSync(resolve(bundle, cleanupPath));
          completionCells.push({
            key,
            record_id: recordId,
            record_path: recordPath,
            record_hash: recordHash,
            cleanup_path: cleanupPath,
            cleanup_hash: createHash("sha256").update(cleanupBytes).digest("hex"),
            artifacts: seals,
            harness,
            requested_model: harness === "codex" ? "gpt-5.6-terra" : "claude-sonnet-5",
            actual_model: harness === "codex" ? "gpt-5.6-terra" : "claude-sonnet-5",
            harness_version_raw: harness === "codex" ? "codex-cli 1.2.3" : "claude-code 2.3.4",
            harness_version_semver: harness === "codex" ? "1.2.3" : "2.3.4",
            status: "completed",
            cleanup_status: "confirmed",
          });
          batchCells.push({
            key,
            vendor,
            surface,
            harness,
            profile: "high",
            effort: "high",
            model: harness === "codex" ? "gpt-5.6-terra" : "claude-sonnet-5",
            trial,
            host_credential_names: [],
            verification_credential_names: [],
            reset_credential_names: [],
            sandbox_scope_names: [],
            provider_pins: [{ kind: "oracle", id: "fixture-oracle", version: "1.0.0" }],
            reset_provider: { id: `fixture-${vendor}-reset`, version: "1.0.0" },
          });
          sourceRecords.set(cohort, [...(sourceRecords.get(cohort) ?? []), recordPath]);
        }
      }
    }
  }
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
    cells: batchCells,
    harnesses: [
      { harness: "codex" as const, version_raw: "codex-cli 1.2.3", version_semver: "1.2.3" },
      { harness: "claude-code" as const, version_raw: "claude-code 2.3.4", version_semver: "2.3.4" },
    ],
    reset_required: true,
    invoke_timeout_seconds: 900,
    first_action_timeout_seconds: 120,
    invoke_retries: 0,
  };
  const configurationHash = arenaBatchConfigurationHash(configuration as any);
  const batch = ArenaBatchManifestSchema.parse({
    schema: "ax.arena-batch/v1",
    batch_id: "batch-1",
    source_commit_sha: "a".repeat(40),
    created_at: "2026-07-20T00:00:00.000Z",
    configuration_hash: configurationHash,
    configuration,
    expected_cells: batchCells.map((cell) => cell.key),
  });
  const completion = ArenaBatchCompletionSchema.parse({
    schema: "ax.arena-batch-completion/v1",
    batch_id: batch.batch_id,
    source_commit_sha: batch.source_commit_sha,
    configuration_hash: batch.configuration_hash,
    completed_at: "2026-07-20T01:00:00.000Z",
    cells: completionCells,
  });
  artifactJson("provenance/batch.json", batch);
  artifactJson("provenance/batch-completion.json", completion);

  const recordPathsByVendor: Record<string, string[]> = { alpha: [], beta: [] };
  for (const [cohort, sources] of sourceRecords) {
    const [product, surface, harness] = cohort.split("/") as [string, "api" | "cli", "codex" | "claude-code"];
    const path = `records/${product}-${surface}-${harness}.aggregate.json`;
    artifactJson(path, record({
      product,
      surface,
      harness,
      rate: rates[cohort]!,
      generatedAt: "2026-07-20T01:30:00.000Z",
      sourceRecords: sources,
    }));
    recordPathsByVendor[product]!.push(path);
  }
  const snapshotCell = completion.cells.find((cell) => cell.key === "alpha/api/codex/trial-1")!;
  writeJson(resolve(bundle, "snapshots/alpha.json"), {
    runs: [{
      profile: "high",
      harness: "codex",
      surface: "api",
      model: "gpt-5.6-terra",
      outcomes: [
        { taskId: "db-create", success: true, status: "pass" },
        { taskId: "db-query", success: false, status: "fail" },
      ],
      evidence: {
        results: [snapshotCell.artifacts.find((artifact) => artifact.name === "results")!.path],
        trace: [snapshotCell.artifacts.find((artifact) => artifact.name === "trace")!.path],
        transcript: snapshotCell.artifacts.find((artifact) => artifact.name === "transcript")!.path,
      },
    }],
  });
  artifactPaths.push("snapshots/alpha.json");
  artifactText("reports/alpha.html", "<html>alpha</html>\n");
  artifactText("suite/daeb-1.yaml", "name: DAEB-1\nversion: 1\n");
  artifactText("methodology.md", "# Methodology\n");
  artifactText("competitive.html", "<html>competitive</html>\n");
  const manifest = {
    schema: "ax.publication-bundle/v2",
    benchmark: "DAEB-1",
    category: "database",
    suite: "suite/daeb-1.yaml",
    suite_version: 1,
    expected_matrix: {
      surfaces: ["api", "cli"],
      harnesses: ["codex", "claude-code"],
      effort_profiles: ["high"],
      required_effort_profiles: ["high"],
      expected_cells: Object.values(vendorSurfaces).reduce((sum, surfaces) => sum + surfaces.length * harnesses.length, 0),
    },
    quality_gates: [{ id: "records", label: "Records", status: "pass", detail: "complete" }],
    layers: {
      static_ax: { description: "static", methodology_artifacts: ["methodology.md"] },
      behavioral: { description: "behavioral", methodology_artifacts: ["methodology.md"] },
    },
    vendors: [
      {
        slug: "alpha",
        expected_surfaces: vendorSurfaces.alpha,
        artifacts: {
          normalized_records: recordPathsByVendor.alpha,
          snapshots: ["snapshots/alpha.json"],
          report_htmls: ["reports/alpha.html"],
        },
      },
      {
        slug: "beta",
        expected_surfaces: vendorSurfaces.beta,
        artifacts: {
          normalized_records: recordPathsByVendor.beta,
          snapshots: [],
          report_htmls: [],
        },
      },
    ],
    publication_readiness: "publication_ready",
    competitive_report: "competitive.html",
    integrity: {
      schema: "ax.publication-integrity/v1",
      source_commit_sha: "a".repeat(40),
      batch_id: "batch-1",
      configuration_hash: batch.configuration_hash,
      batch_manifest_path: "provenance/batch.json",
      batch_manifest_sha256: createHash("sha256").update(readFileSync(resolve(bundle, "provenance/batch.json"))).digest("hex"),
      batch_completion_path: "provenance/batch-completion.json",
      batch_completion_sha256: createHash("sha256").update(readFileSync(resolve(bundle, "provenance/batch-completion.json"))).digest("hex"),
      files: [...new Set(artifactPaths)].sort().map((path) => {
        const bytes = readFileSync(resolve(bundle, path));
        return { path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
      }),
    },
  };
  writeJson(resolve(bundle, "manifest.json"), manifest);
  return bundle;
}

function resealArtifact(root: string, path: string): void {
  const manifestPath = resolve(root, "bundle/manifest.json");
  const manifest = parse(manifestPath);
  const entry = manifest.integrity.files.find((candidate: { path: string }) => candidate.path === path);
  const bytes = readFileSync(resolve(root, "bundle", path));
  entry.bytes = bytes.length;
  entry.sha256 = createHash("sha256").update(bytes).digest("hex");
  writeJson(manifestPath, manifest);
}

function initializeRepository(root: string): void {
  writeFileSync(resolve(root, ".gitignore"), "*-out\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init");
  git("config", "user.name", "Arena Test");
  git("config", "user.email", "arena@example.invalid");
  git("add", ".");
  git("-c", "commit.gpgSign=false", "commit", "-m", "publication export fixture");
}

function parse(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function withoutGeneratedAt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutGeneratedAt);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    key,
    key === "generated_at" ? "<generated>" : withoutGeneratedAt(child),
  ]));
}

describe("arena publication export", () => {
  it("writes all seven indexes with legacy semantic parity and deterministic time", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-export-"));
    try {
      createBundle(root);
      const manifest = buildArenaPublicationExport({
        root,
        bundleDir: "bundle",
        outDir: "arena-out",
        generatedAt: GENERATED_AT,
      });
      expect(manifest.files).toHaveLength(7);
      for (const file of manifest.files) expect(existsSync(resolve(root, "arena-out", file.path))).toBe(true);
      const leaderboard = parse(resolve(root, "arena-out/leaderboard.json"));
      const codex = leaderboard.agents.find((agent: { harness: string }) => agent.harness === "codex");
      expect(codex.views.overall.rows.map((row: { vendor: string }) => row.vendor)).toEqual(["beta", "alpha"]);
      expect(codex.views.overall.rows.find((row: { vendor: string }) => row.vendor === "alpha").mean_pass_at_1).toBe(0.7);
      expect(parse(resolve(root, "arena-out/failures.json")).failures[0].task_id).toBe("db-query");
      expect(parse(resolve(root, "arena-out/tasks.json")).tasks).toHaveLength(2);
      const cells = parse(resolve(root, "arena-out/cells.json"));
      expect(cells.generated_at).toBe(GENERATED_AT.toISOString());
      expect(cells.cells).toHaveLength(8);
      expect(new Set(cells.cells.map((cell: { id: string }) => cell.id)).size).toBe(8);

      execFileSync(process.execPath, [
        "--import", TSX_LOADER, CORE_CLI,
        "export-publication", "--from", "bundle", "--out", "core-out",
      ], { cwd: root, stdio: "pipe" });
      for (const name of manifest.files.map((file) => file.path)) {
        expect(withoutGeneratedAt(parse(resolve(root, "arena-out", name))))
          .toEqual(withoutGeneratedAt(parse(resolve(root, "core-out", name))));
      }
      expect(parse(resolve(root, "arena-out/manifest.json")).source_integrity)
        .toEqual(parse(resolve(root, "bundle/manifest.json")).integrity);

      const stdout: string[] = [];
      const stderr: string[] = [];
      const io: CliIo = { stdout: (message) => stdout.push(message), stderr: (message) => stderr.push(message) };
      initializeRepository(root);
      await expect(runArenaCli([
        "benchmark", "export-publication",
        "--from", "bundle",
        "--out", "cli-out",
        "--generated-at", GENERATED_AT.toISOString(),
      ], io, root)).resolves.toBe(0);
      expect(stderr).toEqual([]);
      expect(stdout[2]).toBe("7 export file(s) for DAEB-1.");
      expect(parse(resolve(root, "cli-out/manifest.json")).generated_at).toBe(GENERATED_AT.toISOString());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for unsealed or tampered publication bundles", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-export-integrity-"));
    try {
      createBundle(root);
      const manifestPath = resolve(root, "bundle/manifest.json");
      const manifest = parse(manifestPath);
      delete manifest.integrity;
      writeJson(manifestPath, manifest);
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "unsealed-out" }))
        .toThrow();
      expect(existsSync(resolve(root, "unsealed-out"))).toBe(false);

      createBundle(root);
      writeFileSync(resolve(root, "bundle/methodology.md"), "# Tampered\n");
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "tampered-out" }))
        .toThrow(/byte length mismatch|SHA-256 mismatch/);
      expect(existsSync(resolve(root, "tampered-out"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds exports to canonical batch provenance and every nested evidence path", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-export-provenance-"));
    try {
      createBundle(root);
      const manifestPath = resolve(root, "bundle/manifest.json");
      const manifest = parse(manifestPath);
      manifest.integrity.source_commit_sha = "f".repeat(40);
      writeJson(manifestPath, manifest);
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "source-out" }))
        .toThrow(/production batch provenance/);

      createBundle(root);
      const snapshotPath = "snapshots/alpha.json";
      const snapshot = parse(resolve(root, "bundle", snapshotPath));
      snapshot.runs[0].evidence.results = ["methodology.md"];
      writeJson(resolve(root, "bundle", snapshotPath), snapshot);
      resealArtifact(root, snapshotPath);
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "evidence-out" }))
        .toThrow(/outside the completed batch/);

      createBundle(root);
      const aggregatePath = "records/alpha-api-codex.aggregate.json";
      const aggregate = parse(resolve(root, "bundle", aggregatePath));
      aggregate.source_records[0] = "methodology.md";
      writeJson(resolve(root, "bundle", aggregatePath), aggregate);
      resealArtifact(root, aggregatePath);
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "source-record-out" }))
        .toThrow(/source outside the completed batch/);

      createBundle(root);
      const scorePath = "records/alpha-api-codex.aggregate.json";
      const score = parse(resolve(root, "bundle", scorePath));
      score.pass_at_1 = 1;
      score.mean_pass_rate = 1;
      score.trial_values = [1, 1, 1];
      score.range_pass_rate = { min: 1, max: 1 };
      score.tasks_passed = 100;
      score.task_consistency_at_3 = 1;
      score.pass_3_tasks = 100;
      score.pass_all_3 = 1;
      score.trial_stability_at_3 = "all_pass";
      writeJson(resolve(root, "bundle", scorePath), score);
      resealArtifact(root, scorePath);
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "score-out" }))
        .toThrow(/aggregate metrics do not match completed trials/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts structural N/A surfaces using each sealed vendor matrix", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-export-structural-na-"));
    try {
      createBundle(root, { betaSurfaces: ["api"] });
      buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "arena-out", generatedAt: GENERATED_AT });
      const cells = parse(resolve(root, "arena-out/cells.json")).cells;
      expect(cells).toHaveLength(6);
      expect(cells.some((cell: { vendor: string; surface: string }) =>
        cell.vendor === "beta" && cell.surface === "cli")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects sealed but incomparable leaderboard cohorts", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-export-comparability-"));
    try {
      createBundle(root);
      const recordPath = "records/beta-api-codex.aggregate.json";
      const mismatched = parse(resolve(root, "bundle", recordPath));
      mismatched.model = "different-codex-model";
      writeJson(resolve(root, "bundle", recordPath), mismatched);
      resealArtifact(root, recordPath);
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "mixed-out" }))
        .toThrow(/one model and one exact harness version/);
      expect(existsSync(resolve(root, "mixed-out"))).toBe(false);

      createBundle(root);
      const manifestPath = resolve(root, "bundle/manifest.json");
      const manifest = parse(manifestPath);
      manifest.vendors[1].artifacts.normalized_records.pop();
      writeJson(manifestPath, manifest);
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "incomplete-out" }))
        .toThrow(/one comparable aggregate for every expected/);
      expect(existsSync(resolve(root, "incomplete-out"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal and absolute artifact paths without partial output", () => {
    for (const malicious of ["../escape.json", resolve(tmpdir(), "escape.json")]) {
      const root = mkdtempSync(resolve(tmpdir(), "ax-arena-export-path-"));
      try {
        createBundle(root);
        const manifestPath = resolve(root, "bundle/manifest.json");
        const manifest = parse(manifestPath);
        manifest.vendors[0].artifacts.normalized_records[0] = malicious;
        writeJson(manifestPath, manifest);
        expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "out" }))
          .toThrow(/canonical contained relative path|escapes|does not cover/);
        expect(existsSync(resolve(root, "out"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects symlinked and invalid inputs before writing output", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-export-symlink-"));
    try {
      createBundle(root);
      const recordPath = resolve(root, "bundle/records/alpha-api-codex.aggregate.json");
      const targetPath = resolve(root, "record-target.json");
      writeFileSync(targetPath, readFileSync(recordPath));
      unlinkSync(recordPath);
      symlinkSync(targetPath, recordPath);
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "symlink-out" }))
        .toThrow(/symlink/);
      expect(existsSync(resolve(root, "symlink-out"))).toBe(false);

      rmSync(resolve(root, "bundle"), { recursive: true, force: true });
      createBundle(root);
      writeFileSync(resolve(root, "bundle/snapshots/alpha.json"), "{");
      resealArtifact(root, "snapshots/alpha.json");
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "invalid-out" }))
        .toThrow(/not valid JSON/);
      expect(existsSync(resolve(root, "invalid-out"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects oversized JSON and unsafe output directories", () => {
    const root = mkdtempSync(resolve(tmpdir(), "ax-arena-export-bounds-"));
    try {
      createBundle(root);
      truncateSync(resolve(root, "bundle/records/alpha-api-codex.aggregate.json"), 16 * 1024 * 1024 + 1);
      resealArtifact(root, "records/alpha-api-codex.aggregate.json");
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "oversized-out" }))
        .toThrow(/16 MiB/);
      expect(existsSync(resolve(root, "oversized-out"))).toBe(false);

      rmSync(resolve(root, "bundle"), { recursive: true, force: true });
      createBundle(root);
      mkdirSync(resolve(root, "existing-out"));
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "existing-out" }))
        .toThrow(/must not already exist/);
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "bundle/output" }))
        .toThrow(/must not overlap/);
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: ".github/export" }))
        .toThrow(/protected repository path/);
      expect(() => buildArenaPublicationExport({ root, bundleDir: "bundle", outDir: "../outside" }))
        .toThrow(/repository root/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
