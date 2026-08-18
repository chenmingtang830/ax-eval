#!/usr/bin/env node
/**
 * Reconcile immutable V2.4 atomic observations without rewriting raw cells.
 * In particular, a model-written invalid required JSON artifact is a task
 * failure, not an infrastructure exclusion. The reconciliation ledger records
 * every such change and leaves the original observation untouched.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const input = process.env.DAEB_V24_ATOMIC_ROOT?.trim();
if (!input) throw new Error("DAEB_V24_ATOMIC_ROOT is required");
const inputRoot = resolve(ROOT, input);
const replacementRoots = (process.env.DAEB_V24_ATOMIC_REPLACEMENT_ROOTS ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean).map((value) => resolve(ROOT, value));
const outputRoot = resolve(ROOT, process.env.DAEB_V24_ATOMIC_AUDIT_ROOT ?? `${inputRoot}-audit`);

type Status = "pass" | "fail" | "structural-na" | "invalid-infra" | "invalid-route";
type Observation = {
  vendor: string;
  task_id: string;
  status: Status;
  artifact_dir: string;
  error?: string;
  [key: string]: unknown;
};

function invocationExitedBeforeAction(row: Observation): boolean {
  const path = resolve(row.artifact_dir, `run-pi-medium-cli-${row.task_id}.invoke.json`);
  if (!existsSync(path)) return false;
  try {
    const invocation = JSON.parse(readFileSync(path, "utf8")) as {
      ok?: unknown;
      validity_status?: unknown;
      action_occurred?: unknown;
    };
    return invocation.ok === false
      && invocation.validity_status === "partial"
      && invocation.action_occurred === false;
  } catch {
    return false;
  }
}

function isInvalidJson(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return false;
  } catch {
    return true;
  }
}

function agentWroteInvalidRequiredArtifact(row: Observation): string | null {
  const names = [
    "run-pi-medium-cli-bootstrap.json",
    "run-pi-medium-cli-bootstrap.trace.json",
    `run-pi-medium-cli-${row.task_id}.json`,
    `run-pi-medium-cli-${row.task_id}.trace.json`,
  ];
  return names.find((name) => isInvalidJson(resolve(row.artifact_dir, name))) ?? null;
}

function readRows(root: string): Observation[] {
  const cells = resolve(root, "cells");
  return readdirSync(cells, { withFileTypes: true }).filter((vendor) => vendor.isDirectory())
  .flatMap((vendor) => readdirSync(resolve(cells, vendor.name), { withFileTypes: true })
    .filter((task) => task.isDirectory()).flatMap((task) => {
      const path = resolve(cells, vendor.name, task.name, "observation.json");
      return existsSync(path) ? [JSON.parse(readFileSync(path, "utf8")) as Observation] : [];
    }));
}

const reconciliations: Array<Record<string, unknown>> = [];
function reconcile(row: Observation): Observation {
  // Pi can acknowledge a request and then exit before emitting any agent
  // action. That is a harness/model-protocol incompatibility, not an outcome
  // attributable to the vendor. Preserve the raw fail and make the exclusion
  // explicit in the immutable final audit ledger.
  if (row.status === "fail" && invocationExitedBeforeAction(row)) {
    reconciliations.push({
      schema: "ax.daeb-v2-4-atomic-observation-reconciliation/v1",
      vendor: row.vendor,
      task_id: row.task_id,
      prior_status: row.status,
      final_status: "invalid-infra",
      reason: "harness-exited-before-agent-action",
      artifact_dir: row.artifact_dir,
    });
    return { ...row, status: "invalid-infra" as const };
  }
  if (row.status !== "invalid-infra") return row;
  const artifact = agentWroteInvalidRequiredArtifact(row);
  if (!artifact) return row;
  reconciliations.push({
    schema: "ax.daeb-v2-4-atomic-observation-reconciliation/v1",
    vendor: row.vendor,
    task_id: row.task_id,
    prior_status: row.status,
    final_status: "fail",
    reason: "agent-wrote-invalid-required-json-artifact",
    invalid_artifact: artifact,
    artifact_dir: row.artifact_dir,
  });
  return { ...row, status: "fail" as const };
}

const raw = readRows(inputRoot);
const primaryFinal = raw.map(reconcile);
const replacementLedger: Array<Record<string, unknown>> = [];
for (const replacementRoot of replacementRoots) {
  for (const replacement of readRows(replacementRoot)) {
    const index = primaryFinal.findIndex((row) => row.vendor === replacement.vendor && row.task_id === replacement.task_id);
    if (index < 0) throw new Error(`replacement has no primary cell: ${replacement.vendor}/${replacement.task_id}`);
    if (primaryFinal[index]!.status !== "invalid-infra") {
      throw new Error(`replacement is only allowed for an audited invalid-infra cell: ${replacement.vendor}/${replacement.task_id}`);
    }
    primaryFinal[index] = replacement;
    replacementLedger.push({
      schema: "ax.daeb-v2-4-atomic-replacement/v1",
      vendor: replacement.vendor,
      task_id: replacement.task_id,
      reason: "controller-pi-auto-retry-policy-defect-before-valid-single-attempt-run",
      primary_root: inputRoot,
      replacement_root: replacementRoot,
      replacement_artifact_dir: replacement.artifact_dir,
    });
  }
}
const final = primaryFinal.map(reconcile);
const statuses: Status[] = ["pass", "fail", "structural-na", "invalid-infra", "invalid-route"];
const summary = {
  schema: "ax.daeb-v2-4-atomic-final-audit/v1",
  formal: false,
  input_root: inputRoot,
  replacement_roots: replacementRoots,
  raw_observations_preserved: raw.length,
  replacements: replacementLedger.length,
  final_observations: final.length,
  reconciliations: reconciliations.length,
  status_counts: Object.fromEntries(statuses.map((status) => [status, final.filter((row) => row.status === status).length])),
  invalid_infra: final.filter((row) => row.status === "invalid-infra").length,
  invalid_route: final.filter((row) => row.status === "invalid-route").length,
  valid_outcome_cells: final.filter((row) => row.status === "pass" || row.status === "fail").length,
  decision: final.some((row) => row.status === "invalid-infra" || row.status === "invalid-route")
    ? "invalid-observations-retained" : "valid-outcomes-ready-for-vendor-summary",
};

mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
writeFileSync(resolve(outputRoot, "final-observations.jsonl"), final.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
writeFileSync(resolve(outputRoot, "reconciliation-ledger.jsonl"), reconciliations.map((row) => JSON.stringify(row)).join("\n") + (reconciliations.length ? "\n" : ""), { mode: 0o600 });
writeFileSync(resolve(outputRoot, "replacement-ledger.jsonl"), replacementLedger.map((row) => JSON.stringify(row)).join("\n") + (replacementLedger.length ? "\n" : ""), { mode: 0o600 });
writeFileSync(resolve(outputRoot, "final-atomic-audit.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ output_root: outputRoot, ...summary }, null, 2));
