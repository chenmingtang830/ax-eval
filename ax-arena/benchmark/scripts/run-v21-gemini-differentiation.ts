#!/usr/bin/env node
/**
 * Diagnostic-only atomic-task runner for the unfrozen V2.3 candidate suite.
 * It uses the V2.1 task/support planner only as a matrix helper, intentionally
 * preserves structural N/A visibility and writes a calibration-shaped ledger.
 * V2.3 calls require exact pack approval; the historical V2.1 fallback remains
 * diagnostic-only and bypasses review. It is not formal benchmark evidence and
 * must never be pooled with a frozen record.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  startOpenRouterGateway,
  validateResolvedProvider,
  type OpenRouterRoutePolicy,
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

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
loadDotenv({ path: resolve(ROOT, ".env") });
const CANDIDATE = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-1/candidate-suite-v2-1.yaml");
const V23_SUITE = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/vendor-experience-suite.yaml");
const V24_SUITE = process.env.DAEB_V24_SUITE?.trim();
const V23_PACK_ROOT = process.env.DAEB_V23_PACK_ROOT?.trim();
const PACK_ROOT = resolve(ROOT, V23_PACK_ROOT ?? (V24_SUITE
  ? "ax-arena/benchmark/axarena-database/v2-3/packs"
  : "ax-arena/benchmark/axarena-database/v2-1/packs"));
const REQUIRE_PACK_APPROVAL = Boolean(V23_PACK_ROOT) || Boolean(V24_SUITE);
const EXECUTION_SUITE = REQUIRE_PACK_APPROVAL ? V23_SUITE : CANDIDATE;
const EVALUATION_SUITE = V24_SUITE ? resolve(ROOT, V24_SUITE) : EXECUTION_SUITE;
const ATOMIC_SCHEMA = V24_SUITE ? "ax.daeb-v2-4-atomic" : "ax.daeb-v2-3-atomic";
/** Defaults preserve the historical Gemini diagnostic lane; V2.3 execution
 * supplies both fields explicitly and never falls back across providers. */
const MODEL = process.env.DAEB_V23_MODEL?.trim() || "google/gemini-3.7-flash-20260813";
const PROVIDER = process.env.DAEB_V23_PROVIDER?.trim() || "google-vertex";
const VENDORS = (process.env.DAEB_V23_VENDORS ?? process.env.DAEB_V21_GEMINI_VENDORS ?? "cockroachdb,insforge,neon,nile,turso,supabase")
  .split(",").map((value) => value.trim()).filter(Boolean);
const EXEC_VENDORS = new Set((process.env.DAEB_V23_EXEC_VENDORS ?? process.env.DAEB_V21_GEMINI_EXEC_VENDORS ?? VENDORS.join(","))
  .split(",").map((value) => value.trim()).filter(Boolean));
const TASK_FILTER = new Set((process.env.DAEB_V23_TASKS ?? process.env.DAEB_V21_GEMINI_TASKS ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean));
const RUN_ROOT = resolve(ROOT, process.env.DAEB_V23_RUN_ROOT ?? process.env.DAEB_V21_GEMINI_RUN_ROOT ?? `results/v23-atomic-${new Date().toISOString().slice(0, 10)}`);
// V2.3 calibration allowed a bounded replacement only for a transport-invalid
// invocation.  V2.4 is a frozen benchmark lane: every first attempt is a
// reportable observation, so replacements would silently alter its denominator.
const MAX_ATTEMPTS = process.env.DAEB_V24_SUITE?.trim() ? 1 : 2;
const TRIAL = Math.max(1, Number.parseInt(process.env.DAEB_V23_TRIAL ?? process.env.DAEB_V21_GEMINI_TRIAL ?? "1", 10) || 1);
const PLAN_ONLY = process.env.DAEB_V23_PLAN_ONLY === "1";
// Cells within one vendor deliberately remain serial because they share the
// pack's controller namespace and reset lifecycle. Independent vendors can
// run concurrently to keep this diagnostic from taking many hours.
const VENDOR_CONCURRENCY = Math.max(1, Number.parseInt(process.env.DAEB_V23_VENDOR_CONCURRENCY ?? process.env.DAEB_V21_GEMINI_VENDOR_CONCURRENCY ?? "3", 10) || 3);

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

async function startV23Gateway(routeLedger: string): Promise<{
  baseUrl: string;
  policy: OpenRouterRoutePolicy;
  close(): Promise<void>;
}> {
  const apiKey = process.env.AX_EVAL_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("V2.3 gateway requires AX_EVAL_OPENROUTER_API_KEY or OPENROUTER_API_KEY");
  const policy: OpenRouterRoutePolicy = {
    model: MODEL,
    canonical_model: MODEL,
    provider: PROVIDER,
    data_collection: "allow",
  };
  const gateway = await startOpenRouterGateway({ policy, apiKey, ledgerPath: routeLedger });
  return { baseUrl: `http://127.0.0.1:${gateway.port}/v1`, policy, close: () => gateway.close() };
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A malformed required result or trace written by the agent is observable
 * task behavior. It must not be collapsed into an infrastructure invalid just
 * because a later parser cannot load it. */
function hasInvocationArtifacts(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.startsWith("run-pi-medium-cli")
      && (name.endsWith(".json") || name.endsWith(".jsonl")));
  } catch {
    return false;
  }
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

/** The SQL oracle needs only its declared verifier credential. Supplying the
 * whole inherited environment to verification makes redaction treat arbitrary
 * one-character env values as secrets, which destroys predicate diagnostics. */
function verificationCredentials(pack: ReturnType<typeof loadPack>): Record<string, string> {
  const names = [pack.sql_conn?.connection_string_env, pack.auth?.env]
    .filter((name): name is string => typeof name === "string" && name.length > 0);
  return Object.fromEntries(names.flatMap((name) => typeof process.env[name] === "string"
    ? [[name, process.env[name]!]]
    : []));
}

type CellOutcome = CalibrationObservation & {
  invocation_id: string;
  family: string;
  attempts: number;
  exec_plan_exit_codes: number[];
  route_entries: number;
  gid_reported: boolean;
  oracle_success: boolean | null;
  agent_attempted: boolean;
  cleanup: unknown;
  artifact_dir: string;
  /** Independent pre-cleanup predicate results, stored in verification.json. */
  oracle_evidence_path?: string;
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
  let finalAgentAttempted = false;
  let cleanup: unknown = null;
  let oracleEvidencePath: string | undefined;
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
    if (!REQUIRE_PACK_APPROVAL) args.push("--skip-review");
    let exitCode = 1;
    try {
      exitCode = await runChild(args);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    allExitCodes.push(exitCode);
    const attemptRoutesBeforeVerification = readJsonl(routeLedger).length;
    // `exec-plan --execution-mode task` writes the agent result to a
    // task-specific path. The aggregate `pi-medium-cli` file is only a
    // placeholder, so loading it here would turn successful task work into an
    // artificial ENOENT/fail observation.
    const paths = defaultInvokePaths(attemptDir, `pi-medium-cli-${plan.task_id}`, "pi");
    let executor: ReturnType<typeof loadResults> | undefined;
    try {
      executor = loadResults(paths.resultsPath);
      const trace = loadRequiredTrace(paths.tracePath);
      const client = new BearerClient(buildVerificationClientOptions(pack, executor, process.env));
      const cleanupCredentials = Object.fromEntries(Object.entries(process.env)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const verified = await verifyGeneratedPack(pack, executor, client, "cli", undefined, {
        oracleProviders: createDatabaseRuntimeExtensionRegistry().oracleProviders,
        env: process.env,
        credentials: verificationCredentials(pack),
        trace,
      });
      const outcome = verified.find((item) => item.taskId === plan.task_id);
      finalAgentAttempted = trace.length > 0 || Boolean(executor.results[plan.task_id]);
      // This is the verifier's redacted predicate-level evidence, persisted
      // before cleanup. A later task-quality audit must be able to distinguish
      // a genuine agent failure from an oracle/contract defect without rerunning
      // or inferring state after the reset.
      oracleEvidencePath = resolve(attemptDir, "verification.json");
      writeFileSync(oracleEvidencePath, JSON.stringify({
        schema: "ax.daeb-v2-3-predicate-verification/v1",
        task_id: plan.task_id,
        vendor: plan.vendor,
        model: MODEL,
        trial: TRIAL,
        verified_before_cleanup: true,
        success: outcome?.success ?? false,
        error: outcome?.error ?? "task outcome missing",
        oracle_results: outcome?.oracleResults ?? [],
      }, null, 2) + "\n", { mode: 0o600 });
      finalOracle = outcome?.success ?? false;
      finalGid = Boolean(executor.results[plan.task_id]?.gid);
      const routes = readJsonl(routeLedger).slice(attemptRoutesBeforeVerification);
      if (routeInvalid(routes, gateway.provider)) {
        finalStatus = "invalid-route";
      // A timeout/non-zero harness exit after a trace/result artifact exists is
      // a bounded agent failure, not infrastructure. Only a run that produced
      // no evidence of attempted work remains invalid-infra.
      } else if (exitCode !== 0 && !finalAgentAttempted) {
        finalStatus = "invalid-infra";
      } else {
        finalStatus = finalOracle && finalGid ? "pass" : "fail";
      }

      if (executor.ns) {
        const registry = createDatabaseRuntimeExtensionRegistry();
        const reset = registry.resetProviders.providerFor({ cell: {} as never, pack });
        if (!reset) throw new Error("no reset provider matched candidate pack");
        const context = { cell: {} as never, pack, credentials: cleanupCredentials, scope: {}, namespace: executor.ns, dryRun: false };
        cleanup = { provider: reset.id, evidence: await reset.execute(await reset.plan(context), context) };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // loadResults/loadRequiredTrace can fail because the agent wrote invalid
      // JSON. Its bootstrap/task artifacts prove attempted work, so retain it
      // as an outcome failure. A process with no agent artifact remains an
      // infrastructure invalid.
      finalAgentAttempted = finalAgentAttempted || hasInvocationArtifacts(attemptDir);
      finalStatus = finalAgentAttempted ? "fail" : "invalid-infra";
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
    trial: TRIAL,
    status: finalStatus,
    invocation_id: plan.invocation_id,
    family: plan.family,
    attempts,
    exec_plan_exit_codes: allExitCodes,
    route_entries: routeEntries.length,
    gid_reported: finalGid,
    oracle_success: finalOracle,
    agent_attempted: finalAgentAttempted,
    cleanup,
    artifact_dir: cellDir,
    ...(oracleEvidencePath ? { oracle_evidence_path: oracleEvidencePath } : {}),
    bootstrap_status: bootstrapStatus,
    ...(lastError ? { error: lastError } : {}),
  };
  writeFileSync(resolve(cellDir, "observation.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  return result;
}

async function main(): Promise<void> {
  if (!existsSync(CANDIDATE)) throw new Error(`candidate suite missing: ${CANDIDATE}`);
  if (!existsSync(V23_SUITE)) throw new Error(`V2.3 suite missing: ${V23_SUITE}`);
  const parsed = parseYaml(readFileSync(CANDIDATE, "utf8")) as { tasks?: unknown[] };
  const tasks = (parsed.tasks ?? []).map((task) => V21TaskSchema.parse(task));
  const v23 = parseYaml(readFileSync(V23_SUITE, "utf8")) as {
    status?: string;
    tasks?: Array<{ id: string; admitted_vendors: string[]; structural_na_vendors: string[] }>;
  };
  if (v23.status !== "frozen") throw new Error(`V2.3 suite must be frozen, got ${v23.status ?? "missing"}`);
  const v23Tasks = new Map((v23.tasks ?? [])
    .filter((task) => task.id !== "db-J01-native-journey")
    .map((task) => [task.id, task]));
  if (!v23Tasks.size) throw new Error("V2.3 suite has no atomic tasks");
  // Use the V2.1 candidate task/support planner only for its task matrix; V2.3
  // supplies the actual model/provider pair and gives every pair a fresh ID.
  const plan = planV21CalibrationInvocations(VENDORS, tasks, TRIAL).invocations
    .filter((cell) => cell.model === "google/gemini-3.7-flash-20260813")
    .filter((cell) => EXEC_VENDORS.has(cell.vendor))
    .filter((cell) => v23Tasks.has(cell.task_id))
    .filter((cell) => !TASK_FILTER.size || TASK_FILTER.has(cell.task_id))
    .map((cell) => {
      const task = v23Tasks.get(cell.task_id)!;
      const status = task.structural_na_vendors.includes(cell.vendor) ? "structural-na" : "pending";
      if (status === "pending" && !task.admitted_vendors.includes(cell.vendor)) {
        throw new Error(`V2.3 matrix omits ${cell.vendor}/${cell.task_id}`);
      }
      const invocation_id = `v23-${cell.vendor}-pi-${shortHash(`${MODEL}:${TRIAL}:${cell.task_id}`)}`;
      return {
        ...cell,
        status,
        model: MODEL,
        invocation_id,
        namespace: `${invocation_id}-ns`,
      } as V21CalibrationInvocationPlan;
    });
  mkdirSync(RUN_ROOT, { recursive: true, mode: 0o700 });
  if (PLAN_ONLY) {
    writeFileSync(resolve(RUN_ROOT, "run-plan.json"), JSON.stringify({
      schema: `${ATOMIC_SCHEMA}-run-plan/v1`,
      candidate_source: CANDIDATE,
      suite: EVALUATION_SUITE,
      model: MODEL,
      provider: PROVIDER,
      trial: TRIAL,
      planned_cells: plan.length,
      runnable_cells: plan.filter((cell) => cell.status === "pending").length,
      structural_na_cells: plan.filter((cell) => cell.status === "structural-na").length,
      invocations: plan,
    }, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ planned_cells: plan.length, runnable_cells: plan.filter((cell) => cell.status === "pending").length, structural_na_cells: plan.filter((cell) => cell.status === "structural-na").length }, null, 2));
    return;
  }
  const routeLedger = resolve(RUN_ROOT, `route-${MODEL.replace(/[^a-zA-Z0-9]+/g, "_")}.jsonl`);
  const gateway = await startV23Gateway(routeLedger);
  const results: CellOutcome[] = [];
  const planned = plan.length;
  writeFileSync(resolve(RUN_ROOT, "run-manifest.json"), JSON.stringify({
    schema: `${ATOMIC_SCHEMA}-run/v1`,
    status: "running",
    candidate_suite: EVALUATION_SUITE,
    model: MODEL,
    provider: gateway.policy.provider,
    harness: "pi",
    trial: TRIAL,
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
              trial: TRIAL,
              status: "structural-na",
              invocation_id: cell.invocation_id,
              family: cell.family,
              attempts: 0,
              exec_plan_exit_codes: [],
              route_entries: 0,
              gid_reported: false,
              oracle_success: null,
              agent_attempted: false,
              cleanup: null,
              artifact_dir: resolve(RUN_ROOT, "cells", cell.vendor, cell.task_id),
              bootstrap_status: undefined,
            };
            mkdirSync(result.artifact_dir, { recursive: true, mode: 0o700 });
            writeFileSync(resolve(result.artifact_dir, "observation.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
            results.push(result);
            console.log(`[v23-atomic] ${results.length}/${planned} ${cell.vendor}/${cell.task_id} → structural-na`);
          } else {
            const result = await executeCell(cell, { baseUrl: gateway.baseUrl, provider: gateway.policy.provider }, routeLedger);
            results.push(result);
            console.log(`[v23-atomic] ${results.length}/${planned} ${cell.vendor}/${cell.task_id} → ${result.status} (attempts=${result.attempts})`);
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
    schema: `${ATOMIC_SCHEMA}-summary/v1`,
    candidate_suite: EVALUATION_SUITE,
    model: MODEL,
    provider: gateway.policy.provider,
    harness: "pi",
    trial: TRIAL,
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
  console.log(`[v23-atomic] complete → ${resolve(RUN_ROOT, "summary.json")}`);
}

await main();
