#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  V22NativeJourneySchema,
  analyzeV22Transcript,
  scoreV22Stages,
} from "../src/runtime/v22-native-journey.js";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const primaryInput = process.env.DAEB_V22_PRIMARY_ROOT?.trim();
if (!primaryInput) throw new Error("DAEB_V22_PRIMARY_ROOT is required");
const primaryRoot = resolve(ROOT, primaryInput);
const replacementRoots = (process.env.DAEB_V22_REPLACEMENT_ROOTS ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean).map((value) => resolve(ROOT, value));
const outputRoot = resolve(ROOT, process.env.DAEB_V22_AUDIT_ROOT
  ?? `${primaryRoot}-audit`);
const contractPath = resolve(ROOT, process.env.DAEB_V22_CONTRACT
  ?? "ax-arena/benchmark/axarena-database/v2-2/native-journey.yaml");
const contract = V22NativeJourneySchema.parse(parseYaml(readFileSync(contractPath, "utf8")));
const primaryManifest = JSON.parse(readFileSync(resolve(primaryRoot, "run-manifest.json"), "utf8")) as {
  planned_sessions?: number;
};
const plannedSessions = primaryManifest.planned_sessions;
if (!Number.isSafeInteger(plannedSessions) || (plannedSessions ?? 0) <= 0) {
  throw new Error("primary run manifest has no positive planned_sessions");
}

type Observation = {
  vendor: string;
  model: string;
  provider: string;
  harness: string;
  trial: number;
  namespace: string;
  status: "pass" | "fail" | "invalid-infra" | "invalid-route";
  stages: Record<"discovery" | "connect" | "operate" | "recovery", boolean>;
  discovery: ReturnType<typeof analyzeV22Transcript> | null;
  world_state: Parameters<typeof scoreV22Stages>[1];
  invocation: { duration_ms: number | null; validity_status?: string | null; ok?: boolean };
  route: { mismatch: boolean };
  cleanup?: { success?: boolean };
  artifact_dir: string;
};

function readRows(root: string): Observation[] {
  const path = resolve(root, "observations.jsonl");
  if (!existsSync(path)) throw new Error(`missing observations ledger: ${path}`);
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as Observation);
}

function sameCell(a: Observation, b: Observation): boolean {
  return a.vendor === b.vendor && a.model === b.model && a.provider === b.provider
    && a.harness === b.harness && a.trial === b.trial;
}

const original = readRows(primaryRoot);
const final = [...original];
const replacementLedger: Array<Record<string, unknown>> = [];
for (const replacementRoot of replacementRoots) {
  for (const replacement of readRows(replacementRoot)) {
    const index = final.findIndex((row) => sameCell(row, replacement));
    if (index < 0) throw new Error(`replacement has no planned primary cell: ${replacement.vendor}`);
    const prior = final[index]!;
    if (!prior.status.startsWith("invalid-")) {
      throw new Error(`replacement cannot overwrite a valid primary cell: ${replacement.vendor}`);
    }
    if (replacement.status.startsWith("invalid-")) {
      throw new Error(`replacement is not valid: ${replacement.vendor} ${replacement.status}`);
    }
    final[index] = replacement;
    replacementLedger.push({
      schema: "ax.daeb-v2-2-replacement/v1",
      vendor: replacement.vendor,
      reason: process.env.DAEB_V22_REPLACEMENT_REASON
        ?? "transport-invalid-before-artifact-write",
      original_status: prior.status,
      original_artifact_dir: prior.artifact_dir,
      replacement_status: replacement.status,
      replacement_artifact_dir: replacement.artifact_dir,
    });
  }
}

const reconciliations: Array<Record<string, unknown>> = [];
for (const row of final) {
  if (row.status.startsWith("invalid-")) continue;
  const vendor = contract.vendors[row.vendor];
  if (!vendor) throw new Error(`contract has no vendor ${row.vendor}`);
  const transcriptPath = resolve(row.artifact_dir, "run-pi-v22-native.transcript.jsonl");
  if (!existsSync(transcriptPath)) continue;
  const discovery = analyzeV22Transcript({
    transcript: readFileSync(transcriptPath, "utf8"),
    vendor,
    staleTarget: `axarena_missing_${row.namespace}`,
    outcomePassed: row.world_state.connection_ok,
  });
  const nextStages = scoreV22Stages(discovery, row.world_state);
  const nextStatus = row.route.mismatch
    ? "invalid-route"
    : row.invocation.ok === false || row.invocation.validity_status !== "valid" || row.cleanup?.success === false
      ? "invalid-infra"
      : Object.values(nextStages).every(Boolean) ? "pass" : "fail";
  if (JSON.stringify(row.discovery) !== JSON.stringify(discovery)
    || JSON.stringify(row.stages) !== JSON.stringify(nextStages)
    || row.status !== nextStatus) {
    reconciliations.push({
      schema: "ax.daeb-v2-2-observation-reconciliation/v1",
      vendor: row.vendor,
      reason: "recomputed-with-current-transcript-decoder-and-scoring",
      prior_status: row.status,
      final_status: nextStatus,
      prior_stages: row.stages,
      final_stages: nextStages,
      transcript_invalid_lines: discovery.transcript_invalid_lines,
      artifact_dir: row.artifact_dir,
    });
  }
  row.discovery = discovery;
  row.stages = nextStages;
  row.status = nextStatus;
}

const stages = ["discovery", "connect", "operate", "recovery"] as const;
const stagePasses = Object.fromEntries(stages.map((stage) => [stage,
  final.filter((row) => row.stages[stage]).length]));
const nonUnanimous = stages.filter((stage) => stagePasses[stage] > 0
  && stagePasses[stage] < final.length);
const modes = new Set(final.flatMap((row) => row.discovery ? [row.discovery.discovery_mode] : []));
const toolCounts = final.flatMap((row) => row.discovery
  ? [row.discovery.commands + row.discovery.searches + row.discovery.fetched_urls] : []);
const latencies = final.flatMap((row) => typeof row.invocation.duration_ms === "number"
  ? [row.invocation.duration_ms] : []);
const dimensions = [
  nonUnanimous.length ? "stage-outcomes" : null,
  modes.size >= 2 ? "discovery-mode" : null,
  toolCounts.length >= 2 && Math.max(...toolCounts) - Math.min(...toolCounts) >= 5
    ? "tool-count" : null,
  latencies.length >= 2 && Math.max(...latencies) / Math.max(1, Math.min(...latencies)) >= 1.5
    ? "latency" : null,
].filter((value): value is string => Boolean(value));
const invalidInfra = final.filter((row) => row.status === "invalid-infra").length;
const invalidRoute = final.filter((row) => row.status === "invalid-route" || row.route.mismatch).length;
const gatePass = final.length === plannedSessions && invalidInfra === 0 && invalidRoute === 0
  && (!contract.acceptance.non_unanimous_stage_required || nonUnanimous.length > 0)
  && dimensions.length >= contract.acceptance.differentiating_dimensions_required;
const audit = {
  schema: "ax.daeb-v2-2-native-pilot-final-audit/v1",
  formal: false,
  primary_root: primaryRoot,
  replacement_roots: replacementRoots,
  contract: contractPath,
  planned_sessions: plannedSessions,
  final_sessions: final.length,
  original_observations_preserved: original.length,
  replacements: replacementLedger.length,
  reconciliations: reconciliations.length,
  status_counts: Object.fromEntries(["pass", "fail", "invalid-infra", "invalid-route"]
    .map((status) => [status, final.filter((row) => row.status === status).length])),
  stage_passes: stagePasses,
  non_unanimous_stages: nonUnanimous,
  differentiating_dimensions: dimensions,
  invalid_infra: invalidInfra,
  invalid_route: invalidRoute,
  pilot_gate_pass: gatePass,
  decision: gatePass ? "signal-found-review-before-expansion" : "do-not-expand",
};

mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
writeFileSync(resolve(outputRoot, "replacement-ledger.jsonl"),
  replacementLedger.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
writeFileSync(resolve(outputRoot, "reconciliation-ledger.jsonl"),
  reconciliations.map((row) => JSON.stringify(row)).join("\n") + (reconciliations.length ? "\n" : ""),
  { mode: 0o600 });
writeFileSync(resolve(outputRoot, "final-observations.jsonl"),
  final.sort((a, b) => a.vendor.localeCompare(b.vendor)).map((row) => JSON.stringify(row)).join("\n") + "\n",
  { mode: 0o600 });
writeFileSync(resolve(outputRoot, "final-pilot-gate.json"), JSON.stringify(audit, null, 2) + "\n",
  { mode: 0o600 });
console.log(JSON.stringify({ output_root: outputRoot, ...audit }, null, 2));
