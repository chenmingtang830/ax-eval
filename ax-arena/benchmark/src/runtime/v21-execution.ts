import { createHash } from "node:crypto";
import { V21_FAMILIES, type V21Family, type V21Task } from "../authoring/discriminative-suite.js";

export const V21_HARNESSES = ["pi", "opencode"] as const;
export const V21_MODELS = [
  "google/gemini-3.7-flash-20260813",
  "deepseek/deepseek-v4-flash-20260731",
  "z-ai/glm-5.2-20260616",
] as const;

export type V21Harness = (typeof V21_HARNESSES)[number];
export type V21Model = (typeof V21_MODELS)[number];
export type V21CellStatus = "pending" | "pass" | "fail" | "structural-na" | "invalid-infra" | "invalid-route";

export interface V21InvocationPlan {
  schema: "ax.daeb-v2-1-invocation-plan/v1";
  invocation_id: string;
  vendor: string;
  harness: V21Harness;
  model: V21Model;
  trial: number;
  family: V21Family;
  task_ids: string[];
  namespace: string;
  discovery_reset: "family";
  status: V21CellStatus;
  replacement_for?: string;
}

export interface V21TaskObservation {
  schema: "ax.daeb-v2-1-task-observation/v1";
  invocation_id: string;
  task_id: string;
  vendor: string;
  harness: V21Harness;
  model: V21Model;
  trial: number;
  family: V21Family;
  status: Exclude<V21CellStatus, "pending">;
  discovery_score?: number;
  strict_pass?: boolean;
  recovery_pass?: boolean;
  latency_ms?: number;
  ttft_ms?: number;
  tool_calls?: number;
  cost_usd?: number;
  tokens?: number;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function v21InvocationId(vendor: string, harness: V21Harness, model: V21Model, trial: number, family: V21Family): string {
  return `v21-${vendor}-${harness}-${shortHash(`${model}:${trial}:${family}`)}`;
}

export function planV21Invocations(
  vendors: readonly string[],
  tasks: readonly V21Task[],
  trials = 3,
): V21InvocationPlan[] {
  if (trials !== 3) throw new Error("V2.1 production planning requires exactly three trials");
  if (vendors.length !== 6 || new Set(vendors).size !== 6) {
    throw new Error("V2.1 production planning requires six unique vendors");
  }
  const output: V21InvocationPlan[] = [];
  for (const vendor of vendors) {
    for (const harness of V21_HARNESSES) {
      for (const model of V21_MODELS) {
        for (let trial = 1; trial <= trials; trial += 1) {
          for (const family of ["access-auth-discovery", "schema-integrity", "query-search", "lifecycle-recovery"] as const) {
            const familyTasks = tasks.filter((task) => task.execution_family === family);
            // V2.1 admission is based on concrete CLI task-fit evidence, not
            // the broader cited-coverage roster. Lower-coverage research
            // concepts remain visible in the plan as structural N/A.
            const admitted = familyTasks.filter((task) => {
              const taskFitVendors = task.task_fit_vendors ?? task.supported_vendors;
              return taskFitVendors.length >= 5
                && taskFitVendors.some((candidateVendor) => candidateVendor.toLowerCase() === vendor.toLowerCase());
            });
            const invocation_id = v21InvocationId(vendor, harness, model, trial, family);
            output.push({
              schema: "ax.daeb-v2-1-invocation-plan/v1",
              invocation_id,
              vendor,
              harness,
              model,
              trial,
              family,
              task_ids: admitted.map((task) => task.id),
              namespace: `${invocation_id}-ns`,
              discovery_reset: "family",
              status: admitted.length ? "pending" : "structural-na",
            });
          }
        }
      }
    }
  }
  return output;
}

export function taskObservationsForInvocation(
  plan: V21InvocationPlan,
  taskStatuses: Readonly<Record<string, Exclude<V21CellStatus, "pending">>>,
): V21TaskObservation[] {
  if (plan.status === "structural-na") return plan.task_ids.map((task_id) => ({
    schema: "ax.daeb-v2-1-task-observation/v1",
    invocation_id: plan.invocation_id,
    task_id,
    vendor: plan.vendor,
    harness: plan.harness,
    model: plan.model,
    trial: plan.trial,
    family: plan.family,
    status: "structural-na",
  }));
  return plan.task_ids.map((task_id) => {
    const status = taskStatuses[task_id];
    if (!status) throw new Error(`missing task status for ${plan.invocation_id}/${task_id}`);
    return {
      schema: "ax.daeb-v2-1-task-observation/v1",
      invocation_id: plan.invocation_id,
      task_id,
      vendor: plan.vendor,
      harness: plan.harness,
      model: plan.model,
      trial: plan.trial,
      family: plan.family,
      status,
    };
  });
}

export function validateV21InvocationPlan(plans: readonly V21InvocationPlan[], expected = 432): void {
  if (plans.length !== expected) throw new Error(`V2.1 invocation plan has ${plans.length} cells, expected ${expected}`);
  const ids = new Set<string>();
  const coordinates = new Set<string>();
  for (const plan of plans) {
    if (ids.has(plan.invocation_id)) throw new Error(`duplicate V2.1 invocation ${plan.invocation_id}`);
    ids.add(plan.invocation_id);
    if (plan.discovery_reset !== "family") throw new Error(`V2.1 invocation ${plan.invocation_id} is not family-isolated`);
    if (!V21_HARNESSES.includes(plan.harness) || !V21_MODELS.includes(plan.model)) {
      throw new Error(`V2.1 invocation ${plan.invocation_id} has an unregistered harness/model`);
    }
    if (!V21_FAMILIES.includes(plan.family)) throw new Error(`V2.1 invocation ${plan.invocation_id} has an unregistered family`);
    if (plan.trial < 1 || plan.trial > 3) throw new Error(`V2.1 invocation ${plan.invocation_id} has an invalid trial`);
    if (!plan.task_ids.length && plan.status !== "structural-na") {
      throw new Error(`V2.1 invocation ${plan.invocation_id} has no admitted tasks but is not structural-na`);
    }
    if (new Set(plan.task_ids).size !== plan.task_ids.length) throw new Error(`V2.1 invocation ${plan.invocation_id} repeats a task`);
    const coordinate = `${plan.vendor}|${plan.harness}|${plan.model}|${plan.trial}|${plan.family}`;
    if (coordinates.has(coordinate)) throw new Error(`duplicate V2.1 invocation coordinate ${coordinate}`);
    coordinates.add(coordinate);
  }
}
