#!/usr/bin/env node
/**
 * Produce a vendor-row diagnostic view for the V2.3 Gemini expansion.
 * Atomic tasks and J01 are reported as separate task families in the same
 * frozen V2.3 trial; they are never double-counted.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { decodeTranscriptContent } from "ax-eval";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../../..");
const outputRoot = resolve(ROOT, process.env.DAEB_V23_GEMINI_OUTPUT_ROOT
  ?? "results/v23-frozen-gemini-3.7-flash-20260816-t1-r2");
const atomicRoots = [
  resolve(ROOT, process.env.DAEB_V23_GEMINI_ATOMIC_ROOT
    ?? "results/v23-frozen-gemini-3.7-flash-20260816-atomic-t1-r2"),
];
const j01Roots = [
  resolve(ROOT, process.env.DAEB_V23_GEMINI_J01_ROOT
    ?? "results/v23-frozen-gemini-3.7-flash-20260816-j01-t1-r2"),
];
const vendors = ["cockroachdb", "insforge", "neon", "nile", "supabase", "turso"];
const atomicCliContracts = Object.fromEntries(vendors.map((vendor) => {
  const pack = parseYaml(readFileSync(resolve(ROOT,
    `ax-arena/benchmark/axarena-database/v2-3/packs/${vendor}/pack.yaml`), "utf8")) as {
    surfaces?: { cli?: { bin?: string } };
    discovery?: { official_domains?: string[] };
  };
  const bin = pack.surfaces?.cli?.bin;
  if (!bin) throw new Error(`atomic pack does not declare CLI bin: ${vendor}`);
  return [vendor, { bin, officialDomains: pack.discovery?.official_domains ?? [] }];
}));

type Observation = {
  task_id: string;
  vendor: string;
  status: string;
  family: string;
  bootstrap_status?: string;
  route_entries: number;
  artifact_dir: string;
  cleanup?: { evidence?: { errors?: unknown[] } };
};
type Invoke = { durationMs?: number; first_action_latency_ms?: number; transcript_event_count?: number };
type Journey = {
  vendor: string;
  status: string;
  stages?: Record<string, boolean>;
  discovery?: { discovery_mode?: string };
  route?: { entries?: number; upstream_errors?: number; reported_cost_usd?: number };
};

function json(path: string): unknown { return JSON.parse(readFileSync(path, "utf8")); }
function numberMean(values: number[]): number | null {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function readAtomic(root: string): Observation[] {
  const cells = resolve(root, "cells");
  if (!existsSync(cells)) throw new Error(`missing atomic cells: ${cells}`);
  return readdirSync(cells, { withFileTypes: true }).filter((vendor) => vendor.isDirectory()).flatMap((vendor) =>
    readdirSync(resolve(cells, vendor.name), { withFileTypes: true }).filter((task) => task.isDirectory()).flatMap((task) => {
      const path = resolve(cells, vendor.name, task.name, "observation.json");
      return existsSync(path) ? [json(path) as Observation] : [];
    }));
}
function invokeFor(row: Observation): Invoke | null {
  const path = resolve(row.artifact_dir, `run-pi-medium-cli-${row.task_id}.invoke.json`);
  return existsSync(path) ? json(path) as Invoke : null;
}
function bootstrapDiscovery(row: Observation): { searches: number; urls: number } | null {
  const path = resolve(row.artifact_dir, "run-pi-medium-cli-bootstrap.json");
  if (!existsSync(path)) return null;
  const parsed = json(path) as { discovery?: { searches?: unknown[]; urls_visited?: unknown[] } };
  return {
    searches: Array.isArray(parsed.discovery?.searches) ? parsed.discovery!.searches.length : 0,
    urls: Array.isArray(parsed.discovery?.urls_visited) ? parsed.discovery!.urls_visited.length : 0,
  };
}
function bootstrapTranscriptMetrics(row: Observation): {
  commands: number;
  searches: number;
  fetched_urls: number;
  help_inspected: boolean;
  official_source_observed: boolean;
  native_entrypoint_observed: boolean;
  mode: "direct" | "assisted" | "unresolved";
} | null {
  const path = resolve(row.artifact_dir, "run-pi-medium-cli-bootstrap.transcript.jsonl");
  if (!existsSync(path)) return null;
  const decoded = decodeTranscriptContent(readFileSync(path, "utf8"), { harness: "pi" });
  const commands = decoded.events.filter((event) => event.kind === "command")
    .map((event) => event.kind === "command" ? event.command : "");
  const vendor = atomicCliContracts[row.vendor];
  if (!vendor) throw new Error(`missing atomic CLI contract vendor: ${row.vendor}`);
  const joined = commands.join("\n").toLowerCase();
  const urls = [
    ...decoded.events.filter((event) => event.kind === "fetch")
      .map((event) => event.kind === "fetch" ? event.url : ""),
    ...[...joined.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0]!),
  ];
  const nativeEntrypoint = new RegExp(`(^|\\s)${vendor.bin.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?:\\s|$)`, "m").test(joined);
  const help = commands.some((command) => /(?:--help|\s-h(?:\s|$)|\bhelp\b)/i.test(command)
    && new RegExp(`(^|\\s)${vendor.bin.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?:\\s|$)`, "m").test(command.toLowerCase()));
  const official = help || urls.some((url) => vendor.officialDomains.some((domain) => url.includes(domain)));
  return {
    commands: commands.length,
    searches: decoded.events.filter((event) => event.kind === "search").length,
    fetched_urls: urls.length,
    help_inspected: help,
    official_source_observed: official,
    native_entrypoint_observed: nativeEntrypoint,
    mode: row.bootstrap_status !== "pass" || !nativeEntrypoint ? "unresolved" : official ? "assisted" : "direct",
  };
}
function readJourney(root: string): Journey[] {
  const gate = json(resolve(root, "pilot-gate.json")) as { observations?: Journey[] };
  return gate.observations ?? [];
}
function atomicLedgerMetrics(roots: string[]): { cost_usd: number; upstream_errors: number } {
  return roots.reduce((total, root) => readdirSync(root)
    .filter((name) => /^route-.*\.jsonl$/.test(name))
    .reduce((rootTotal, name) => readFileSync(resolve(root, name), "utf8").trim().split("\n")
      .filter(Boolean)
      .reduce((ledgerTotal, line) => {
        const entry = JSON.parse(line) as { cost_usd?: number; outcome?: string };
        return {
          cost_usd: ledgerTotal.cost_usd + (entry.cost_usd ?? 0),
          upstream_errors: ledgerTotal.upstream_errors + (entry.outcome === "upstream-error" ? 1 : 0),
        };
      }, rootTotal), total), { cost_usd: 0, upstream_errors: 0 });
}

const atomic = atomicRoots.flatMap(readAtomic);
if (atomic.length !== 36) throw new Error(`expected 36 atomic observations, found ${atomic.length}`);
const duplicateKeys = atomic.map((row) => `${row.vendor}/${row.task_id}`);
if (new Set(duplicateKeys).size !== atomic.length) throw new Error("duplicate atomic vendor/task observations");
const invalid = atomic.filter((row) => row.status === "invalid-infra" || row.status === "invalid-route");
if (invalid.length) throw new Error(`atomic lane contains invalid observations: ${invalid.map((row) => `${row.vendor}/${row.task_id}`).join(", ")}`);
const cleanupErrors = atomic.filter((row) => (row.cleanup?.evidence?.errors?.length ?? 0) > 0);
if (cleanupErrors.length) throw new Error("atomic lane contains cleanup errors");

const journeyTrials = j01Roots.map((path) => ({ path, rows: readJourney(path) }));
for (const trial of journeyTrials) {
  if (trial.rows.length !== vendors.length) throw new Error(`expected six J01 observations in ${trial.path}`);
  if (trial.rows.some((row) => row.status.startsWith("invalid-"))) throw new Error(`J01 audit contains invalid observation: ${trial.path}`);
}

const rows = vendors.map((vendor) => {
  const cells = atomic.filter((row) => row.vendor === vendor);
  const valid = cells.filter((row) => row.status === "pass" || row.status === "fail");
  const runnable = cells.filter((row) => row.status !== "structural-na");
  const invokes = cells.flatMap((row) => { const item = invokeFor(row); return item ? [item] : []; });
  const reportedDiscovery = cells.flatMap((row) => { const item = bootstrapDiscovery(row); return item ? [item] : []; });
  const discovery = cells.flatMap((row) => { const item = bootstrapTranscriptMetrics(row); return item ? [item] : []; });
  const j01 = journeyTrials.map((trial) => trial.rows.find((row) => row.vendor === vendor)!);
  const byTask = Object.fromEntries(cells.map((row) => [row.task_id, row.status]));
  return {
    vendor,
    atomic_t1: {
      planned: cells.length,
      valid: valid.length,
      pass: valid.filter((row) => row.status === "pass").length,
      fail: valid.filter((row) => row.status === "fail").length,
      structural_na: cells.filter((row) => row.status === "structural-na").length,
      pass_rate: valid.length ? valid.filter((row) => row.status === "pass").length / valid.length : null,
      by_task: byTask,
    },
    discovery_metrics: {
      denominator_runnable_cells: runnable.length,
      bootstrap_valid_rate: runnable.length ? runnable.filter((row) => row.bootstrap_status === "pass").length / runnable.length : null,
      source: "decoded bootstrap transcripts; not agent-authored discovery fields",
      mean_commands: numberMean(discovery.map((item) => item.commands)),
      mean_web_searches: numberMean(discovery.map((item) => item.searches)),
      mean_fetched_or_command_urls: numberMean(discovery.map((item) => item.fetched_urls)),
      help_inspected_rate: runnable.length ? discovery.filter((item) => item.help_inspected).length / runnable.length : null,
      official_source_observed_rate: runnable.length ? discovery.filter((item) => item.official_source_observed).length / runnable.length : null,
      native_entrypoint_observed_rate: runnable.length ? discovery.filter((item) => item.native_entrypoint_observed).length / runnable.length : null,
      mode_counts: Object.fromEntries(["direct", "assisted", "unresolved"].map((mode) => [mode,
        discovery.filter((item) => item.mode === mode).length])),
      agent_reported_web_searches_mean: numberMean(reportedDiscovery.map((item) => item.searches)),
      agent_reported_urls_mean: numberMean(reportedDiscovery.map((item) => item.urls)),
      discovery_task_status: byTask["db-T17-cli-session-discovery"] ?? null,
    },
    efficiency_metrics: {
      median_duration_ms: median(invokes.flatMap((item) => typeof item.durationMs === "number" ? [item.durationMs] : [])),
      median_first_action_latency_ms: median(invokes.flatMap((item) => typeof item.first_action_latency_ms === "number" ? [item.first_action_latency_ms] : [])),
      mean_transcript_events: numberMean(invokes.flatMap((item) => typeof item.transcript_event_count === "number" ? [item.transcript_event_count] : [])),
      route_entries: cells.reduce((total, row) => total + row.route_entries, 0),
      cost_usd: null,
      cost_note: "Pi invocation metadata does not report per-cell cost; do not infer it from the shared gateway ledger.",
    },
    j01_native_journey: j01.map((row, index) => ({
      source_root: j01Roots[index], status: row.status, stages: row.stages ?? null,
      discovery_mode: row.discovery?.discovery_mode ?? null,
    })),
  };
});
const taskQualityAudit = [...new Set(atomic.map((row) => row.task_id))].sort().map((task_id) => {
  const cells = atomic.filter((row) => row.task_id === task_id);
  const valid = cells.filter((row) => row.status === "pass" || row.status === "fail");
  const pass = valid.filter((row) => row.status === "pass").length;
  const fail = valid.filter((row) => row.status === "fail").length;
  const structuralNa = cells.filter((row) => row.status === "structural-na").length;
  const decision = fail === 0
    ? "provisional-retain"
    : fail >= 3 ? "oracle-or-contract-review-required"
      : structuralNa > 0 ? "support-matrix-and-targeted-retest-required"
        : "targeted-retest-required";
  return {
    task_id,
    family: cells[0]?.family ?? null,
    planned: cells.length,
    valid: valid.length,
    pass,
    fail,
    structural_na: structuralNa,
    vendor_statuses: Object.fromEntries(cells.map((row) => [row.vendor, row.status])),
    decision,
    evidence_boundary: "One model and one fresh trial only. Valid failures prove this model-task-vendor outcome, not a task defect. Every runnable atomic cell persists pre-cleanup predicate evidence.",
  };
});
const atomicLedger = atomicLedgerMetrics(atomicRoots);
const j01CostUsd = journeyTrials.flatMap((trial) => trial.rows)
  .reduce((total, row) => total + (row.route?.reported_cost_usd ?? 0), 0);
const j01UpstreamErrors = journeyTrials.flatMap((trial) => trial.rows)
  .reduce((total, row) => total + (row.route?.upstream_errors ?? 0), 0);

const summary = {
  schema: "ax.daeb-v2-3-gemini-vendor-summary/v1",
  status: "diagnostic-partial-repetition",
  formal: false,
  primary_unit: "vendor",
  row_order: vendors,
  model: "google/gemini-3.7-flash-20260813",
  provider: "google-vertex",
  preflight: "provider-pinning validated by the current atomic route ledger; no separate no-write preflight artifact",
  atomic_evidence: { roots: atomicRoots, trial: 1, task_count: 6, planned_cells: 36, valid_cells: atomic.filter((row) => row.status === "pass" || row.status === "fail").length, structural_na: atomic.filter((row) => row.status === "structural-na").length, invalid_infra: 0, invalid_route: 0 },
  observed_costs_usd: {
    atomic_shared_lane: atomicLedger.cost_usd,
    j01_native_journey: j01CostUsd,
    total: atomicLedger.cost_usd + j01CostUsd,
    note: "Atomic cost is a shared gateway-lane total and is deliberately not allocated to individual vendor rows.",
  },
  retained_upstream_errors: {
    atomic_route_ledger: atomicLedger.upstream_errors,
    j01_route_ledger: j01UpstreamErrors,
    note: "Upstream errors are retained in their route ledgers and are not reclassified as model failures.",
  },
  j01_policy: "Fresh V2.3 J01 trial is reported beside atomic tasks as one distinct family and is never double-counted.",
  rows,
  task_quality_audit: taskQualityAudit,
  caveats: [
    "One fresh atomic trial is insufficient for a stability or leaderboard claim.",
    "Discovery metrics are decoded from bootstrap transcripts. Agent-authored discovery fields are retained only as a discrepancy diagnostic.",
    "Atomic gateway cost is shared-lane-only; per-vendor atomic cost is intentionally null.",
  ],
};
mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
writeFileSync(resolve(outputRoot, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 });
writeFileSync(resolve(outputRoot, "source-evidence.json"), JSON.stringify({
  schema: "ax.daeb-v2-3-source-evidence/v1", model: summary.model, provider: summary.provider,
  atomic_roots: atomicRoots, j01_roots: j01Roots, pooling: "J01 is a distinct family, not a stage-expanded duplicate",
}, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify({ output_root: outputRoot, atomic: summary.atomic_evidence, rows: rows.map((row) => ({ vendor: row.vendor, atomic_t1: row.atomic_t1 })) }, null, 2));
