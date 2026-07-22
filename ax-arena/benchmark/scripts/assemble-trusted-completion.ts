import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import {
  assertCanonicalRunArtifact,
  assertCommittedConfigurationSource,
  assertCommittedFile,
  assertExpectedConfigurationSource,
  assertNoSymlinkChain,
  assertSourceHead,
  isInside,
  oneFlag,
  parseFlags,
  readPinned,
  repositoryRoot,
} from "./trusted-script-common.js";
import { readTrustedRuntime } from "./lib/trusted-runtime.mjs";

function writeExclusive(path: string, bytes: Buffer): void {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o444,
  );
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function regularTreeFiles(root: string, current = root, files: string[] = []): string[] {
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(current, entry.name);
    const stat = lstatSync(path);
    if (entry.isSymbolicLink() || stat.isSymbolicLink()) throw new Error("trusted cell transfer tree cannot contain symlinks");
    if (entry.isDirectory() && stat.isDirectory()) regularTreeFiles(root, path, files);
    else if (entry.isFile() && stat.isFile() && stat.nlink === 1) files.push(relative(root, path).replaceAll("\\", "/"));
    else throw new Error("trusted cell transfer tree contains an unsupported entry");
  }
  return files;
}

const flags = parseFlags([
  "--batch-manifest",
  "--batch-plan",
  "--cell-result",
  "--cell-results-root",
  "--configuration-source",
  "--configuration-sha256",
  "--run-root",
  "--runtime-manifests-root",
]);
const root = repositoryRoot();
process.chdir(root);
const runRoot = resolve(oneFlag(flags, "--run-root"));
if (!isInside(resolve(root, "results", "runs"), runRoot)) {
  throw new Error("trusted arena run root must live under results/runs");
}
assertNoSymlinkChain(root, runRoot, "trusted arena run root");
assertCanonicalRunArtifact(runRoot, oneFlag(flags, "--batch-manifest"), "batch.json", "batch manifest");
assertCanonicalRunArtifact(runRoot, oneFlag(flags, "--batch-plan"), "batch-plan.json", "batch plan");
const explicitResultPaths = flags.get("--cell-result") ?? [];
const cellResultsRoots = flags.get("--cell-results-root") ?? [];
if (Boolean(explicitResultPaths.length) === Boolean(cellResultsRoots.length)
  || cellResultsRoots.length > 1) {
  throw new Error("trusted arena completion requires repeated --cell-result paths or exactly one --cell-results-root");
}

const arenaRuntimeModule = new URL("../dist/index.js", import.meta.url).href;
const {
  ArenaBatchConfigurationSchema,
  ArenaCellResultSchema,
  arenaCellResultPath,
  arenaBatchConfigurationHash,
  loadBatchManifest,
  loadBatchPlan,
  writeBatchCompletionFromResults,
} = await import(arenaRuntimeModule) as typeof import("../src/index.js");
const batch = loadBatchManifest(runRoot);
assertSourceHead(root, batch.source_commit_sha);
assertExpectedConfigurationSource(
  batch.configuration_source,
  oneFlag(flags, "--configuration-source"),
  oneFlag(flags, "--configuration-sha256"),
);
const configurationBytes = assertCommittedConfigurationSource(root, batch.source_commit_sha, batch.configuration_source);
const committedConfiguration = ArenaBatchConfigurationSchema.parse(JSON.parse(configurationBytes.toString("utf8")));
if (arenaBatchConfigurationHash(committedConfiguration) !== batch.configuration_hash) {
  throw new Error("trusted arena batch configuration drifted from its committed source");
}
const plan = loadBatchPlan(runRoot, batch);
const runtime = readTrustedRuntime(root);
const runtimeManifestsRoot = resolve(oneFlag(flags, "--runtime-manifests-root"));
if (!isInside(runRoot, runtimeManifestsRoot)
  || runtimeManifestsRoot !== resolve(runRoot, "runtime-manifests")) {
  throw new Error("trusted arena runtime manifests must use the canonical run-root directory");
}
const manifestsRootStat = lstatSync(runtimeManifestsRoot);
if (!manifestsRootStat.isDirectory() || manifestsRootStat.isSymbolicLink()) {
  throw new Error("trusted arena runtime manifests root must be a regular directory");
}
const expectedRuntimeManifestNames = plan.cells.map((cell) =>
  `runtime-manifest-${cell.vendor}-${cell.surface}-${cell.harness}-trial-${cell.trial}.json`).sort();
const actualRuntimeManifestNames = readdirSync(runtimeManifestsRoot).sort();
if (JSON.stringify(actualRuntimeManifestNames) !== JSON.stringify(expectedRuntimeManifestNames)) {
  throw new Error("trusted arena runtime manifest set does not exactly match the immutable cell plan");
}
let runtimeManifestBytes: Buffer | undefined;
for (const name of expectedRuntimeManifestNames) {
  const bytes = readPinned(resolve(runtimeManifestsRoot, name), `trusted cell runtime manifest ${name}`);
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`trusted cell runtime manifest ${name} must be valid JSON`);
  }
  if (!bytes.equals(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
    || manifest.schema !== "ax.arena-trusted-runtime-manifest/v1"
    || manifest.platform !== "linux/amd64"
    || manifest.runtime_lock_path !== "ax-arena/benchmark/trusted-runtime/runtime-lock.json"
    || manifest.runtime_lock_sha256 !== runtime.sha256
    || manifest.sysroot !== "/opt/ax-arena-runtime/rootfs"
    || JSON.stringify(manifest.container) !== JSON.stringify(runtime.lock.container)
    || typeof manifest.node_executable_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.node_executable_sha256)
    || typeof manifest.tools_tree_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.tools_tree_sha256)
    || !Array.isArray(manifest.entries)) {
    throw new Error(`trusted cell runtime manifest ${name} does not match the immutable runtime lock`);
  }
  if (runtimeManifestBytes && !runtimeManifestBytes.equals(bytes)) {
    throw new Error("trusted arena cells did not use one byte-identical pinned runtime manifest");
  }
  runtimeManifestBytes = bytes;
}
if (!runtimeManifestBytes) throw new Error("trusted arena completion requires runtime manifest evidence");
const runtimeManifestSha256 = createHash("sha256").update(runtimeManifestBytes).digest("hex");
const canonicalRuntimeManifestPath = resolve(runRoot, "runtime-manifest.json");
writeExclusive(canonicalRuntimeManifestPath, runtimeManifestBytes);
writeExclusive(
  resolve(runRoot, "configuration.json"),
  Buffer.from(`${JSON.stringify(committedConfiguration, null, 2)}\n`),
);
const transfersRoot = resolve(runRoot, "transfers");
const transfersRootStat = lstatSync(transfersRoot);
if (!transfersRootStat.isDirectory() || transfersRootStat.isSymbolicLink()) {
  throw new Error("trusted arena cell transfers root must be a regular directory");
}
const transferFileNames = [
  "transfer-manifest.json",
  "cell-result.json",
  "record.normalized.json",
  "cleanup.json",
  "artifact-invoke_metadata.bin",
  "artifact-results.bin",
  "artifact-trace.bin",
  "artifact-transcript.bin",
] as const;
const expectedTransferFiles = plan.cells.flatMap((cell) =>
  transferFileNames.map((name) => `${cell.key}/${name}`)).sort();
if (JSON.stringify(regularTreeFiles(transfersRoot).sort()) !== JSON.stringify(expectedTransferFiles)) {
  throw new Error("trusted arena cell transfer set does not exactly match the immutable plan");
}
for (const cell of plan.cells) {
  const transferRoot = resolve(transfersRoot, ...cell.key.split("/"));
  const manifestBytes = readPinned(resolve(transferRoot, "transfer-manifest.json"), `trusted ${cell.key} transfer manifest`);
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(manifestBytes.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new Error(`trusted ${cell.key} transfer manifest must be valid JSON`);
  }
  if (!manifestBytes.equals(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
    || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify([
      "batch_id", "cell_key", "files", "runtime_manifest_sha256", "schema",
    ])
    || manifest.schema !== "ax.arena-cell-transfer/v1"
    || manifest.batch_id !== batch.batch_id
    || manifest.cell_key !== cell.key
    || manifest.runtime_manifest_sha256 !== runtimeManifestSha256
    || !Array.isArray(manifest.files) || manifest.files.length !== 7) {
    throw new Error(`trusted ${cell.key} transfer manifest does not match the immutable plan and runtime`);
  }
  const transferEntries = manifest.files.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`trusted ${cell.key} transfer entry ${index + 1} is invalid`);
    }
    const entry = value as Record<string, unknown>;
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["name", "original_path", "sha256", "transfer_path"])
      || typeof entry.name !== "string" || typeof entry.original_path !== "string"
      || typeof entry.transfer_path !== "string" || !/^[a-f0-9]{64}$/.test(String(entry.sha256))) {
      throw new Error(`trusted ${cell.key} transfer entry ${index + 1} is invalid`);
    }
    const transferPath = resolve(transferRoot, entry.transfer_path);
    if (!isInside(transferRoot, transferPath) || relative(transferRoot, transferPath).includes("/")) {
      throw new Error(`trusted ${cell.key} ${entry.name} transfer path is not a direct child`);
    }
    const bytes = readPinned(transferPath, `trusted ${cell.key} ${entry.name} transfer`);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error(`trusted ${cell.key} ${entry.name} transfer hash drifted`);
    }
    return { ...entry, bytes } as {
      name: string;
      original_path: string;
      transfer_path: string;
      sha256: string;
      bytes: Buffer;
    };
  });
  const resultEntry = transferEntries.find((entry) => entry.name === "cell_result");
  if (!resultEntry) throw new Error(`trusted ${cell.key} transfer omitted its cell result`);
  let result;
  try {
    result = ArenaCellResultSchema.parse(JSON.parse(resultEntry.bytes.toString("utf8")));
  } catch {
    throw new Error(`trusted ${cell.key} transferred an invalid cell result`);
  }
  if (!resultEntry.bytes.equals(Buffer.from(`${JSON.stringify(result, null, 2)}\n`))
    || result.cell_key !== cell.key || result.runtime_manifest_sha256 !== runtimeManifestSha256) {
    throw new Error(`trusted ${cell.key} cell result does not match its transfer and runtime`);
  }
  const expectedEntries = [
    { name: "cell_result", transfer_path: "cell-result.json", original_path: relative(runRoot, arenaCellResultPath(runRoot, cell)).replaceAll("\\", "/") },
    { name: "record", transfer_path: "record.normalized.json", original_path: result.record.path, sha256: result.record.sha256 },
    { name: "cleanup", transfer_path: "cleanup.json", original_path: result.cleanup.path, sha256: result.cleanup.sha256 },
    ...result.artifacts.map((artifact) => ({
      name: artifact.name,
      transfer_path: `artifact-${artifact.name}.bin`,
      original_path: artifact.path,
      sha256: artifact.sha256,
    })),
  ];
  for (const expected of expectedEntries) {
    const transferred = transferEntries.find((entry) => entry.name === expected.name);
    if (!transferred || transferred.transfer_path !== expected.transfer_path
      || transferred.original_path !== expected.original_path
      || expected.sha256 !== undefined && transferred.sha256 !== expected.sha256) {
      throw new Error(`trusted ${cell.key} ${expected.name} transfer mapping drifted`);
    }
  }
  for (const entry of [...transferEntries.filter((item) => item.name !== "cell_result"), resultEntry]) {
    const destination = resolve(runRoot, entry.original_path);
    if (!isInside(runRoot, destination)) throw new Error(`trusted ${cell.key} ${entry.name} transfer escaped the run root`);
    assertNoSymlinkChain(root, destination, `trusted ${cell.key} ${entry.name} transfer destination`);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    assertNoSymlinkChain(root, destination, `trusted ${cell.key} ${entry.name} transfer destination`);
    writeExclusive(destination, entry.bytes);
  }
}
let resultPaths: readonly string[];
if (cellResultsRoots.length) {
  const cellResultsRoot = resolve(cellResultsRoots[0]!);
  if (cellResultsRoot !== resolve(runRoot, "cells")) {
    throw new Error("trusted arena cell-results root must be the canonical run cells directory");
  }
  resultPaths = plan.cells.map((descriptor) => arenaCellResultPath(runRoot, descriptor));
} else {
  resultPaths = explicitResultPaths.map((path) => resolve(path));
}
const vendors = [...new Set(plan.cells.map((descriptor) => descriptor.vendor))];
const canonicalPackPaths = Object.fromEntries(vendors.map((vendor) => {
  const path = resolve(root, "ax-arena", "benchmark", "daeb", "v1", "packs", vendor, "pack.yaml");
  assertCommittedFile(root, batch.source_commit_sha, path, `canonical ${vendor} pack`);
  return [vendor, path];
}));
const completion = writeBatchCompletionFromResults({
  runRoot,
  batch,
  plan,
  resultPaths,
  canonicalPackPaths,
  runtimeManifestSha256,
  now: new Date(),
});
process.stdout.write(`${JSON.stringify({
  batch_id: completion.batch_id,
  completed_cells: completion.cells.map((cell) => cell.key),
  completion_path: resolve(runRoot, "batch-completion.json"),
})}\n`);
