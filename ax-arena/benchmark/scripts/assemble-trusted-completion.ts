import { resolve } from "node:path";
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
  repositoryRoot,
} from "./trusted-script-common.js";

const flags = parseFlags([
  "--batch-manifest",
  "--batch-plan",
  "--cell-result",
  "--configuration-source",
  "--configuration-sha256",
  "--run-root",
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
const resultPaths = flags.get("--cell-result") ?? [];
if (!resultPaths.length) throw new Error("trusted arena completion requires at least one --cell-result <path>");

const arenaRuntimeModule = new URL("../dist/index.js", import.meta.url).href;
const {
  ArenaBatchConfigurationSchema,
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
  resultPaths: resultPaths.map((path) => resolve(path)),
  canonicalPackPaths,
  now: new Date(),
});
process.stdout.write(`${JSON.stringify({
  batch_id: completion.batch_id,
  completed_cells: completion.cells.map((cell) => cell.key),
  completion_path: resolve(runRoot, "batch-completion.json"),
})}\n`);
