import { createHash } from "node:crypto";
import { V21_FAMILIES, type V21Task } from "../authoring/discriminative-suite.js";
import type { V21Model } from "./v21-execution.js";

export const V21_CALIBRATION_MODELS = [
  "google/gemini-3.7-flash-20260813",
  "deepseek/deepseek-v4-flash-20260731",
] as const satisfies readonly V21Model[];
export const V21_HOLDOUT_MODEL = "z-ai/glm-5.2-20260616" as const satisfies V21Model;
export type V21CalibrationModel = (typeof V21_CALIBRATION_MODELS)[number];

export type V21CalibrationCellStatus = "pending" | "structural-na";

export interface V21CalibrationInvocationPlan {
  schema: "ax.daeb-v2-1-calibration-invocation/v1";
  invocation_id: string;
  vendor: string;
  harness: "pi";
  model: V21Model;
  trial: 1;
  task_id: string;
  family: (typeof V21_FAMILIES)[number];
  namespace: string;
  discovery_reset: "family";
  status: V21CalibrationCellStatus;
}

export interface V21CalibrationPlan {
  schema: "ax.daeb-v2-1-calibration-plan/v1";
  vendors: string[];
  models: readonly V21Model[];
  calibration_models: readonly V21CalibrationModel[];
  holdout_model: V21Model;
  harness: "pi";
  trial: 1;
  candidate_count: 16;
  planned_invocations: 288;
  invocations: V21CalibrationInvocationPlan[];
  immutable: true;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function fitVendors(task: V21Task): readonly string[] {
  return task.task_fit_vendors ?? task.supported_vendors;
}

function vendorMatches(task: V21Task, vendor: string): boolean {
  const fit = fitVendors(task);
  return fit.length >= 5 && fit.some((candidate) => candidate.toLowerCase() === vendor.toLowerCase());
}

export function v21CalibrationInvocationId(vendor: string, model: V21Model, taskId: string): string {
  return `v21-cal-${vendor}-pi-${shortHash(`${model}:1:${taskId}`)}`;
}

/** Plan every candidate × vendor × registered model observation. Unsupported
 * tuples remain visible as structural N/A; they are never dropped from the
 * calibration denominator or silently replaced with a better-covered task. */
export function planV21CalibrationInvocations(
  vendors: readonly string[],
  tasks: readonly V21Task[],
): V21CalibrationPlan {
  if (vendors.length !== 6 || new Set(vendors).size !== 6) throw new Error("V2.1 calibration requires six unique vendors");
  if (tasks.length !== 16 || new Set(tasks.map((task) => task.id)).size !== tasks.length) {
    throw new Error("V2.1 calibration requires exactly 16 unique candidates");
  }
  const models: readonly V21Model[] = [...V21_CALIBRATION_MODELS, V21_HOLDOUT_MODEL];
  const invocations: V21CalibrationInvocationPlan[] = [];
  for (const vendor of vendors) {
    for (const model of models) {
      for (const task of tasks) {
        const invocation_id = v21CalibrationInvocationId(vendor, model, task.id);
        invocations.push({
          schema: "ax.daeb-v2-1-calibration-invocation/v1",
          invocation_id,
          vendor,
          harness: "pi",
          model,
          trial: 1,
          task_id: task.id,
          family: task.execution_family,
          namespace: `${invocation_id}-ns`,
          discovery_reset: "family",
          status: vendorMatches(task, vendor) ? "pending" : "structural-na",
        });
      }
    }
  }
  if (invocations.length !== 288) throw new Error(`V2.1 calibration planner produced ${invocations.length} cells, expected 288`);
  return {
    schema: "ax.daeb-v2-1-calibration-plan/v1",
    vendors: [...vendors],
    models,
    calibration_models: V21_CALIBRATION_MODELS,
    holdout_model: V21_HOLDOUT_MODEL,
    harness: "pi",
    trial: 1,
    candidate_count: 16,
    planned_invocations: 288,
    invocations,
    immutable: true,
  };
}

export function v21CalibrationExecPlanArgs(input: {
  packPath: string;
  runDir: string;
  plan: V21CalibrationInvocationPlan;
  gatewayUrl: string;
  provider: string;
  dataCollection: "allow" | "deny";
}): string[] {
  if (input.plan.status === "structural-na") throw new Error("structural N/A calibration cells must not start a harness");
  return [
    "run", "ax-eval", "--", "exec-plan",
    "--pack", input.packPath,
    "--tasks", input.plan.task_id,
    "--harness", "pi",
    "--profile", "medium",
    // Pi must receive an OpenRouter provider/model route so the controller
    // does not accidentally demand a direct Google/DeepSeek/Z.AI credential.
    // The gateway still attests the bare canonical model separately.
    "--model", `openrouter/${input.plan.model}`,
    "--effort", "high",
    "--surface", "cli",
    "--isolated-harness-auth",
    "--invoke",
    "--execution-mode", "task",
    "--attempts", "1",
    "--concurrency", "1",
    "--invoke-timeout", "900",
    "--first-action-timeout", "180",
    "--invoke-retries", "0",
    "--trial", "1",
    "--run-batch-id", input.plan.invocation_id,
    "--run-dir", input.runDir,
    "--openrouter-gateway-url", input.gatewayUrl,
    "--openrouter-provider", input.provider,
    "--openrouter-canonical-model", input.plan.model,
    "--openrouter-data-collection", input.dataCollection,
  ];
}
