import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ArenaCellSpec } from "../src/index.js";
import { readTrustedRuntime } from "./lib/trusted-runtime.mjs";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`trusted arena cell requires ${name}`);
  return value;
}

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`trusted arena cell requires ${name} <value>`);
  return value;
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return [...actual].sort().join("\0") === [...expected].sort().join("\0");
}

function assertNoSymlinkChain(root: string, path: string, label: string): void {
  const rel = relative(root, path);
  if (!inside(root, path)) throw new Error(`${label} must resolve inside the repository`);
  let current = root;
  for (const segment of rel.split(/[\\/]/)) {
    current = resolve(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`${label} cannot traverse a symlink`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function assertCommittedFile(repositoryRoot: string, sourceSha: string, path: string, label: string): Buffer {
  assertNoSymlinkChain(repositoryRoot, path, label);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !inside(repositoryRoot, path)) {
    throw new Error(`${label} must be a committed single-linked file inside the repository`);
  }
  const bytes = readFileSync(path);
  const relativePath = relative(repositoryRoot, path).replaceAll("\\", "/");
  const committed = execFileSync("git", ["show", `${sourceSha}:${relativePath}`], {
    cwd: repositoryRoot,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!bytes.equals(committed)) throw new Error(`${label} bytes must match the immutable source commit`);
  return bytes;
}

if (process.env.GITHUB_ACTIONS !== "true" || process.env.AX_ARENA_TRUSTED_WORKFLOW !== "true") {
  throw new Error("trusted arena cell entrypoint is restricted to the reviewed GitHub Actions environment");
}
const repositoryRoot = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim());
process.chdir(repositoryRoot);
const sourceSha = required("AX_ARENA_SOURCE_SHA");
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (sourceSha !== head || !/^[a-f0-9]{40}$/.test(sourceSha)) {
  throw new Error("trusted arena source SHA must be the full checked-out commit ID");
}
const runtime = readTrustedRuntime(repositoryRoot);
if (process.version !== `v${runtime.lock.container.node_version}`) throw new Error("trusted arena Node version drifted");
process.env.PATH = "/opt/ax-arena-tools/turso/bin:/opt/ax-arena-tools/harness/node_modules/.bin:/opt/ax-arena-tools/node/bin:/usr/bin:/bin";
process.env.AX_EVAL_CODEX_BIN = runtime.lock.harnesses.codex.executable_path;
process.env.AX_EVAL_CLAUDE_BIN = runtime.lock.harnesses.claude_code.executable_path;

const { loadPack, loadSuite, packFileContentHash } = await import("ax-eval");
const {
  ArenaBatchConfigurationSchema,
  assertArenaOutputRoot,
  cellCredentialNames,
  cellResetCredentialNames,
  cellVerificationCredentialNames,
  createDatabaseRuntimeExtensionRegistry,
  executeArenaCell,
  resolveBatchIdentity,
  writeBatchCompletion,
} = await import("../dist/index.js");

const configurationPath = resolve(flag("--configuration"));
const configurationBytes = assertCommittedFile(repositoryRoot, sourceSha, configurationPath, "batch configuration");
const canonicalConfigurationRoot = resolve(repositoryRoot, "ax-arena", "benchmark", "daeb");
if (!inside(canonicalConfigurationRoot, configurationPath)) {
  throw new Error("trusted arena batch configuration must live under the canonical DAEB root");
}
const configuration = ArenaBatchConfigurationSchema.parse(JSON.parse(configurationBytes.toString("utf8")));
if (configuration.execution?.runtime_backend !== "pinned-oci"
  || configuration.execution?.trust_level !== "hosted-trusted"
  || !configuration.reset_required || !configuration.sandbox
  || configuration.sandbox.runtime_lock_sha256 !== runtime.sha256
  || configuration.sandbox.sysroot !== "/opt/ax-arena-runtime/rootfs"
  || configuration.sandbox.executable !== runtime.lock.bubblewrap.executable_path
  || configuration.sandbox.executable_sha256 !== runtime.lock.bubblewrap.executable_sha256) {
  throw new Error("trusted arena workflow requires the reviewed sandbox and confirmed post-verification cleanup");
}
const suitePath = resolve(repositoryRoot, "ax-arena", "benchmark", "daeb", "v1", "suite.yaml");
const suiteBytes = assertCommittedFile(repositoryRoot, sourceSha, suitePath, "canonical suite");
const suite = loadSuite(suitePath);
const suiteHash = createHash("sha256").update(suiteBytes).digest("hex");
if (suite.name !== configuration.suite.name || suite.version !== configuration.suite.version
  || suiteHash !== configuration.suite.file_hash) {
  throw new Error("trusted arena canonical suite identity must match the immutable batch configuration");
}

const expectedVendor = required("AX_ARENA_EXPECTED_VENDOR");
const expectedSurface = required("AX_ARENA_EXPECTED_SURFACE");
if (configuration.command !== "daeb-production-rerun"
  || configuration.cells.some((cell) => cell.vendor !== expectedVendor || cell.surface !== expectedSurface)) {
  throw new Error("trusted arena dispatch requires one production vendor/surface cohort per batch configuration");
}
const expectedHarnesses = {
  codex: runtime.lock.harnesses.codex,
  "claude-code": runtime.lock.harnesses.claude_code,
} as const;
for (const pin of configuration.harnesses) {
  const expected = expectedHarnesses[pin.harness];
  if (pin.version_semver !== expected.version || pin.version_raw !== expected.version_output) {
    throw new Error("trusted arena harness versions must match the reviewed runtime lock");
  }
}

const runRoot = resolve(flag("--run-root"));
const canonicalRunRoot = resolve(repositoryRoot, "results", "runs");
if (!inside(canonicalRunRoot, runRoot)) throw new Error("trusted arena run root must live under results/runs");
assertNoSymlinkChain(repositoryRoot, runRoot, "trusted arena run root");
assertArenaOutputRoot(repositoryRoot, runRoot);
const batch = resolveBatchIdentity(runRoot, sourceSha, new Date(), configuration);
const configuredPack = configuration.packs.find((pack) => pack.vendor === expectedVendor);
if (!configuredPack) throw new Error("trusted arena cell vendor is missing its configured pack");
const packPath = resolve(repositoryRoot, "ax-arena", "benchmark", "daeb", "v1", "packs", expectedVendor, "pack.yaml");
const pack = loadPack(packPath);
if (pack.name !== expectedVendor || pack.standard_set_version !== configuredPack.standard_set_version
  || packFileContentHash(packPath) !== configuredPack.file_hash) {
  throw new Error("trusted arena target and pack hash must match the immutable batch configuration");
}

const ambient = process.env as Readonly<Record<string, string | undefined>>;
const sandboxScopeNames = pack.sandbox_scope
  .filter((scope) => scope.required || Boolean(ambient[scope.env]?.trim()))
  .map((scope) => scope.env)
  .sort();
const executions: Awaited<ReturnType<typeof executeArenaCell>>[] = [];
for (const configuredCell of configuration.cells) {
  const hostCredentialNames = cellCredentialNames(pack, configuredCell.surface, configuredCell.harness, ambient);
  const verificationCredentialNames = cellVerificationCredentialNames(pack, ambient, configuredCell.surface);
  const resetCredentialNames = cellResetCredentialNames(pack, ambient);
  if (!sameNames(hostCredentialNames, configuredCell.host_credential_names)
    || !sameNames(verificationCredentialNames, configuredCell.verification_credential_names)
    || !sameNames(resetCredentialNames, configuredCell.reset_credential_names)
    || !sameNames(sandboxScopeNames, configuredCell.sandbox_scope_names)) {
    throw new Error(`trusted arena credential partitions must match configured cell ${configuredCell.key}`);
  }
  const credentialNames = [...new Set([
    ...hostCredentialNames,
    ...verificationCredentialNames,
    ...resetCredentialNames,
  ])];
  const credentials = Object.fromEntries(credentialNames.flatMap((name) => {
    const value = process.env[name];
    return value?.trim() ? [[name, value]] : [];
  }));
  const artifactDir = resolve(runRoot, "cells", ...configuredCell.key.split("/"));
  const spec: ArenaCellSpec = {
    cwd: repositoryRoot,
    artifactDir,
    recordPath: resolve(artifactDir, "record.normalized.json"),
    cleanupPath: resolve(artifactDir, "cleanup.json"),
    packPath,
    batchId: batch.batch_id,
    evaluationSetId: configuration.suite.name,
    targetId: configuredCell.vendor,
    surface: configuredCell.surface,
    harness: configuredCell.harness,
    profile: configuredCell.profile,
    model: configuredCell.model,
    effort: configuredCell.effort,
    trial: configuredCell.trial,
    sourceCommitSha: sourceSha,
    invokeTimeoutMs: configuration.invoke_timeout_seconds * 1_000,
    firstActionTimeoutMs: configuration.first_action_timeout_seconds * 1_000,
    invokeRetries: configuration.invoke_retries,
    skipReset: false,
  };
  const execution = await executeArenaCell(spec, {
    credentials,
    execution: configuration.execution,
    sandbox: configuration.sandbox,
    now: () => new Date(),
    async createRegistry() {
      const turso = configuration.turso_cli;
      return createDatabaseRuntimeExtensionRegistry(pack.name === "turso" && spec.surface === "cli" && turso ? {
        searchPath: resolve(runtime.lock.turso_cli.executable_path, ".."),
        trustedInstallRoot: turso.install_root,
        expectedVersion: turso.version,
        expectedSha256: turso.sha256,
      } : undefined);
    },
  });
  const harnessPin = configuration.harnesses.find((pin) => pin.harness === configuredCell.harness)!;
  if (execution.record.harness_version_semver !== harnessPin.version_semver
    || execution.record.harness_version_raw !== harnessPin.version_raw) {
    throw new Error(`trusted arena harness identity does not match configured cell ${configuredCell.key}`);
  }
  if (execution.record.status !== "completed" || execution.cleanup.status !== "confirmed") {
    throw new Error(`trusted arena cell ${configuredCell.key} did not complete with confirmed cleanup`);
  }
  executions.push(execution);
}
const completion = writeBatchCompletion(runRoot, batch, executions, new Date());
process.stdout.write(`${JSON.stringify({
  batch_id: batch.batch_id,
  completed_cells: completion.cells.map((cell) => cell.key),
  completion_path: resolve(runRoot, "batch-completion.json"),
})}\n`);
