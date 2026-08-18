#!/usr/bin/env node
/** Create the exact-file human-review packet required before V2.3 pack approval. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { checkApproval, loadPack } from "ax-eval";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const suitePath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/vendor-experience-suite.yaml");
const packsRoot = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/packs");
const contractsRoot = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/contracts");
const outputPath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/pack-review.json");
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const repoPath = (path: string) => relative(ROOT, path).split(sep).join("/");
const suite = parseYaml(readFileSync(suitePath, "utf8")) as { status: string; vendors: string[] };
if (suite.status !== "frozen") throw new Error(`pack review requires frozen suite, got ${suite.status}`);
const packs = Object.fromEntries(suite.vendors.map((vendor) => {
  const pack = resolve(packsRoot, vendor, "pack.yaml");
  const approval = pack.replace(/\.yaml$/, ".approval.json");
  if (!existsSync(pack)) throw new Error(`missing derived pack ${pack}`);
  const verdict = checkApproval(loadPack(pack), pack);
  return [vendor, { pack: repoPath(pack), pack_sha256: hash(pack), approval: repoPath(approval), approved: verdict.ok, approval_reason: verdict.reason ?? null }];
}));
const contractManifestPath = resolve(contractsRoot, "native-contract-manifest.json");
if (!existsSync(contractManifestPath)) throw new Error(`missing V2.3 native contract manifest ${contractManifestPath}`);
const contractManifest = JSON.parse(readFileSync(contractManifestPath, "utf8")) as {
  contracts: Record<string, { contract: string; contract_sha256: string }>;
};
const native_contracts = Object.fromEntries(Object.entries(contractManifest.contracts).map(([name, contract]) => [name, {
  contract: contract.contract,
  contract_sha256: contract.contract_sha256,
  hash_matches: hash(resolve(ROOT, contract.contract)) === contract.contract_sha256,
}]));
const review = {
  schema: "ax.daeb-v2-3-pack-review/v1",
  status: "requires-human-review",
  suite: { path: repoPath(suitePath), sha256: hash(suitePath) },
  derived_pack_manifest: { path: repoPath(resolve(packsRoot, "derived-pack-manifest.json")), sha256: hash(resolve(packsRoot, "derived-pack-manifest.json")) },
  packs,
  native_contract_manifest: { path: repoPath(contractManifestPath), sha256: hash(contractManifestPath) },
  native_contracts,
  required_human_decisions: [
    "Confirm each exact derived pack contains only the frozen V2.3 atomic task subset.",
    "Confirm the independent oracle and cleanup contract for every admitted tuple.",
    "Confirm the provider-pinned J01 native contracts bind only to the V2.3 pack root.",
    "Approve the exact pack hashes; later edits require a new review and approval sidecar.",
  ],
};
writeFileSync(outputPath, JSON.stringify(review, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ output_path: outputPath, status: review.status, packs: Object.keys(packs) }, null, 2));
