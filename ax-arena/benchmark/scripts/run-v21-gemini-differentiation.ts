#!/usr/bin/env node
/**
 * Diagnostic-only Gemini differentiation lane for the unfrozen V2.1 candidate
 * suite. This intentionally bypasses pack approval with --skip-review, keeps
 * structural N/A visible, and writes a calibration-shaped ledger. It is not a
 * formal V2.1 run and must never be pooled with publication evidence.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { config as loadDotenv } from "dotenv";
import {
  BearerClient,
  buildVerificationClientOptions,
  defaultInvokePaths,
  loadPack,
  loadRequiredTrace,
  loadResults,
  validateResolvedProvider,
  verifyGeneratedPack,
} from "ax-eval";
import { createDatabaseRuntimeExtensionRegistry } from "../src/index.js";
import {
  V21TaskSchema,
  type CalibrationObservation,
  type V21Task,
} from "../src/authoring/discriminative-suite.js";
import {
  planV21CalibrationInvocations,
  v21CalibrationExecPlanArgs,
  type V21CalibrationInvocationPlan,
} from "../src/runtime/v21-calibration.js";
import { startV21OpenRouterGateway } from "../src/runtime/v21-routes.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
loadDotenv({ path: resolve(ROOT, ".env") });
const CANDIDATE = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-1/candidate-suite-v2-1.yaml");
const PACK_ROOT = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-1/packs");
const MODEL = "google/gemini-3.7-flash-20260813" as const;
const VENDORS = (process.env.DAEB_V21_GEMINI_VENDORS ?? "cockroachdb,insforge,neon,nile,turso,supabase")
  .split(",").map((value) => value.trim()).filter(Boolean);
const EXEC_VENDORS = new Set((process.env.DAEB_V21_GEMINI_EXEC_VENDORS ?? VENDORS.join(","))
  .split(",").map((value) => value.trim()).filter(Boolean));
const TASK_FILTER = new Set((process.env.DAEB_V21_GEMINI_TASKS ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean));
const RUN_ROOT = resolve(ROOT, process.env.DAEB_V21_GEMINI_RUN_ROOT ?? `results/v21-gemini-differentiation-${new Date().toISOString().slice(0, 10)}`);
const MAX_ATTEMPTS = 2;
// Cells within one vendor deliberately remain serial because they share the
// pack's controller namespace and reset lifecycle. Independent vendors can
// run concurrently to keep this diagnostic from taking many hours.
const VENDOR_CONCURRENCY = Math.max(1, Number.parseInt(process.env.DAEB_V21_GEMINI_VENDOR_CONCURRENCY ?? "3", 10) || 3);

function readJsonl(path: string): Array<Record<string, unknown>> {
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

function routeInvalid(entries: readonly Record<string, unknown>[], provider: string): boolean {
  return entries.some((entry) => entry.outcome !== "ok"
    || entry.required_provider !== provider
    || !validateResolvedProvider({
      resolved_provider: typeof entry.resolved_provider === "string" ? entry.resolved_provider : null,
      generation_id: typeof entry.generation_id === "string" ? entry.generation_id : null,
      cost_usd: typeof entry.cost_usd === "number" ? entry.cost_usd : null,
      token_usage: entry.token_usage && typeof entry.token_usage === "object" ? entry.token_usage as Record<string, number> : null,
    }, provider));
}

function routeHasUpstreamError(entries: readonly Record<string, unknown>[]): boolean {
  return entries.some((entry) => entry.outcome === "upstream-error" || entry.status === 599);
}

function packForTask(packPath: string, taskId: string) {
  const pack = loadPack(packPath);
  return { ...pack, tasks: pack.tasks.filter((task) => task.id === taskId) };
}

type CellOutcome = CalibrationObservation & {
  invocation_id: string;
  family: string;
  attempts: number;
  exec_plan_exit_codes: number[];
  route_entries: number;
  gid_reported: boolean;
  oracle_success: boolean | null;
  cleanup: unknown;
  artifact_dir: string;
  bootstrap_status?: "pass" | "partial" | "missing";
  error?: string;
};

async function executeCell(
  plan: V21CalibrationInvocationPlan,
  gateway: { baseUrl: string; provider: string },
  routeLedger: string,
): Promise<CellOutcome> {
  const packPath = resolve(PACK_ROOT, plan.vendor, "pack.yaml");
  const cellDir = resolve(RUN_ROOT, "cells", plan.vendor, plan.task_id);
  mkdirSync(cellDir, { recursive: true, mode: 0o700 });
  const pack = packForTask(packPath, plan.task_id);
  const allExitCodes: number[] = [];
  let finalStatus: CalibrationObservation["status"] = "invalid-infra";
  let finalGid = false;
  let finalOracle: boolean | null = null;
  let cleanup: unknown = null;
  let lastError: string | undefined;
  let attempts = 0;
  const routeBefore = readJsonl(routeLedger).length;

  for (attempts = 1; attempts <= MAX_ATTEMPTS; attempts += 1) {
    const attemptDir = attempts === 1 ? cellDir : resolve(cellDir, `replacement-${attempts - 1}`);
    mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
    const attemptPlan = { ...plan, invocation_id: attempts === 1 ? plan.invocation_id : `${plan.invocation_id}-replacement-${attempts - 1}`, namespace: `${plan.namespace}-a${attempts}` };
    const args = v21CalibrationExecPlanArgs({
      packPath,
      runDir: attemptDir,
      plan: attemptPlan,
      gatewayUrl: gateway.baseUrl,
      provider: gateway.provider,
      dataCollection: "allow",
    });
    args.push("--skip-review");
    let exitCode = 1;
    try {
      exitCode = await runChild(args);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    allExitCodes.push(exitCode);
    const attemptRoutesBeforeVerification = readJsonl(routeLedger).length;
    const paths = defaultInvokePaths(attemptDir, "pi-medium-cli", "pi");
    let executor: ReturnType<typeof loadResults> | undefined;
    try {
      executor = loadResults(paths.resultsPath);
      const trace = loadRequiredTrace(paths.tracePath);
      const client = new BearerClient(buildVerificationClientOptions(pack, executor, process.env));
      const credentials = Object.fromEntries(Object.entries(process.env)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const verified = await verifyGeneratedPack(pack, executor, client, "cli", undefined, {
        oracleProviders: createDatabaseRuntimeExtensionRegistry().oracleProviders,
        env: process.env,
        credentials,
        trace,
      });
      const outcome = verified.find((item) => item.taskId === plan.task_id);
      finalOracle = outcome?.success ?? false;
      finalGid = Boolean(executor.results[plan.task_id]?.gid);
      const routes = readJsonl(routeLedger).slice(attemptRoutesBeforeVerification);
      if (routeInvalid(routes, gateway.provider)) {
        finalStatus = "invalid-route";
      } else if (exitCode !== 0) {
        finalStatus = "invalid-infra";
      } else {
        finalStatus = finalOracle && finalGid ? "pass" : "fail";
      }

      if (executor.ns) {
        const registry = createDatabaseRuntimeExtensionRegistry();
        const reset = registry.resetProviders.providerFor({ cell: {} as never, pack });
        if (!reset) throw new Error("no reset provider matched candidate pack");
        const credentialsForReset = Object.fromEntries(Object.entries(process.env)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        const context = { cell: {} as never, pack, credentials: credentialsForReset, scope: {}, namespace: executor.ns, dryRun: false };
        cleanup = { provider: reset.id, evidence: await reset.execute(await reset.plan(context), context) };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      finalStatus = "invalid-infra";
    }

    const routes = readJsonl(routeLedger).slice(attemptRoutesBeforeVerification);
    const replaceable = finalStatus === "invalid-infra" || routeHasUpstreamError(routes);
    if (!replaceable || finalStatus === "pass" || finalStatus === "fail") break;
    if (attempts < MAX_ATTEMPTS) {
      console.log(`[gemini-diff] replacement ${plan.vendor}/${plan.task_id} after ${finalStatus}`);
    }
  }

  const routeEntries = readJsonl(routeLedger).slice(routeBefore);
  attempts = Math.min(attempts, MAX_ATTEMPTS);
  let bootstrapStatus: CellOutcome["bootstrap_status"] = "missing";
  const bootstrapMetaPath = resolve(cellDir, "run-pi-medium-cli-bootstrap.invoke.json");
  if (existsSync(bootstrapMetaPath)) {
    try {
      const bootstrap = JSON.parse(readFileSync(bootstrapMetaPath, "utf8")) as { ok?: unknown; validity_status?: unknown };
      bootstrapStatus = bootstrap.ok === true && bootstrap.validity_status === "valid"
        ? "pass"
        : bootstrap.validity_status === "partial" ? "partial" : "missing";
    } catch {
      bootstrapStatus = "missing";
    }
  }
  const result: CellOutcome = {
    task_id: plan.task_id,
    vendor: plan.vendor,
    model: MODEL,
    harness: "pi",
    trial: 1,
    status: finalStatus,
    invocation_id: plan.invocation_id,
    family: plan.family,
    attempts,
    exec_plan_exit_codes: allExitCodes,
    route_entries: routeEntries.length,
    gid_reported: finalGid,
    oracle_success: finalOracle,
    cleanup,
    artifact_dir: cellDir,
    bootstrap_status: bootstrapStatus,
    ...(lastError ? { error: lastError } : {}),
  };
  writeFileSync(resolve(cellDir, "observation.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  return result;
}

async function main(): Promise<void> {
  if (!existsSync(CANDIDATE)) throw new Error(`candidate suite missing: ${CANDIDATE}`);
  const parsed = parseYaml(readFileSync(CANDIDATE, "utf8")) as { tasks?: unknown[] };
  const tasks = (parsed.tasks ?? []).map((task) => V21TaskSchema.parse(task));
  const plan = planV21CalibrationInvocations(VENDORS, tasks).invocations
    .filter((cell) => cell.model === MODEL)
    .filter((cell) => EXEC_VENDORS.has(cell.vendor))
    .filter((cell) => !TASK_FILTER.size || TASK_FILTER.has(cell.task_id));
  mkdirSync(RUN_ROOT, { recursive: true, mode: 0o700 });
  const routeLedger = resolve(RUN_ROOT, "route-google_gemini_3_7_flash_20260813.jsonl");
  const gateway = await startV21OpenRouterGateway(MODEL, routeLedger);
  const results: CellOutcome[] = [];
  const planned = plan.length;
  writeFileSync(resolve(RUN_ROOT, "run-manifest.json"), JSON.stringify({
    schema: "ax.daeb-v2-1-gemini-differentiation-run/v1",
    status: "running",
    candidate_suite: CANDIDATE,
    model: MODEL,
    provider: gateway.policy.provider,
    harness: "pi",
    trial: 1,
    vendors: VENDORS,
    planned_cells: planned,
    structural_na_cells: plan.filter((cell) => cell.status === "structural-na").length,
    runnable_cells: plan.filter((cell) => cell.status !== "structural-na").length,
    max_attempts: MAX_ATTEMPTS,
    vendor_concurrency: VENDOR_CONCURRENCY,
    formal: false,
    updated_at: new Date().toISOString(),
  }, null, 2) + "\n", { mode: 0o600 });
  try {
    const byVendor = new Map<string, V21CalibrationInvocationPlan[]>();
    for (const cell of plan) {
      const cells = byVendor.get(cell.vendor) ?? [];
      cells.push(cell);
      byVendor.set(cell.vendor, cells);
    }
    const vendorQueue = VENDORS.filter((vendor) => EXEC_VENDORS.has(vendor) && byVendor.has(vendor));
    let nextVendor = 0;
    const runVendor = async (): Promise<void> => {
      while (true) {
        const vendorIndex = nextVendor;
        nextVendor += 1;
        if (vendorIndex >= vendorQueue.length) return;
        const vendor = vendorQueue[vendorIndex];
        for (const cell of byVendor.get(vendor) ?? []) {
          if (cell.status === "structural-na") {
            const result: CellOutcome = {
              task_id: cell.task_id,
              vendor: cell.vendor,
              model: MODEL,
              harness: "pi",
              trial: 1,
              status: "structural-na",
              invocation_id: cell.invocation_id,
              family: cell.family,
              attempts: 0,
              exec_plan_exit_codes: [],
              route_entries: 0,
              gid_reported: false,
              oracle_success: null,
              cleanup: null,
              artifact_dir: resolve(RUN_ROOT, "cells", cell.vendor, cell.task_id),
              bootstrap_status: undefined,
            };
            mkdirSync(result.artifact_dir, { recursive: true, mode: 0o700 });
            writeFileSync(resolve(result.artifact_dir, "observation.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
            results.push(result);
            console.log(`[gemini-diff] ${results.length}/${planned} ${cell.vendor}/${cell.task_id} → structural-na`);
          } else {
            const result = await executeCell(cell, { baseUrl: gateway.baseUrl, provider: gateway.policy.provider }, routeLedger);
            results.push(result);
            console.log(`[gemini-diff] ${results.length}/${planned} ${cell.vendor}/${cell.task_id} → ${result.status} (attempts=${result.attempts})`);
          }
          writeFileSync(resolve(RUN_ROOT, "observations.jsonl"), results.map((item) => JSON.stringify(item)).join("\n") + "\n", { mode: 0o600 });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(VENDOR_CONCURRENCY, vendorQueue.length) }, () => runVendor()));
  } finally {
    await gateway.close();
  }

  const grouped = Object.fromEntries(VENDORS.map((vendor) => {
    const rows = results.filter((row) => row.vendor === vendor);
    const runnable = rows.filter((row) => row.status !== "structural-na");
    return [vendor, {
      total: rows.length,
      structural_na: rows.filter((row) => row.status === "structural-na").length,
      runnable: runnable.length,
      pass: runnable.filter((row) => row.status === "pass").length,
      fail: runnable.filter((row) => row.status === "fail").length,
      invalid_infra: runnable.filter((row) => row.status === "invalid-infra").length,
      invalid_route: runnable.filter((row) => row.status === "invalid-route").length,
      bootstrap_invalid: runnable.filter((row) => row.bootstrap_status !== "pass").length,
      pass_rate: runnable.length ? runnable.filter((row) => row.status === "pass").length / runnable.length : null,
    }];
  }));
  const summary = {
    schema: "ax.daeb-v2-1-gemini-differentiation-summary/v1",
    candidate_suite: CANDIDATE,
    model: MODEL,
    provider: "google-vertex",
    harness: "pi",
    trial: 1,
    planned_cells: planned,
    observed_cells: results.length,
    grouped,
    status_counts: Object.fromEntries(["pass", "fail", "structural-na", "invalid-infra", "invalid-route"].map((status) => [status, results.filter((row) => row.status === status).length])),
    route_entries: readJsonl(routeLedger).length,
    formal: false,
    completed_at: new Date().toISOString(),
  };
  writeFileSync(resolve(RUN_ROOT, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  const manifestPath = resolve(RUN_ROOT, "run-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, status: "complete", observed_cells: results.length, updated_at: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
  console.log(`[gemini-diff] complete → ${resolve(RUN_ROOT, "summary.json")}`);
}

await main();
