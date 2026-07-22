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
import { NORMALIZED_RESULT_SCHEMA, type NormalizedResult } from "ax-eval";
import { z } from "zod";
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

function taskResultsFromSnapshot(snapshotPath: string, snapshot: unknown): Array<Record<string, unknown>> {
  if (!snapshot || typeof snapshot !== "object") return [];
  const runs = (snapshot as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const record = run as {
      profile?: unknown;
      harness?: unknown;
      surface?: unknown;
      model?: unknown;
      outcomes?: unknown;
      evidence?: { results?: unknown; trace?: unknown; transcript?: unknown };
    };
    if (!Array.isArray(record.outcomes)) continue;
    for (const outcome of record.outcomes) {
      if (!outcome || typeof outcome !== "object") continue;
      const value = outcome as Record<string, unknown>;
      out.push({
        task_id: value.taskId ?? value.task_id ?? value.id ?? null,
        success: typeof value.success === "boolean" ? value.success : null,
        status: value.status ?? null,
        profile: record.profile ?? null,
        harness: record.harness ?? null,
        surface: record.surface ?? null,
        model: record.model ?? null,
        evidence: {
          snapshot: snapshotPath,
          results: Array.isArray(record.evidence?.results) ? record.evidence.results : [],
          trace: Array.isArray(record.evidence?.trace) ? record.evidence.trace : [],
          transcript: typeof record.evidence?.transcript === "string" ? record.evidence.transcript : null,
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
): void {
  assertPinnedDirectory();
  const path = resolve(directory, name);
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const opened = fstatSync(descriptor);
    assertPinnedDirectory();
    const current = lstatSync(path);
    if (!opened.isFile() || current.isSymbolicLink() || !sameIdentity(opened, current)) {
      throw new Error(`publication export staging file ${name} changed during creation`);
    }
    writeFileSync(descriptor, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  assertPinnedDirectory();
}

function slash(path: string): string {
  return path.replaceAll("\\", "/");
}

function assertComparableLeaderboardRecords(
  bundle: ArenaPublicationBundle,
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
  const expectedKeys = bundle.vendors.flatMap((vendor) =>
    bundle.expected_matrix.harnesses.flatMap((harness) =>
      bundle.expected_matrix.surfaces.map((surface) => JSON.stringify([vendor.slug, harness, surface]))));
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
    || record.trial_count !== 3)) {
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

export function buildArenaPublicationExport(opts: BuildArenaPublicationExportOptions): ArenaPublicationExportManifest {
  const root = resolve(opts.root);
  canonicalDirectory(root, "publication export root");
  const bundleRoot = resolveContained(root, opts.bundleDir, "publication bundle");
  assertNoSymlinkChain(root, bundleRoot, "publication bundle");
  canonicalDirectory(bundleRoot, "publication bundle");
  const outRoot = resolveContained(root, opts.outDir, "publication export output");
  assertSafeOutput(root, bundleRoot, outRoot);
  const generatedAt = opts.generatedAt ?? new Date();
  if (!Number.isFinite(generatedAt.getTime())) throw new Error("publication export generatedAt must be a valid date");
  const generatedAtIso = generatedAt.toISOString();

  const manifestPath = safeBundleFile(bundleRoot, "manifest.json", "publication manifest");
  const bundle = ArenaPublicationBundleSchema.parse(readBoundedJson(bundleRoot, "manifest.json", "publication manifest"));
  const retainedJsonPaths = new Set(bundle.vendors.flatMap((vendor) => [
    ...vendor.artifacts.normalized_records,
    ...(vendor.artifacts.snapshots ?? []),
  ]));
  const verifiedJson = verifyPublicationIntegrity(bundleRoot, bundle, retainedJsonPaths);
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
      snapshots.set(snapshotPath, readPublicationJson(
        snapshotPath,
        `snapshot ${snapshotPath}`,
      ));
    }
  }

  const leaderboardRecords: Array<{ vendor: string; record: NormalizedResult }> = [];
  const cells: Array<Record<string, unknown>> = [];
  const taskResults: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];
  for (const vendor of bundle.vendors) {
    for (const recordPath of vendor.artifacts.normalized_records) {
      const record = normalizedRecords.get(recordPath)!;
      leaderboardRecords.push({ vendor: vendor.slug, record });
      cells.push({
        id: `${vendor.slug}/${record.surface}/${record.harness}`,
        vendor: vendor.slug,
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
      evidence.push({ kind: "normalized_record", vendor: vendor.slug, surface: record.surface, harness: record.harness, path: recordPath });
    }
    for (const snapshotPath of vendor.artifacts.snapshots ?? []) {
      taskResults.push(...taskResultsFromSnapshot(snapshotPath, snapshots.get(snapshotPath)).map((result) => ({ vendor: vendor.slug, ...result })));
      evidence.push({ kind: "snapshot", vendor: vendor.slug, path: snapshotPath });
    }
    for (const reportPath of vendor.artifacts.report_htmls ?? []) {
      evidence.push({ kind: "report_html", vendor: vendor.slug, path: reportPath });
    }
  }

  const selectedRecords = new Map<string, { vendor: string; record: NormalizedResult }>();
  for (const entry of leaderboardRecords) {
    if (entry.record.blocked) continue;
    if (entry.record.summary_kind !== "aggregate") continue;
    const key = JSON.stringify([entry.vendor, entry.record.harness, entry.record.surface]);
    if (selectedRecords.has(key)) throw new Error(`publication bundle contains duplicate aggregate cohort ${key}`);
    selectedRecords.set(key, entry);
  }
  assertComparableLeaderboardRecords(bundle, selectedRecords);
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
    assertPinnedStaging();
    for (const [name, value] of Object.entries(outputs)) {
      writePinnedJson(staging, name, value, assertPinnedStaging);
    }
    writePinnedJson(staging, "manifest.json", exportManifest, assertPinnedStaging);
    fsyncSync(stagingDescriptor);
    assertPinnedStaging();
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
