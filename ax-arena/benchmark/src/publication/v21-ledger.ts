import { z } from "zod";
import {
  V21_HARNESSES,
  V21_MODELS,
  type V21CellStatus,
  type V21Harness,
  type V21InvocationPlan,
  type V21Model,
  type V21TaskObservation,
} from "../runtime/v21-execution.js";
import { harmonicMean } from "./ax-score.js";

export const V21_FINAL_STATUSES = ["pass", "fail", "structural-na", "invalid-infra", "invalid-route"] as const;
export type V21FinalStatus = (typeof V21_FINAL_STATUSES)[number];

const V21LedgerCellSchema = z.object({
  invocation_id: z.string().min(1),
  vendor: z.string().min(1),
  harness: z.enum(V21_HARNESSES),
  model: z.enum(V21_MODELS),
  trial: z.number().int().positive(),
  family: z.string().min(1),
  namespace: z.string().min(1),
  status: z.enum(V21_FINAL_STATUSES),
  replacement_for: z.string().optional(),
}).strict();
export type V21LedgerCell = z.infer<typeof V21LedgerCellSchema>;

const V21LedgerObservationSchema = z.object({
  schema: z.literal("ax.daeb-v2-1-task-observation/v1"),
  invocation_id: z.string().min(1),
  task_id: z.string().min(1),
  vendor: z.string().min(1),
  harness: z.enum(V21_HARNESSES),
  model: z.enum(V21_MODELS),
  trial: z.number().int().positive(),
  family: z.string().min(1),
  status: z.enum(V21_FINAL_STATUSES),
  discovery_score: z.number().min(0).max(1).optional(),
  strict_pass: z.boolean().optional(),
  recovery_pass: z.boolean().optional(),
  latency_ms: z.number().nonnegative().optional(),
  ttft_ms: z.number().nonnegative().optional(),
  tool_calls: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
}).strict();
const V21ResultLedgerSchema = z.object({
  schema: z.literal("ax.daeb-v2-1-result-ledger/v1"),
  suite_version: z.literal("2.1"),
  planned_invocations: z.number().int().positive(),
  cells: z.array(V21LedgerCellSchema),
  task_observations: z.array(V21LedgerObservationSchema),
}).strict();
export type V21ResultLedger = z.infer<typeof V21ResultLedgerSchema>;

function finalStatus(status: V21CellStatus): V21FinalStatus {
  if (status === "pending") throw new Error("pending status cannot enter the final V2.1 ledger");
  return status;
}

export function buildV21ResultLedger(
  plans: readonly V21InvocationPlan[],
  cells: readonly (V21InvocationPlan & { status: V21CellStatus })[],
  observations: readonly V21TaskObservation[],
): V21ResultLedger {
  const planIds = new Set(plans.map((plan) => plan.invocation_id));
  const planById = new Map(plans.map((plan) => [plan.invocation_id, plan]));
  if (cells.length !== plans.length) throw new Error("V2.1 final ledger needs " + plans.length + " cells, got " + cells.length);
  const seen = new Set<string>();
  const finalCells = cells.map((cell) => {
    if (!planIds.has(cell.invocation_id)) throw new Error("unknown V2.1 invocation " + cell.invocation_id);
    if (seen.has(cell.invocation_id)) throw new Error("duplicate V2.1 invocation " + cell.invocation_id);
    seen.add(cell.invocation_id);
    const plan = planById.get(cell.invocation_id)!;
    if (cell.vendor !== plan.vendor || cell.harness !== plan.harness || cell.model !== plan.model
      || cell.trial !== plan.trial || cell.family !== plan.family || cell.namespace !== plan.namespace) {
      throw new Error("V2.1 final cell identity drifted for " + cell.invocation_id);
    }
    const status = finalStatus(cell.status);
    return V21LedgerCellSchema.parse({
      invocation_id: cell.invocation_id,
      vendor: cell.vendor,
      harness: cell.harness,
      model: cell.model,
      trial: cell.trial,
      family: cell.family,
      namespace: cell.namespace,
      status,
      ...(cell.replacement_for ? { replacement_for: cell.replacement_for } : {}),
    });
  });
  for (const plan of plans) if (!seen.has(plan.invocation_id)) throw new Error("missing final V2.1 invocation " + plan.invocation_id);
  const finalObservations = observations.map((observation) => V21LedgerObservationSchema.parse({
    ...observation,
    status: finalStatus(observation.status),
  }));
  for (const observation of finalObservations) {
    const cell = finalCells.find((candidate) => candidate.invocation_id === observation.invocation_id);
    if (!cell) throw new Error("task observation references unknown cell " + observation.invocation_id);
    if (cell.vendor !== observation.vendor || cell.harness !== observation.harness || cell.model !== observation.model || cell.trial !== observation.trial || cell.family !== observation.family) {
      throw new Error("task observation identity drifted for " + observation.invocation_id + "/" + observation.task_id);
    }
  }
  return V21ResultLedgerSchema.parse({
    schema: "ax.daeb-v2-1-result-ledger/v1",
    suite_version: "2.1",
    planned_invocations: plans.length,
    cells: finalCells,
    task_observations: finalObservations,
  });
}

export interface V21ScoreSlice {
  vendor: string;
  harness: V21Harness;
  model: V21Model;
  observations: number;
  applicable: number;
  passes: number;
  failures: number;
  structural_na: number;
  invalid_infra: number;
  invalid_route: number;
  pass_at_1: number | null;
  pass_at_3: number | null;
  pass_at_1_ci95: [number, number] | null;
  pass_at_3_ci95: [number, number] | null;
  discovery_mean: number | null;
  ax_harmonic_mean: number | null;
  strict_rate: number | null;
  recovery_rate: number | null;
  latency_ms_mean: number | null;
  ttft_ms_mean: number | null;
  tool_calls_mean: number | null;
  cost_usd_total: number | null;
  tokens_total: number | null;
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function wilson95(successes: number, total: number): [number, number] | null {
  if (!total) return null;
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z / denominator) * Math.sqrt((p * (1 - p) / total) + (z * z) / (4 * total * total));
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

function scoreSlice(rows: readonly z.infer<typeof V21LedgerObservationSchema>[], vendor: string, harness: V21Harness, model: V21Model): V21ScoreSlice {
  const selected = rows.filter((row) => row.vendor === vendor && row.harness === harness && row.model === model);
  const valid = selected.filter((row) => row.status === "pass" || row.status === "fail");
  const taskGroups = new Map<string, typeof valid>();
  for (const row of valid) taskGroups.set(row.task_id, [...(taskGroups.get(row.task_id) ?? []), row]);
  const passAt1 = valid.length ? valid.filter((row) => row.status === "pass").length / valid.length : null;
  const passAt3Values = [...taskGroups.values()].filter((group) => group.length >= 3).map((group) => group.some((row) => row.status === "pass") ? 1 : 0);
  return {
    vendor,
    harness,
    model,
    observations: selected.length,
    applicable: valid.length,
    passes: valid.filter((row) => row.status === "pass").length,
    failures: valid.filter((row) => row.status === "fail").length,
    structural_na: selected.filter((row) => row.status === "structural-na").length,
    invalid_infra: selected.filter((row) => row.status === "invalid-infra").length,
    invalid_route: selected.filter((row) => row.status === "invalid-route").length,
    pass_at_1: passAt1,
    pass_at_3: passAt3Values.length ? passAt3Values.reduce<number>((a, b) => a + b, 0) / passAt3Values.length : null,
    pass_at_1_ci95: wilson95(valid.filter((row) => row.status === "pass").length, valid.length),
    pass_at_3_ci95: wilson95(passAt3Values.reduce<number>((sum, value) => sum + value, 0), passAt3Values.length),
    discovery_mean: mean(valid.flatMap((row) => row.discovery_score === undefined ? [] : [row.discovery_score])),
    ax_harmonic_mean: mean(valid.flatMap((row) => row.discovery_score === undefined ? [] : [
      harmonicMean(row.status === "pass" ? 1 : 0, row.discovery_score),
    ])),
    strict_rate: mean(valid.flatMap((row) => row.strict_pass === undefined ? [] : [row.strict_pass ? 1 : 0])),
    recovery_rate: mean(valid.flatMap((row) => row.recovery_pass === undefined ? [] : [row.recovery_pass ? 1 : 0])),
    latency_ms_mean: mean(valid.flatMap((row) => row.latency_ms === undefined ? [] : [row.latency_ms])),
    ttft_ms_mean: mean(valid.flatMap((row) => row.ttft_ms === undefined ? [] : [row.ttft_ms])),
    tool_calls_mean: mean(valid.flatMap((row) => row.tool_calls === undefined ? [] : [row.tool_calls])),
    cost_usd_total: valid.some((row) => row.cost_usd !== undefined)
      ? valid.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0)
      : null,
    tokens_total: valid.some((row) => row.tokens !== undefined)
      ? valid.reduce((sum, row) => sum + (row.tokens ?? 0), 0)
      : null,
  };
}

export function scoreV21Ledger(ledger: V21ResultLedger): V21ScoreSlice[] {
  const parsed = V21ResultLedgerSchema.parse(ledger);
  // Derive the roster from planned cells, not observations: a fully
  // structural-N/A vendor still needs a visible zero-applicability slice.
  const vendors = [...new Set(parsed.cells.map((row) => row.vendor))];
  return vendors.flatMap((vendor) => V21_HARNESSES.flatMap((harness) => V21_MODELS.map((model) =>
    scoreSlice(parsed.task_observations, vendor, harness, model),
  )));
}

export interface V21MacroScore {
  model: V21Model;
  harness?: V21Harness;
  vendor_harness_slices: number;
  pass_at_1: number | null;
  pass_at_3: number | null;
}

/** Equal-weight macro averages over vendor×harness slices. This prevents a
 * vendor with fewer applicable tasks from silently changing the leaderboard
 * denominator; N/A-only slices remain visible but do not become fake zeros. */
export function macroAverageV21Scores(
  slices: readonly V21ScoreSlice[],
  scope: "model" | "model-harness" = "model",
): V21MacroScore[] {
  const groups = new Map<string, V21ScoreSlice[]>();
  for (const slice of slices) {
    const key = scope === "model" ? slice.model : `${slice.model}|${slice.harness}`;
    groups.set(key, [...(groups.get(key) ?? []), slice]);
  }
  return [...groups.entries()].map(([key, rows]) => {
    const [model, harness] = key.split("|") as [V21Model, V21Harness | undefined];
    const usable = rows.filter((row) => row.pass_at_1 !== null);
    const pass3 = rows.filter((row) => row.pass_at_3 !== null);
    return {
      model,
      ...(scope === "model-harness" ? { harness } : {}),
      vendor_harness_slices: rows.length,
      pass_at_1: usable.length ? usable.reduce((sum, row) => sum + row.pass_at_1!, 0) / usable.length : null,
      pass_at_3: pass3.length ? pass3.reduce((sum, row) => sum + row.pass_at_3!, 0) / pass3.length : null,
    };
  }).sort((left, right) => left.model.localeCompare(right.model) || (left.harness ?? "").localeCompare(right.harness ?? ""));
}

export function validateV21ResultLedger(ledger: V21ResultLedger, expectedInvocations = 432): void {
  const parsed = V21ResultLedgerSchema.parse(ledger);
  if (parsed.planned_invocations !== expectedInvocations) throw new Error("V2.1 ledger planned count is " + parsed.planned_invocations + ", expected " + expectedInvocations);
  if (parsed.cells.length !== expectedInvocations) throw new Error("V2.1 ledger cell count is " + parsed.cells.length + ", expected " + expectedInvocations);
  if (parsed.cells.some((cell) => cell.status === "invalid-route")) throw new Error("V2.1 formal ledger cannot contain invalid-route cells");
}
