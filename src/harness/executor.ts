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

export const NS_PLACEHOLDER = "{ns}";

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

/** Resolve a per-execution namespace: <genVersion>-<profile>-<shortRand>. */
export function resolveNs(runId: string, profile: string): string {
  const rand = Math.random().toString(36).slice(2, 6);
  const base = (runId || "gen").replace(/[^a-z0-9-]/gi, "");
  return `${base}-${profile}-${rand}`;
}

/** Substitute {ns} everywhere in a string. */
export function applyNs(text: string, ns: string): string {
  return text.split(NS_PLACEHOLDER).join(ns);
}

const SENSITIVE_RESULT_TOKENS = new Set([
  "auth",
  "bearer",
  "credential",
  "dsn",
  "key",
  "password",
  "passwd",
  "secret",
  "token",
]);

function isSensitiveResultField(name: string): boolean {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return normalized.split(/[^a-z0-9]+/).some((part) => SENSITIVE_RESULT_TOKENS.has(part));
}

export function taskResultKeys(task: Task): string[] {
  const keys = new Set<string>(["gid"]);
  const scan = (value: unknown) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        const key = match[1];
        if (key && key !== "gid" && key !== "ns" && !isSensitiveResultField(key)) keys.add(key);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) scan(entry);
      return;
    }
    if (value && typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>)) scan(entry);
    }
  };
  scan(task.create_path);
  for (const oracle of task.oracles) {
    scan(oracle.readPathTemplate);
    scan(oracle.readQueryTemplate);
    scan(oracle.readBodyTemplate);
    scan(oracle.sqlQuery);
    scan(oracle.mongoQuery);
  }
  return [...keys];
}

function taskResultShape(task: Task): string {
  const fields = taskResultKeys(task)
    .map((key) => `"${key}": "<${key} or null>"`)
    .join(", ");
  return `      "${task.id}": {${fields}}`;
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
  const line = `- ${task.id} [${task.difficulty}]: ${applyNs(task.prompt, ns).trim()}`;
  const extraKeys = taskResultKeys(task).filter((key) => key !== "gid");
  return extraKeys.length > 0
    ? `${line}\n  Also report these non-secret verification fields: ${extraKeys.join(", ")}.`
    : line;
}

/** Tell the agent which process env vars hold the credential + sandbox scope. Derived
 *  from the pack's declarations (target-agnostic); falls back to the legacy Asana
 *  vars when a pack predates the `auth`/`sandbox_scope` blocks. */
function credentialBlock(pack: TargetPack): string[] {
  const lines: string[] = [];
  if (!pack.auth?.env && pack.sandbox_scope.length === 0) {
    if (/asana/i.test(pack.name)) {
      lines.push(
        `Use process.env.ASANA_PAT, process.env.ASANA_SANDBOX_PROJECT_GID, and process.env.ASANA_SANDBOX_WORKSPACE_GID`,
        `(use the leading numeric portion of each scope value).`,
      );
    } else {
      lines.push(`No credential env var is declared by this pack; do not assume product-specific defaults.`);
    }
    return lines;
  }
  const authVar = pack.auth?.env || "the credential var";
  lines.push(`Use process.env.${authVar} for the credential.`);
  for (const p of pack.sandbox_scope) {
    const req = p.required ? "" : " (optional)";
    const note = p.instructions ? ` — ${p.instructions}` : "";
    lines.push(`Use process.env.${p.env}${req} = the sandbox ${p.name}${note}`);
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
  /** Optional explicit subset for task-level execution. */
  tasks?: Task[];
  /** Reusable discovery context from a prior bootstrap run. */
  sharedDiscovery?: {
    path: string;
    base_url_found?: string;
    endpoint_used?: string;
    auth_scheme_found?: string;
    searches?: string[];
    urls_visited?: string[];
    notes?: string;
  };
}

/** Build the full sub-agent prompt for one (pack × profile × ns × surface) run. */
export function buildExecutorPrompt(opts: BuildPromptOptions): string {
  const { pack, profile, ns, resultsPath, tracePath } = opts;
  const surface = opts.surface ?? apiSurface;
  const tasks = opts.tasks ?? tasksForSurface(pack, surface.id);
  const sharedDiscovery = opts.sharedDiscovery;
  const ids = tasks.map((t) => t.id);
  const resultsShape = tasks.map((task) => taskResultShape(task)).join(",\n");
  const phase0Block = sharedDiscovery
    ? [
        `=== PHASE 0 — SHARED BOOTSTRAP (already completed) ===`,
        `Reuse the prior discovery instead of repeating a cold-start workflow unless it is unusable.`,
        `Shared bootstrap artifact: ${sharedDiscovery.path}`,
        `- base_url_found: ${sharedDiscovery.base_url_found ?? "<unknown>"}`,
        `- endpoint_used: ${sharedDiscovery.endpoint_used ?? "<unknown>"}`,
        `- auth_scheme_found: ${sharedDiscovery.auth_scheme_found ?? "<unknown>"}`,
        `- searches: ${(sharedDiscovery.searches ?? []).join(" | ") || "<none recorded>"}`,
        `- urls_visited: ${(sharedDiscovery.urls_visited ?? []).join(" | ") || "<none recorded>"}`,
        `- notes: ${sharedDiscovery.notes ?? "<none>"}`,
        `Append only real additional discovery to the output discovery object.`,
      ]
    : surface.discoveryBlock(pack);
  const phase1Block = tasks.length > 0
    ? [`=== PHASE 1 — TASKS (use ONLY what you discovered in Phase 0) ===`, ...tasks.map((t) => taskLine(t, ns))]
    : [
        `=== PHASE 1 — SHARED BOOTSTRAP OUTPUT ===`,
        `Do not create benchmark resources; write an empty results object after discovery/bootstrap.`,
      ];

  return [
    `You are an agent being evaluated on whether you can discover and use the ${pack.name} ${surface.subject}`,
    `from a cold start. Work in the repo root.`,
    ``,
    `=== PROFILE: "${profile.name}" (effort=${profile.effort}, model=${profile.model ?? "host-default"}) ===`,
    EFFORT_BLOCK[profile.effort],
    `Budget: at most ~${profile.maxTurns} ${surface.actionUnit} total across discovery + ALL tasks.`,
    ``,
    `=== CREDENTIALS (the "where", not the "how") ===`,
    `The harness has already loaded declared env values into the child process environment.`,
    ...credentialBlock(pack),
    `Never open, print, cat, grep, echo, or include .env contents or secret values in output artifacts.`,
    `Read only the specific process.env names declared above, and use their values silently.`,
    `Any declared credential is provided, but you must still DISCOVER how to authenticate and`,
    `what the base URL / endpoints are (Phase 0).`,
    ``,
    ...surface.setupBlock(pack),
    ...phase0Block,
    `=== NAMESPACE ===`,
    `Every task name below already has the namespace "${ns}" substituted in. Create resources`,
    `with EXACTLY those names — do not change them.`,
    `Do not delete, reset, overwrite, or mutate pre-existing resources that were not created in this run.`,
    `If quota or sandbox limits block a task, record the failure instead of cleaning up unrelated resources.`,
    ``,
    ...phase1Block,
    ``,
    ...(tasks.length > 0
      ? [`Treat tasks as independent best-effort attempts: record a failed task and continue with the remaining tasks.`]
      : []),
    ``,
    ...(tasks.length > 0
      ? [
          `For each task capture the created resource's id (for the L2 child task, report the CHILD`,
          `id). If the results shape shows extra context ids (for example a parent doc or table id),`,
          `report those too. If a task truly fails, record gid as null and leave any extra ids null.`,
          `If a create/mutate call succeeds and returns an id but immediate read-back is temporarily unavailable`,
          `(for example 202/404/409 during async processing), still record the created id and any context ids`,
          `from the successful response or trace rather than dropping them to null.`,
        ]
      : []),
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
    tasks.length === 0
      ? `When done, report the shared discovery/bootstrap you established.`
      : ids.length === 1
        ? `When done, report whether the task succeeded or failed and its id.`
        : `When done, report which tasks succeeded/failed and the ids.`,
  ].join("\n");
}
