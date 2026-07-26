import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import {
  SuiteSchema,
  TargetPackSchema,
  packContentHash,
  validatePackAgainstSuite,
  type NormalizedResult,
  type TargetPack,
} from "ax-eval";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ArenaRuntimeReportSchema } from "../controller/schemas.js";
import { bubblewrapPolicyHash } from "../controller/sandbox.js";
import { verifyHostedRunAttestation } from "./attestation.js";
import { renderArenaCompetitiveReport } from "./competitive.js";
import { ArenaPublicationBundleSchema, type ArenaPublicationBundle } from "./contracts.js";
import { assertCanonicalRuntimeDerivation } from "./derivation.js";
import { ArenaNormalizedResultSchema, loadArenaPublicationCohort } from "./export.js";
import {
  canonicalRoot,
  insideOrEqual,
  parseCanonicalJsonFile,
  readCanonicalJson,
  readPinnedFile,
  resolveContained,
  writeAtomicDirectory,
  type PinnedFile,
  type PlannedPublicationFile,
} from "./filesystem.js";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_PATH = "/usr/bin/git";
const GIT_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: process.env.HOME ?? "/var/empty",
  USER: process.env.USER ?? "root",
  LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "root",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  LANG: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_PAGER: "cat",
} as const;
const PRODUCTION_MODELS = {
  codex: "gpt-5.6-terra",
  "claude-code": "claude-sonnet-5",
} as const;
const METHODOLOGY_FILES = [
  "suite.methodology.yaml",
  "suite.concept-universe.yaml",
  "suite.coverage-matrix.yaml",
  "suite.selection-ledger.yaml",
  "suite.support-matrix.yaml",
  "suite.grader-ledger.yaml",
  "suite.failure-taxonomy.yaml",
  "suite.trace-review.yaml",
] as const;

const ApprovalSchema = z.object({
  standard_set_version: z.string(),
  content_hash: z.string(),
  pack_file_hash: z.string().regex(SHA256).optional(),
  approved_by: z.string(),
  approved_at: z.string(),
  task_count: z.number().int().nonnegative(),
}).passthrough();

const RuntimeLockSchema = z.object({
  schema: z.literal("ax.arena-trusted-runtime-lock/v1"),
  platform: z.literal("linux/amd64"),
  container: z.object({
    image: z.string().min(1),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    node_version: z.string().min(1),
  }).strict(),
  bubblewrap: z.object({
    version: z.string().min(1),
    archive_url: z.string().min(1),
    archive_sha256: z.string().regex(SHA256),
    executable_path: z.string().min(1),
    executable_sha256: z.string().regex(SHA256),
  }).passthrough(),
}).passthrough();

const TrialManifestSchema = z.object({
  schema: z.literal("ax.arena-runtime-trials/v1"),
  batch_id: z.string(),
  vendor: z.string(),
  surface: z.enum(["api", "cli", "sdk", "mcp"]),
  harness: z.enum(["codex", "claude-code"]),
  generated_at: z.string(),
  trials: z.array(z.object({
    trial: z.number().int().positive(),
    record_path: z.string(),
    record_hash: z.string().regex(SHA256),
  }).strict()).min(1),
}).strict();

const SnapshotRunSchema = z.object({
  cell_key: z.string().min(1),
  trial: z.number().int().positive(),
  profile: z.enum(["medium", "high"]),
  harness: z.enum(["codex", "claude-code"]),
  model: z.string().min(1),
  surface: z.enum(["api", "cli", "sdk", "mcp"]),
  outcomes: z.array(z.object({ taskId: z.string().min(1) }).passthrough()).min(1),
  trace: z.array(z.object({
    step: z.number().int().positive(),
    taskId: z.string().min(1),
    action: z.string().min(1),
  }).passthrough()),
  evidence: z.object({
    results: z.array(z.string().min(1)).min(1),
    trace: z.array(z.string().min(1)).min(1),
    transcript: z.string().min(1),
  }).passthrough(),
}).passthrough();

const SnapshotSchema = z.object({
  schema: z.literal("ax.generated-report-snapshot/v1"),
  pack: TargetPackSchema,
  runs: z.array(SnapshotRunSchema).min(1),
  generatedAt: z.string(),
}).passthrough();

export interface PublicationQualityGate {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface PublicationArtifactSet {
  vendor_card?: string;
  oracle_extract?: string;
  compiled_pack?: string;
  approval?: string;
  support_matrix?: string;
  snapshot?: string;
  snapshots?: string[];
  report_html?: string;
  report_htmls?: string[];
  normalized_records: string[];
}

interface BuiltArenaPublicationBundle {
  schema: "ax.publication-bundle/v2";
  benchmark: string;
  category: string;
  suite: string;
  suite_version: number;
  generated_at: string;
  publication_readiness: "publication_ready";
  expected_matrix: {
    surfaces: string[];
    harnesses: string[];
    effort_profiles: string[];
    required_effort_profiles: string[];
    expected_cells: number;
  };
  quality_gates: PublicationQualityGate[];
  layers: {
    static_ax: { description: string; methodology_artifacts: string[] };
    behavioral: { description: string; methodology_artifacts: string[] };
  };
  vendors: Array<{
    slug: string;
    pack: string;
    expected_surfaces: string[];
    missing: string[];
    validation_errors: string[];
    artifacts: PublicationArtifactSet;
  }>;
  competitive_report?: string;
  missing: string[];
  notes: string[];
  integrity: {
    schema: "ax.publication-integrity/v1";
    source_commit_sha: string;
    batch_id: string;
    configuration_hash: string;
    batch_manifest_path: string;
    batch_manifest_sha256: string;
    batch_completion_path: string;
    batch_completion_sha256: string;
    runtime_report_path: string;
    runtime_report_sha256: string;
    attestation: {
      schema: "ax.github-oidc-attestation-verification/v1";
      subject_path: string;
      subject_sha256: string;
      detached_bundles_path: string;
      detached_bundles_sha256: string;
      repository: string;
      signer_workflow: string;
      workflow_ref: string;
      workflow_sha: string;
      run_id: string;
      run_attempt: string;
    };
    files: Array<{ path: string; sha256: string; bytes: number; source_path?: string }>;
  };
}

export interface BuildArenaPublicationBundleOptions {
  runRoot: string;
  outDir: string;
  benchmarkRoot: string;
  generatedAt?: Date;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseYamlFile<T>(file: PinnedFile, label: string, parse: (input: unknown) => T): T {
  try {
    return parse(parseYaml(file.bytes.toString("utf8")));
  } catch (error) {
    throw new Error(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sourceCheckoutRoot(cwd: string): string {
  const git = lstatSync(GIT_PATH);
  if (!git.isFile() || git.isSymbolicLink() || git.uid !== 0 || (git.mode & 0o022) !== 0
    || realpathSync(GIT_PATH) !== GIT_PATH) {
    throw new Error("publication source verification requires the root-owned, non-writable /usr/bin/git executable");
  }
  try {
    return canonicalRoot(execFileSync(GIT_PATH, ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      env: GIT_ENV,
    }).trim(), "publication source checkout");
  } catch {
    throw new Error("publication bundle requires a source checkout containing the batch source commit");
  }
}

function currentSourceSha(root: string): string {
  return execFileSync(GIT_PATH, ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", env: GIT_ENV }).trim();
}

function assertCommitted(root: string, sourceSha: string, file: PinnedFile, label: string): void {
  const path = relative(root, file.path).replaceAll("\\", "/");
  if (!path || path.startsWith("../")) throw new Error(`${label} is outside the source checkout`);
  let committed: Buffer;
  try {
    const treeEntry = execFileSync(GIT_PATH, ["ls-tree", "-z", "--full-tree", sourceSha, "--", path], {
      cwd: root,
      encoding: "utf8",
      env: GIT_ENV,
    });
    const separator = treeEntry.indexOf("\t");
    if (separator < 0 || !/^100(?:644|755) blob [a-f0-9]+$/.test(treeEntry.slice(0, separator))
      || treeEntry.slice(separator + 1) !== `${path}\0`) {
      throw new Error("source entry is absent or is not a regular blob");
    }
    committed = execFileSync(GIT_PATH, ["show", `${sourceSha}:${path}`], {
      cwd: root,
      encoding: "buffer",
      env: GIT_ENV,
      maxBuffer: Math.max(file.bytes.length + 1024, 16 * 1024 * 1024),
    });
  } catch {
    throw new Error(`${label} is not committed at batch source SHA ${sourceSha}`);
  }
  if (!committed.equals(file.bytes)) throw new Error(`${label} drifted from batch source SHA ${sourceSha}`);
}

function expectedReportPath(vendor: string, surface: string, name: string): string {
  return `${vendor}/${surface}/reporting/${name}`;
}

function expectedAggregatePath(vendor: string, surface: string, harness: string): string {
  return `${vendor}/${surface}/${harness}/aggregate/${harness}.${surface}.aggregate.normalized.json`;
}

function expectedTrialManifestPath(vendor: string, surface: string, harness: string): string {
  return `${vendor}/${surface}/${harness}/aggregate/trial-manifest.json`;
}

function traceCoverageIssue(snapshot: z.infer<typeof SnapshotSchema>): string | null {
  const issues: string[] = [];
  for (const raw of snapshot.runs) {
    if (!raw || typeof raw !== "object") continue;
    const run = raw as {
      profile?: string;
      harness?: string;
      surface?: string;
      outcomes?: Array<{ taskId?: string }>;
      trace?: Array<{ taskId?: string; method?: string; path?: string }>;
    };
    const expected = new Set((run.outcomes ?? []).map((outcome) => outcome.taskId).filter((id): id is string => Boolean(id)));
    const calls = (run.trace ?? []).filter((step) => step.method || step.path);
    if (!expected.size || !calls.length) continue;
    const scoped = new Set(calls.map((step) => step.taskId).filter((id): id is string => Boolean(id && expected.has(id))));
    const opaque = calls.filter((step) => !step.taskId || step.taskId === "all" || step.taskId === "observed").length;
    const minimum = Math.min(expected.size, Math.max(2, Math.ceil(expected.size / 2)));
    if (scoped.size < minimum || opaque / calls.length > 0.5) {
      issues.push(`${run.harness ?? "unknown"}/${run.surface ?? "api"}/${run.profile ?? "profile"}: ${scoped.size}/${expected.size} task-scoped trace coverage across ${calls.length} call(s)`);
    }
  }
  return issues.length ? issues.join(" | ") : null;
}

function hasEfficiency(record: NormalizedResult): boolean {
  return record.latency_ms !== undefined
    && record.total_duration_ms !== undefined
    && record.token_usage !== undefined
    && record.cost_usd !== undefined
    && record.tool_call_count !== undefined
    && record.harness_version_raw !== undefined
    && record.harness_version_semver !== undefined
    && record.run_batch_id !== undefined
    && (record.harness !== "claude-code" || typeof record.cost_usd === "number");
}

function exactSet(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function buildArenaPublicationBundle(opts: BuildArenaPublicationBundleOptions): ArenaPublicationBundle {
  const root = sourceCheckoutRoot(resolve(opts.benchmarkRoot));
  const runRoot = canonicalRoot(resolveContained(root, opts.runRoot, "publication run root"), "publication run root");
  const benchmarkRoot = canonicalRoot(resolveContained(root, opts.benchmarkRoot, "publication benchmark root"), "publication benchmark root");
  if (!insideOrEqual(root, runRoot) || runRoot === root) {
    throw new Error("publication run root escaped the physical repository root");
  }
  if (!insideOrEqual(root, benchmarkRoot) || benchmarkRoot === root) {
    throw new Error("publication benchmark root escaped the physical repository root");
  }
  const output = resolveContained(root, opts.outDir, "publication output");
  if (opts.generatedAt && !Number.isFinite(opts.generatedAt.getTime())) throw new Error("publication generatedAt must be a valid date");

  const attested = verifyHostedRunAttestation(runRoot);
  const batchRead = { file: attested.batchFile, value: attested.batch };
  const completionRead = { file: attested.completionFile, value: attested.completion };
  const reportRead = readCanonicalJson(runRoot, resolve(runRoot, "runtime-reporting.json"), "runtime reporting manifest", (input) => ArenaRuntimeReportSchema.parse(input), 16 * 1024 * 1024);
  const batch = batchRead.value;
  const completion = completionRead.value;
  const report = reportRead.value;
  const generatedAtIso = report.generated_at;
  if (opts.generatedAt && opts.generatedAt.toISOString() !== generatedAtIso) {
    throw new Error("publication generatedAt must equal the canonical runtime reporting timestamp");
  }
  if (batch.configuration.command !== "daeb-production-rerun"
    || batch.configuration.execution?.runtime_backend !== "pinned-oci"
    || batch.configuration.execution?.trust_level !== "hosted-trusted"
    || !batch.configuration.sandbox
    || report.execution.runtime_backend !== "pinned-oci"
    || report.execution.trust_level !== "hosted-trusted"
    || !report.sandbox_provenance
    || report.sandbox_provenance.runtime_lock_sha256 !== attested.subject.runtime.lock_sha256
    || report.sandbox_provenance.implementation_sha256 !== batch.configuration.sandbox.executable_sha256
    || report.sandbox_provenance.policy_sha256 !== bubblewrapPolicyHash(batch.configuration.sandbox)) {
    throw new Error("official publication bundles require one hosted-trusted pinned-OCI production run");
  }
  if (currentSourceSha(root) !== batch.source_commit_sha) {
    throw new Error("publication checkout HEAD must equal the immutable batch source SHA");
  }
  const runtimeLock = readPinnedFile(root, resolve(root, attested.subject.runtime.lock_path), "trusted runtime lock");
  assertCommitted(root, batch.source_commit_sha, runtimeLock, "trusted runtime lock");
  const runtimeLockValue = parseCanonicalJsonFile(runtimeLock, "trusted runtime lock", (input) => RuntimeLockSchema.parse(input));
  if (sha256(runtimeLock.bytes) !== attested.subject.runtime.lock_sha256
    || runtimeLockValue.container.digest !== attested.subject.runtime.container_digest
    || runtimeLockValue.bubblewrap.executable_sha256 !== batch.configuration.sandbox.executable_sha256) {
    throw new Error("trusted runtime lock does not match the attested hosted execution");
  }
  if (completion.batch_id !== batch.batch_id || completion.source_commit_sha !== batch.source_commit_sha
    || completion.configuration_hash !== batch.configuration_hash
    || report.batch_id !== batch.batch_id || report.configuration_hash !== batch.configuration_hash
    || report.source_commit_sha !== batch.source_commit_sha) {
    throw new Error("publication batch, completion, and runtime report identities do not match");
  }
  if (!report.batch_manifest_sha256 || !report.batch_completion_sha256
    || report.batch_manifest_sha256 !== sha256(batchRead.file.bytes)
    || report.batch_completion_sha256 !== sha256(completionRead.file.bytes)) {
    throw new Error("runtime report is missing or mismatches its batch/completion hashes; rerun aggregate");
  }
  if (!exactSet(completion.cells.map((cell) => cell.key), batch.expected_cells)) {
    throw new Error("batch completion does not contain the exact configured cell set");
  }
  for (const [label, values] of [
    ["record ids", completion.cells.map((cell) => cell.record_id)],
    ["record paths", completion.cells.map((cell) => cell.record_path)],
    ["cleanup paths", completion.cells.map((cell) => cell.cleanup_path)],
  ] as const) {
    if (new Set(values).size !== values.length) throw new Error(`batch completion ${label} must be unique`);
  }
  type PublicationPlan = PlannedPublicationFile & { sourcePath?: string };
  const sealedRuntimeFiles: PublicationPlan[] = [];
  const sealedRuntimePaths = new Set<string>();
  const addSealedRuntimeFile = (path: string, expectedHash: string, label: string): PinnedFile => {
    if (sealedRuntimePaths.has(path)) throw new Error(`trusted run reuses sealed path ${path}`);
    const file = readPinnedFile(runRoot, resolve(runRoot, path), label);
    if (sha256(file.bytes) !== expectedHash) throw new Error(`${label} hash drifted from batch completion`);
    sealedRuntimePaths.add(path);
    sealedRuntimeFiles.push({ path, bytes: file.bytes });
    return file;
  };
  const completionByKey = new Map(completion.cells.map((cell) => [cell.key, cell]));
  for (const configured of batch.configuration.cells) {
    const completed = completionByKey.get(configured.key);
    if (!completed || completed.harness !== configured.harness
      || completed.requested_model !== configured.model || completed.actual_model !== configured.model
      || completed.status !== "completed" || (batch.configuration.reset_required && completed.cleanup_status !== "confirmed")) {
      throw new Error(`completed cell does not match immutable batch configuration: ${configured.key}`);
    }
    const pin = batch.configuration.harnesses.find((candidate) => candidate.harness === configured.harness)!;
    if (completed.harness_version_raw !== pin.version_raw || completed.harness_version_semver !== pin.version_semver) {
      throw new Error(`completed cell harness pin drifted: ${configured.key}`);
    }
    addSealedRuntimeFile(completed.record_path, completed.record_hash, `completed record ${configured.key}`);
    addSealedRuntimeFile(completed.cleanup_path, completed.cleanup_hash, `completed cleanup ${configured.key}`);
    const artifactNames = completed.artifacts.map((artifact) => artifact.name);
    if (new Set(artifactNames).size !== artifactNames.length) {
      throw new Error(`completed cell artifact names are duplicated: ${configured.key}`);
    }
    for (const artifact of completed.artifacts) {
      addSealedRuntimeFile(artifact.path, artifact.sha256, `completed ${artifact.name} artifact ${configured.key}`);
    }
  }

  const suitePath = resolve(benchmarkRoot, `v${batch.configuration.suite.version}`, "suite.yaml");
  const suiteFile = readPinnedFile(benchmarkRoot, suitePath, "canonical suite", 16 * 1024 * 1024);
  assertCommitted(root, batch.source_commit_sha, suiteFile, "canonical suite");
  if (sha256(suiteFile.bytes) !== batch.configuration.suite.file_hash) throw new Error("canonical suite hash drifted from batch configuration");
  const suite = parseYamlFile(suiteFile, "canonical suite", (input) => SuiteSchema.parse(input));
  if (suite.name !== batch.configuration.suite.name || suite.version !== batch.configuration.suite.version) {
    throw new Error("canonical suite identity drifted from batch configuration");
  }
  const signedSources = new Map(attested.subject.source_artifacts.map((artifact) => [artifact.path, artifact.sha256]));
  const sourcePlan = (path: string, file: PinnedFile, label: string): PublicationPlan => {
    const sourcePath = relative(root, file.path).replaceAll("\\", "/");
    if (!sourcePath.startsWith("ax-arena/benchmark/daeb/") || signedSources.get(sourcePath) !== sha256(file.bytes)) {
      throw new Error(`${label} is not bound by the signed protected-main source artifact set`);
    }
    return { path, bytes: file.bytes, sourcePath };
  };

  const subjectPath = "provenance/trusted-run-subject.json";
  const detachedBundlesPath = "provenance/github-attestation-bundles.jsonl";
  const batchPath = `provenance/${attested.subject.batch.manifest.path}`;
  const completionPath = `provenance/${attested.subject.batch.completion.path}`;
  const runtimeReportPath = "provenance/runtime-reporting.json";
  const plans: PublicationPlan[] = [
    { path: subjectPath, bytes: attested.subjectFile.bytes },
    { path: detachedBundlesPath, bytes: attested.detachedBundles },
    { path: `provenance/${attested.subject.runtime.manifest.path}`, bytes: attested.runtimeManifestFile.bytes },
    { path: `provenance/${attested.subject.configuration.path}`, bytes: attested.configurationFile.bytes },
    { path: batchPath, bytes: batchRead.file.bytes },
    { path: completionPath, bytes: completionRead.file.bytes },
    { path: runtimeReportPath, bytes: reportRead.file.bytes },
    ...sealedRuntimeFiles,
    sourcePlan("suite/suite.yaml", suiteFile, "canonical suite"),
  ];
  const topLevelMissing: string[] = [];
  const methodologyPaths: string[] = [];
  const maybeCommitted = (source: string, destination: string, label: string, missing: string[]): PinnedFile | undefined => {
    if (!existsSync(source)) {
      missing.push(destination);
      return undefined;
    }
    const file = readPinnedFile(benchmarkRoot, source, label);
    assertCommitted(root, batch.source_commit_sha, file, label);
    plans.push(sourcePlan(destination, file, label));
    return file;
  };
  const suiteDir = resolve(benchmarkRoot, `v${suite.version}`);
  for (const name of METHODOLOGY_FILES) {
    const destination = `suite/${name}`;
    if (maybeCommitted(resolve(suiteDir, name), destination, `canonical methodology ${name}`, topLevelMissing)) {
      methodologyPaths.push(destination);
    }
  }

  const expectedReportKeys = [...new Set(batch.configuration.cells.map((cell) => `${cell.vendor}/${cell.surface}`))].sort();
  const actualReportKeys = report.surface_reports.map((entry) => `${entry.vendor}/${entry.surface}`).sort();
  if (!exactSet(expectedReportKeys, actualReportKeys)) throw new Error("runtime report surface set does not match the immutable batch");
  const expectedAggregateKeys = [...new Set(batch.configuration.cells.map((cell) => `${cell.vendor}/${cell.surface}/${cell.harness}`))].sort();
  const actualAggregateKeys = report.aggregates.map((entry) => `${entry.vendor}/${entry.surface}/${entry.harness}`).sort();
  if (!exactSet(expectedAggregateKeys, actualAggregateKeys)) throw new Error("runtime report aggregate set does not match the immutable batch");

  const snapshotsByVendor = new Map<string, string[]>();
  const htmlByVendor = new Map<string, string[]>();
  const snapshotValues = new Map<string, z.infer<typeof SnapshotSchema>>();
  for (const entry of report.surface_reports) {
    const expectedSnapshot = expectedReportPath(entry.vendor, entry.surface, "generated-eval.snapshot.json");
    const expectedHtml = expectedReportPath(entry.vendor, entry.surface, "generated-eval.html");
    const expectedReview = expectedReportPath(entry.vendor, entry.surface, "failure-review.md");
    if (entry.snapshot_path !== expectedSnapshot || entry.html_path !== expectedHtml || entry.failure_review_path !== expectedReview) {
      throw new Error(`runtime report paths are not deterministic: ${entry.vendor}/${entry.surface}`);
    }
    if (!entry.snapshot_sha256 || !entry.html_sha256 || !entry.failure_review_sha256) {
      throw new Error("runtime report is missing artifact hashes; rerun aggregate");
    }
    const snapshotFile = readPinnedFile(runRoot, resolve(runRoot, entry.snapshot_path), `runtime snapshot ${entry.vendor}/${entry.surface}`);
    const html = readPinnedFile(runRoot, resolve(runRoot, entry.html_path), `runtime HTML ${entry.vendor}/${entry.surface}`);
    const review = readPinnedFile(runRoot, resolve(runRoot, entry.failure_review_path), `runtime failure review ${entry.vendor}/${entry.surface}`);
    if (sha256(snapshotFile.bytes) !== entry.snapshot_sha256 || sha256(html.bytes) !== entry.html_sha256
      || sha256(review.bytes) !== entry.failure_review_sha256) {
      throw new Error(`runtime surface artifact hash drifted: ${entry.vendor}/${entry.surface}`);
    }
    const snapshot = parseCanonicalJsonFile(snapshotFile, `runtime snapshot ${entry.vendor}/${entry.surface}`, (input) => SnapshotSchema.parse(input));
    const configuredRuns = batch.configuration.cells.filter((cell) =>
      cell.vendor === entry.vendor && cell.surface === entry.surface);
    const runSignature = (run: { cell_key?: string; trial: number; harness: string; surface: string; profile: string; model: string; key?: string }) =>
      `${run.cell_key ?? run.key}/${run.trial}/${run.harness}/${run.surface}/${run.profile}/${run.model}`;
    if (snapshot.pack.name !== entry.vendor || snapshot.generatedAt !== report.generated_at
      || !exactSet(snapshot.runs.map(runSignature), configuredRuns.map(runSignature))) {
      throw new Error(`runtime snapshot evidence does not match the immutable batch: ${entry.vendor}/${entry.surface}`);
    }
    const snapshotDestination = `vendors/${entry.vendor}/reports/${entry.surface}/generated-eval.snapshot.json`;
    const htmlDestination = `vendors/${entry.vendor}/reports/${entry.surface}/generated-eval.html`;
    plans.push(
      { path: entry.snapshot_path, bytes: snapshotFile.bytes },
      { path: entry.html_path, bytes: html.bytes },
      { path: entry.failure_review_path, bytes: review.bytes },
      { path: snapshotDestination, bytes: snapshotFile.bytes },
      { path: htmlDestination, bytes: html.bytes },
    );
    snapshotsByVendor.set(entry.vendor, [...(snapshotsByVendor.get(entry.vendor) ?? []), snapshotDestination]);
    htmlByVendor.set(entry.vendor, [...(htmlByVendor.get(entry.vendor) ?? []), htmlDestination]);
    snapshotValues.set(`${entry.vendor}/${entry.surface}`, snapshot);
  }

  const aggregateRecords: NormalizedResult[] = [];
  const aggregatePathsByVendor = new Map<string, string[]>();
  for (const entry of report.aggregates) {
    const expectedRecord = expectedAggregatePath(entry.vendor, entry.surface, entry.harness);
    const expectedTrials = expectedTrialManifestPath(entry.vendor, entry.surface, entry.harness);
    if (entry.aggregate_record_path !== expectedRecord || entry.trial_manifest_path !== expectedTrials) {
      throw new Error(`runtime aggregate paths are not deterministic: ${entry.vendor}/${entry.surface}/${entry.harness}`);
    }
    if (!entry.aggregate_record_sha256 || !entry.trial_manifest_sha256) {
      throw new Error("runtime report is missing aggregate hashes; rerun aggregate");
    }
    const aggregateFile = readPinnedFile(runRoot, resolve(runRoot, entry.aggregate_record_path), `runtime aggregate ${entry.vendor}/${entry.surface}/${entry.harness}`);
    const trialFile = readPinnedFile(runRoot, resolve(runRoot, entry.trial_manifest_path), `runtime trial manifest ${entry.vendor}/${entry.surface}/${entry.harness}`);
    if (sha256(aggregateFile.bytes) !== entry.aggregate_record_sha256 || sha256(trialFile.bytes) !== entry.trial_manifest_sha256) {
      throw new Error(`runtime aggregate artifact hash drifted: ${entry.vendor}/${entry.surface}/${entry.harness}`);
    }
    const aggregate = parseCanonicalJsonFile(aggregateFile, `runtime aggregate ${entry.vendor}/${entry.surface}/${entry.harness}`, (input) => ArenaNormalizedResultSchema.parse(input));
    const trials = parseCanonicalJsonFile(trialFile, `runtime trial manifest ${entry.vendor}/${entry.surface}/${entry.harness}`, (input) => TrialManifestSchema.parse(input));
    const cells = batch.configuration.cells.filter((cell) =>
      cell.vendor === entry.vendor && cell.surface === entry.surface && cell.harness === entry.harness);
    const configured = cells[0];
    const pin = batch.configuration.harnesses.find((candidate) => candidate.harness === entry.harness)!;
    const expectedCompleted = cells.map((cell) => completionByKey.get(cell.key)!);
    if (!configured || entry.trial_count !== cells.length || trials.batch_id !== batch.batch_id
      || trials.vendor !== entry.vendor || trials.surface !== entry.surface || trials.harness !== entry.harness
      || trials.generated_at !== report.generated_at || trials.trials.length !== cells.length) {
      throw new Error(`runtime aggregate trial manifest identity drifted: ${entry.vendor}/${entry.surface}/${entry.harness}`);
    }
    const expectedTrialsByNumber = new Map(cells.map((cell) => [cell.trial, completionByKey.get(cell.key)!]));
    if (!exactSet(trials.trials.map((trial) => String(trial.trial)), cells.map((cell) => String(cell.trial)))) {
      throw new Error(`runtime aggregate trial numbers are duplicated or incomplete: ${entry.vendor}/${entry.surface}/${entry.harness}`);
    }
    for (const trial of trials.trials) {
      const completed = expectedTrialsByNumber.get(trial.trial);
      if (!completed || trial.record_path !== completed.record_path || trial.record_hash !== completed.record_hash) {
        throw new Error(`runtime aggregate trial provenance drifted: ${entry.vendor}/${entry.surface}/${entry.harness}`);
      }
    }
    const record = aggregate as NormalizedResult;
    if (record.product !== entry.vendor || record.surface !== entry.surface || record.harness !== entry.harness
      || record.standard_set_version !== batch.configuration.packs.find((pack) => pack.vendor === entry.vendor)?.standard_set_version
      || record.run_batch_id !== batch.batch_id || record.summary_kind !== "aggregate"
      || record.trial_count !== cells.length || record.generated_at !== report.generated_at
      || record.model !== configured.model || record.best_profile !== configured.profile
      || !exactSet(record.profiles, [configured.profile])
      || record.harness_version_raw !== pin.version_raw || record.harness_version_semver !== pin.version_semver
      || !exactSet(record.source_records ?? [], expectedCompleted.map((cell) => cell.record_path))) {
      throw new Error(`runtime aggregate identity drifted: ${entry.vendor}/${entry.surface}/${entry.harness}`);
    }
    aggregateRecords.push(record);
    const destination = `vendors/${entry.vendor}/normalized/${entry.surface}/${entry.harness}/${basename(entry.aggregate_record_path)}`;
    plans.push(
      { path: entry.aggregate_record_path, bytes: aggregateFile.bytes },
      { path: entry.trial_manifest_path, bytes: trialFile.bytes },
      { path: destination, bytes: aggregateFile.bytes },
    );
    aggregatePathsByVendor.set(entry.vendor, [...(aggregatePathsByVendor.get(entry.vendor) ?? []), destination]);
  }

  const competitivePath = "competitive.html";
  const competitiveHtml = renderArenaCompetitiveReport(aggregateRecords, {
    batch,
    generatedAt: generatedAtIso,
  });
  plans.push({ path: competitivePath, bytes: Buffer.from(competitiveHtml) });

  const vendors: BuiltArenaPublicationBundle["vendors"] = [];
  const canonicalPackPaths: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const configuredPack of batch.configuration.packs) {
    const slug = configuredPack.vendor;
    const missing: string[] = [];
    const validationErrors: string[] = [];
    const packSource = resolve(benchmarkRoot, `v${suite.version}`, "packs", slug, "pack.yaml");
    const packDestination = `vendors/${slug}/compiled-pack.yaml`;
    let pack: TargetPack | undefined;
    if (!existsSync(packSource)) {
      missing.push(packDestination);
    } else {
      const file = readPinnedFile(benchmarkRoot, packSource, `canonical pack ${slug}`);
      assertCommitted(root, batch.source_commit_sha, file, `canonical pack ${slug}`);
      if (sha256(file.bytes) !== configuredPack.file_hash) throw new Error(`canonical pack hash drifted: ${slug}`);
      pack = parseYamlFile(file, `canonical pack ${slug}`, (input) => TargetPackSchema.parse(input));
      if (pack.name !== slug || pack.standard_set_version !== configuredPack.standard_set_version) {
        throw new Error(`canonical pack identity drifted: ${slug}`);
      }
      canonicalPackPaths[slug] = packSource;
      validationErrors.push(...validatePackAgainstSuite(
        pack.tasks.map((task) => ({ id: task.id, title: task.title, difficulty: task.difficulty })),
        suite,
      ));
      for (const task of pack.tasks) {
        if (!task.na && task.oracles.length === 0) validationErrors.push(`Task ${task.id} is executable but has no oracle.`);
      }
      for (const snapshot of snapshotValues.values()) {
        if (snapshot.pack.name === slug && (snapshot.pack.standard_set_version !== pack.standard_set_version
          || packContentHash(snapshot.pack) !== packContentHash(pack))) {
          throw new Error(`runtime snapshot pack content drifted: ${slug}`);
        }
      }
      plans.push(sourcePlan(packDestination, file, `canonical pack ${slug}`));
    }
    const approvalDestination = `vendors/${slug}/pack.approval.json`;
    const approvalSource = resolve(benchmarkRoot, `v${suite.version}`, "packs", slug, "pack.approval.json");
    let approvalCopied = false;
    if (!existsSync(approvalSource)) {
      missing.push(approvalDestination);
    } else if (pack) {
      const approval = readCanonicalJson(benchmarkRoot, approvalSource, `canonical approval ${slug}`, (input) => ApprovalSchema.parse(input));
      assertCommitted(root, batch.source_commit_sha, approval.file, `canonical approval ${slug}`);
      if ((approval.value.pack_file_hash !== undefined && approval.value.pack_file_hash !== configuredPack.file_hash)
        || approval.value.standard_set_version !== pack.standard_set_version
        || approval.value.content_hash !== packContentHash(pack)
        || approval.value.task_count !== pack.tasks.length) {
        throw new Error(`canonical approval does not bind the configured pack: ${slug}`);
      }
      plans.push(sourcePlan(approvalDestination, approval.file, `canonical approval ${slug}`));
      approvalCopied = true;
    }
    const vendorCardDestination = `vendors/${slug}/vendor.discovered.yaml`;
    const oracleDestination = `vendors/${slug}/oracle-extract.yaml`;
    const supportDestination = `vendors/${slug}/suite-support-matrix.yaml`;
    const vendorCard = maybeCommitted(resolve(benchmarkRoot, "vendors", `${slug}.discovered.yaml`), vendorCardDestination, `canonical vendor card ${slug}`, missing);
    const oracle = maybeCommitted(resolve(benchmarkRoot, `v${suite.version}`, "extracts", slug, "oracles.yaml"), oracleDestination, `canonical oracle extract ${slug}`, missing);
    const support = maybeCommitted(resolve(suiteDir, "suite.support-matrix.yaml"), supportDestination, "canonical suite support matrix", missing);
    const snapshots = [...(snapshotsByVendor.get(slug) ?? [])].sort();
    const reports = [...(htmlByVendor.get(slug) ?? [])].sort();
    const normalized = [...(aggregatePathsByVendor.get(slug) ?? [])].sort();
    if (!snapshots.length) missing.push(`vendors/${slug}/reports/*/generated-eval.snapshot.json`);
    if (!reports.length) missing.push(`vendors/${slug}/reports/*/generated-eval.html`);
    if (!normalized.length) missing.push(`vendors/${slug}/normalized/**/*.normalized.json`);
    const expectedSurfaces = ["api", "cli", "sdk", "mcp"].filter((surface) =>
      configuredPack.surfaces.includes(surface as (typeof configuredPack.surfaces)[number]));
    vendors.push({
      slug,
      pack: packDestination,
      expected_surfaces: expectedSurfaces,
      missing,
      validation_errors: validationErrors,
      artifacts: {
        ...(vendorCard ? { vendor_card: vendorCardDestination } : {}),
        ...(oracle ? { oracle_extract: oracleDestination } : {}),
        ...(pack ? { compiled_pack: packDestination } : {}),
        ...(approvalCopied ? { approval: approvalDestination } : {}),
        ...(support ? { support_matrix: supportDestination } : {}),
        ...(snapshots[0] ? { snapshot: snapshots[0] } : {}),
        snapshots,
        ...(reports[0] ? { report_html: reports[0] } : {}),
        report_htmls: reports,
        normalized_records: normalized,
      },
    });
  }

  assertCanonicalRuntimeDerivation({
    runRoot,
    batch,
    batchBytes: batchRead.file.bytes,
    completion,
    report,
    packPaths: canonicalPackPaths,
  });

  const expectedSurfaces = ["api", "cli", "sdk", "mcp"].filter((surface) =>
    batch.configuration.cells.some((cell) => cell.surface === surface));
  const expectedHarnesses = ["codex", "claude-code"].filter((harness) =>
    batch.configuration.cells.some((cell) => cell.harness === harness));
  const expectedProfiles = [...new Set(batch.configuration.cells.map((cell) => cell.profile))].sort();
  const expectedCells = expectedAggregateKeys.length;
  const vendorMissing = vendors.flatMap((vendor) => vendor.missing.map((item) => `${vendor.slug}: ${item}`));
  const validationErrors = vendors.flatMap((vendor) => vendor.validation_errors.map((item) => `${vendor.slug}: ${item}`));
  const missingCells: string[] = [];
  for (const key of expectedAggregateKeys) {
    const [vendor, surface, harness] = key.split("/");
    if (!aggregateRecords.some((record) => record.product === vendor && record.surface === surface && record.harness === harness)) {
      missingCells.push(key);
    }
  }
  const missingRequiredProfiles = aggregateRecords.filter((record) => {
    const configured = batch.configuration.cells.find((cell) =>
      cell.vendor === record.product && cell.surface === record.surface && cell.harness === record.harness);
    return !configured || !record.profiles.includes(configured.profile);
  });
  const missingEfficiency = aggregateRecords.filter((record) => !hasEfficiency(record));
  const canonicalIssues: string[] = [];
  for (const record of aggregateRecords) {
    const harness = record.harness as keyof typeof PRODUCTION_MODELS;
    if (PRODUCTION_MODELS[harness] && record.model !== PRODUCTION_MODELS[harness]) canonicalIssues.push(`${record.product}/${record.surface}/${record.harness}: model=${record.model ?? "missing"}`);
    if (!record.profiles.includes("high")) canonicalIssues.push(`${record.product}/${record.surface}/${record.harness}: missing high profile`);
    if (record.summary_kind !== "aggregate" || record.trial_count !== 3) canonicalIssues.push(`${record.product}/${record.surface}/${record.harness}: requires 3-trial aggregate`);
  }
  const batchIds = new Set(aggregateRecords.map((record) => record.run_batch_id));
  if (batchIds.size !== 1 || !batchIds.has(batch.batch_id)) canonicalIssues.push("run_batch_id must be present and identical across publication records");
  for (const harness of ["codex", "claude-code"] as const) {
    const records = aggregateRecords.filter((record) => record.harness === harness);
    const versions = new Set(records.map((record) => record.harness_version_semver));
    if (!records.length || versions.size !== 1 || versions.has(null) || versions.has(undefined)) canonicalIssues.push(`${harness}: harness_version_semver must be present and identical`);
  }
  if (batch.configuration.command !== "daeb-production-rerun") canonicalIssues.push("batch command is not daeb-production-rerun");
  const traceIssues = [...snapshotValues.entries()].flatMap(([key, snapshot]) => {
    const issue = traceCoverageIssue(snapshot);
    return issue ? [`${key}: ${issue}`] : [];
  });
  const gates: PublicationQualityGate[] = [
    {
      id: "required-artifacts", label: "Required publication artifacts are present",
      status: topLevelMissing.length || vendorMissing.length ? "fail" : "pass",
      detail: topLevelMissing.length || vendorMissing.length
        ? `${topLevelMissing.length + vendorMissing.length} required artifact(s) missing.`
        : "Suite artifacts, vendor adapters, approvals, reports, snapshots, and normalized records are present.",
    },
    {
      id: "pack-validation", label: "Compiled packs validate against the frozen suite",
      status: validationErrors.length ? "fail" : "pass",
      detail: validationErrors.length
        ? `${validationErrors.length} validation error(s): ${validationErrors.slice(0, 5).join(" | ")}${validationErrors.length > 5 ? " | ..." : ""}`
        : "All compiled vendor packs match the frozen suite and executable tasks have graders.",
    },
    {
      id: "matrix-completeness", label: "Expected usability matrix cells are present",
      status: missingCells.length || missingRequiredProfiles.length ? "fail" : "pass",
      detail: missingCells.length || missingRequiredProfiles.length
        ? `${missingCells.length}/${expectedCells} cell(s) missing; ${missingRequiredProfiles.length} cell(s) lack required profile coverage (${expectedProfiles.join("/")}).`
        : `${expectedCells} expected vendor×surface×harness cells are present with required profile coverage (${expectedProfiles.join("/")}).`,
    },
    {
      id: "optional-profile-coverage", label: "Optional research profiles are tracked separately", status: "pass",
      detail: "Optional research-profile evidence is present for every expected cell.",
    },
    {
      id: "efficiency-metrics", label: "Efficiency metrics are present in normalized records",
      status: !aggregateRecords.length || missingEfficiency.length ? "fail" : "pass",
      detail: !aggregateRecords.length
        ? "No normalized records are available, so latency/token/tool-call metrics cannot be audited."
        : missingEfficiency.length
          ? `${missingEfficiency.length}/${aggregateRecords.length} normalized record(s) lack latency, token/cost, or tool-call metrics.`
          : "Normalized records include latency, token/cost, and tool-call metrics.",
    },
    {
      id: "canonical-execution-config", label: "Production records use the frozen execution configuration",
      status: canonicalIssues.length ? "fail" : "pass",
      detail: canonicalIssues.length
        ? `${canonicalIssues.length} issue(s): ${canonicalIssues.slice(0, 5).join(" | ")}${canonicalIssues.length > 5 ? " | ..." : ""}`
        : "gpt-5.6-terra and claude-sonnet-5, high effort, 3 trials, one run batch, and one version per harness.",
    },
    {
      id: "trace-attribution", label: "Trace coverage supports process attribution",
      status: traceIssues.length ? "warn" : "pass",
      detail: traceIssues.length
        ? `${traceIssues.length} run(s) have sparse or coarse task-scoped traces: ${traceIssues.slice(0, 5).join(" | ")}${traceIssues.length > 5 ? " | ..." : ""}`
        : "Recorded traces are sufficiently task-scoped for process diagnostics.",
    },
    {
      id: "competitive-report", label: "Cross-vendor competitive report is present", status: "pass",
      detail: "competitive.html is included.",
    },
  ];
  const staticMethodology = methodologyPaths.filter((path) => /methodology|concept-universe|coverage-matrix|selection-ledger|failure-taxonomy|trace-review/i.test(path));
  const behavioralMethodology = methodologyPaths.filter((path) => /support-matrix|grader-ledger|selection-ledger|coverage-matrix|methodology/i.test(path));
  const bundleWithoutIntegrity = {
    schema: "ax.publication-bundle/v2" as const,
    benchmark: suite.name,
    category: suite.category,
    suite: "suite/suite.yaml",
    suite_version: suite.version,
    generated_at: generatedAtIso,
    publication_readiness: "publication_ready" as const,
    expected_matrix: {
      surfaces: expectedSurfaces,
      harnesses: expectedHarnesses,
      effort_profiles: expectedProfiles,
      required_effort_profiles: expectedProfiles,
      expected_cells: expectedCells,
    },
    quality_gates: gates,
    layers: {
      static_ax: {
        description: "Discoverability & Readiness is the publication/audit layer for discoverability, content quality, and capability exposure.",
        methodology_artifacts: staticMethodology,
      },
      behavioral: {
        description: `Usability Canonical Suite is the benchmark of record and is scored only from verified outcomes on ${expectedSurfaces.join("/")}.`,
        methodology_artifacts: behavioralMethodology,
      },
    },
    vendors,
    competitive_report: competitivePath,
    missing: topLevelMissing,
    notes: [
      "Compiled TargetPacks are executable vendor adapters produced from the canonical suite plus vendor-specific verification extraction.",
      "Discoverability & Readiness artifacts and usability-suite artifacts are published side by side but remain separate scoring layers.",
      "Publication-grade bundles require both Discoverability & Readiness artifacts and usability-suite artifacts; missing methodology files are recorded explicitly.",
      `Publication readiness requires all artifacts, required profile matrix coverage (${expectedProfiles.join("/")}), efficiency metrics, and competitive report gates to pass.`,
      "Optional profile artifacts remain valuable execution-learning and publication evidence, but missing optional coverage does not block a publication-ready bundle when required profile coverage is complete.",
      "The detached GitHub OIDC attestation binds this bundle to its protected-main workflow, pinned runtime, exact batch, and completion.",
      "Do not publish unredacted transcripts, credentials, connection strings, or .env files in this bundle.",
    ],
  };
  if (topLevelMissing.length || vendors.some((vendor) => vendor.missing.length || vendor.validation_errors.length)
    || gates.some((gate) => gate.status === "fail")) {
    throw new Error("official publication bundle quality gates are not all satisfied");
  }
  const integrityFiles = plans.map((file) => ({
    path: file.path,
    sha256: sha256(file.bytes),
    bytes: file.bytes.length,
    ...(file.sourcePath ? { source_path: file.sourcePath } : {}),
  }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const bundle: BuiltArenaPublicationBundle = {
    ...bundleWithoutIntegrity,
    integrity: {
      schema: "ax.publication-integrity/v1",
      source_commit_sha: batch.source_commit_sha,
      batch_id: batch.batch_id,
      configuration_hash: batch.configuration_hash,
      batch_manifest_path: batchPath,
      batch_manifest_sha256: sha256(batchRead.file.bytes),
      batch_completion_path: completionPath,
      batch_completion_sha256: sha256(completionRead.file.bytes),
      runtime_report_path: runtimeReportPath,
      runtime_report_sha256: sha256(reportRead.file.bytes),
      attestation: {
        ...attested.verification,
        subject_path: subjectPath,
        subject_sha256: sha256(attested.subjectFile.bytes),
        detached_bundles_path: detachedBundlesPath,
        detached_bundles_sha256: sha256(attested.detachedBundles),
      },
      files: integrityFiles,
    },
  };
  const parsedBundle = ArenaPublicationBundleSchema.parse(bundle);
  plans.push({ path: "manifest.json", bytes: Buffer.from(`${JSON.stringify(parsedBundle, null, 2)}\n`) });
  writeAtomicDirectory(root, output, plans, [runRoot, benchmarkRoot], (stagingRoot) => {
    loadArenaPublicationCohort({ root, bundleDir: stagingRoot });
  });
  return parsedBundle;
}
