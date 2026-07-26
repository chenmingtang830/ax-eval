import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { BubblewrapSandboxConfig } from "../src/index.js";
import {
  assertCanonicalRunArtifact,
  assertCommittedConfigurationSource,
  assertCommittedFile,
  assertExpectedConfigurationSource,
  assertNoSymlinkChain,
  assertSourceHead,
  assertTrustedRuntimeManifest,
  attestTrustedHarnessBinary,
  isInside,
  oneFlag,
  parseFlags,
  repositoryRoot,
  requiredEnvironment,
} from "./trusted-script-common.js";
import { readTrustedRuntime } from "./lib/trusted-runtime.mjs";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.AX_ARENA_TRUSTED_WORKFLOW !== "true") {
  throw new Error("trusted arena worker is restricted to the reviewed GitHub Actions environment");
}

const flags = parseFlags([
  "--batch-manifest",
  "--batch-plan",
  "--cell-key",
  "--configuration-source",
  "--configuration-sha256",
  "--run-root",
  "--runtime-manifest",
]);
const root = repositoryRoot();
process.chdir(root);
const sourceSha = requiredEnvironment("AX_ARENA_SOURCE_SHA");
assertSourceHead(root, sourceSha);
const runtime = readTrustedRuntime(root);
if (process.version !== `v${runtime.lock.container.node_version}`) {
  throw new Error("trusted arena worker Node version does not match the immutable runtime lock");
}
const runRoot = resolve(oneFlag(flags, "--run-root"));
if (!isInside(resolve(root, "results", "runs"), runRoot)) {
  throw new Error("trusted arena run root must live under results/runs");
}
assertNoSymlinkChain(root, runRoot, "trusted arena run root");
assertCanonicalRunArtifact(runRoot, oneFlag(flags, "--batch-manifest"), "batch.json", "batch manifest");
assertCanonicalRunArtifact(runRoot, oneFlag(flags, "--batch-plan"), "batch-plan.json", "batch plan");
const runtimeManifest = assertTrustedRuntimeManifest(
  runRoot,
  oneFlag(flags, "--runtime-manifest"),
  runtime,
);
process.env.PATH = runtimeManifest.trustedPath;
process.env.AX_EVAL_CODEX_BIN = runtime.lock.harnesses.codex.executable_path;
process.env.AX_EVAL_CLAUDE_BIN = runtime.lock.harnesses.claude_code.executable_path;

const { loadPack, loadSuite, packFileContentHash } = await import("ax-eval");
const arenaRuntimeModule = new URL("../dist/index.js", import.meta.url).href;
const {
  createDatabaseRuntimeExtensionRegistry,
  ArenaBatchConfigurationSchema,
  arenaBatchConfigurationHash,
  buildBubblewrapInvocation,
  executeArenaWorkerCell,
  loadBatchManifest,
  loadBatchPlan,
  selectArenaWorkerCell,
} = await import(arenaRuntimeModule) as typeof import("../src/index.js");
const batch = loadBatchManifest(runRoot);
if (batch.source_commit_sha !== sourceSha) throw new Error("trusted arena batch source SHA does not match the checkout");
assertExpectedConfigurationSource(
  batch.configuration_source,
  oneFlag(flags, "--configuration-source"),
  oneFlag(flags, "--configuration-sha256"),
);
const configurationBytes = assertCommittedConfigurationSource(root, sourceSha, batch.configuration_source);
const committedConfiguration = ArenaBatchConfigurationSchema.parse(JSON.parse(configurationBytes.toString("utf8")));
if (arenaBatchConfigurationHash(committedConfiguration) !== batch.configuration_hash) {
  throw new Error("trusted arena batch configuration drifted from its committed source");
}
const plan = loadBatchPlan(runRoot, batch);
const descriptor = selectArenaWorkerCell(plan, oneFlag(flags, "--cell-key"));

const suitePath = resolve(root, "ax-arena", "benchmark", "daeb", "v1", "suite.yaml");
const suiteBytes = assertCommittedFile(root, sourceSha, suitePath, "canonical suite");
const suite = loadSuite(suitePath);
if (suite.name !== batch.configuration.suite.name
  || suite.version !== batch.configuration.suite.version
  || createHash("sha256").update(suiteBytes).digest("hex") !== batch.configuration.suite.file_hash) {
  throw new Error("trusted arena canonical suite identity does not match the immutable batch");
}
const packPath = resolve(root, "ax-arena", "benchmark", "daeb", "v1", "packs", descriptor.vendor, "pack.yaml");
assertCommittedFile(root, sourceSha, packPath, "canonical pack");
const pack = loadPack(packPath);
if (pack.name !== descriptor.vendor
  || pack.standard_set_version !== descriptor.standard_set_version
  || packFileContentHash(packPath) !== descriptor.pack_file_hash) {
  throw new Error("trusted arena pack identity does not match the selected cell descriptor");
}

const harnessLock = descriptor.harness === "codex" ? runtime.lock.harnesses.codex : runtime.lock.harnesses.claude_code;
if (descriptor.harness_version_semver !== harnessLock.version
  || descriptor.harness_version_raw !== harnessLock.version_output) {
  throw new Error("trusted arena harness version does not match the selected cell descriptor");
}
const sandbox = descriptor.sandbox as BubblewrapSandboxConfig | undefined;
if (descriptor.execution.runtime_backend !== "pinned-oci" || descriptor.execution.trust_level !== "hosted-trusted"
  || !sandbox || sandbox.policy_version !== "ax.arena-bubblewrap/v2"
  || sandbox.runtime_lock_sha256 !== runtime.sha256
  || sandbox.sysroot !== "/opt/ax-arena-runtime/rootfs"
  || sandbox.executable !== runtime.lock.bubblewrap.executable_path
  || sandbox.executable_sha256 !== runtime.lock.bubblewrap.executable_sha256) {
  throw new Error("trusted arena Bubblewrap pin does not match the selected cell descriptor");
}
const harnessCommand = harnessLock.executable_path;
const harnessCommandEnvironment = descriptor.harness === "codex" ? "AX_EVAL_CODEX_BIN" : "AX_EVAL_CLAUDE_BIN";
if (resolve(requiredEnvironment(harnessCommandEnvironment)) !== harnessCommand) {
  throw new Error("trusted arena harness command does not match the immutable tool install");
}
const probeWorkspace = resolve(runRoot, "controller-probes", ...descriptor.key.split("/"));
mkdirSync(probeWorkspace, { recursive: true, mode: 0o700 });
assertNoSymlinkChain(root, probeWorkspace, "trusted harness probe workspace");
const probe = buildBubblewrapInvocation(sandbox, harnessCommand, ["--version"], probeWorkspace);
attestTrustedHarnessBinary({
  command: harnessCommand,
  trustedInstallRoot: "/opt/ax-arena-tools/harness",
  searchPath: runtimeManifest.trustedPath,
  expectedRaw: descriptor.harness_version_raw,
  expectedSemver: descriptor.harness_version_semver,
  probe: { command: probe.command, args: probe.args, cwd: probeWorkspace },
});

const selectedNames = new Set([
  ...descriptor.host_credential_names,
  ...descriptor.verification_credential_names,
  ...descriptor.reset_credential_names,
  ...descriptor.sandbox_scope_names,
]);
const batchCredentialNames = new Set(batch.configuration.packs.flatMap((configuredPack) => [
  ...configuredPack.host_credential_names,
  ...configuredPack.verification_credential_names,
  ...configuredPack.reset_credential_names,
  ...configuredPack.sandbox_scope_names,
]));
for (const name of batchCredentialNames) {
  if (!selectedNames.has(name) && process.env[name]?.trim()) {
    throw new Error(`trusted arena worker received out-of-scope batch credential ${name}`);
  }
}
const credentials = Object.fromEntries([...selectedNames].map((name) => [name, requiredEnvironment(name)]));
const execution = await executeArenaWorkerCell(batch, descriptor, runRoot, packPath, {
  credentials,
  execution: descriptor.execution,
  sandbox,
  now: () => new Date(),
  async createRegistry() {
    return createDatabaseRuntimeExtensionRegistry(descriptor.turso_cli ? {
      searchPath: runtimeManifest.trustedPath,
      trustedInstallRoot: descriptor.turso_cli.install_root,
      expectedVersion: descriptor.turso_cli.version,
      expectedSha256: descriptor.turso_cli.sha256,
    } : undefined);
  },
});
process.stdout.write(`${JSON.stringify({
  batch_id: batch.batch_id,
  cell_key: descriptor.key,
  cell_result_path: execution.resultPath,
})}\n`);
