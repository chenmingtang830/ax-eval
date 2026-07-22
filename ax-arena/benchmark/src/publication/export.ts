import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";
import {
  NORMALIZED_RESULT_SCHEMA,
  NormalizedCellRecordSchema,
  type NormalizedCellRecord,
  type NormalizedResult,
} from "ax-eval";
import { z } from "zod";
import {
  ArenaBatchCompletionSchema,
  ArenaBatchManifestSchema,
  ArenaCellCleanupSchema,
  type ArenaBatchCompletion,
  type ArenaBatchManifest,
} from "../controller/schemas.js";
import {
  ArenaPublicationBundleSchema,
  ArenaPublicationIntegritySchema,
  publicationArtifactPaths,
  type ArenaPublicationBundle,
} from "./contracts.js";

export {
  PUBLICATION_INTEGRITY_SCHEMA,
  ArenaPublicationBundleSchema,
  ArenaPublicationIntegritySchema,
  publicationArtifactPaths,
} from "./contracts.js";
export type { ArenaPublicationBundle, ArenaPublicationIntegrity } from "./contracts.js";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const PUBLICATION_EFFORT = "high" as const;
const PROTECTED_REPOSITORY_PATHS = [
  ".git",
  ".github",
  "package.json",
  "package-lock.json",
  "src",
  "schemas",
  "targets",
  "tests",
  "ax-arena",
] as const;

export const ArenaPublicationExportManifestSchema = z.object({
  schema: z.literal("ax.axarena-export/v1"),
  benchmark: z.string().min(1),
  category: z.string().min(1),
  suite_version: z.number().int().nonnegative(),
  generated_at: z.string(),
  source_bundle: z.string(),
  source_manifest: z.string(),
  source_integrity: ArenaPublicationIntegritySchema,
  files: z.array(z.object({ id: z.string().min(1), path: z.string().min(1) }).strict()),
}).strict();
export type ArenaPublicationExportManifest = z.infer<typeof ArenaPublicationExportManifestSchema>;
export type ArenaPublicationExportFile = ArenaPublicationExportManifest["files"][number];

export const ArenaNormalizedResultSchema = z.object({
  schema: z.literal(NORMALIZED_RESULT_SCHEMA),
  surface: z.enum(["api", "cli", "sdk", "mcp"]),
  product: z.string(),
  harness: z.string(),
  standard_set_version: z.string(),
  generated_at: z.string(),
  tasks_total: z.number().int().nonnegative(),
  tasks_passed: z.number().int().nonnegative(),
  pass_at_1: z.number().min(0).max(1),
  pass_at_k: z.number().min(0).max(1),
  attempts: z.number().int().positive(),
  discovery_score: z.number().min(0).max(1).nullable(),
  content_quality: z.number().min(0).max(1).nullable().optional(),
  profiles: z.array(z.string()),
  best_profile: z.string().nullable(),
  model: z.string().nullable().optional(),
  blocked: z.enum(["requires-oauth", "missing-credential", "missing-harness", "invoke-failed"]).optional(),
  summary_kind: z.enum(["single", "aggregate"]).optional(),
  source_records: z.array(z.string()).optional(),
  mean_pass_rate: z.number().min(0).max(1).optional(),
  range_pass_rate: z.object({ min: z.number().min(0).max(1), max: z.number().min(0).max(1) }).nullable().optional(),
  trial_count: z.number().int().positive().optional(),
  trial_values: z.array(z.number().min(0).max(1)).optional(),
  task_consistency_at_3: z.number().min(0).max(1).nullable().optional(),
  pass_3_tasks: z.number().int().nonnegative().nullable().optional(),
  pass_3_tasks_total: z.number().int().nonnegative().nullable().optional(),
  pass_all_3: z.number().min(0).max(1).nullable().optional(),
  trial_stability_at_3: z.enum(["all_pass", "all_fail", "inconsistent"]).nullable().optional(),
  latency_ms: z.number().nonnegative().nullable().optional(),
  total_duration_ms: z.number().nonnegative().nullable().optional(),
  first_action_latency_ms: z.number().nonnegative().nullable().optional(),
  tool_call_count: z.number().nonnegative().nullable().optional(),
  token_usage: z.record(z.number().nonnegative()).nullable().optional(),
  token_cost: z.number().nonnegative().nullable().optional(),
  cost_usd: z.number().nonnegative().nullable().optional(),
  tokens_in: z.number().int().nonnegative().nullable().optional(),
  tokens_out: z.number().int().nonnegative().nullable().optional(),
  harness_version_raw: z.string().nullable().optional(),
  harness_version_semver: z.string().nullable().optional(),
  run_batch_id: z.string().nullable().optional(),
  validity_status: z.string().nullable().optional(),
}).passthrough().superRefine((record, context) => {
  if (record.tasks_passed > record.tasks_total) {
    context.addIssue({ code: "custom", path: ["tasks_passed"], message: "tasks_passed cannot exceed tasks_total" });
  }
  if (record.range_pass_rate && record.range_pass_rate.min > record.range_pass_rate.max) {
    context.addIssue({ code: "custom", path: ["range_pass_rate"], message: "range min cannot exceed max" });
  }
  if (record.pass_3_tasks !== null && record.pass_3_tasks !== undefined
    && record.pass_3_tasks_total !== null && record.pass_3_tasks_total !== undefined
    && record.pass_3_tasks > record.pass_3_tasks_total) {
    context.addIssue({ code: "custom", path: ["pass_3_tasks"], message: "pass_3_tasks cannot exceed pass_3_tasks_total" });
  }
});

export interface BuildArenaPublicationExportOptions {
  root: string;
  bundleDir: string;
  outDir: string;
  generatedAt?: Date;
}

export interface LoadArenaPublicationCohortOptions {
  root: string;
  bundleDir: string;
}

export interface VerifiedArenaPublicationCohort {
  bundle: ArenaPublicationBundle;
  batch: ArenaBatchManifest;
  records: Array<{ vendor: string; path: string; record: NormalizedResult }>;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

function insideOrEqual(root: string, candidate: string): boolean {
  return root === candidate || inside(root, candidate);
}

function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function canonicalDirectory(path: string, label: string): string {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular directory`);
  return realpathSync(path);
}

function resolveContained(root: string, input: string, label: string): string {
  const path = resolve(root, input);
  if (!inside(root, path)) throw new Error(`${label} must resolve inside the repository root`);
  return path;
}

function assertNoSymlinkChain(root: string, path: string, label: string): void {
  let current = root;
  for (const segment of relative(root, path).split(/[\\/]/)) {
    current = resolve(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} cannot traverse a symlink`);
  }
}

function safeBundleFile(bundleRoot: string, relativePath: string, label: string): string {
  if (isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.includes("\0")
    || posix.normalize(relativePath) !== relativePath || relativePath === ".") {
    throw new Error(`${label} must be a canonical contained relative path`);
  }
  const path = resolve(bundleRoot, relativePath);
  if (!inside(bundleRoot, path)) throw new Error(`${label} escapes the publication bundle`);
  let current = bundleRoot;
  for (const segment of relativePath.split("/")) {
    current = resolve(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${label} cannot traverse a symlink`);
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (!inside(realpathSync(bundleRoot), realpathSync(path))) throw new Error(`${label} escapes the publication bundle`);
  return path;
}

function readBoundedJson(bundleRoot: string, relativePath: string, label: string): unknown {
  const path = safeBundleFile(bundleRoot, relativePath, label);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source: string;
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new Error(`${label} must be a regular file`);
    if (opened.size > MAX_JSON_BYTES) throw new Error(`${label} exceeds the 16 MiB input limit`);
    const revalidatedPath = safeBundleFile(bundleRoot, relativePath, label);
    const current = lstatSync(revalidatedPath);
    if (revalidatedPath !== path || current.isSymbolicLink() || !sameIdentity(opened, current)) {
      throw new Error(`${label} changed during validation`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_JSON_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_JSON_BYTES + 1 - total));
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_JSON_BYTES) throw new Error(`${label} exceeds the 16 MiB input limit`);
    const afterRead = fstatSync(descriptor);
    const finalPath = safeBundleFile(bundleRoot, relativePath, label);
    const finalStat = lstatSync(finalPath);
    if (finalPath !== path || finalStat.isSymbolicLink() || !sameIdentity(opened, finalStat)
      || !sameIdentity(opened, afterRead) || total !== opened.size
      || afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs
      || afterRead.ctimeMs !== opened.ctimeMs || finalStat.size !== opened.size
      || finalStat.mtimeMs !== opened.mtimeMs || finalStat.ctimeMs !== opened.ctimeMs) {
      throw new Error(`${label} changed during validation`);
    }
    source = Buffer.concat(chunks, total).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseBoundedJsonBytes(bytes: Buffer, label: string): unknown {
  if (bytes.length > MAX_JSON_BYTES) throw new Error(`${label} exceeds the 16 MiB input limit`);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseCanonicalJson<T>(
  bytes: Buffer,
  parse: (value: unknown) => T,
  label: string,
): T {
  const parsed = parse(parseBoundedJsonBytes(bytes, label));
  if (bytes.toString("utf8") !== `${JSON.stringify(parsed, null, 2)}\n`) {
    throw new Error(`${label} is not in canonical persisted form`);
  }
  return parsed;
}

function assertSafeOutput(root: string, bundleRoot: string, outRoot: string): void {
  if (!inside(root, outRoot)) throw new Error("publication export output must resolve inside the repository root");
  if (existsSync(outRoot)) throw new Error("publication export output must not already exist");
  if (inside(bundleRoot, outRoot) || inside(outRoot, bundleRoot) || bundleRoot === outRoot) {
    throw new Error("publication export output must not overlap the source bundle");
  }
  for (const protectedPath of PROTECTED_REPOSITORY_PATHS) {
    const protectedRoot = resolve(root, protectedPath);
    if (insideOrEqual(protectedRoot, outRoot) || insideOrEqual(outRoot, protectedRoot)) {
      throw new Error(`publication export output must not overlap protected repository path ${protectedPath}`);
    }
  }
  const rel = relative(root, dirname(outRoot));
  let current = root;
  for (const segment of rel === "" ? [] : rel.split(/[\\/]/)) {
    current = resolve(current, segment);
    if (!existsSync(current)) break;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("publication export output cannot traverse a symlink");
    if (!stat.isDirectory()) throw new Error("publication export output parent must be a directory");
  }
}

function verifyIntegrityFile(
  bundleRoot: string,
  entry: { path: string; sha256: string; bytes: number },
  retain: boolean,
): Buffer | undefined {
  const label = `publication integrity artifact ${entry.path}`;
  const path = safeBundleFile(bundleRoot, entry.path, label);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) throw new Error(`${label} must be a regular file`);
    if (opened.size !== entry.bytes) {
      throw new Error(`${label} byte length mismatch (expected ${entry.bytes}, found ${opened.size})`);
    }
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const retained: Buffer[] = [];
    let total = 0;
    for (;;) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      digest.update(chunk.subarray(0, bytesRead));
      if (retain) retained.push(Buffer.from(chunk.subarray(0, bytesRead)));
      total += bytesRead;
    }
    const afterRead = fstatSync(descriptor);
    const revalidatedPath = safeBundleFile(bundleRoot, entry.path, label);
    const current = lstatSync(revalidatedPath);
    if (revalidatedPath !== path || current.isSymbolicLink() || !sameIdentity(opened, current)
      || !sameIdentity(opened, afterRead) || afterRead.size !== opened.size
      || afterRead.mtimeMs !== opened.mtimeMs || afterRead.ctimeMs !== opened.ctimeMs
      || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs
      || current.ctimeMs !== opened.ctimeMs) {
      throw new Error(`${label} changed during integrity verification`);
    }
    if (total !== entry.bytes) {
      throw new Error(`${label} byte length mismatch (expected ${entry.bytes}, read ${total})`);
    }
    const actual = digest.digest("hex");
    if (actual !== entry.sha256) {
      throw new Error(`${label} SHA-256 mismatch (expected ${entry.sha256}, found ${actual})`);
    }
    return retain ? Buffer.concat(retained, total) : undefined;
  } finally {
    closeSync(descriptor);
  }
}

function verifyPublicationIntegrity(
  bundleRoot: string,
  bundle: ArenaPublicationBundle,
  retainPaths: ReadonlySet<string>,
): Map<string, Buffer> {
  const retained = new Map<string, Buffer>();
  const listed = new Set(bundle.integrity.files.map((entry) => entry.path));
  const missing = publicationArtifactPaths(bundle).filter((path) => !listed.has(path));
  if (missing.length) {
    throw new Error(`publication integrity does not cover referenced artifact(s): ${missing.join(", ")}`);
  }
  for (const entry of bundle.integrity.files) {
    const keep = retainPaths.has(entry.path);
    if (keep && entry.bytes > MAX_JSON_BYTES) {
      throw new Error(`publication integrity artifact ${entry.path} exceeds the 16 MiB JSON input limit`);
    }
    const bytes = verifyIntegrityFile(bundleRoot, entry, keep);
    if (bytes) retained.set(entry.path, bytes);
  }
  return retained;
}

function integrityEntries(bundle: ArenaPublicationBundle): Map<string, { path: string; sha256: string; bytes: number }> {
  return new Map(bundle.integrity.files.map((entry) => [entry.path, entry]));
}

function requireIntegrityEntry(
  entries: ReadonlyMap<string, { path: string; sha256: string; bytes: number }>,
  path: string,
  label: string,
): { path: string; sha256: string; bytes: number } {
  const entry = entries.get(path);
  if (!entry) throw new Error(`publication integrity does not cover ${label}: ${path}`);
  return entry;
}

function verifyBatchBinding(
  bundle: ArenaPublicationBundle,
  verifiedJson: ReadonlyMap<string, Buffer>,
): { batch: ArenaBatchManifest; completion: ArenaBatchCompletion } {
  const entries = integrityEntries(bundle);
  const batchEntry = requireIntegrityEntry(entries, bundle.integrity.batch_manifest_path, "the batch manifest");
  const completionEntry = requireIntegrityEntry(entries, bundle.integrity.batch_completion_path, "the batch completion");
  if (batchEntry.sha256 !== bundle.integrity.batch_manifest_sha256
    || completionEntry.sha256 !== bundle.integrity.batch_completion_sha256) {
    throw new Error("publication integrity batch hashes do not match their covered artifacts");
  }
  const batchBytes = verifiedJson.get(bundle.integrity.batch_manifest_path);
  const completionBytes = verifiedJson.get(bundle.integrity.batch_completion_path);
  if (!batchBytes || !completionBytes) throw new Error("publication integrity did not retain batch provenance");
  const batch = parseCanonicalJson(batchBytes, (value) => ArenaBatchManifestSchema.parse(value), "publication batch manifest");
  const completion = parseCanonicalJson(
    completionBytes,
    (value) => ArenaBatchCompletionSchema.parse(value),
    "publication batch completion",
  );
  if (batch.configuration.command !== "daeb-production-rerun"
    || batch.batch_id !== bundle.integrity.batch_id
    || batch.source_commit_sha !== bundle.integrity.source_commit_sha
    || batch.configuration_hash !== bundle.integrity.configuration_hash
    || completion.batch_id !== batch.batch_id
    || completion.source_commit_sha !== batch.source_commit_sha
    || completion.configuration_hash !== batch.configuration_hash) {
    throw new Error("publication integrity does not match its production batch provenance");
  }
  const expectedKeys = [...batch.expected_cells].sort();
  const completionKeys = completion.cells.map((cell) => cell.key).sort();
  if (new Set(completionKeys).size !== completionKeys.length
    || expectedKeys.length !== completionKeys.length
    || expectedKeys.some((key, index) => key !== completionKeys[index])) {
    throw new Error("publication batch completion does not contain the exact configured cell set");
  }
  for (const cell of completion.cells) {
    const record = requireIntegrityEntry(entries, cell.record_path, `completed record ${cell.key}`);
    const cleanup = requireIntegrityEntry(entries, cell.cleanup_path, `cleanup evidence ${cell.key}`);
    if (record.sha256 !== cell.record_hash || cleanup.sha256 !== cell.cleanup_hash) {
      throw new Error(`publication integrity sidecar hash does not match batch completion cell ${cell.key}`);
    }
    if (batch.configuration.reset_required && cell.cleanup_status !== "confirmed") {
      throw new Error(`publication batch cleanup is not confirmed for ${cell.key}`);
    }
    for (const artifact of cell.artifacts) {
      const entry = requireIntegrityEntry(entries, artifact.path, `${artifact.name} artifact ${cell.key}`);
      if (entry.sha256 !== artifact.sha256) {
        throw new Error(`publication integrity artifact hash does not match batch completion cell ${cell.key}`);
      }
    }
  }
  return { batch, completion };
}

function loadCompletedCellRecords(
  bundleRoot: string,
  bundle: ArenaPublicationBundle,
  batch: ArenaBatchManifest,
  completion: ArenaBatchCompletion,
): Map<string, NormalizedCellRecord> {
  const entries = integrityEntries(bundle);
  const records = new Map<string, NormalizedCellRecord>();
  for (const cell of completion.cells) {
    const entry = requireIntegrityEntry(entries, cell.record_path, `completed record ${cell.key}`);
    const bytes = verifyIntegrityFile(bundleRoot, entry, true)!;
    const record = parseCanonicalJson(
      bytes,
      (value) => NormalizedCellRecordSchema.parse(value),
      `completed record ${cell.key}`,
    );
    const cleanupEntry = requireIntegrityEntry(entries, cell.cleanup_path, `cleanup evidence ${cell.key}`);
    const cleanup = parseCanonicalJson(
      verifyIntegrityFile(bundleRoot, cleanupEntry, true)!,
      (value) => ArenaCellCleanupSchema.parse(value),
      `cleanup evidence ${cell.key}`,
    );
    const configured = batch.configuration.cells.find((candidate) => candidate.key === cell.key);
    const pack = batch.configuration.packs.find((candidate) => candidate.vendor === configured?.vendor);
    const harness = batch.configuration.harnesses.find((candidate) => candidate.harness === configured?.harness);
    const key = `${record.target_id}/${record.surface}/${record.harness}/trial-${record.trial}`;
    const artifactPaths = Object.fromEntries(cell.artifacts.map((artifact) => [artifact.name, artifact.path]));
    const endsWithPath = (value: string, suffix: string): boolean => {
      const normalizedValue = value.replaceAll("\\", "/");
      const normalizedSuffix = suffix.replaceAll("\\", "/");
      return normalizedValue === normalizedSuffix || normalizedValue.endsWith(`/${normalizedSuffix}`);
    };
    const providerPins = (record.provider_provenance ?? [])
      .map((provider) => JSON.stringify([provider.kind, provider.id, provider.version])).sort();
    const configuredPins = (configured?.provider_pins ?? [])
      .map((provider) => JSON.stringify([provider.kind, provider.id, provider.version])).sort();
    const scoredTasks = record.task_results.filter((task) => !task.na);
    const passedTasks = scoredTasks.filter((task) => task.success);
    const derivedPassRate = scoredTasks.length ? passedTasks.length / scoredTasks.length : 0;
    if (!configured || !pack || !harness || key !== cell.key
      || record.record_id !== cell.record_id || record.cell_id !== cell.record_id
      || record.batch_id !== batch.batch_id || record.run_batch_id !== batch.batch_id
      || record.source_commit_sha !== batch.source_commit_sha
      || record.evaluation_set_id !== batch.configuration.suite.name
      || record.evaluation_set_version !== pack.standard_set_version
      || record.standard_set_version !== pack.standard_set_version
      || record.pack_content_hash !== pack.file_hash
      || record.product !== configured.vendor || record.target_id !== configured.vendor
      || record.surface !== configured.surface || record.harness !== configured.harness
      || record.profiles.length !== 1 || record.profiles[0] !== configured.profile
      || record.best_profile !== configured.profile || record.effort !== configured.effort
      || record.requested_model !== configured.model || record.model !== configured.model
      || record.harness_version_raw !== harness.version_raw
      || record.harness_version_semver !== harness.version_semver
      || record.trial !== configured.trial || record.status !== "completed"
      || record.blocked !== undefined || record.error !== null || record.validity_status !== "valid"
      || record.attempts !== 1 || !sameNumber(record.pass_at_1, derivedPassRate)
      || !sameNumber(record.pass_at_k, derivedPassRate)
      || cleanup.cell_id !== record.cell_id || cleanup.record_sha256 !== cell.record_hash
      || cleanup.status !== cell.cleanup_status || cleanup.status !== "confirmed"
      || cleanup.namespace !== record.execution_namespace
      || cleanup.provider?.id !== configured.reset_provider?.id
      || cleanup.provider?.version !== configured.reset_provider?.version
      || !endsWithPath(cleanup.record_path, cell.record_path)
      || record.tasks_total !== scoredTasks.length || record.tasks_passed !== passedTasks.length
      || providerPins.join("\0") !== configuredPins.join("\0")
      || cell.harness !== configured.harness || cell.requested_model !== configured.model
      || cell.actual_model !== configured.model || cell.harness_version_raw !== harness.version_raw
      || cell.harness_version_semver !== harness.version_semver
      || !endsWithPath(resolve(record.artifacts.base_dir, record.artifacts.results), artifactPaths.results!)
      || !endsWithPath(resolve(record.artifacts.base_dir, record.artifacts.trace), artifactPaths.trace!)
      || !endsWithPath(resolve(record.artifacts.base_dir, record.artifacts.transcript), artifactPaths.transcript!)
      || !endsWithPath(resolve(record.artifacts.base_dir, record.artifacts.invoke_metadata), artifactPaths.invoke_metadata!)) {
      throw new Error(`completed record identity does not match sealed batch cell ${cell.key}`);
    }
    records.set(cell.record_path, record);
  }
  return records;
}

function sameNumber(left: number | null | undefined, right: number | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) return left === right;
  return Math.abs(left - right) <= 1e-12;
}

function average(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function assertAggregateSourceBinding(
  batch: ArenaBatchManifest,
  completion: ArenaBatchCompletion,
  completedRecords: ReadonlyMap<string, NormalizedCellRecord>,
  selected: ReadonlyMap<string, { vendor: string; record: NormalizedResult }>,
): void {
  const completionByKey = new Map(completion.cells.map((cell) => [cell.key, cell]));
  for (const { vendor, record } of selected.values()) {
    const configured = batch.configuration.cells
      .filter((cell) => cell.vendor === vendor && cell.surface === record.surface && cell.harness === record.harness)
      .sort((left, right) => left.trial - right.trial);
    const expectedPaths = configured.map((cell) => completionByKey.get(cell.key)!.record_path);
    if (!record.source_records || record.source_records.length !== expectedPaths.length
      || record.source_records.some((path, index) => path !== expectedPaths[index])) {
      throw new Error(`publication aggregate ${vendor}/${record.surface}/${record.harness} does not cite its exact completed trials`);
    }
    const sources = expectedPaths.map((path) => completedRecords.get(path)!);
    const trialValues = sources.map((source) => source.pass_at_1);
    const mean = average(trialValues)!;
    const passAtK = average(sources.map((source) => source.pass_at_k))!;
    const attempts = Math.max(...sources.map((source) => source.attempts));
    const discovery = average(sources.flatMap((source) => source.discovery_score === null ? [] : [source.discovery_score]));
    const content = average(sources.flatMap((source) => source.content_quality === null ? [] : [source.content_quality]));
    const taskIds = new Set(sources.flatMap((source) => source.task_results
      .filter((task) => !task.na).map((task) => task.taskId)));
    const consistentTasks = [...taskIds].filter((taskId) => sources.every((source) =>
      source.task_results.some((task) => task.taskId === taskId && !task.na && task.success))).length;
    const consistency = taskIds.size ? consistentTasks / taskIds.size : null;
    const allPass = sources.every((source) => source.pass_at_1 >= 1) ? 1 : 0;
    const stability = sources.every((source) => source.pass_at_1 >= 1)
      ? "all_pass"
      : sources.every((source) => source.pass_at_1 <= 0) ? "all_fail" : "inconsistent";
    if (record.trial_count !== sources.length
      || record.product !== vendor || record.surface !== sources[0]!.surface
      || record.harness !== sources[0]!.harness
      || record.standard_set_version !== sources[0]!.standard_set_version
      || record.run_batch_id !== batch.batch_id || record.validity_status !== "valid"
      || record.model !== sources[0]!.model
      || record.harness_version_raw !== sources[0]!.harness_version_raw
      || record.harness_version_semver !== sources[0]!.harness_version_semver
      || record.best_profile !== sources[0]!.best_profile
      || record.profiles.length !== 1 || record.profiles[0] !== sources[0]!.profiles[0]
      || record.trial_values?.length !== trialValues.length
      || record.trial_values.some((value, index) => !sameNumber(value, trialValues[index]))
      || !sameNumber(record.mean_pass_rate, mean) || !sameNumber(record.pass_at_1, mean)
      || !sameNumber(record.pass_at_k, passAtK) || record.attempts !== attempts
      || record.tasks_total !== sources[0]!.tasks_total
      || record.tasks_passed !== Math.round(mean * sources[0]!.tasks_total)
      || record.range_pass_rate?.min !== Math.min(...trialValues)
      || record.range_pass_rate?.max !== Math.max(...trialValues)
      || !sameNumber(record.discovery_score, discovery) || !sameNumber(record.content_quality, content)
      || !sameNumber(record.task_consistency_at_3, consistency)
      || record.pass_3_tasks !== consistentTasks || record.pass_3_tasks_total !== taskIds.size
      || record.pass_all_3 !== allPass || record.trial_stability_at_3 !== stability) {
      throw new Error(`publication aggregate metrics do not match completed trials for ${vendor}/${record.surface}/${record.harness}`);
    }
  }
}

function assertNestedEvidenceCoverage(
  bundle: ArenaPublicationBundle,
  completion: ArenaBatchCompletion,
  completedCellRecords: ReadonlyMap<string, NormalizedCellRecord>,
  normalizedRecords: ReadonlyMap<string, NormalizedResult>,
  snapshots: ReadonlyMap<string, unknown>,
): void {
  const entries = integrityEntries(bundle);
  const completedRecords = new Set(completion.cells.map((cell) => cell.record_path));
  const cellsByEvidence = new Map(completion.cells.map((cell) => {
    const artifacts = Object.fromEntries(cell.artifacts.map((artifact) => [artifact.name, artifact.path]));
    return [JSON.stringify([artifacts.results, artifacts.trace, artifacts.transcript]), cell] as const;
  }));
  for (const [path, record] of normalizedRecords) {
    for (const source of record.source_records ?? []) {
      requireIntegrityEntry(entries, source, `source record referenced by ${path}`);
      if (!completedRecords.has(source)) {
        throw new Error(`normalized record ${path} references a source outside the completed batch: ${source}`);
      }
    }
  }
  const seenCells = new Set<string>();
  for (const [snapshotPath, snapshot] of snapshots) {
    if (!snapshot || typeof snapshot !== "object" || !Array.isArray((snapshot as { runs?: unknown }).runs)) {
      throw new Error(`snapshot ${snapshotPath} must contain a runs array`);
    }
    for (const run of (snapshot as { runs: unknown[] }).runs) {
      if (!run || typeof run !== "object") throw new Error(`snapshot ${snapshotPath} contains an invalid run`);
      const valueRun = run as Record<string, unknown>;
      const evidence = valueRun.evidence;
      if (!evidence || typeof evidence !== "object") throw new Error(`snapshot ${snapshotPath} run is missing evidence`);
      const value = evidence as { results?: unknown; trace?: unknown; transcript?: unknown };
      if (!Array.isArray(value.results) || value.results.length !== 1 || typeof value.results[0] !== "string"
        || !Array.isArray(value.trace) || value.trace.length !== 1 || typeof value.trace[0] !== "string"
        || typeof value.transcript !== "string" || !Array.isArray(valueRun.outcomes)) {
        throw new Error(`snapshot ${snapshotPath} run must carry one exact completed-cell evidence set and outcomes`);
      }
      const referenced = [value.results[0], value.trace[0], value.transcript];
      for (const reference of referenced) {
        requireIntegrityEntry(entries, reference, `evidence referenced by ${snapshotPath}`);
      }
      const cell = cellsByEvidence.get(JSON.stringify(referenced));
      const record = cell ? completedCellRecords.get(cell.record_path) : undefined;
      if (!cell || !record) throw new Error(`snapshot ${snapshotPath} references evidence outside one completed batch cell`);
      if (seenCells.has(cell.key)) throw new Error(`snapshot ${snapshotPath} duplicates completed batch cell ${cell.key}`);
      if (valueRun.profile !== record.best_profile || valueRun.harness !== record.harness
        || valueRun.surface !== record.surface || valueRun.model !== record.model
        || JSON.stringify(valueRun.outcomes) !== JSON.stringify(record.task_results)) {
        throw new Error(`snapshot ${snapshotPath} does not match completed batch cell ${cell.key}`);
      }
      seenCells.add(cell.key);
    }
  }
  const missingCells = completion.cells.filter((cell) => !seenCells.has(cell.key));
  if (missingCells.length) {
    throw new Error(`publication snapshots do not cover completed batch cell(s): ${missingCells.map((cell) => cell.key).join(", ")}`);
  }
}

function taskResultsFromCompletedCells(
  completion: ArenaBatchCompletion,
  records: ReadonlyMap<string, NormalizedCellRecord>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const cell of completion.cells) {
    const record = records.get(cell.record_path)!;
    const artifacts = Object.fromEntries(cell.artifacts.map((artifact) => [artifact.name, artifact.path]));
    for (const task of record.task_results) {
      out.push({
        vendor: record.product,
        task_id: task.taskId,
        success: task.na ? null : task.success,
        status: task.na ? "na" : task.success ? "pass" : "fail",
        profile: record.best_profile,
        harness: record.harness,
        surface: record.surface,
        model: record.model,
        trial: record.trial,
        evidence: {
          record: cell.record_path,
          results: [artifacts.results],
          trace: [artifacts.trace],
          transcript: artifacts.transcript,
        },
      });
    }
  }
  return out;
}

function writePinnedJson(
  directory: string,
  name: string,
  value: unknown,
  assertPinnedDirectory: () => void,
): { name: string; identity: { dev: number; ino: number }; size: number; mtimeMs: number; ctimeMs: number } {
  assertPinnedDirectory();
  const path = resolve(directory, name);
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let completed: ReturnType<typeof fstatSync> | undefined;
  try {
    const opened = fstatSync(descriptor);
    assertPinnedDirectory();
    const current = lstatSync(path);
    if (!opened.isFile() || current.isSymbolicLink() || !sameIdentity(opened, current)) {
      throw new Error(`publication export staging file ${name} changed during creation`);
    }
    writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(descriptor);
    completed = fstatSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  assertPinnedDirectory();
  const current = lstatSync(path);
  if (!completed || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1
    || !sameIdentity(completed, current) || current.size !== completed.size
    || current.mtimeMs !== completed.mtimeMs || current.ctimeMs !== completed.ctimeMs) {
    throw new Error(`publication export staging file ${name} changed during write`);
  }
  return {
    name,
    identity: { dev: Number(completed.dev), ino: Number(completed.ino) },
    size: completed.size,
    mtimeMs: completed.mtimeMs,
    ctimeMs: completed.ctimeMs,
  };
}

function slash(path: string): string {
  return path.replaceAll("\\", "/");
}

function assertComparableLeaderboardRecords(
  bundle: ArenaPublicationBundle,
  batch: ArenaBatchManifest,
  selected: ReadonlyMap<string, { vendor: string; record: NormalizedResult }>,
): void {
  const expectedProfiles = [...new Set(bundle.expected_matrix.required_effort_profiles)].sort();
  const availableProfiles = [...new Set(bundle.expected_matrix.effort_profiles)].sort();
  if (expectedProfiles.length !== 1 || expectedProfiles[0] !== PUBLICATION_EFFORT
    || availableProfiles.length !== 1 || availableProfiles[0] !== PUBLICATION_EFFORT) {
    throw new Error("publication export requires the frozen high-effort profile");
  }
  if (bundle.quality_gates.some((gate) => gate.status === "fail")) {
    throw new Error("publication export requires every blocking quality gate to pass");
  }
  const vendorSlugs = bundle.vendors.map((vendor) => vendor.slug);
  const batchVendors = batch.configuration.packs.map((pack) => pack.vendor);
  if (new Set(vendorSlugs).size !== vendorSlugs.length
    || [...vendorSlugs].sort().join("\0") !== [...batchVendors].sort().join("\0")) {
    throw new Error("publication vendors must uniquely and exactly match the sealed batch");
  }
  const batchHarnesses = batch.configuration.harnesses.map((pin) => pin.harness).sort();
  const matrixHarnesses = [...bundle.expected_matrix.harnesses].sort();
  const batchSurfaces = [...new Set(batch.configuration.packs.flatMap((pack) => pack.surfaces))].sort();
  const matrixSurfaces = [...new Set(bundle.expected_matrix.surfaces)].sort();
  if (matrixHarnesses.join("\0") !== batchHarnesses.join("\0")
    || matrixSurfaces.join("\0") !== batchSurfaces.join("\0")
    || new Set(bundle.expected_matrix.harnesses).size !== bundle.expected_matrix.harnesses.length
    || new Set(bundle.expected_matrix.surfaces).size !== bundle.expected_matrix.surfaces.length) {
    throw new Error("publication expected matrix does not match the sealed batch dimensions");
  }
  for (const vendor of bundle.vendors) {
    const pack = batch.configuration.packs.find((candidate) => candidate.vendor === vendor.slug)!;
    if (new Set(vendor.expected_surfaces).size !== vendor.expected_surfaces.length
      || [...vendor.expected_surfaces].sort().join("\0") !== [...pack.surfaces].sort().join("\0")) {
      throw new Error(`publication vendor ${vendor.slug} surfaces do not match the sealed batch`);
    }
  }
  if (bundle.suite_version !== batch.configuration.suite.version
    || bundle.benchmark !== batch.configuration.suite.name) {
    throw new Error("publication suite identity does not match the sealed batch");
  }
  const expectedKeys = bundle.vendors.flatMap((vendor) =>
    bundle.expected_matrix.harnesses.flatMap((harness) =>
      vendor.expected_surfaces.map((surface) => JSON.stringify([vendor.slug, harness, surface]))));
  if (new Set(expectedKeys).size !== expectedKeys.length
    || bundle.expected_matrix.expected_cells !== expectedKeys.length
    || selected.size !== expectedKeys.length
    || expectedKeys.some((key) => !selected.has(key))) {
    throw new Error("publication export requires one comparable aggregate for every expected vendor, harness, and surface");
  }
  const records = [...selected.values()];
  if (records.some(({ vendor, record }) => record.product !== vendor
    || record.summary_kind !== "aggregate"
    || record.run_batch_id !== bundle.integrity.batch_id
    || record.best_profile !== PUBLICATION_EFFORT
    || record.profiles.length !== 1
    || record.profiles[0] !== PUBLICATION_EFFORT
    || record.trial_count !== 3
    || record.source_records?.length !== 3
    || new Set(record.source_records).size !== 3
    || record.validity_status !== "valid")) {
    throw new Error("publication aggregate identity does not match the sealed batch and high-effort cohort");
  }
  if (new Set(records.map(({ record }) => record.standard_set_version)).size !== 1) {
    throw new Error("publication aggregates must share one standard-set version");
  }
  for (const harness of bundle.expected_matrix.harnesses) {
    const cohort = records.filter(({ record }) => record.harness === harness).map(({ record }) => record);
    const models = new Set(cohort.map((record) => record.model).filter(Boolean));
    const versions = new Set(cohort.map((record) => record.harness_version_semver).filter(Boolean));
    if (!cohort.length || models.size !== 1 || versions.size !== 1
      || cohort.some((record) => !record.model || !record.harness_version_semver)) {
      throw new Error(`publication harness ${harness} must use one model and one exact harness version`);
    }
  }
}

function loadVerifiedPublicationSource(opts: LoadArenaPublicationCohortOptions) {
  const root = resolve(opts.root);
  canonicalDirectory(root, "publication export root");
  const bundleRoot = resolveContained(root, opts.bundleDir, "publication bundle");
  assertNoSymlinkChain(root, bundleRoot, "publication bundle");
  canonicalDirectory(bundleRoot, "publication bundle");
  const manifestPath = safeBundleFile(bundleRoot, "manifest.json", "publication manifest");
  const bundle = ArenaPublicationBundleSchema.parse(readBoundedJson(bundleRoot, "manifest.json", "publication manifest"));
  const retainedJsonPaths = new Set(bundle.vendors.flatMap((vendor) => [
    ...vendor.artifacts.normalized_records,
    ...(vendor.artifacts.snapshots ?? []),
  ]).concat([
    bundle.integrity.batch_manifest_path,
    bundle.integrity.batch_completion_path,
  ]));
  const verifiedJson = verifyPublicationIntegrity(bundleRoot, bundle, retainedJsonPaths);
  const { batch, completion } = verifyBatchBinding(bundle, verifiedJson);
  const completedRecords = loadCompletedCellRecords(bundleRoot, bundle, batch, completion);
  for (const artifact of publicationArtifactPaths(bundle)) {
    safeBundleFile(bundleRoot, artifact, `publication artifact ${artifact}`);
  }
  const readPublicationJson = (path: string, label: string): unknown => {
    const bytes = verifiedJson.get(path);
    if (!bytes) throw new Error(`publication integrity did not retain verified JSON artifact ${path}`);
    return parseBoundedJsonBytes(bytes, label);
  };

  const normalizedRecords = new Map<string, NormalizedResult>();
  const snapshots = new Map<string, unknown>();
  for (const vendor of bundle.vendors) {
    for (const recordPath of vendor.artifacts.normalized_records) {
      normalizedRecords.set(recordPath, ArenaNormalizedResultSchema.parse(
        readPublicationJson(recordPath, `normalized record ${recordPath}`),
      ) as NormalizedResult);
    }
    for (const snapshotPath of vendor.artifacts.snapshots ?? []) {
      snapshots.set(snapshotPath, readPublicationJson(snapshotPath, `snapshot ${snapshotPath}`));
    }
  }
  assertNestedEvidenceCoverage(bundle, completion, completedRecords, normalizedRecords, snapshots);

  const leaderboardRecords: Array<{ vendor: string; path: string; record: NormalizedResult }> = [];
  const taskResults = taskResultsFromCompletedCells(completion, completedRecords);
  const evidence: Array<Record<string, unknown>> = [];
  for (const vendor of bundle.vendors) {
    for (const recordPath of vendor.artifacts.normalized_records) {
      const record = normalizedRecords.get(recordPath)!;
      leaderboardRecords.push({ vendor: vendor.slug, path: recordPath, record });
      evidence.push({ kind: "normalized_record", vendor: vendor.slug, surface: record.surface, harness: record.harness, path: recordPath });
    }
    for (const snapshotPath of vendor.artifacts.snapshots ?? []) {
      evidence.push({ kind: "snapshot", vendor: vendor.slug, path: snapshotPath });
    }
    for (const reportPath of vendor.artifacts.report_htmls ?? []) {
      evidence.push({ kind: "report_html", vendor: vendor.slug, path: reportPath });
    }
  }

  const selectedRecords = new Map<string, { vendor: string; path: string; record: NormalizedResult }>();
  for (const entry of leaderboardRecords) {
    if (entry.record.blocked || entry.record.summary_kind !== "aggregate") continue;
    const key = JSON.stringify([entry.vendor, entry.record.harness, entry.record.surface]);
    if (selectedRecords.has(key)) throw new Error(`publication bundle contains duplicate aggregate cohort ${key}`);
    selectedRecords.set(key, entry);
  }
  assertComparableLeaderboardRecords(bundle, batch, selectedRecords);
  assertAggregateSourceBinding(batch, completion, completedRecords, selectedRecords);
  return {
    root,
    bundleRoot,
    manifestPath,
    bundle,
    batch,
    completion,
    completedRecords,
    normalizedRecords,
    snapshots,
    leaderboardRecords,
    selectedRecords,
    taskResults,
    evidence,
  };
}

export function loadArenaPublicationCohort(
  opts: LoadArenaPublicationCohortOptions,
): VerifiedArenaPublicationCohort {
  const source = loadVerifiedPublicationSource(opts);
  return {
    bundle: source.bundle,
    batch: source.batch,
    records: [...source.selectedRecords.values()].map(({ vendor, path, record }) => ({ vendor, path, record })),
  };
}

export function buildArenaPublicationExport(opts: BuildArenaPublicationExportOptions): ArenaPublicationExportManifest {
  const source = loadVerifiedPublicationSource(opts);
  const {
    root,
    bundleRoot,
    manifestPath,
    bundle,
    leaderboardRecords,
    selectedRecords,
    taskResults,
    evidence,
  } = source;
  const outRoot = resolveContained(root, opts.outDir, "publication export output");
  assertSafeOutput(root, bundleRoot, outRoot);
  const generatedAt = opts.generatedAt ?? new Date();
  if (!Number.isFinite(generatedAt.getTime())) throw new Error("publication export generatedAt must be a valid date");
  const generatedAtIso = generatedAt.toISOString();
  const cells: Array<Record<string, unknown>> = [];
  for (const { vendor, path: recordPath, record } of leaderboardRecords) {
    const key = JSON.stringify([vendor, record.harness, record.surface]);
    if (selectedRecords.get(key)?.record !== record) continue;
    cells.push({
      id: `${vendor}/${record.surface}/${record.harness}`,
      vendor,
      surface: record.surface,
      harness: record.harness,
      model: record.model,
      profiles: record.profiles,
      task_count: record.tasks_total,
      tasks_passed: record.tasks_passed,
      mean_success_rate: record.mean_pass_rate ?? record.pass_at_1,
      range_success_rate: record.range_pass_rate ?? null,
      trial_count: record.trial_count ?? null,
      trial_values: record.trial_values ?? null,
      pass_all_3: record.pass_all_3 ?? null,
      pass_3_rate: record.task_consistency_at_3 ?? null,
      pass_3_count: record.pass_3_tasks ?? null,
      pass_3_total: record.pass_3_tasks_total ?? null,
      trial_stability_at_3: record.trial_stability_at_3 ?? null,
      latency_ms: record.latency_ms ?? null,
      total_duration_ms: record.total_duration_ms ?? null,
      first_action_latency_ms: record.first_action_latency_ms ?? null,
      tool_call_count: record.tool_call_count ?? null,
      token_usage: record.token_usage ?? null,
      token_cost: record.token_cost ?? null,
      cost_usd: record.cost_usd ?? null,
      tokens_in: record.tokens_in ?? null,
      tokens_out: record.tokens_out ?? null,
      harness_version_raw: record.harness_version_raw ?? null,
      harness_version_semver: record.harness_version_semver ?? null,
      run_batch_id: record.run_batch_id ?? null,
      validity_status: record.validity_status ?? null,
      normalized_record: recordPath,
      source_records: record.source_records ?? [],
    });
  }
  const makeView = (harness: string, surface: string | null) => {
    const rows = bundle.vendors.flatMap((vendor) => {
      const records = [...selectedRecords.values()]
        .filter((entry) => entry.vendor === vendor.slug && entry.record.harness === harness)
        .filter((entry) => surface === null || entry.record.surface === surface)
        .map((entry) => entry.record);
      if (!records.length) return [];
      const pass3Available = records.every((record) =>
        typeof record.pass_3_tasks === "number" && typeof record.pass_3_tasks_total === "number");
      const pass3Count = pass3Available ? records.reduce((sum, record) => sum + record.pass_3_tasks!, 0) : null;
      const pass3Total = pass3Available ? records.reduce((sum, record) => sum + record.pass_3_tasks_total!, 0) : null;
      const surfaceScores = Object.fromEntries(records.map((record) => [record.surface, {
        mean_pass_at_1: record.mean_pass_rate ?? record.pass_at_1,
        pass_3_rate: record.task_consistency_at_3 ?? null,
        pass_3_count: record.pass_3_tasks ?? null,
        pass_3_total: record.pass_3_tasks_total ?? null,
      }]));
      return [{
        rank: 0,
        vendor: vendor.slug,
        mean_pass_at_1: records.reduce((sum, record) => sum + (record.mean_pass_rate ?? record.pass_at_1), 0) / records.length,
        pass_3_rate: pass3Count !== null && pass3Total ? pass3Count / pass3Total : null,
        pass_3_count: pass3Count,
        pass_3_total: pass3Total,
        surface_count: records.length,
        surfaces: surfaceScores,
      }];
    }).sort((left, right) =>
      right.mean_pass_at_1 - left.mean_pass_at_1
      || (right.pass_3_rate ?? -1) - (left.pass_3_rate ?? -1)
      || (right.pass_3_count ?? -1) - (left.pass_3_count ?? -1)
      || left.vendor.localeCompare(right.vendor));
    return { rows: rows.map((row, index) => ({ ...row, rank: index + 1 })) };
  };
  const leaderboard = bundle.expected_matrix.harnesses.map((harness) => {
    const records = [...selectedRecords.values()].filter((entry) => entry.record.harness === harness).map((entry) => entry.record);
    const models = [...new Set(records.map((record) => record.model).filter((value): value is string => Boolean(value)))];
    const versions = [...new Set(records.map((record) => record.harness_version_semver).filter((value): value is string => Boolean(value)))];
    return {
      harness,
      model: models.length === 1 ? models[0] : null,
      effort: PUBLICATION_EFFORT,
      harness_version_semver: versions.length === 1 ? versions[0] : null,
      views: { overall: makeView(harness, null), api: makeView(harness, "api"), cli: makeView(harness, "cli") },
    };
  });

  const tasks = taskResults.reduce((acc, result) => {
    if (typeof result.task_id !== "string") return acc;
    const bucket = acc.get(result.task_id) ?? { task_id: result.task_id, results: [] };
    (bucket.results as Array<Record<string, unknown>>).push(result);
    acc.set(result.task_id, bucket);
    return acc;
  }, new Map<string, Record<string, unknown>>());
  const failures = taskResults.filter((result) => result.success === false).map((result) => ({
    ...result,
    failure_type: "unclassified",
    classification_status: "needs_review",
  }));
  if (bundle.competitive_report) evidence.push({ kind: "competitive_report", path: bundle.competitive_report });
  const methodology = {
    static_ax: bundle.layers.static_ax,
    behavioral: bundle.layers.behavioral,
    suite: bundle.suite,
    expected_matrix: bundle.expected_matrix,
    quality_gates: bundle.quality_gates,
  };
  const files: ArenaPublicationExportFile[] = [
    { id: "leaderboard", path: "leaderboard.json" },
    { id: "cells", path: "cells.json" },
    { id: "tasks", path: "tasks.json" },
    { id: "trials", path: "trials.json" },
    { id: "failures", path: "failures.json" },
    { id: "evidence-index", path: "evidence-index.json" },
    { id: "methodology-index", path: "methodology-index.json" },
  ];
  const outputs: Record<string, unknown> = {
    "leaderboard.json": {
      schema: "ax.axarena-leaderboard/v2",
      benchmark: bundle.benchmark,
      generated_at: generatedAtIso,
      scoring: {
        primary: "mean pass@1 within surface, then equal-weight macro-average across participating surfaces",
        tie_breakers: ["pass_3_rate", "pass_3_count", "vendor"],
        agents_are_independent: true,
        na_policy: "exclude structural N/A cells and publish the denominator",
      },
      agents: leaderboard,
    },
    "cells.json": { schema: "ax.axarena-cells/v1", benchmark: bundle.benchmark, generated_at: generatedAtIso, cells },
    "tasks.json": { schema: "ax.axarena-tasks/v1", benchmark: bundle.benchmark, generated_at: generatedAtIso, tasks: [...tasks.values()].sort((a, b) => String(a.task_id).localeCompare(String(b.task_id))) },
    "trials.json": { schema: "ax.axarena-trials/v1", benchmark: bundle.benchmark, generated_at: generatedAtIso, task_results: taskResults },
    "failures.json": { schema: "ax.axarena-failures/v1", benchmark: bundle.benchmark, generated_at: generatedAtIso, failures },
    "evidence-index.json": { schema: "ax.axarena-evidence-index/v1", benchmark: bundle.benchmark, generated_at: generatedAtIso, evidence },
    "methodology-index.json": { schema: "ax.axarena-methodology-index/v1", benchmark: bundle.benchmark, generated_at: generatedAtIso, methodology },
  };
  const exportManifest = ArenaPublicationExportManifestSchema.parse({
    schema: "ax.axarena-export/v1",
    benchmark: bundle.benchmark,
    category: bundle.category,
    suite_version: bundle.suite_version,
    generated_at: generatedAtIso,
    source_bundle: slash(relative(outRoot, bundleRoot)),
    source_manifest: slash(relative(outRoot, manifestPath)),
    source_integrity: bundle.integrity,
    files,
  });

  const outParent = dirname(outRoot);
  mkdirSync(outParent, { recursive: true });
  assertNoSymlinkChain(root, outParent, "publication export output parent");
  const realRoot = realpathSync(root);
  const realOutParent = realpathSync(outParent);
  if (!insideOrEqual(realRoot, realOutParent)) {
    throw new Error("publication export output parent escapes the repository root");
  }
  const parentDescriptor = openSync(
    outParent,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let staging: string | undefined;
  let stagingDescriptor: number | undefined;
  let stagingIdentity: { dev: number; ino: number } | undefined;
  try {
    const parentIdentity = fstatSync(parentDescriptor);
    const assertPinnedParent = (): void => {
      assertNoSymlinkChain(root, outParent, "publication export output parent");
      const current = lstatSync(outParent);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(parentIdentity, current)
        || realpathSync(outParent) !== realOutParent) {
        throw new Error("publication export output parent changed during export");
      }
    };
    assertPinnedParent();
    staging = mkdtempSync(resolve(outParent, ".axarena-export-"));
    stagingDescriptor = openSync(
      staging,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const openedStaging = fstatSync(stagingDescriptor);
    stagingIdentity = { dev: Number(openedStaging.dev), ino: Number(openedStaging.ino) };
    const realStaging = realpathSync(staging);
    if (!inside(realOutParent, realStaging)) throw new Error("publication export staging escaped its pinned parent");
    const assertPinnedStaging = (): void => {
      assertPinnedParent();
      const current = lstatSync(staging!);
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(stagingIdentity!, current)
        || realpathSync(staging!) !== realStaging) {
        throw new Error("publication export staging directory changed during export");
      }
    };
    const stagedFiles: Array<ReturnType<typeof writePinnedJson>> = [];
    const assertPinnedFiles = (directory: string): void => {
      for (const file of stagedFiles) {
        const path = resolve(directory, file.name);
        const current = lstatSync(path);
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1
          || !sameIdentity(file.identity, current) || current.size !== file.size
          || current.mtimeMs !== file.mtimeMs || current.ctimeMs !== file.ctimeMs) {
          throw new Error(`publication export staging file ${file.name} changed before publication`);
        }
      }
    };
    assertPinnedStaging();
    for (const [name, value] of Object.entries(outputs)) {
      stagedFiles.push(writePinnedJson(staging, name, value, assertPinnedStaging));
    }
    stagedFiles.push(writePinnedJson(staging, "manifest.json", exportManifest, assertPinnedStaging));
    assertPinnedFiles(staging);
    fsyncSync(stagingDescriptor);
    assertPinnedStaging();
    assertPinnedFiles(staging);
    assertPinnedParent();
    if (existsSync(outRoot)) throw new Error("publication export output appeared during export");
    renameSync(staging, outRoot);
    assertPinnedParent();
    const completed = lstatSync(outRoot);
    if (!completed.isDirectory() || completed.isSymbolicLink()
      || !sameIdentity(stagingIdentity, completed)
      || !inside(realOutParent, realpathSync(outRoot))) {
      throw new Error("publication export output escaped its pinned parent");
    }
    assertPinnedFiles(outRoot);
  } catch (error) {
    if (staging && existsSync(staging)) {
      const current = lstatSync(staging);
      if (stagingIdentity && current.isDirectory() && !current.isSymbolicLink()
        && sameIdentity(stagingIdentity, current)) {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    throw error;
  } finally {
    if (stagingDescriptor !== undefined) closeSync(stagingDescriptor);
    closeSync(parentDescriptor);
  }
  return exportManifest;
}
