#!/usr/bin/env node
/** Derive V2.3 J01 contracts that bind to the frozen V2.3 pack root. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import { V22NativeJourneySchema } from "../src/runtime/v22-native-journey.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const sourceRoot = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-2");
const outputRoot = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/contracts");
const suitePath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/vendor-experience-suite.yaml");
const sources = [
  ["gemini-3.7-flash.yaml", resolve(sourceRoot, "native-journey.yaml")],
  ["qwen-3.8-27b.yaml", resolve(sourceRoot, "contracts/qwen-3.8-27b.yaml")],
  ["kimi-k3.yaml", resolve(sourceRoot, "contracts/kimi-k3.yaml")],
] as const;
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const repoPath = (path: string) => relative(ROOT, path).split(sep).join("/");

const suiteHash = sha256(readFileSync(suitePath));
const manifest: Record<string, unknown> = {
  schema: "ax.daeb-v2-3-native-contract-manifest/v1",
  suite: { path: repoPath(suitePath), sha256: suiteHash },
  contracts: {},
};
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
for (const [name, sourcePath] of sources) {
  const sourceBytes = readFileSync(sourcePath);
  const contract = parse(sourceBytes.toString("utf8")) as Record<string, unknown> & { vendors: Record<string, Record<string, unknown>> };
  for (const [vendor, config] of Object.entries(contract.vendors)) {
    config.base_pack = `ax-arena/benchmark/axarena-database/v2-3/packs/${vendor}/pack.yaml`;
  }
  contract.name = "DAEB-V2.3-NATIVE-JOURNEY";
  contract.version = "2.3-frozen";
  const destination = resolve(outputRoot, name);
  writeFileSync(destination, stringify(contract), { mode: 0o600 });
  V22NativeJourneySchema.parse(parse(readFileSync(destination, "utf8")));
  (manifest.contracts as Record<string, unknown>)[name] = {
    source: repoPath(sourcePath),
    source_sha256: sha256(sourceBytes),
    contract: repoPath(destination),
    contract_sha256: sha256(readFileSync(destination)),
  };
}
writeFileSync(resolve(outputRoot, "native-contract-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ output_root: outputRoot, suite_sha256: suiteHash, contracts: sources.map(([name]) => name) }, null, 2));
