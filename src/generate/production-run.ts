import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { SurfaceId } from "../surface/types.js";
import type { NormalizedResult } from "./record.js";
import { aggregateNormalizedResults } from "./record.js";
import { DAEB_VENDOR_ORDER, DAEB_V1_EXECUTION_SURFACES } from "./low-pass.js";

export const DAEB_PRODUCTION_RUN_SCHEMA = "ax.daeb-production-run/v1" as const;
export const DAEB_PRODUCTION_ARCHIVE_SCHEMA = "ax.daeb-production-archive/v1" as const;
export const DAEB_PRODUCTION_TRIAL_COUNT = 3 as const;
export const DAEB_PRODUCTION_EFFORT = "medium" as const;
export const DAEB_PRODUCTION_HARNESSES = ["codex", "claude-code"] as const;
export const DAEB_PRODUCTION_SURFACES = [...DAEB_V1_EXECUTION_SURFACES] as const;

export interface ProductionTrialRecord {
  trial: number;
  trial_dir: string;
  normalized_record: string;
  snapshot_path?: string;
  report_html?: string;
  classification_path?: string;
  result_paths: string[];
}

export interface ProductionAggregateManifest {
  schema: typeof DAEB_PRODUCTION_RUN_SCHEMA;
  vendor: string;
  surface: SurfaceId;
  harness: (typeof DAEB_PRODUCTION_HARNESSES)[number];
  effort: typeof DAEB_PRODUCTION_EFFORT;
  model: string;
  trial_count: number;
  generated_at: string;
  aggregate_record: string;
  trial_manifest: string;
  trials: ProductionTrialRecord[];
}

export interface ProductionArchiveManifestEntry {
  source_path: string;
  archive_path: string;
  reason: string;
  status: "archived" | "missing";
}

export function daebProductionVendorOrder(): string[] {
  return [...DAEB_VENDOR_ORDER];
}

export function defaultProductionRunRoot(root: string, runDir?: string): string {
  if (!runDir || runDir === "results") return resolve(root, "results", "runs", "daeb-production");
  return resolve(root, runDir);
}

export function productionHarnessRoot(runRoot: string, vendor: string, surface: SurfaceId, harness: string): string {
  return resolve(runRoot, vendor, surface, harness);
}

export function productionTrialDir(runRoot: string, vendor: string, surface: SurfaceId, harness: string, trial: number): string {
  return resolve(productionHarnessRoot(runRoot, vendor, surface, harness), `trial-${trial}`);
}

export function productionAggregateDir(runRoot: string, vendor: string, surface: SurfaceId, harness: string): string {
  return resolve(productionHarnessRoot(runRoot, vendor, surface, harness), "aggregate");
}

/**
 * Pre-flight cleanup for a production run root: move known debug-only lanes
 * (targeted re-runs, post-normalize/smoke scratch, ad hoc matrix previews)
 * out of the way before treating the tree as clean benchmark-of-record input.
 * Relative to `runRoot` itself (not hardcoded to any one historical run name),
 * so it works the same way for every fresh `daeb-production-rerun`.
 */
export function archiveDaebDebugArtifacts(runRoot: string, archiveRoot: string): ProductionArchiveManifestEntry[] {
  const candidates = [
    { path: resolve(runRoot, "targeted-low"), reason: "targeted reruns are debug-only evidence" },
    { path: resolve(runRoot, "targeted-high"), reason: "targeted reruns are debug-only evidence" },
    { path: resolve(runRoot, "post-normalize"), reason: "post-normalize lanes are not benchmark-of-record input" },
    { path: resolve(runRoot, "smoke"), reason: "smoke lanes are not benchmark-of-record input" },
  ];
  const lowPassDir = resolve(runRoot, "low-pass");
  if (existsSync(lowPassDir)) {
    for (const name of readdirSync(lowPassDir)) {
      if (/^competitive-matrix-preview.*\.html$/i.test(name)) {
        candidates.push({
          path: resolve(lowPassDir, name),
          reason: "matrix preview html is ad hoc inspection output",
        });
      }
    }
  }
  const entries: ProductionArchiveManifestEntry[] = [];
  for (const candidate of candidates) {
    const archivePath = resolve(archiveRoot, relative(runRoot, candidate.path));
    if (!existsSync(candidate.path)) {
      entries.push({
        source_path: candidate.path,
        archive_path: archivePath,
        reason: candidate.reason,
        status: "missing",
      });
      continue;
    }
    mkdirSync(dirname(archivePath), { recursive: true });
    renameSync(candidate.path, archivePath);
    entries.push({
      source_path: candidate.path,
      archive_path: archivePath,
      reason: candidate.reason,
      status: "archived",
    });
  }
  return entries;
}

export function writeArchiveManifest(archiveRoot: string, entries: ProductionArchiveManifestEntry[]): string {
  mkdirSync(archiveRoot, { recursive: true });
  const path = resolve(archiveRoot, "archive-manifest.json");
  writeFileSync(path, JSON.stringify({
    schema: DAEB_PRODUCTION_ARCHIVE_SCHEMA,
    generated_at: new Date().toISOString(),
    entries,
  }, null, 2) + "\n");
  return path;
}

export function loadAggregateCandidateRecords(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".normalized.json")) out.push(full);
    }
  }
  const aggregate = out.filter((path) => relative(dir, path).split(sep).includes("aggregate"));
  return (aggregate.length ? aggregate : out).sort();
}

function loadTrialOutcomeMap(snapshotPath: string | undefined): Map<string, boolean> | null {
  if (!snapshotPath || !existsSync(snapshotPath)) return null;
  const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
    runs?: Array<{ outcomes?: Array<{ taskId?: string; success?: boolean; na?: boolean }> }>;
  };
  const outcomes = parsed.runs?.[0]?.outcomes ?? [];
  const byTask = new Map<string, boolean>();
  for (const outcome of outcomes) {
    if (!outcome.taskId || outcome.na) continue;
    if (!byTask.has(outcome.taskId)) byTask.set(outcome.taskId, outcome.success === true);
  }
  return byTask;
}

function taskConsistencyAt3(trials: ProductionTrialRecord[]): number | null {
  if (trials.length !== 3) return null;
  const trialMaps = trials.map((trial) => loadTrialOutcomeMap(trial.snapshot_path));
  if (trialMaps.some((map) => !map)) return null;
  const maps = trialMaps as Map<string, boolean>[];
  const taskIds = new Set<string>();
  for (const map of maps) {
    for (const taskId of map.keys()) taskIds.add(taskId);
  }
  if (!taskIds.size) return null;
  let stablePasses = 0;
  for (const taskId of taskIds) {
    if (maps.every((map) => map.get(taskId) === true)) stablePasses += 1;
  }
  return stablePasses / taskIds.size;
}

export function writeProductionAggregate(opts: {
  runRoot: string;
  vendor: string;
  surface: SurfaceId;
  harness: (typeof DAEB_PRODUCTION_HARNESSES)[number];
  model: string;
  trials: ProductionTrialRecord[];
  records: NormalizedResult[];
}): ProductionAggregateManifest {
  const aggregateDir = productionAggregateDir(opts.runRoot, opts.vendor, opts.surface, opts.harness);
  mkdirSync(aggregateDir, { recursive: true });
  const sourceRecords = opts.trials.map((trial) => trial.normalized_record);
  const aggregate = aggregateNormalizedResults(opts.records, sourceRecords);
  aggregate.task_consistency_at_3 = taskConsistencyAt3(opts.trials);
  const normalizedPath = resolve(aggregateDir, `${opts.harness}.${opts.surface}.aggregate.normalized.json`);
  writeFileSync(normalizedPath, JSON.stringify(aggregate, null, 2) + "\n");
  const trialManifestPath = resolve(aggregateDir, "trial-manifest.json");
  writeFileSync(trialManifestPath, JSON.stringify({
    schema: DAEB_PRODUCTION_RUN_SCHEMA,
    vendor: opts.vendor,
    surface: opts.surface,
    harness: opts.harness,
    effort: DAEB_PRODUCTION_EFFORT,
    model: opts.model,
    trial_count: opts.trials.length,
    generated_at: new Date().toISOString(),
    trials: opts.trials,
  }, null, 2) + "\n");
  const manifest: ProductionAggregateManifest = {
    schema: DAEB_PRODUCTION_RUN_SCHEMA,
    vendor: opts.vendor,
    surface: opts.surface,
    harness: opts.harness,
    effort: DAEB_PRODUCTION_EFFORT,
    model: opts.model,
    trial_count: opts.trials.length,
    generated_at: new Date().toISOString(),
    aggregate_record: normalizedPath,
    trial_manifest: trialManifestPath,
    trials: opts.trials,
  };
  writeFileSync(resolve(aggregateDir, "aggregate-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
