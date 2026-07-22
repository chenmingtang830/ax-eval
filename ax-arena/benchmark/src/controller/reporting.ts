import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  NormalizedCellRecordSchema,
  aggregateNormalizedResults,
  loadPack,
  observedToTrace,
  packFileContentHash,
  parseTranscriptContent,
  renderGeneratedSnapshot,
  type GeneratedReportSnapshot,
  type HarnessProbe,
  type NormalizedCellRecord,
  type NormalizedResult,
  type ProfileRun,
  type SurfaceId,
  type TargetPack,
} from "ax-eval";
import { assertBatchManifest } from "./batch.js";
import { arenaCellId } from "./cell.js";
import {
  ARENA_RUNTIME_REPORT_SCHEMA,
  ArenaBatchCompletionSchema,
  ArenaBatchManifestSchema,
  ArenaCellCleanupSchema,
  ArenaRuntimeReportSchema,
  type ArenaBatchManifest,
  type ArenaCellCleanupRecord,
  type ArenaRuntimeReport,
} from "./schemas.js";

export interface RuntimeReportingOptions {
  runRoot: string;
  batch: ArenaBatchManifest;
  packPaths: Readonly<Record<string, string>>;
  harness: HarnessProbe;
  now: Date;
  minPassRate?: number;
}

function pathEscapes(path: string): boolean {
  return path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path);
}

function readRunFile(runRoot: string, path: string, label: string): { bytes: Buffer; relativePath: string } {
  const rootStat = lstatSync(runRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("arena reporting run root must be a regular directory");
  }
  const root = realpathSync(runRoot);
  const absolute = resolve(runRoot, path);
  const lexical = relative(resolve(runRoot), absolute);
  if (!lexical || pathEscapes(lexical)) throw new Error(`${label} is outside the arena run root`);
  let current = resolve(runRoot);
  for (const segment of lexical.split(/[\\/]/)) {
    current = resolve(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} cannot traverse a symlink`);
  }
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  const physical = relative(root, realpathSync(absolute));
  if (!physical || pathEscapes(physical)) throw new Error(`${label} escaped the physical arena run root`);
  return { bytes: readFileSync(absolute), relativePath: lexical.replaceAll("\\", "/") };
}

function parseCanonical<T>(bytes: Buffer, parse: (input: unknown) => T, label: string): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  const parsed = parse(decoded);
  if (bytes.toString("utf8") !== `${JSON.stringify(parsed, null, 2)}\n`) {
    throw new Error(`${label} is not in canonical persisted form`);
  }
  return parsed;
}

function prepareOutput(runRoot: string, path: string): void {
  const root = resolve(runRoot);
  const lexical = relative(root, resolve(path));
  if (!lexical || pathEscapes(lexical)) throw new Error("report output is outside the arena run root");
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("arena run root must be a regular directory");
  let current = root;
  for (const segment of dirname(lexical).split(/[\\/]/).filter((entry) => entry && entry !== ".")) {
    current = resolve(current, segment);
    try {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`report output parent is unsafe: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
  }
}

function assertOutputAvailable(runRoot: string, path: string): void {
  prepareOutput(runRoot, path);
  try {
    lstatSync(path);
    throw new Error(`refusing to overwrite existing runtime report artifact: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function exclusiveJson(runRoot: string, path: string, value: unknown): void {
  prepareOutput(runRoot, path);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

function exclusiveText(runRoot: string, path: string, value: string): void {
  prepareOutput(runRoot, path);
  writeFileSync(path, value, { flag: "wx", mode: 0o600 });
}

function artifactPath(runRoot: string, record: NormalizedCellRecord, name: string, label: string) {
  if (isAbsolute(name) || dirname(name) !== "." || name === "." || name === "..") {
    throw new Error(`${label} name must be a direct relative file name`);
  }
  const base = resolve(record.artifacts.base_dir);
  const baseStat = lstatSync(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error(`${label} base must be a regular directory`);
  const candidate = resolve(base, name);
  const lexical = relative(base, candidate);
  if (!lexical || pathEscapes(lexical)) throw new Error(`${label} escaped its declared artifact directory`);
  const file = readRunFile(runRoot, candidate, label);
  const physical = relative(realpathSync(base), realpathSync(candidate));
  if (!physical || pathEscapes(physical)) throw new Error(`${label} escaped its physical artifact directory`);
  return file;
}

function profileRun(
  runRoot: string,
  pack: TargetPack,
  record: NormalizedCellRecord,
  cleanup: ArenaCellCleanupRecord,
): ProfileRun {
  const results = artifactPath(runRoot, record, record.artifacts.results, "results artifact");
  const trace = artifactPath(runRoot, record, record.artifacts.trace, "trace artifact");
  const transcript = artifactPath(runRoot, record, record.artifacts.transcript, "transcript artifact");
  const observed = parseTranscriptContent(transcript.bytes.toString("utf8"), {
    baseUrl: pack.base_url.includes("${") ? undefined : pack.base_url,
    cliBin: pack.surfaces?.cli?.bin,
    sdkPackage: pack.surfaces?.sdk?.package,
    mcpServer: pack.surfaces?.mcp?.server,
  });
  const transcriptAfter = readRunFile(runRoot, resolve(runRoot, transcript.relativePath), "transcript artifact");
  if (!transcript.bytes.equals(transcriptAfter.bytes)) throw new Error("transcript artifact changed while reporting");
  return {
    profile: record.best_profile ?? record.profiles[0]!,
    harness: record.harness,
    model: record.model ?? record.requested_model,
    surface: record.surface,
    ns: cleanup.namespace,
    outcomes: record.task_results,
    // Process diagnostics must come from the harness-native event stream. The
    // executor trace remains linked below for review, but is model-authored and
    // therefore cannot be trusted as evidence of which calls actually ran.
    trace: observedToTrace(observed),
    discovery: record.discovery,
    discoverySource: record.discovery_source,
    efficiency: {
      latency_ms: record.latency_ms,
      total_duration_ms: record.total_duration_ms,
      tool_call_count: record.tool_call_count,
      token_usage: record.token_usage,
      token_cost: record.token_cost,
      cost_usd: record.cost_usd,
      harness_version_raw: record.harness_version_raw,
      harness_version_semver: record.harness_version_semver,
      run_batch_id: record.run_batch_id,
      validity_status: record.validity_status,
      first_action_latency_ms: record.first_action_latency_ms,
      transcript_event_count: record.transcript_event_count,
      action_occurred: record.action_occurred,
    },
    evidence: {
      results: [results.relativePath],
      trace: [trace.relativePath],
      transcript: transcript.relativePath,
    },
  };
}

function normalizedResult(record: NormalizedCellRecord): NormalizedResult {
  return {
    schema: "ax.normalized-result/v1",
    surface: record.surface,
    product: record.product,
    harness: record.harness,
    standard_set_version: record.standard_set_version,
    generated_at: record.generated_at,
    tasks_total: record.tasks_total,
    tasks_passed: record.tasks_passed,
    pass_at_1: record.pass_at_1,
    pass_at_k: record.pass_at_k,
    attempts: record.attempts,
    discovery_score: record.discovery_score,
    content_quality: record.content_quality,
    profiles: record.profiles,
    best_profile: record.best_profile,
    model: record.model,
    harness_version_raw: record.harness_version_raw,
    harness_version_semver: record.harness_version_semver,
    run_batch_id: record.run_batch_id,
    latency_ms: record.latency_ms,
    total_duration_ms: record.total_duration_ms,
    tool_call_count: record.tool_call_count,
    token_usage: record.token_usage,
    token_cost: record.token_cost,
    cost_usd: record.cost_usd,
    tokens_in: record.tokens_in,
    tokens_out: record.tokens_out,
    validity_status: record.validity_status,
    first_action_latency_ms: record.first_action_latency_ms,
    transcript_event_count: record.transcript_event_count,
    action_occurred: record.action_occurred,
    summary_kind: "single",
  };
}

function taskConsistency(records: readonly NormalizedCellRecord[]) {
  if (records.length !== 3) return null;
  const taskIds = new Set(records.flatMap((record) =>
    record.task_results.filter((task) => !task.na).map((task) => task.taskId)));
  if (!taskIds.size) return null;
  const count = [...taskIds].filter((taskId) => records.every((record) =>
    record.task_results.some((task) => task.taskId === taskId && !task.na && task.success))).length;
  return { rate: count / taskIds.size, count, total: taskIds.size };
}

function failureReview(records: readonly NormalizedCellRecord[]): string {
  const failures = records.flatMap((record) => record.task_results
    .filter((task) => !task.na && !task.success)
    .map((task) => `- ${record.harness}/${record.surface}/${task.taskId}: ${task.error ?? "verification failed"}`))
    .sort();
  return [
    "# AXArena runtime failure review",
    "",
    ...(failures.length ? failures : ["- failed_tasks: none"]),
    "",
  ].join("\n");
}

function loadPacks(batch: ArenaBatchManifest, paths: Readonly<Record<string, string>>): Map<string, TargetPack> {
  const packs = new Map<string, TargetPack>();
  for (const configured of batch.configuration.packs) {
    const path = paths[configured.vendor];
    if (!path) throw new Error(`runtime reporting requires the canonical ${configured.vendor} pack path`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`runtime reporting pack must be a regular file: ${path}`);
    if (packFileContentHash(path) !== configured.file_hash) throw new Error(`runtime reporting pack hash drifted: ${configured.vendor}`);
    const pack = loadPack(path);
    if (pack.name !== configured.vendor || pack.standard_set_version !== configured.standard_set_version) {
      throw new Error(`runtime reporting pack identity drifted: ${configured.vendor}`);
    }
    packs.set(configured.vendor, pack);
  }
  return packs;
}

export function writeRuntimeReportingBundle(options: RuntimeReportingOptions): ArenaRuntimeReport {
  const minPassRate = options.minPassRate ?? 0.8;
  if (!Number.isFinite(minPassRate) || minPassRate < 0 || minPassRate > 1) {
    throw new Error("runtime reporting minPassRate must be a finite number from 0 to 1");
  }
  const runRoot = resolve(options.runRoot);
  const batch = ArenaBatchManifestSchema.parse(options.batch);
  assertBatchManifest(runRoot, batch);
  const completionFile = readRunFile(runRoot, "batch-completion.json", "batch completion");
  const completion = parseCanonical(completionFile.bytes, (input) => ArenaBatchCompletionSchema.parse(input), "batch completion");
  if (completion.batch_id !== batch.batch_id
    || completion.source_commit_sha !== batch.source_commit_sha
    || completion.configuration_hash !== batch.configuration_hash) {
    throw new Error("batch completion does not match the immutable batch manifest");
  }
  const expectedKeys = [...batch.expected_cells].sort();
  const actualKeys = completion.cells.map((cell) => cell.key).sort();
  if (new Set(actualKeys).size !== actualKeys.length
    || expectedKeys.length !== actualKeys.length
    || expectedKeys.some((key, index) => key !== actualKeys[index])) {
    throw new Error("batch completion does not contain the exact configured cell set");
  }
  const packs = loadPacks(batch, options.packPaths);
  const cells = completion.cells.map((cell) => {
    const recordFile = readRunFile(runRoot, cell.record_path, `record ${cell.key}`);
    const cleanupFile = readRunFile(runRoot, cell.cleanup_path, `cleanup ${cell.key}`);
    const recordHash = createHash("sha256").update(recordFile.bytes).digest("hex");
    if (recordHash !== cell.record_hash
      || createHash("sha256").update(cleanupFile.bytes).digest("hex") !== cell.cleanup_hash) {
      throw new Error(`completed batch sidecar hash drifted: ${cell.key}`);
    }
    const record = parseCanonical(recordFile.bytes, (input) => NormalizedCellRecordSchema.parse(input), `record ${cell.key}`);
    const cleanup = parseCanonical(cleanupFile.bytes, (input) => ArenaCellCleanupSchema.parse(input), `cleanup ${cell.key}`);
    const key = `${record.target_id}/${record.surface}/${record.harness}/trial-${record.trial}`;
    const configured = batch.configuration.cells.find((candidate) => candidate.key === cell.key);
    const configuredPack = batch.configuration.packs.find((candidate) => candidate.vendor === record.target_id);
    const pin = batch.configuration.harnesses.find((candidate) => candidate.harness === record.harness);
    const expectedCellId = configured && configuredPack ? arenaCellId({
      batchId: batch.batch_id,
      evaluationSetId: batch.configuration.suite.name,
      targetId: configured.vendor,
      surface: configured.surface,
      harness: configured.harness,
      profile: configured.profile,
      model: configured.model,
      effort: configured.effort,
      trial: configured.trial,
      sourceCommitSha: batch.source_commit_sha,
    }, configuredPack.file_hash) : undefined;
    if (!configured || !configuredPack || !pin || record.cell_id !== expectedCellId
      || key !== cell.key
      || record.record_id !== cell.record_id
      || record.cell_id !== cell.record_id
      || record.batch_id !== batch.batch_id
      || record.run_batch_id !== batch.batch_id
      || record.source_commit_sha !== batch.source_commit_sha
      || record.evaluation_set_id !== batch.configuration.suite.name
      || record.evaluation_set_version !== configuredPack.standard_set_version
      || record.standard_set_version !== configuredPack.standard_set_version
      || record.pack_content_hash !== configuredPack.file_hash
      || record.product !== configured.vendor
      || record.target_id !== configured.vendor
      || record.surface !== configured.surface
      || record.harness !== configured.harness
      || record.profiles.length !== 1
      || record.profiles[0] !== configured.profile
      || record.best_profile !== configured.profile
      || record.effort !== configured.effort
      || record.requested_model !== configured.model
      || record.model !== configured.model
      || record.harness_version_raw !== pin.version_raw
      || record.harness_version_semver !== pin.version_semver
      || record.status !== "completed"
      || cell.harness !== configured.harness
      || cell.requested_model !== configured.model
      || cell.actual_model !== configured.model
      || cell.harness_version_raw !== pin.version_raw
      || cell.harness_version_semver !== pin.version_semver
      || cell.status !== "completed"
      || cell.cleanup_status !== cleanup.status
      || cell.record_path !== recordFile.relativePath
      || cell.cleanup_path !== cleanupFile.relativePath
      || (batch.configuration.reset_required && cleanup.status !== "confirmed")
      || cleanup.cell_id !== record.cell_id
      || cleanup.record_sha256 !== recordHash
      || cleanup.namespace !== record.execution_namespace
      || resolve(cleanup.record_path) !== resolve(runRoot, cell.record_path)) {
      throw new Error(`runtime reporting sidecars do not match completion cell ${cell.key}`);
    }
    return { cell, record, cleanup, recordPath: recordFile.relativePath };
  }).sort((left, right) => left.cell.key < right.cell.key ? -1 : left.cell.key > right.cell.key ? 1 : 0);
  const generatedAt = options.now.toISOString();
  const surfaceReports: ArenaRuntimeReport["surface_reports"] = [];
  const aggregates: ArenaRuntimeReport["aggregates"] = [];
  const outputs: Array<
    { kind: "json"; path: string; value: unknown }
    | { kind: "text"; path: string; value: string }
  > = [];
  const surfaceKeys = [...new Set(cells.map(({ record }) => `${record.target_id}\0${record.surface}`))].sort();
  for (const surfaceKey of surfaceKeys) {
    const [vendor, surface] = surfaceKey.split("\0") as [string, SurfaceId];
    const selected = cells.filter(({ record }) => record.target_id === vendor && record.surface === surface);
    const reportDir = resolve(runRoot, vendor, surface, "reporting");
    const snapshotPath = resolve(reportDir, "generated-eval.snapshot.json");
    const htmlPath = resolve(reportDir, "generated-eval.html");
    const reviewPath = resolve(reportDir, "failure-review.md");
    const snapshot: GeneratedReportSnapshot = {
      schema: "ax.generated-report-snapshot/v1",
      pack: packs.get(vendor)!,
      runs: selected.map(({ record, cleanup }) => profileRun(runRoot, packs.get(vendor)!, record, cleanup)),
      harness: options.harness,
      warnings: [],
      minPassRate,
      generatedAt,
    };
    outputs.push(
      { kind: "json", path: snapshotPath, value: snapshot },
      { kind: "text", path: htmlPath, value: renderGeneratedSnapshot(snapshot) },
      { kind: "text", path: reviewPath, value: failureReview(selected.map(({ record }) => record)) },
    );
    surfaceReports.push({
      vendor,
      surface,
      snapshot_path: relative(runRoot, snapshotPath).replaceAll("\\", "/"),
      html_path: relative(runRoot, htmlPath).replaceAll("\\", "/"),
      failure_review_path: relative(runRoot, reviewPath).replaceAll("\\", "/"),
    });
    for (const harness of ["codex", "claude-code"] as const) {
      const trials = selected.filter(({ record }) => record.harness === harness)
        .sort((left, right) => left.record.trial - right.record.trial);
      if (!trials.length) continue;
      const aggregateDir = resolve(runRoot, vendor, surface, harness, "aggregate");
      const aggregatePath = resolve(aggregateDir, `${harness}.${surface}.aggregate.normalized.json`);
      const trialManifestPath = resolve(aggregateDir, "trial-manifest.json");
      const aggregate = aggregateNormalizedResults(
        trials.map(({ record }) => normalizedResult(record)),
        trials.map(({ recordPath }) => recordPath),
      );
      aggregate.generated_at = generatedAt;
      const consistency = taskConsistency(trials.map(({ record }) => record));
      aggregate.task_consistency_at_3 = consistency?.rate ?? null;
      aggregate.pass_3_tasks = consistency?.count ?? null;
      aggregate.pass_3_tasks_total = consistency?.total ?? null;
      outputs.push({ kind: "json", path: aggregatePath, value: aggregate });
      outputs.push({ kind: "json", path: trialManifestPath, value: {
        schema: "ax.arena-runtime-trials/v1",
        batch_id: batch.batch_id,
        vendor,
        surface,
        harness,
        generated_at: generatedAt,
        trials: trials.map(({ cell, record, recordPath }) => ({
          trial: record.trial,
          record_path: recordPath,
          record_hash: cell.record_hash,
        })),
      } });
      aggregates.push({
        vendor,
        surface,
        harness,
        trial_count: trials.length,
        aggregate_record_path: relative(runRoot, aggregatePath).replaceAll("\\", "/"),
        trial_manifest_path: relative(runRoot, trialManifestPath).replaceAll("\\", "/"),
      });
    }
  }
  const report = ArenaRuntimeReportSchema.parse({
    schema: ARENA_RUNTIME_REPORT_SCHEMA,
    batch_id: batch.batch_id,
    configuration_hash: batch.configuration_hash,
    generated_at: generatedAt,
    surface_reports: surfaceReports,
    aggregates,
  });
  outputs.push({ kind: "json", path: resolve(runRoot, "runtime-reporting.json"), value: report });
  for (const output of outputs) assertOutputAvailable(runRoot, output.path);
  for (const output of outputs) {
    if (output.kind === "json") exclusiveJson(runRoot, output.path, output.value);
    else exclusiveText(runRoot, output.path, output.value);
  }
  return report;
}
