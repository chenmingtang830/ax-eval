#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import {
  defaultInvokePaths,
  detectInvokeHarness,
  loadPack,
  provisionHarnessForSurface,
  runInvokeHarness,
  startOpenRouterGateway,
  validateResolvedProvider,
  type OpenRouterRoutePolicy,
  type RunningOpenRouterGateway,
  type TargetPack,
} from "ax-eval";
import {
  V22NativeJourneySchema,
  V22_TASK_ID,
  analyzeV22Transcript,
  buildV22NativeJourneyPrompt,
  scoreV22Stages,
  type V22NativeJourney,
  type V22Vendor,
  type V22WorldState,
} from "../src/runtime/v22-native-journey.js";
import { createMacOsWorkspaceWriteSandbox } from "../src/runtime/macos-workspace-sandbox.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
loadDotenv({ path: resolve(ROOT, ".env") });
const CONTRACT_PATH = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-2/native-journey.yaml");
const RUN_ROOT = resolve(
  ROOT,
  process.env.DAEB_V22_RUN_ROOT
    ?? `results/v22-native-pilot-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);
const VENDOR_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.DAEB_V22_VENDOR_CONCURRENCY ?? "2", 10) || 2,
);

type CellStatus = "pass" | "fail" | "invalid-infra" | "invalid-route";

type V22Gateway = RunningOpenRouterGateway & {
  baseUrl: string;
  policy: OpenRouterRoutePolicy;
};

async function startCellGateway(
  contract: V22NativeJourney,
  apiKey: string,
  ledgerPath: string,
): Promise<V22Gateway> {
  const policy: OpenRouterRoutePolicy = {
    model: contract.model,
    canonical_model: contract.model,
    provider: contract.provider,
    data_collection: "allow",
  };
  const running = await startOpenRouterGateway({ policy, apiKey, ledgerPath });
  return Object.assign(running, {
    baseUrl: `http://127.0.0.1:${running.port}/v1`,
    policy,
  });
}

interface CellObservation {
  schema: "ax.daeb-v2-2-native-observation/v1";
  vendor: string;
  display_name: string;
  model: string;
  provider: string;
  harness: "pi";
  trial: 1;
  namespace: string;
  status: CellStatus;
  stages: ReturnType<typeof scoreV22Stages>;
  discovery: ReturnType<typeof analyzeV22Transcript> | null;
  world_state: V22WorldState;
  invocation: {
    ok: boolean;
    validity_status: string | null;
    duration_ms: number | null;
    total_duration_ms: number | null;
    first_action_latency_ms: number | null;
    transcript_event_count: number | null;
  };
  route: {
    entries: number;
    upstream_errors: number;
    mismatch: boolean;
    reported_cost_usd: number | null;
  };
  cleanup: { attempted: boolean; success: boolean; detail: string };
  artifact_dir: string;
  error?: string;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

function readJsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function routeMismatch(entries: readonly Record<string, unknown>[], provider: string): boolean {
  return entries.some((entry) => entry.outcome === "invalid-route"
    || entry.outcome === "invalid-request"
    || (entry.outcome === "ok" && (entry.required_provider !== provider
    || !validateResolvedProvider({
      resolved_provider: typeof entry.resolved_provider === "string" ? entry.resolved_provider : null,
      generation_id: typeof entry.generation_id === "string" ? entry.generation_id : null,
      cost_usd: typeof entry.cost_usd === "number" ? entry.cost_usd : null,
      token_usage: entry.token_usage && typeof entry.token_usage === "object"
        ? entry.token_usage as Record<string, number>
        : null,
    }, provider))));
}

function routeCost(entries: readonly Record<string, unknown>[]): number | null {
  const values = entries.flatMap((entry) => typeof entry.cost_usd === "number" ? [entry.cost_usd] : []);
  return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function boundedError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "<redacted-connection>").slice(0, 800);
}

function commandResult(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(command, args, {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function metricSql(table: string, ns: string, dialect: "postgres" | "sqlite"): string {
  const qTable = quoteIdentifier(table);
  const alpha = quoteLiteral(`alpha_${ns}`);
  const recovered = quoteLiteral(`recovered_${ns}`);
  const primary = dialect === "postgres"
    ? `(SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema='public' AND table_name=${quoteLiteral(table)} AND constraint_type='PRIMARY KEY')`
    : `(SELECT COUNT(*) FROM pragma_table_info(${quoteLiteral(table)}) WHERE pk > 0)`;
  const unique = dialect === "postgres"
    ? `(SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema='public' AND table_name=${quoteLiteral(table)} AND constraint_type='UNIQUE')`
    : `(SELECT COUNT(*) FROM pragma_index_list(${quoteLiteral(table)}) WHERE "unique" = 1)`;
  return `SELECT 'AXV22|' || `
    + `(SELECT COUNT(*) FROM ${qTable}) || '|' || `
    + `(SELECT COUNT(*) FROM ${qTable} WHERE status='active') || '|' || `
    + `(SELECT COUNT(*) FROM ${qTable} WHERE marker=${alpha}) || '|' || `
    + `(SELECT COUNT(*) FROM ${qTable} WHERE marker=${alpha} AND recovery_note=${recovered}) || '|' || `
    + `${primary} || '|' || ${unique};`;
}

function parseWorldState(output: string): V22WorldState {
  const match = output.match(/AXV22\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)/);
  if (!match) {
    return {
      connection_ok: false,
      total_rows: null,
      active_rows: null,
      alpha_rows: null,
      recovered_rows: null,
      primary_constraints: null,
      unique_constraints: null,
      error: "controller read-back did not return the expected metric row",
    };
  }
  return {
    connection_ok: true,
    total_rows: Number(match[1]),
    active_rows: Number(match[2]),
    alpha_rows: Number(match[3]),
    recovered_rows: Number(match[4]),
    primary_constraints: Number(match[5]),
    unique_constraints: Number(match[6]),
  };
}

function verifyWorldState(vendorSlug: string, vendor: V22Vendor, table: string, ns: string): V22WorldState {
  if (vendorSlug === "turso") {
    const database = process.env.TURSO_SANDBOX_DATABASE?.trim();
    const token = process.env.TURSO_ORG_API_TOKEN?.trim();
    if (!database || !token) return { connection_ok: false, total_rows: null, active_rows: null, alpha_rows: null, recovered_rows: null, primary_constraints: null, unique_constraints: null, error: "missing Turso controller credential name" };
    const result = commandResult("turso", ["db", "shell", database, metricSql(table, ns, "sqlite")], {
      ...process.env,
      TURSO_API_TOKEN: token,
    });
    if (result.status !== 0) {
      return { connection_ok: false, total_rows: null, active_rows: null, alpha_rows: null, recovered_rows: null, primary_constraints: null, unique_constraints: null, error: boundedError(result.stderr || `turso exited ${result.status}`) };
    }
    return parseWorldState(result.stdout);
  }
  const envName = vendor.data_connection_env;
  const connection = envName ? process.env[envName]?.trim() : undefined;
  if (!envName || !connection) return { connection_ok: false, total_rows: null, active_rows: null, alpha_rows: null, recovered_rows: null, primary_constraints: null, unique_constraints: null, error: `missing controller connection env ${envName ?? "<none>"}` };
  const result = commandResult("psql", [connection, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", metricSql(table, ns, "postgres")], process.env);
  if (result.status !== 0) {
    return { connection_ok: false, total_rows: null, active_rows: null, alpha_rows: null, recovered_rows: null, primary_constraints: null, unique_constraints: null, error: boundedError(result.stderr || `psql exited ${result.status}`) };
  }
  return parseWorldState(result.stdout);
}

function cleanupWorldState(vendorSlug: string, vendor: V22Vendor, table: string): CellObservation["cleanup"] {
  const sql = `DROP TABLE IF EXISTS ${quoteIdentifier(table)};`;
  let result;
  if (vendorSlug === "turso") {
    const database = process.env.TURSO_SANDBOX_DATABASE?.trim();
    const token = process.env.TURSO_ORG_API_TOKEN?.trim();
    if (!database || !token) return { attempted: false, success: false, detail: "missing Turso cleanup credential name" };
    result = commandResult("turso", ["db", "shell", database, sql], { ...process.env, TURSO_API_TOKEN: token });
  } else {
    const envName = vendor.data_connection_env;
    const connection = envName ? process.env[envName]?.trim() : undefined;
    if (!connection) return { attempted: false, success: false, detail: `missing cleanup env ${envName ?? "<none>"}` };
    result = commandResult("psql", [connection, "-X", "-v", "ON_ERROR_STOP=1", "-c", sql], process.env);
  }
  return {
    attempted: true,
    success: result.status === 0,
    detail: result.status === 0 ? `dropped exact relation ${table}` : boundedError(result.stderr || `cleanup exited ${result.status}`),
  };
}

function runtimePack(base: TargetPack): TargetPack {
  const seed = base.tasks.find((task) => task.id === "db-T18-constraint-preservation") ?? base.tasks[0];
  if (!seed) throw new Error(`base pack ${base.name} has no task seed`);
  return {
    ...base,
    name: `${base.name}-v22-native-pilot`,
    version: "2.2-diagnostic",
    standard_set_version: "daeb-v2-2-native-journey-diagnostic",
    tasks: [{
      ...seed,
      id: V22_TASK_ID,
      title: "Native discovery, connection, operation, and recovery journey",
      prompt: "Controller-owned prompt is persisted separately.",
      oracles: [],
      allowed_surfaces: ["cli"],
    }],
  };
}

function childEnvironment(vendor: V22Vendor, provisioning: Record<string, string>, staleTarget: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const name of ["PATH", "SHELL", "TMPDIR", "LANG", "LC_ALL", "TERM", "USER", "LOGNAME", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) {
    const value = process.env[name];
    if (value) output[name] = value;
  }
  for (const name of [...vendor.credential_envs, ...vendor.scope_envs]) {
    const value = process.env[name];
    if (value) output[name] = value;
  }
  Object.assign(output, provisioning, {
    DAEB_NATIVE_STALE_TARGET: staleTarget,
    NO_COLOR: "1",
    CI: "1",
  });
  if (output.TURSO_ORG_API_TOKEN && !output.TURSO_API_TOKEN) output.TURSO_API_TOKEN = output.TURSO_ORG_API_TOKEN;
  return output;
}

async function executeVendor(
  contract: V22NativeJourney,
  vendorSlug: string,
  vendor: V22Vendor,
  openRouterKey: string,
): Promise<CellObservation> {
  const namespace = `v22_${vendorSlug}_${shortHash(`${Date.now()}:${vendorSlug}`)}`;
  const table = `axarena_native_journey_${namespace}`;
  const staleTarget = `axarena_missing_${namespace}`;
  const cellDir = resolve(RUN_ROOT, "cells", vendorSlug);
  mkdirSync(cellDir, { recursive: true, mode: 0o700 });
  const routeLedger = resolve(cellDir, "route-ledger.jsonl");
  const gateway = await startCellGateway(contract, openRouterKey, routeLedger);
  const paths = defaultInvokePaths(cellDir, "pi-v22-native", "pi");
  const sandbox = createMacOsWorkspaceWriteSandbox({ writableRoot: cellDir });
  const base = loadPack(resolve(ROOT, vendor.base_pack));
  const pack = runtimePack(base);
  writeFileSync(paths.promptPath, buildV22NativeJourneyPrompt({
    vendor,
    vendorSlug,
    namespace,
    resultsPath: paths.resultsPath,
    tracePath: paths.tracePath,
  }) + "\n", { mode: 0o600 });
  let invoke;
  let error: string | undefined;
  try {
    const detection = detectInvokeHarness("pi");
    if (!detection.ok) throw new Error(`Pi detection failed: ${detection.detail ?? detection.reason}`);
    const provisioning = await provisionHarnessForSurface({
      pack,
      harness: "pi",
      surface: "cli",
      paths,
      cwd: cellDir,
      env: process.env,
      allowDownloads: true,
      allowAmbientHarnessAuth: false,
      model: `openrouter/${contract.model}`,
      openrouterGateway: { baseUrl: gateway.baseUrl, policy: gateway.policy },
      command: detection.command,
      isolateWorkspace: true,
    });
    const piHome = typeof provisioning.meta?.pi_home === "string" ? provisioning.meta.pi_home : undefined;
    const childEnv = childEnvironment(vendor, {
      ...provisioning.env,
      ...(piHome ? { HOME: piHome, npm_config_cache: resolve(piHome, ".npm-cache") } : {}),
    }, staleTarget);
    const missing = [...vendor.credential_envs, ...vendor.scope_envs]
      .filter((name) => !process.env[name]?.trim());
    if (missing.length) {
      error = `missing required V2.2 env names: ${missing.join(", ")}`;
    } else {
      invoke = await runInvokeHarness({
        pack,
        harness: "pi",
        profile: "pilot",
        surface: "cli",
        ns: namespace,
        paths,
        cwd: cellDir,
        model: `openrouter/${contract.model}`,
        openrouterRoutePolicy: gateway.policy,
        openrouterGatewayUrl: gateway.baseUrl,
        effort: "high",
        timeoutMs: 20 * 60 * 1000,
        firstActionTimeoutMs: 3 * 60 * 1000,
        retries: 0,
        env: childEnv,
        replaceEnv: true,
        redactionValues: [...vendor.credential_envs, ...vendor.scope_envs]
          .flatMap((name) => process.env[name]?.trim() ? [process.env[name]!.trim()] : []),
        provisioning: provisioning.meta,
        harnessDetection: detection,
        runBatchId: `v22-native-${vendorSlug}-t1`,
        requireTrace: true,
        sandbox,
      });
    }
  } catch (caught) {
    error = boundedError(caught);
  } finally {
    await gateway.close();
  }
  const world = verifyWorldState(vendorSlug, vendor, table, namespace);
  let discovery: ReturnType<typeof analyzeV22Transcript> | null = null;
  if (existsSync(paths.transcriptPath)) {
    try {
      discovery = analyzeV22Transcript({
        transcript: readFileSync(paths.transcriptPath, "utf8"),
        vendor,
        staleTarget,
        outcomePassed: world.connection_ok,
      });
    } catch (caught) {
      error = error ?? boundedError(caught);
    }
  }
  const emptyDiscovery = {
    commands: 0,
    searches: 0,
    fetched_urls: 0,
    transcript_invalid_lines: 0,
    help_inspected: false,
    official_source_observed: false,
    native_entrypoint_observed: false,
    data_connection_env_observed: false,
    stale_target_attempted: false,
    discovery_mode: "unresolved" as const,
  };
  const stages = scoreV22Stages(discovery ?? emptyDiscovery, world);
  const cleanup = cleanupWorldState(vendorSlug, vendor, table);
  const routeEntries = readJsonl(routeLedger);
  const mismatch = routeEntries.length === 0 || routeMismatch(routeEntries, contract.provider);
  const upstreamErrors = routeEntries.filter((entry) => entry.outcome === "upstream-error").length;
  const infraInvalid = !invoke || !invoke.ok || invoke.validity_status !== "valid" || !cleanup.success;
  const status: CellStatus = mismatch
    ? "invalid-route"
    : infraInvalid ? "invalid-infra"
      : Object.values(stages).every(Boolean) ? "pass" : "fail";
  const observation: CellObservation = {
    schema: "ax.daeb-v2-2-native-observation/v1",
    vendor: vendorSlug,
    display_name: vendor.display_name,
    model: contract.model,
    provider: contract.provider,
    harness: "pi",
    trial: 1,
    namespace,
    status,
    stages,
    discovery,
    world_state: world,
    invocation: {
      ok: invoke?.ok ?? false,
      validity_status: invoke?.validity_status ?? null,
      duration_ms: invoke?.metrics?.duration_ms ?? invoke?.durationMs ?? null,
      total_duration_ms: invoke?.metrics?.total_duration_ms ?? invoke?.durationMs ?? null,
      first_action_latency_ms: invoke?.first_action_latency_ms ?? null,
      transcript_event_count: invoke?.transcript_event_count ?? null,
    },
    route: {
      entries: routeEntries.length,
      upstream_errors: upstreamErrors,
      mismatch,
      reported_cost_usd: routeCost(routeEntries),
    },
    cleanup,
    artifact_dir: cellDir,
    ...((error ?? world.error) ? { error: error ?? world.error } : {}),
  };
  writeFileSync(resolve(cellDir, "observation.json"), JSON.stringify(observation, null, 2) + "\n", { mode: 0o600 });
  return observation;
}

function summarize(contract: V22NativeJourney, observations: CellObservation[], plannedSessions: number) {
  const stageNames = ["discovery", "connect", "operate", "recovery"] as const;
  const stagePasses = Object.fromEntries(stageNames.map((stage) => [stage, observations.filter((row) => row.stages[stage]).length]));
  const nonUnanimousStages = stageNames.filter((stage) => stagePasses[stage] >= 2 && stagePasses[stage] <= observations.length - 1);
  const discoveryModes = new Set(observations.flatMap((row) => row.discovery ? [row.discovery.discovery_mode] : []));
  const toolCounts = observations.flatMap((row) => row.discovery ? [row.discovery.commands + row.discovery.searches + row.discovery.fetched_urls] : []);
  const latencies = observations.flatMap((row) => typeof row.invocation.duration_ms === "number" ? [row.invocation.duration_ms] : []);
  const differentiatingDimensions = [
    nonUnanimousStages.length > 0 ? "stage-outcomes" : null,
    discoveryModes.size >= 2 ? "discovery-mode" : null,
    toolCounts.length >= 2 && Math.max(...toolCounts) - Math.min(...toolCounts) >= 5 ? "tool-count" : null,
    latencies.length >= 2 && Math.max(...latencies) / Math.max(1, Math.min(...latencies)) >= 1.5 ? "latency" : null,
  ].filter((value): value is string => Boolean(value));
  const invalidInfra = observations.filter((row) => row.status === "invalid-infra").length;
  const invalidRoute = observations.filter((row) => row.status === "invalid-route").length;
  const complete = observations.length === plannedSessions;
  const gatePass = complete
    && invalidInfra === contract.acceptance.unexplained_invalid_infra
    && invalidRoute === contract.acceptance.route_mismatches
    && nonUnanimousStages.length > 0
    && differentiatingDimensions.length >= contract.acceptance.differentiating_dimensions_required;
  return {
    schema: "ax.daeb-v2-2-native-pilot-gate/v1",
    formal: false,
    complete,
    planned_sessions: plannedSessions,
    observed_sessions: observations.length,
    status_counts: Object.fromEntries(["pass", "fail", "invalid-infra", "invalid-route"].map((status) => [status, observations.filter((row) => row.status === status).length])),
    stage_passes: stagePasses,
    non_unanimous_stages: nonUnanimousStages,
    discovery_modes: Object.fromEntries([...discoveryModes].map((mode) => [mode, observations.filter((row) => row.discovery?.discovery_mode === mode).length])),
    differentiating_dimensions: differentiatingDimensions,
    invalid_infra: invalidInfra,
    invalid_route: invalidRoute,
    pilot_gate_pass: gatePass,
    decision: gatePass ? "signal-found-review-before-expansion" : "do-not-expand",
    observations,
  };
}

async function main(): Promise<void> {
  const contract = V22NativeJourneySchema.parse(parseYaml(readFileSync(CONTRACT_PATH, "utf8")));
  const selected = new Set((process.env.DAEB_V22_VENDORS ?? Object.keys(contract.vendors).join(","))
    .split(",").map((value) => value.trim()).filter(Boolean));
  const vendorEntries = Object.entries(contract.vendors).filter(([vendor]) => selected.has(vendor));
  if (existsSync(resolve(RUN_ROOT, "run-manifest.json"))) {
    throw new Error(`run root already contains a manifest; choose a new DAEB_V22_RUN_ROOT: ${RUN_ROOT}`);
  }
  mkdirSync(RUN_ROOT, { recursive: true, mode: 0o700 });
  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!openRouterKey) throw new Error("OPENROUTER_API_KEY is required");
  writeFileSync(resolve(RUN_ROOT, "run-manifest.json"), JSON.stringify({
    schema: "ax.daeb-v2-2-native-run/v1",
    status: "running",
    formal: false,
    contract: CONTRACT_PATH,
    model: contract.model,
    provider: contract.provider,
    harness: contract.harness,
    trial: contract.trial,
    vendors: vendorEntries.map(([vendor]) => vendor),
    planned_sessions: vendorEntries.length,
    vendor_concurrency: VENDOR_CONCURRENCY,
    started_at: new Date().toISOString(),
  }, null, 2) + "\n", { mode: 0o600 });
  const observations: CellObservation[] = [];
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < vendorEntries.length) {
      const index = cursor++;
      const [vendorSlug, vendor] = vendorEntries[index]!;
      console.log(`[v22-native] starting ${vendorSlug}`);
      try {
        const observation = await executeVendor(contract, vendorSlug, vendor, openRouterKey);
        observations.push(observation);
        console.log(`[v22-native] ${vendorSlug} ${observation.status} stages=${JSON.stringify(observation.stages)}`);
      } catch (error) {
        console.error(`[v22-native] ${vendorSlug} controller failure: ${boundedError(error)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(VENDOR_CONCURRENCY, vendorEntries.length) }, () => worker()));
  observations.sort((a, b) => a.vendor.localeCompare(b.vendor));
  const summary = summarize(contract, observations, vendorEntries.length);
  writeFileSync(resolve(RUN_ROOT, "observations.jsonl"), observations.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  writeFileSync(resolve(RUN_ROOT, "pilot-gate.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(resolve(RUN_ROOT, "run-manifest.json"), JSON.stringify({
    schema: "ax.daeb-v2-2-native-run/v1",
    status: "complete",
    formal: false,
    contract: CONTRACT_PATH,
    model: contract.model,
    provider: contract.provider,
    harness: contract.harness,
    trial: contract.trial,
    vendors: vendorEntries.map(([vendor]) => vendor),
    planned_sessions: vendorEntries.length,
    observed_sessions: observations.length,
    pilot_gate_pass: summary.pilot_gate_pass,
    decision: summary.decision,
    completed_at: new Date().toISOString(),
  }, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ run_root: RUN_ROOT, ...summary }, null, 2));
}

main().catch((error) => {
  console.error(boundedError(error));
  process.exitCode = 1;
});
