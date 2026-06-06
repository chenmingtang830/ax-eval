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
import type { SurfaceId } from "../surface/types.js";
import { NORMALIZED_RESULT_SCHEMA, type NormalizedResult } from "./record.js";
import type { TraceStep } from "../harness/executor.js";
import { diffTrace, type TraceDiff } from "../harness/trace-diff.js";
import {
  getProfile,
  profilesAreCrossModel,
  CONTROLLED_VARIABLES,
  VARIED_VARIABLE,
  type HarnessProfile,
} from "../harness/profile.js";
import type { HarnessProbe } from "../harness/probe.js";
import { REPORT_STYLE } from "../report-style.js";
import { renderContentQualitySection, type SpecQualityAudit } from "../static/smells.js";

export interface ProfileRun {
  profile: string;
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
  priority: "high" | "med" | "low";
  title: string;
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

/** Signal ids whose failure plausibly blocks downstream execution. Only
 *  `canonical` blocks: an agent can complete tasks without ever opening the
 *  official docs (reaching `official`) as long as it found the right endpoint,
 *  so gating on `official` over-fires "discovery-blocked?" on real successes. */
const BLOCKING_SIGNALS = ["canonical"] as const;

// ---------------------------------------------------------------------------
// Pure analysis helpers (shared by the recommendations engine + the renderer).
// ---------------------------------------------------------------------------

function passCount(outcomes: RoundtripOutcome[]): number {
  return outcomes.filter((o) => o.success).length;
}

function pct(outcomes: RoundtripOutcome[]): number {
  return outcomes.length ? Math.round((passCount(outcomes) / outcomes.length) * 100) : 0;
}

/** "2/3 (67%)" label for a set of outcomes. */
function rateLabel(outcomes: RoundtripOutcome[]): string {
  return `${passCount(outcomes)}/${outcomes.length} (${pct(outcomes)}%)`;
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

/** Highest behavioral pass rate across profiles (the strongest agent config). */
function bestBehavioralPct(runs: ProfileRun[]): { pct: number; profile: string } | null {
  let best: { pct: number; profile: string } | null = null;
  for (const r of runs) {
    if (r.outcomes.length === 0) continue;
    const p = pct(r.outcomes);
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

  // Representative discovery: prefer the strongest profile's, else any scored.
  const repDiscovery = strongest?.discovery ?? runs.find((r) => r.discovery)?.discovery;
  const missed = (id: string): boolean =>
    !!repDiscovery && repDiscovery.metrics.find((m) => m.id === id)?.passed === false;

  const v0 = staticReadiness?.v0Score;
  const v2 = staticReadiness?.v2Score;
  const readiness = readinessScore(staticReadiness);

  // 1) High readiness + low behavioral → the headline "exposed ≠ usable" gap.
  if (readiness !== undefined && best && readiness >= 50 && readiness - best.pct >= 20) {
    recs.push({
      priority: "high",
      title: "Close the gap between published and usable",
      detail:
        `Discoverability is ${readiness}/100 but the best agent (${best.profile}) completed only ` +
        `${best.pct}% of tasks — a ${readiness - best.pct}-point gap. The API is published, but agents still ` +
        `can't reliably use it. The discovery and docs fixes below are the priority.`,
    });
  }

  // 2) Discovery missed `official` → agents never reached the official docs.
  if (missed("official")) {
    recs.push({
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
      priority: "med",
      title: "Docs aren't link-reachable (likely a client-rendered SPA)",
      detail:
        `The docs-graph crawl scored ${v2}/100 — almost no agent-followable links were found from the docs root` +
        (v0 !== undefined && v0 > v2
          ? ` (conventional-path readiness is ${v0}/100, so the content exists but isn't crawlable)`
          : "") +
        ". Add server-rendered links, a sitemap.xml, and an llms.txt so non-JS crawlers and agents can traverse the docs.",
    });
  }

  // 5) Product-attributed failures: strongest agent failed and discovery held.
  if (strongest) {
    const fails = strongest.outcomes.filter((o) => !o.success);
    const planFails = fails.filter((o) => planLimited(strongest.trace, o.taskId));
    const held = !discoveryWeak(strongest.discovery);
    const productFails = held ? fails.filter((o) => !planLimited(strongest.trace, o.taskId)) : [];
    if (productFails.length) {
      recs.push({
        priority: "high",
        title: "Product/docs gap: the strongest agent still failed",
        detail:
          `The strongest profile (${strongest.profile}) failed ${productFails.length} non-plan task(s) ` +
          `(${productFails.map((o) => o.taskId).join(", ")}) with discovery intact. When the best agent fails and ` +
          "discovery held up, the gap points at the product/docs — fix the API ergonomics or the docs for these tasks.",
      });
    }
    // 6) Plan-limited failures → sandbox/plan limits, NOT product gaps.
    if (planFails.length) {
      recs.push({
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
      priority: contentScore < 50 ? "high" : "med",
      title: "Improve the OpenAPI spec's content quality",
      detail:
        `The spec scores ${contentScore}/100 on content quality` +
        (cq ? ` (${cq.totalSmells} smell(s) across ${cq.endpointsAnalyzed} endpoints)` : "") +
        ". Structural validity isn't agent-readiness — fix the documentation/REST smells flagged in the " +
        "Content quality section (undocumented inputs, weak response schemas, unclear auth) so an agent can " +
        "construct calls and interpret results without guessing.",
    });
  }

  // 8) Everything passes → positive note + suggest hardening.
  const ranOutcomes = runs.flatMap((r) => r.outcomes);
  if (ranOutcomes.length > 0 && !ranOutcomes.some((o) => !o.success)) {
    recs.push({
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
function renderHeader(pack: TargetPack, generatedAt: string): string {
  const meta: Array<[string, string]> = [
    ["generated", esc(generatedAt)],
    ["standard_set_version", code(pack.standard_set_version || "(unset)")],
    ["run_id", code(pack.run_id || "(unversioned)")],
    ["base_url", code(pack.base_url || "(unset)")],
    ["generated_by", code(pack.generated_by || "(unset)")],
  ];
  const rows = meta.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join("\n      ");
  return `<header class="ax-header">
    <div class="ax-eyebrow">Agent-readiness report</div>
    <h1 class="ax-title">How well can an AI agent use <span class="ax-target">${esc(pack.name)}</span>?</h1>
    <p class="ax-subtitle">We ran live tasks against the API to measure what an AI agent can actually complete — not just what the docs expose.</p>
    <dl class="ax-meta">
      ${rows}
    </dl>
  </header>`;
}

/** Pick a pass/warn/fail card modifier for the readiness↔behavioral gap. */
function gapClass(gap: number): string {
  if (gap <= 0) return "ax-card--pass";
  if (gap < 20) return "ax-card--warn";
  return "ax-card--fail";
}

/** Section 2 — one-line verdict + 3 scorecard metric cards. */
function renderScorecard(stat: StaticReadiness | undefined, runs: ProfileRun[]): string {
  const best = bestBehavioralPct(runs);
  const readiness = readinessScore(stat);
  const haveGap = readiness !== undefined && best;
  const gap = haveGap ? readiness! - best!.pct : undefined;

  let verdict: string;
  if (!best) {
    verdict = "No agent runs recorded yet — nothing to score.";
  } else if (readiness === undefined) {
    verdict = `The best agent completed ${best.pct}% of tasks. (Discoverability wasn't measured for this run.)`;
  } else if (gap! > 0) {
    verdict = `The API is published and discoverable (${readiness}/100), but the best agent finished only ${best.pct}% of real tasks — a ${gap}-point gap. Being published isn't the same as being usable by agents.`;
  } else {
    verdict = `Agents can actually use this API: task success (${best.pct}%) is on par with or above its discoverability (${readiness}/100).`;
  }

  const v0 = stat?.v0Score;
  const v2 = stat?.v2Score;
  const readinessSub =
    [v0 !== undefined ? `v0 ${v0}` : null, v2 !== undefined ? `v2 ${v2}` : null]
      .filter(Boolean)
      .join(" · ") || "not measured";

  const content = stat?.contentScore;
  const cards: string[] = [];
  cards.push(
    `<div class="ax-card">
        <span class="ax-card__value">${readiness !== undefined ? esc(readiness) : "—"}</span>
        <span class="ax-card__label">Discoverability</span>
        <span class="ax-card__sub">${esc(readinessSub)}</span>
      </div>`,
  );
  // Content quality (v3 smell audit) — the orthogonal "once found, is it usable?"
  // axis. Only shown when an openapi_url was configured + audited.
  if (content !== undefined) {
    const contentClass = content >= 80 ? "ax-card--pass" : content >= 50 ? "ax-card--warn" : "ax-card--fail";
    cards.push(
      `<div class="ax-card ${contentClass}">
        <span class="ax-card__value">${esc(content)}</span>
        <span class="ax-card__label">Content quality</span>
        <span class="ax-card__sub">spec smells · 0–100</span>
      </div>`,
    );
  }
  cards.push(
    `<div class="ax-card">
        <span class="ax-card__value">${best ? esc(best.pct) + "%" : "—"}</span>
        <span class="ax-card__label">Task success</span>
        <span class="ax-card__sub">${best ? "best agent: " + esc(best.profile) : "no runs"}</span>
      </div>`,
  );
  cards.push(
    `<div class="ax-card ${gap !== undefined ? gapClass(gap) : ""}">
        <span class="ax-card__value">${gap !== undefined ? (gap > 0 ? "+" : "") + esc(gap) : "—"}</span>
        <span class="ax-card__label">Gap</span>
        <span class="ax-card__sub">${gap !== undefined ? (gap > 0 ? "published but not usable" : "usable") : "needs both metrics"}</span>
      </div>`,
  );

  return `<section class="ax-section ax-scorecard-section">
    <h2>Summary</h2>
    <p class="ax-verdict">${esc(verdict)}</p>
    <div class="ax-scorecard${cards.length >= 4 ? " ax-scorecard--four" : ""}">
      ${cards.join("\n      ")}
    </div>
  </section>`;
}

/** Build 2–3 prioritized plain-text findings from the data. */
function buildFindings(pack: TargetPack, runs: ProfileRun[], stat?: StaticReadiness): string[] {
  const findings: string[] = [];
  const best = bestBehavioralPct(runs);
  const readiness = readinessScore(stat);

  if (best && readiness !== undefined) {
    const gap = readiness - best.pct;
    findings.push(
      gap > 0
        ? `Discoverability is ${readiness}/100 but only ${best.pct}% of tasks succeed — a ${gap}-point gap between published and usable.`
        : `Task success (${best.pct}%) is on par with or above discoverability (${readiness}/100) — agents can actually use it.`,
    );
  } else if (best) {
    findings.push(`The best agent (${best.profile}) completed ${best.pct}% of tasks; discoverability wasn't measured.`);
  }

  // Content-quality axis: flag when the spec, once found, is hard to use.
  const cq = stat?.contentQuality;
  if (cq && stat?.contentScore !== undefined && stat.contentScore < 80) {
    const top = (Object.keys(cq.byCategory) as (keyof typeof cq.byCategory)[])
      .filter((c) => cq.byCategory[c] > 0)
      .sort((a, b) => cq.byCategory[b] - cq.byCategory[a])[0];
    findings.push(
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
        if (m.id !== "hops" && !m.passed) missing.add(METRIC_LABEL[m.id] ?? m.id);
      }
    }
    findings.push(
      missing.size
        ? `Agents had trouble finding the API on their own: ${[...missing].join(", ")}.`
        : "Agents reliably found the API on their own (every discovery signal passed).",
    );
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
      findings.push(
        `Even the best agent failed ${productFails.length} task(s) it could find — the friction is in the API or docs, not discovery.`,
      );
    } else if (planFails.length) {
      findings.push(`${planFails.length} failure(s) are plan/sandbox limits, not problems with the API itself.`);
    } else if (fails.length === 0) {
      findings.push("The best agent passed every task.");
    }
  }

  // Allow one extra slot when the content-quality axis contributed a finding,
  // so it doesn't crowd out the attribution finding.
  return findings.slice(0, stat?.contentQuality ? 4 : 3);
}

/** Section 3 — key findings. */
function renderFindings(pack: TargetPack, runs: ProfileRun[], stat?: StaticReadiness): string {
  const findings = buildFindings(pack, runs, stat);
  const body = findings.length
    ? `<ul class="ax-findings">${findings.map((f) => `<li class="ax-finding">${esc(f)}</li>`).join("")}</ul>`
    : `<p class="ax-empty">No findings — no runs recorded.</p>`;
  return `<section class="ax-section">
    <h2>Key findings</h2>
    ${body}
  </section>`;
}

/** Section 4 — recommendations from the engine. */
function renderRecommendations(recs: Recommendation[]): string {
  const body = recs.length
    ? `<ol class="ax-recs">${recs
        .map(
          (r) => `<li class="ax-rec ax-rec--${r.priority}">
        <span class="ax-rec__badge">${esc(r.priority)}</span>
        <div class="ax-rec__body">
          <h3 class="ax-rec__title">${esc(r.title)}</h3>
          <p class="ax-rec__detail">${esc(r.detail)}</p>
        </div>
      </li>`,
        )
        .join("\n      ")}</ol>`
    : `<p class="ax-empty">No recommendations — nothing actionable surfaced from this run.</p>`;
  return `<section class="ax-section">
    <h2>Recommendations</h2>
    ${body}
  </section>`;
}

/** A by-difficulty × profile pass-rate table (HTML). */
function difficultyTable(pack: TargetPack, runs: ProfileRun[]): string {
  const presentDiffs = DIFFS.filter((d) => pack.tasks.some((t) => t.difficulty === d));
  const head = `<tr><th>difficulty</th>${runs.map((r) => `<th>${esc(r.profile)}</th>`).join("")}</tr>`;
  const rows = presentDiffs
    .map(
      (d) =>
        `<tr><td>${esc(d)}</td>${runs
          .map((r) => `<td>${esc(rateLabel(r.outcomes.filter((o) => o.difficulty === d)))}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<table class="ax-table">
      <thead>${head}</thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** A by-profile overall pass-rate table (HTML). */
function profileTable(runs: ProfileRun[], profileOf: (n: string) => HarnessProfile | null): string {
  const rows = runs
    .map((r) => {
      const tag = r.profile === "ceiling" ? " (ceiling / upper bound)" : "";
      const model = profileOf(r.profile)?.model ?? "host-default";
      return `<tr><td>${esc(r.profile + tag)}</td><td>${code(model)}</td><td>${esc(rateLabel(r.outcomes))}</td></tr>`;
    })
    .join("");
  return `<table class="ax-table">
      <thead><tr><th>profile</th><th>model</th><th>overall</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** Discovery scorecard: signals × profiles matrix (HTML). */
function discoveryTable(spec: DiscoverySpec, runs: ProfileRun[]): string {
  const scored = runs.filter((r) => r.discovery);
  if (scored.length === 0) return "";
  const order = ["official", "canonical", "hops", "misled", "auth", "outcome"];
  const head = `<tr><th>signal</th>${scored
    .map((r) => `<th>${esc(r.profile)} (${esc(r.discoverySource ?? "self-report")})</th>`)
    .join("")}</tr>`;
  const rows: string[] = [];
  for (const id of order) {
    if (!scored.some((r) => r.discovery!.metrics.some((m) => m.id === id))) continue;
    const cells = scored
      .map((r) => {
        const m = r.discovery!.metrics.find((x) => x.id === id);
        if (!m) return `<td>—</td>`;
        if (id === "hops") return `<td>${esc(r.discovery!.hops)}</td>`;
        const cls = m.passed ? "ax-pill--pass" : "ax-pill--fail";
        return `<td><span class="ax-pill ${cls}">${m.passed ? "PASS" : "FAIL"}</span></td>`;
      })
      .join("");
    rows.push(`<tr><td>${esc(METRIC_LABEL[id] ?? id)}</td>${cells}</tr>`);
  }
  const summaries = scored
    .map((r) => {
      const failed = r.discovery!.metrics.filter((m) => m.id !== "hops" && !m.passed).map((m) => m.id);
      const summary = failed.length ? `missed: ${failed.join(", ")}` : "all signals passed";
      return `<li>${esc(r.profile)} (${esc(r.discovery!.hops)} hops): ${esc(summary)}.</li>`;
    })
    .join("");
  return `<h3 class="ax-subhead">Discovery scorecard (Phase 0, per profile)</h3>
    <p class="ax-note">Each profile cold-starts from only the product name + credentials — no endpoint, docs, or spec — and must find the API itself. A gap here is a behavioral-AEO finding: the surface exists statically but the agent didn't find or use it.</p>
    <table class="ax-table">
      <thead>${head}</thead>
      <tbody>${rows.join("")}</tbody>
    </table>
    <ul class="ax-oracles">${summaries}</ul>`;
}

/** Discovery (Phase 0) section — the behavioral discoverability detail. Kept as
 *  its own section (ahead of content quality + pass rate) because it gates
 *  everything below: if the agent never finds the API, downstream pass rates
 *  can't be interpreted. Empty when the pack declares no discovery target. */
function renderDiscovery(pack: TargetPack, runs: ProfileRun[]): string {
  if (!pack.discovery?.product) return "";
  const table = discoveryTable(pack.discovery, runs);
  if (!table) return "";
  return `<section class="ax-section">
    <h2>Discovery (Phase 0)</h2>
    ${table}
  </section>`;
}

/** Section 5 — pass-rate scores at a glance (discovery is its own section). */
function renderScores(
  pack: TargetPack,
  runs: ProfileRun[],
  profileOf: (n: string) => HarnessProfile | null,
): string {
  const parts: string[] = [];
  parts.push(`<h3 class="ax-subhead">Pass rate by difficulty</h3>`, difficultyTable(pack, runs));
  parts.push(`<h3 class="ax-subhead">Pass rate by profile</h3>`, profileTable(runs, profileOf));
  return `<section class="ax-section">
    <h2>Scores</h2>
    ${parts.join("\n    ")}
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
  const rows = withEvidence
    .map((r) => {
      const ev = r.evidence!;
      const list = (paths?: string[]): string =>
        paths && paths.length ? paths.map((p) => code(p)).join("<br>") : "—";
      return `<tr>
        <td>${esc(r.profile)}</td>
        <td>${list(ev.results)}</td>
        <td>${list(ev.trace)}</td>
        <td>${ev.transcript ? code(ev.transcript) : "—"}</td>
      </tr>`;
    })
    .join("");
  return `<h3 class="ax-subhead">Evidence files (per profile)</h3>
    <p class="ax-note">Raw artifacts this report was assembled from. Open these files to inspect anything the rendered HTML doesn't show — agent reasoning, full tool I/O, or the unfiltered call sequence.</p>
    <table class="ax-table">
      <thead><tr><th>profile</th><th>results</th><th>trace</th><th>transcript</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
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
  const rows: Array<[string, string]> = [
    ["tasks in set", code(String(pack.tasks.length))],
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
  const crossModel = profilesAreCrossModel(profiles);

  const rows = runs
    .map((r) => {
      const p = profileOf(r.profile);
      const ns = r.ns ? code(r.ns) : "—";
      if (!p) {
        // Unregistered profile (e.g. an ad-hoc `live`): render gracefully.
        return `<tr><td>${esc(r.profile)}</td><td>${code("host-default")}</td><td>unregistered</td><td>unregistered</td><td>unregistered</td><td>${ns}</td></tr>`;
      }
      const model = p.model ?? "host-default";
      return `<tr><td>${esc(p.name + (p.ceiling ? " (ceiling)" : ""))}</td><td>${code(model)}</td><td>${esc(p.effort)}</td><td>${esc(p.autonomy)}</td><td>${esc(p.maxTurns)}</td><td>${ns}</td></tr>`;
    })
    .join("");

  const notes: string[] = [];
  if (profiles.length > 1) {
    const uniformTurns = new Set(profiles.map((p) => p.maxTurns)).size === 1;
    notes.push(
      `Experiment design — controlled: ${CONTROLLED_VARIABLES.join(", ")}` +
        `${uniformTurns ? ` (maxTurns=${profiles[0]!.maxTurns} for all)` : " (⚠ maxTurns differs — confounded)"}; varied: ${VARIED_VARIABLE}.`,
    );
  }
  if (!crossModel && profiles.length > 1) {
    const sharedModel = profiles[0]!.model ?? "host-default";
    notes.push(
      `All profiles ran on the same model (${sharedModel}, the host agent) with the same turn budget, so the ` +
        `floor↔ceiling spread reflects effort only — not a model, turn-budget, or harness difference.`,
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

  return `<section class="ax-section">
    <h2>Methodology &amp; provenance</h2>
    ${renderRunConfig(pack, runs, profiles)}
    <h3 class="ax-subhead">Harness profiles (execution config)</h3>
    <table class="ax-table">
      <thead><tr><th>profile</th><th>model</th><th>effort</th><th>autonomy</th><th>max turns</th><th>namespace</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
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
          return `<p class="ax-outcome"><span class="${markClass}">${esc(r.profile)}: ${esc(mark)}</span>${attemptTag}${
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
  return `<div class="ax-gate ${ok ? "ax-gate--pass" : "ax-gate--fail"}">
      <span class="ax-gate__status">CI gate: ${ok ? "PASS" : "FAIL"}</span>
      <span class="ax-gate__detail">Pass rate ${ratePct}% (${passed}/${total}) ${
        ok ? "meets" : "is below"
      } the required minimum of ${minPct}%.</span>
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

  const rows = runs
    .map((r) => {
      const tasks = robustnessByTask(r);
      const total = tasks.length;
      const anyPass = tasks.filter((t) => t.passes >= 1).length;
      const allPass = tasks.filter((t) => t.passes === t.attempts).length;
      const flaky = tasks.filter((t) => t.passes > 0 && t.passes < t.attempts);
      const k0 = tasks.length ? Math.max(...tasks.map((t) => t.attempts)) : k;
      const flakyLabel = flaky.length
        ? flaky.map((t) => `${t.taskId} (${t.passes}/${t.attempts})`).join(", ")
        : "none";
      const flakyClass = flaky.length ? "ax-fail" : "ax-pass";
      return `<tr>
        <td>${esc(r.profile)}</td>
        <td>${esc(k0)}</td>
        <td>${esc(anyPass)}/${esc(total)}</td>
        <td>${esc(allPass)}/${esc(total)}</td>
        <td class="${flakyClass}">${esc(flakyLabel)}</td>
      </tr>`;
    })
    .join("");

  return `<section class="ax-section">
    <h2>Robustness (pass@k)</h2>
    <p class="ax-note">Each task ran up to ${esc(k)} times per profile with a sandbox reset between attempts. <strong>pass@k</strong> = solved on at least one attempt; <strong>all-k</strong> = solved on every attempt (fully reliable); <strong>flaky</strong> = solved on some but not all. This measures host-agent reliability across repeated attempts — not a comparison across models or agents.</p>
    <table class="ax-table">
      <thead><tr><th>profile</th><th>attempts (k)</th><th>pass@k</th><th>all-k</th><th>flaky tasks</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
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

  const blocks = withTrace
    .map((r) => {
      const diffs = dedupeDiffs(diffTrace(pack, r.trace!));
      if (!diffs.length) {
        return `<h3 class="ax-subhead">${esc(r.profile)}</h3>
        <p class="ax-outcome"><span class="ax-pass">PASS — no structural mismatches</span> across ${esc(
          r.trace!.length,
        )} recorded call(s).</p>`;
      }
      const rows = diffs
        .map(
          (d) => `<tr>
          <td><span class="ax-kind">${esc(d.kind)}</span></td>
          <td>${d.taskId ? code(d.taskId) : "—"}</td>
          <td>${d.expected ? code(d.expected) : "—"}</td>
          <td>${d.actual ? code(d.actual) : "—"}</td>
        </tr>`,
        )
        .join("");
      return `<h3 class="ax-subhead">${esc(r.profile)} — ${esc(diffs.length)} mismatch${
        diffs.length === 1 ? "" : "es"
      }</h3>
        <table class="ax-table">
          <thead><tr><th>kind</th><th>task</th><th>expected</th><th>observed</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    })
    .join("\n    ");

  return `<section class="ax-section">
    <h2>Trace checks</h2>
    <p class="ax-note">Each profile's recorded API calls are compared against the expected call pattern. Diff kinds: <code class="ax-code">missing_call</code>, <code class="ax-code">extra_call</code>, <code class="ax-code">forbidden_call</code>, <code class="ax-code">order_mismatch</code>, <code class="ax-code">argument_mismatch</code>.</p>
    ${blocks}
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
 * - `warnings`: runtime issues the CLI hit while assembling the report (e.g.
 *   "trace file missing for ceiling/a3", "transcript path unreadable",
 *   "static discover skipped: site_url not set"). Surfaced verbatim in
 *   Methodology so the reader sees what couldn't be measured rather than
 *   silently missing data.
 */
export interface ReportOptions {
  gate?: ReportGate;
  warnings?: string[];
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
    gateOrOpts && ("gate" in gateOrOpts || "warnings" in gateOrOpts)
      ? (gateOrOpts as ReportOptions)
      : { gate: gateOrOpts as ReportGate | undefined };
  const gate = opts.gate;
  const warnings = opts.warnings;
  const generatedAt = new Date().toISOString();
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

  const body = [
    renderHeader(pack, generatedAt),
    `<main class="ax-main-inner">`,
    renderGate(runs, gate),
    renderScorecard(stat, runs),
    renderFindings(pack, runs, stat),
    renderRecommendations(recs),
    // Discoverability detail → content-quality detail → pass rate: the content
    // quality section sits between "can the agent find it" and "did it succeed".
    renderDiscovery(pack, runs),
    stat?.contentQuality ? renderContentQualitySection(stat.contentQuality) : "",
    renderScores(pack, runs, profileOf),
    renderRobustness(runs),
    renderTraceChecks(pack, runs),
    renderMethodology(pack, runs, profileOf, probe, warnings),
    renderAppendix(pack, runs),
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
  const label = reason === "requires-oauth" ? "OAuth req'd" : "no cred";
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

/**
 * Render the local competitive report: the surface × product plane, from
 * normalized records. The third axis (which agent/harness ran the tasks) is
 * intentionally NOT computed here; this report covers a single harness and
 * emits normalized records that can be aggregated across many runs later.
 * `harnessNote` surfaces which harness produced these records so a reader
 * knows the records are single-harness.
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
    <div class="ax-eyebrow">Agent Experience — competitive report</div>
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
    `<section class="ax-section">
      <h2>Methodology &amp; scope</h2>
      <p class="ax-note">Each cell is a normalized <code class="ax-code">${esc(NORMALIZED_RESULT_SCHEMA)}</code> record keyed by { surface, product, harness }. Metrics report the strongest profile. These records are single-harness by design — the skill computes the surface × product plane locally and emits normalized records that can be aggregated across many runs later without re-deriving anything.</p>
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
