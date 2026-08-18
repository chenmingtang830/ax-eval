#!/usr/bin/env node
/** Build a hash-bound, human-review packet for the candidate V2.3 suite. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const suitePath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/vendor-experience-suite.yaml");
const ledgerPath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/contract-change-ledger.yaml");
const outputPath = resolve(ROOT, process.env.DAEB_V23_REVIEW_OUT
  ?? "ax-arena/benchmark/axarena-database/v2-3/freeze-review.json");
const vendors = ["cockroachdb", "insforge", "neon", "nile", "supabase", "turso"];

function sha256(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
const repoPath = (path: string) => relative(ROOT, path).split(sep).join("/");
const suite = parseYaml(readFileSync(suitePath, "utf8")) as {
  schema: string; status: string; tasks: Array<{ id: string; family: string; admitted_vendors: string[]; structural_na_vendors: string[] }>;
};
if (suite.status === "frozen" && outputPath === resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/freeze-review.json")) {
  throw new Error("refusing to overwrite the approved freeze review; choose DAEB_V23_REVIEW_OUT for a new candidate packet");
}
const packs = Object.fromEntries(vendors.map((vendor) => {
  const path = resolve(ROOT, `ax-arena/benchmark/axarena-database/v2-1/packs/${vendor}/pack.yaml`);
  return [vendor, { path: repoPath(path), sha256: sha256(path), human_approved: false }];
}));
const evidenceRoots = [
  "results/v23-gemini-3.7-flash-20260816-atomic-t1",
  "results/v23-gemini-3.7-flash-20260816-atomic-t1-rest",
  "results/v23-gemini-3.7-flash-20260816-predicate-r2",
  "results/v23-gemini-3.7-flash-20260816-t19-contract-r4",
  "results/v23-gemini-3.7-flash-20260816-t19-contract-r5",
];
const review = {
  schema: "ax.daeb-v2-3-freeze-review/v1",
  status: "requires-human-review",
  suite: { path: repoPath(suitePath), sha256: sha256(suitePath), schema: suite.schema, current_status: suite.status },
  contract_change_ledger: { path: repoPath(ledgerPath), sha256: sha256(ledgerPath) },
  packs,
  task_matrix: suite.tasks.map((task) => ({
    task_id: task.id, family: task.family, admitted_vendors: task.admitted_vendors,
    structural_na_vendors: task.structural_na_vendors,
  })),
  evidence_roots: evidenceRoots.map((path) => ({ path, exists: existsSync(resolve(ROOT, path)) })),
  required_human_decisions: [
    "Confirm each post-change task prompt and independent oracle is a fair, disclosed task contract.",
    "Confirm Turso T18/T19/T20 remain structural-na until an independent verifier is implemented.",
    "Approve the exact source-pack hashes shown here; any later pack edit invalidates this packet.",
  ],
  nonnegotiable_before_freeze: [
    "Two clean, post-change trials for every admitted vendor-task tuple.",
    "At least the declared model strata, each provider-pinned with fallback disabled.",
    "No unresolved task-quality, route, cleanup, or predicate-evidence blocker.",
  ],
};
mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
writeFileSync(outputPath, JSON.stringify(review, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ output_path: outputPath, status: review.status, suite_sha256: review.suite.sha256 }, null, 2));
