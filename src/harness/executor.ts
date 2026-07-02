/**
 * Executor prompt builder — turns a frozen pack + a profile into the exact
 * instructions a host-agent (sub-agent) runs.
 *
 * The run is ONE continuous session in two phases:
 *
 *   Phase 0 — DISCOVERY (cold start). The agent is given only the product name
 *     and credentials. NO base URL, endpoint, request shape, or docs link. It
 *     must web-search to find how the API works, then carry that knowledge
 *     forward. This is the behavioral-AEO layer, run per profile (the `low`
 *     effort profile discovers differently from the `high` one).
 *
 *   Phase 1 — EXECUTION. The L1-L4 tasks, using ONLY what Phase 0 discovered.
 *     Task prompts are goal-level and never name the endpoint, so a bad
 *     discovery causally breaks downstream tasks (as in the real world).
 *
 * Three things are made systematic instead of hand-written:
 *   1. namespace (ns)  — a per-execution token substituted into {ns} in every
 *      task name, so two harnesses never collide on resource names.
 *   2. discovery funnel — the agent must report its search→land→read funnel, so
 *      we can score reach/canonical/hops/misled/auth per profile.
 *   3. trace           — a structured step log, so we can see *how* each profile
 *      got each result (or gave up).
 *
 * The builder is pure/deterministic so it can be unit-tested and reproduced.
 */
import type { HarnessProfile } from "./profile.js";
import type { TargetPack, Task } from "../schemas.js";
import { apiSurface } from "../surface/api.js";
import type { Surface } from "../surface/index.js";
import { tasksForSurface } from "../surface/index.js";
import { applyNs, NS_PLACEHOLDER, resolveNs } from "./namespace.js";
import { taskResultShape } from "./result-shape.js";

export { applyNs, NS_PLACEHOLDER, resolveNs } from "./namespace.js";

/** A single recorded step in an executor run (written to *.trace.json). */
export interface TraceStep {
  step: number;
  taskId: string;
  action: string;
  method?: string;
  path?: string;
  status?: number;
  note?: string;
}

const EFFORT_BLOCK: Record<HarnessProfile["effort"], string> = {
  low:
    "You are a LOW-EFFORT agent. In discovery, do the bare minimum search and stop " +
    "at the first plausible answer. In execution, do the minimum literal steps each " +
    "task names; do NOT investigate prerequisites, inspect responses beyond grabbing " +
    "the id, or verify results. If a call errors, make at most ONE quick retry, then " +
    "record that task as failed (gid null) and move on.",
  medium:
    "You are a MEDIUM-EFFORT agent. Take reasonable steps to discover the API and to " +
    "complete each task, with a light sanity check, but don't exhaustively investigate.",
  high:
    "You are a HIGH-EFFORT agent. Discover thoroughly (confirm the base URL, the current " +
    "endpoints, the auth scheme, and any prerequisites like a required workspace field). " +
    "In execution, inspect responses, recover from errors by fixing and retrying, and " +
    "verify each result reads back.",
};

/** Per-task instruction. Goal-level — the endpoint is whatever Phase 0 found. */
function taskLine(task: Task, ns: string): string {
  return `- ${task.id} [${task.difficulty}]: ${applyNs(task.prompt, ns).trim()}`;
}

/** Tell the agent which .env vars hold the credential + sandbox scope. Derived
 *  from the pack's declarations (target-agnostic); falls back to the legacy Asana
 *  vars when a pack predates the `auth`/`sandbox_scope` blocks. */
function credentialBlock(pack: TargetPack): string[] {
  const lines: string[] = [];
  if (!pack.auth?.env && pack.sandbox_scope.length === 0) {
    lines.push(
      `Read .env for ASANA_PAT, ASANA_SANDBOX_PROJECT_GID, and ASANA_SANDBOX_WORKSPACE_GID`,
      `(use the leading numeric portion of each).`,
    );
    return lines;
  }
  const authVar = pack.auth?.env || "the credential var";
  lines.push(`Read .env for the credential ${authVar}.`);
  for (const p of pack.sandbox_scope) {
    const req = p.required ? "" : " (optional)";
    const note = p.instructions ? ` — ${p.instructions}` : "";
    lines.push(`Read .env for ${p.env}${req} = the sandbox ${p.name}${note}`);
  }
  lines.push(`Use the leading numeric/id portion of each scope value if it's pasted as a URL.`);
  return lines;
}

export interface BuildPromptOptions {
  pack: TargetPack;
  profile: HarnessProfile;
  ns: string;
  /** Where the executor must write its combined results (discovery + tasks). */
  resultsPath: string;
  tracePath: string;
  /** Which surface the agent must operate the product through. Defaults to the
   *  API surface, whose prompt is identical to the original hard-coded flow. */
  surface?: Surface;
}

/** Build the full sub-agent prompt for one (pack × profile × ns × surface) run. */
export function buildExecutorPrompt(opts: BuildPromptOptions): string {
  const { pack, profile, ns, resultsPath, tracePath } = opts;
  const surface = opts.surface ?? apiSurface;
  const tasks = tasksForSurface(pack, surface.id);
  const ids = tasks.map((t) => t.id);
  const resultsShape = tasks.map((task) => taskResultShape(task)).join(",\n");

  return [
    `You are an agent being evaluated on whether you can discover and use the ${pack.name} ${surface.subject}`,
    `from a cold start. Work in the repo root.`,
    ``,
    `=== PROFILE: "${profile.name}" (effort=${profile.effort}, model=${profile.model ?? "host-default"}) ===`,
    EFFORT_BLOCK[profile.effort],
    `Budget: at most ~${profile.maxTurns} ${surface.actionUnit} total across discovery + ALL tasks.`,
    ``,
    `=== CREDENTIALS (the "where", not the "how") ===`,
    ...credentialBlock(pack),
    `The token is provided, but you must still DISCOVER how to authenticate with it and`,
    `what the base URL / endpoints are (Phase 0).`,
    ``,
    ...surface.setupBlock(pack),
    ...surface.discoveryBlock(pack),
    `=== NAMESPACE ===`,
    `Every task name below already has the namespace "${ns}" substituted in. Create resources`,
    `with EXACTLY those names — do not change them.`,
    ``,
    `=== PHASE 1 — TASKS (use ONLY what you discovered in Phase 0) ===`,
    ...tasks.map((t) => taskLine(t, ns)),
    ``,
    `For each task capture the created resource's id (for the L2 child task, report the CHILD`,
    `id). If the results shape shows extra context ids (for example a parent doc or table id),`,
    `report those too. If a task truly fails, record gid as null and leave any extra ids null.`,
    `If a create/mutate call succeeds and returns an id but immediate read-back is temporarily unavailable`,
    `(for example 202/404/409 during async processing), still record the created id and any context ids`,
    `from the successful response or trace rather than dropping them to null.`,
    ``,
    `=== OBSERVABILITY (required) ===`,
    `Log EVERY API call as you go. After finishing, write ${tracePath} as a JSON array of steps:`,
    `[{"step":1,"taskId":"<id or 'discovery'>","action":"create task","method":"POST","path":"/tasks","status":201,"note":"ok"}, ...]`,
    `Record failures too (status + the error message in note).`,
    ``,
    `=== RESULTS (required) ===`,
    `Write ${resultsPath} with EXACTLY this JSON shape:`,
    `{`,
    `  "profile": "${profile.name}",`,
    `  "ns": "${ns}",`,
    `  "surface": "${surface.id}",`,
    `  "discovery": {`,
    `    "base_url_found": "${surface.resultsHints.base}",`,
    `    "searches": ["<each web search query you ran, in order>"],`,
    `    "urls_visited": ["<each URL you opened, in order>"],`,
    `    "endpoint_used": "${surface.resultsHints.endpoint}",`,
    `    "auth_scheme_found": "${surface.resultsHints.auth}",`,
    `    "notes": "<anything that misled you / outdated sources / dead ends>"`,
    `  },`,
    `  "results": {`,
    resultsShape,
    `  }`,
    `}`,
    ``,
    `Honesty matters: the discovery funnel is scored, so record your real searches/URLs.`,
    `${surface.actionGuidance(pack)} Do not edit any files other than ${resultsPath} and ${tracePath}.`,
    `When done, report which tasks succeeded/failed and the ids.`,
  ].join("\n");
}
