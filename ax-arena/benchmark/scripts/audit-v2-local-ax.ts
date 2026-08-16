/**
 * Reconstruct observed Phase-0 discovery from retained harness transcripts and
 * combine it with independent provider-oracle usability. This is a post-hoc
 * local release audit: it never invokes a model or mutates a provider sandbox.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoveryScore,
  loadPack,
  observedToDiscovery,
  parseTranscriptWithDiagnostics,
  scoreDiscovery,
  type BearerClient,
  type DiscoveryMetric,
} from "ax-eval";
import { parse as yamlParse } from "yaml";
import { z } from "zod";

import { axCompositeScore } from "../src/publication/ax-score.js";

const ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const DEFAULT_POLICY = resolve(ROOT, "ax-arena/benchmark/axarena-database/v2/production/local-ax-cohort.yaml");

const EvidenceSchema = z.object({
  vendor: z.string().min(1),
  root: z.string().min(1),
  trials: z.array(z.number().int().positive()).min(1),
}).strict();

const LaneSchema = z.object({
  id: z.string().min(1),
  track: z.string().min(1),
  include_in_release_total: z.boolean(),
  harness: z.enum(["claude-code", "codex", "opencode", "pi"]),
  model: z.string().min(1),
  evidence: z.array(EvidenceSchema).min(1),
}).strict();

const PolicySchema = z.object({
  schema: z.literal("ax.daeb-v2-local-ax-cohort/v1"),
  release_id: z.string().min(1),
  output: z.string().min(1),
  markdown_output: z.string().min(1),
  policy: z.object({
    discovery_source: z.literal("observed-transcript-only"),
    discovery_signals: z.array(z.enum(["official", "canonical", "misled", "auth"])).min(1),
    usability_source: z.literal("independent-provider-oracle"),
    composite_formula: z.literal("harmonic_mean"),
    notes: z.array(z.string()).default([]),
  }).strict(),
  lanes: z.array(LaneSchema).min(1),
}).strict();

type AuditSummary = {
  runnable_tasks?: number;
  oracle_passed?: number;
  strict_passed?: number;
  eligible?: number;
  passed?: number;
};

type ModelAudit = {
  vendor: string;
  trial: number;
  harness?: string | null;
  model: string;
  summary: AuditSummary;
};

type ExecutorRecord = {
  harness: string;
  model: string;
  ns?: string;
};

type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  total_tokens?: number;
};

type InvokeRecord = {
  durationMs: number;
  first_action_latency_ms: number | null;
  metrics?: {
    cost_usd?: number | null;
    token_usage?: TokenUsage | null;
  };
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function insideRoot(path: string, label: string): string {
  const absolute = resolve(ROOT, path);
  const rel = relative(ROOT, absolute);
  if (!rel || rel === ".." || rel.startsWith("../")) throw new Error(`${label} must resolve inside ${ROOT}`);
  return absolute;
}

function onlyFile(dir: string, pattern: RegExp, label: string): string {
  const matches = readdirSync(dir).filter((name) => pattern.test(name));
  if (matches.length !== 1) throw new Error(`${label} expected exactly one file in ${relative(ROOT, dir)}, found ${matches.length}`);
  return resolve(dir, matches[0]!);
}

function packPath(vendor: string, track: string): string {
  return track === "supabase-cli-extension"
    ? resolve(ROOT, "ax-arena/benchmark/axarena-database/v2/production/extensions/supabase-cli/pack.yaml")
    : resolve(ROOT, "ax-arena/benchmark/axarena-database/v2/production/packs", vendor, "pack.yaml");
}

function usability(summary: AuditSummary): { passed: number; total: number; rate: number } {
  const passed = summary.oracle_passed ?? summary.passed;
  const total = summary.runnable_tasks ?? summary.eligible;
  if (passed === undefined || total === undefined || total <= 0 || passed < 0 || passed > total) {
    throw new Error("model audit has an invalid usability summary");
  }
  return { passed, total, rate: passed / total };
}

function strict(summary: AuditSummary): { passed: number; total: number; rate: number } | null {
  if (summary.strict_passed === undefined || summary.runnable_tasks === undefined) return null;
  return {
    passed: summary.strict_passed,
    total: summary.runnable_tasks,
    rate: summary.strict_passed / summary.runnable_tasks,
  };
}

function average(values: readonly number[]): number {
  if (!values.length) throw new Error("cannot average an empty list");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (!values.length) throw new Error("cannot take the median of an empty list");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function aggregate(cells: Array<{
  usability: { passed: number; total: number; rate: number };
  discovery: { score: number };
  strict: { passed: number; total: number; rate: number } | null;
  efficiency: { duration_ms: number; first_action_latency_ms: number | null };
  economics: { cost_usd: number | null; token_usage: TokenUsage | null };
}>) {
  const passed = cells.reduce((sum, cell) => sum + cell.usability.passed, 0);
  const total = cells.reduce((sum, cell) => sum + cell.usability.total, 0);
  const usabilityRate = total ? passed / total : 0;
  const discoveryRate = average(cells.map((cell) => cell.discovery.score));
  const strictAvailable = cells.every((cell) => cell.strict !== null);
  const strictPassed = strictAvailable ? cells.reduce((sum, cell) => sum + cell.strict!.passed, 0) : null;
  const strictTotal = strictAvailable ? cells.reduce((sum, cell) => sum + cell.strict!.total, 0) : null;
  const durations = cells.map((cell) => cell.efficiency.duration_ms);
  const firstActions = cells.flatMap((cell) => cell.efficiency.first_action_latency_ms === null ? [] : [cell.efficiency.first_action_latency_ms]);
  const reportedCosts = cells.flatMap((cell) => cell.economics.cost_usd === null ? [] : [cell.economics.cost_usd]);
  const costCoveredTaskObservations = cells
    .filter((cell) => cell.economics.cost_usd !== null)
    .reduce((sum, cell) => sum + cell.usability.total, 0);
  return {
    task_observations: total,
    tasks_passed: passed,
    usability_rate: usabilityRate,
    discovery_cells: cells.length,
    discovery_rate: discoveryRate,
    ax_composite: axCompositeScore(usabilityRate, discoveryRate).ax_score,
    strict_gid_oracle_passed: strictPassed,
    strict_gid_oracle_total: strictTotal,
    strict_gid_oracle_rate: strictPassed !== null && strictTotal ? strictPassed / strictTotal : null,
    efficiency: {
      coverage: `${durations.length}/${cells.length}`,
      total_duration_ms: durations.reduce((sum, value) => sum + value, 0),
      mean_duration_ms: average(durations),
      median_duration_ms: median(durations),
      first_action_coverage: `${firstActions.length}/${cells.length}`,
      mean_first_action_latency_ms: firstActions.length ? average(firstActions) : null,
      mean_seconds_per_task_observation: total ? durations.reduce((sum, value) => sum + value, 0) / 1000 / total : null,
    },
    economics: {
      cost_coverage: `${reportedCosts.length}/${cells.length}`,
      cost_covered_task_observations: costCoveredTaskObservations,
      total_reported_cost_usd: reportedCosts.length ? reportedCosts.reduce((sum, value) => sum + value, 0) : null,
      mean_reported_cost_usd_per_cell: reportedCosts.length ? average(reportedCosts) : null,
      reported_cost_usd_per_task_observation: reportedCosts.length && costCoveredTaskObservations
        ? reportedCosts.reduce((sum, value) => sum + value, 0) / costCoveredTaskObservations
        : null,
    },
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function seconds(value: number | null): string {
  return value === null ? "N/A" : `${(value / 1000).toFixed(1)}s`;
}

function dollars(value: number | null): string {
  return value === null ? "N/A" : `$${value.toFixed(3)}`;
}

function renderMarkdown(report: any): string {
  const lines = [
    "# DAEB v2 complete local result matrix",
    "",
    "Every row is one observed `vendor × harness × model × trial` cell. The release cohort and comparative appendix are kept separate.",
    "",
    "## Aggregate lanes",
    "",
    "| cohort | lane | cells | task usability | discovery | AX | strict | mean cell | first action | cost coverage | reported cost |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const lane of report.lanes) {
    lines.push(`| ${lane.include_in_release_total ? "release" : "appendix"} | ${lane.id} | ${lane.cells.length} | ${lane.tasks_passed}/${lane.task_observations} (${percent(lane.usability_rate)}) | ${percent(lane.discovery_rate)} | ${percent(lane.ax_composite)} | ${lane.strict_gid_oracle_passed === null ? "N/A" : `${lane.strict_gid_oracle_passed}/${lane.strict_gid_oracle_total}`} | ${seconds(lane.efficiency.mean_duration_ms)} | ${seconds(lane.efficiency.mean_first_action_latency_ms)} | ${lane.economics.cost_coverage} | ${dollars(lane.economics.total_reported_cost_usd)} |`);
  }
  lines.push(
    "",
    "## Every cell",
    "",
    "| cohort | vendor | harness | model | trial | task pass | discovery | AX | strict | latency | first action | reported cost |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const lane of report.lanes) {
    for (const cell of lane.cells) {
      const cellAx = axCompositeScore(cell.usability.rate, cell.discovery.score).ax_score;
      lines.push(`| ${lane.include_in_release_total ? "release" : "appendix"} | ${cell.vendor} | ${lane.harness} | ${lane.model} | ${cell.trial} | ${cell.usability.passed}/${cell.usability.total} | ${percent(cell.discovery.score)} | ${percent(cellAx)} | ${cell.strict === null ? "N/A" : `${cell.strict.passed}/${cell.strict.total}`} | ${seconds(cell.efficiency.duration_ms)} | ${seconds(cell.efficiency.first_action_latency_ms)} | ${dollars(cell.economics.cost_usd)} |`);
    }
  }
  lines.push(
    "",
    "## Interpretation boundary",
    "",
    "- Provider-oracle task success remains the primary behavioral metric; AX is a secondary harmonic composite of usability and cell-level discovery.",
    "- Discovery was observed once before each cell's task batch, not independently for every task.",
    "- Latency is complete cell wall time. Per-task latency is only an aggregate normalization, not independently timed task latency.",
    "- `N/A` cost means the harness did not report cost. It does not mean zero cost, and no list-price estimate is substituted.",
    "- OpenCode GLM 5.2 is a comparative appendix and is not pooled into the release total.",
    "",
    "## Recommendations",
    "",
    "1. Publish provider-oracle usability as the primary result, with discovery, strictness, latency, and reported cost as separate panels.",
    "2. Keep OpenCode GLM 5.2 in a labelled comparative appendix until it is rerun under the exact release cohort policy.",
    "3. Do not publish a cross-harness cost ranking until Codex and OpenCode provide observed cost telemetry; `N/A` is not zero.",
    "4. Add task-level start/finish events in the next runner revision. Current latency is exact per cell, but per-task latency is only an aggregate normalization.",
    "5. For the next pack revision, run discovery per task family or with isolated cold starts; the current once-per-cell discovery measurement remains relatively saturated.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const policyPath = insideRoot(process.argv[2] ?? DEFAULT_POLICY, "policy path");
  const policy = PolicySchema.parse(yamlParse(readFileSync(policyPath, "utf8")));
  const scoredSignalIds = new Set<DiscoveryMetric["id"]>(policy.policy.discovery_signals);
  const noOutcomeClient = {
    get: async () => { throw new Error("discovery outcome network read-back is not allowed in the post-hoc local audit"); },
  } as unknown as BearerClient;

  const lanes = [];
  for (const lane of policy.lanes) {
    const cells = [];
    const identities = new Set<string>();
    for (const source of lane.evidence) {
      for (const trial of source.trials) {
        const dir = insideRoot(resolve(ROOT, source.root, `trial-${trial}`), "evidence directory");
        const auditPath = resolve(dir, "model-audit.json");
        if (!existsSync(auditPath)) throw new Error(`missing model audit: ${relative(ROOT, auditPath)}`);
        const resultPath = onlyFile(dir, /^run-.*-cli\.json$/, "executor result");
        const invokePath = onlyFile(dir, /^run-.*-cli\.invoke\.json$/, "invoke telemetry");
        const transcriptPath = onlyFile(dir, /^run-.*-cli\.transcript\.jsonl$/, "harness transcript");
        const audit = readJson<ModelAudit>(auditPath);
        const executor = readJson<ExecutorRecord>(resultPath);
        const invoke = readJson<InvokeRecord>(invokePath);
        if (!Number.isFinite(invoke.durationMs) || invoke.durationMs < 0) {
          throw new Error(`invoke telemetry has invalid duration: ${relative(ROOT, invokePath)}`);
        }
        const packFile = packPath(source.vendor, lane.track);
        const pack = loadPack(packFile);
        if (!pack.discovery?.product) throw new Error(`${source.vendor} pack has no discovery specification`);
        if (pack.discovery.outcome) throw new Error(`${source.vendor} discovery outcome is not eligible for offline post-hoc scoring`);
        if (audit.vendor !== source.vendor || audit.trial !== trial || audit.model !== lane.model) {
          throw new Error(`model audit identity mismatch in ${relative(ROOT, auditPath)}`);
        }
        if (executor.harness !== lane.harness || executor.model !== lane.model) {
          throw new Error(`executor identity mismatch in ${relative(ROOT, resultPath)}`);
        }
        identities.add(`${source.vendor}:${trial}`);
        const parsed = parseTranscriptWithDiagnostics(transcriptPath, {
          harness: lane.harness,
          cliBin: pack.surfaces?.cli?.bin,
          cliBins: [pack.name, `@${pack.name}/cli`],
        });
        if (parsed.diagnostics.recognized === 0 || parsed.diagnostics.emitted === 0) {
          throw new Error(`transcript decoder recognized no usable events: ${relative(ROOT, transcriptPath)}`);
        }
        const discoveryReport = await scoreDiscovery(
          pack.discovery,
          observedToDiscovery(parsed.run, executor.ns, "cli"),
          noOutcomeClient,
          { surface: "cli", apiStyle: pack.api_style },
        );
        const score = discoveryScore(discoveryReport);
        if (score === null) throw new Error(`discovery was not scoreable: ${relative(ROOT, transcriptPath)}`);
        const signals = Object.fromEntries(discoveryReport.metrics
          .filter((metric) => scoredSignalIds.has(metric.id))
          .map((metric) => [metric.id, metric.passed]));
        if (Object.keys(signals).length !== scoredSignalIds.size) {
          throw new Error(`discovery signal set mismatch: ${relative(ROOT, transcriptPath)}`);
        }
        cells.push({
          vendor: source.vendor,
          trial,
          artifact_dir: relative(ROOT, dir),
          input_sha256: {
            model_audit: sha256(auditPath),
            executor_result: sha256(resultPath),
            invoke_telemetry: sha256(invokePath),
            transcript: sha256(transcriptPath),
            pack: sha256(packFile),
          },
          decoder: {
            id: parsed.diagnostics.decoder,
            version: parsed.diagnostics.decoderVersion,
            recognized_events: parsed.diagnostics.recognized,
            emitted_events: parsed.diagnostics.emitted,
            malformed_events: parsed.diagnostics.malformed,
          },
          usability: usability(audit.summary),
          discovery: {
            source: "observed" as const,
            score,
            hops: discoveryReport.hops,
            signals,
          },
          strict: strict(audit.summary),
          efficiency: {
            duration_ms: invoke.durationMs,
            first_action_latency_ms: invoke.first_action_latency_ms ?? null,
          },
          economics: {
            source: invoke.metrics?.cost_usd == null ? "unavailable" as const : "harness-reported" as const,
            cost_usd: invoke.metrics?.cost_usd ?? null,
            token_usage: invoke.metrics?.token_usage ?? null,
          },
        });
      }
    }
    if (identities.size !== cells.length) throw new Error(`lane ${lane.id} contains duplicate vendor/trial identities`);
    const vendors = [...new Set(cells.map((cell) => cell.vendor))].sort().map((vendor) => {
      const vendorCells = cells.filter((cell) => cell.vendor === vendor);
      return { vendor, ...aggregate(vendorCells) };
    });
    lanes.push({
      id: lane.id,
      track: lane.track,
      include_in_release_total: lane.include_in_release_total,
      harness: lane.harness,
      model: lane.model,
      ...aggregate(cells),
      vendors,
      cells,
    });
  }

  const releaseCells = lanes.filter((lane) => lane.include_in_release_total).flatMap((lane) => lane.cells);
  const outputPath = insideRoot(policy.output, "output path");
  const report = {
    schema: "ax.daeb-v2-local-ax-scorecard/v1",
    generated_at: new Date().toISOString(),
    release_id: policy.release_id,
    trust_level: "local",
    surface: "cli",
    source_policy: relative(ROOT, policyPath),
    source_policy_sha256: sha256(policyPath),
    policy: policy.policy,
    release_total: aggregate(releaseCells),
    lanes,
    publication_boundary: {
      official_hosted_trusted: false,
      note: "Observed discovery is reconstructed from retained local transcripts; this scorecard does not upgrade the trust level of the underlying runs.",
    },
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const markdownPath = insideRoot(policy.markdown_output, "markdown output path");
  writeFileSync(markdownPath, renderMarkdown(report), { mode: 0o600 });
  console.log(`${outputPath}\n${JSON.stringify({ release_total: report.release_total, lanes: lanes.map((lane) => ({ id: lane.id, usability_rate: lane.usability_rate, discovery_rate: lane.discovery_rate, ax_composite: lane.ax_composite })) }, null, 2)}`);
}

await main();
