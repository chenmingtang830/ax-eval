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

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const PUBLICATION_EFFORT = "high" as const;

const ArtifactPathSchema = z.string().min(1).max(4_096);
const ArtifactSchema = z.object({
  vendor_card: ArtifactPathSchema.optional(),
  oracle_extract: ArtifactPathSchema.optional(),
  compiled_pack: ArtifactPathSchema.optional(),
  approval: ArtifactPathSchema.optional(),
  support_matrix: ArtifactPathSchema.optional(),
  snapshot: ArtifactPathSchema.optional(),
  snapshots: z.array(ArtifactPathSchema).optional(),
  report_html: ArtifactPathSchema.optional(),
  report_htmls: z.array(ArtifactPathSchema).optional(),
  normalized_records: z.array(ArtifactPathSchema),
}).passthrough();

const PublicationLayerSchema = z.object({
  description: z.string(),
  methodology_artifacts: z.array(ArtifactPathSchema),
}).passthrough();

export const ArenaPublicationBundleSchema = z.object({
  schema: z.literal("ax.publication-bundle/v2"),
  benchmark: z.string().min(1),
  category: z.string().min(1),
  suite: z.string().min(1),
  suite_version: z.number().int().nonnegative(),
  expected_matrix: z.object({
    surfaces: z.array(z.string()),
    harnesses: z.array(z.string()),
    effort_profiles: z.array(z.string()),
    required_effort_profiles: z.array(z.string()),
    expected_cells: z.number().int().nonnegative(),
  }).passthrough(),
  quality_gates: z.array(z.object({
    id: z.string(),
    label: z.string(),
    status: z.enum(["pass", "warn", "fail"]),
    detail: z.string(),
  }).passthrough()),
  layers: z.object({
    static_ax: PublicationLayerSchema,
    behavioral: PublicationLayerSchema,
  }).passthrough(),
  vendors: z.array(z.object({
    slug: z.string().min(1),
    artifacts: ArtifactSchema,
  }).passthrough()),
  competitive_report: ArtifactPathSchema.optional(),
}).passthrough();
export type ArenaPublicationBundle = z.infer<typeof ArenaPublicationBundleSchema>;

export const ArenaPublicationExportManifestSchema = z.object({
  schema: z.literal("ax.axarena-export/v1"),
  benchmark: z.string().min(1),
  category: z.string().min(1),
  suite_version: z.number().int().nonnegative(),
  generated_at: z.string(),
  source_bundle: z.string(),
  source_manifest: z.string(),
  files: z.array(z.object({ id: z.string().min(1), path: z.string().min(1) }).strict()),
}).strict();
export type ArenaPublicationExportManifest = z.infer<typeof ArenaPublicationExportManifestSchema>;
export type ArenaPublicationExportFile = ArenaPublicationExportManifest["files"][number];

const NormalizedResultSchema = z.object({
  schema: z.literal(NORMALIZED_RESULT_SCHEMA),
  surface: z.enum(["api", "cli", "sdk", "mcp"]),
  product: z.string(),
  harness: z.string(),
  standard_set_version: z.string(),
  generated_at: z.string(),
  tasks_total: z.number(),
  tasks_passed: z.number(),
  pass_at_1: z.number(),
  pass_at_k: z.number(),
  attempts: z.number(),
  discovery_score: z.number().nullable(),
  content_quality: z.number().nullable(),
  profiles: z.array(z.string()),
  best_profile: z.string().nullable(),
  model: z.string().nullable(),
  blocked: z.string().optional(),
  summary_kind: z.enum(["single", "aggregate"]).optional(),
  source_records: z.array(z.string()).optional(),
  mean_pass_rate: z.number().optional(),
  range_pass_rate: z.object({ min: z.number(), max: z.number() }).nullable().optional(),
  trial_count: z.number().optional(),
  trial_values: z.array(z.number()).optional(),
  task_consistency_at_3: z.number().nullable().optional(),
  pass_3_tasks: z.number().nullable().optional(),
  pass_3_tasks_total: z.number().nullable().optional(),
  pass_all_3: z.number().nullable().optional(),
  trial_stability_at_3: z.enum(["all_pass", "all_fail", "inconsistent"]).nullable().optional(),
  latency_ms: z.number().nullable().optional(),
  total_duration_ms: z.number().nullable().optional(),
  first_action_latency_ms: z.number().nullable().optional(),
  tool_call_count: z.number().nullable().optional(),
  token_usage: z.record(z.number()).nullable().optional(),
  token_cost: z.number().nullable().optional(),
  cost_usd: z.number().nullable().optional(),
  tokens_in: z.number().nullable().optional(),
  tokens_out: z.number().nullable().optional(),
  harness_version_raw: z.string().nullable().optional(),
  harness_version_semver: z.string().nullable().optional(),
  run_batch_id: z.string().nullable().optional(),
  validity_status: z.string().nullable().optional(),
}).passthrough();

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

function assertSafeOutput(root: string, bundleRoot: string, outRoot: string): void {
  if (!inside(root, outRoot)) throw new Error("publication export output must resolve inside the repository root");
  if (existsSync(outRoot)) throw new Error("publication export output must not already exist");
  if (inside(bundleRoot, outRoot) || inside(outRoot, bundleRoot) || bundleRoot === outRoot) {
    throw new Error("publication export output must not overlap the source bundle");
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

function artifactPaths(bundle: ArenaPublicationBundle): string[] {
  const paths = [
    bundle.suite,
    ...bundle.layers.static_ax.methodology_artifacts,
    ...bundle.layers.behavioral.methodology_artifacts,
    ...(bundle.competitive_report ? [bundle.competitive_report] : []),
  ];
  for (const vendor of bundle.vendors) {
    const artifacts = vendor.artifacts;
    paths.push(...[
      artifacts.vendor_card,
      artifacts.oracle_extract,
      artifacts.compiled_pack,
      artifacts.approval,
      artifacts.support_matrix,
      artifacts.snapshot,
      artifacts.report_html,
    ].filter((item): item is string => typeof item === "string"));
    paths.push(...(artifacts.snapshots ?? []), ...(artifacts.report_htmls ?? []), ...artifacts.normalized_records);
  }
  return [...new Set(paths)];
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
  const resolvedArtifacts = new Map<string, string>();
  for (const artifact of artifactPaths(bundle)) {
    resolvedArtifacts.set(artifact, safeBundleFile(bundleRoot, artifact, `publication artifact ${artifact}`));
  }

  const normalizedRecords = new Map<string, NormalizedResult>();
  const snapshots = new Map<string, unknown>();
  for (const vendor of bundle.vendors) {
    for (const recordPath of vendor.artifacts.normalized_records) {
      normalizedRecords.set(recordPath, NormalizedResultSchema.parse(
        readBoundedJson(bundleRoot, recordPath, `normalized record ${recordPath}`),
      ) as NormalizedResult);
    }
    for (const snapshotPath of vendor.artifacts.snapshots ?? []) {
      snapshots.set(snapshotPath, readBoundedJson(
        bundleRoot,
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
    const key = `${entry.vendor}\0${entry.record.harness}\0${entry.record.surface}`;
    const current = selectedRecords.get(key);
    if (!current || (entry.record.summary_kind === "aggregate" && current.record.summary_kind !== "aggregate")
      || (entry.record.summary_kind === current.record.summary_kind && entry.record.generated_at > current.record.generated_at)) {
      selectedRecords.set(key, entry);
    }
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
