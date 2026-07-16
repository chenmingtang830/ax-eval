import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SurfaceId } from "../surface/types.js";
import { assertArtifactSegment } from "./artifact-path.js";
import {
  aggregateNormalizedResults,
  NORMALIZED_RESULT_SCHEMA,
  type NormalizedResult,
} from "./record.js";

export interface ProductionTrialInput {
  trial: number;
  normalized_record: string;
}

export interface ProductionAggregateManifest {
  schema: "ax.production-aggregate/v1";
  suite: string;
  vendor: string;
  surface: SurfaceId;
  harness: string;
  generated_at: string;
  required_trial_count: number;
  trial_count: number;
  trials: Array<{ trial: number; normalized_record: string }>;
  aggregate_record: string;
}

export function defaultProductionRunRoot(root: string, suiteName: string, runDir?: string): string {
  return runDir
    ? resolve(root, runDir)
    : resolve(root, "results", "runs", assertArtifactSegment(suiteName, "suite name"), "production");
}

export function productionCellRoot(
  runRoot: string,
  vendor: string,
  surface: SurfaceId,
  harness: string,
): string {
  return resolve(
    runRoot,
    assertArtifactSegment(vendor, "vendor slug"),
    assertArtifactSegment(surface, "surface"),
    assertArtifactSegment(harness, "harness"),
  );
}

export function productionTrialDir(
  runRoot: string,
  vendor: string,
  surface: SurfaceId,
  harness: string,
  trial: number,
): string {
  if (!Number.isInteger(trial) || trial < 1) throw new Error("trial must be a positive integer");
  return resolve(productionCellRoot(runRoot, vendor, surface, harness), `trial-${trial}`);
}

export function productionAggregateDir(
  runRoot: string,
  vendor: string,
  surface: SurfaceId,
  harness: string,
): string {
  return resolve(productionCellRoot(runRoot, vendor, surface, harness), "aggregate");
}

export function loadNormalizedResult(path: string): NormalizedResult {
  if (!existsSync(path)) throw new Error(`normalized record not found at ${path}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`normalized record at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { schema?: unknown }).schema !== NORMALIZED_RESULT_SCHEMA) {
    throw new Error(`normalized record at ${path} does not use ${NORMALIZED_RESULT_SCHEMA}`);
  }
  return parsed as NormalizedResult;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function pathWithin(parent: string, child: string): boolean {
  const relativePath = relative(parent, child);
  return Boolean(relativePath)
    && relativePath !== ".."
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

function sourcePathForTrial(
  runRoot: string,
  vendor: string,
  surface: SurfaceId,
  harness: string,
  trial: ProductionTrialInput,
): { absolute: string; relative: string } {
  const requestedPath = resolve(runRoot, trial.normalized_record);
  if (!existsSync(requestedPath)) throw new Error(`normalized record not found at ${requestedPath}`);
  const absolute = realpathSync(requestedPath);
  const requestedTrialDir = productionTrialDir(runRoot, vendor, surface, harness, trial.trial);
  if (!existsSync(requestedTrialDir)) {
    throw new Error(`trial ${trial.trial} normalized record must be inside its production trial directory`);
  }
  const expectedTrialDir = realpathSync(requestedTrialDir);
  if (!pathWithin(runRoot, absolute) || !pathWithin(expectedTrialDir, absolute)) {
    throw new Error(`trial ${trial.trial} normalized record must be inside its production trial directory`);
  }
  return { absolute, relative: relative(runRoot, absolute) };
}

export function writeProductionAggregate(options: {
  runRoot: string;
  suiteName: string;
  vendor: string;
  surface: SurfaceId;
  harness: string;
  trials: readonly ProductionTrialInput[];
  requiredTrialCount?: number;
  now?: () => Date;
}): ProductionAggregateManifest {
  const runRoot = realpathSync(options.runRoot);
  const suiteName = assertArtifactSegment(options.suiteName, "suite name");
  const vendor = assertArtifactSegment(options.vendor, "vendor slug");
  const harness = assertArtifactSegment(options.harness, "harness");
  const requiredTrialCount = options.requiredTrialCount ?? 3;
  if (!Number.isInteger(requiredTrialCount) || requiredTrialCount < 1) {
    throw new Error("required trial count must be a positive integer");
  }
  if (options.trials.length !== requiredTrialCount) {
    throw new Error(`production aggregate requires exactly ${requiredTrialCount} trial records`);
  }
  const trialNumbers = options.trials.map((trial) => trial.trial);
  if (new Set(trialNumbers).size !== trialNumbers.length || trialNumbers.some((trial) => !Number.isInteger(trial) || trial < 1)) {
    throw new Error("production trials must have unique positive integer trial numbers");
  }
  const sortedTrials = [...options.trials].sort((left, right) => left.trial - right.trial);
  const expectedTrials = Array.from({ length: requiredTrialCount }, (_, index) => index + 1);
  if (sortedTrials.some((trial, index) => trial.trial !== expectedTrials[index])) {
    throw new Error(`production trials must be numbered 1 through ${requiredTrialCount}`);
  }
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  const aggregateDir = productionAggregateDir(
    runRoot,
    vendor,
    options.surface,
    harness,
  );
  const aggregatePath = resolve(aggregateDir, `${harness}.${options.surface}.aggregate.normalized.json`);
  const manifestPath = resolve(aggregateDir, "aggregate-manifest.json");
  const sources = sortedTrials.map((trial) => sourcePathForTrial(
    runRoot,
    vendor,
    options.surface,
    harness,
    trial,
  ));
  const sourceRecords = sources.map((source) => source.relative);
  const records = sources.map((source) => loadNormalizedResult(source.absolute));
  const aggregate = aggregateNormalizedResults(
    records,
    sourceRecords,
    { now: () => new Date(generatedAt) },
  );
  if (aggregate.product !== vendor) throw new Error(`production vendor ${vendor} does not match record product ${aggregate.product}`);
  if (aggregate.surface !== options.surface) throw new Error(`production surface ${options.surface} does not match record surface ${aggregate.surface}`);
  if (aggregate.harness !== harness) throw new Error(`production harness ${harness} does not match record harness ${aggregate.harness}`);
  if (aggregate.standard_set_version !== suiteName) {
    throw new Error(`production suite ${suiteName} does not match record standard_set_version ${aggregate.standard_set_version}`);
  }
  mkdirSync(aggregateDir, { recursive: true });
  if (!pathWithin(runRoot, realpathSync(aggregateDir))) {
    throw new Error("production aggregate directory must be inside the production run root");
  }
  const manifest: ProductionAggregateManifest = {
    schema: "ax.production-aggregate/v1",
    suite: suiteName,
    vendor,
    surface: options.surface,
    harness,
    generated_at: generatedAt,
    required_trial_count: requiredTrialCount,
    trial_count: sortedTrials.length,
    trials: sortedTrials.map((trial, index) => ({ trial: trial.trial, normalized_record: sourceRecords[index]! })),
    aggregate_record: relative(runRoot, aggregatePath),
  };
  writeJsonAtomic(aggregatePath, aggregate);
  writeJsonAtomic(manifestPath, manifest);
  return manifest;
}
