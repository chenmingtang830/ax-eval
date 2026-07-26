import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBatchIdentity, writeBatchPlan } from "../controller/batch.js";
import { assertArenaOutputRoot, resolveSourceCommitSha } from "../controller/cell.js";
import { writeRuntimeReportingBundle } from "../controller/reporting.js";
import { buildArenaPublicationExport } from "../publication/export.js";
import { writeArenaCompetitiveReport } from "../publication/competitive.js";
import { buildArenaPublicationBundle } from "../publication/bundle.js";
import {
  ArenaBatchConfigurationSchema,
  ArenaBatchManifestSchema,
  ArenaVendorSchema,
} from "../controller/schemas.js";

export const RUNTIME_COMMANDS = [
  "plan",
  "execute",
  "aggregate",
  "competitive",
  "publication-bundle",
  "publish",
  "export-publication",
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
  if (command === "competitive") {
    return "usage: ax-arena benchmark competitive --from <sealed-publication-bundle> [--html out.html] [--generated-at <UTC ISO>]";
  }
  if (command === "publication-bundle") {
    return [
      "usage: ax-arena benchmark publication-bundle --run-root <completed-run-dir> --out <new-bundle-dir> [--benchmark-root <arena-daeb-root>] [--generated-at <exact UTC ISO>]",
      "  Legacy aliases also accept --run-dir, --suite, --vendors, and effort-profile selectors when they exactly match the immutable batch.",
    ].join("\n");
  }
  if (command === "publish") {
    return "usage: ax-arena benchmark publish --run-root <dir>\n  Publication remains fail-closed until trusted workflow activation.";
  }
  if (command === "export-publication") {
    return "usage: ax-arena benchmark export-publication --from <publication-bundle-dir> --out <dir> [--generated-at <UTC ISO>]";
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

function csvSet(value: string, flag: string): string[] {
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!values.length || new Set(values).size !== values.length) {
    throw new Error(`${flag} must contain unique comma-separated values`);
  }
  return values.sort();
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function resolveFromCanonicalCwd(cwd: string, input: string): string {
  const absolute = resolve(cwd, input);
  const suffix = [basename(absolute)];
  let existingParent = dirname(absolute);
  while (!existsSync(existingParent)) {
    const parent = dirname(existingParent);
    if (parent === existingParent) return absolute;
    suffix.unshift(basename(existingParent));
    existingParent = parent;
  }
  return resolve(realpathSync(existingParent), ...suffix);
}

function assertLegacyPublicationSelectors(
  values: Map<string, string[]>,
  runRoot: string,
  cwd: string,
): string | undefined {
  const suiteValue = one(values, "--suite");
  const vendorsValue = one(values, "--vendors");
  const effortProfilesValue = one(values, "--effort-profiles");
  const requiredEffortProfilesValue = one(values, "--required-effort-profiles");
  if (!suiteValue && !vendorsValue && !effortProfilesValue && !requiredEffortProfilesValue) return undefined;

  const batch = ArenaBatchManifestSchema.parse(
    readBoundedJson(resolve(runRoot, "batch.json"), "legacy publication batch manifest"),
  );
  if (vendorsValue && !sameValues(
    csvSet(vendorsValue, "--vendors"),
    batch.configuration.packs.map((pack) => pack.vendor),
  )) {
    throw new Error("--vendors must exactly match the immutable batch vendors");
  }
  const profiles = [...new Set(batch.configuration.cells.map((cell) => cell.profile))];
  for (const [flag, selected] of [
    ["--effort-profiles", effortProfilesValue],
    ["--required-effort-profiles", requiredEffortProfilesValue],
  ] as const) {
    if (selected && !sameValues(csvSet(selected, flag), profiles)) {
      throw new Error(`${flag} must exactly match the immutable batch profiles`);
    }
  }
  if (!suiteValue) return undefined;
  const suitePath = resolveFromCanonicalCwd(cwd, suiteValue);
  if (basename(suitePath) !== "suite.yaml"
    || basename(dirname(suitePath)) !== `v${batch.configuration.suite.version}`) {
    throw new Error("--suite must identify the immutable batch suite path");
  }
  return dirname(dirname(suitePath));
}

function readBoundedJson(path: string, label: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (stat.size > 16 * 1024 * 1024) throw new Error(`${label} exceeds the 16 MiB input limit`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function committedConfigurationSource(
  repositoryRoot: string,
  sourceSha: string,
  path: string,
): { path: string; file_hash: string; decoded: unknown } {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("batch configuration must be a regular file");
  if (stat.size > 16 * 1024 * 1024) throw new Error("batch configuration exceeds the 16 MiB input limit");
  const relativePath = relative(realpathSync(repositoryRoot), realpathSync(path));
  if (!relativePath || relativePath === ".." || relativePath.startsWith("../")
    || relativePath.startsWith("..\\") || isAbsolute(relativePath)) {
    throw new Error("batch configuration must be a committed file inside the source repository");
  }
  const bytes = readFileSync(path);
  const portablePath = relativePath.replaceAll("\\", "/");
  const committed = execFileSync("git", ["show", `${sourceSha}:${portablePath}`], {
    cwd: repositoryRoot,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024 + 1,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (!bytes.equals(committed)) {
    throw new Error("batch configuration bytes must match the immutable source commit");
  }
  return {
    path: portablePath,
    file_hash: createHash("sha256").update(bytes).digest("hex"),
    decoded: JSON.parse(bytes.toString("utf8")),
  };
}

function shippedBenchmarkRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(moduleDirectory, "../../daeb"),
    resolve(moduleDirectory, "../daeb"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("could not locate the shipped arena DAEB root; pass --benchmark-root explicitly");
  return found;
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
    const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const configurationSource = committedConfigurationSource(repositoryRoot, sourceSha, configurationPath);
    const configuration = ArenaBatchConfigurationSchema.parse(configurationSource.decoded);
    const manifest = resolveBatchIdentity(runRoot, sourceSha, new Date(), configuration, {
      path: configurationSource.path,
      file_hash: configurationSource.file_hash,
    });
    writeBatchPlan(runRoot, manifest);
    io.stdout([
      manifest.batch_id,
      resolve(runRoot, "batch.json"),
      resolve(runRoot, "batch-plan.json"),
      configurationSource.path,
      configurationSource.file_hash,
    ].join("\n"));
    return 0;
  }
  if (command === "export-publication") {
    assertOnly(values, ["--from", "--out", "--generated-at"]);
    const bundleDir = one(values, "--from", true)!;
    const outDir = one(values, "--out", true)!;
    const generatedAtValue = one(values, "--generated-at");
    const generatedAt = generatedAtValue === undefined ? new Date() : new Date(generatedAtValue);
    if (!Number.isFinite(generatedAt.getTime())
      || generatedAtValue !== undefined && generatedAt.toISOString() !== generatedAtValue) {
      throw new Error("--generated-at must be an exact UTC ISO timestamp");
    }
    assertArenaOutputRoot(cwd, resolve(cwd, outDir));
    const manifest = buildArenaPublicationExport({ root: cwd, bundleDir, outDir, generatedAt });
    io.stdout(`Saved axarena export → ${outDir}`);
    io.stdout(`Saved manifest → ${resolve(cwd, outDir, "manifest.json")}`);
    io.stdout(`${manifest.files.length} export file(s) for ${manifest.benchmark}.`);
    return 0;
  }
  if (command === "publication-bundle") {
    assertOnly(values, [
      "--run-root", "--run-dir", "--out", "--benchmark-root", "--generated-at",
      "--suite", "--vendors", "--effort-profiles", "--required-effort-profiles",
    ]);
    const runRootValue = one(values, "--run-root");
    const legacyRunDir = one(values, "--run-dir");
    if (runRootValue && legacyRunDir
      && resolveFromCanonicalCwd(cwd, runRootValue) !== resolveFromCanonicalCwd(cwd, legacyRunDir)) {
      throw new Error("--run-root and legacy --run-dir must identify the same completed batch");
    }
    const selectedRunRoot = runRootValue ?? legacyRunDir;
    if (!selectedRunRoot) throw new Error("missing required flag --run-root (or legacy --run-dir)");
    const runRoot = resolveFromCanonicalCwd(cwd, selectedRunRoot);
    const outDir = resolveFromCanonicalCwd(cwd, one(values, "--out", true)!);
    const benchmarkRootValue = one(values, "--benchmark-root");
    const legacySuiteRoot = assertLegacyPublicationSelectors(values, runRoot, cwd);
    if (benchmarkRootValue && legacySuiteRoot
      && resolveFromCanonicalCwd(cwd, benchmarkRootValue) !== resolve(legacySuiteRoot)) {
      throw new Error("--benchmark-root and legacy --suite must identify the same arena DAEB root");
    }
    const benchmarkRoot = benchmarkRootValue
      ? resolveFromCanonicalCwd(cwd, benchmarkRootValue)
      : legacySuiteRoot ?? shippedBenchmarkRoot();
    const generatedAtValue = one(values, "--generated-at");
    const generatedAt = generatedAtValue === undefined ? new Date() : new Date(generatedAtValue);
    if (!Number.isFinite(generatedAt.getTime())
      || generatedAtValue !== undefined && generatedAt.toISOString() !== generatedAtValue) {
      throw new Error("--generated-at must be an exact UTC ISO timestamp");
    }
    const manifest = buildArenaPublicationBundle({ runRoot, outDir, benchmarkRoot, generatedAt });
    io.stdout(`Saved arena publication bundle → ${outDir}`);
    io.stdout(`Saved manifest → ${resolve(outDir, "manifest.json")}`);
    io.stdout(`${manifest.vendors.length} vendor(s); ${manifest.publication_readiness}.`);
    return 0;
  }
  if (command === "competitive") {
    assertOnly(values, ["--from", "--html", "--generated-at"]);
    const bundleDir = one(values, "--from", true)!;
    const outPath = one(values, "--html") ?? "results/competitive.html";
    const generatedAtValue = one(values, "--generated-at");
    const generatedAt = generatedAtValue === undefined ? new Date() : new Date(generatedAtValue);
    if (!Number.isFinite(generatedAt.getTime())
      || generatedAtValue !== undefined && generatedAt.toISOString() !== generatedAtValue) {
      throw new Error("--generated-at must be an exact UTC ISO timestamp");
    }
    writeArenaCompetitiveReport({ root: cwd, bundleDir, outPath, generatedAt });
    io.stdout(`Saved competitive report → ${outPath}`);
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
