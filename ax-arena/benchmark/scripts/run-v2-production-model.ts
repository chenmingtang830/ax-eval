/**
 * Reproducible local model lane for the DAEB v2 production packs.
 *
 * This is a diagnostic/qualification runner, not the hosted publication
 * workflow. It always verifies through the arena provider registry and writes
 * a strict (gid + independent oracle) audit before namespaced cleanup.
 *
 * Required environment:
 *   DAEB_V2_HARNESS=codex|claude-code|opencode
 *   DAEB_V2_MODEL=<frozen model route>
 * Optional:
 *   DAEB_V2_BATCH, DAEB_V2_VENDORS, DAEB_V2_TRIALS, DAEB_V2_PROFILE
 */
import "dotenv/config";

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BearerClient,
  buildVerificationClientOptions,
  loadPack,
  loadRequiredTrace,
  loadResults,
  verifyGeneratedPack,
  type RoundtripOutcome,
} from "ax-eval";
import { createDatabaseRuntimeExtensionRegistry } from "../src/index.js";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const HARNESS = process.env.DAEB_V2_HARNESS ?? "opencode";
const MODEL = process.env.DAEB_V2_MODEL ?? "openrouter/z-ai/glm-5.2";
const PROFILE = process.env.DAEB_V2_PROFILE ?? (HARNESS === "codex" ? "gpt5" : "medium");
const EFFORT = process.env.DAEB_V2_EFFORT ?? "high";
const BATCH = process.env.DAEB_V2_BATCH ?? `daeb-v2-${HARNESS}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
const PACK_ROOT = resolve(ROOT, process.env.DAEB_V2_PACK_ROOT ?? "ax-arena/benchmark/axarena-database/v2/production/packs");
const VENDORS = (process.env.DAEB_V2_VENDORS ?? "cockroachdb,insforge,neon,nile")
  .split(",").map((value) => value.trim()).filter(Boolean);
const TRIALS = (process.env.DAEB_V2_TRIALS ?? "1,2,3")
  .split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);

function runExecPlan(packPath: string, runDir: string, runBatchId: string, trial: number): Promise<number> {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = [
    "run", "ax-eval", "--", "exec-plan",
    "--pack", packPath,
    "--harness", HARNESS,
    "--profile", PROFILE,
    "--model", MODEL,
    "--effort", EFFORT,
    "--surface", "cli",
    "--isolated-harness-auth",
    "--invoke",
    "--execution-mode", "cell",
    "--attempts", "1",
    "--trial", String(trial),
    "--concurrency", "1",
    "--invoke-timeout", "900",
    "--first-action-timeout", "180",
    "--invoke-retries", "0",
    "--run-batch-id", runBatchId,
    "--run-dir", runDir,
  ];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(npm, args, { cwd: ROOT, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise(code ?? (signal ? 1 : 0)));
  });
}

function compactOutcomes(outcomes: RoundtripOutcome[]) {
  return outcomes.map((outcome) => ({
    taskId: outcome.taskId,
    difficulty: outcome.difficulty,
    success: outcome.success,
    na: outcome.na,
    error: outcome.error,
    oracleResults: outcome.oracleResults.map((result) => ({
      type: result.type,
      passed: result.passed,
      detail: result.detail,
    })),
  }));
}

async function verifyAndCleanup(vendor: string, packPath: string, runDir: string, exitCode: number, trial: number): Promise<void> {
  const pack = loadPack(packPath);
  const artifactStem = `run-${HARNESS}-${PROFILE}-cli`;
  const resultPath = join(runDir, `${artifactStem}.json`);
  const tracePath = join(runDir, `${artifactStem}.trace.json`);
  const credentials = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const registry = createDatabaseRuntimeExtensionRegistry();
  let executor: ReturnType<typeof loadResults> | undefined;
  let outcomes: RoundtripOutcome[] = [];
  let verifyError: string | undefined;
  try {
    executor = loadResults(resultPath);
    const trace = loadRequiredTrace(tracePath);
    const client = new BearerClient(buildVerificationClientOptions(pack, executor, process.env));
    outcomes = await verifyGeneratedPack(pack, executor, client, "cli", undefined, {
      oracleProviders: registry.oracleProviders,
      env: process.env,
      credentials,
      trace,
    });
  } catch (error) {
    verifyError = error instanceof Error ? error.message : String(error);
  }

  const taskAudit = outcomes.map((outcome) => ({
    task_id: outcome.taskId,
    na: outcome.na,
    gid_reported: Boolean(executor?.results[outcome.taskId]?.gid),
    oracle_passed: outcome.success,
    strict_passed: !outcome.na && Boolean(executor?.results[outcome.taskId]?.gid) && outcome.success,
  }));
  let cleanup: unknown = null;
  if (executor?.ns) {
    const provider = registry.resetProviders.providerFor({ cell: {} as never, pack });
    if (provider) {
      try {
        const context = { cell: {} as never, pack, credentials, scope: {}, namespace: executor.ns, dryRun: false };
        const plan = await provider.plan(context);
        const evidence = await provider.execute(plan, context);
        cleanup = { provider: { id: provider.id, version: provider.version }, namespace: executor.ns, plan, evidence };
      } catch (error) {
        cleanup = { error: error instanceof Error ? error.message : String(error) };
      }
    } else {
      cleanup = { error: "no matching reset provider" };
    }
  } else {
    cleanup = { error: "no persisted executor namespace" };
  }
  const runnable = pack.tasks.filter((task) => !task.na).length;
  const strictPassed = taskAudit.filter((task) => task.strict_passed).length;
  const oraclePassed = taskAudit.filter((task) => !task.na && task.oracle_passed).length;
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "model-audit.json"), JSON.stringify({
    schema: "ax.daeb-v2-production-model-audit/v2",
    generated_at: new Date().toISOString(),
    vendor,
    harness: HARNESS,
    model: MODEL,
    profile: PROFILE,
    effort: EFFORT,
    route: HARNESS === "opencode" ? `OpenCode -> ${MODEL}` : `${HARNESS} -> ${MODEL}`,
    batch: BATCH,
    trial,
    surface: "cli",
    exec_plan_exit_code: exitCode,
    namespace: executor?.ns ?? null,
    summary: {
      runnable_tasks: runnable,
      oracle_passed: oraclePassed,
      strict_passed: strictPassed,
      oracle_rate: runnable ? oraclePassed / runnable : null,
      strict_rate: runnable ? strictPassed / runnable : null,
    },
    task_audit: taskAudit,
    outcomes: compactOutcomes(outcomes),
    verify_error: verifyError ?? null,
    cleanup,
  }, null, 2) + "\n", { mode: 0o600 });
  console.log(`[v2-audit] ${vendor} trial-${trial}: strict ${strictPassed}/${runnable}; oracle ${oraclePassed}/${runnable}; exec-plan=${exitCode}`);
}

async function main(): Promise<void> {
  for (const trial of TRIALS) {
    for (const vendor of VENDORS) {
      const packDir = process.env[`DAEB_V2_PACK_DIR_${vendor.toUpperCase()}`] ?? vendor;
      const packPath = resolve(PACK_ROOT, packDir, "pack.yaml");
      const runDir = resolve(ROOT, "results", BATCH, vendor, `trial-${trial}`);
      mkdirSync(runDir, { recursive: true });
      console.log(`[v2] starting ${vendor} with ${MODEL} (${HARNESS}, trial ${trial})`);
      let exitCode = 1;
      try {
        exitCode = await runExecPlan(packPath, runDir, `${BATCH}-${vendor}-t${trial}`, trial);
      } catch (error) {
        console.error(`[v2] ${vendor} trial-${trial} spawn failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await verifyAndCleanup(vendor, packPath, runDir, exitCode, trial);
    }
  }
}

await main();
