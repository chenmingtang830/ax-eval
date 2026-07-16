import { assertPortablePublicationPath, type PublicationManifest } from "./publication-manifest.js";
import { classifyTrialStabilityAt3, NORMALIZED_RESULT_SCHEMA, type NormalizedResult } from "./record.js";

export const PUBLICATION_CELLS_SCHEMA = "ax.publication-cells/v1" as const;

export interface PublicationCellRecordInput {
  path: string;
  record: NormalizedResult;
}

export interface PublicationCellRecord {
  id: string;
  vendor: string;
  surface: NormalizedResult["surface"];
  harness: string;
  model: string | null;
  profiles: string[];
  tasks_total: number;
  tasks_passed: number;
  mean_success_rate: number;
  range_success_rate: { min: number; max: number };
  pass_at_k: number;
  trial_count: number;
  trial_values: number[];
  pass_hat_3: number | null;
  pass_all_3: number | null;
  trial_stability_at_3: "all_pass" | "all_fail" | "inconsistent" | null;
  discovery_score: number | null;
  content_quality: number | null;
  latency_ms: number | null;
  first_action_latency_ms: number | null;
  validity_status: string | null;
  aggregate_record: string;
  source_records: string[];
}

export interface PublicationCellsExport {
  schema: typeof PUBLICATION_CELLS_SCHEMA;
  benchmark: string;
  category: string;
  suite_version: number;
  standard_set_version: string;
  generated_at: string;
  cells: PublicationCellRecord[];
}

function cellId(value: { vendor: string; surface: string; harness: string }): string {
  return `${value.vendor}/${value.surface}/${value.harness}`;
}

function assertRate(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite rate between 0 and 1`);
  }
  return value;
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right)) * 8;
}

function nullableRate(value: number | null, label: string): number | null {
  return value === null ? null : assertRate(value, label);
}

function nullableDuration(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
  return value;
}

export function buildPublicationCellsExport(options: {
  manifest: PublicationManifest;
  records: readonly PublicationCellRecordInput[];
  now?: () => Date;
}): PublicationCellsExport {
  if (options.records.length !== options.manifest.cells.length) {
    throw new Error("publication cell record count must match the manifest cell count");
  }
  const manifestCells = new Map(options.manifest.cells.map((cell) => [cell.aggregate_record, cell]));
  if (manifestCells.size !== options.manifest.cells.length) {
    throw new Error("publication manifest contains duplicate aggregate record paths");
  }
  const seenPaths = new Set<string>();
  const cells = options.records.map(({ path, record }) => {
    const aggregateRecord = assertPortablePublicationPath(path, "publication aggregate record path");
    if (seenPaths.has(aggregateRecord)) throw new Error(`publication aggregate record appears more than once: ${aggregateRecord}`);
    seenPaths.add(aggregateRecord);
    const expected = manifestCells.get(aggregateRecord);
    if (!expected) throw new Error(`publication aggregate record is not declared by the manifest: ${aggregateRecord}`);
    if (record.schema !== NORMALIZED_RESULT_SCHEMA) throw new Error(`publication aggregate record must use ${NORMALIZED_RESULT_SCHEMA}`);
    if (record.summary_kind !== "aggregate") throw new Error(`publication cell ${cellId(expected)} must use an aggregate record`);
    if (record.blocked) throw new Error(`publication cell ${cellId(expected)} cannot publish a blocked record`);
    if (record.product !== expected.vendor) throw new Error(`publication cell ${cellId(expected)} product does not match the manifest`);
    if (record.surface !== expected.surface) throw new Error(`publication cell ${cellId(expected)} surface does not match the manifest`);
    if (record.harness !== expected.harness) throw new Error(`publication cell ${cellId(expected)} harness does not match the manifest`);
    if (record.standard_set_version !== options.manifest.standard_set_version) {
      throw new Error(`publication cell ${cellId(expected)} standard set does not match the manifest`);
    }
    if (record.trial_count !== expected.trial_count) throw new Error(`publication cell ${cellId(expected)} trial count does not match the manifest`);
    if (!sameValues(record.profiles, expected.profiles)) throw new Error(`publication cell ${cellId(expected)} profiles do not match the manifest`);
    if (!Number.isInteger(record.tasks_total) || record.tasks_total < 1) throw new Error(`publication cell ${cellId(expected)} has invalid tasks_total`);
    if (!Number.isInteger(record.tasks_passed) || record.tasks_passed < 0 || record.tasks_passed > record.tasks_total) {
      throw new Error(`publication cell ${cellId(expected)} has invalid tasks_passed`);
    }
    const meanSuccessRate = assertRate(record.mean_pass_rate, `publication cell ${cellId(expected)} mean_pass_rate`);
    const passAtK = assertRate(record.pass_at_k, `publication cell ${cellId(expected)} pass_at_k`);
    if (!approximatelyEqual(record.pass_at_1, meanSuccessRate)) {
      throw new Error(`publication cell ${cellId(expected)} pass_at_1 does not match mean_pass_rate`);
    }
    if (passAtK < meanSuccessRate) throw new Error(`publication cell ${cellId(expected)} pass_at_k is below mean_pass_rate`);
    if (!record.range_pass_rate) throw new Error(`publication cell ${cellId(expected)} is missing range_pass_rate`);
    const range = {
      min: assertRate(record.range_pass_rate.min, `publication cell ${cellId(expected)} range minimum`),
      max: assertRate(record.range_pass_rate.max, `publication cell ${cellId(expected)} range maximum`),
    };
    if (range.min > meanSuccessRate || range.max < meanSuccessRate || range.min > range.max) {
      throw new Error(`publication cell ${cellId(expected)} has an invalid success-rate range`);
    }
    if (!record.trial_values || record.trial_values.length !== record.trial_count) {
      throw new Error(`publication cell ${cellId(expected)} trial values do not match trial_count`);
    }
    const trialValues = record.trial_values.map((value) => assertRate(value, `publication cell ${cellId(expected)} trial value`));
    const observedMean = trialValues.reduce((sum, value) => sum + value, 0) / trialValues.length;
    if (!approximatelyEqual(observedMean, meanSuccessRate)
      || range.min !== Math.min(...trialValues)
      || range.max !== Math.max(...trialValues)) {
      throw new Error(`publication cell ${cellId(expected)} aggregate metrics do not match trial values`);
    }
    const sourceRecords = (record.source_records ?? []).map((source) =>
      assertPortablePublicationPath(source, `publication cell ${cellId(expected)} source record`));
    if (sourceRecords.length !== record.trial_count) {
      throw new Error(`publication cell ${cellId(expected)} source records do not match trial_count`);
    }
    const passHat3 = nullableRate(record.pass_hat_3 ?? null, `publication cell ${cellId(expected)} pass_hat_3`);
    const passAll3 = nullableRate(record.pass_all_3 ?? null, `publication cell ${cellId(expected)} pass_all_3`);
    const stability = record.trial_stability_at_3 ?? null;
    if (record.trial_count === 3) {
      const expectedPassAll3 = trialValues.every((value) => value === 1) ? 1 : 0;
      if (passHat3 === null || !approximatelyEqual(passHat3, meanSuccessRate ** 3)
        || passAll3 !== expectedPassAll3
        || stability !== classifyTrialStabilityAt3(trialValues)) {
        throw new Error(`publication cell ${cellId(expected)} three-trial metrics do not match trial values`);
      }
    } else if (passHat3 !== null || passAll3 !== null || stability !== null) {
      throw new Error(`publication cell ${cellId(expected)} has three-trial metrics without exactly three trials`);
    }
    const discoveryScore = nullableRate(record.discovery_score, `publication cell ${cellId(expected)} discovery_score`);
    const contentQuality = nullableRate(record.content_quality, `publication cell ${cellId(expected)} content_quality`);
    return {
      id: cellId(expected),
      vendor: expected.vendor,
      surface: expected.surface,
      harness: expected.harness,
      model: record.model,
      profiles: [...expected.profiles],
      tasks_total: record.tasks_total,
      tasks_passed: record.tasks_passed,
      mean_success_rate: meanSuccessRate,
      range_success_rate: range,
      pass_at_k: passAtK,
      trial_count: record.trial_count,
      trial_values: trialValues,
      pass_hat_3: passHat3,
      pass_all_3: passAll3,
      trial_stability_at_3: stability,
      discovery_score: discoveryScore,
      content_quality: contentQuality,
      latency_ms: nullableDuration(record.latency_ms, `publication cell ${cellId(expected)} latency_ms`),
      first_action_latency_ms: nullableDuration(record.first_action_latency_ms, `publication cell ${cellId(expected)} first_action_latency_ms`),
      validity_status: record.validity_status ?? null,
      aggregate_record: aggregateRecord,
      source_records: sourceRecords,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));

  const missing = [...manifestCells.keys()].filter((path) => !seenPaths.has(path));
  if (missing.length) throw new Error(`publication cells are missing aggregate records: ${missing.join(", ")}`);
  return {
    schema: PUBLICATION_CELLS_SCHEMA,
    benchmark: options.manifest.benchmark,
    category: options.manifest.category,
    suite_version: options.manifest.suite_version,
    standard_set_version: options.manifest.standard_set_version,
    generated_at: (options.now ?? (() => new Date()))().toISOString(),
    cells,
  };
}
