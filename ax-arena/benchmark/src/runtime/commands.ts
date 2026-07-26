import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveBatchIdentity } from "../controller/batch.js";
import { assertArenaOutputRoot, resolveSourceCommitSha } from "../controller/cell.js";
import { writeRuntimeReportingBundle } from "../controller/reporting.js";
import {
  ArenaBatchConfigurationSchema,
  ArenaBatchManifestSchema,
  ArenaVendorSchema,
} from "../controller/schemas.js";

export const RUNTIME_COMMANDS = [
  "plan",
  "execute",
  "aggregate",
  "publish",
  "daeb-low-pass",
  "daeb-production-rerun",
] as const;
export type RuntimeCommand = (typeof RUNTIME_COMMANDS)[number];
const RUNTIME_COMMAND_SET = new Set<string>(RUNTIME_COMMANDS);

export function isRuntimeCommand(value: string | undefined): value is RuntimeCommand {
  return value !== undefined && RUNTIME_COMMAND_SET.has(value);
}

export function runtimeCommandUsage(command: RuntimeCommand): string {
  if (command === "plan") {
    return "usage: ax-arena benchmark plan --configuration <batch-config.json> --run-root <dir> [--source-sha <sha>]";
  }
  if (command === "execute") {
    return "usage: ax-arena benchmark execute --run-root <dir>\n  Execution requires the trusted workflow OS sandbox.";
  }
  if (command === "aggregate") {
    return [
      "usage: ax-arena benchmark aggregate --run-root <dir> --pack <vendor=pack.yaml> [--pack ...]",
      "                                    [--generated-at <UTC ISO timestamp>] [--min-pass-rate <0..1>]",
    ].join("\n");
  }
  if (command === "publish") {
    return "usage: ax-arena benchmark publish --run-root <dir>\n  Publication remains fail-closed until trusted workflow activation.";
  }
  if (command === "daeb-low-pass") {
    return [
      "usage: ax-arena benchmark daeb-low-pass [--suite <suite.yaml>] [--vendor <slug> | --vendors <a,b,c>]",
      "                                          [--surface api|cli|all] [--run-dir <dir>]",
      "                                          [--codex-model <slug>] [--claude-model <slug>] [--skip-reset]",
      "                                          [--benchmark-root <dir>]",
    ].join("\n");
  }
  return [
    "usage: ax-arena benchmark daeb-production-rerun [--suite <suite.yaml>] [--vendor <slug> | --vendors <a,b,c>]",
    "                                                  [--surface api|cli|all] [--run-dir <dir>]",
    "                                                  [--trial-count 3] [--invoke-timeout seconds]",
    "                                                  [--first-action-timeout seconds] [--skip-archive] [--reclaim]",
    "                                                  [--benchmark-root <dir>]",
  ].join("\n");
}

export interface RuntimeCommandIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

function flagValues(argv: readonly string[]): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) throw new Error(`unexpected argument ${flag ?? ""}`);
    if (["--skip-reset", "--skip-archive", "--reclaim"].includes(flag)) {
      values.set(flag, [...(values.get(flag) ?? []), "true"]);
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`flag ${flag} requires a value`);
    values.set(flag, [...(values.get(flag) ?? []), value]);
  }
  return values;
}

function one(values: Map<string, string[]>, flag: string, required = false): string | undefined {
  const found = values.get(flag) ?? [];
  if (found.length > 1) throw new Error(`flag ${flag} may be passed only once`);
  if (required && !found[0]) throw new Error(`missing required flag ${flag}`);
  return found[0];
}

function assertOnly(values: Map<string, string[]>, allowed: readonly string[]): void {
  const unknown = [...values.keys()].filter((flag) => !allowed.includes(flag));
  if (unknown.length) throw new Error(`unknown flag ${unknown[0]}`);
}

function readBoundedJson(path: string, label: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (stat.size > 16 * 1024 * 1024) throw new Error(`${label} exceeds the 16 MiB input limit`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function failClosedExecution(command: RuntimeCommand, argv: readonly string[]): never {
  const values = flagValues(argv);
  if (command === "daeb-low-pass" || command === "daeb-production-rerun") {
    const surface = one(values, "--surface");
    if (surface && !["api", "cli", "all"].includes(surface)) {
      throw new Error(`DAEB/database v1 surface "${surface}" is out of scope; expected api, cli, or all`);
    }
    if (command === "daeb-production-rerun") {
      const codexModel = one(values, "--codex-model");
      const claudeModel = one(values, "--claude-model");
      if ((codexModel && codexModel !== "gpt-5.6-terra")
        || (claudeModel && claudeModel !== "claude-sonnet-5")) {
        throw new Error("production models are frozen to gpt-5.6-terra and claude-sonnet-5");
      }
      const trials = one(values, "--trial-count");
      if (trials && trials !== "3") throw new Error("production requires exactly 3 clean trials");
      if (values.has("--skip-reset")) throw new Error("--skip-reset is not allowed for production reruns");
    }
  }
  throw new Error(`${command} requires the trusted workflow OS sandbox and is unavailable from a direct CLI`);
}

export async function runRuntimeCommand(
  command: RuntimeCommand,
  argv: readonly string[],
  io: RuntimeCommandIo,
  cwd = process.cwd(),
): Promise<number> {
  if (command === "execute" || command === "publish"
    || command === "daeb-low-pass" || command === "daeb-production-rerun") {
    return failClosedExecution(command, argv);
  }
  const values = flagValues(argv);
  if (command === "plan") {
    assertOnly(values, ["--configuration", "--run-root", "--source-sha"]);
    const configurationPath = resolve(cwd, one(values, "--configuration", true)!);
    const runRoot = resolve(cwd, one(values, "--run-root", true)!);
    assertArenaOutputRoot(cwd, runRoot);
    const currentSourceSha = resolveSourceCommitSha(cwd);
    const requestedSourceSha = one(values, "--source-sha");
    if (requestedSourceSha && requestedSourceSha !== currentSourceSha) {
      throw new Error(`--source-sha ${requestedSourceSha} does not match checked-out HEAD ${currentSourceSha}`);
    }
    const sourceSha = requestedSourceSha ?? currentSourceSha;
    const configuration = ArenaBatchConfigurationSchema.parse(readBoundedJson(configurationPath, "batch configuration"));
    const manifest = resolveBatchIdentity(runRoot, sourceSha, new Date(), configuration);
    io.stdout(`${manifest.batch_id}\n${resolve(runRoot, "batch.json")}`);
    return 0;
  }
  assertOnly(values, ["--run-root", "--pack", "--generated-at", "--min-pass-rate"]);
  const runRoot = resolve(cwd, one(values, "--run-root", true)!);
  assertArenaOutputRoot(cwd, runRoot);
  const packPaths: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const entry of values.get("--pack") ?? []) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) throw new Error("--pack must use vendor=pack.yaml");
    const vendor = entry.slice(0, separator);
    if (!ArenaVendorSchema.safeParse(vendor).success) throw new Error(`invalid --pack vendor ${vendor}`);
    if (vendor in packPaths) throw new Error(`duplicate --pack vendor ${vendor}`);
    packPaths[vendor] = resolve(cwd, entry.slice(separator + 1));
  }
  if (!Object.keys(packPaths).length) throw new Error("aggregate requires at least one --pack vendor=pack.yaml");
  const generatedAt = one(values, "--generated-at");
  const now = generatedAt ? new Date(generatedAt) : new Date();
  if (!Number.isFinite(now.getTime()) || now.toISOString() !== generatedAt && generatedAt !== undefined) {
    throw new Error("--generated-at must be an exact UTC ISO timestamp");
  }
  const minPassRateValue = one(values, "--min-pass-rate");
  const minPassRate = minPassRateValue === undefined ? undefined : Number(minPassRateValue);
  const batch = ArenaBatchManifestSchema.parse(readBoundedJson(resolve(runRoot, "batch.json"), "batch manifest"));
  const suppliedVendors = Object.keys(packPaths).sort();
  const configuredVendors = batch.configuration.packs.map((pack) => pack.vendor).sort();
  if (suppliedVendors.length !== configuredVendors.length
    || suppliedVendors.some((vendor, index) => vendor !== configuredVendors[index])) {
    throw new Error(`--pack vendors must exactly match the batch (${configuredVendors.join(", ")})`);
  }
  const report = writeRuntimeReportingBundle({
    runRoot,
    batch,
    packPaths,
    now,
    ...(minPassRate === undefined ? {} : { minPassRate }),
  });
  io.stdout(resolve(runRoot, "runtime-reporting.json"));
  io.stdout(`${report.surface_reports.length} surface report(s), ${report.aggregates.length} aggregate(s)`);
  return 0;
}
