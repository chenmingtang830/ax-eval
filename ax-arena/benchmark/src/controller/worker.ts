import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  EvaluationCellSchema,
  NormalizedCellRecordSchema,
  TargetPackSchema,
  type EvaluationCell,
  type NormalizedCellRecord,
  type TargetPack,
} from "ax-eval";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  assertBatchManifest,
  buildBatchCompletion,
  buildBatchPlan,
  loadBatchPlan,
  writeBatchCompletion,
} from "./batch.js";
import {
  assertArenaRecordIdentity,
  arenaCellWorkspaceArtifactDirectory,
  executeArenaCell,
  type ArenaCellDependencies,
  type ArenaCellExecution,
  type ArenaCellSpec,
} from "./cell.js";
import {
  ArenaBatchCellDescriptorSchema,
  ArenaBatchManifestSchema,
  ArenaBatchPlanSchema,
  ArenaCellCleanupSchema,
  arenaExecutionMode,
  type ArenaBatchCellDescriptor,
  type ArenaBatchCompletion,
  type ArenaBatchManifest,
  type ArenaBatchPlan,
  type ArenaCellCleanupRecord,
} from "./schemas.js";

export const ARENA_CELL_RESULT_SCHEMA = "ax.arena-cell-result/v1" as const;

const MAX_RESULT_FILE_BYTES = 16 * 1024 * 1024;
const NonBlank = z.string().max(4_096).refine((value) => /\S/.test(value), "must contain non-whitespace text");
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const SourceSha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const Timestamp = z.string().datetime({ offset: false, precision: 3 });
const Semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/).max(256);
const CellKey = z.string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,127}\/(?:api|cli|sdk|mcp)\/(?:codex|claude-code)\/trial-[1-9]\d*$/)
  .max(256);
const RelativeArtifactPath = z.string()
  .regex(/^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._\/-]+$/)
  .max(4_096);
const EnvironmentName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/).max(256);
const CredentialNames = z.array(EnvironmentName).max(256).refine(
  (names) => new Set(names).size === names.length,
  "credential names must be unique",
);

const ResultArtifactSchema = z.object({
  path: RelativeArtifactPath,
  sha256: Sha256,
}).strict();
const RuntimeArtifactSealSchema = ResultArtifactSchema.extend({
  name: z.enum(["invoke_metadata", "results", "trace", "transcript"]),
}).strict();

export const ArenaCellResultSchema = z.object({
  schema: z.literal(ARENA_CELL_RESULT_SCHEMA),
  batch_id: NonBlank,
  configuration_hash: Sha256,
  source_commit_sha: SourceSha,
  batch_plan_sha256: Sha256,
  cell_descriptor_sha256: Sha256,
  runtime_manifest_sha256: Sha256.nullable(),
  cell_key: CellKey,
  cell: EvaluationCellSchema,
  credential_names: z.object({
    host: CredentialNames,
    verification: CredentialNames,
    reset: CredentialNames,
    sandbox_scope: CredentialNames,
  }).strict(),
  expected_harness_version_raw: NonBlank,
  expected_harness_version_semver: Semver,
  observed_harness_version_raw: NonBlank,
  observed_harness_version_semver: Semver,
  actual_model: NonBlank,
  record_status: z.enum(["completed", "failed"]),
  cleanup_status: z.enum(["confirmed", "unconfirmed", "skipped"]),
  record: ResultArtifactSchema,
  cleanup: ResultArtifactSchema,
  artifacts: z.array(RuntimeArtifactSealSchema).length(4).superRefine((artifacts, context) => {
    const expected = ["invoke_metadata", "results", "trace", "transcript"];
    if (artifacts.some((artifact, index) => artifact.name !== expected[index])) {
      context.addIssue({ code: "custom", message: "runtime artifact seals must use canonical order" });
    }
  }),
  generated_at: Timestamp,
}).strict().superRefine((result, context) => {
  const expectedKey = `${result.cell.target_id}/${result.cell.surface}/${result.cell.harness.id}/trial-${result.cell.trial}`;
  for (const [path, message] of [
    [["batch_id"], result.batch_id === result.cell.batch_id ? undefined : "batch ID must match the evaluation cell"],
    [["source_commit_sha"], result.source_commit_sha === result.cell.source_commit_sha ? undefined : "source SHA must match the evaluation cell"],
    [["cell_key"], result.cell_key === expectedKey ? undefined : "cell key must match the evaluation cell"],
    [["record", "path"], result.record.path !== result.cleanup.path ? undefined : "record and cleanup paths must be distinct"],
  ] as const) {
    if (message) context.addIssue({ code: "custom", path: [...path], message });
  }
});
export type ArenaCellResult = z.infer<typeof ArenaCellResultSchema>;

export interface ArenaWorkerExecution {
  spec: ArenaCellSpec;
  execution: ArenaCellExecution;
  result: ArenaCellResult;
  resultPath: string;
}

export interface ArenaBatchResultAssemblyOptions {
  runRoot: string;
  batch: ArenaBatchManifest;
  plan: ArenaBatchPlan;
  resultPaths: readonly string[];
  canonicalPackPaths: Readonly<Record<string, string>>;
  runtimeManifestSha256?: string;
  now: Date;
}

export interface ArenaWorkerDependencies extends ArenaCellDependencies {
  runtimeManifestSha256?: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, canonical(nested)]));
  }
  return value;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function entryIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isPathEscape(path: string): boolean {
  return path === ".." || path.startsWith("../") || path.startsWith("..\\") || isAbsolute(path);
}

function pathEndsWith(value: string, suffix: string): boolean {
  const normalizedValue = value.replaceAll("\\", "/");
  const normalizedSuffix = suffix.replaceAll("\\", "/");
  return normalizedValue === normalizedSuffix || normalizedValue.endsWith(`/${normalizedSuffix}`);
}

function containedPath(runRoot: string, path: string, label: string): { absolute: string; relative: string } {
  const root = resolve(runRoot);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const lexical = relative(root, absolute);
  if (!lexical || isPathEscape(lexical)) throw new Error(`${label} must be contained by the arena run root`);
  return { absolute, relative: lexical.replaceAll("\\", "/") };
}

function assertDirectoryNoSymlinks(runRoot: string, path: string, label: string): void {
  const root = resolve(runRoot);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("arena run root must be a regular directory");
  }
  const { absolute } = containedPath(root, path, label);
  const rel = relative(root, absolute);
  let current = root;
  for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, segment);
    const stat = entryIfPresent(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`${label} cannot traverse a symlink: ${current}`);
  }
}

interface ReadArtifact {
  absolutePath: string;
  relativePath: string;
  bytes: Buffer;
}

function readContainedFileNoFollow(runRoot: string, path: string, label: string): ReadArtifact {
  const root = resolve(runRoot);
  const located = containedPath(root, path, label);
  assertDirectoryNoSymlinks(root, located.absolute, label);
  const physicalRoot = realpathSync(root);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(located.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_RESULT_FILE_BYTES) {
      throw new Error(`${label} must be a bounded regular file`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const current = lstatSync(located.absolute);
    if (!after.isFile()
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || current.isSymbolicLink() || !current.isFile() || current.dev !== after.dev || current.ino !== after.ino) {
      throw new Error(`${label} changed while it was being read`);
    }
    assertDirectoryNoSymlinks(root, located.absolute, label);
    const physical = relative(physicalRoot, realpathSync(located.absolute));
    if (!physical || isPathEscape(physical)) throw new Error(`${label} escaped the physical arena run root`);
    return { absolutePath: located.absolute, relativePath: located.relative, bytes };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readRegularFileNoFollow(path: string, label: string): Buffer {
  const absolute = resolve(path);
  const initial = lstatSync(absolute);
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > MAX_RESULT_FILE_BYTES) throw new Error(`${label} must be a bounded regular file`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const current = lstatSync(absolute);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || current.isSymbolicLink() || !current.isFile() || current.dev !== after.dev || current.ino !== after.ino) {
      throw new Error(`${label} changed while it was being read`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function exclusiveDurableWrite(runRoot: string, path: string, contents: string): void {
  const root = resolve(runRoot);
  const located = containedPath(root, path, "arena cell result path");
  assertDirectoryNoSymlinks(root, dirname(located.absolute), "arena cell result parent");
  mkdirSync(dirname(located.absolute), { recursive: true, mode: 0o700 });
  assertDirectoryNoSymlinks(root, dirname(located.absolute), "arena cell result parent");
  if (entryIfPresent(located.absolute)) throw new Error(`refusing to overwrite arena cell result: ${located.absolute}`);
  const temporary = resolve(dirname(located.absolute), `.${basename(located.absolute)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, located.absolute);
    const directory = openSync(dirname(located.absolute), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (entryIfPresent(temporary)) unlinkSync(temporary);
  }
}

function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(jsonBytes(value)).digest("hex");
}

function parsedCanonicalJson<T>(artifact: ReadArtifact, parse: (value: unknown) => T, label: string): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(artifact.bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  const parsed = parse(decoded);
  if (artifact.bytes.toString("utf8") !== jsonBytes(parsed)) {
    throw new Error(`${label} is not in canonical immutable JSON format`);
  }
  return parsed;
}

function exactDescriptor(batch: ArenaBatchManifest, descriptor: ArenaBatchCellDescriptor): ArenaBatchCellDescriptor {
  const parsed = ArenaBatchCellDescriptorSchema.parse(descriptor);
  const expected = buildBatchPlan(batch).cells.find((cell) => cell.key === parsed.key);
  if (!expected || !canonicalEqual(parsed, expected)) {
    throw new Error(`arena worker descriptor ${parsed.key} drifted from the immutable batch`);
  }
  return parsed;
}

function repositoryRootForPack(canonicalPackPath: string): string {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: dirname(resolve(canonicalPackPath)),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return realpathSync(root);
}

function milliseconds(seconds: number, label: string): number {
  const value = seconds * 1_000;
  if (!Number.isSafeInteger(value)) throw new Error(`${label} does not fit in a safe millisecond value`);
  return value;
}

export function selectArenaWorkerCell(plan: ArenaBatchPlan, cellKey: string): ArenaBatchCellDescriptor {
  const parsed = ArenaBatchPlanSchema.parse(plan);
  const matches = parsed.cells.filter((cell) => cell.key === cellKey);
  if (matches.length !== 1) {
    throw new Error(`arena worker requires exactly one descriptor for cell ${cellKey}; found ${matches.length}`);
  }
  return matches[0]!;
}

export function arenaWorkerCredentialNames(descriptor: ArenaBatchCellDescriptor): string[] {
  const parsed = ArenaBatchCellDescriptorSchema.parse(descriptor);
  return [...new Set([
    ...parsed.host_credential_names,
    ...parsed.verification_credential_names,
    ...parsed.reset_credential_names,
    ...parsed.sandbox_scope_names,
  ])].sort();
}

export function arenaCellArtifactDirectory(runRoot: string, descriptor: ArenaBatchCellDescriptor): string {
  const parsed = ArenaBatchCellDescriptorSchema.parse(descriptor);
  return resolve(runRoot, "cells", ...parsed.key.split("/"));
}

export function arenaCellResultPath(runRoot: string, descriptor: ArenaBatchCellDescriptor): string {
  return resolve(arenaCellArtifactDirectory(runRoot, descriptor), "cell-result.json");
}

export function deriveArenaCellSpec(
  batch: ArenaBatchManifest,
  descriptor: ArenaBatchCellDescriptor,
  runRoot: string,
  canonicalPackPath: string,
): ArenaCellSpec {
  const parsedBatch = ArenaBatchManifestSchema.parse(batch);
  const parsed = exactDescriptor(parsedBatch, descriptor);
  const repositoryRoot = repositoryRootForPack(canonicalPackPath);
  const physicalRunRoot = realpathSync(resolve(runRoot));
  const physicalPackPath = realpathSync(resolve(canonicalPackPath));
  for (const [path, label] of [
    [physicalRunRoot, "arena run root"],
    [physicalPackPath, "canonical pack"],
  ] as const) {
    const rel = relative(repositoryRoot, path);
    if (!rel || isPathEscape(rel)) throw new Error(`${label} must live inside the source repository`);
  }
  const artifactDir = arenaCellArtifactDirectory(physicalRunRoot, parsed);
  return {
    cwd: repositoryRoot,
    artifactDir,
    recordPath: resolve(artifactDir, "record.normalized.json"),
    cleanupPath: resolve(artifactDir, "cleanup.json"),
    packPath: physicalPackPath,
    batchId: parsed.batch_id,
    evaluationSetId: parsedBatch.configuration.suite.name,
    targetId: parsed.vendor,
    surface: parsed.surface,
    harness: parsed.harness,
    profile: parsed.profile,
    model: parsed.model,
    effort: parsed.effort,
    trial: parsed.trial,
    sourceCommitSha: parsed.source_commit_sha,
    invokeTimeoutMs: milliseconds(parsed.invoke_timeout_seconds, "invoke timeout"),
    firstActionTimeoutMs: milliseconds(parsed.first_action_timeout_seconds, "first-action timeout"),
    invokeRetries: parsed.invoke_retries,
    skipReset: !parsed.reset_required,
  };
}

function assertExecutionIdentity(
  batch: ArenaBatchManifest,
  descriptor: ArenaBatchCellDescriptor,
  execution: ArenaCellExecution,
): void {
  const cell = execution.cell;
  const key = `${cell.target_id}/${cell.surface}/${cell.harness.id}/trial-${cell.trial}`;
  const configuredPack = batch.configuration.packs.find((pack) => pack.vendor === descriptor.vendor);
  if (key !== descriptor.key
    || cell.batch_id !== descriptor.batch_id
    || cell.source_commit_sha !== descriptor.source_commit_sha
    || cell.evaluation_set_id !== batch.configuration.suite.name
    || cell.evaluation_set_version !== descriptor.standard_set_version
    || cell.target_id !== descriptor.vendor
    || cell.surface !== descriptor.surface
    || cell.harness.id !== descriptor.harness
    || cell.harness.profile !== descriptor.profile
    || cell.harness.effort !== descriptor.effort
    || cell.harness.model !== descriptor.model
    || cell.trial !== descriptor.trial
    || cell.pack.content_hash !== descriptor.pack_file_hash
    || cell.run_context.invoke_timeout_ms !== descriptor.invoke_timeout_seconds * 1_000
    || cell.run_context.first_action_timeout_ms !== descriptor.first_action_timeout_seconds * 1_000
    || cell.run_context.invoke_retries !== descriptor.invoke_retries
    || !sameStringSet(cell.required_credentials, descriptor.host_credential_names)
    || !sameStringSet(execution.credentialNames.host, descriptor.host_credential_names)
    || !sameStringSet(execution.credentialNames.verification, descriptor.verification_credential_names)
    || !sameStringSet(execution.credentialNames.reset, descriptor.reset_credential_names)
    || !canonicalEqual(execution.record.provider_provenance ?? [], descriptor.provider_pins)
    || (execution.cleanup.status === "confirmed"
      ? !canonicalEqual(execution.cleanup.provider ?? null, descriptor.reset_provider)
      : execution.cleanup.status === "skipped"
        ? execution.cleanup.provider !== undefined
        : execution.cleanup.provider !== undefined
          && !canonicalEqual(execution.cleanup.provider, descriptor.reset_provider))
    || !configuredPack
    || execution.pack.name !== descriptor.vendor
    || execution.pack.standard_set_version !== descriptor.standard_set_version
    || !sameStringSet(execution.pack.sandbox_scope.map((scope) => scope.env), descriptor.sandbox_scope_names)) {
    throw new Error(`arena cell execution ${descriptor.key} drifted from its immutable descriptor`);
  }
  assertArenaRecordIdentity(execution.record, cell);
}

function validateResultArtifacts(runRoot: string, result: ArenaCellResult): {
  record: NormalizedCellRecord;
  recordPath: string;
  cleanup: ArenaCellCleanupRecord;
  cleanupPath: string;
} {
  const recordFile = readContainedFileNoFollow(runRoot, result.record.path, "arena cell result record");
  const cleanupFile = readContainedFileNoFollow(runRoot, result.cleanup.path, "arena cell result cleanup");
  const recordHash = createHash("sha256").update(recordFile.bytes).digest("hex");
  const cleanupHash = createHash("sha256").update(cleanupFile.bytes).digest("hex");
  if (recordHash !== result.record.sha256 || cleanupHash !== result.cleanup.sha256) {
    throw new Error(`arena cell result ${result.cell_key} sidecar hash mismatch`);
  }
  const record = parsedCanonicalJson(
    recordFile,
    (value) => NormalizedCellRecordSchema.parse(value),
    "arena cell result record",
  );
  const cleanup = parsedCanonicalJson(
    cleanupFile,
    (value) => ArenaCellCleanupSchema.parse(value),
    "arena cell result cleanup",
  );
  const expectedArtifactRoot = arenaCellWorkspaceArtifactDirectory(runRoot, result.cell_key);
  for (const artifact of result.artifacts) {
    const fileName = record.artifacts[artifact.name];
    if (isAbsolute(fileName) || basename(fileName) !== fileName || fileName === "." || fileName === "..") {
      throw new Error(`arena cell result ${result.cell_key} ${artifact.name} name must be a direct relative file name`);
    }
    const configuredPath = resolve(expectedArtifactRoot, fileName);
    const sealed = readContainedFileNoFollow(runRoot, artifact.path, `arena cell result ${artifact.name}`);
    if (sealed.absolutePath !== resolve(configuredPath)
      || createHash("sha256").update(sealed.bytes).digest("hex") !== artifact.sha256) {
      throw new Error(`arena cell result ${result.cell_key} ${artifact.name} artifact seal mismatch`);
    }
  }
  assertArenaRecordIdentity(record, result.cell);
  if (record.harness_version_raw !== result.observed_harness_version_raw
    || record.harness_version_semver !== result.observed_harness_version_semver
    || record.model !== result.actual_model
    || record.status !== result.record_status
    || cleanup.status !== result.cleanup_status
    || cleanup.cell_id !== result.cell.cell_id
    || cleanup.namespace !== record.execution_namespace
    || !pathEndsWith(cleanup.record_path, recordFile.relativePath)) {
    throw new Error(`arena cell result ${result.cell_key} does not match its persisted sidecars`);
  }
  return {
    record,
    recordPath: recordFile.absolutePath,
    cleanup,
    cleanupPath: cleanupFile.absolutePath,
  };
}

export function writeArenaCellResult(
  runRoot: string,
  batch: ArenaBatchManifest,
  descriptor: ArenaBatchCellDescriptor,
  execution: ArenaCellExecution,
  now: Date,
  resultPath = arenaCellResultPath(runRoot, descriptor),
  runtimeManifestSha256: string | null = null,
): ArenaCellResult {
  const parsedBatch = ArenaBatchManifestSchema.parse(batch);
  const parsedDescriptor = exactDescriptor(parsedBatch, descriptor);
  assertBatchManifest(runRoot, parsedBatch);
  const persistedPlan = loadBatchPlan(runRoot, parsedBatch);
  const persistedDescriptor = selectArenaWorkerCell(persistedPlan, parsedDescriptor.key);
  if (!canonicalEqual(parsedDescriptor, persistedDescriptor)) {
    throw new Error(`arena worker descriptor ${parsedDescriptor.key} drifted from the persisted batch plan`);
  }
  if (parsedDescriptor.execution.runtime_backend === "pinned-oci" && !runtimeManifestSha256) {
    throw new Error(`pinned-oci arena cell ${parsedDescriptor.key} requires its verified runtime manifest hash`);
  }
  if (parsedDescriptor.execution.runtime_backend === "native" && runtimeManifestSha256) {
    throw new Error(`native arena cell ${parsedDescriptor.key} cannot claim a pinned runtime manifest`);
  }
  assertExecutionIdentity(parsedBatch, parsedDescriptor, execution);
  const recordFile = readContainedFileNoFollow(runRoot, execution.recordPath, "arena worker record");
  const cleanupFile = readContainedFileNoFollow(runRoot, execution.cleanupPath, "arena worker cleanup evidence");
  const record = parsedCanonicalJson(recordFile, (value) => NormalizedCellRecordSchema.parse(value), "arena worker record");
  const cleanup = parsedCanonicalJson(cleanupFile, (value) => ArenaCellCleanupSchema.parse(value), "arena worker cleanup evidence");
  if (!canonicalEqual(record, execution.record) || !canonicalEqual(cleanup, execution.cleanup)) {
    throw new Error(`arena cell execution ${parsedDescriptor.key} changed before its result envelope was written`);
  }
  assertArenaRecordIdentity(record, execution.cell);
  const artifactSeals = (["invoke_metadata", "results", "trace", "transcript"] as const).map((name) => {
    const artifact = readContainedFileNoFollow(
      runRoot,
      resolve(record.artifacts.base_dir, record.artifacts[name]),
      `arena worker ${name} artifact`,
    );
    return {
      name,
      path: artifact.relativePath,
      sha256: createHash("sha256").update(artifact.bytes).digest("hex"),
    };
  });
  const result = ArenaCellResultSchema.parse({
    schema: ARENA_CELL_RESULT_SCHEMA,
    batch_id: parsedDescriptor.batch_id,
    configuration_hash: parsedDescriptor.configuration_hash,
    source_commit_sha: parsedDescriptor.source_commit_sha,
    batch_plan_sha256: canonicalSha256(persistedPlan),
    cell_descriptor_sha256: canonicalSha256(persistedDescriptor),
    runtime_manifest_sha256: runtimeManifestSha256,
    cell_key: parsedDescriptor.key,
    cell: execution.cell,
    credential_names: {
      host: [...execution.credentialNames.host],
      verification: [...execution.credentialNames.verification],
      reset: [...execution.credentialNames.reset],
      sandbox_scope: [...parsedDescriptor.sandbox_scope_names],
    },
    expected_harness_version_raw: parsedDescriptor.harness_version_raw,
    expected_harness_version_semver: parsedDescriptor.harness_version_semver,
    observed_harness_version_raw: record.harness_version_raw,
    observed_harness_version_semver: record.harness_version_semver,
    actual_model: record.model,
    record_status: record.status,
    cleanup_status: cleanup.status,
    record: {
      path: recordFile.relativePath,
      sha256: createHash("sha256").update(recordFile.bytes).digest("hex"),
    },
    cleanup: {
      path: cleanupFile.relativePath,
      sha256: createHash("sha256").update(cleanupFile.bytes).digest("hex"),
    },
    artifacts: artifactSeals,
    generated_at: now.toISOString(),
  });
  exclusiveDurableWrite(runRoot, resultPath, jsonBytes(result));
  return result;
}

function readArenaCellResultEnvelope(runRoot: string, resultPath: string): ArenaCellResult {
  const resultFile = readContainedFileNoFollow(runRoot, resultPath, "arena cell result envelope");
  return parsedCanonicalJson(
    resultFile,
    (value) => ArenaCellResultSchema.parse(value),
    "arena cell result envelope",
  );
}

export function loadArenaCellResult(runRoot: string, resultPath: string): ArenaCellResult {
  const result = readArenaCellResultEnvelope(runRoot, resultPath);
  validateResultArtifacts(runRoot, result);
  return result;
}

function assertResultDescriptor(
  result: ArenaCellResult,
  descriptor: ArenaBatchCellDescriptor,
  plan: ArenaBatchPlan,
): void {
  const cell = result.cell;
  if (result.batch_id !== descriptor.batch_id
    || result.configuration_hash !== descriptor.configuration_hash
    || result.source_commit_sha !== descriptor.source_commit_sha
    || result.batch_plan_sha256 !== canonicalSha256(plan)
    || result.cell_descriptor_sha256 !== canonicalSha256(descriptor)
    || result.cell_key !== descriptor.key
    || cell.target_id !== descriptor.vendor
    || cell.surface !== descriptor.surface
    || cell.harness.id !== descriptor.harness
    || cell.harness.profile !== descriptor.profile
    || cell.harness.effort !== descriptor.effort
    || cell.harness.model !== descriptor.model
    || cell.trial !== descriptor.trial
    || cell.pack.content_hash !== descriptor.pack_file_hash
    || cell.evaluation_set_version !== descriptor.standard_set_version
    || result.expected_harness_version_raw !== descriptor.harness_version_raw
    || result.expected_harness_version_semver !== descriptor.harness_version_semver
    || !sameStringSet(result.credential_names.host, descriptor.host_credential_names)
    || !sameStringSet(result.credential_names.verification, descriptor.verification_credential_names)
    || !sameStringSet(result.credential_names.reset, descriptor.reset_credential_names)
    || !sameStringSet(result.credential_names.sandbox_scope, descriptor.sandbox_scope_names)) {
    throw new Error(`arena cell result ${result.cell_key} drifted from its immutable descriptor`);
  }
}

function loadCanonicalPack(path: string, descriptor: ArenaBatchCellDescriptor): TargetPack {
  const bytes = readRegularFileNoFollow(path, `canonical pack for ${descriptor.vendor}`);
  if (createHash("sha256").update(bytes).digest("hex") !== descriptor.pack_file_hash) {
    throw new Error(`canonical pack for ${descriptor.vendor} no longer matches its immutable hash`);
  }
  const pack = TargetPackSchema.parse(parseYaml(bytes.toString("utf8")));
  if (pack.name !== descriptor.vendor
    || pack.standard_set_version !== descriptor.standard_set_version
    || !sameStringSet(pack.sandbox_scope.map((scope) => scope.env), descriptor.sandbox_scope_names)) {
    throw new Error(`canonical pack for ${descriptor.vendor} drifted from its immutable descriptor`);
  }
  return pack;
}

function executionsFromResults(options: ArenaBatchResultAssemblyOptions): {
  executions: ArenaCellExecution[];
  results: ArenaCellResult[];
} {
  const batch = ArenaBatchManifestSchema.parse(options.batch);
  const plan = ArenaBatchPlanSchema.parse(options.plan);
  const persistedPlan = loadBatchPlan(options.runRoot, batch);
  const expectedPlan = buildBatchPlan(batch);
  if (!canonicalEqual(plan, expectedPlan) || !canonicalEqual(plan, persistedPlan)) {
    throw new Error("arena batch result assembly requires the exact persisted immutable batch plan");
  }
  const results = options.resultPaths.map((path) => readArenaCellResultEnvelope(options.runRoot, path));
  const runtimeManifestSha256 = options.runtimeManifestSha256 ?? null;
  const execution = plan.cells[0]!.execution;
  if (execution.runtime_backend === "pinned-oci" && !runtimeManifestSha256) {
    throw new Error("pinned-oci arena result assembly requires the verified runtime manifest hash");
  }
  if (execution.runtime_backend === "native" && runtimeManifestSha256) {
    throw new Error("native arena result assembly cannot claim a pinned runtime manifest");
  }
  if (results.some((result) => result.runtime_manifest_sha256 !== runtimeManifestSha256)) {
    throw new Error("arena cell results do not all match the assembled runtime manifest");
  }
  const byKey = new Map<string, ArenaCellResult>();
  for (const result of results) {
    if (byKey.has(result.cell_key)) throw new Error(`duplicate arena cell result for ${result.cell_key}`);
    byKey.set(result.cell_key, result);
  }
  const expectedKeys = new Set(plan.expected_cells);
  const extras = [...byKey.keys()].filter((key) => !expectedKeys.has(key));
  const missing = plan.expected_cells.filter((key) => !byKey.has(key));
  if (extras.length || missing.length || results.length !== plan.expected_cells.length) {
    throw new Error(
      `arena batch results are not exact (missing ${missing.join(", ") || "none"}; extra ${extras.join(", ") || "none"})`,
    );
  }
  const expectedVendors = [...new Set(plan.cells.map((cell) => cell.vendor))].sort();
  const suppliedVendors = Object.keys(options.canonicalPackPaths).sort();
  if (!sameStringSet(expectedVendors, suppliedVendors)) {
    throw new Error("canonical pack vendors must exactly match the arena batch plan");
  }
  const packs = new Map<string, TargetPack>();
  const executions = plan.cells.map((descriptor) => {
    const result = byKey.get(descriptor.key)!;
    assertResultDescriptor(result, descriptor, plan);
    const artifacts = validateResultArtifacts(options.runRoot, result);
    let pack = packs.get(descriptor.vendor);
    if (!pack) {
      pack = loadCanonicalPack(options.canonicalPackPaths[descriptor.vendor]!, descriptor);
      packs.set(descriptor.vendor, pack);
    }
    return {
      cell: result.cell as EvaluationCell,
      pack,
      credentialNames: {
        host: [...result.credential_names.host],
        verification: [...result.credential_names.verification],
        reset: [...result.credential_names.reset],
      },
      record: artifacts.record,
      recordPath: artifacts.recordPath,
      cleanup: artifacts.cleanup,
      cleanupPath: artifacts.cleanupPath,
    };
  });
  return { executions, results };
}

function assertCompletionMatchesResults(
  completion: ArenaBatchCompletion,
  results: readonly ArenaCellResult[],
): void {
  const byKey = new Map(results.map((result) => [result.cell_key, result]));
  for (const cell of completion.cells) {
    const result = byKey.get(cell.key);
    if (!result
      || cell.record_path !== result.record.path
      || cell.record_hash !== result.record.sha256
      || cell.cleanup_path !== result.cleanup.path
      || cell.cleanup_hash !== result.cleanup.sha256
      || !canonicalEqual(cell.artifacts, result.artifacts)) {
      throw new Error(`arena batch completion ${cell.key} does not match its sealed worker result`);
    }
  }
  if (completion.cells.length !== results.length) {
    throw new Error("arena batch completion does not exactly match its sealed worker result set");
  }
}

export function buildBatchCompletionFromResults(options: ArenaBatchResultAssemblyOptions): ArenaBatchCompletion {
  const assembled = executionsFromResults(options);
  const completion = buildBatchCompletion(
    options.runRoot,
    options.batch,
    assembled.executions,
    options.now,
    options.runtimeManifestSha256 ?? null,
    false,
  );
  assertCompletionMatchesResults(completion, assembled.results);
  return completion;
}

export function writeBatchCompletionFromResults(options: ArenaBatchResultAssemblyOptions): ArenaBatchCompletion {
  const assembled = executionsFromResults(options);
  return writeBatchCompletion(
    options.runRoot,
    options.batch,
    assembled.executions,
    options.now,
    (completion) => assertCompletionMatchesResults(completion, assembled.results),
    options.runtimeManifestSha256 ?? null,
    false,
  );
}

export async function executeArenaWorkerCell(
  batch: ArenaBatchManifest,
  descriptor: ArenaBatchCellDescriptor,
  runRoot: string,
  canonicalPackPath: string,
  dependencies: ArenaWorkerDependencies,
): Promise<ArenaWorkerExecution> {
  const parsedDescriptor = exactDescriptor(batch, descriptor);
  const persistedPlan = loadBatchPlan(runRoot, batch);
  if (!canonicalEqual(selectArenaWorkerCell(persistedPlan, parsedDescriptor.key), parsedDescriptor)) {
    throw new Error(`arena worker descriptor ${parsedDescriptor.key} drifted from the persisted batch plan`);
  }
  const expectedCredentialNames = new Set(arenaWorkerCredentialNames(parsedDescriptor));
  const supplied = Object.entries(dependencies.credentials)
    .filter(([, value]) => Boolean(value?.trim()))
    .map(([name]) => name);
  const missing = [...expectedCredentialNames].filter((name) => !dependencies.credentials[name]?.trim());
  const extra = supplied.filter((name) => !expectedCredentialNames.has(name));
  if (missing.length || extra.length) {
    throw new Error(
      `arena worker credential scope does not exactly match ${parsedDescriptor.key} (missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"})`,
    );
  }
  if (!canonicalEqual(dependencies.sandbox, parsedDescriptor.sandbox)) {
    throw new Error(`arena worker sandbox pin does not match ${parsedDescriptor.key}`);
  }
  const executionMode = dependencies.execution ?? arenaExecutionMode(batch.configuration);
  if (!canonicalEqual(executionMode, parsedDescriptor.execution)) {
    throw new Error(`arena worker execution mode does not match ${parsedDescriptor.key}`);
  }
  const spec = deriveArenaCellSpec(batch, parsedDescriptor, runRoot, canonicalPackPath);
  const execution = await executeArenaCell(spec, {
    ...dependencies,
    credentials: Object.fromEntries([...expectedCredentialNames].map((name) => [name, dependencies.credentials[name]])),
  });
  const resultPath = arenaCellResultPath(runRoot, parsedDescriptor);
  const result = writeArenaCellResult(
    runRoot,
    batch,
    parsedDescriptor,
    execution,
    dependencies.now(),
    resultPath,
    dependencies.runtimeManifestSha256 ?? null,
  );
  return { spec, execution, result, resultPath };
}
