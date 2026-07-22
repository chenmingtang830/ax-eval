/**
 * Render a generated-pack eval as a self-contained, design-system-ready HTML
 * report. Structure (top → bottom): header · optional CI-gate banner · verdict +
 * scorecard · key findings · recommendations · scores at a glance · robustness
 * (pass@k) · trace checks (structural diff) · methodology/provenance · appendix
 * (per-task oracle results + observed API calls).
 *
 * The HTML is intentionally lightly styled: semantic HTML5 + CSS custom
 * properties on :root + namespaced `ax-*` classes, so a design system can
 * restyle it later without touching structure. All interpolated text is escaped.
 */
import type { DiscoverySpec, TargetPack } from "../schemas.js";
import type { RoundtripOutcome } from "./verify.js";
import type { DiscoveryReport } from "./discovery.js";
import { tasksForSurface, type SurfaceId } from "../surface/types.js";
import { NORMALIZED_RESULT_SCHEMA, type NormalizedResult } from "./record.js";
import type { TraceStep } from "../harness/executor.js";
import { diffTrace, type TraceDiff } from "../harness/trace-diff.js";
import {
  getProfile,
  CONTROLLED_VARIABLES,
  VARIED_VARIABLE,
  type HarnessProfile,
} from "../harness/profile.js";
import type { HarnessProbe } from "../harness/probe.js";
import { REPORT_STYLE } from "../report-style.js";
import { renderContentQualitySection, type SpecQualityAudit } from "../static/smells.js";
import type { StaticCheckResult } from "../static/types.js";

export interface ProfileRun {
  profile: string;
  /** Concrete harness/agent CLI that produced this run, when known. */
  harness?: string;
  /** The model the harness ACTUALLY ran as (ground truth, stamped from harness
   *  output). Preferred over the profile's hardcoded label in the report. */
  model?: string;
  outcomes: RoundtripOutcome[];
  /** Surface this run drove the product through (api/cli/sdk/mcp). Defaults to
   *  "api" when unset so single-surface reports are unchanged. Used to tag the
   *  normalized record + group the cross-surface comparison. */
  surface?: SurfaceId;
  /** Per-execution namespace (resource-name suffix) this run used. */
  ns?: string;
  /** This profile's Phase-0 discovery score (behavioral AEO). */
  discovery?: DiscoveryReport;
  /** Provenance of the discovery score: objective (parsed from the harness
   *  transcript) vs the agent's self-report. */
  discoverySource?: "observed" | "self-report";
  /** Structured step log for observability (optional). */
  trace?: TraceStep[];
  /** Whether trace events carry trustworthy task IDs. Native harness events are
   * objective but unattributed, so task-scoped structural diffs must not run. */
  traceAttribution?: "task-scoped" | "unattributed";
  /** Efficiency diagnostics. These never affect correctness; deterministic
   *  read-back outcomes remain the only pass/fail authority. */
  efficiency?: {
    latency_ms?: number | null;
    total_duration_ms?: number | null;
    tool_call_count?: number | null;
    token_usage?: Record<string, number> | null;
    token_cost?: number | null;
    cost_usd?: number | null;
    harness_version_raw?: string | null;
    harness_version_semver?: string | null;
    run_batch_id?: string | null;
    validity_status?: string | null;
    first_action_latency_ms?: number | null;
    transcript_event_count?: number | null;
    action_occurred?: boolean | null;
  };
  /** Source files this run was assembled from. Surfaced verbatim in the report
   *  so a reader can drill from the rendered HTML back to the raw evidence
   *  (results JSON, trace JSON, harness transcript). Multi-attempt runs hold
   *  one entry per attempt for `results`/`trace`; `transcript` is per-profile. */
  evidence?: {
    results?: string[];
    trace?: string[];
    transcript?: string;
  };
}

/**
 * The static (agent-readiness) side of the gap, measured against the same target
 * the behavioral run hit. `v0` = conventional-path checklist; `v2` = agent-style
 * docs-graph crawl. Either may be absent (network-skipped).
 */
export interface StaticReadiness {
  site: string;
  v0Score?: number;
  v2Score?: number;
  /** The per-check v0 breakdown (llms.txt, OpenAPI, sitemap, …) behind v0Score, so
   *  the report can show exactly where static-discovery points were lost. */
  v0Checks?: StaticCheckResult[];
  source?: string;
  /** v3 content-quality (OpenAPI smell) score, 0–100. Orthogonal to v0/v2:
   *  those ask whether docs are *findable*; this asks whether the spec, once
   *  found, is *usable*. Absent when no openapi_url is configured. */
  contentScore?: number;
  /** The full smell audit behind `contentScore`, rendered as its own report
   *  section. Absent when the audit didn't run. */
  contentQuality?: SpecQualityAudit;
}

/** One actionable, prioritized recommendation produced by the engine below. */
export interface Recommendation {
  category?: "discovery" | "execution";
  priority: "high" | "med" | "low";
  title: string;
  detail: string;
  /** Agent-actionable triple — what to change, the evidence behind it, and the
   *  concrete fix. Rendered as labeled rows so the HTML can be handed to a coding
   *  agent. Optional + back-compat: recs without them just render `detail`. */
  target?: string;
  evidence?: string;
  fix?: string;
}

interface Finding {
  category: "discovery" | "execution";
  detail: string;
}

const DIFFS = ["L1", "L2", "L3", "L4"];

const METRIC_LABEL: Record<string, string> = {
  official: "Reached official docs",
  canonical: "Found canonical endpoint",
  hops: "Discovery efficiency (hops)",
  misled: "Avoided outdated/wrong source",
  auth: "Discovered auth scheme",
  outcome: "Completed the goal (round-trip)",
};

const METRIC_FAILURE_LABEL: Record<string, string> = {
  official: "did not reach official docs",
  canonical: "did not find the canonical endpoint",
  hops: "needed too many discovery hops",
  misled: "used an outdated or wrong source",
  auth: "did not discover the auth scheme",
  outcome: "did not complete the goal",
};

/** Signal ids whose failure plausibly blocks downstream execution. Only
 *  `canonical` blocks: an agent can complete tasks without ever opening the
 *  official docs (reaching `official`) as long as it found the right endpoint,
 *  so gating on `official` over-fires "discovery-blocked?" on real successes. */
const BLOCKING_SIGNALS = ["canonical"] as const;

// ---------------------------------------------------------------------------
// Pure analysis helpers (shared by the recommendations engine + the renderer).
// ---------------------------------------------------------------------------

/** N/A tasks (per DAEB methodology) are excluded from both the numerator
 *  and denominator of any pass-rate figure — they're disclosed separately,
 *  never silently counted as failures. */
function scoredOutcomes(outcomes: RoundtripOutcome[]): RoundtripOutcome[] {
  return outcomes.filter((o) => !o.na);
}

function passCount(outcomes: RoundtripOutcome[]): number {
  return scoredOutcomes(outcomes).filter((o) => o.success).length;
}

function pct(outcomes: RoundtripOutcome[]): number {
  const scored = scoredOutcomes(outcomes);
  return scored.length ? Math.round((passCount(outcomes) / scored.length) * 100) : 0;
}

/** First attempt per task id, in order. A merged multi-attempt run holds one
 *  outcome per (task × attempt); the headline tables (matrix, difficulty, best%)
 *  report **pass@1** over these so the number is defined regardless of attempts.
 *  The Robustness section owns the full pass@k / all-k / flaky story. */
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

/** "2/3 (67%)" label for a set of outcomes (N/A tasks excluded from the total). */
function rateLabel(outcomes: RoundtripOutcome[]): string {
  return `${passCount(outcomes)}/${scoredOutcomes(outcomes).length} (${pct(outcomes)}%)`;
}

function runLabel(run: ProfileRun): string {
  // harness/surface/profile so configs that share harness+profile across surfaces
  // (e.g. claude-code/api/low vs claude-code/mcp/low) are distinguishable.
  const h = run.harness ?? "host-agent";
  const s = (run.surface ?? "api").toUpperCase();
  return `${h}/${s}/${run.profile}`;
}

/** Overall pass rate (0–1) across every recorded outcome (all profiles/attempts). */
function overallRate(runs: ProfileRun[]): number {
  const outcomes = runs.flatMap((r) => r.outcomes);
  if (!outcomes.length) return 0;
  return outcomes.filter((o) => o.success).length / outcomes.length;
}

/**
 * Per-task robustness for one profile. When a pack is run with `--attempts N`,
 * the merged run holds N outcomes per task id. Grouping by task id recovers the
 * attempt vector so we can report pass@k (any attempt) vs all-k (robust) and flag
 * flaky tasks (0 < passes < attempts). This is host-agent reliability across
 * repeated attempts — not a comparison across models or agents.
 */
interface TaskRobustness {
  taskId: string;
  difficulty: string;
  attempts: number;
  passes: number;
}

function robustnessByTask(run: ProfileRun): TaskRobustness[] {
  const byTask = new Map<string, RoundtripOutcome[]>();
  for (const o of run.outcomes) {
    const list = byTask.get(o.taskId) ?? [];
    list.push(o);
    byTask.set(o.taskId, list);
  }
  return [...byTask.entries()].map(([taskId, os]) => ({
    taskId,
    difficulty: os[0]!.difficulty,
    attempts: os.length,
    passes: os.filter((o) => o.success).length,
  }));
}

/** Max attempts observed for any task in any profile (1 ⇒ no repetition). */
function maxAttempts(runs: ProfileRun[]): number {
  let max = 1;
  for (const r of runs) {
    for (const t of robustnessByTask(r)) max = Math.max(max, t.attempts);
  }
  return max;
}

/** True if this profile's discovery is weak enough to have blocked its tasks. */
function discoveryWeak(report: DiscoveryReport | undefined): boolean {
  if (!report) return false;
  return BLOCKING_SIGNALS.some((id) => report.metrics.find((m) => m.id === id)?.passed === false);
}

/**
 * A task is "plan-limited" (not a product/docs gap, not an agent miss) when the
 * executor's trace shows the API rejected it for plan-tier reasons — a 402 or a
 * premium/enterprise/business marker. Read off the trace so it's evidence-based.
 */
function planLimited(trace: TraceStep[] | undefined, taskId: string): boolean {
  return (trace ?? []).some(
    (s) =>
      s.taskId === taskId &&
      (s.status === 402 || /\b402\b|premium|enterprise|business plan|only available/i.test(s.note ?? "")),
  );
}

function taskById(pack: TargetPack): Map<string, TargetPack["tasks"][number]> {
  return new Map(pack.tasks.map((t) => [t.id, t]));
}

function taskDescriptor(pack: TargetPack, taskId: string): string {
  const task = taskById(pack).get(taskId);
  if (!task) return taskId;
  const path = task.create_path ? ` (${task.create_path})` : "";
  return `${task.id}${path}`;
}

function inferredCapability(pack: TargetPack, taskId: string): string {
  const task = taskById(pack).get(taskId);
  const hay = `${taskId} ${task?.title ?? ""} ${task?.prompt ?? ""} ${task?.create_path ?? ""}`.toLowerCase();
  if (hay.includes("portfolio")) return "add project to portfolio";
  if (hay.includes("project_brief") || hay.includes("project brief")) return "create project brief";
  if (hay.includes("project_status") || hay.includes("project status")) return "create project status";
  if (hay.includes("archive")) return "archive/update project";
  if (hay.includes("section")) return "create project section";
  if (hay.includes("complete")) return "complete/update task";
  if (hay.includes("reschedule") || hay.includes("due date")) return "reschedule/update task";
  if (hay.includes("project")) return "create/update project";
  if (hay.includes("task")) return "create/update task";
  return taskId;
}

function traceCapability(step: TraceStep): string | null {
  const hay = `${step.taskId ?? ""} ${step.action ?? ""} ${step.method ?? ""} ${step.path ?? ""} ${step.note ?? ""}`.toLowerCase();
  if (hay.includes("portfolio") || hay.includes("additem")) return "add project to portfolio";
  if (hay.includes("project_brief") || hay.includes("project brief")) return "create project brief";
  if (hay.includes("archive") || hay.includes("archived")) return "archive/update project";
  return null;
}

function traceShowsCoverageGap(step: TraceStep): boolean {
  const hay = `${step.action ?? ""} ${step.path ?? ""} ${step.note ?? ""}`.toLowerCase();
  return (
    /no (mcp |discovered |exposed )?(tool|mutation|capabilit)/.test(hay) ||
    /tool (unavailable|not available|missing|not exposed)/.test(hay) ||
    /used rest api|rest fallback|fallback to rest|used curl|post curl|put curl/.test(hay)
  );
}

function traceShowsApprovalIssue(step: TraceStep): boolean {
  const hay = `${step.action ?? ""} ${step.note ?? ""}`.toLowerCase();
  return step.status === 499 || /user cancelled|approval|permission denied|cancelled mcp tool call/.test(hay);
}

function failureDetail(o: RoundtripOutcome): string {
  return o.error ?? (o.oracleResults.map((x) => x.detail).filter(Boolean).join("; ") || "oracle failed");
}

function runPassPct(run: ProfileRun): number {
  return pct(firstAttempts(run.outcomes));
}

function configLabel(run: ProfileRun): string {
  return `${run.harness ?? "host-agent"}/${(run.surface ?? "api").toUpperCase()}/${run.profile}`;
}

function configPassPcts(runs: ProfileRun[]): number[] {
  return runs.filter((r) => r.outcomes.length).map((r) => runPassPct(r));
}

function rangeLabel(nums: number[], unit = "%"): string {
  if (!nums.length) return "not measured";
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return lo === hi ? `${lo}${unit}` : `${lo}–${hi}${unit}`;
}

interface ProcessStats {
  run: ProfileRun;
  calls: number;
  failed: number;
  retryish: number;
  taskScoped: number;
  expectedTasks: number;
  opaqueCalls: number;
}

function countRetryishCalls(trace: TraceStep[] | undefined): number {
  const seen = new Map<string, number>();
  for (const s of trace ?? []) {
    if (!s.method || !s.path) continue;
    const key = `${s.taskId}:${s.method}:${s.path}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.values()].filter((n) => n > 1).length;
}

function processStats(runs: ProfileRun[]): ProcessStats[] {
  return runs.map((run) => {
    const trace = run.trace ?? [];
    const calls = trace.filter((s) => s.method || s.path);
    const expectedTasks = new Set(firstAttempts(run.outcomes).map((o) => o.taskId));
    const taskScoped = new Set(
      calls
        .map((s) => s.taskId)
        .filter((id): id is string => Boolean(id && expectedTasks.has(id))),
    ).size;
    const opaqueCalls = calls.filter((s) => !s.taskId || s.taskId === "all" || s.taskId === "observed").length;
    return {
      run,
      calls: calls.length,
      failed: calls.filter((s) => s.status !== undefined && s.status >= 400).length,
      retryish: countRetryishCalls(trace),
      taskScoped,
      expectedTasks: expectedTasks.size,
      opaqueCalls,
    };
  });
}

function worstProcessStats(runs: ProfileRun[]): ProcessStats | undefined {
  return processStats(runs)
    .filter((s) => s.calls || s.failed || s.retryish)
    .sort((a, b) => b.failed - a.failed || b.retryish - a.retryish || b.calls - a.calls)[0];
}

function hasInsufficientTraceCoverage(s: ProcessStats): boolean {
  if (s.expectedTasks === 0 || s.calls === 0) return false;
  // Task outcome correctness remains oracle-gated; this only decides whether
  // trace-derived process cleanliness is strong enough to claim as clean.
  const minimumScopedTasks = Math.min(s.expectedTasks, Math.max(2, Math.ceil(s.expectedTasks / 2)));
  return s.taskScoped < minimumScopedTasks || s.opaqueCalls / Math.max(1, s.calls) > 0.5;
}

function processStatsLabel(s: ProcessStats): string {
  return `${s.run.harness ?? "host-agent"}/${(s.run.surface ?? "api").toUpperCase()}/${s.run.profile}`;
}

function processQualityTakeaway(runs: ProfileRun[]): string {
  const worst = worstProcessStats(runs);
  if (!worst) return "Process quality was not measured from trace data.";
  if (hasInsufficientTraceCoverage(worst)) {
    return `Process trace coverage was insufficient in the noisiest recorded config (${processStatsLabel(worst)}: ${worst.calls} calls, ${worst.taskScoped}/${worst.expectedTasks} task-scoped). Treat process cleanliness and product attribution as requiring trace review; correctness is still decided by read-back outcomes.`;
  }
  if (worst.failed === 0 && worst.retryish === 0) {
    return `Process quality was clean in the noisiest recorded config (${processStatsLabel(worst)}: ${worst.calls} calls, no failed calls, no retry-ish repeats).`;
  }
  return `Process quality warning: ${processStatsLabel(worst)} needed ${worst.calls} calls with ${worst.failed} failed call${worst.failed === 1 ? "" : "s"} and ${worst.retryish} retry-ish repeat${worst.retryish === 1 ? "" : "s"}.`;
}

function usabilityLabel(taskPct: number | undefined, agentDiscovery: number | undefined): string {
  if (taskPct === undefined) return "Agent usability not measured";
  if (taskPct >= 100 && (agentDiscovery ?? 0) >= 80) return "Strong agent usability";
  if (taskPct >= 100) return "Strong execution, partial agent usability";
  if (taskPct >= 80) return "Partial agent usability";
  return "Weak agent usability";
}

function usabilityTakeaway(taskPct: number | undefined, agentDiscovery: number | undefined): string {
  if (taskPct === undefined) return "No live task run was available, so agent usability could not be scored.";
  if (taskPct >= 100 && (agentDiscovery ?? 0) >= 80) {
    return "Agents can find the right path and use the product successfully.";
  }
  if (taskPct >= 100) {
    return "Agents can use the product successfully once on the right path, but cold-start discovery is not yet as strong as execution.";
  }
  if (taskPct >= 80) {
    return "Agents can use much of the product, but some real workflows still fail round-trip verification.";
  }
  return "Agents cannot yet use the product reliably across the reviewed workflow set.";
}

/** Highest behavioral pass rate across profiles (the strongest agent config). */
function bestBehavioralPct(runs: ProfileRun[]): { pct: number; profile: string } | null {
  let best: { pct: number; profile: string } | null = null;
  for (const r of runs) {
    if (r.outcomes.length === 0) continue;
    const p = pct(firstAttempts(r.outcomes)); // pass@1 — defined regardless of attempts
    if (!best || p > best.pct) best = { pct: p, profile: r.profile };
  }
  return best;
}

/** Static readiness = best discoverability evidence by *either* strategy a real
 *  agent uses (conventional v0 paths or v2 crawl). Max keeps it stable when an
 *  SPA root yields no crawlable links. Undefined when nothing was measured. */
function readinessScore(stat?: StaticReadiness): number | undefined {
  if (!stat) return undefined;
  const scores = [stat.v0Score, stat.v2Score].filter((s): s is number => s !== undefined);
  return scores.length ? Math.max(...scores) : undefined;
}

/** Behavioral **agent discovery** score, 0–100: the fraction of scored Phase-0
 *  signals the strongest run passed (hops excluded — it's efficiency, not
 *  pass/fail). This is the agent-side counterpart to static discoverability,
 *  and a top-level pillar. Undefined when no run carried a scored funnel. */
function agentDiscoveryScore(runs: ProfileRun[]): number | undefined {
  const scored = runs.filter((r) => r.discovery && r.discovery.metrics.length);
  if (!scored.length) return undefined;
  // Use the strongest run's funnel (matches "best agent" framing elsewhere).
  const best = bestBehavioralPct(runs);
  const rep = (best && scored.find((r) => r.profile === best.profile)) ?? scored[0]!;
  const signals = rep.discovery!.metrics.filter((m) => m.id !== "hops");
  if (!signals.length) return undefined;
  return Math.round((signals.filter((m) => m.passed).length / signals.length) * 100);
}

// ---------------------------------------------------------------------------
// Recommendations engine.
// ---------------------------------------------------------------------------

/**
 * Turn the run + readiness data into an actionable, prioritized punch-list. Each
 * rule maps a concrete signal in the data to a fix, and classifies the failure
 * (discovery/AEO gap, product/docs gap, plan-limit, weak verification) so the
 * reader knows *who* should act.
 */
export function buildRecommendations(
  pack: TargetPack,
  runs: ProfileRun[],
  staticReadiness?: StaticReadiness,
): Recommendation[] {
  const recs: Recommendation[] = [];
  const best = bestBehavioralPct(runs);
  const strongest = best ? (runs.find((r) => r.profile === best.profile) ?? null) : null;
  const surface = dominantSurface(runs);
  // The docs-site crawl only reflects the agent's discovery path on the API
  // surface; for mcp/sdk/cli the gap-style recommendations below would conflate
  // a website-crawlability signal with tool usability, so we gate them.
  const gapMeaningful = staticReflectsAgentDiscovery(surface);

  // Representative discovery: prefer the strongest profile's, else any scored.
  const repDiscovery = strongest?.discovery ?? runs.find((r) => r.discovery)?.discovery;
  const missed = (id: string): boolean =>
    !!repDiscovery && repDiscovery.metrics.find((m) => m.id === id)?.passed === false;

  const v0 = staticReadiness?.v0Score;
  const v2 = staticReadiness?.v2Score;
  const readiness = readinessScore(staticReadiness);

  const mcpRuns = runs.filter((r) => (r.surface ?? "api") === "mcp");
  const coverageSignals: Array<{ run: ProfileRun; capability: string; taskId: string; detail: string }> = [];
  const approvalSignals: Array<{ run: ProfileRun; taskId: string; detail: string }> = [];
  for (const r of mcpRuns) {
    for (const step of r.trace ?? []) {
      if (traceShowsApprovalIssue(step)) {
        approvalSignals.push({
          run: r,
          taskId: step.taskId || "unknown",
          detail: `${step.action || "MCP tool call"}: ${step.note || step.status || "approval issue"}`,
        });
        continue;
      }
      if (traceShowsCoverageGap(step)) {
        const capability = traceCapability(step);
        if (capability) {
          coverageSignals.push({
            run: r,
            capability,
            taskId: step.taskId || "unknown",
            detail: `${step.action || "trace"}: ${step.note || step.path || "coverage gap"}`,
          });
        }
      }
    }
    for (const outcome of firstAttempts(r.outcomes).filter((o) => !o.success && !planLimited(r.trace, o.taskId))) {
      const steps = (r.trace ?? []).filter((s) => s.taskId === outcome.taskId);
      if (steps.some(traceShowsApprovalIssue)) {
        approvalSignals.push({ run: r, taskId: outcome.taskId, detail: failureDetail(outcome) });
        continue;
      }
      const capability = inferredCapability(pack, outcome.taskId);
      if (capability === "complete/update task" || capability === "reschedule/update task") {
        approvalSignals.push({ run: r, taskId: outcome.taskId, detail: failureDetail(outcome) });
        continue;
      }
      coverageSignals.push({ run: r, capability, taskId: outcome.taskId, detail: failureDetail(outcome) });
    }
  }
  if (coverageSignals.length) {
    const capabilities = [...new Set(coverageSignals.map((s) => s.capability))];
    const capStats = new Map<string, { configs: Set<string>; tasks: Set<string>; examples: string[] }>();
    for (const signal of coverageSignals) {
      const { run, capability: cap, taskId, detail } = signal;
      const stat = capStats.get(cap) ?? { configs: new Set<string>(), tasks: new Set<string>(), examples: [] };
      stat.configs.add(configLabel(run));
      stat.tasks.add(taskDescriptor(pack, taskId));
      if (stat.examples.length < 2) stat.examples.push(detail);
      capStats.set(cap, stat);
    }
    const worst = mcpRuns
      .filter((r) => r.outcomes.length)
      .sort((a, b) => runPassPct(a) - runPassPct(b))[0];
    const evidence = [...capStats.entries()]
      .map(([cap, stat]) => {
        const examples = stat.examples.length ? `; examples: ${stat.examples.join("; ")}` : "";
        return `${cap}: failed in ${stat.configs.size} config(s), ${stat.tasks.size} task(s)${examples}`;
      })
      .join(" | ");
    recs.push({
      category: "execution",
      priority: "high",
      title: "Fill MCP tool coverage gaps",
      detail:
        `The MCP surface has ${coverageSignals.length} coverage-gap signal(s)` +
        (worst ? `; the weakest MCP config (${configLabel(worst)}) passed ${runPassPct(worst)}% of tasks` : "") +
        `. The gaps cluster around capabilities agents expected but could not reliably use: ${capabilities.join(", ")}.`,
      target: `MCP tools/capabilities: ${capabilities.join(", ")}`,
      evidence: `Round-trip failures and trace evidence from MCP runs — ${evidence}`,
      fix:
        "Expose or document first-class MCP tools for these operations, with returned ids matching the resource that the oracle can read back. Re-run MCP configs after adding coverage.",
    });
  }
  if (approvalSignals.length) {
    const configs = new Set(approvalSignals.map((s) => configLabel(s.run)));
    const tasks = new Set(approvalSignals.map((s) => taskDescriptor(pack, s.taskId)));
    const examples = approvalSignals.slice(0, 3).map((s) => `${configLabel(s.run)} ${s.taskId}: ${s.detail}`).join(" | ");
    recs.push({
      category: "execution",
      priority: "med",
      title: "Separate MCP approval failures from tool coverage",
      detail:
        `Some MCP failures were caused by tool-call approval or cancellation in ${configs.size} config(s), not by missing product MCP tools.`,
      target: `Harness/MCP approval flow for ${[...tasks].join(", ")}`,
      evidence: examples,
      fix:
        "Run MCP eval cells with deterministic non-interactive approval policy, or mark approval-blocked cells separately from product/tool coverage gaps.",
    });
  }

  const failedStatic = (staticReadiness?.v0Checks ?? []).filter((c) => c.status === "fail");
  const failedIds = new Set(failedStatic.map((c) => c.id));
  const missingEntrypoints: string[] = [];
  if (failedIds.has("llms-txt") || failedIds.has("markdown-docs")) missingEntrypoints.push("llms-full.txt / markdown docs");
  if (failedIds.has("openapi")) missingEntrypoints.push("discoverable OpenAPI link");
  if (failedIds.has("mcp-server")) missingEntrypoints.push("MCP descriptor / endpoint");
  if (failedIds.has("robots-sitemap")) missingEntrypoints.push("sitemap.xml");
  if (failedIds.has("auth-discovery")) missingEntrypoints.push("OAuth authorization-server discovery");
  if (missingEntrypoints.length) {
    recs.push({
      category: "discovery",
      priority: "high",
      title: "Publish machine-readable discovery entrypoints",
      detail:
        `Static discovery missed ${missingEntrypoints.length} agent entrypoint(s): ${missingEntrypoints.join(", ")}. ` +
        "These are high-ROI docs changes because they help agents find the right surface before task execution starts.",
      target: staticReadiness?.site || "public developer docs",
      evidence: failedStatic.map((c) => `${c.label}: ${c.detail}`).join(" | "),
      fix:
        "Add explicit links from the docs root and conventional locations for llms-full.txt, OpenAPI, MCP descriptor/endpoint, sitemap.xml, and OAuth discovery where applicable.",
    });
  }

  // 1) High readiness + low behavioral → the headline "exposed ≠ usable" gap.
  //    Only meaningful when the docs site IS the agent's discovery path (API).
  if (gapMeaningful && readiness !== undefined && best && readiness >= 50 && readiness - best.pct >= 20) {
    recs.push({
      category: "discovery",
      priority: "high",
      title: "Close the gap between published and usable",
      detail:
        `Docs-site discoverability is ${readiness}/100 but the best agent (${best.profile}) completed only ` +
        `${best.pct}% of tasks — a ${readiness - best.pct}-point gap. The API is published, but agents still ` +
        `can't reliably use it. The discovery and docs fixes below are the priority.`,
    });
  }

  // 2) Discovery missed `official` → agents never reached the official docs.
  if (missed("official")) {
    recs.push({
      category: "discovery",
      priority: "high",
      title: "Agents never reached your official docs",
      detail:
        "Phase-0 discovery shows the agent did not land on an official domain — web search routed it elsewhere. " +
        "Improve answer-engine optimization: make the official docs the top result for product + API queries, and " +
        "publish an llms.txt and clear canonical links so agents arrive at the authoritative source.",
    });
  }

  // 3) Discovery missed `canonical` → docs don't surface the right endpoint.
  if (missed("canonical")) {
    recs.push({
      category: "discovery",
      priority: "high",
      title: "Official docs don't surface the canonical endpoint",
      detail:
        "Discovery reached the docs but did not extract the current/correct endpoint where agents look — an AEO " +
        "gap. Surface the canonical call prominently (quickstart, top of the reference, a machine-readable spec) " +
        "so agents use it instead of a guessed or deprecated path.",
    });
  }

  // 4) v2 docs-graph crawl ~0 → docs aren't link-reachable (likely an SPA).
  if (v2 !== undefined && v2 <= 10) {
    recs.push({
      category: "discovery",
      priority: "med",
      title: "Docs aren't link-reachable (likely a client-rendered SPA)",
      detail:
        `The docs-graph crawl scored ${v2}/100 — almost no agent-followable links were found from the docs root` +
        (v0 !== undefined && v0 > v2
          ? ` (conventional-path readiness is ${v0}/100, so the content exists but isn't crawlable)`
          : "") +
        ". Add server-rendered links, sitemap.xml, llms-full.txt, and explicit OpenAPI/MCP/auth discovery links so non-JS crawlers and agents can traverse the docs.",
    });
  }

  // 5) Product-attributed failures: strongest agent failed and discovery held.
  if (strongest) {
    const fails = strongest.outcomes.filter((o) => !o.success);
    const planFails = fails.filter((o) => planLimited(strongest.trace, o.taskId));
    const held = !discoveryWeak(strongest.discovery);
    const productFails = held ? fails.filter((o) => !planLimited(strongest.trace, o.taskId)) : [];
    if (productFails.length) {
      const ids = productFails.map((o) => o.taskId).join(", ");
      // Surface the per-task oracle detail as evidence (what was asserted vs what
      // read back), so a coding agent has the concrete failure to act on.
      const evidence = productFails
        .map((o) => {
          const why = o.error ?? (o.oracleResults.map((x) => x.detail).filter(Boolean).join("; ") || "oracle failed");
          return `${o.taskId}: ${why}`;
        })
        .join(" | ");
      recs.push({
        category: "execution",
        priority: "high",
        title: "Product/docs gap: the strongest agent still failed",
        detail:
          `The strongest profile (${strongest.profile}) failed ${productFails.length} non-plan task(s) ` +
          `(${ids}) with discovery intact. When the best agent fails and discovery held up, the gap points at the ` +
          "product/docs, not at finding the API.",
        target: `Tasks: ${ids} (the API endpoints / MCP tools they exercise)`,
        evidence: `Round-trip oracle read-back — ${evidence}`,
        fix: "Fix the API ergonomics or docs for these operations (missing capability, confusing field, or a tool that doesn't exist on this surface), then re-run to confirm the read-back passes.",
      });
    }
    // 6) Plan-limited failures → sandbox/plan limits, NOT product gaps.
    if (planFails.length) {
      recs.push({
        category: "execution",
        priority: "low",
        title: "Some failures are plan/sandbox limits, not product gaps",
        detail:
          `${planFails.length} task(s) (${planFails.map((o) => o.taskId).join(", ")}) returned 402 / premium-only. ` +
          "These are plan-tier/sandbox limits and should be excluded from product attribution — re-run on an " +
          "appropriately provisioned account to score them.",
      });
    }
  }

  // 7) Weak / missing oracles → recommend a stronger (round-trip) oracle.
  const weakTasks = pack.tasks.filter(
    (t) => t.oracles.length === 0 || !t.oracles.some((o) => o.type === "roundtrip"),
  );
  if (weakTasks.length) {
    recs.push({
      category: "execution",
      priority: "med",
      title: "Strengthen weak task verification",
      detail:
        `${weakTasks.length} task(s) (${weakTasks.map((t) => t.id).join(", ")}) have no round-trip oracle ` +
        "(no oracle at all, or only a weak existence/equality check). Add a round-trip oracle — create, then " +
        "independently GET the resource and assert a server-confirmed field — so success reflects real API state, " +
        "not the executor's self-report.",
    });
  }

  // 7b) Low content quality → point at the spec-smell section. Priority tracks
  //     severity: a sub-50 score blocks autonomous use outright.
  const contentScore = staticReadiness?.contentScore;
  if (contentScore !== undefined && contentScore < 80) {
    const cq = staticReadiness?.contentQuality;
    recs.push({
      category: "discovery",
      priority: contentScore < 50 ? "high" : "med",
      title: "Improve the OpenAPI spec's content quality",
      detail:
        `The spec scores ${contentScore}/100 on content quality` +
        (cq ? ` (${cq.totalSmells} smell(s) across ${cq.endpointsAnalyzed} endpoints)` : "") +
        ". Structural validity isn't agent-readiness. For stable public APIs, don't churn existing paths just to satisfy style smells; prioritize additive fixes in the Content quality section: clearer parameter docs, examples, request/response schemas, auth notes, and rich-text/body requirements.",
    });
  }

  if (maxAttempts(runs) <= 1 && runs.some((r) => r.outcomes.length > 0)) {
    recs.push({
      category: "execution",
      priority: "low",
      title: "Re-run with pass@k before treating results as stable",
      detail:
        "This report has attempts per task = 1, so it identifies priority areas but does not prove reliability. " +
        "Run multiple attempts with sandbox reset between attempts to distinguish stable failures from one-off agent variance.",
      target: "Eval run configuration",
      evidence: "Robustness section reports a single attempt per task.",
      fix: "Re-run with --attempts 3 or higher after the first round of fixes, then compare pass@k/all-k/flaky tasks.",
    });
  }

  // 8) Everything passes → positive note + suggest hardening.
  const ranOutcomes = runs.flatMap((r) => r.outcomes);
  if (ranOutcomes.length > 0 && !ranOutcomes.some((o) => !o.success)) {
    recs.push({
      category: "execution",
      priority: "low",
      title: "All tasks pass — raise the bar",
      detail:
        "Every task passed for every profile. To keep the suite discriminating, add harder scenarios (more L3/L4 " +
        "multi-step tasks), run pass@k to surface flakiness, and broaden coverage of the surface area.",
    });
  }

  const order = { high: 0, med: 1, low: 2 } as const;
  return recs.sort((a, b) => order[a.priority] - order[b.priority]);
}

// ---------------------------------------------------------------------------
// HTML rendering.
// ---------------------------------------------------------------------------

/** Escape text for safe interpolation into an HTML text node or attribute. */
function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline `<code>` wrapping an escaped value. */
function code(value: unknown): string {
  return `<code class="ax-code">${esc(value)}</code>`;
}

/**
 * The shared stylesheet (one source of truth for every report) lives in
 * `../report-style.ts`. Aliased to `STYLE` so the renderers below are unchanged.
 */
const STYLE = REPORT_STYLE;

/** Section 1 — header with target name, timestamp, and compact provenance. */
/** TL;DR — the executive summary that opens the report: a one-line takeaway, the
 *  four pillar numbers as quick-scan pills, and jump-links into each section so a
 *  reader (or a coding agent handed the HTML) lands on the detail fast. */
function renderTldr(
  pack: TargetPack,
  runs: ProfileRun[],
  stat: StaticReadiness | undefined,
  recCount: number,
): string {
  const cells = matrixCells(runs);
  if (!cells.length) return "";
  const readiness = readinessScore(stat);
  const content = stat?.contentScore;
  const harnesses = [...new Set(cells.map((c) => c.harness))];

  // A pill links to its detail section when one exists; Static discovery has no
  // deeper section (its only detail is the v0/v2 breakdown in the sub-label), so
  // it renders as a plain, non-clickable pill rather than jumping somewhere wrong.
  const pill = (label: string, val: string, href?: string): string => {
    const inner = `<span class="ax-tldr__pill-val">${val}</span><span class="ax-tldr__pill-label">${esc(label)}</span>`;
    return href
      ? `<a class="ax-tldr__pill" href="${href}">${inner}</a>`
      : `<div class="ax-tldr__pill ax-tldr__pill--static">${inner}</div>`;
  };
  // Show the denominator so the scale is explicit: /100 for scores, % for the rate.
  const num = (n: number | undefined, scale: "/100" | "%"): string =>
    n === undefined ? "—" : `${esc(n)}<span class="ax-tldr__pill-scale">${scale}</span>`;
  const links = [
    `<a href="#discovery">Discovery</a>`,
    `<a href="#execution">Execution</a>`,
    recCount ? `<a href="#discovery-recommendations">${recCount} recommendation${recCount === 1 ? "" : "s"}</a>` : "",
    `<a href="#methodology">Methodology</a>`,
  ].filter(Boolean);
  const jump = `<p class="ax-tldr__jump">Jump to: ${links.join(" · ")}</p>`;
  const section = (title: string, body: string): string =>
    `<div class="ax-tldr__section"><div class="ax-tldr__section-h">${title}</div>${body}</div>`;

  // Multi-harness: the two cell-level pillars (task success, agent discovery) are
  // broken down PER HARNESS; the two product-level pillars stay single pills.
  if (harnesses.length > 1) {
    const surfaces = SURFACE_ORDER.filter((s) => cells.some((c) => c.surface === s));
    const profiles = [...new Set(runs.map((r) => r.profile))];
    const spread = rangeLabel(configPassPcts(runs));
    const bestTask = Math.max(...configPassPcts(runs));
    const bestDiscoveryValues = cells.map((c) => c.discovery).filter((n): n is number => n !== undefined);
    const bestDiscovery = bestDiscoveryValues.length ? Math.max(...bestDiscoveryValues) : undefined;
    const opLabel = usabilityLabel(bestTask, bestDiscovery);
    const opTakeaway = usabilityTakeaway(bestTask, bestDiscovery);
    const takeaway =
      `<strong>${esc(opLabel)}</strong>. ${esc(opTakeaway)} ${esc(processQualityTakeaway(runs))} ` +
      `<strong>${harnesses.length} harnesses × ${surfaces.length} surface${surfaces.length === 1 ? "" : "s"} × ${profiles.length} effort level${profiles.length === 1 ? "" : "s"} = ${runs.length} configs</strong>, ` +
      `summarized into ${cells.length} harness × surface cell${cells.length === 1 ? "" : "s"}. ` +
      `Task success ${spread} across configs. Static discovery and content quality are product-level; ` +
      `task success and agent discovery break down by harness below.`;
    // Per-harness range across that harness's cells (min–max, or single value).
    const range = (nums: (number | undefined)[], unit: string): string => {
      const v = nums.filter((n): n is number => n !== undefined);
      if (!v.length) return "—";
      const a = Math.min(...v), b = Math.max(...v);
      return a === b ? `${esc(a)}${unit}` : `${esc(a)}–${esc(b)}${unit}`;
    };
    const discSpread = range(cells.map((c) => c.discovery), "/100");
    const discoveryPills = [
      pill("Static discovery", num(readiness, "/100"), stat?.v0Checks?.length ? "#static-discovery" : undefined),
      pill("Agent discovery", discSpread === "—" ? "—" : `${esc(discSpread)}`, "#agent-discovery"),
      content !== undefined ? pill("Content quality", num(content, "/100"), "#content-quality") : "",
    ].filter(Boolean);
    const byHarness = harnesses
      .map((h) => {
        const hr = runs.filter((r) => (r.harness ?? "host-agent") === h);
        const hc = cells.filter((c) => c.harness === h);
        return {
          name: h,
          task: rangeLabel(configPassPcts(hr)),
          disc: range(hc.map((c) => c.discovery), "/100"),
        };
      })
    ;
    const discoveryRows = byHarness
      .map((h) => `<div class="ax-tldr__hrow"><span class="ax-tldr__hname">${esc(h.name)}</span><span class="ax-tldr__hmetric">agent discovery <strong>${esc(h.disc)}</strong></span></div>`)
      .join("");
    const executionRows = byHarness
      .map((h) => `<div class="ax-tldr__hrow"><span class="ax-tldr__hname">${esc(h.name)}</span><span class="ax-tldr__hmetric">task success <strong>${esc(h.task)}</strong></span></div>`)
      .join("");
    return `<section class="ax-section ax-tldr" id="tldr">
    <div class="ax-eyebrow">TL;DR</div>
    <p class="ax-tldr__takeaway">${takeaway}</p>
    <div class="ax-tldr__split">
      ${section(`<a href="#discovery">Discovery</a>`, `<div class="ax-tldr__pills">${discoveryPills.join("")}</div><div class="ax-tldr__byharness"><div class="ax-tldr__byharness-h">By harness — agent discovery range across surfaces:</div>${discoveryRows}</div>`)}
      ${section(`<a href="#execution">Execution</a>`, `<div class="ax-tldr__pills">${pill("Task success", spread === "—" ? "—" : `${esc(spread)}`, "#scores")}</div><div class="ax-tldr__byharness"><div class="ax-tldr__byharness-h">By harness — task success range across surfaces:</div>${executionRows}</div>`)}
    </div>
    ${jump}
  </section>`;
  }

  // Single harness (one cell, or one harness across profiles/attempts): the
  // classic four-pillar TL;DR with a neutral, surface-aware takeaway.
  const best = bestBehavioralPct(runs);
  if (!best) return "";
  const surface = dominantSurface(runs);
  const agentDisc = agentDiscoveryScore(runs);
  const opLabel = usabilityLabel(best.pct, agentDisc);
  const opTakeaway = usabilityTakeaway(best.pct, agentDisc);
  const fails = runs.find((r) => r.profile === best.profile)?.outcomes.filter((o) => !o.success) ?? [];
  const failNote = fails.length
    ? `${fails.length} task(s) still fail (${esc(fails.map((o) => o.taskId).join(", "))})`
    : `every task passed`;
  const takeaway =
    `<strong>${esc(opLabel)}</strong>. ${esc(opTakeaway)} ${esc(processQualityTakeaway(runs))} ` +
    `On the <strong>${esc(surface.toUpperCase())}</strong> surface, the best agent (${esc(best.profile)} effort) ` +
    `completed <strong>${esc(best.pct)}%</strong> of real tasks; ${failNote}. ` +
    `Static docs discovery and behavioral agent discovery are reported separately below.`;
  const discoveryPills = [
    pill("Static discovery", num(readiness, "/100"), stat?.v0Checks?.length ? "#static-discovery" : undefined),
    pill("Agent discovery", num(agentDisc, "/100"), "#agent-discovery"),
    content !== undefined ? pill("Content quality", num(content, "/100"), "#content-quality") : "",
  ].filter(Boolean);
  const executionBody = `<div class="ax-tldr__pills">${pill("Task success", num(best.pct, "%"), "#scores")}</div><p class="ax-tldr__section-note">On the <strong>${esc(surface.toUpperCase())}</strong> surface with <strong>${esc(best.profile)}</strong> effort, ${failNote}.</p>`;
  return `<section class="ax-section ax-tldr" id="tldr">
    <div class="ax-eyebrow">TL;DR</div>
    <p class="ax-tldr__takeaway">${takeaway}</p>
    <div class="ax-tldr__split">
      ${section(`<a href="#discovery">Discovery</a>`, `<div class="ax-tldr__pills">${discoveryPills.join("")}</div>`)}
      ${section(`<a href="#execution">Execution</a>`, executionBody)}
    </div>
    ${jump}
  </section>`;
}

function renderHeader(pack: TargetPack, generatedAt: string): string {
  const product = pack.discovery?.product || pack.name.replace(/-generated$/, "");
  const meta: Array<[string, string]> = [
    ["generated", esc(generatedAt)],
    ["standard_set_version", code(pack.standard_set_version || "(unset)")],
    ["run_id", code(pack.run_id || "(unversioned)")],
    ["base_url", code(pack.base_url || "(unset)")],
    ["generated_by", code(pack.generated_by || "(unset)")],
  ];
  const rows = meta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("\n      ");
  return `<header class="ax-header">
    <div class="ax-eyebrow">Agent usability report</div>
    <h1 class="ax-title">How well can an AI agent use <span class="ax-target">${esc(product)}</span>?</h1>
    <p class="ax-subtitle">We ran live tasks against the API to measure what an AI agent can actually complete — not just what the docs expose.</p>
    <dl class="ax-meta">
      ${rows}
    </dl>
  </header>`;
}

function renderProminentCaveat(warnings?: string[]): string {
  const sample = (warnings ?? []).find((w) => /\bfake\b|\bsample\b/i.test(w));
  if (!sample) return "";
  return `<div class="ax-caveat ax-caveat--sample">
      <span class="ax-caveat__label">Sample data only</span>
      <span class="ax-caveat__detail">${esc(sample)}</span>
    </div>`;
}

/** Pick a pass/warn/fail card modifier for the readiness↔behavioral gap. */
function gapClass(gap: number): string {
  if (gap <= 0) return "ax-card--pass";
  if (gap < 20) return "ax-card--warn";
  return "ax-card--fail";
}

/** The surface most runs drove the product through (api/cli/sdk/mcp). Used to
 *  decide whether the STATIC docs-site crawl actually reflects how the agent
 *  discovered the product. For api/docs it does (the agent reads the website);
 *  for mcp/sdk/cli it does NOT (the agent lists tools / introspects the SDK), so
 *  the static score is a publisher-facing docs signal, not this run's discovery
 *  path — and the report must say so instead of folding it into one number. */
function dominantSurface(runs: ProfileRun[]): SurfaceId {
  const counts = new Map<SurfaceId, number>();
  for (const r of runs) counts.set(r.surface ?? "api", (counts.get(r.surface ?? "api") ?? 0) + 1);
  let best: SurfaceId = "api";
  let max = -1;
  for (const [s, n] of counts) if (n > max) ((max = n), (best = s));
  return best;
}

/** True when the run's surface discovers the product by reading the docs website
 *  (api/docs) rather than by listing tools or introspecting an SDK (mcp/sdk/cli).
 *  Only then does the static docs-site crawl measure the agent's real discovery
 *  path; otherwise it's an orthogonal publisher-facing signal. */
function staticReflectsAgentDiscovery(surface: SurfaceId): boolean {
  return surface === "api";
}

/** A {harness × surface} cell of one product's run matrix. The two behavioral
 *  pillars (task success, agent discovery) vary per cell; the two static pillars
 *  (static discovery, content quality) are product-level and shown once. */
interface MatrixCell {
  harness: string;
  surface: SurfaceId;
  taskPct: number | undefined;
  discovery: number | undefined;
}

/** Group runs into {harness × surface} cells (profiles/attempts collapse within
 *  a cell to the best behavioral result). One cell = today's report; many cells
 *  = the cross-harness / cross-surface matrix. */
function matrixCells(runs: ProfileRun[]): MatrixCell[] {
  const groups = new Map<string, ProfileRun[]>();
  for (const r of runs) {
    const key = `${r.harness ?? "host-agent"}::${r.surface ?? "api"}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const cells: MatrixCell[] = [];
  for (const [key, rs] of groups) {
    const [harness, surface] = key.split("::") as [string, SurfaceId];
    cells.push({ harness, surface, taskPct: bestBehavioralPct(rs)?.pct, discovery: agentDiscoveryScore(rs) });
  }
  return cells;
}

/** Strict score tier — green ONLY at a perfect 100, amber 60–99, red <60. Used
 *  for every score color in the report so the same number always reads the same.
 *  (Intentionally strict: a cell isn't "green/good" unless it's flawless.) */
function scoreTier(n: number | undefined): "hi" | "mid" | "lo" | "na" {
  if (n === undefined) return "na";
  return n >= 100 ? "hi" : n >= 60 ? "mid" : "lo";
}

/** Shared 0–100 band → card pass/warn/fail class (strict scale). */
function scoreBand(n: number | undefined): string {
  const t = scoreTier(n);
  return t === "hi" ? "ax-card--pass" : t === "mid" ? "ax-card--warn" : t === "lo" ? "ax-card--fail" : "";
}

function heatBadge(value: string, tier: ReturnType<typeof scoreTier>): string {
  return `<span class="ax-heat ax-heat--${tier}">${esc(value)}</span>`;
}

function rateBadge(outcomes: RoundtripOutcome[]): string {
  return heatBadge(rateLabel(outcomes), scoreTier(pct(outcomes)));
}

function countTier(n: number): "hi" | "mid" | "lo" {
  return n === 0 ? "hi" : n <= 2 ? "mid" : "lo";
}

function countBadge(n: number): string {
  return `<span class="ax-heat ax-heat--count ax-heat--${countTier(n)}">${esc(n)}</span>`;
}

/** The four-pillar formula explainer (shared by single-cell + matrix views). */
function howScoredBlock(contentMeasured: boolean): string {
  const items = [
    `<strong>Static discovery /100</strong> — the higher of two docs-site audits: v0 (conventional-path checklist — llms.txt, OpenAPI, sitemap, OAuth discovery, …) and v2 (a docs-graph crawl scoring link-reachable surfaces). <code class="ax-code">max(v0, v2)</code>.`,
    `<strong>Agent discovery /100</strong> — the share of a run's scored Phase-0 signals that passed (reached the authoritative source · used a concrete create action · avoided a stale/wrong source · authenticated). Efficiency (hops) is reported but not scored.`,
    contentMeasured
      ? `<strong>Content quality /100</strong> — a weighted score over the OpenAPI spec's per-endpoint "smells" (Hermes taxonomy): 100 minus weighted smell prevalence, so a clean spec ≈ 100.`
      : "",
    `<strong>Task success %</strong> — the share of tasks whose <em>round-trip oracle</em> passed: the agent creates/mutates a resource and the verifier independently reads it back and asserts a server-confirmed field.`,
  ].filter(Boolean);
  return `<details class="ax-howscored">
      <summary>How these scores are computed</summary>
      <ul>${items.map((h) => `<li>${h}</li>`).join("")}</ul>
    </details>`;
}

/** Shared grouped-config tbody for the detail tables: surface (merged) · harness
 *  (merged) · effort, then per-config data cells. Matches the Summary matrix's
 *  Excel-style grouping + dividers so every detail table reads consistently.
 *  `dataCells(r)` returns the `<td>`s for the columns after `effort`. */
function groupedConfigRows(runs: ProfileRun[], dataCells: (r: ProfileRun) => string): string {
  const surfaces = SURFACE_ORDER.filter((s) => runs.some((r) => (r.surface ?? "api") === s));
  const profRank = (p: string): number => (p === "medium" ? 0 : p === "low" ? 1 : p === "high" ? 2 : 3);
  let html = "";
  for (const s of surfaces) {
    const sRuns = runs.filter((r) => (r.surface ?? "api") === s);
    const harnesses = [...new Set(sRuns.map((r) => r.harness ?? "host-agent"))].sort();
    let firstOfSurface = true;
    for (const h of harnesses) {
      const hRuns = sRuns
        .filter((r) => (r.harness ?? "host-agent") === h)
        .sort((a, b) => profRank(a.profile) - profRank(b.profile) || a.profile.localeCompare(b.profile));
      let firstOfHarness = true;
      for (const r of hRuns) {
        const cls = firstOfSurface ? ' class="ax-mx-group"' : "";
        const surfaceCell = firstOfSurface ? `<td rowspan="${sRuns.length}" class="ax-mx-surface">${esc(s.toUpperCase())}</td>` : "";
        const harnessCell = firstOfHarness ? `<td rowspan="${hRuns.length}" class="ax-mcell__harness">${esc(h)}</td>` : "";
        html += `<tr${cls}>${surfaceCell}${harnessCell}<td>${esc(r.profile)}</td>${dataCells(r)}</tr>`;
        firstOfSurface = false;
        firstOfHarness = false;
      }
    }
  }
  return html;
}

/** Matrix Summary — used when more than one config (harness × surface × effort)
 *  is present. Product-level pillars (static discovery, content quality) are
 *  shown once; then EVERY config is printed in a grid: rows = harness · surface,
 *  columns = effort. New runs normally contain only medium; historical
 *  multi-effort artifacts remain neutral and fully rendered. */
function renderMatrixScorecard(stat: StaticReadiness | undefined, runs: ProfileRun[]): string {
  const readiness = readinessScore(stat);
  const content = stat?.contentScore;
  const agentDisc = agentDiscoveryScore(runs);
  const profRank = (p: string): number => (p === "medium" ? 0 : p === "low" ? 1 : p === "high" ? 2 : 3);
  const profiles = [...new Set(runs.map((r) => r.profile))].sort((a, b) => profRank(a) - profRank(b) || a.localeCompare(b));

  const allPct = runs.map((r) => pct(firstAttempts(r.outcomes)));
  const lo = Math.min(...allPct), hi = Math.max(...allPct);
  const cellDiscovery = matrixCells(runs).map((c) => c.discovery).filter((n): n is number => n !== undefined);
  const bestDiscovery = cellDiscovery.length ? Math.max(...cellDiscovery) : undefined;
  const opLabel = usabilityLabel(hi, bestDiscovery);
  const opTakeaway = usabilityTakeaway(hi, bestDiscovery);
  const nH = new Set(runs.map((r) => r.harness ?? "host-agent")).size;
  const nS = new Set(runs.map((r) => r.surface ?? "api")).size;
  const verdict =
    `${opLabel}: ${opTakeaway} ${processQualityTakeaway(runs)} ` +
    `${nH} harness${nH === 1 ? "" : "es"} × ${nS} surface${nS === 1 ? "" : "s"} × ${profiles.length} effort = ${runs.length} configs. ` +
    `Read this report in two passes: Discovery asks whether agents can find and interpret the surface; Execution asks whether they can complete real tasks once there.`;

  // Cell: task success heat pill (strict scale) + agent-discovery colored text.
  const cell = (r: ProfileRun | undefined): string => {
    if (!r) return `<td class="ax-mcell ax-mcell--na">—</td>`;
    const p = pct(firstAttempts(r.outcomes)); // pass@1 — defined regardless of attempts
    const disc = agentDiscoveryScore([r]);
    const discTxt = disc !== undefined ? `<span class="ax-mcell__sub ax-disc--${scoreTier(disc)}">disc ${esc(disc)}/100</span>` : "";
    return `<td class="ax-mcell"><span class="ax-heat ax-heat--${scoreTier(p)}">${esc(p)}%</span> ${discTxt}</td>`;
  };
  // Excel-style layout: surface | harness | model | <effort columns>. The surface
  // cell is merged (rowspan) across its harnesses, with a divider between groups.
  const surfaces = SURFACE_ORDER.filter((s) => runs.some((r) => (r.surface ?? "api") === s));
  const harnessesFor = (s: SurfaceId): string[] =>
    [...new Set(runs.filter((r) => (r.surface ?? "api") === s).map((r) => r.harness ?? "host-agent"))].sort();
  const runFor = (s: SurfaceId, h: string, p: string): ProfileRun | undefined =>
    runs.find((r) => (r.surface ?? "api") === s && (r.harness ?? "host-agent") === h && r.profile === p);
  const modelFor = (s: SurfaceId, h: string): string => {
    const r = runs.find((rr) => (rr.surface ?? "api") === s && (rr.harness ?? "host-agent") === h);
    return r?.model ?? "host-default";
  };
  const head = `<tr><th>surface</th><th>harness</th><th>model</th>${profiles.map((p) => `<th>${esc(p)} effort</th>`).join("")}</tr>`;
  const body = surfaces
    .map((s) => {
      const hs = harnessesFor(s);
      return hs
        .map((h, i) => {
          const surfaceCell = i === 0 ? `<td rowspan="${hs.length}" class="ax-mx-surface">${esc(s.toUpperCase())}</td>` : "";
          const rowCls = i === 0 ? ' class="ax-mx-group"' : "";
          return `<tr${rowCls}>${surfaceCell}<td class="ax-mcell__harness">${esc(h)}</td><td>${code(modelFor(s, h))}</td>${profiles.map((p) => cell(runFor(s, h, p))).join("")}</tr>`;
        })
        .join("");
    })
    .join("");

  const v0 = stat?.v0Score, v2 = stat?.v2Score;
  const readinessSub = [v0 !== undefined ? `v0 ${v0}` : null, v2 !== undefined ? `v2 ${v2}` : null].filter(Boolean).join(" · ") || "not measured";
  const productCards = [
    `<div class="ax-card ${scoreBand(readiness)}">
        <span class="ax-card__value">${readiness !== undefined ? esc(readiness) : "—"}<span class="ax-card__scale">/100</span></span>
        <span class="ax-card__label">${stat?.v0Checks?.length ? `<a href="#static-discovery">Static discovery</a>` : "Static discovery"}</span>
        <span class="ax-card__sub">max(${esc(readinessSub)}) · docs-site crawl · product-level</span>
      </div>`,
    content !== undefined
      ? `<div class="ax-card ${scoreBand(content)}">
        <span class="ax-card__value">${esc(content)}<span class="ax-card__scale">/100</span></span>
        <span class="ax-card__label"><a href="#content-quality">Content quality</a></span>
        <span class="ax-card__sub">weighted OpenAPI smell score · product-level</span>
      </div>`
      : "",
    `<div class="ax-card ${scoreBand(agentDisc)}">
        <span class="ax-card__value">${agentDisc !== undefined ? esc(agentDisc) : "—"}${agentDisc !== undefined ? '<span class="ax-card__scale">/100</span>' : ""}</span>
        <span class="ax-card__label"><a href="#agent-discovery">Agent discovery</a></span>
        <span class="ax-card__sub">best observed Phase-0 score across configs</span>
      </div>`,
  ].filter(Boolean);
  const executionCards = [
    `<div class="ax-card ${scoreBand(hi)}">
        <span class="ax-card__value">${esc(lo === hi ? hi : `${lo}–${hi}`)}<span class="ax-card__scale">%</span></span>
        <span class="ax-card__label"><a href="#scores">Task success</a></span>
        <span class="ax-card__sub">${lo === hi ? "same across configs" : "range across configs"}</span>
      </div>`,
  ];

  return `<section class="ax-section ax-scorecard-section">
    <h2>Overview</h2>
    <p class="ax-verdict">${esc(verdict)}</p>
    <div class="ax-overview-split">
      <div class="ax-overview-block">
        <h3 class="ax-overview-block__title">Discovery snapshot</h3>
        <p class="ax-overview-block__note">Product-level docs and schema signals, plus the strongest behavioral discovery score across configs.</p>
        <div class="ax-scorecard">
          ${productCards.join("\n          ")}
        </div>
      </div>
      <div class="ax-overview-block">
        <h3 class="ax-overview-block__title">Execution snapshot</h3>
        <p class="ax-overview-block__note">Behavior once discovery is intact: real task completion across harnesses, surfaces, and effort levels.</p>
        <div class="ax-scorecard">
          ${executionCards.join("\n          ")}
        </div>
      </div>
    </div>
    <h3 class="ax-subhead">Execution matrix — every config</h3>
    <p class="ax-note">One row per harness · surface, one column per effort level. The pill is task success (round-trip oracles); <code class="ax-code">disc</code> is the behavioral agent-discovery score. Every config is printed — none crowned "best".</p>
    <div class="ax-table-wrap">
    <table class="ax-table ax-matrix">
      <thead>${head}</thead>
      <tbody>${body}</tbody>
    </table>
    </div>
    ${howScoredBlock(content !== undefined)}
  </section>`;
}

/** Section 2 — one-line verdict + scorecard metric cards. */
function renderScorecard(stat: StaticReadiness | undefined, runs: ProfileRun[]): string {
  // More than one config (any of harness/surface/effort varies) → the neutral
  // all-configs matrix. A single config falls through to the four-pillar scorecard.
  if (runs.length > 1) return renderMatrixScorecard(stat, runs);

  const best = bestBehavioralPct(runs);
  const readiness = readinessScore(stat);
  const surface = dominantSurface(runs);
  // The docs-site gap is only a coherent single number when the agent actually
  // discovers via the docs website (api/docs). For mcp/sdk/cli the static crawl
  // and the behavioral run measure DIFFERENT discovery channels, so we don't
  // subtract them — we report them side by side and say why.
  const gapMeaningful = staticReflectsAgentDiscovery(surface);
  const haveGap = readiness !== undefined && best && gapMeaningful;
  const gap = haveGap ? readiness! - best!.pct : undefined;

  let verdict: string;
  if (!best) {
    verdict = `${usabilityLabel(undefined, undefined)}: ${usabilityTakeaway(undefined, undefined)} ${processQualityTakeaway(runs)}`;
  } else if (readiness === undefined) {
    const opLabel = usabilityLabel(best.pct, agentDiscoveryScore(runs));
    const opTakeaway = usabilityTakeaway(best.pct, agentDiscoveryScore(runs));
    verdict = `${opLabel}: ${opTakeaway} ${processQualityTakeaway(runs)} The best agent completed ${best.pct}% of tasks. (Docs-site discoverability wasn't measured for this run.)`;
  } else if (!gapMeaningful) {
    // Non-API surface: keep the two signals explicitly separate.
    const opLabel = usabilityLabel(best.pct, agentDiscoveryScore(runs));
    const opTakeaway = usabilityTakeaway(best.pct, agentDiscoveryScore(runs));
    verdict =
      `${opLabel}: ${opTakeaway} ${processQualityTakeaway(runs)} ` +
      `On the ${surface.toUpperCase()} surface the best agent completed ${best.pct}% of tasks. ` +
      `Docs-site discoverability is a separate, publisher-facing signal (${readiness}/100, a static crawl of the docs website) — ` +
      `the agent discovered the ${surface.toUpperCase()} tools by listing them, not by reading those docs.`;
  } else if (gap! > 0) {
    const opLabel = usabilityLabel(best.pct, agentDiscoveryScore(runs));
    const opTakeaway = usabilityTakeaway(best.pct, agentDiscoveryScore(runs));
    verdict = `${opLabel}: ${opTakeaway} ${processQualityTakeaway(runs)} The API is published and discoverable (${readiness}/100), but the best agent finished only ${best.pct}% of real tasks — a ${gap}-point gap. Being published isn't the same as being usable by agents.`;
  } else {
    const opLabel = usabilityLabel(best.pct, agentDiscoveryScore(runs));
    const opTakeaway = usabilityTakeaway(best.pct, agentDiscoveryScore(runs));
    verdict = `${opLabel}: ${opTakeaway} ${processQualityTakeaway(runs)} Task success (${best.pct}%) is on par with or above docs-site discoverability (${readiness}/100).`;
  }

  const v0 = stat?.v0Score;
  const v2 = stat?.v2Score;
  const readinessSub =
    [v0 !== undefined ? `v0 ${v0}` : null, v2 !== undefined ? `v2 ${v2}` : null]
      .filter(Boolean)
      .join(" · ") || "not measured";

  const content = stat?.contentScore;
  const agentDisc = agentDiscoveryScore(runs);
  // Card color by the shared strict scale (only 100 green) so the four pillars
  // read consistently with the matrix view.
  const band = scoreBand;
  // Render the value WITH its denominator so the scale is never ambiguous:
  // "38/100" for the 0–100 scores, "86%" for the rate. "—" when unmeasured.
  const val = (n: number | undefined, scale: "/100" | "%"): string =>
    n === undefined
      ? `<span class="ax-card__value">—</span>`
      : `<span class="ax-card__value">${esc(n)}<span class="ax-card__scale">${scale}</span></span>`;

  // The four pillars, in order. Each is a distinct axis — two discoveries (static
  // docs-site crawl vs behavioral agent discovery) are deliberately separate
  // cards, never folded into one "discoverability" number or a gap. The sub-label
  // states how each number is derived; the "How these scores are computed" note
  // below the cards spells out each formula in full.
  const cards: string[] = [
    // 1) Static discovery — a crawl of the docs WEBSITE (publisher signal). Links
    //    to its breakdown section only when we captured the per-check detail.
    `<div class="ax-card ${band(readiness)}">
        ${val(readiness, "/100")}
        <span class="ax-card__label">${stat?.v0Checks?.length ? `<a href="#static-discovery">Static discovery</a>` : "Static discovery"}</span>
        <span class="ax-card__sub">max(${esc(readinessSub)}) · docs-site crawl</span>
      </div>`,
    // 2) Agent discovery — what THIS run's agent did to find the product.
    `<div class="ax-card ${band(agentDisc)}">
        ${val(agentDisc, "/100")}
        <span class="ax-card__label"><a href="#agent-discovery">Agent discovery</a></span>
        <span class="ax-card__sub">% of Phase-0 signals passed${best ? ` · ${esc(best.profile)}` : ""}</span>
      </div>`,
  ];
  // 3) Content quality (v3 smell audit) — only when an openapi_url was audited.
  if (content !== undefined) {
    cards.push(
      `<div class="ax-card ${band(content)}">
        ${val(content, "/100")}
        <span class="ax-card__label"><a href="#content-quality">Content quality</a></span>
        <span class="ax-card__sub">weighted OpenAPI smell score</span>
      </div>`,
    );
  }
  const executionCards = [
    `<div class="ax-card ${band(best?.pct)}">
        ${val(best?.pct, "%")}
        <span class="ax-card__label"><a href="#scores">Task success</a></span>
        <span class="ax-card__sub">${best ? `oracles passed · ${esc(best.profile)} · ${esc(surface.toUpperCase())}` : "no runs"}</span>
      </div>`,
  ];

  // Spell out each formula so a reader can see how the report arrives at every
  // number. Three pillars are 0–100 scores; task success is a percentage rate.
  const howScored = [
    `<strong>Static discovery /100</strong> — the higher of two docs-site audits: v0 (conventional-path checklist — llms.txt, OpenAPI, sitemap, OAuth discovery, …) and v2 (a docs-graph crawl scoring link-reachable surfaces). <code class="ax-code">max(v0, v2)</code>.`,
    `<strong>Agent discovery /100</strong> — the share of the strongest run's scored Phase-0 signals that passed (reached the authoritative source · used a concrete create action · avoided a stale/wrong source · authenticated). Efficiency (hops) is reported but not scored.`,
    content !== undefined
      ? `<strong>Content quality /100</strong> — a weighted score over the OpenAPI spec's per-endpoint "smells" (Hermes taxonomy): 100 minus weighted smell prevalence, so a clean spec ≈ 100.`
      : "",
    `<strong>Task success %</strong> — the share of tasks whose <em>round-trip oracle</em> passed for the best profile: the agent creates/mutates a resource and the verifier independently reads it back and asserts a server-confirmed field.`,
  ].filter(Boolean);

  return `<section class="ax-section ax-scorecard-section">
    <h2>Overview</h2>
    <p class="ax-verdict">${esc(verdict)}</p>
    <div class="ax-overview-split">
      <div class="ax-overview-block">
        <h3 class="ax-overview-block__title">Discovery snapshot</h3>
        <p class="ax-overview-block__note">Can the agent find the authoritative surface and infer how to authenticate and create the target object?</p>
        <div class="ax-scorecard${cards.length >= 3 ? " ax-scorecard--three" : ""}">
          ${cards.join("\n          ")}
        </div>
      </div>
      <div class="ax-overview-block">
        <h3 class="ax-overview-block__title">Execution snapshot</h3>
        <p class="ax-overview-block__note">Once discovery is intact, does the agent complete the real tasks and read back server-confirmed state?</p>
        <div class="ax-scorecard">
          ${executionCards.join("\n          ")}
        </div>
      </div>
    </div>
    <details class="ax-howscored">
      <summary>How these scores are computed</summary>
      <ul>${howScored.map((h) => `<li>${h}</li>`).join("")}</ul>
    </details>
  </section>`;
}

/** Build prioritized plain-text findings, split by report section. */
function buildFindings(pack: TargetPack, runs: ProfileRun[], stat?: StaticReadiness): Finding[] {
  const findings: Finding[] = [];
  const best = bestBehavioralPct(runs);
  const readiness = readinessScore(stat);
  const surface = dominantSurface(runs);
  const gapMeaningful = staticReflectsAgentDiscovery(surface);
  const cells = matrixCells(runs);
  const pushFinding = (category: Finding["category"], detail: string): void => {
    findings.push({ category, detail });
  };

  if (cells.length > 1) {
    const measured = configPassPcts(runs);
    if (measured.length) {
      const lo = Math.min(...measured);
      const hi = Math.max(...measured);
      pushFinding(
        "execution",
        `Task success ranges ${lo === hi ? `${hi}%` : `${lo}–${hi}%`} across configs; static discoverability is ${readiness ?? "not measured"}${readiness !== undefined ? "/100" : ""}. Read the matrix by surface/harness/profile — the best config is a ceiling, not a product-wide result.`,
      );
    }
  } else if (best && readiness !== undefined && gapMeaningful) {
    const gap = readiness - best.pct;
    pushFinding(
      "discovery",
      gap > 0
        ? `Docs-site discoverability is ${readiness}/100 but only ${best.pct}% of tasks succeed — a ${gap}-point gap between published and usable.`
        : `Task success (${best.pct}%) is on par with or above docs-site discoverability (${readiness}/100) — agents can actually use it.`,
    );
  } else if (best && readiness !== undefined) {
    // Non-API surface: report the two signals separately, do not subtract them.
    pushFinding(
      "discovery",
      `On the ${surface.toUpperCase()} surface the best agent completed ${best.pct}% of tasks. The ${readiness}/100 ` +
        `docs-site discoverability is a static crawl of the docs website — a publisher signal, not how the agent found the ${surface.toUpperCase()} tools.`,
    );
  } else if (best) {
    pushFinding("execution", `The best agent (${best.profile}) completed ${best.pct}% of tasks; docs-site discoverability wasn't measured.`);
  }

  const process = worstProcessStats(runs);
  if (process && (process.failed > 0 || process.retryish >= 3)) {
    pushFinding(
      "execution",
      `${processStatsLabel(process)} completed with ${process.calls} recorded call(s), ${process.failed} failed call(s), and ` +
        `${process.retryish} retry-ish repeat(s). Final task success still comes from read-back oracles, but this is an efficiency/ergonomics warning.`,
    );
  }

  // Content-quality axis: flag when the spec, once found, is hard to use.
  const cq = stat?.contentQuality;
  if (cq && stat?.contentScore !== undefined && stat.contentScore < 80) {
    const top = (Object.keys(cq.byCategory) as (keyof typeof cq.byCategory)[])
      .filter((c) => cq.byCategory[c] > 0)
      .sort((a, b) => cq.byCategory[b] - cq.byCategory[a])[0];
    pushFinding(
      "discovery",
      `OpenAPI content quality is ${stat.contentScore}/100 (${cq.totalSmells} spec smell(s) across ${cq.endpointsAnalyzed} endpoints)` +
        (top ? `, most often ${top}` : "") +
        " — agents may struggle to construct calls even after finding the docs.",
    );
  }

  const scored = runs.filter((r) => r.discovery);
  if (scored.length) {
    const missing = new Set<string>();
    for (const r of scored) {
      for (const m of r.discovery!.metrics) {
        if (m.id !== "hops" && !m.passed) missing.add(METRIC_FAILURE_LABEL[m.id] ?? `failed ${m.id}`);
      }
    }
    pushFinding(
      "discovery",
      missing.size
        ? `The most common failed discovery signals were: ${[...missing].join(", ")}.`
        : "Agents reliably found the API on their own (every discovery signal passed).",
    );
  }

  if (cells.length > 1) {
    const weak = runs
      .filter((r) => r.outcomes.length && runPassPct(r) < 100)
      .sort((a, b) => runPassPct(a) - runPassPct(b));
    if (weak.length) {
      const w = weak[0]!;
      pushFinding(
        "execution",
        `Some configs still fail despite a stronger config passing: weakest config is ${configLabel(w)} at ${runPassPct(w)}% task success. Treat "best config" as a ceiling, not as product-wide success.`,
      );
    }
  }

  // Attribution finding from the strongest run.
  const strongest = best ? runs.find((r) => r.profile === best.profile) : undefined;
  if (strongest) {
    const fails = strongest.outcomes.filter((o) => !o.success);
    const planFails = fails.filter((o) => planLimited(strongest.trace, o.taskId));
    const productFails = !discoveryWeak(strongest.discovery)
      ? fails.filter((o) => !planLimited(strongest.trace, o.taskId))
      : [];
    if (productFails.length) {
      pushFinding(
        "execution",
        `Even the best agent failed ${productFails.length} task(s) it could find — the friction is in the API or docs, not discovery.`,
      );
    } else if (planFails.length) {
      pushFinding("execution", `${planFails.length} failure(s) are plan/sandbox limits, not problems with the API itself.`);
    } else if (fails.length === 0) {
      const allConfigsPassed = runs.every((r) => firstAttempts(r.outcomes).every((o) => o.success));
      pushFinding(
        "execution",
        allConfigsPassed
          ? "Every config passed every task."
          : "At least one config passed every task, but other configs still failed; inspect the matrix before treating this as product-wide success.",
      );
    }
  }

  // Allow one extra slot when the content-quality axis contributed a finding,
  // so it doesn't crowd out the attribution finding.
  return findings.slice(0, stat?.contentQuality ? 4 : 3);
}

function renderFindings(title: string, findings: Finding[], id?: string): string {
  const body = findings.length
    ? `<ul class="ax-findings">${findings.map((f) => `<li class="ax-finding">${esc(f.detail)}</li>`).join("")}</ul>`
    : `<p class="ax-empty">No findings — no runs recorded.</p>`;
  return `<section class="ax-section"${id ? ` id="${esc(id)}"` : ""}>
    <h2>${esc(title)}</h2>
    ${body}
  </section>`;
}

function renderRecommendations(title: string, recs: Recommendation[], note: string, id?: string): string {
  const actionable = (r: Recommendation): string => {
    // Structured target/evidence/fix rows when present (agent-actionable shape).
    const rows = [
      r.target ? `<div class="ax-rec__row"><span class="ax-rec__key">Target</span><span>${esc(r.target)}</span></div>` : "",
      r.evidence ? `<div class="ax-rec__row"><span class="ax-rec__key">Evidence</span><span>${esc(r.evidence)}</span></div>` : "",
      r.fix ? `<div class="ax-rec__row"><span class="ax-rec__key">Fix</span><span>${esc(r.fix)}</span></div>` : "",
    ].filter(Boolean).join("");
    return rows ? `<div class="ax-rec__grid">${rows}</div>` : "";
  };
  const body = recs.length
    ? `<ol class="ax-recs">${recs
        .map(
          (r) => `<li class="ax-rec ax-rec--${r.priority}">
        <span class="ax-rec__badge">${esc(r.priority)}</span>
        <div class="ax-rec__body">
          <h3 class="ax-rec__title">${esc(r.title)}</h3>
          <p class="ax-rec__detail">${esc(r.detail)}</p>
          ${actionable(r)}
        </div>
      </li>`,
        )
        .join("\n      ")}</ol>`
    : `<p class="ax-empty">No recommendations — nothing actionable surfaced from this run.</p>`;
  return `<section class="ax-section"${id ? ` id="${esc(id)}"` : ""}>
    <h2>${esc(title)}</h2>
    <p class="ax-note">${note}</p>
    ${body}
  </section>`;
}

/** A by-difficulty × profile pass-rate table (HTML). */
function difficultyTable(pack: TargetPack, runs: ProfileRun[]): string {
  const presentDiffs = DIFFS.filter((d) => pack.tasks.some((t) => t.difficulty === d));
  // Same grouped layout as the Summary matrix: surface · harness · effort rows,
  // difficulty columns.
  const head = `<tr><th>surface</th><th>harness</th><th>effort</th>${presentDiffs.map((d) => `<th>${esc(d)}</th>`).join("")}</tr>`;
  const body = groupedConfigRows(runs, (r) =>
    presentDiffs.map((d) => `<td>${rateBadge(firstAttempts(r.outcomes).filter((o) => o.difficulty === d))}</td>`).join(""),
  );
  return `<div class="ax-table-wrap"><table class="ax-table ax-matrix">
      <thead>${head}</thead>
      <tbody>${body}</tbody>
    </table></div>`;
}

function scoreSubsetFootnotes(pack: TargetPack, runs: ProfileRun[]): string {
  const total = pack.tasks.length;
  if (!total) return "";
  const surfaces = [...new Set(runs.map((r) => r.surface ?? "api"))];
  const notes = surfaces
    .map((surface) => {
      const subset = tasksForSurface(pack, surface);
      if (subset.length === total) return "";
      const byDifficulty = DIFFS.map((d) => `${d} ${subset.filter((t) => t.difficulty === d).length}`).join(", ");
      const hasEmptyBucket = DIFFS.some(
        (d) => pack.tasks.some((t) => t.difficulty === d) && subset.every((t) => t.difficulty !== d),
      );
      return `${surface.toUpperCase()} is scored on a surface-aware subset in this report: ${subset.length}/${total} task(s) total (${byDifficulty}).${
        hasEmptyBucket
          ? " A 0/0 cell means there were no scored tasks for that surface in that difficulty bucket, not that the agent failed hidden tasks."
          : ""
      }`;
    })
    .filter(Boolean);
  if (!notes.length) return "";
  return `<p class="ax-note"><strong>Footnote.</strong> ${notes.map(esc).join(" ")}</p>`;
}

/** Discovery scorecard: configs × signals matrix (HTML). Transposed — each
 *  CONFIG is a row and the signals are the (few) columns — so a 12-config run is
 *  12 readable rows instead of 12 unreadable columns. */
function discoveryTable(spec: DiscoverySpec, runs: ProfileRun[]): string {
  const scored = runs.filter((r) => r.discovery);
  if (scored.length === 0) return "";
  const order = ["official", "canonical", "hops", "misled", "auth", "outcome"];
  const present = order.filter((id) => scored.some((r) => r.discovery!.metrics.some((m) => m.id === id)));
  const cellFor = (r: ProfileRun, id: string): string => {
    const m = r.discovery!.metrics.find((x) => x.id === id);
    if (!m) return `<td>—</td>`;
    if (id === "hops") return `<td>${esc(r.discovery!.hops)}</td>`;
    const cls = m.passed ? "ax-pill--pass" : "ax-pill--fail";
    return `<td><span class="ax-pill ${cls}">${m.passed ? "PASS" : "FAIL"}</span></td>`;
  };
  const head = `<tr><th>surface</th><th>harness</th><th>effort</th>${present.map((id) => `<th>${esc(METRIC_LABEL[id] ?? id)}</th>`).join("")}<th>source</th></tr>`;
  const body = groupedConfigRows(
    scored,
    (r) => present.map((id) => cellFor(r, id)).join("") + `<td>${esc(r.discoverySource ?? "self-report")}</td>`,
  );
  return `<h3 class="ax-subhead">Discovery scorecard (Phase 0, per config)</h3>
    <p class="ax-note">Each config cold-starts from only the product name + credentials — no endpoint, docs, or spec — and must find the API itself. A gap here is a behavioral-AEO finding: the surface exists statically but the agent didn't find or use it.</p>
    <div class="ax-table-wrap">
    <table class="ax-table ax-matrix">
      <thead>${head}</thead>
      <tbody>${body}</tbody>
    </table>
    </div>`;
}

/** Static discovery section — the breakdown behind the "Static discovery" pillar:
 *  the per-check v0 conventional-path audit (which weighted checks passed/failed)
 *  plus the v2 docs-graph crawl score. This is where a publisher sees *where they
 *  lose points* and what to add (llms.txt, sitemap, OpenAPI link, …). Empty when
 *  no per-check breakdown was captured (e.g. openapi-only packs with no site). */
function renderStaticDiscovery(stat?: StaticReadiness): string {
  const checks = stat?.v0Checks;
  if (!checks || !checks.length) return "";
  const evaluable = checks.filter((c) => c.status !== "error");
  const totalWeight = evaluable.reduce((s, c) => s + c.weight, 0);
  const earned = evaluable.reduce((s, c) => s + (c.status === "pass" ? c.weight : 0), 0);
  const lost = evaluable.filter((c) => c.status === "fail");
  const pill = (s: string): string =>
    s === "pass"
      ? `<span class="ax-pill ax-pill--pass">PASS</span>`
      : s === "fail"
        ? `<span class="ax-pill ax-pill--fail">MISSING</span>`
        : `<span class="ax-pill">n/a</span>`;
  const rows = checks
    .map(
      (c) => `<tr>
        <td>${esc(c.label)}</td>
        <td>${esc(c.weight)}</td>
        <td>${pill(c.status)}</td>
        <td>${esc(c.detail)}${c.url ? ` <code class="ax-code">${esc(c.url)}</code>` : ""}</td>
      </tr>`,
    )
    .join("");
  const v2 = stat?.v2Score;
  const v2Note =
    v2 !== undefined
      ? ` The v2 docs-graph crawl scored <strong>${esc(v2)}/100</strong> (agent-followable links from the docs root); the headline Static discovery score is <code class="ax-code">max(v0, v2)</code>.`
      : "";
  const lostNote = lost.length
    ? `Points are lost on ${lost.length} missing surface(s): <strong>${esc(lost.map((c) => c.label).join(", "))}</strong>. Adding each (weighted by impact) raises the score.`
    : `All evaluable checks passed.`;
  return `<section class="ax-section" id="static-discovery">
    <h2>Static discovery (docs-site audit)</h2>
    <p class="ax-note">A keyless crawl of the docs <em>website</em> — can an agent-style crawler find the conventional surfaces? Score = weighted share of checks passed: <strong>${esc(earned)}/${esc(totalWeight)} weight → ${esc(stat?.v0Score ?? 0)}/100</strong> (v0).${v2Note} ${lostNote}</p>
    <table class="ax-table">
      <thead><tr><th>surface</th><th>weight</th><th>status</th><th>detail</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

/** Agent discovery (Phase 0) section — the BEHAVIORAL discovery detail: what
 *  THIS run's agent actually did to find the product (cold-start searches, the
 *  endpoint/tools it landed on, auth scheme). This is distinct from the static
 *  docs-site audit above (which crawls the docs website regardless of any run).
 *  Kept as its own section (ahead of content quality + pass rate) because it
 *  gates everything below: if the agent never finds the product, downstream pass
 *  rates can't be interpreted. Empty when the pack declares no discovery target. */
function renderDiscovery(pack: TargetPack, runs: ProfileRun[]): string {
  if (!pack.discovery?.product) return "";
  const table = discoveryTable(pack.discovery, runs);
  if (!table) return "";
  const surface = dominantSurface(runs);
  const intro = staticReflectsAgentDiscovery(surface)
    ? `What the agent actually did this run to find the API on its own — distinct from the static docs-site crawl in the Summary.`
    : `What the agent actually did this run to find the ${surface.toUpperCase()} tools (by listing them, not by crawling the docs website). This is the discovery channel that gates the ${surface.toUpperCase()} task results — distinct from the static docs-site crawl in the Summary.`;
  return `<section class="ax-section" id="agent-discovery">
    <h2>Agent discovery (Phase 0, behavioral)</h2>
    <p class="ax-note">${esc(intro)}</p>
    ${table}
  </section>`;
}

/** Section 5 — pass-rate scores at a glance (discovery is its own section). */
function renderScores(
  pack: TargetPack,
  runs: ProfileRun[],
  profileOf: (n: string) => HarnessProfile | null,
): string {
  // Per-config overall task success + model already live in the Summary matrix;
  // Scores adds the per-difficulty (L1–L4) breakdown, same grouped layout.
  void profileOf;
  const footnote = scoreSubsetFootnotes(pack, runs);
  return `<section class="ax-section" id="scores">
    <h2>Scores</h2>
    <h3 class="ax-subhead">Pass rate by difficulty (L1–L4) — per config</h3>
    <p class="ax-note">Each config's pass rate split by task difficulty. Overall task success per config is in the <a href="#tldr">Summary</a> matrix.</p>
    ${difficultyTable(pack, runs)}
    ${footnote}
  </section>`;
}

/**
 * Evidence files — the raw artifacts each profile was assembled from. We surface
 * paths only (never inline transcript content), so the rendered HTML stays
 * compact and shareable while a reader who wants to drill in knows exactly
 * which files to open. Multi-attempt runs list each attempt's results/trace.
 */
function renderEvidence(runs: ProfileRun[]): string {
  const withEvidence = runs.filter(
    (r) => r.evidence && (r.evidence.results?.length || r.evidence.trace?.length || r.evidence.transcript),
  );
  if (!withEvidence.length) return "";
  const list = (paths?: string[]): string =>
    paths && paths.length ? paths.map((p) => code(p)).join("<br>") : "—";
  const rows = groupedConfigRows(withEvidence, (r) => {
    const ev = r.evidence!;
    return `<td>${list(ev.results)}</td><td>${list(ev.trace)}</td><td>${ev.transcript ? code(ev.transcript) : "—"}</td>`;
  });
  return `<h3 class="ax-subhead">Evidence files (per config)</h3>
    <p class="ax-note">Raw artifacts this report was assembled from. Open these files to inspect anything the rendered HTML doesn't show — agent reasoning, full tool I/O, or the unfiltered call sequence.</p>
    <div class="ax-table-wrap"><table class="ax-table ax-matrix">
      <thead><tr><th>surface</th><th>harness</th><th>effort</th><th>results</th><th>trace</th><th>transcript</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

/** Run provenance: the host harness AX Eval executed in (additive, optional). */
function renderProvenance(probe: HarnessProbe): string {
  const rows: Array<[string, string]> = [
    ["host", `${esc(probe.hostLabel)} (${code(probe.host)}, confidence ${esc(probe.confidence)})`],
    ["model", code(probe.model ?? "host-default")],
    ["node", code(probe.node)],
    ["platform", code(`${probe.platform}/${probe.arch}`)],
    ["detected_at", esc(probe.detectedAt)],
  ];
  const body = rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join("");
  const signals = probe.signals.length ? probe.signals.map((s) => code(s)).join(", ") : "none";
  const sug = probe.suggestion;
  return `<h3 class="ax-subhead">Run provenance (host harness)</h3>
    <table class="ax-table">
      <thead><tr><th>field</th><th>value</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="ax-note">Detected from environment signals (key names only — no values): ${signals}. Suggested profile(s): ${esc(
      sug.profiles.join(", "),
    )} — ${esc(sug.reason)}.</p>`;
}

/**
 * Run configuration — the knobs that set the run's *scope* (tasks, profiles,
 * attempts, turn budget). Deliberately framed as configuration, not "cost":
 * these are what was run, and the levers a reader can turn, not a spend figure.
 */
function renderRunConfig(
  pack: TargetPack,
  runs: ProfileRun[],
  profiles: HarnessProfile[],
): string {
  const k = maxAttempts(runs);
  const turnSet = new Set(profiles.map((p) => p.maxTurns));
  const turnBudget =
    profiles.length === 0
      ? "host-default"
      : turnSet.size === 1
        ? String(profiles[0]!.maxTurns)
        : "varies by profile";
  const profileNames = runs.map((r) => r.profile).join(", ") || "—";
  const harnessNames = [...new Set(runs.map((r) => r.harness ?? "host-agent"))].join(", ") || "—";
  const rows: Array<[string, string]> = [
    ["tasks in set", code(String(pack.tasks.length))],
    ["harnesses run", code(harnessNames)],
    ["profiles run", `${runs.length} (${esc(profileNames)})`],
    [
      "attempts per task",
      `${code(String(k))}${k > 1 ? " — pass@k, with a sandbox reset between attempts" : ""}`,
    ],
    ["turn budget (max turns)", code(turnBudget)],
  ];
  const body = rows.map(([key, v]) => `<tr><td>${esc(key)}</td><td>${v}</td></tr>`).join("");
  return `<h3 class="ax-subhead">Run configuration</h3>
    <table class="ax-table">
      <thead><tr><th>setting</th><th>value</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

/** Section 6 — methodology / provenance. */
function renderMethodology(
  pack: TargetPack,
  runs: ProfileRun[],
  profileOf: (n: string) => HarnessProfile | null,
  probe?: HarnessProbe,
  warnings?: string[],
): string {
  const profiles = runs.map((r) => profileOf(r.profile)).filter((p): p is HarnessProfile => !!p);
  // Ground-truth model per run: what the harness reported running, falling back
  // to the profile's declared label. Cross-model is judged on these ACTUAL
  // models so two runs of the same profile on different `--model` slugs are
  // correctly flagged as a model comparison (not an effort-only spread).
  const ranModel = (r: ProfileRun): string => r.model ?? profileOf(r.profile)?.model ?? "host-default";
  const crossModel = new Set(runs.map(ranModel)).size > 1;

  const rows = groupedConfigRows(runs, (r) => {
    const p = profileOf(r.profile);
    const ns = r.ns ? code(r.ns) : "—";
    const model = ranModel(r);
    if (!p) return `<td>${code(model)}</td><td>unregistered</td><td>unregistered</td><td>${ns}</td>`;
    return `<td>${code(model)}</td><td>${esc(p.autonomy)}</td><td>${esc(p.maxTurns)}</td><td>${ns}</td>`;
  });

  const notes: string[] = [];
  if (profiles.length > 1) {
    const uniformTurns = new Set(profiles.map((p) => p.maxTurns)).size === 1;
    const varied = crossModel ? "model + effort" : VARIED_VARIABLE;
    const controlled = crossModel
      ? CONTROLLED_VARIABLES.filter((v) => v !== "model").join(", ")
      : CONTROLLED_VARIABLES.join(", ");
    notes.push(
      `Experiment design — controlled: ${controlled}` +
        `${uniformTurns ? ` (maxTurns=${profiles[0]!.maxTurns} for all)` : " (⚠ maxTurns differs — confounded)"}; varied: ${varied}.`,
    );
  }
  if (crossModel && runs.length > 1) {
    const models = [...new Set(runs.map(ranModel))];
    notes.push(
      `Cross-model run: profiles ran on different models (${models.join(", ")}), so differences in task success may reflect ` +
        `the model, the effort setting, or both — not the product alone. Compare same-model rows to isolate effort.`,
    );
  } else if (!crossModel && runs.length > 1) {
    const sharedModel = ranModel(runs[0]!);
    const effortProfiles = profiles.map((profile) => profile.name).join("↔");
    notes.push(
      `All profiles ran on the same model (${sharedModel}) with the same turn budget, so the ` +
        `effort spread (${effortProfiles}) reflects effort only — not a model, turn-budget, or harness difference.`,
    );
  }
  notes.push(
    "Round-trip oracles verify success independently of the executor: the agent creates a resource and reports its " +
      "id, then the verifier GETs that resource, strips the response envelope, and asserts a server-confirmed field. " +
      "Passing requires real API state, not the agent's self-report.",
  );

  // Surface any runtime issues (missing trace files, unreadable transcripts,
  // partial static readiness, etc.) the CLI captured during verify so the
  // report is honest about what couldn't be measured rather than silently
  // omitting it. Lives next to the controlled-variable notes so a reader sees
  // the caveats before they read the numbers.
  const warningsBlock = warnings && warnings.length > 0
    ? `<div class="ax-warnings">
      <h3 class="ax-subhead">Runtime notes &amp; caveats</h3>
      <ul class="ax-warnings__list">
        ${warnings.map((w) => `<li>${esc(w)}</li>`).join("\n        ")}
      </ul>
    </div>`
    : "";

  return `<section class="ax-section" id="methodology">
    <h2>Methodology &amp; provenance</h2>
    ${renderRunConfig(pack, runs, profiles)}
    <h3 class="ax-subhead">Harness profiles (execution config)</h3>
    <div class="ax-table-wrap"><table class="ax-table ax-matrix">
      <thead><tr><th>surface</th><th>harness</th><th>effort</th><th>model</th><th>autonomy</th><th>max turns</th><th>namespace</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${notes.map((n) => `<p class="ax-note">${esc(n)}</p>`).join("\n    ")}
    ${warningsBlock}
    ${renderEvidence(runs)}
    ${probe ? renderProvenance(probe) : ""}
  </section>`;
}

/** Section 7 — appendix: per-task detail (lower emphasis). */
function renderAppendix(pack: TargetPack, runs: ProfileRun[]): string {
  const tasks = pack.tasks
    .map((task) => {
      const surfaces = task.allowed_surfaces.join(", ") || "any";
      const perProfile = runs
        .map((r) => {
          const all = r.outcomes.filter((x) => x.taskId === task.id);
          const o = all[0];
          if (!o) return "";
          // With --attempts > 1 the merged run holds one outcome per attempt;
          // show the attempt vector and base the detail on the first attempt.
          const attemptTag =
            all.length > 1 ? ` <span class="ax-task__diff">(passed ${all.filter((x) => x.success).length}/${all.length} attempts)</span>` : "";
          const plan = !o.success && planLimited(r.trace, task.id);
          const blocked =
            !o.success &&
            !plan &&
            discoveryWeak(r.discovery) &&
            o.oracleResults.some((orr) => /no gid/i.test(orr.detail));
          const mark = o.success
            ? "PASS"
            : plan
              ? "FAIL (plan-limited)"
              : blocked
                ? "FAIL (discovery-blocked?)"
                : "FAIL";
          const markClass = o.success ? "ax-pass" : "ax-fail";
          const oracleItems = o.oracleResults
            .map(
              (orr) =>
                `<li><span class="${orr.passed ? "ax-pass" : "ax-fail"}">${orr.passed ? "PASS" : "FAIL"}</span> ${esc(
                  orr.type,
                )}: ${esc(orr.detail)}</li>`,
            )
            .join("");
          const steps = (r.trace ?? []).filter((s) => s.taskId === task.id && (s.method || s.path));
          const traceList = steps.length
            ? `<ul class="ax-trace">${steps
                .map(
                  (s) =>
                    `<li>${esc(s.method ?? "?")} ${esc(s.path ?? "?")}${
                      s.status !== undefined ? ` → ${esc(s.status)}` : ""
                    }${s.note ? ` <span class="ax-task__diff">${esc(s.note)}</span>` : ""}</li>`,
                )
                .join("")}</ul>`
            : "";
          return `<p class="ax-outcome"><span class="${markClass}">${esc(runLabel(r))}: ${esc(mark)}</span>${attemptTag}${
            o.error ? " " + esc(`(${o.error})`) : ""
          }</p>
          <ul class="ax-oracles">${oracleItems}</ul>${traceList}`;
        })
        .join("");
      return `<details class="ax-task">
        <summary>${esc(task.id)} <span class="ax-task__diff">[${esc(task.difficulty)}] · surfaces: ${esc(surfaces)}</span></summary>
        <div class="ax-prompt">${esc(task.prompt.trim())}</div>
        ${perProfile}
      </details>`;
    })
    .join("\n      ");

  return `<section class="ax-section ax-appendix">
    <h2>Appendix — per-task detail</h2>
    ${tasks}
  </section>`;
}

/** CI gate banner — only rendered when a `--min-pass-rate` threshold was set. */
function renderGate(runs: ProfileRun[], gate?: ReportGate): string {
  if (!gate || gate.minPassRate === undefined) return "";
  const rate = overallRate(runs);
  const total = runs.flatMap((r) => r.outcomes).length;
  const passed = runs.flatMap((r) => r.outcomes).filter((o) => o.success).length;
  const ok = rate >= gate.minPassRate;
  const ratePct = Math.round(rate * 100);
  const minPct = Math.round(gate.minPassRate * 100);
  const surfaces = SURFACE_ORDER.filter((s) => runs.some((r) => (r.surface ?? "api") === s));
  const subgates = surfaces.map((s) => {
    const outcomes = runs.filter((r) => (r.surface ?? "api") === s).flatMap((r) => r.outcomes);
    const pass = outcomes.filter((o) => o.success).length;
    const pct0 = outcomes.length ? Math.round((pass / outcomes.length) * 100) : 0;
    return { surface: s, pct: pct0, pass, total: outcomes.length, ok: pct0 >= minPct };
  });
  const anySubFail = subgates.some((s) => !s.ok);
  const gateClass = ok ? (anySubFail ? "ax-gate--warn" : "ax-gate--pass") : "ax-gate--fail";
  const subgateLabel = subgates.length > 1
    ? ` Surface subgates: ${subgates
        .map((s) => `${s.surface.toUpperCase()} ${s.ok ? "PASS" : "FAIL"} ${s.pct}% (${s.pass}/${s.total})`)
        .join(" · ")}.`
    : "";
  return `<div class="ax-gate ${gateClass}">
      <span class="ax-gate__status">Overall gate: ${ok ? "PASS" : "FAIL"}${ok && anySubFail ? " · Surface gate: FAIL" : ""}</span>
      <span class="ax-gate__detail">Overall pass rate ${ratePct}% (${passed}/${total}) ${
        ok ? "meets" : "is below"
      } the required minimum of ${minPct}%.${subgateLabel}</span>
    </div>`;
}

/**
 * Section — host-agent robustness (pass@k). Surfaces whether the SAME agent
 * succeeds consistently across repeated attempts. Only meaningful with
 * `--attempts > 1`; otherwise we nudge the reader to enable it.
 */
function renderRobustness(runs: ProfileRun[]): string {
  const k = maxAttempts(runs);
  if (k <= 1) {
    return `<section class="ax-section">
    <h2>Robustness (pass@k)</h2>
    <p class="ax-note">Each task ran once. Re-run with <code class="ax-code">--attempts N</code> (default 3) to measure host-agent robustness — whether the same agent succeeds consistently across repeated attempts — and to surface flaky tasks. The sandbox is reset between attempts so runs don't contaminate each other.</p>
  </section>`;
  }

  // Same grouped layout as the matrix — this is the ONE section that grows with
  // attempts, and it grows by content (a flaky list), never by columns.
  const body = groupedConfigRows(runs, (r) => {
    const tasks = robustnessByTask(r);
    const total = tasks.length;
    const anyPass = tasks.filter((t) => t.passes >= 1).length;
    const allPass = tasks.filter((t) => t.passes === t.attempts).length;
    const flaky = tasks.filter((t) => t.passes > 0 && t.passes < t.attempts);
    const k0 = tasks.length ? Math.max(...tasks.map((t) => t.attempts)) : k;
    const flakyLabel = flaky.length ? flaky.map((t) => `${t.taskId} (${t.passes}/${t.attempts})`).join(", ") : "none";
    const flakyClass = flaky.length ? "ax-fail" : "ax-pass";
    return `<td>${esc(k0)}</td><td>${esc(anyPass)}/${esc(total)}</td><td>${esc(allPass)}/${esc(total)}</td><td class="${flakyClass}">${esc(flakyLabel)}</td>`;
  });

  return `<section class="ax-section">
    <h2>Robustness (pass@k)</h2>
    <p class="ax-note">Each task ran up to ${esc(k)} times per config with a sandbox reset between attempts. <strong>pass@k</strong> = solved on at least one attempt; <strong>all-k</strong> = solved on every attempt (fully reliable); <strong>flaky</strong> = solved on some but not all. The headline matrix reports pass@1; this section is where the multi-attempt detail lives.</p>
    <div class="ax-table-wrap"><table class="ax-table ax-matrix">
      <thead><tr><th>surface</th><th>harness</th><th>effort</th><th>attempts (k)</th><th>pass@k</th><th>all-k</th><th>flaky tasks</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </section>`;
}

function renderProcessQuality(runs: ProfileRun[]): string {
  if (!runs.length) return "";
  const body = groupedConfigRows(runs, (r) => {
    const stats = processStats([r])[0]!;
    const source = r.discoverySource ?? (r.discovery ? "self-report" : "not measured");
    const sourceCls = source === "observed" ? "ax-proc-source--ok" : source === "not measured" ? "ax-proc-source--bad" : "ax-proc-source--warn";
    const scopedCls = hasInsufficientTraceCoverage(stats) ? "ax-proc-source--warn" : "ax-proc-source--ok";
    const scoped = stats.expectedTasks ? `${stats.taskScoped}/${stats.expectedTasks}` : "n/a";
    return `<td><span class="ax-count">${esc(stats.calls)}</span></td><td>${countBadge(stats.failed)}</td><td>${countBadge(stats.retryish)}</td><td><span class="ax-proc-source ${scopedCls}">${esc(scoped)}</span></td><td><span class="ax-proc-source ${sourceCls}">${esc(source)}</span></td>`;
  });
  const takeaway = processQualityTakeaway(runs);
  return `<section class="ax-section">
    <h2>Process quality</h2>
    <p class="ax-verdict">${esc(takeaway)}</p>
    <p class="ax-note">These are trace-derived process signals only. They explain how much work the agent needed after discovery: total recorded calls, calls that failed before recovery, repeated same-task/same-path operations that look retry-ish, and whether calls were attributable to individual tasks rather than one coarse batch step. Final task success is still decided by deterministic read-back oracles.</p>
    <div class="ax-table-wrap"><table class="ax-table ax-matrix">
      <thead><tr><th>surface</th><th>harness</th><th>effort</th><th>calls</th><th>failed calls</th><th>retry-ish repeats</th><th>task-scoped trace</th><th>discovery evidence</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  </section>`;
}

function renderSectionGroup(id: string, title: string, intro: string, sections: string[]): string {
  const body = sections.filter(Boolean).join("\n");
  if (!body) return "";
  return `<section class="ax-group" id="${esc(id)}">
    <div class="ax-group__head">
      <div class="ax-eyebrow">Part</div>
      <h2 class="ax-group__title">${esc(title)}</h2>
      <p class="ax-group__intro">${esc(intro)}</p>
    </div>
    ${body}
  </section>`;
}

/** Dedupe structural diffs by their identifying fields (merged multi-attempt
 *  traces can repeat the same mismatch once per attempt). */
function dedupeDiffs(diffs: TraceDiff[]): TraceDiff[] {
  const seen = new Set<string>();
  const out: TraceDiff[] = [];
  for (const d of diffs) {
    const key = `${d.kind}|${d.taskId ?? ""}|${d.expected ?? ""}|${d.actual ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * Section — trace checks. Replays each profile's structured trace against the
 * pack's trace constraints (required/forbidden/order/argument), surfacing the
 * structured diff kinds so reviewers can see *how* a run deviated from the
 * expected API call pattern, not just whether the oracle passed.
 */
function renderTraceChecks(pack: TargetPack, runs: ProfileRun[]): string {
  const withTrace = runs.filter((r) => (r.trace?.length ?? 0) > 0);
  if (!withTrace.length) {
    return `<section class="ax-section">
    <h2>Trace checks</h2>
    <p class="ax-note">No structured traces were captured for this run. Save <code class="ax-code">run-*.trace.json</code> from the executor (or pass <code class="ax-code">--observe</code> transcripts) to enable structural trace checks: required calls, forbidden calls, ordering, and path/argument matching.</p>
  </section>`;
  }

  // One grouped row per config with a result cell; per-config mismatch detail
  // (rare) is listed below, so we don't emit 12 repetitive "PASS" blocks.
  const diffsByLabel: Array<{ label: string; diffs: TraceDiff[] }> = [];
  const resultCell = (r: ProfileRun): string => {
    const surface = r.surface ?? "api";
    if (surface !== "api") return `<td><span class="ax-mcell__sub">n/a — ${esc(surface.toUpperCase())} tools, oracle-gated</span></td>`;
    if (r.traceAttribution === "unattributed") {
      return `<td><span class="ax-mcell__sub">n/a — native calls captured without trustworthy task attribution</span></td>`;
    }
    const diffs = dedupeDiffs(diffTrace(pack, r.trace!, surface));
    if (!diffs.length) return `<td><span class="ax-pill ax-pill--pass">PASS</span> <span class="ax-mcell__sub">${esc(r.trace!.length)} call(s)</span></td>`;
    diffsByLabel.push({ label: runLabel(r), diffs });
    return `<td><span class="ax-pill ax-pill--fail">${esc(diffs.length)} mismatch${diffs.length === 1 ? "" : "es"}</span></td>`;
  };
  const body = groupedConfigRows(withTrace, resultCell);
  const details = diffsByLabel
    .map(
      ({ label, diffs }) => `<h4 class="ax-subhead">${esc(label)}</h4>
        <table class="ax-table"><thead><tr><th>kind</th><th>task</th><th>expected</th><th>observed</th></tr></thead><tbody>${diffs
          .map((d) => `<tr><td><span class="ax-kind">${esc(d.kind)}</span></td><td>${d.taskId ? code(d.taskId) : "—"}</td><td>${d.expected ? code(d.expected) : "—"}</td><td>${d.actual ? code(d.actual) : "—"}</td></tr>`)
          .join("")}</tbody></table>`,
    )
    .join("\n    ");

  return `<section class="ax-section">
    <h2>Trace checks</h2>
    <p class="ax-note">Each config's recorded calls are compared against trace expectations as a process diagnostic; final success is still decided by deterministic read-back oracles. For generated parent→child tasks, a trace mismatch can mean the agent recorded the parent create (for example <code class="ax-code">POST /projects</code>) while the expected child call was separate; treat these as workflow/debugging evidence, not as overriding a 100% task-success cell. Diff kinds: <code class="ax-code">missing_call</code>, <code class="ax-code">extra_call</code>, <code class="ax-code">forbidden_call</code>, <code class="ax-code">order_mismatch</code>, <code class="ax-code">argument_mismatch</code>.</p>
    <div class="ax-table-wrap"><table class="ax-table ax-matrix">
      <thead><tr><th>surface</th><th>harness</th><th>effort</th><th>trace check</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${details ? `<p class="ax-note">Mismatch detail:</p>\n    ${details}` : ""}
  </section>`;
}

/** Optional CI-gate threshold surfaced in the report (set via `--min-pass-rate`). */
export interface ReportGate {
  minPassRate?: number;
}

/**
 * Optional report extras the CLI supplies on top of runs/static/probe:
 *
 * - `gate`: CI threshold for the gate banner.
 * - `generatedAt`: caller-selected timestamp for reproducible persisted reports.
 * - `warnings`: runtime issues the CLI hit while assembling the report (e.g.
 *   "trace file missing for high/a3", "transcript path unreadable",
 *   "static discover skipped: site_url not set"). Surfaced verbatim in
 *   Methodology so the reader sees what couldn't be measured rather than
 *   silently missing data.
 */
export interface ReportOptions {
  gate?: ReportGate;
  warnings?: string[];
  generatedAt?: string;
}

export function renderGeneratedReport(
  pack: TargetPack,
  runs: ProfileRun[],
  staticReadiness?: StaticReadiness,
  probe?: HarnessProbe,
  gateOrOpts?: ReportGate | ReportOptions,
): string {
  // Back-compat: callers pre-warnings passed a bare `ReportGate`. New callers
  // can pass `{ gate, warnings }`. Detect either shape.
  const opts: ReportOptions =
    gateOrOpts && ("gate" in gateOrOpts || "warnings" in gateOrOpts || "generatedAt" in gateOrOpts)
      ? (gateOrOpts as ReportOptions)
      : { gate: gateOrOpts as ReportGate | undefined };
  const gate = opts.gate;
  const warnings = opts.warnings;
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const profileOf = (name: string): HarnessProfile | null => {
    try {
      return getProfile(name);
    } catch {
      return null;
    }
  };
  const hasStatic =
    staticReadiness &&
    (staticReadiness.v0Score !== undefined ||
      staticReadiness.v2Score !== undefined ||
      staticReadiness.contentScore !== undefined);
  const stat = hasStatic ? staticReadiness : undefined;
  const recs = buildRecommendations(pack, runs, stat);
  const findings = buildFindings(pack, runs, stat);
  const discoveryFindings = findings.filter((f) => f.category === "discovery");
  const executionFindings = findings.filter((f) => f.category === "execution");
  const discoveryRecs = recs.filter((r) => r.category === "discovery");
  const executionRecs = recs.filter((r) => r.category !== "discovery");

  const body = [
    renderHeader(pack, generatedAt),
    `<main class="ax-main-inner">`,
    renderProminentCaveat(warnings),
    renderTldr(pack, runs, stat, recs.length),
    renderGate(runs, gate),
    renderScorecard(stat, runs),
    renderSectionGroup(
      "discovery",
      "Discovery",
      "Can agents find the right surface, reach the authoritative source, and get enough usable docs or schema to start operating?",
      [
        renderFindings("Discovery findings", discoveryFindings),
        renderRecommendations(
          "Discovery recommendations",
          discoveryRecs,
          'Prioritized fixes for findability and usability before execution starts: docs entrypoints, auth discovery, canonical calls, and schema quality. The per-endpoint <a href="#content-quality">suggested fixes</a> remain machine-applicable.',
          "discovery-recommendations",
        ),
        renderStaticDiscovery(stat),
        renderDiscovery(pack, runs),
        stat?.contentQuality ? renderContentQualitySection(stat.contentQuality) : "",
      ],
    ),
    renderSectionGroup(
      "execution",
      "Execution",
      "Once discovery is intact, can the agent complete real tasks reliably, and what does the trace say about how cleanly it got there?",
      [
        renderFindings("Execution findings", executionFindings),
        renderRecommendations(
          "Execution recommendations",
          executionRecs,
          "Prioritized fixes for task completion and run quality: capability gaps, verification, retry behavior, and harder follow-up eval design.",
          "execution-recommendations",
        ),
        renderScores(pack, runs, profileOf),
        renderRobustness(runs),
        renderProcessQuality(runs),
        renderTraceChecks(pack, runs),
        renderAppendix(pack, runs),
      ],
    ),
    renderMethodology(pack, runs, profileOf, probe, warnings),
    `</main>`,
  ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AX eval — ${esc(pack.name)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="ax-main">
${body}
</div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Competitive report (surface × product plane of the cube).
// ---------------------------------------------------------------------------

const SURFACE_ORDER: SurfaceId[] = ["api", "cli", "sdk", "mcp"];

/** A color-coded heat cell for a 0–1 metric: hi ≥ 0.8, mid ≥ 0.5, else lo;
 *  null/undefined renders a neutral em-dash. Returns the inner <span> only. */
function heat(n: number | null | undefined): string {
  if (n === null || n === undefined) return `<span class="ax-heat ax-heat--na">—</span>`;
  const cls = n >= 0.8 ? "ax-heat--hi" : n >= 0.5 ? "ax-heat--mid" : "ax-heat--lo";
  return `<span class="ax-heat ${cls}">${Math.round(n * 100)}%</span>`;
}

/** A blocked-cell pill: the surface couldn't be evaluated (no headless auth).
 *  Distinct from a 0% so a reader never confuses "blocked on credentials" with
 *  "the agent failed the tasks". */
function blockedPill(reason: string): string {
  const label =
    reason === "requires-oauth"
      ? "OAuth req'd"
      : reason === "missing-harness"
        ? "no CLI"
        : reason === "invoke-failed"
          ? "invoke failed"
          : "no cred";
  return `<span class="ax-heat ax-heat--blocked" title="blocked: ${esc(reason)}">${esc(label)}</span>`;
}

/** Medal badge for a leaderboard rank (1-based). */
function rankBadge(i: number): string {
  const n = i + 1;
  const cls = n <= 3 ? `ax-rank--${n}` : "ax-rank--n";
  return `<span class="ax-rank ${cls}">${n}</span>`;
}

/** Sort surfaces into the canonical api→cli→sdk→mcp order. */
function bySurfaceOrder(a: SurfaceId, b: SurfaceId): number {
  return SURFACE_ORDER.indexOf(a) - SURFACE_ORDER.indexOf(b);
}

/** Cross-surface: for each product, compare the surfaces head-to-head. */
function renderCrossSurface(records: NormalizedResult[]): string {
  const byProduct = new Map<string, NormalizedResult[]>();
  for (const r of records) {
    const list = byProduct.get(r.product) ?? [];
    list.push(r);
    byProduct.set(r.product, list);
  }
  const blocks = [...byProduct.entries()]
    .filter(([, rs]) => rs.length > 0)
    .map(([product, rs]) => {
      const sorted = [...rs].sort((a, b) => bySurfaceOrder(a.surface, b.surface));
      // Blocked cells are excluded from the "best surface" pick — you can't win
      // on a surface you couldn't run.
      const best = sorted.reduce<NormalizedResult | null>(
        (acc, r) => (r.blocked ? acc : !acc || r.pass_at_1 > acc.pass_at_1 ? r : acc),
        null,
      );
      const rows = sorted
        .map((r) => {
          if (r.blocked) {
            return `<tr class="ax-row--blocked">
          <td>${esc(r.surface)}</td>
          <td>${blockedPill(r.blocked)}</td>
          <td>${blockedPill(r.blocked)}</td>
          <td>${heat(r.discovery_score)}</td>
          <td>${heat(r.content_quality)}</td>
          <td>—</td>
        </tr>`;
          }
          const win = best && r.surface === best.surface && sorted.length > 1;
          const label = `${esc(r.surface)}${win ? ' <span class="ax-task__diff">best</span>' : ""}`;
          return `<tr${win ? ' class="ax-row--best"' : ""}>
          <td>${label}</td>
          <td>${heat(r.pass_at_1)}</td>
          <td>${heat(r.pass_at_k)}${r.attempts > 1 ? ` <span class="ax-task__diff">(k=${esc(r.attempts)})</span>` : ""}</td>
          <td>${heat(r.discovery_score)}</td>
          <td>${heat(r.content_quality)}</td>
          <td>${esc(r.tasks_passed)}/${esc(r.tasks_total)}</td>
        </tr>`;
        })
        .join("");
      return `<h3 class="ax-subhead">${esc(product)}</h3>
      <table class="ax-table">
        <thead><tr><th>surface</th><th>pass@1</th><th>pass@k</th><th>discovery</th><th>content</th><th>tasks</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    })
    .join("\n      ");
  return `<section class="ax-section">
    <h2>Cross-surface (same product)</h2>
    <p class="ax-note">The same task bank + read-back oracle run across each surface a product exposes. Pass@1/pass@k come from the strongest profile; discovery is the share of Phase-0 signals it passed for that surface; content is the OpenAPI content-quality (smell) score, which is product-level (constant across a product's surfaces). This is the surface axis of the competitive cube — which interface serves agents best for each product.</p>
    ${blocks || '<p class="ax-empty">No surface results to compare.</p>'}
  </section>`;
}

/** Cross-product: for each surface, a leaderboard of products by pass@1. */
function renderCrossProduct(records: NormalizedResult[]): string {
  const bySurface = new Map<SurfaceId, NormalizedResult[]>();
  for (const r of records) {
    const list = bySurface.get(r.surface) ?? [];
    list.push(r);
    bySurface.set(r.surface, list);
  }
  const blocks = [...bySurface.entries()]
    .sort((a, b) => bySurfaceOrder(a[0], b[0]))
    .map(([surface, rs]) => {
      // Runnable cells lead, ranked by pass@1; blocked cells sink to the bottom
      // with no medal (they have no score to rank).
      const runnable = rs.filter((r) => !r.blocked).sort((a, b) => b.pass_at_1 - a.pass_at_1 || b.pass_at_k - a.pass_at_k);
      const blocked = rs.filter((r) => r.blocked);
      const rows = runnable
        .map(
          (r, i) => `<tr${i === 0 && runnable.length > 1 ? ' class="ax-row--best"' : ""}>
          <td>${rankBadge(i)}</td>
          <td>${esc(r.product)}</td>
          <td>${heat(r.pass_at_1)}</td>
          <td>${heat(r.pass_at_k)}</td>
          <td>${heat(r.discovery_score)}</td>
          <td>${heat(r.content_quality)}</td>
        </tr>`,
        )
        .concat(
          blocked.map(
            (r) => `<tr class="ax-row--blocked">
          <td>—</td>
          <td>${esc(r.product)}</td>
          <td>${blockedPill(r.blocked as string)}</td>
          <td>${blockedPill(r.blocked as string)}</td>
          <td>${heat(r.discovery_score)}</td>
          <td>${heat(r.content_quality)}</td>
        </tr>`,
          ),
        )
        .join("");
      return `<h3 class="ax-subhead">${esc(surface)} leaderboard</h3>
      <table class="ax-table">
        <thead><tr><th>#</th><th>product</th><th>pass@1</th><th>pass@k</th><th>discovery</th><th>content</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    })
    .join("\n      ");
  return `<section class="ax-section">
    <h2>Cross-product (same surface)</h2>
    <p class="ax-note">A leaderboard per surface: which products are most agent-usable through that interface. <code class="ax-code">content</code> is the OpenAPI content-quality (smell) score — how usable each product's spec is once found. Useful for picking a vendor on a given surface, or for a vendor to see where it ranks.</p>
    ${blocks || '<p class="ax-empty">No product results to compare.</p>'}
  </section>`;
}

function renderCrossHarness(records: NormalizedResult[]): string {
  const harnesses = new Set(records.map((r) => r.harness));
  if (harnesses.size <= 1) return "";
  const byCell = new Map<string, NormalizedResult[]>();
  for (const r of records) {
    const key = `${r.product}::${r.surface}`;
    const list = byCell.get(key) ?? [];
    list.push(r);
    byCell.set(key, list);
  }
  const blocks = [...byCell.entries()]
    .filter(([, rs]) => new Set(rs.map((r) => r.harness)).size > 1)
    .map(([key, rs]) => {
      const [product, surface] = key.split("::");
      const runnable = rs.filter((r) => !r.blocked).sort((a, b) => b.pass_at_1 - a.pass_at_1 || b.pass_at_k - a.pass_at_k);
      const best = runnable[0];
      const rows = rs
        .sort((a, b) => a.harness.localeCompare(b.harness))
        .map((r) => {
          const win = best && r.harness === best.harness && runnable.length > 1;
          if (r.blocked) {
            return `<tr class="ax-row--blocked">
          <td>${esc(r.harness)}</td>
          <td>${blockedPill(r.blocked)}</td>
          <td>${blockedPill(r.blocked)}</td>
          <td>${heat(r.discovery_score)}</td>
          <td>${heat(r.content_quality)}</td>
        </tr>`;
          }
          return `<tr${win ? ' class="ax-row--best"' : ""}>
          <td>${esc(r.harness)}${win ? ' <span class="ax-task__diff">best</span>' : ""}</td>
          <td>${heat(r.pass_at_1)}</td>
          <td>${heat(r.pass_at_k)}</td>
          <td>${heat(r.discovery_score)}</td>
          <td>${heat(r.content_quality)}</td>
        </tr>`;
        })
        .join("");
      return `<h3 class="ax-subhead">${esc(product)} / ${esc(surface)}</h3>
      <table class="ax-table">
        <thead><tr><th>harness</th><th>pass@1</th><th>pass@k</th><th>discovery</th><th>content</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    })
    .join("\n      ");
  if (!blocks) return "";
  return `<section class="ax-section">
    <h2>Cross-harness (same product + surface)</h2>
    <p class="ax-note">When multiple local harnesses have records for the same product/surface cell, this compares them without changing the oracle. A blocked local CLI is shown as blocked, not as a failed task run.</p>
    ${blocks}
  </section>`;
}

/**
 * Render the local competitive report: the surface × product plane, from
 * normalized records. If records contain more than one harness, it also renders
 * a local cross-harness view for matching product/surface cells.
 */
export function renderCompetitiveReport(
  records: NormalizedResult[],
  opts: { harness?: string; generatedAt?: string } = {},
): string {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const harnesses = [...new Set(records.map((r) => r.harness))];
  const products = [...new Set(records.map((r) => r.product))];
  const surfaces = [...new Set(records.map((r) => r.surface))];
  const meta: Array<[string, string]> = [
    ["generated", esc(generatedAt)],
    ["harness", code(opts.harness ?? (harnesses.join(", ") || "(unknown)"))],
    ["products", esc(products.length)],
    ["surfaces", esc(surfaces.length)],
    ["cells", esc(records.length)],
  ];
  const rows = meta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("\n      ");
  const header = `<header class="ax-header">
    <div class="ax-eyebrow">Agent usability — competitive report</div>
    <h1 class="ax-title">Which surface serves agents best?</h1>
    <p class="ax-subtitle">The same tasks + read-back oracle, run across every surface (API / CLI / SDK / MCP) each product exposes. This is the surface × product plane.</p>
    <dl class="ax-meta">
      ${rows}
    </dl>
  </header>`;

  const body = [
    header,
    `<main class="ax-main-inner">`,
    renderCrossSurface(records),
    renderCrossProduct(records),
    renderCrossHarness(records),
    `<section class="ax-section">
      <h2>Methodology &amp; scope</h2>
      <p class="ax-note">Each cell is a normalized <code class="ax-code">${esc(NORMALIZED_RESULT_SCHEMA)}</code> record keyed by { surface, product, harness }. Metrics report the strongest profile. The surface × product tables answer which interface serves agents best; the optional cross-harness table answers which local agent CLI performed best for the same product/surface, without changing the deterministic oracle.</p>
    </section>`,
    `</main>`,
  ].join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AX eval — competitive report</title>
<style>${STYLE}</style>
</head>
<body>
<div class="ax-main">
${body}
</div>
</body>
</html>
`;
}
