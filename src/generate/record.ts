/**
 * The normalized result record — the single schema decision that makes results
 * aggregatable across runs. Every run/verify produces one record per
 * { surface, product, harness } cell. The skill computes the surface × product
 * plane locally; records from many harnesses can be aggregated later to add the
 * third axis (which agent ran) without re-deriving anything.
 *
 * Keep this schema stable and additive: downstream aggregation keys off the
 * triple + `schema` version, so renaming/removing a field is a breaking change.
 */
import type { SurfaceId } from "../surface/types.js";
import type { TargetPack } from "../schemas.js";
import type { ProfileRun } from "./report.js";
import type { RoundtripOutcome } from "./verify.js";
import type { DiscoveryReport } from "./discovery.js";

export const NORMALIZED_RESULT_SCHEMA = "ax.normalized-result/v1" as const;

export type BlockedReason = "requires-oauth" | "missing-credential" | "missing-harness" | "invoke-failed";

export interface NormalizedResult {
  schema: typeof NORMALIZED_RESULT_SCHEMA;
  /** Axis 1 — how the agent drove the product. */
  surface: SurfaceId;
  /** Axis 2 — the product under test (pack name). */
  product: string;
  /** Axis 3 — the harness/agent the tasks ran in. */
  harness: string;
  /** The frozen task set the score is comparable within. */
  standard_set_version: string;
  generated_at: string;
  /** Tasks in the set, and how many the best profile solved on its first attempt. */
  tasks_total: number;
  tasks_passed: number;
  /** Best-profile pass@1 (first attempt) and pass@k (solved on ≥1 attempt), 0–1. */
  pass_at_1: number;
  pass_at_k: number;
  /** Attempts per task (k); 1 when the run wasn't repeated. */
  attempts: number;
  /** Best-profile discovery score = fraction of scored signals passed (hops
   *  excluded — it's an efficiency measure, not pass/fail). null if unmeasured. */
  discovery_score: number | null;
  /** Content-quality (OpenAPI smell) score, 0–1 (the v3 audit's 0–100 score
   *  divided by 100). Orthogonal to discovery: "once found, is the spec usable?"
   *  null when no openapi_url was configured / the audit didn't run. */
  content_quality: number | null;
  /** Profiles that contributed (e.g. floor, ceiling) — provenance, not a key. */
  profiles: string[];
  /** The profile whose metrics this record reports (the strongest one). */
  best_profile: string | null;
  /** The model the best profile ACTUALLY ran as (ground truth, stamped from
   *  harness output). Lets `competitive` compare the same product/surface across
   *  models. null when no run stamped a model (older records). */
  model: string | null;
  /** Efficiency diagnostics for the best profile. These are explanatory only:
   *  correctness is still governed by deterministic outcome graders. */
  latency_ms?: number | null;
  tool_call_count?: number | null;
  token_usage?: Record<string, number> | null;
  token_cost?: number | null;
  /** Runtime validity diagnostics are explanatory only. They separate harness
   *  runtime issues (for example, no-action timeouts) from vendor capability. */
  validity_status?: string | null;
  first_action_latency_ms?: number | null;
  transcript_event_count?: number | null;
  action_occurred?: boolean | null;
  summary_kind?: "single" | "aggregate";
  trial_count?: number;
  trial_values?: number[];
  mean_pass_rate?: number;
  range_pass_rate?: { min: number; max: number };
  pass_all_3?: number | null;
  source_records?: string[];
  /** When set, this cell was NOT evaluated on this surface and its metrics are
   *  not meaningful. The cube renders it as a distinct state (never a misleading
   *  0%): "requires-oauth" (OAuth-only surface, no headless token), or
   *  "missing-credential" (the developer hasn't set the surface's token). */
  blocked?: BlockedReason;
}

/** First attempt per task id, in task order — pass@1 is computed over these. */
function firstAttempts(outcomes: RoundtripOutcome[]): RoundtripOutcome[] {
  const seen = new Set<string>();
  const out: RoundtripOutcome[] = [];
  for (const o of outcomes) {
    if (seen.has(o.taskId)) continue;
    seen.add(o.taskId);
    out.push(o);
  }
  return out;
}

/** Solved-on-any-attempt count + max attempts observed (pass@k numerator / k).
 *  N/A tasks (per DAEB-1 methodology) are excluded from both solved and tasks. */
function passAtK(outcomes: RoundtripOutcome[]): { solved: number; tasks: number; k: number } {
  const byTask = new Map<string, RoundtripOutcome[]>();
  for (const o of outcomes) {
    if (o.na) continue;
    const list = byTask.get(o.taskId) ?? [];
    list.push(o);
    byTask.set(o.taskId, list);
  }
  let k = 1;
  let solved = 0;
  for (const os of byTask.values()) {
    k = Math.max(k, os.length);
    if (os.some((o) => o.success)) solved += 1;
  }
  return { solved, tasks: byTask.size, k };
}

/** Discovery score = passed / scored signals, excluding the `hops` efficiency
 *  metric (and `outcome`, which duplicates task success). null when unscored. */
export function discoveryScore(report: DiscoveryReport | undefined): number | null {
  if (!report) return null;
  const scored = report.metrics.filter((m) => m.id !== "hops" && m.id !== "outcome");
  if (!scored.length) return null;
  return scored.filter((m) => m.passed).length / scored.length;
}

function passRateOf(outcomes: RoundtripOutcome[]): number {
  const scored = outcomes.filter((o) => !o.na);
  return scored.length ? scored.filter((o) => o.success).length / scored.length : 0;
}

/** The strongest profile run (highest first-attempt pass rate), or null. */
function bestRun(runs: ProfileRun[]): ProfileRun | null {
  let best: { run: ProfileRun; rate: number } | null = null;
  for (const r of runs) {
    if (!r.outcomes.length) continue;
    const rate = passRateOf(firstAttempts(r.outcomes));
    if (!best || rate > best.rate) best = { run: r, rate };
  }
  return best?.run ?? null;
}

/**
 * Build the normalized record for one { surface, product, harness } cell from
 * the profile runs that produced it. Metrics report the strongest profile (the
 * existing report's "best agent" framing) so a cell is one comparable number.
 */
export function buildNormalizedResult(
  pack: TargetPack,
  surface: SurfaceId,
  harness: string,
  runs: ProfileRun[],
  /** Content-quality score 0–1 (the v3 smell audit, /100). null = not measured. */
  contentQuality: number | null = null,
): NormalizedResult {
  const best = bestRun(runs);
  const first = best ? firstAttempts(best.outcomes) : [];
  const { solved, tasks, k } = best ? passAtK(best.outcomes) : { solved: 0, tasks: 0, k: 1 };
  return {
    schema: NORMALIZED_RESULT_SCHEMA,
    surface,
    // The cube keys on product IDENTITY, not provenance. A pack auto-generated
    // from a spec carries a "-generated" suffix to disambiguate it from a
    // hand-curated pack during development, but in the competitive report it is
    // the same product ("asana-generated" → "asana").
    product: pack.name.replace(/-generated$/, ""),
    harness,
    standard_set_version: pack.standard_set_version,
    generated_at: new Date().toISOString(),
    tasks_total: first.length,
    tasks_passed: first.filter((o) => o.success).length,
    pass_at_1: first.length ? first.filter((o) => o.success).length / first.length : 0,
    pass_at_k: tasks ? solved / tasks : 0,
    attempts: k,
    discovery_score: discoveryScore(best?.discovery),
    content_quality: contentQuality,
    profiles: runs.map((r) => r.profile),
    best_profile: best?.profile ?? null,
    model: best?.model ?? null,
    latency_ms: best?.efficiency?.latency_ms ?? null,
    tool_call_count: best?.efficiency?.tool_call_count ?? null,
    token_usage: best?.efficiency?.token_usage ?? null,
    token_cost: best?.efficiency?.token_cost ?? null,
    validity_status: best?.efficiency?.validity_status ?? null,
    first_action_latency_ms: best?.efficiency?.first_action_latency_ms ?? null,
    transcript_event_count: best?.efficiency?.transcript_event_count ?? null,
    action_occurred: best?.efficiency?.action_occurred ?? null,
    summary_kind: "single",
  };
}

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function range(values: number[]): { min: number; max: number } | null {
  return values.length ? { min: Math.min(...values), max: Math.max(...values) } : null;
}

function averageTokenUsage(records: NormalizedResult[]): Record<string, number> | null {
  const totals = new Map<string, { sum: number; count: number }>();
  for (const record of records) {
    if (!record.token_usage) continue;
    for (const [key, value] of Object.entries(record.token_usage)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const bucket = totals.get(key) ?? { sum: 0, count: 0 };
      bucket.sum += value;
      bucket.count += 1;
      totals.set(key, bucket);
    }
  }
  if (!totals.size) return null;
  return Object.fromEntries([...totals.entries()].map(([key, bucket]) => [key, bucket.sum / bucket.count]));
}

export function aggregateNormalizedResults(
  records: NormalizedResult[],
  sourceRecords: string[] = [],
): NormalizedResult {
  if (records.length === 0) throw new Error("aggregateNormalizedResults requires at least one trial record.");
  const first = records[0]!;
  const passValues = records.map((record) => record.pass_at_1);
  const latencies = records.flatMap((record) => typeof record.latency_ms === "number" ? [record.latency_ms] : []);
  const toolCalls = records.flatMap((record) => typeof record.tool_call_count === "number" ? [record.tool_call_count] : []);
  const tokenCosts = records.flatMap((record) => typeof record.token_cost === "number" ? [record.token_cost] : []);
  const firstActionLatencies = records.flatMap((record) =>
    typeof record.first_action_latency_ms === "number" ? [record.first_action_latency_ms] : []);
  const transcriptEvents = records.flatMap((record) =>
    typeof record.transcript_event_count === "number" ? [record.transcript_event_count] : []);
  const meanPassRate = average(passValues) ?? 0;
  const passRange = range(passValues) ?? { min: 0, max: 0 };
  const attempts = Math.max(...records.map((record) => record.attempts || 1));
  const validities = [...new Set(records.map((record) => record.validity_status).filter((value): value is string => Boolean(value)))];
  const models = [...new Set(records.map((record) => record.model).filter((value): value is string => Boolean(value)))];
  return {
    ...first,
    generated_at: new Date().toISOString(),
    tasks_passed: Math.round(meanPassRate * first.tasks_total),
    pass_at_1: meanPassRate,
    pass_at_k: average(records.map((record) => record.pass_at_k)) ?? meanPassRate,
    attempts,
    discovery_score: average(records.flatMap((record) => record.discovery_score === null ? [] : [record.discovery_score])),
    content_quality: average(records.flatMap((record) => record.content_quality === null ? [] : [record.content_quality])),
    profiles: [...new Set(records.flatMap((record) => record.profiles))],
    best_profile: first.best_profile,
    model: models.length === 1 ? models[0]! : (first.model ?? null),
    latency_ms: average(latencies),
    tool_call_count: average(toolCalls),
    token_usage: averageTokenUsage(records),
    token_cost: average(tokenCosts),
    validity_status: validities.length === 1 ? validities[0] : validities.join(","),
    first_action_latency_ms: average(firstActionLatencies),
    transcript_event_count: average(transcriptEvents),
    action_occurred: records.some((record) => record.action_occurred === true),
    summary_kind: "aggregate",
    trial_count: records.length,
    trial_values: passValues,
    mean_pass_rate: meanPassRate,
    range_pass_rate: passRange,
    pass_all_3: records.length === 3 ? (records.every((record) => record.pass_at_1 >= 1) ? 1 : 0) : null,
    source_records: sourceRecords,
  };
}

function cellKey(run: ProfileRun, fallbackHarness: string): string {
  return `${run.harness ?? fallbackHarness}\0${run.surface ?? "api"}`;
}

function cellFileStem(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export interface NormalizedResultCell {
  harness: string;
  surface: SurfaceId;
  fileStem: string;
  runs: ProfileRun[];
  record: NormalizedResult;
}

/** Build one normalized record per actual {harness, surface} cell in a mixed
 *  report. A single HTML report can summarize many cells, but competitive
 *  aggregation wants these durable records at cell granularity. */
export function buildNormalizedResultCells(
  pack: TargetPack,
  runs: ProfileRun[],
  contentQuality: number | null = null,
  fallbackHarness = "unknown",
): NormalizedResultCell[] {
  const grouped = new Map<string, ProfileRun[]>();
  for (const run of runs) {
    const key = cellKey(run, fallbackHarness);
    grouped.set(key, [...(grouped.get(key) ?? []), run]);
  }
  return [...grouped.values()].map((cellRuns) => {
    const harness = cellRuns.find((r) => r.harness)?.harness ?? fallbackHarness;
    const surface = cellRuns.find((r) => r.surface)?.surface ?? "api";
    return {
      harness,
      surface,
      fileStem: `${cellFileStem(harness)}.${surface}`,
      runs: cellRuns,
      record: buildNormalizedResult(pack, surface, harness, cellRuns, contentQuality),
    };
  });
}

/**
 * Build a "blocked" cube cell for a surface that can't be evaluated headlessly
 * (no credential / OAuth-only). Metrics are zeroed and `blocked` is set so the
 * competitive report shows an honest "blocked" state instead of a 0% that would
 * read as "the agent failed". Emitted by exec-plan when a requested surface is
 * unauthenticated, so the cube still has a cell documenting why.
 */
export function buildBlockedResult(
  pack: TargetPack,
  surface: SurfaceId,
  harness: string,
  blocked: BlockedReason,
): NormalizedResult {
  return {
    schema: NORMALIZED_RESULT_SCHEMA,
    surface,
    product: pack.name.replace(/-generated$/, ""),
    harness,
    standard_set_version: pack.standard_set_version,
    generated_at: new Date().toISOString(),
    tasks_total: 0,
    tasks_passed: 0,
    pass_at_1: 0,
    pass_at_k: 0,
    attempts: 1,
    discovery_score: null,
    content_quality: null,
    profiles: [],
    best_profile: null,
    model: null,
    latency_ms: null,
    tool_call_count: null,
    token_usage: null,
    token_cost: null,
    validity_status: null,
    first_action_latency_ms: null,
    transcript_event_count: null,
    action_occurred: null,
    summary_kind: "single",
    blocked,
  };
}
