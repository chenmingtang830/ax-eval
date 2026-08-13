import "dotenv/config";

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BearerClient } from "../../../src/http/client.js";
import { buildVerificationClientOptions } from "../../../src/generate/verification-client.js";
import {
  loadRequiredTrace,
  loadResults,
  verifyGeneratedPack,
  type RoundtripOutcome,
} from "../../../src/generate/verify.js";
import { loadPack } from "../../../src/config.js";
import { createDatabaseRuntimeExtensionRegistry } from "../src/index.js";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const MODEL = "openrouter/z-ai/glm-5.2";
const BATCH = process.env.DAEB_V2_BATCH ?? "daeb-v2-glm52-cli-full-20260812";
const TRIAL = Number(process.env.DAEB_V2_TRIAL ?? "2");
const VENDORS = (process.env.DAEB_V2_VENDORS ?? "cockroachdb,insforge,neon,nile,turso")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function runExecPlan(packPath: string, runDir: string, runBatchId: string): Promise<number> {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = [
    "run", "ax-eval", "--", "exec-plan",
    "--pack", packPath,
    "--harness", "opencode",
    "--profile", "high",
    "--model", MODEL,
    "--effort", "high",
    "--surface", "cli",
    "--invoke",
    "--execution-mode", "task",
    "--attempts", "1",
    "--trial", String(TRIAL),
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

async function cleanupPostgresDatabases(pack: ReturnType<typeof loadPack>, namespace: string): Promise<string[]> {
  if (pack.sql_conn?.dialect !== "postgres") return [];
  const connectionString = process.env[pack.sql_conn.connection_string_env];
  if (!connectionString) return [];
  const { Client } = await import("pg");
  const client = new Client({ connectionString });
  await client.connect();
  const deleted: string[] = [];
  try {
    const rows = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'axarena_%'",
    );
    const suffix = `_${namespace}`;
    for (const row of rows.rows) {
      const name = row.datname;
      if (!name.startsWith("axarena_") || !name.endsWith(suffix)) continue;
      const quoted = `"${name.replaceAll('"', '""')}"`;
      await client.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
      deleted.push(name);
    }
  } finally {
    await client.end();
  }
  return deleted;
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

async function verifyAndCleanup(vendor: string, packPath: string, runDir: string, exitCode: number) {
  const pack = loadPack(packPath);
  const resultPath = join(runDir, "run-opencode-high-cli.json");
  const tracePath = join(runDir, "run-opencode-high-cli.trace.json");
  const auditPath = join(runDir, "model-audit.json");
  const credentials = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  const registry = createDatabaseRuntimeExtensionRegistry();
  let executor: ReturnType<typeof loadResults> | undefined;
  let outcomes: RoundtripOutcome[] = [];
  let verifyError: string | undefined;
  if (resultPath && tracePath) {
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
  } else {
    verifyError = "executor result or required trace artifact is missing";
  }

  let cleanup: unknown = null;
  const droppedDatabases: string[] = [];
  if (executor?.ns) {
    const provider = registry.resetProviders.providerFor({ cell: {} as never, pack });
    if (provider) {
      const context = {
        cell: {} as never,
        pack,
        credentials,
        scope: {},
        namespace: executor.ns,
        dryRun: false,
      };
      try {
        const plan = await provider.plan(context);
        const evidence = await provider.execute(plan, context);
        cleanup = { provider: { id: provider.id, version: provider.version }, plan, evidence };
      } catch (error) {
        cleanup = { provider: { id: provider.id, version: provider.version }, error: error instanceof Error ? error.message : String(error) };
      }
      try {
        droppedDatabases.push(...await cleanupPostgresDatabases(pack, executor.ns));
      } catch (error) {
        cleanup = { ...(cleanup as Record<string, unknown> ?? {}), databaseCleanupError: error instanceof Error ? error.message : String(error) };
      }
    } else {
      cleanup = { error: "no matching reset provider" };
    }
  } else {
    cleanup = { error: "no persisted executor namespace" };
  }

  const passed = outcomes.filter((outcome) => !outcome.na && outcome.success).length;
  const eligible = outcomes.filter((outcome) => !outcome.na).length;
  mkdirSync(runDir, { recursive: true });
  writeFileSync(auditPath, JSON.stringify({
    schema: "daeb-v2-model-audit.v1",
    vendor,
    model: MODEL,
    route: "OpenCode -> OpenRouter -> z-ai/glm-5.2",
    batch: BATCH,
    trial: TRIAL,
    execPlanExitCode: exitCode,
    namespace: executor?.ns ?? null,
    summary: { passed, eligible, rate: eligible ? passed / eligible : null },
    outcomes: compactOutcomes(outcomes),
    verifyError: verifyError ?? null,
    cleanup,
    droppedDatabases,
  }, null, 2) + "\n");
  console.log(`[v2-audit] ${vendor}: ${passed}/${eligible} verified; exec-plan=${exitCode}; audit=${auditPath}`);
}

async function main() {
  for (const vendor of VENDORS) {
    const packPath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2/packs", vendor, "pack.yaml");
    const runDir = resolve(ROOT, "results", BATCH, vendor);
    mkdirSync(runDir, { recursive: true });
    console.log(`[v2] starting ${vendor} with ${MODEL} (trial ${TRIAL})`);
    let exitCode = 1;
    try {
      exitCode = await runExecPlan(packPath, runDir, `${BATCH}-${vendor}`);
    } catch (error) {
      console.error(`[v2] ${vendor} exec-plan spawn failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await verifyAndCleanup(vendor, packPath, runDir, exitCode);
  }
}

await main();
