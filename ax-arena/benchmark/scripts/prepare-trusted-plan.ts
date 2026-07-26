import { createHash } from "node:crypto";
import { appendFileSync, lstatSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  assertNoSymlinkChain,
  assertCommittedFile,
  assertSourceHead,
  isInside,
  oneFlag,
  parseFlags,
  repositoryRoot,
  requiredEnvironment,
} from "./trusted-script-common.js";
import { readTrustedRuntime } from "./lib/trusted-runtime.mjs";

if (process.env.GITHUB_ACTIONS !== "true" || process.env.AX_ARENA_TRUSTED_PLAN !== "true") {
  throw new Error("trusted arena planner is restricted to the credential-free GitHub Actions plan job");
}
const flags = parseFlags(["--configuration", "--run-root", "--source-sha"]);
const root = repositoryRoot();
process.chdir(root);
const sourceSha = oneFlag(flags, "--source-sha");
assertSourceHead(root, sourceSha);
const runtime = readTrustedRuntime(root);
const arenaRuntimeModule = new URL("../dist/index.js", import.meta.url).href;
const {
  ArenaBatchConfigurationSchema,
  buildTrustedWorkflowDispatch,
  resolveBatchIdentity,
  writeBatchPlan,
} = await import(arenaRuntimeModule) as typeof import("../src/index.js");
const configurationPath = resolve(oneFlag(flags, "--configuration"));
const daebRoot = resolve(root, "ax-arena", "benchmark", "daeb");
if (!isInside(daebRoot, configurationPath)) {
  throw new Error("trusted arena configuration must live under the canonical DAEB root");
}
assertNoSymlinkChain(root, configurationPath, "trusted arena configuration");
const runRoot = resolve(oneFlag(flags, "--run-root"));
const expectedRunRoot = resolve(
  root,
  "results",
  "runs",
  `trusted-${requiredEnvironment("GITHUB_RUN_ID")}-${requiredEnvironment("GITHUB_RUN_ATTEMPT")}`,
);
if (runRoot !== expectedRunRoot) throw new Error(`trusted arena run root must be ${expectedRunRoot}`);
assertNoSymlinkChain(root, runRoot, "trusted arena run root");

const configurationBytes = assertCommittedFile(root, sourceSha, configurationPath, "trusted arena configuration");
const configuration = ArenaBatchConfigurationSchema.parse(JSON.parse(configurationBytes.toString("utf8")));
const configurationSource = {
  path: relative(root, configurationPath).replaceAll("\\", "/"),
  file_hash: createHash("sha256").update(configurationBytes).digest("hex"),
};
const batch = resolveBatchIdentity(runRoot, sourceSha, new Date(), configuration, configurationSource);
const plan = writeBatchPlan(runRoot, batch);
const sandbox = batch.configuration.sandbox;
const harnesses = new Map(batch.configuration.harnesses.map((pin) => [pin.harness, pin]));
if (!sandbox
  || sandbox.runtime_lock_sha256 !== runtime.sha256
  || sandbox.executable !== runtime.lock.bubblewrap.executable_path
  || sandbox.executable_sha256 !== runtime.lock.bubblewrap.executable_sha256
  || harnesses.get("codex")?.version_semver !== runtime.lock.harnesses.codex.version
  || harnesses.get("codex")?.version_raw !== runtime.lock.harnesses.codex.version_output
  || harnesses.get("claude-code")?.version_semver !== runtime.lock.harnesses.claude_code.version
  || harnesses.get("claude-code")?.version_raw !== runtime.lock.harnesses.claude_code.version_output
  || (batch.configuration.turso_cli
    && (batch.configuration.turso_cli.version !== runtime.lock.turso_cli.version_output
      || batch.configuration.turso_cli.sha256 !== runtime.lock.turso_cli.executable_sha256))) {
  throw new Error("trusted arena plan does not match the exact reviewed runtime lock");
}
const dispatch = buildTrustedWorkflowDispatch(batch, plan);
const markerPath = resolve(runRoot, "transfer-root.marker");
writeFileSync(markerPath, `${JSON.stringify({
  schema: "ax.arena-transfer-root/v1",
  batch_id: dispatch.batch_id,
  configuration_sha256: dispatch.configuration_sha256,
})}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });

const relativeRunRoot = relative(root, runRoot).replaceAll("\\", "/");
if (!relativeRunRoot || isAbsolute(relativeRunRoot) || relativeRunRoot.startsWith("../")) {
  throw new Error("trusted arena run root must remain repository-relative");
}
const outputPath = requiredEnvironment("GITHUB_OUTPUT");
const outputStat = lstatSync(outputPath);
if (!outputStat.isFile() || outputStat.isSymbolicLink()) throw new Error("GITHUB_OUTPUT must be a regular file");
const outputs: Record<string, string> = {
  batch_id: dispatch.batch_id,
  run_root: relativeRunRoot,
  configuration_source: dispatch.configuration_source,
  configuration_sha256: dispatch.configuration_sha256,
  matrix: JSON.stringify(dispatch.matrix),
};
for (const [name, value] of Object.entries(outputs)) {
  if (value.includes("\n") || value.includes("\r")) throw new Error(`trusted planner output ${name} is not single-line`);
  appendFileSync(outputPath, `${name}=${value}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify({ batch_id: dispatch.batch_id, cells: dispatch.matrix.include.length })}\n`);
