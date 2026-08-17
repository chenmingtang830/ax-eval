#!/usr/bin/env node
/**
 * Vendor-first V2.4 diagnostic summary.
 *
 * Every input must be a final audit root.  This deliberately refuses raw
 * controller output so that no invalid or replacement observation can leak
 * into the published aggregate unnoticed.  Models/trials remain slices in
 * each vendor row, never the primary organization of the report.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const manifestPath = resolve(ROOT, process.env.DAEB_V24_SUMMARY_MANIFEST
  ?? "ax-arena/benchmark/axarena-database/v2-4/publication-inputs.json");
const outputRoot = resolve(ROOT, process.env.DAEB_V24_SUMMARY_OUTPUT_ROOT
  ?? "results/v24-vendor-publication-summary");
const DEFAULT_CORE_VENDORS = ["cockroachdb", "insforge", "neon", "nile", "supabase"];

type Atomic = {
  vendor: string; task_id: string; model: string; trial: number; status: string;
  route_entries?: number; artifact_dir: string; bootstrap_status?: string;
};
type Journey = {
  vendor: string; model: string; trial: number; status: string;
  stages?: Record<string, boolean>;
  discovery?: { discovery_mode?: string; commands?: number; searches?: number; fetched_urls?: number };
  invocation?: { duration_ms?: number; first_action_latency_ms?: number; transcript_event_count?: number };
  route?: { entries?: number; upstream_errors?: number; reported_cost_usd?: number };
};
type Trial = { trial: number; atomic_audit_root: string; j01_audit_root: string };
type Model = { model: string; provider: string; trials: Trial[] };
type Manifest = { schema: string; formal?: boolean; core_vendors?: string[]; models: Model[] };

function json(path: string): any { return JSON.parse(readFileSync(path, "utf8")); }
function jsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle]! : (ordered[middle - 1]! + ordered[middle]!) / 2;
}
function mean(values: number[]): number | null {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}
function statusCounts(rows: Array<{ status: string }>): Record<string, number> {
  return Object.fromEntries(["pass", "fail", "structural-na", "invalid-infra", "invalid-route", "invalid-evidence"]
    .map((status) => [status, rows.filter((row) => row.status === status).length]));
}
function requireAudit(root: string, kind: "atomic" | "j01"): { rows: Atomic[] | Journey[]; gate: any } {
  const gateName = kind === "atomic" ? "final-atomic-audit.json" : "final-pilot-gate.json";
  const gatePath = resolve(ROOT, root, gateName);
  const rowsPath = resolve(ROOT, root, "final-observations.jsonl");
  if (!existsSync(gatePath) || !existsSync(rowsPath)) throw new Error(`missing final ${kind} audit evidence: ${root}`);
  const gate = json(gatePath);
  if (gate.formal !== false) throw new Error(`unexpected formal status in ${root}`);
  if ((gate.invalid_infra ?? gate.status_counts?.["invalid-infra"] ?? 0) !== 0
    || (gate.invalid_route ?? gate.status_counts?.["invalid-route"] ?? 0) !== 0
    || (gate.invalid_evidence ?? gate.status_counts?.["invalid-evidence"] ?? 0) !== 0) {
    throw new Error(`invalid observation admitted into summary input: ${root}`);
  }
  if (kind === "j01" && gate.pilot_gate_pass !== true) throw new Error(`J01 audit gate failed: ${root}`);
  return { rows: jsonl(rowsPath), gate };
}
function invoke(row: Atomic): { duration?: number; firstAction?: number; events?: number } {
  const path = resolve(row.artifact_dir, `run-pi-medium-cli-${row.task_id}.invoke.json`);
  if (!existsSync(path)) return {};
  const value = json(path);
  return { duration: value.durationMs, firstAction: value.first_action_latency_ms, events: value.transcript_event_count };
}

const manifest = json(manifestPath) as Manifest;
if (manifest.schema !== "ax.daeb-v2-4-publication-inputs/v1" || manifest.formal !== false || !Array.isArray(manifest.models)) {
  throw new Error(`invalid V2.4 publication input manifest: ${manifestPath}`);
}
if (!manifest.models.length) throw new Error("publication input manifest has no models");
const coreVendors = manifest.core_vendors ?? DEFAULT_CORE_VENDORS;
if (new Set(coreVendors).size !== coreVendors.length || coreVendors.length !== 5) {
  throw new Error("publication core must declare exactly five unique vendors");
}

const atomic: Array<Atomic & { provider: string }> = [];
const journeys: Array<Journey & { provider: string }> = [];
const inputEvidence: any[] = [];
for (const model of manifest.models) {
  if (!model.model || !model.provider || model.trials.length !== 2) throw new Error(`model must declare two trials: ${model.model}`);
  for (const trial of model.trials) {
    const atomicAudit = requireAudit(trial.atomic_audit_root, "atomic");
    const journeyAudit = requireAudit(trial.j01_audit_root, "j01");
    const aRows = atomicAudit.rows as Atomic[];
    const jRows = journeyAudit.rows as Journey[];
    const coreAtomic = aRows.filter((row) => coreVendors.includes(row.vendor));
    const coreJourney = jRows.filter((row) => coreVendors.includes(row.vendor));
    if (coreAtomic.length !== coreVendors.length * 6 || coreJourney.length !== coreVendors.length) {
      throw new Error(`incomplete five-vendor audited trial: ${model.model} T${trial.trial}`);
    }
    if (aRows.some((row) => row.model !== model.model || row.trial !== trial.trial)
      || jRows.some((row) => row.model !== model.model || row.trial !== trial.trial)) {
      throw new Error(`model/trial identity mismatch in audited rows: ${model.model} T${trial.trial}`);
    }
    atomic.push(...coreAtomic.map((row) => ({ ...row, provider: model.provider })));
    journeys.push(...coreJourney.map((row) => ({ ...row, provider: model.provider })));
    inputEvidence.push({ model: model.model, provider: model.provider, trial: trial.trial,
      atomic_audit_root: trial.atomic_audit_root, j01_audit_root: trial.j01_audit_root,
      atomic_gate: atomicAudit.gate.decision, j01_gate: journeyAudit.gate.decision,
      excluded_appendix_observations: { atomic: aRows.length - coreAtomic.length, j01: jRows.length - coreJourney.length } });
  }
}

const rows = coreVendors.map((vendor) => {
  const vendorAtomic = atomic.filter((row) => row.vendor === vendor);
  const vendorJourneys = journeys.filter((row) => row.vendor === vendor);
  const validAtomic = vendorAtomic.filter((row) => row.status === "pass" || row.status === "fail");
  const invocations = vendorAtomic.map(invoke);
  const modelTrialSlices = manifest.models.flatMap((model) => model.trials.map((trial) => {
    const a = vendorAtomic.filter((row) => row.model === model.model && row.trial === trial.trial);
    const j = vendorJourneys.find((row) => row.model === model.model && row.trial === trial.trial);
    const valid = a.filter((row) => row.status === "pass" || row.status === "fail");
    return {
      model: model.model, provider: model.provider, trial: trial.trial,
      atomic: { planned: a.length, valid: valid.length, pass: valid.filter((row) => row.status === "pass").length,
        fail: valid.filter((row) => row.status === "fail").length,
        structural_na: a.filter((row) => row.status === "structural-na").length,
        pass_rate: valid.length ? valid.filter((row) => row.status === "pass").length / valid.length : null,
        by_task: Object.fromEntries(a.map((row) => [row.task_id, row.status])) },
      j01: j ? { status: j.status, stages: j.stages ?? null, discovery_mode: j.discovery?.discovery_mode ?? null,
        duration_ms: j.invocation?.duration_ms ?? null, first_action_latency_ms: j.invocation?.first_action_latency_ms ?? null,
        transcript_events: j.invocation?.transcript_event_count ?? null, route_entries: j.route?.entries ?? null,
        upstream_errors: j.route?.upstream_errors ?? null, cost_usd: j.route?.reported_cost_usd ?? null } : null,
    };
  }));
  const jPass = vendorJourneys.filter((row) => row.status === "pass").length;
  const discoveryModes = ["direct-success", "assisted-discovery", "unresolved"];
  const journeyDurations = vendorJourneys.flatMap((row) => typeof row.invocation?.duration_ms === "number" ? [row.invocation.duration_ms] : []);
  const journeyFirstAction = vendorJourneys.flatMap((row) => typeof row.invocation?.first_action_latency_ms === "number" ? [row.invocation.first_action_latency_ms] : []);
  const journeyEvents = vendorJourneys.flatMap((row) => typeof row.invocation?.transcript_event_count === "number" ? [row.invocation.transcript_event_count] : []);
  return {
    vendor,
    outcome_metrics: {
      atomic: { planned: vendorAtomic.length, valid: validAtomic.length, pass: validAtomic.filter((row) => row.status === "pass").length,
        fail: validAtomic.filter((row) => row.status === "fail").length,
        structural_na: vendorAtomic.filter((row) => row.status === "structural-na").length,
        pass_rate: validAtomic.length ? validAtomic.filter((row) => row.status === "pass").length / validAtomic.length : null },
      j01: { planned: vendorJourneys.length, pass: jPass, fail: vendorJourneys.filter((row) => row.status === "fail").length,
        pass_rate: vendorJourneys.length ? jPass / vendorJourneys.length : null,
        stages: Object.fromEntries(["discovery", "connect", "operate", "recovery"].map((stage) => [stage,
          vendorJourneys.filter((row) => row.stages?.[stage] === true).length])) },
    },
    discovery_metrics: {
      denominator_j01: vendorJourneys.length,
      modes: Object.fromEntries(discoveryModes.map((mode) => [mode, vendorJourneys.filter((row) => row.discovery?.discovery_mode === mode).length])),
      mean_searches: mean(vendorJourneys.flatMap((row) => typeof row.discovery?.searches === "number" ? [row.discovery.searches] : [])),
      mean_commands: mean(vendorJourneys.flatMap((row) => typeof row.discovery?.commands === "number" ? [row.discovery.commands] : [])),
      mean_fetched_urls: mean(vendorJourneys.flatMap((row) => typeof row.discovery?.fetched_urls === "number" ? [row.discovery.fetched_urls] : [])),
    },
    efficiency_metrics: {
      atomic_median_duration_ms: median(invocations.flatMap((item) => typeof item.duration === "number" ? [item.duration] : [])),
      atomic_median_first_action_latency_ms: median(invocations.flatMap((item) => typeof item.firstAction === "number" ? [item.firstAction] : [])),
      atomic_mean_transcript_events: mean(invocations.flatMap((item) => typeof item.events === "number" ? [item.events] : [])),
      j01_median_duration_ms: median(journeyDurations), j01_median_first_action_latency_ms: median(journeyFirstAction),
      j01_mean_duration_ms: mean(journeyDurations),
      j01_mean_first_action_latency_ms: mean(journeyFirstAction),
      j01_mean_transcript_events: mean(journeyEvents),
      atomic_route_entries: vendorAtomic.reduce((total, row) => total + (row.route_entries ?? 0), 0),
      j01_route_entries: vendorJourneys.reduce((total, row) => total + (row.route?.entries ?? 0), 0),
      j01_upstream_errors: vendorJourneys.reduce((total, row) => total + (row.route?.upstream_errors ?? 0), 0),
      j01_reported_cost_usd: vendorJourneys.reduce((total, row) => total + (row.route?.reported_cost_usd ?? 0), 0),
      j01_mean_reported_cost_usd: mean(vendorJourneys.flatMap((row) =>
        typeof row.route?.reported_cost_usd === "number" ? [row.route.reported_cost_usd] : [])),
      atomic_cost_usd: null,
      atomic_cost_note: "Shared gateway-lane cost is intentionally not allocated to vendor rows.",
    },
    model_trial_slices: modelTrialSlices,
  };
});

// This is an explicitly supplementary slice table: it answers model-selection
// questions while preserving vendor rows as the primary public comparison.
const modelSliceRows = manifest.models.map((model) => {
  const slices = journeys.filter((row) => row.model === model.model && row.provider === model.provider);
  const durations = slices.flatMap((row) => typeof row.invocation?.duration_ms === "number" ? [row.invocation.duration_ms] : []);
  const firstActions = slices.flatMap((row) => typeof row.invocation?.first_action_latency_ms === "number" ? [row.invocation.first_action_latency_ms] : []);
  const costs = slices.flatMap((row) => typeof row.route?.reported_cost_usd === "number" ? [row.route.reported_cost_usd] : []);
  const pass = slices.filter((row) => row.status === "pass").length;
  return {
    model: model.model,
    provider: model.provider,
    metrics_scope: "J01 native journeys only; two trials × five core vendors",
    j01_planned: slices.length,
    j01_pass: pass,
    j01_fail: slices.filter((row) => row.status === "fail").length,
    j01_success_rate: slices.length ? pass / slices.length : null,
    j01_total_reported_cost_usd: costs.reduce((total, cost) => total + cost, 0),
    j01_mean_reported_cost_usd: mean(costs),
    j01_median_duration_ms: median(durations),
    j01_median_first_action_latency_ms: median(firstActions),
  };
});

const output = {
  schema: "ax.daeb-v2-4-vendor-first-summary/v1", formal: false, status: "diagnostic-multi-model-two-trial",
  primary_unit: "vendor", row_order: coreVendors, input_evidence: inputEvidence,
  sample: { models: manifest.models.map((model) => ({ model: model.model, provider: model.provider, trials: model.trials.map((trial) => trial.trial) })),
    atomic_cells: atomic.length, j01_sessions: journeys.length, atomic_status_counts: statusCounts(atomic), j01_status_counts: statusCounts(journeys) },
  rows,
  model_slice_rows: modelSliceRows,
  interpretation_boundary: [
    "Vendor rows are the primary unit; models and trials are disclosed slices, not pooled leaderboard ranks.",
    "Turso is excluded from this five-vendor core and retained only through its separate compatibility/J01 appendix evidence.",
    "Atomic and J01 are distinct task families and are never double-counted.",
    "All inputs are final-audited V2.4 diagnostics; no invalid-infra, invalid-route, or invalid-evidence cells are admitted.",
    "Route-ledger upstream errors remain reliability signals and are not relabeled as model failures.",
  ],
};
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
writeFileSync(resolve(outputRoot, "summary.json"), JSON.stringify(output, null, 2) + "\n", { mode: 0o600 });
writeFileSync(resolve(outputRoot, "source-evidence.json"), JSON.stringify({ schema: "ax.daeb-v2-4-summary-sources/v1", inputs: inputEvidence }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ output_root: outputRoot, primary_unit: output.primary_unit, sample: output.sample, vendors: rows.map((row) => ({ vendor: row.vendor, outcome: row.outcome_metrics })) }, null, 2));
