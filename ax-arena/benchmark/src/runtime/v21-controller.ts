import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  V21_HARNESSES,
  V21_MODELS,
  planV21Invocations,
  validateV21InvocationPlan,
  type V21CellStatus,
  type V21Harness,
  type V21InvocationPlan,
  type V21Model,
} from "./v21-execution.js";
import type { V21Task } from "../authoring/discriminative-suite.js";

/** The controller is deliberately independent of a target pack loader. The
 * trusted caller loads and validates packs, then passes only the frozen task
 * metadata here. That keeps planning/resume deterministic and keyless. */
export interface V21ControllerInput {
  suitePath: string;
  suiteHash: string;
  vendors: readonly string[];
  tasks: readonly V21Task[];
  runRoot: string;
  trials?: number;
}

export interface V21ControllerPlan {
  schema: "ax.daeb-v2-1-controller-plan/v1";
  suite_path: string;
  suite_hash: string;
  run_root: string;
  vendors: string[];
  harnesses: readonly V21Harness[];
  models: readonly V21Model[];
  trials: 3;
  planned_invocations: 432;
  invocations: V21InvocationPlan[];
  immutable: true;
}

export function buildV21ControllerPlan(input: V21ControllerInput): V21ControllerPlan {
  const trials = input.trials ?? 3;
  const invocations = planV21Invocations(input.vendors, input.tasks, trials);
  validateV21InvocationPlan(invocations, 432);
  if (!/^[a-f0-9]{64}$/.test(input.suiteHash)) throw new Error("V2.1 controller requires a SHA-256 suite hash");
  return {
    schema: "ax.daeb-v2-1-controller-plan/v1",
    suite_path: resolve(input.suitePath),
    suite_hash: input.suiteHash,
    run_root: resolve(input.runRoot),
    vendors: [...input.vendors],
    harnesses: V21_HARNESSES,
    models: V21_MODELS,
    trials: 3,
    planned_invocations: 432,
    invocations,
    immutable: true,
  };
}

export function writeV21ControllerPlan(plan: V21ControllerPlan): string {
  mkdirSync(plan.run_root, { recursive: true, mode: 0o700 });
  const path = resolve(plan.run_root, "controller-plan.json");
  writeFileSync(path, JSON.stringify(plan, null, 2) + "\n", { mode: 0o600 });
  return path;
}

/** Build the exact child command for one family cell. The controller pins all
 * route fields explicitly; no caller can accidentally re-enable fallback,
 * batch mode, retries, or a different effort level through this helper. */
export function v21ExecPlanArgs(input: {
  packPath: string;
  runDir: string;
  plan: V21InvocationPlan;
  gatewayUrl: string;
  provider: string;
  dataCollection: "allow" | "deny";
  harness: V21Harness;
  model: V21Model;
}): string[] {
  if (input.plan.harness !== input.harness || input.plan.model !== input.model) {
    throw new Error(`V2.1 child command identity mismatch for ${input.plan.invocation_id}`);
  }
  return [
    "run", "ax-eval", "--", "exec-plan",
    "--pack", input.packPath,
    "--harness", input.harness,
    "--profile", "medium",
    // The controller identity remains the bare canonical slug, while the
    // harness route must carry the OpenRouter provider prefix so the child
    // environment receives OPENROUTER_API_KEY rather than a direct-provider
    // credential. invoke.ts normalizes this back to the canonical route.
    "--model", `openrouter/${input.model}`,
    "--effort", "high",
    "--surface", "cli",
    "--tasks", input.plan.task_ids.join(","),
    "--isolated-harness-auth",
    "--invoke",
    "--execution-mode", "task",
    "--attempts", "1",
    "--concurrency", "1",
    "--invoke-timeout", "900",
    "--first-action-timeout", "180",
    "--invoke-retries", "0",
    "--trial", String(input.plan.trial),
    "--run-batch-id", input.plan.invocation_id,
    "--run-dir", input.runDir,
    "--openrouter-gateway-url", input.gatewayUrl,
    "--openrouter-provider", input.provider,
    "--openrouter-canonical-model", input.model,
    "--openrouter-data-collection", input.dataCollection,
  ];
}

const V21CheckpointSchema = z.object({
  schema: z.literal("ax.daeb-v2-1-controller-checkpoint/v1"),
  invocation_id: z.string().min(1),
  vendor: z.string().min(1),
  harness: z.enum(V21_HARNESSES),
  model: z.enum(V21_MODELS),
  trial: z.number().int().positive(),
  family: z.string().min(1),
  namespace: z.string().min(1),
  status: z.enum(["pending", "pass", "fail", "structural-na", "invalid-infra", "invalid-route"]),
  attempts: z.number().int().nonnegative().default(0),
  artifact_dir: z.string().min(1),
  replacement_for: z.string().optional(),
  updated_at: z.string().datetime(),
}).strict();
export type V21Checkpoint = z.infer<typeof V21CheckpointSchema>;

export function checkpointPath(runRoot: string, invocationId: string): string {
  return resolve(runRoot, "cells", invocationId, "checkpoint.json");
}

export function writeV21Checkpoint(runRoot: string, checkpoint: V21Checkpoint): string {
  const parsed = V21CheckpointSchema.parse(checkpoint);
  const path = checkpointPath(runRoot, parsed.invocation_id);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n", { mode: 0o600 });
  return path;
}

export function readV21Checkpoint(runRoot: string, invocationId: string): V21Checkpoint | null {
  const path = checkpointPath(runRoot, invocationId);
  if (!existsSync(path)) return null;
  return V21CheckpointSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

/** A resume is safe only for a terminal artifact that still belongs to the
 * exact plan coordinate. Invalid/partial cells are retained but re-runnable;
 * they never disappear from the final ledger. */
export function isResumableV21Checkpoint(
  plan: V21InvocationPlan,
  checkpoint: V21Checkpoint | null,
): checkpoint is V21Checkpoint {
  return Boolean(
    checkpoint
    && checkpoint.invocation_id === plan.invocation_id
    && checkpoint.vendor === plan.vendor
    && checkpoint.harness === plan.harness
    && checkpoint.model === plan.model
    && checkpoint.trial === plan.trial
    && checkpoint.family === plan.family
    && checkpoint.namespace === plan.namespace
    && checkpoint.status !== "pending"
    && existsSync(checkpoint.artifact_dir),
  );
}

export function controllerPlanHash(plan: V21ControllerPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export function classifyV21CellStatus(input: {
  plan: V21InvocationPlan;
  routeMismatch?: boolean;
  infraInvalid?: boolean;
  taskStatuses?: readonly V21CellStatus[];
}): Exclude<V21CellStatus, "pending"> {
  if (input.plan.status === "structural-na") return "structural-na";
  if (input.routeMismatch) return "invalid-route";
  if (input.infraInvalid) return "invalid-infra";
  const statuses = input.taskStatuses ?? [];
  if (!statuses.length || statuses.some((status) => status === "pending")) return "invalid-infra";
  if (statuses.some((status) => status === "invalid-route")) return "invalid-route";
  if (statuses.some((status) => status === "invalid-infra")) return "invalid-infra";
  return statuses.every((status) => status === "pass") ? "pass" : "fail";
}
