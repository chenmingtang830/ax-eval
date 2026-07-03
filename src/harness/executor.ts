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

// Native harness effort knobs do most of the work (codex:
// model_reasoning_effort; Claude Code: --effort). The prompt still names the
// intended behavior so transcripts are interpretable, but the wording stays
// moderate to avoid double-encoding effort as hidden task hints.
const EFFORT_BLOCK: Record<HarnessProfile["effort"], string> = {
  low:
    "Work at a normal, unhurried pace: it's fine to go with the first reasonable approach " +
    "you find rather than cross-checking alternatives, and a light sanity check on results " +
    "is enough — you don't need to exhaustively verify every detail.",
  medium:
    "Take reasonable steps to discover the API and complete each task, with a light sanity " +
    "check, but don't exhaustively investigate.",
  high:
    "Take extra care: confirm the base URL, current endpoints, auth scheme, and any " +
    "prerequisites before acting, inspect responses as you go, recover from errors by " +
    "fixing and retrying, and verify each result reads back before moving on.",
};

/** Per-task instruction. Goal-level — the endpoint is whatever Phase 0 found. */
/** Named fields an oracle check needs the agent to self-report, beyond `gid` —
 *  e.g. Supabase's vector-search check needs `rpc_function_name` because
 *  PostgREST can't order by vector distance itself, so the agent must wrap it
 *  in a Postgres function; that requirement is invisible to the agent unless
 *  surfaced explicitly, since it's vendor-specific verification plumbing the
 *  shared, vendor-agnostic task prompt text has no reason to mention. */
export function namedFieldsFor(task: Task): string[] {
  const names = new Set<string>();
  const placeholderRe = /\{([a-z][a-z0-9_]*)\}/g;
  const collect = (value: unknown) => {
    if (typeof value === "string") {
      for (const m of value.matchAll(placeholderRe)) {
        const name = m[1];
        if (name && name !== "ns" && name !== "gid") names.add(name);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>)) collect(entry);
    }
  };
  for (const oracle of task.oracles) {
    if (oracle.authField) names.add(oracle.authField);
    if (oracle.sqlConnField) names.add(oracle.sqlConnField);
    for (const text of [oracle.readPathTemplate, oracle.sqlQuery]) {
      if (!text) continue;
      for (const m of text.matchAll(placeholderRe)) {
        const name = m[1];
        if (name && name !== "ns" && name !== "gid") names.add(name);
      }
    }
    collect(oracle.readBodyTemplate);
    collect(oracle.mongoQuery);
  }
  return [...names];
}

function taskLine(task: Task, ns: string): string {
  const base = `- ${task.id} [${task.difficulty}]: ${applyNs(task.prompt, ns).trim()}`;
  const extra = namedFieldsFor(task);
  if (!extra.length) return base;
  return `${base}\n  (also self-report, alongside gid: ${extra.map((n) => `\`${n}\``).join(", ")})`;
}

function envTemplateNames(text: string): string[] {
  return [...new Set([...text.matchAll(/\$\{([A-Z0-9_]+)\}/g)].map((match) => match[1]).filter((name): name is string => Boolean(name)))];
}

function surfaceCredentialEnvNames(pack: TargetPack): string[] {
  const names = new Set<string>();
  for (const surface of Object.values(pack.surfaces ?? {})) {
    const auth = surface?.auth;
    if (!auth) continue;
    if (auth.kind === "token" && auth.token_env) names.add(auth.token_env);
    if (auth.kind === "oauth_app") {
      if (auth.client_id_env) names.add(auth.client_id_env);
      if (auth.refresh_token_env) names.add(auth.refresh_token_env);
    }
  }
  return [...names].filter((name) => name !== pack.auth?.env);
}

/** Tell the agent which .env vars hold the credential + sandbox scope. Derived
 *  from the pack's declarations (target-agnostic); falls back to the legacy Asana
 *  vars only for Asana packs that predate the `auth`/`sandbox_scope` blocks. */
function credentialBlock(pack: TargetPack): string[] {
  const lines: string[] = [];
  if (!pack.auth?.env && pack.sandbox_scope.length === 0) {
    if (/asana/i.test(pack.name)) {
      lines.push(
        `Use process.env.ASANA_PAT, process.env.ASANA_SANDBOX_PROJECT_GID, and process.env.ASANA_SANDBOX_WORKSPACE_GID`,
        `(use the leading numeric portion of each scope value).`,
      );
    } else {
      lines.push(`No credential env var is declared by this pack; do not assume product-specific default credentials.`);
    }
    return lines;
  }
  const authVar = pack.auth?.env || "the credential var";
  lines.push(`Use process.env.${authVar} for the credential.`);
  const templateVars = envTemplateNames(pack.base_url);
  if (templateVars.length) {
    lines.push(`Use process.env for non-secret endpoint/context variable(s): ${templateVars.join(", ")}; use these values literally when constructing hosts or URLs.`);
  }
  const surfaceCreds = surfaceCredentialEnvNames(pack);
  if (surfaceCreds.length) {
    lines.push(`Other declared sandbox credential env var(s), if the docs require them for this surface: ${surfaceCreds.join(", ")}.`);
  }
  if (pack.mongo_conn?.database) {
    lines.push(`Use MongoDB database name "${pack.mongo_conn.database}" for MongoDB data-plane work.`);
  }
  for (const p of pack.sandbox_scope) {
    const req = p.required ? "" : " (optional)";
    const note = p.instructions ? ` — ${p.instructions}` : "";
    lines.push(`Use process.env.${p.env}${req} = the sandbox ${p.name}${note}`);
  }
  if (pack.sandbox_scope.length) {
    lines.push(`For sandbox scope vars only, use the leading numeric/id portion if the value is pasted as a URL; do not split endpoint/context vars such as host, org, project-ref, or database names.`);
  }
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
  /** Optional explicit task subset for task-level execution mode. Defaults to
   *  every task eligible on the selected surface. */
  tasks?: Task[];
}

/** Build the full sub-agent prompt for one (pack × profile × ns × surface) run. */
export function buildExecutorPrompt(opts: BuildPromptOptions): string {
  const { pack, profile, ns, resultsPath, tracePath } = opts;
  const surface = opts.surface ?? apiSurface;
  const tasks = opts.tasks ?? tasksForSurface(pack, surface.id);
  const resultsShape = tasks.map((task) => {
    const fields = ["\"gid\": \"<gid or null>\"", ...namedFieldsFor(task).map((field) => `"${field}": "<value or null>"`)];
    return `      "${task.id}": {${fields.join(", ")}}`;
  }).join(",\n");
  const effortLabel = `${profile.effort.toUpperCase()}-EFFORT`;
  const taskScope = tasks.length === 1
    ? `THIS ONE TASK`
    : `ALL tasks`;
  const completionLine = tasks.length === 1
    ? `When done, report whether the task succeeded or failed and the id.`
    : `When done, report which tasks succeeded/failed and the ids.`;

  return [
    `You are an agent being evaluated on whether you can discover and use the ${pack.name} ${surface.subject}`,
    `from a cold start. Work in the repo root.`,
    ``,
    `=== PROFILE: "${profile.name}" (${effortLabel}, effort=${profile.effort}, model=${profile.model ?? "host-default"}) ===`,
    EFFORT_BLOCK[profile.effort],
    `Budget: at most ~${profile.maxTurns} ${surface.actionUnit} total across discovery + ${taskScope}.`,
    ``,
    `=== CREDENTIALS (the "where", not the "how") ===`,
    `The harness has already loaded declared .env values into the child process environment.`,
    ...credentialBlock(pack),
    `Secret hygiene is mandatory: never print, cat, grep, rg, echo, or include .env contents or secret values in stdout, trace, notes, or results.`,
    `Do not use file-reading tools to open .env. In scripts, read only the specific process.env names you need, use them silently, and report only env-var NAMES or redacted placeholders such as <token>.`,
    `The token is provided, but you must still DISCOVER how to authenticate with it and`,
    `what the base URL / endpoints are (Phase 0).`,
    ``,
    ...surface.setupBlock(pack),
    ...surface.discoveryBlock(pack),
    `=== NAMESPACE ===`,
    `Every task name below already has the namespace "${ns}" substituted in. Create resources`,
    `with EXACTLY those names — do not change them.`,
    `Do not delete, reset, overwrite, or mutate pre-existing resources that were not created in this run.`,
    `If a quota or sandbox limit blocks a task, record that task as failed instead of cleaning up unrelated resources.`,
    ``,
    `=== PHASE 1 — TASKS (use ONLY what you discovered in Phase 0) ===`,
    ...tasks.map((t) => taskLine(t, ns)),
    ``,
    `Treat tasks as independent best-effort attempts: if one task fails, record that task's gid as null, log the failure, and continue with the remaining tasks instead of aborting the whole run.`,
    ``,
    `For each task capture the created resource's id (for the L2 child task, report the CHILD`,
    `id). If a task truly fails, record gid as null.`,
    ``,
    `Some tasks need more than just "gid" reported to be verifiable — e.g. a second identity/credential (row-`,
    `level access control needs two signed-in users' tokens to demonstrate isolation between them), or a`,
    `specific value only you determine while doing the task (e.g. the id of a particular row you're using to`,
    `test something, or the exact duplicate value you attempted). Whenever a task's instructions imply this,`,
    `report each such extra value as an EXTRA key alongside that task's "gid" in your results JSON — e.g.`,
    `{"gid": "<created row id>", "user_a_token": "<user A's signed-in token>", "user_b_token": "<user B's`,
    `signed-in token>", "test_row_id": "<a specific row's id>"}. Use short, descriptive key names; these are`,
    `read back by the verifier.`,
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
    completionLine,
  ].join("\n");
}
