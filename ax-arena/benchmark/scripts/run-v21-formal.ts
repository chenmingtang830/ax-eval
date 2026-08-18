#!/usr/bin/env node
/**
 * Resumable local V2.1 controller.
 *
 * This is intentionally fail-closed: a real run requires a production
 * eligible freeze manifest, exact human approvals for every vendor pack, the
 * pinned Pi/OpenCode binaries, and a controller-owned OpenRouter key. `--dry-run`
 * only writes the 432-cell plan and never starts a harness or gateway.
 */
import "dotenv/config";

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  BearerClient,
  buildVerificationClientOptions,
  checkCellApproval,
  defaultInvokePaths,
  detectInvokeHarness,
  loadPack,
  loadRequiredTrace,
  loadResults,
  packFileContentHash,
  verifyGeneratedPack,
  validateResolvedProvider,
  type InvokeHarnessMetrics,
  type InvokeHarnessId,
} from "ax-eval";
import { createDatabaseRuntimeExtensionRegistry } from "../src/index.js";
import {
  buildV21ControllerPlan,
  isResumableV21Checkpoint,
  readV21Checkpoint,
  v21ExecPlanArgs,
  writeV21Checkpoint,
  type V21Checkpoint,
} from "../src/runtime/v21-controller.js";
import {
  V21_HARNESSES,
  V21_MODELS,
  type V21CellStatus,
  type V21Harness,
  type V21InvocationPlan,
  type V21TaskObservation,
} from "../src/runtime/v21-execution.js";
import { startV21OpenRouterGateway, validateV21HarnessVersion } from "../src/runtime/v21-routes.js";
import { buildV21ResultLedger, scoreV21Ledger, validateV21ResultLedger, type V21FinalStatus } from "../src/publication/v21-ledger.js";
import { V21TaskSchema } from "../src/authoring/discriminative-suite.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BENCHMARK_ROOT = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-1");
const VENDORS = ["cockroachdb", "insforge", "neon", "nile", "turso", "supabase"] as const;
const PACKS = Object.fromEntries(VENDORS.map((vendor) => [vendor, resolve(BENCHMARK_ROOT, "packs", vendor, "pack.yaml")])) as Record<string, string>;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function envPath(name: string, fallback: string): string {
  return resolve(ROOT, process.env[name]?.trim() || fallback);
}

function readRouteEntries(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

function runChild(args: readonly string[]): Promise<number> {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return new Promise((resolvePromise, reject) => {
    const child = spawn(npm, [...args], { cwd: ROOT, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  });
}

function taskPack(pack: ReturnType<typeof loadPack>, taskIds: readonly string[]) {
  return { ...pack, tasks: pack.tasks.filter((task) => taskIds.includes(task.id)) };
}

function metricsForTask(runDir: string, harness: V21Harness, taskId: string): {
  latency_ms?: number;
  ttft_ms?: number;
  cost_usd?: number;
  tokens?: number;
  tool_calls?: number;
} {
  const path = resolve(runDir, `run-${harness}-medium-cli-${taskId}.invoke.json`);
  if (!existsSync(path)) return {};
  try {
    const meta = JSON.parse(readFileSync(path, "utf8")) as {
      durationMs?: unknown;
      first_action_latency_ms?: unknown;
      metrics?: InvokeHarnessMetrics;
      transcript_event_count?: unknown;
    };
    const usage = meta.metrics?.token_usage;
    const totalTokens = usage && typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : usage
        ? Object.values(usage).filter((value): value is number => typeof value === "number").reduce((sum, value) => sum + value, 0)
        : undefined;
    return {
      ...(typeof meta.durationMs === "number" ? { latency_ms: meta.durationMs } : {}),
      ...(typeof meta.first_action_latency_ms === "number" ? { ttft_ms: meta.first_action_latency_ms } : {}),
      ...(typeof meta.metrics?.cost_usd === "number" ? { cost_usd: meta.metrics.cost_usd } : {}),
      ...(typeof totalTokens === "number" ? { tokens: totalTokens } : {}),
      ...(typeof meta.transcript_event_count === "number" ? { tool_calls: meta.transcript_event_count } : {}),
    };
  } catch {
    return {};
  }
}

function routeMismatch(entries: readonly Record<string, unknown>[], provider: string): boolean {
  return entries.some((entry) => entry.outcome !== "ok"
    || entry.required_provider !== provider
    || typeof entry.resolved_provider !== "string"
    || !validateResolvedProvider({
      resolved_provider: entry.resolved_provider,
      generation_id: typeof entry.generation_id === "string" ? entry.generation_id : null,
      cost_usd: typeof entry.cost_usd === "number" ? entry.cost_usd : null,
      token_usage: entry.token_usage && typeof entry.token_usage === "object" ? entry.token_usage as Record<string, number> : null,
    }, provider));
}

function observationStatus(value: { success: boolean; na: boolean; gid: boolean }): V21FinalStatus {
  if (value.na) return "structural-na";
  return value.success && value.gid ? "pass" : "fail";
}

function observationRows(
  plan: V21InvocationPlan,
  taskIds: readonly string[],
  outcomes: Map<string, { success: boolean; na: boolean; gid: boolean }>,
  runDir: string,
  harness: V21Harness,
  forcedStatus?: "invalid-infra" | "invalid-route",
): V21TaskObservation[] {
  return taskIds.map((taskId) => {
    const outcome = outcomes.get(taskId) ?? { success: false, na: false, gid: false };
    const status = forcedStatus ?? observationStatus(outcome);
    const metrics = metricsForTask(runDir, harness, taskId);
    return {
      schema: "ax.daeb-v2-1-task-observation/v1",
      invocation_id: plan.invocation_id,
      task_id: taskId,
      vendor: plan.vendor,
      harness: plan.harness,
      model: plan.model,
      trial: plan.trial,
      family: plan.family,
      status,
      strict_pass: status === "pass",
      recovery_pass: status === "pass",
      ...metrics,
    };
  });
}

function checkpointFor(plan: V21InvocationPlan, runDir: string, status: Exclude<V21CellStatus, "pending">, attempts: number): V21Checkpoint {
  return {
    schema: "ax.daeb-v2-1-controller-checkpoint/v1",
    invocation_id: plan.invocation_id,
    vendor: plan.vendor,
    harness: plan.harness,
    model: plan.model,
    trial: plan.trial,
    family: plan.family,
    namespace: plan.namespace,
    status,
    attempts,
    artifact_dir: runDir,
    updated_at: new Date().toISOString(),
  };
}

async function executeCell(
  plan: V21InvocationPlan,
  packPath: string,
  runRoot: string,
  gateway: { baseUrl: string; provider: string },
): Promise<{ checkpoint: V21Checkpoint; observations: V21TaskObservation[] }> {
  const runDir = resolve(runRoot, "cells", plan.invocation_id);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const existing = readV21Checkpoint(runRoot, plan.invocation_id);
  if (isResumableV21Checkpoint(plan, existing)) {
    const observationsPath = resolve(runDir, "observations.json");
    const observations = existsSync(observationsPath)
      ? JSON.parse(readFileSync(observationsPath, "utf8")) as V21TaskObservation[]
      : [];
    return { checkpoint: existing, observations };
  }
  if (plan.status === "structural-na") {
    const checkpoint = checkpointFor(plan, runDir, "structural-na", 0);
    writeV21Checkpoint(runRoot, checkpoint);
    writeFileSync(resolve(runDir, "observations.json"), "[]\n", { mode: 0o600 });
    return { checkpoint, observations: [] };
  }

  const pack = loadPack(packPath);
  const family = taskPack(pack, plan.task_ids);
  const routeLedger = resolve(runRoot, `route-${plan.model.replace(/[^a-z0-9]+/gi, "_")}.jsonl`);
  const beforeRoutes = readRouteEntries(routeLedger).length;
  const args = v21ExecPlanArgs({
    packPath,
    runDir,
    plan,
    gatewayUrl: gateway.baseUrl,
    provider: gateway.provider,
    dataCollection: "allow",
    harness: plan.harness,
    model: plan.model,
  });
  const exitCode = await runChild(args);
  const routeEntries = readRouteEntries(routeLedger).slice(beforeRoutes);
  const paths = defaultInvokePaths(runDir, `${plan.harness}-medium-cli`, plan.harness as InvokeHarnessId);
  let executor: ReturnType<typeof loadResults> | undefined;
  let outcomes: Array<{ taskId: string; success: boolean; na: boolean }> = [];
  let infrastructureInvalid = exitCode !== 0;
  let cleanupError = false;
  try {
    executor = loadResults(paths.resultsPath);
    const trace = loadRequiredTrace(paths.tracePath);
    const client = new BearerClient(buildVerificationClientOptions(family, executor, process.env));
    const credentials = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const verified = await verifyGeneratedPack(family, executor, client, "cli", undefined, {
      oracleProviders: createDatabaseRuntimeExtensionRegistry().oracleProviders,
      env: process.env,
      credentials,
      trace,
    });
    outcomes = verified.map((outcome) => ({
      taskId: outcome.taskId,
      success: outcome.success,
      na: outcome.na,
    }));
    const registry = createDatabaseRuntimeExtensionRegistry();
    if (!executor.ns) throw new Error("executor did not persist a namespace for cleanup");
    const reset = registry.resetProviders.providerFor({ cell: {} as never, pack: family });
    if (!reset) throw new Error("no reset provider matched this V2.1 pack");
    const context = { cell: {} as never, pack: family, credentials, scope: {}, namespace: executor.ns, dryRun: false };
    await reset.execute(await reset.plan(context), context);
  } catch (error) {
    // A thrown verifier/cleanup/trace error is an infrastructure-invalid
    // observation. Ordinary agent task failures are returned as `success:false`
    // by verifyGeneratedPack and remain ordinary `fail` rows.
    infrastructureInvalid = true;
    cleanupError = /reset|cleanup|namespace/i.test(error instanceof Error ? error.message : String(error));
    if (!outcomes.length) outcomes = plan.task_ids.map((taskId) => ({ taskId, success: false, na: false }));
    if (error instanceof Error) writeFileSync(resolve(runDir, "controller-error.txt"), `${error.message}\n`, { mode: 0o600 });
  }
  const invalidRoute = routeMismatch(routeEntries, gateway.provider);
  const forcedStatus = invalidRoute ? "invalid-route" : (infrastructureInvalid || cleanupError ? "invalid-infra" : undefined);
  const outcomeMap = new Map(outcomes.map((outcome) => [outcome.taskId, { ...outcome, gid: Boolean(executor?.results[outcome.taskId]?.gid) }]));
  const observations = observationRows(plan, plan.task_ids, outcomeMap, runDir, plan.harness, forcedStatus);
  const status: Exclude<V21CellStatus, "pending"> = forcedStatus
    ?? (observations.every((observation) => observation.status === "pass") ? "pass" : "fail");
  const checkpoint = checkpointFor(plan, runDir, status, 1);
  writeFileSync(resolve(runDir, "observations.json"), JSON.stringify(observations, null, 2) + "\n", { mode: 0o600 });
  writeV21Checkpoint(runRoot, checkpoint);
  return { checkpoint, observations };
}

async function main(): Promise<number> {
  const suitePath = envPath("DAEB_V21_SUITE", "ax-arena/benchmark/axarena-database/v2-1/suite-v2-1.yaml");
  const runRoot = envPath("DAEB_V21_RUN_ROOT", `results/daeb-v2-1-formal-${new Date().toISOString().slice(0, 10)}`);
  const dryRun = process.argv.includes("--dry-run");
  if (!existsSync(suitePath)) throw new Error(`V2.1 suite not found: ${suitePath}`);
  const freezePath = `${suitePath}.freeze.json`;
  if (!existsSync(freezePath)) throw new Error(`V2.1 formal run requires a freeze manifest: ${freezePath}`);
  const freeze = JSON.parse(readFileSync(freezePath, "utf8")) as { production_eligible?: unknown; selected_task_ids?: unknown };
  if (freeze.production_eligible !== true && !dryRun) throw new Error("V2.1 formal run blocked: freeze manifest is not production_eligible");
  const suite = parseYaml(readFileSync(suitePath, "utf8")) as { tasks?: unknown };
  if (!Array.isArray(suite.tasks)) throw new Error("V2.1 suite has no tasks array");
  const tasks = suite.tasks.map((task) => V21TaskSchema.parse(task));
  const plan = buildV21ControllerPlan({ suitePath, suiteHash: sha256(suitePath), vendors: VENDORS, tasks, runRoot });
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(runRoot, "controller-plan.json"), JSON.stringify(plan, null, 2) + "\n", { mode: 0o600 });
  const manifestPath = resolve(runRoot, "run-manifest.json");
  const writeManifest = (status: "planned" | "running" | "complete" | "blocked", extra: Record<string, unknown> = {}) => {
    writeFileSync(manifestPath, JSON.stringify({
      schema: "ax.daeb-v2-1-formal-run-manifest/v1",
      suite: resolve(suitePath),
      suite_hash: plan.suite_hash,
      controller_plan_hash: createHash("sha256").update(JSON.stringify(plan)).digest("hex"),
      run_root: resolve(runRoot),
      vendors: VENDORS,
      harnesses: V21_HARNESSES,
      models: V21_MODELS,
      trials: 3,
      planned_invocations: 432,
      status,
      updated_at: new Date().toISOString(),
      ...extra,
    }, null, 2) + "\n", { mode: 0o600 });
  };
  writeManifest("planned");
  if (dryRun) {
    console.log(`V2.1 dry-run: ${plan.planned_invocations} cells → ${resolve(runRoot, "controller-plan.json")}`);
    return 0;
  }
  const selectedIds = new Set(tasks.map((task) => task.id));
  for (const vendor of VENDORS) {
    const packPath = PACKS[vendor];
    if (!existsSync(packPath)) throw new Error(`missing frozen vendor pack: ${packPath}`);
    const pack = loadPack(packPath);
    const packIds = new Set(pack.tasks.map((task) => task.id));
    const missing = [...selectedIds].filter((taskId) => !packIds.has(taskId));
    if (missing.length) throw new Error(`${vendor} pack is missing frozen task(s): ${missing.join(", ")}`);
    const approval = checkCellApproval(pack, packPath, packFileContentHash(packPath));
    if (!approval.ok) throw new Error(`${vendor} pack approval gate failed: ${approval.reason}`);
  }
  writeManifest("running");
  // The formal controller does not create or reuse a public OpenRouter key.
  // startV21OpenRouterGateway fails before the first cell if the isolated key
  // is absent, preserving an honest blocked run.
  const allObservations: V21TaskObservation[] = [];
  const allCells: Array<V21InvocationPlan & { status: V21CellStatus }> = [];
  for (const model of V21_MODELS) {
    const routePath = resolve(runRoot, `route-${model.replace(/[^a-z0-9]+/gi, "_")}.jsonl`);
    let gateway: Awaited<ReturnType<typeof startV21OpenRouterGateway>>;
    try {
      gateway = await startV21OpenRouterGateway(model, routePath);
    } catch (error) {
      writeManifest("blocked", { gate_error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    try {
      for (const planCell of plan.invocations.filter((cell) => cell.model === model)) {
        const detection = detectInvokeHarness(planCell.harness);
        if (!detection.ok || !detection.version) {
          throw new Error(`V2.1 ${planCell.harness} detection failed: ${detection.detail ?? detection.reason}`);
        }
        validateV21HarnessVersion(planCell.harness, detection.version);
        const result = await executeCell(planCell, PACKS[planCell.vendor]!, runRoot, { baseUrl: gateway.baseUrl, provider: gateway.policy.provider });
        allCells.push({ ...planCell, status: result.checkpoint.status });
        allObservations.push(...result.observations);
        console.log(`[v2.1] ${planCell.invocation_id} → ${result.checkpoint.status}`);
      }
    } finally {
      await gateway.close();
    }
  }
  if (allCells.length !== plan.invocations.length) throw new Error(`V2.1 controller completed ${allCells.length}/${plan.invocations.length} cells`);
  const ledger = buildV21ResultLedger(plan.invocations, allCells, allObservations);
  const ledgerPath = resolve(runRoot, "result-ledger.json");
  writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", { mode: 0o600 });
  try {
    validateV21ResultLedger(ledger, 432);
    writeFileSync(resolve(runRoot, "score-slices.json"), JSON.stringify(scoreV21Ledger(ledger), null, 2) + "\n", { mode: 0o600 });
    writeManifest("complete", { ledger: "result-ledger.json" });
    console.log(`V2.1 formal ledger complete → ${ledgerPath}`);
    return 0;
  } catch (error) {
    writeFileSync(resolve(runRoot, "formal-gate-error.txt"), `${error instanceof Error ? error.message : String(error)}\n`, { mode: 0o600 });
    writeManifest("blocked", { ledger: "result-ledger.json", gate_error: error instanceof Error ? error.message : String(error) });
    console.error(`V2.1 formal ledger retained but publication gate is closed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
