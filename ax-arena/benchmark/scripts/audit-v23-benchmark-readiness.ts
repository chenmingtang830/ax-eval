#!/usr/bin/env node
/** Fail closed on the exact vendor-first V2.3 execution matrix. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { checkApproval, loadPack } from "ax-eval";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const suitePath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/vendor-experience-suite.yaml");
const reviewPath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/freeze-review.json");
const approvalPath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/freeze-approval.json");
const planPath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/execution-plan.json");
const packReviewPath = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2-3/pack-review.json");
const outputPath = resolve(ROOT, process.env.DAEB_V23_READINESS_OUT ?? "ax-arena/benchmark/axarena-database/v2-3/benchmark-readiness.json");

type Cell = { cell_id: string; vendor: string; task_id: string; trial: number; status: "planned" | "structural-na"; command?: { script: string; env: Record<string, string> } };
type Plan = { suite: { sha256: string }; cells: Cell[] };
type Approval = { status?: string; reviewer?: string; approved_at?: string; suite_sha256?: string; review_sha256?: string };
const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const json = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;

function observationPath(cell: Cell): string | null {
  if (!cell.command) return null;
  if (cell.command.script === "run-v22-native-pilot.ts") {
    const observations = resolve(ROOT, cell.command.env.DAEB_V22_RUN_ROOT!, "observations.jsonl");
    if (!existsSync(observations)) return null;
    const found = readFileSync(observations, "utf8").split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line) as { vendor?: string; trial?: number })
      .some((row) => row.vendor === cell.vendor && row.trial === cell.trial);
    return found ? observations : null;
  }
  return resolve(ROOT, cell.command.env.DAEB_V23_RUN_ROOT!, "cells", cell.vendor, cell.task_id, "observation.json");
}

const suite = parseYaml(readFileSync(suitePath, "utf8")) as { status?: string; formal?: boolean };
const plan = json<Plan>(planPath);
const approval = json<Approval>(approvalPath);
const packReview = json<{ status?: string; packs?: Record<string, { pack: string }> }>(packReviewPath);
const suiteHash = digest(suitePath);
const reviewHash = digest(reviewPath);
const runnable = plan.cells.filter((cell) => cell.status === "planned");
const missing = runnable.filter((cell) => {
  const path = observationPath(cell);
  return !path || !existsSync(path);
});
const invalid = runnable.flatMap((cell) => {
  const path = observationPath(cell);
  if (!path || !existsSync(path) || path.endsWith("observations.jsonl")) return [];
  const status = json<{ status?: string }>(path).status;
  return status === "invalid-infra" || status === "invalid-route" ? [{ cell_id: cell.cell_id, status }] : [];
});
const unapprovedPacks = Object.entries(packReview.packs ?? {}).flatMap(([vendor, record]) => {
  const pack = resolve(ROOT, record.pack);
  const verdict = checkApproval(loadPack(pack), pack);
  return verdict.ok ? [] : [{ vendor, reason: verdict.reason }];
});
const blockers = [
  ...(suite.status !== "frozen" ? [{ code: "suite-not-frozen", detail: `suite status=${suite.status ?? "missing"}` }] : []),
  ...(plan.suite.sha256 !== suiteHash ? [{ code: "execution-plan-stale", detail: "plan does not bind current suite hash" }] : []),
  ...(approval.status !== "approved" || !approval.reviewer || !approval.approved_at ? [{ code: "freeze-approval-invalid", detail: "human approval lacks required state, reviewer, or timestamp" }] : []),
  ...(approval.suite_sha256 !== suiteHash ? [{ code: "approval-suite-hash-mismatch", detail: "approval does not bind current suite" }] : []),
  ...(approval.review_sha256 !== reviewHash ? [{ code: "approval-review-hash-mismatch", detail: "approval does not bind current review packet" }] : []),
  ...(packReview.status !== "reviewed-and-approved" ? [{ code: "pack-review-not-approved", detail: `pack review status=${packReview.status ?? "missing"}` }] : []),
  ...(unapprovedPacks.length ? [{ code: "unapproved-executable-packs", detail: `${unapprovedPacks.length} V2.3 packs lack a valid standard approval sidecar`, packs: unapprovedPacks }] : []),
  ...(missing.length ? [{ code: "missing-planned-observations", detail: `${missing.length}/${runnable.length} runnable cells have no terminal observation`, sample_cell_ids: missing.slice(0, 12).map((cell) => cell.cell_id) }] : []),
  ...(invalid.length ? [{ code: "invalid-observations", detail: `${invalid.length} terminal observations are invalid`, sample_cells: invalid.slice(0, 12) }] : []),
];
const report = {
  schema: "ax.daeb-v2-3-benchmark-readiness/v2",
  status: blockers.length ? "not-ready" : "ready-for-benchmark-of-record",
  formal: false,
  checked_at: new Date().toISOString(),
  bindings: { suite_sha256: suiteHash, review_sha256: reviewHash, plan_suite_sha256: plan.suite.sha256 },
  coverage: { total_cells: plan.cells.length, runnable_cells: runnable.length, structural_na_cells: plan.cells.length - runnable.length, observed_runnable_cells: runnable.length - missing.length },
  blockers,
};
mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ output_path: outputPath, status: report.status, blockers }, null, 2));
