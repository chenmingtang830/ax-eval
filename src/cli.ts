#!/usr/bin/env node
/**
 * `ax-eval` command-line entrypoint.
 *
 *   ax-eval run [--pack p] [--harness h]... [--out o] [--offline]  behavioral matrix + static gap
 *   ax-eval audit [--pack p | --site url] [--offline]              static readiness audit only
 *   ax-eval smells --openapi <url> [--html out] [--out json] [--offline]  content-quality (OpenAPI smell) audit
 *   ax-eval report <results.json>                                  render a saved result file
 *   ax-eval list-harnesses                                         show registered harnesses
 *   ax-eval probe [--out json]                                     detect host harness + suggest profile
 *   ax-eval init --pack <yaml>                                     print a .env stub for a pack
 *   ax-eval check-env --pack <yaml>                                  show env required by the pack
 *   ax-eval verify-generated --pack <yaml> --results <run.json>...   generated-run verify + CI gate
 *       [--min-pass-rate 0.8] [--html path]
 *   ax-eval ingest --openapi <url> [--out json] [--offline]          parse a spec → IngestedSpec
 *   ax-eval ingest --graphql <endpoint|file> [--out json] [--offline] introspect a GraphQL schema → rich IngestedGraphql
 *   ax-eval generate --from <ingest.json> [--product P] [--site url]   IngestedSpec → pack draft
 *                    [--docs url,url] [--limit N] [--l2-limit N] [--l3-limit N]
 *                    [--l4-limit N] [--base-url url] [--out yaml] [--deterministic]
 *                    [--generator-harness codex|claude-code] [--generator-model m] [--generator-effort high]
 *                    REST: L1 create · L2 chain · L3 goal · L4 lifecycle; GraphQL: L1 create + read-back oracles
 *   ax-eval verify-generated --pack <yaml> --results <run.json>...   round-trip oracles → HTML report
 *       [--html path] writes the self-contained HTML report (--md is an alias that also writes HTML).
 *   ax-eval render-generated --snapshot <report.snapshot.json>       re-render a saved generated report snapshot
 *       [--html path] without re-running live verification
 *   ax-eval trace-diff --pack <yaml> --trace <run.trace.json>         structural trace diff
 *   ax-eval reset --pack <yaml> [--ns <token>] [--dry-run]           delete probe resources (pass@k hygiene)
 *   ax-eval exec-plan --invoke --harness claude-code|codex [--profile high] run prompts locally
 */
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { availableHarnesses } from "./adapters/registry.js";
import { loadDotenv, loadPack } from "./config.js";
import { render } from "./reporting.js";
import { run } from "./runner.js";
import { auditSite } from "./static/audit.js";
import { discoverSurfaces, renderDiscovery } from "./static/discover.js";
import { auditSpecQuality, renderSpecQuality, renderSpecQualityHtml } from "./static/smells.js";
import { renderAudit, renderGap } from "./static/render.js";
import { loadReport, saveReport } from "./storage.js";
import { fetchSpecText, ingestFromUrl } from "./ingest/run.js";
import { ingestGraphqlDetailed } from "./ingest/graphql.js";
import { generatePack, packToYaml, type GenerateOptions } from "./generate/pack.js";
import { generateGraphqlPack, looksLikeGraphqlIngest, type GenerateGraphqlPackOptions } from "./generate/graphql-pack.js";
import { loadResults, loadTrace, verifyGeneratedPack } from "./generate/verify.js";
import {
  GENERATED_REPORT_SNAPSHOT_SCHEMA,
  loadGeneratedReportSnapshot,
  renderGeneratedSnapshot,
  saveGeneratedReportSnapshot,
  type GeneratedReportSnapshot,
} from "./generate/snapshot.js";
import {
  renderCompetitiveReport,
  renderGeneratedReport,
  type ProfileRun,
  type StaticReadiness,
} from "./generate/report.js";
import {
  buildNormalizedResult,
  buildNormalizedResultCells,
  buildBlockedResult,
  type NormalizedResult,
} from "./generate/record.js";
import { isSurfaceId, type SurfaceId } from "./surface/types.js";
import { TargetPackSchema, type TargetPack } from "./schemas.js";
import { getSurface, resolveSurfaceSelection, tasksForSurface } from "./surface/index.js";
import { checkApproval, reviewSummary, writeApproval } from "./generate/review.js";
import { scoreDiscovery, type DiscoveryResult } from "./generate/discovery.js";
import { buildExecutorPrompt, resolveNs } from "./harness/executor.js";
import {
  defaultInvokePaths,
  detectInvokeHarness,
  INVOKE_HARNESS_IDS,
  isInvokeHarnessId,
  runInvokeHarness,
  type InvokeHarnessId,
  type InvokeRunOptions,
} from "./harness/invoke.js";
import { provisionHarnessForSurface } from "./harness/mcp-provision.js";
import { observedToDiscovery, observedToTrace, parseTranscript } from "./harness/transcript.js";
import { diffTrace, renderTraceDiffs } from "./harness/trace-diff.js";
import { getProfile, type HarnessProfile } from "./harness/profile.js";
import { probeHarness } from "./harness/probe.js";
import { BearerClient } from "./http/client.js";
import { describeRequiredEnv, hasRequiredEnv, resolveScope, resolveToken, surfaceAuthStatus, type SurfaceAuthStatus } from "./target/config.js";
import { resetPack } from "./target/reset.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACK = resolve(HERE, "..", "targets", "examples", "asana", "pack.yaml");
const INVOKE_HARNESS_LIST = INVOKE_HARNESS_IDS.join("|");
const COMMANDS = [
  "run",
  "audit",
  "discover",
  "smells",
  "report",
  "list-harnesses",
  "probe",
  "check-env",
  "init",
  "verify",
  "ingest",
  "generate",
  "review",
  "exec-plan",
  "verify-generated",
  "render-generated",
  "competitive",
  "trace-diff",
  "reset",
  "mcp-server",
] as const;
const COMMAND_SET = new Set<string>(COMMANDS);
const USAGE = `usage: ax-eval <${COMMANDS.join("|")}> [options]`;

function isHelpToken(value: string | undefined): boolean {
  return value === "--help" || value === "-h" || value === "help";
}

function commandUsage(command: string | undefined): string {
  switch (command) {
    case "smells":
      return "usage: ax-eval smells --openapi <url> [--html out.html] [--out json] [--offline]";
    case "report":
      return "usage: ax-eval report <results.json>";
    case "ingest":
      return "usage: ax-eval ingest (--openapi <url> | --graphql <endpoint|file>) [--out json] [--offline]";
    case "generate":
      return [
        "usage: ax-eval generate --from <ingest.json> [--product P] [--site url]",
        "                       [--docs url,url] [--limit N] [--l2-limit N] [--l3-limit N] [--l4-limit N]",
        "                       [--base-url url] [--out yaml] [--deterministic]",
        "                       [--generator-harness codex|claude-code] [--generator-model m]",
        "                       [--generator-effort low|medium|high]",
      ].join("\n");
    case "review":
      return "usage: ax-eval review --pack <yaml> [--approve --by <name>]";
    case "exec-plan":
      return `usage: ax-eval exec-plan --pack <yaml> [--harness ${INVOKE_HARNESS_LIST}] [--profile name] [--surface api|cli|sdk|mcp|all] [--invoke]`;
    case "verify-generated":
    case "verify":
      return "usage: ax-eval verify-generated --pack <yaml> --results <run.json>... [--html out.html] [--snapshot out.json] [--min-pass-rate 0.8]";
    case "competitive":
      return "usage: ax-eval competitive --results <run.normalized.json>... [--html out.html]";
    case "render-generated":
      return "usage: ax-eval render-generated --snapshot <report.snapshot.json> [--html out.html]";
    case "trace-diff":
      return "usage: ax-eval trace-diff --pack <yaml> --trace <run.trace.json>";
    case "reset":
      return "usage: ax-eval reset --pack <yaml> [--ns <token>] [--dry-run]";
    case "run":
      return "usage: ax-eval run [--pack <yaml>] [--harness name]... [--out results.json] [--offline]";
    case "audit":
      return "usage: ax-eval audit [--pack <yaml> | --site url] [--offline]";
    case "discover":
      return "usage: ax-eval discover [--pack <yaml> | --site url] [--max-pages N] [--max-depth N] [--offline]";
    case "list-harnesses":
      return "usage: ax-eval list-harnesses";
    case "probe":
      return "usage: ax-eval probe [--out json]";
    case "check-env":
      return "usage: ax-eval check-env --pack <yaml> [--surface api|cli|sdk|mcp|all]";
    case "init":
      return "usage: ax-eval init --pack <yaml> [--surface api|cli|sdk|mcp|all]";
    default:
      return USAGE;
  }
}

interface Parsed {
  pack: string;
  harness: string[];
  profile: string[];
  /** Optional model slug to run the harness as (`--model`). Overrides the
   *  profile's declared model; lets a user compare arbitrary models by issuing
   *  one run per model and stacking the records with `competitive`. */
  model: string;
  /** Optional effort level (`--effort low|medium|high`). Overrides the profile's
   *  effort, and is translated to each harness's native convention at invocation
   *  (codex → model_reasoning_effort; claude-code → prompt-level). */
  effort: string;
  deterministic: boolean;
  generatorHarness: string;
  generatorModel: string;
  generatorEffort: string;
  /** Max harness invocations to run at once (`--concurrency`, default 4). Parallel
   *  by default for speed; `1` forces serial. Concurrent runs use distinct
   *  namespaces so they don't collide in the sandbox. */
  concurrency: number;
  /** Per-invocation wall-clock cap in seconds (`--invoke-timeout`, default 900).
   *  A harness child that exceeds it is killed so one wedged agent can't stall
   *  the whole matrix; the cell is retried (see `invokeRetries`) then recorded
   *  as a timeout failure. 0 disables the cap. */
  invokeTimeout: number;
  /** Retries for a failed/timed-out invocation (`--invoke-retries`, default 1).
   *  0 disables retries. */
  invokeRetries: number;
  out: string;
  site: string;
  product: string;
  docs: string;
  offline: boolean;
  task: string;
  all: boolean;
  md: string;
  html: string;
  openapi: string;
  graphql: string;
  snapshot: string;
  from: string;
  baseUrl: string;
  limit: number;
  l2Limit: number | undefined;
  l3Limit: number | undefined;
  l4Limit: number | undefined;
  results: string[];
  runId: string;
  runDir: string;
  observe: Record<string, string>;
  maxPages: number;
  maxDepth: number;
  approve: boolean;
  by: string;
  skipReview: boolean;
  invoke: boolean;
  dryRun: boolean;
  ns: string;
  attempts: number;
  minPassRate: number | undefined;
  trace: string;
  /** Raw `--surface` value: a concrete id (api/cli/sdk/mcp) or `all`. exec-plan
   *  fans out across the resolved selection; verify uses the concrete id (if any)
   *  to override the per-result self-report when tagging. */
  surface?: string;
  _: string[];
}

function parseArgs(argv: string[]): Parsed {
  const p: Parsed = {
    pack: DEFAULT_PACK,
    harness: [],
    profile: [],
    model: "",
    effort: "",
    deterministic: false,
    generatorHarness: "",
    generatorModel: "",
    generatorEffort: "high",
    concurrency: 4,
    invokeTimeout: 900,
    invokeRetries: 1,
    out: "results/last-run.json",
    site: "",
    product: "",
    docs: "",
    offline: false,
    task: "",
    all: false,
    md: "",
    html: "",
    openapi: "",
    graphql: "",
    snapshot: "",
    from: "",
    baseUrl: "",
    limit: 3,
    l2Limit: undefined,
    l3Limit: undefined,
    l4Limit: undefined,
    results: [],
    runId: "",
    runDir: "results",
    observe: {},
    maxPages: 25,
    maxDepth: 2,
    approve: false,
    by: "",
    skipReview: false,
    invoke: false,
    dryRun: false,
    ns: "",
    attempts: 1,
    minPassRate: undefined,
    trace: "",
    _: [],
  };
  // Read the value for a value-taking flag, erroring if it's missing (i.e. the
  // flag was the last token) instead of silently passing undefined downstream.
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`flag ${flag} requires a value`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--pack") p.pack = value(++i, "--pack");
    else if (a === "--harness") p.harness.push(value(++i, "--harness"));
    else if (a === "--profile") p.profile.push(value(++i, "--profile"));
    else if (a === "--model") p.model = value(++i, "--model");
    else if (a === "--effort") {
      const v = value(++i, "--effort");
      if (!["low", "medium", "high"].includes(v)) {
        throw new Error(`--effort must be one of low|medium|high (got ${v})`);
      }
      p.effort = v;
    }
    else if (a === "--deterministic") p.deterministic = true;
    else if (a === "--generator-harness") {
      const v = value(++i, "--generator-harness");
      if (!["codex", "claude-code", "host-agent"].includes(v)) {
        throw new Error(`--generator-harness must be one of codex|claude-code|host-agent (got ${v})`);
      }
      p.generatorHarness = v;
    }
    else if (a === "--generator-model") p.generatorModel = value(++i, "--generator-model");
    else if (a === "--generator-effort") {
      const v = value(++i, "--generator-effort");
      if (!["low", "medium", "high"].includes(v)) {
        throw new Error(`--generator-effort must be one of low|medium|high (got ${v})`);
      }
      p.generatorEffort = v;
    }
    else if (a === "--invoke-timeout") {
      const n = Number(value(++i, "--invoke-timeout"));
      if (!Number.isInteger(n) || n < 0) throw new Error(`--invoke-timeout must be a non-negative integer (seconds; got ${n})`);
      p.invokeTimeout = n;
    }
    else if (a === "--invoke-retries") {
      const n = Number(value(++i, "--invoke-retries"));
      if (!Number.isInteger(n) || n < 0) throw new Error(`--invoke-retries must be a non-negative integer (got ${n})`);
      p.invokeRetries = n;
    }
    else if (a === "--concurrency") {
      const n = Number(value(++i, "--concurrency"));
      if (!Number.isInteger(n) || n < 1) throw new Error(`--concurrency must be a positive integer (got ${n})`);
      p.concurrency = n;
    }
    else if (a === "--out") p.out = value(++i, "--out");
    else if (a === "--site") p.site = value(++i, "--site");
    else if (a === "--product") p.product = value(++i, "--product");
    else if (a === "--docs") p.docs = value(++i, "--docs");
    else if (a === "--offline") p.offline = true;
    else if (a === "--task") p.task = value(++i, "--task");
    else if (a === "--all") p.all = true;
    else if (a === "--md") p.md = value(++i, "--md");
    else if (a === "--html") p.html = value(++i, "--html");
    else if (a === "--openapi") p.openapi = value(++i, "--openapi");
    else if (a === "--graphql") p.graphql = value(++i, "--graphql");
    else if (a === "--snapshot") p.snapshot = value(++i, "--snapshot");
    else if (a === "--from") p.from = value(++i, "--from");
    else if (a === "--base-url") p.baseUrl = value(++i, "--base-url");
    else if (a === "--limit") p.limit = Number(value(++i, "--limit"));
    else if (a === "--l2-limit") p.l2Limit = Number(value(++i, "--l2-limit"));
    else if (a === "--l3-limit") p.l3Limit = Number(value(++i, "--l3-limit"));
    else if (a === "--l4-limit") p.l4Limit = Number(value(++i, "--l4-limit"));
    else if (a === "--results") p.results.push(value(++i, "--results"));
    else if (a === "--run-id") p.runId = value(++i, "--run-id");
    else if (a === "--run-dir") p.runDir = value(++i, "--run-dir");
    else if (a === "--observe") {
      const v = value(++i, "--observe");
      const eq = v.indexOf("=");
      if (eq === -1) throw new Error("--observe expects <profile>=<transcript.jsonl>");
      p.observe[v.slice(0, eq)] = v.slice(eq + 1);
    }     else if (a === "--max-pages") p.maxPages = Number(value(++i, "--max-pages"));
    else if (a === "--max-depth") p.maxDepth = Number(value(++i, "--max-depth"));
    else if (a === "--approve") p.approve = true;
    else if (a === "--by") p.by = value(++i, "--by");
    else if (a === "--skip-review") p.skipReview = true;
    else if (a === "--invoke") p.invoke = true;
    else if (a === "--dry-run") p.dryRun = true;
    else if (a === "--ns") p.ns = value(++i, "--ns");
    else if (a === "--attempts") p.attempts = Number(value(++i, "--attempts"));
    else if (a === "--min-pass-rate") p.minPassRate = Number(value(++i, "--min-pass-rate"));
    else if (a === "--trace") p.trace = value(++i, "--trace");
    else if (a === "--surface") {
      const v = value(++i, "--surface");
      if (v !== "all" && !isSurfaceId(v)) throw new Error(`--surface must be one of api|cli|sdk|mcp|all (got ${v})`);
      p.surface = v;
    } else if (a!.startsWith("--")) throw new Error(`unknown flag ${a}`);
    else p._.push(a!);
  }
  return p;
}

async function cmdRun(args: Parsed): Promise<number> {
  loadDotenv();
  const pack = loadPack(args.pack);
  const harnesses = args.harness.length ? args.harness : ["mock", "mock-weak", "hermes"];
  console.log(
    `Running ${pack.tasks.length} tasks × ${harnesses.length} harnesses ` +
      `on ${pack.name} v${pack.version}\n`,
  );
  const report = await run(pack, harnesses, { progress: true });
  saveReport(report, args.out);
  console.log(`\nSaved results → ${args.out}\n`);
  console.log(render(report));

  // Static readiness audit next to the behavioral matrix — the "gap".
  if (pack.site_url) {
    const audit = await auditSite(pack.site_url, { mode: args.offline ? "fixture" : "live" });
    console.log("\n" + renderAudit(audit));
    console.log("\n" + renderGap(audit, report));
  }
  return 0;
}

async function cmdAudit(args: Parsed): Promise<number> {
  let site = args.site;
  if (!site) site = loadPack(args.pack).site_url;
  if (!site) throw new Error("no site to audit: pass --site <url> or use a pack with site_url");
  const audit = await auditSite(site, { mode: args.offline ? "fixture" : "live" });
  console.log(renderAudit(audit));
  return 0;
}

async function cmdDiscover(args: Parsed): Promise<number> {
  let site = args.site;
  if (!site) site = loadPack(args.pack).site_url;
  if (!site) throw new Error("no site to crawl: pass --site <url> or use a pack with site_url");
  const audit = await discoverSurfaces(site, {
    mode: args.offline ? "fixture" : "live",
    maxPages: args.maxPages,
    maxDepth: args.maxDepth,
  });
  console.log(renderDiscovery(audit));
  return 0;
}

/**
 * `ax-eval smells --openapi <url>` — content-quality (semantic-readiness) audit
 * of an OpenAPI spec. The orthogonal axis to discovery: once an agent finds the
 * spec, is its CONTENT good enough to USE? Heuristic re-implementation of the
 * Hermes 9-smell taxonomy (Lima et al., EASE 2026); offline fixture fallback.
 */
async function cmdSmells(args: Parsed): Promise<number> {
  if (!args.openapi)
    throw new Error("usage: ax-eval smells --openapi <url> [--html out.html] [--out json] [--offline]");
  const { text, source } = await fetchSpecText(args.openapi, { offline: args.offline });
  const audit = auditSpecQuality(text, source);
  if (args.html) {
    mkdirSync(dirname(args.html), { recursive: true });
    writeFileSync(args.html, renderSpecQualityHtml(audit));
    console.log(`Saved HTML → ${args.html}`);
  } else {
    console.log(renderSpecQuality(audit));
  }
  if (args.out && args.out !== "results/last-run.json") {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify(audit, null, 2));
    console.log(`Saved JSON → ${args.out}`);
  }
  return 0;
}

function cmdReport(args: Parsed): number {
  const path = args._[0];
  if (!path) throw new Error("usage: ax-eval report <results.json>");
  console.log(render(loadReport(path)));
  return 0;
}

function cmdList(): number {
  console.log("Registered harnesses:");
  for (const name of availableHarnesses()) console.log(`  ${name}`);
  return 0;
}

/**
 * Self-detect the host harness AX Eval is executing inside (Cursor, Claude Code,
 * Codex, CI, …) from cheap env signals, print provenance + a profile suggestion,
 * and optionally save the structured probe with --out. Never fails: an
 * unrecognized host falls back to host-default.
 */
function cmdProbe(args: Parsed): number {
  const probe = probeHarness();
  console.log(`Host harness:  ${probe.hostLabel} (${probe.host}, confidence ${probe.confidence})`);
  console.log(`Model:         ${probe.model ?? "host-default"}`);
  console.log(`Runtime:       node ${probe.node} · ${probe.platform}/${probe.arch}`);
  console.log(`Detected at:   ${probe.detectedAt}`);
  console.log(`Signals:       ${probe.signals.length ? probe.signals.join(", ") : "(none — no values captured)"}`);
  const sug = probe.suggestion;
  console.log(`\nSuggested profile(s): ${sug.profiles.join(", ")}`);
  console.log(`  ${sug.reason}`);
  // Follow the --out convention: persist the structured probe when a path is given.
  if (args.out && args.out !== "results/last-run.json") {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, JSON.stringify(probe, null, 2));
    console.log(`\nSaved probe → ${args.out}`);
  }
  return 0;
}

/** The surface statuses to report for a `--surface` selection. With no flag we
 *  stay api-only (byte-identical to the original check-env/init). `all` fans out
 *  over every surface the pack declares; a single id is validated against it. */
function selectedSurfaceStatuses(pack: TargetPack, surfaceArg: string | undefined): SurfaceAuthStatus[] {
  if (!surfaceArg) return [];
  const ids = resolveSurfaceSelection(pack, surfaceArg);
  // The api surface's auth is already covered by describeRequiredEnv's auth row.
  return ids.filter((id) => id !== "api").map((id) => surfaceAuthStatus(pack, id));
}

async function cmdCheckEnv(args: Parsed): Promise<number> {
  loadDotenv();
  const pack = loadPack(args.pack);
  // Target-agnostic: report exactly the env this pack declares it needs.
  const reqs = describeRequiredEnv(pack);
  console.log(`Required env for ${pack.name}:`);
  for (const r of reqs) {
    const flag = r.set ? "✓" : r.required ? "✗ MISSING" : "· (optional, unset)";
    const note = r.instructions ? `  — ${r.instructions}` : "";
    console.log(`  ${flag}  ${r.env} (${r.role})${note}`);
  }
  // Per-surface auth (only when --surface is given). Each surface's own
  // credential is checked here; a missing one is a BLOCK on that surface, not a
  // hard failure of the api gate — so a developer can run the surfaces they have
  // creds for and see exactly what to add for the rest.
  const statuses = selectedSurfaceStatuses(pack, args.surface);
  let blockedCount = 0;
  for (const s of statuses) {
    console.log(`\nSurface "${s.surface}" auth (${s.kind}):`);
    for (const r of s.requirements) {
      const flag = r.set ? "✓" : "✗ MISSING";
      console.log(`  ${flag}  ${r.env} (${r.role})`);
    }
    if (s.blocked) {
      blockedCount += 1;
      const why = s.blocked === "requires-oauth"
        ? "OAuth-only surface — register an OAuth app and store a refresh token"
        : "set the surface's credential in .env";
      console.log(`  → BLOCKED (${s.blocked}): ${why}.`);
      if (s.missing.length) console.log(`    add to .env: ${s.missing.join(", ")}`);
      if (s.instructions) console.log(`    ${s.instructions}`);
    }
  }
  const apiOk = hasRequiredEnv(pack);
  if (!apiOk) {
    console.error("\nSet the missing required vars in .env (see .env.example or 'ax-eval init').");
    return 1;
  }
  if (blockedCount > 0) {
    console.error(
      `\n${blockedCount} surface(s) blocked on missing credentials — the api surface is runnable; ` +
        `add the keys above (or 'ax-eval init --pack ${args.pack ?? "<pack>"} --surface all') to unblock the rest.`,
    );
    // Soft signal: api works, so this isn't a hard env failure. Exit 0 so a
    // partial run isn't gated; the blocked surfaces show up as blocked cells.
  }
  return 0;
}

/**
 * `ax-eval init --pack <yaml>` — print a copy-paste .env template for a pack.
 *
 * The pack itself declares which env vars it needs (`auth.env`, each
 * `sandbox_scope[].env`); we don't read or write secrets, we just emit a
 * commented stub the developer can append to .env and fill in. Output goes to
 * stdout so it composes with shell redirection (`>> .env`). When run on a
 * pack whose env is already complete, `set` lines are commented as already-set
 * markers so a re-run on a half-filled .env is non-destructive.
 */
async function cmdInit(args: Parsed): Promise<number> {
  loadDotenv();
  const pack = loadPack(args.pack);
  const reqs = describeRequiredEnv(pack);
  const header = [
    `# .env stub for ${pack.name}`,
    `# Generated by 'ax-eval init --pack ${args.pack ?? "<pack>"}'.`,
    `# Append to your .env (or set in your shell), then 'ax-eval check-env --pack <pack>'.`,
    `# This stub never reads or writes secrets — values are placeholders.`,
    "",
  ];
  const lines: string[] = [];
  const emit = (env: string, set: boolean, tag: string, note: string) => {
    lines.push(`# ${tag}${note}`);
    if (set) {
      lines.push(`# ${env} is already set in your environment; leaving stub commented.`);
      lines.push(`# ${env}=`);
    } else {
      lines.push(`${env}=`);
    }
    lines.push("");
  };
  for (const r of reqs) {
    emit(r.env, r.set, r.required ? "REQUIRED" : "optional", ` (${r.role})${r.instructions ? ` — ${r.instructions}` : ""}`);
  }
  // Per-surface auth stubs (only when --surface is given). OAuth-only surfaces
  // emit their client id/secret/refresh-token slots; token surfaces emit their
  // own token. Already-set vars are commented so a re-run is non-destructive.
  const statuses = selectedSurfaceStatuses(pack, args.surface);
  const seen = new Set(reqs.map((r) => r.env));
  for (const s of statuses) {
    lines.push(`# --- surface "${s.surface}" auth (${s.kind})${s.blocked ? ` — currently ${s.blocked}` : ""} ---`);
    if (s.instructions) lines.push(`# ${s.instructions}`);
    lines.push("");
    for (const r of s.requirements) {
      if (seen.has(r.env)) continue; // shared with the api credential (inherit)
      seen.add(r.env);
      emit(r.env, r.set, "REQUIRED", ` (${s.surface} ${r.role})`);
    }
  }
  process.stdout.write(header.concat(lines).join("\n"));
  // Tell the human (stderr so it doesn't pollute the redirected stdout).
  const missing = reqs.filter((r) => r.required && !r.set).length
    + statuses.flatMap((s) => s.requirements).filter((r) => !r.set && !reqs.some((q) => q.env === r.env)).length;
  if (missing > 0) {
    console.error(`\n${missing} required var(s) missing — fill in then run 'ax-eval check-env --pack ${args.pack ?? "<pack>"}'`);
  } else {
    console.error(`\nAll required vars already set; run 'ax-eval check-env --pack ${args.pack ?? "<pack>"}' to verify.`);
  }
  return 0;
}

/**
 * `ax-eval verify-generated --pack <yaml> --results <run.json>...` —
 *
 * Generated-pack verifier and CI gate. `verify` is kept as a compatibility
 * alias. Replays each recorded run against the
 * pack's expected_calls + round-trip oracles, computes pass-rate, and writes
 * a self-contained HTML report. Target-agnostic: every per-target detail
 * (auth, base URL, env names, sandbox scope) comes from the pack YAML.
 */
async function cmdVerify(args: Parsed): Promise<number> {
  return cmdVerifyGenerated(args);
}

async function cmdIngest(args: Parsed): Promise<number> {
  // GraphQL ingest: persist rich introspection so `generate --from` can synthesize
  // read-back oracles, while keeping the summary focused on types + mutations.
  if (args.graphql) {
    const g = await ingestGraphqlDetailed(args.graphql, { offline: args.offline });
    console.log(`Ingested GraphQL schema (${g.source}) [${g.format}]`);
    console.log(`  query type:    ${g.queryType ?? "(none)"}`);
    console.log(`  mutation type: ${g.mutationType ?? "(none)"}`);
    console.log(`  object types:  ${g.objectTypes.length}`);
    console.log(`  mutations:     ${g.mutations.length} (create-style: ${g.createMutations.length})`);
    console.log(`  rich fields:   queries=${g.queryTypeFields.length} types=${g.typeDetails.length}`);
    for (const name of g.createMutations.slice(0, 12)) console.log(`    + ${name}  (create-style)`);
    const out = args.out && args.out !== "results/last-run.json" ? args.out : "results/ingest-graphql.json";
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(g, null, 2));
    console.log(`\nSaved → ${out}`);
    return 0;
  }
  if (!args.openapi) throw new Error("usage: ax-eval ingest (--openapi <url> | --graphql <endpoint|file>) [--out json]");
  const spec = await ingestFromUrl(args.openapi, { offline: args.offline });
  console.log(`Ingested ${spec.title} (${spec.source})`);
  console.log(`  base_url: ${spec.baseUrl || "(none)"}`);
  console.log(`  envelope: ${spec.requestEnvelope ?? "(none)"}`);
  console.log(`  CRUD resources: ${spec.resources.length}`);
  for (const r of spec.resources.slice(0, 12)) {
    const dep = r.dependsOn.length ? ` depends:[${r.dependsOn.join(",")}]` : "";
    console.log(`    - ${r.name}: POST ${r.createPath} / GET ${r.readPath} id=${r.identityField}${dep}`);
  }
  const out = args.out && args.out !== "results/last-run.json" ? args.out : "results/ingest.json";
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(spec, null, 2));
  console.log(`\nSaved → ${out}`);
  return 0;
}

/** UPPER/lower slug of a product name, for pack-name + output-path derivation. */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function isFullPackPath(path: string | undefined): boolean {
  return typeof path === "string" && /(^|\/)[^/]*generated\.full\.pack\.ya?ml$/i.test(path);
}

function resolvedGeneratePolicy(args: Parsed, allowFullPreset = true): Pick<GenerateOptions, "limit" | "l2Limit" | "l3Limit" | "l4Limit" | "targetTaskCount"> {
  const wantsFull = allowFullPreset && isFullPackPath(args.out && args.out !== "results/last-run.json" ? args.out : undefined);
  const explicitTierFlags = args.limit !== 3 || args.l2Limit !== undefined || args.l3Limit !== undefined || args.l4Limit !== undefined;
  return {
    limit: args.limit,
    l2Limit: args.l2Limit ?? (wantsFull ? 2 : undefined),
    l3Limit: args.l3Limit ?? (wantsFull ? 3 : undefined),
    l4Limit: args.l4Limit ?? (wantsFull ? 3 : undefined),
    targetTaskCount: wantsFull && !explicitTierFlags ? 12 : undefined,
  };
}

/**
 * Curated, Asana-specific generation extras. Asana's OpenAPI declares no
 * `securitySchemes` and several resources read back under `title` not `name`,
 * so these can't be derived from the spec — they're hand-curated for the Asana
 * target. Layered on ONLY when the product resolves to Asana; every other
 * product generates generically from the ingested spec.
 */
const ASANA_PRESET: Partial<GenerateOptions> = {
  packName: "asana-generated",
  siteUrl: "https://developers.asana.com",
  openapiUrl: "https://raw.githubusercontent.com/Asana/openapi/master/defs/asana_oas.yaml",
  docsUrls: ["https://developers.asana.com/docs"],
  authMethod: "pat",
  authScheme: "Bearer personal access token",
  authType: "bearer",
  authEnv: "ASANA_PAT",
  authVerifyEnv: "ASANA_VERIFY_PAT",
  prefer: [
    "tasks", "projects", "tags", "goals", "portfolios",
    "sections", "project_briefs", "project_statuses", "stories",
  ],
  identityOverrides: {
    project_briefs: "title",
    project_statuses: "title",
  },
  surfaces: {
    sdk: {
      package: "asana",
      language: "node",
      reference_url: "https://developers.asana.com/docs/overview",
      auth: { kind: "inherit", token_env_aliases: [] },
    },
    mcp: {
      server: "https://mcp.asana.com/v2/mcp",
      transport: "http",
      docs_url: "https://developers.asana.com/docs/using-asanas-mcp-server",
      auth: {
        kind: "oauth_app",
        token_env_aliases: [],
        client_id_env: "ASANA_MCP_CLIENT_ID",
        client_secret_env: "ASANA_MCP_CLIENT_SECRET",
        refresh_token_env: "ASANA_MCP_REFRESH_TOKEN",
        token_url: "https://app.asana.com/-/oauth_token",
        instructions:
          "Register an Asana OAuth app, complete the OAuth flow once, and store the refresh token. ax-eval exchanges it for a short-lived MCP bearer token at invoke time.",
      },
    },
  },
  l4: [
    {
      idSuffix: "task-complete",
      title: "L4: create then complete a task (state mutation)",
      resource: "tasks",
      prompt:
        `Create a task named "{val}", then mark it complete. Report the task id; ` +
        `it must read back as completed.`,
      assertField: "completed",
      expected: true,
    },
    {
      idSuffix: "task-reschedule",
      title: "L4: create then reschedule a task (due-date mutation)",
      resource: "tasks",
      prompt:
        `Create a task named "{val}", then set its due date to 2026-06-30. ` +
        `Report the task id.`,
      assertField: "due_on",
      expected: "2026-06-30",
    },
    {
      idSuffix: "project-archive",
      title: "L4: create then archive a project (state mutation)",
      resource: "projects",
      prompt:
        `Create a project named "{val}" in the sandbox workspace, then archive it. ` +
        `Report the project id; it must read back as archived.`,
      assertField: "archived",
      expected: true,
    },
  ],
};

const exaUrlOracleTrace = (description: string): NonNullable<GenerateOptions["operationTasks"]>[number]["trace"] => [
  { type: "required_call", method: "POST", path: "/search", description },
];

const EXA_PRESET: Partial<GenerateOptions> = {
  packName: "exa",
  siteUrl: "https://exa.ai",
  openapiUrl: "https://docs.exa.ai/exa-spec.json",
  docsUrls: [
    "https://docs.exa.ai/reference/search-api-guide",
    "https://docs.exa.ai/reference/search-api-guide-for-coding-agents",
    "https://docs.exa.ai/reference/openapi-spec",
  ],
  authMethod: "api-key",
  authScheme: "API key in the x-api-key header",
  authType: "api-key",
  authEnv: "EXA_API_KEY",
  authHeader: "x-api-key",
  headers: {},
  sandboxScope: [],
  limit: 0,
  l2Limit: 0,
  l4Limit: 0,
  discoveryCanonicalEndpoint: "POST /search",
  discoveryGoal:
    "You are about to operate Exa programmatically. First work out, from scratch, how Exa's public Search API works — its base URL, how to authenticate with an API key in the `x-api-key` header, the `/search` request shape, and how content options such as `contents.highlights` are nested — then you will perform several tasks. You are NOT given any endpoint, base URL, or documentation link; find them yourself.",
  deprecatedMarkers: ["useAutoprompt", "includeUrls", "excludeUrls", "livecrawl"],
  surfaces: {
    sdk: {
      package: "exa-js",
      language: "node",
      reference_url: "https://docs.exa.ai/reference/typescript-sdk-specification",
      auth: { kind: "inherit", token_env_aliases: [] },
    },
    mcp: {
      server: "exa-mcp-server",
      transport: "stdio",
      docs_url: "https://docs.exa.ai/reference/exa-mcp",
      auth: {
        kind: "token",
        token_env: "EXA_API_KEY",
        token_env_aliases: [],
        instructions: "Configure the Exa MCP server with EXA_API_KEY. Verification still reads back through the Exa REST API.",
      },
    },
  },
  operationTasks: [
    {
      id: "exa-l1-python-taskgroup",
      title: "L1: find official Python docs",
      difficulty: "L1",
      prompt:
        "Use Exa Search to find the official Python documentation page for the `asyncio.TaskGroup` API. Request highlights via `contents.highlights`, and report the result URL `https://docs.python.org/3/library/asyncio-task.html` as the id if it is returned.",
      expectedUrl: "https://docs.python.org/3/library/asyncio-task.html",
      expectedAny: ["https://docs.python.org/3/library/asyncio-task.html#asyncio.TaskGroup"],
      matchMode: "url",
      trace: exaUrlOracleTrace("search must use Exa's Search endpoint"),
    },
    {
      id: "exa-l1-mdn-fetch",
      title: "L1: find MDN Fetch API docs",
      difficulty: "L1",
      prompt:
        "Use Exa Search to find MDN's Fetch API reference. Request highlights via `contents.highlights`, and report the result URL `https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API` as the id if it is returned.",
      expectedUrl: "https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API",
      matchMode: "url",
      trace: exaUrlOracleTrace("search must use Exa's Search endpoint"),
    },
    {
      id: "exa-l1-rfc-9110",
      title: "L1: find an RFC",
      difficulty: "L1",
      prompt:
        "Use Exa Search to find the HTML page for IETF RFC 9110, HTTP Semantics. Request highlights via `contents.highlights`, and report the result URL `https://www.rfc-editor.org/rfc/rfc9110.html` as the id if it is returned.",
      expectedUrl: "https://www.rfc-editor.org/rfc/rfc9110.html",
      expectedAny: ["https://www.rfc-editor.org/info/rfc9110/", "https://datatracker.ietf.org/doc/html/rfc9110"],
      matchMode: "url",
      trace: exaUrlOracleTrace("search must use Exa's Search endpoint"),
    },
    {
      id: "exa-l2-domain-filter-mdn",
      title: "L2: constrain search to one domain",
      difficulty: "L2",
      prompt:
        "Use Exa Search to find MDN's AbortController reference. Use `includeDomains` to restrict results to developer.mozilla.org and request `contents.highlights`. Report the result URL `https://developer.mozilla.org/en-US/docs/Web/API/AbortController` as the id if it is returned.",
      expectedUrl: "https://developer.mozilla.org/en-US/docs/Web/API/AbortController",
      matchMode: "url",
      trace: exaUrlOracleTrace("search must use Exa's Search endpoint"),
    },
    {
      id: "exa-l2-domain-filter-python",
      title: "L2: constrain search to Python docs",
      difficulty: "L2",
      prompt:
        "Use Exa Search to find Python's official `pathlib` documentation. Use `includeDomains` to restrict results to docs.python.org and request `contents.highlights`. Report the result URL `https://docs.python.org/3/library/pathlib.html` as the id if it is returned.",
      expectedUrl: "https://docs.python.org/3/library/pathlib.html",
      matchMode: "url",
      trace: exaUrlOracleTrace("search must use Exa's Search endpoint"),
    },
    {
      id: "exa-l2-exclude-domain",
      title: "L2: exclude a misleading domain",
      difficulty: "L2",
      prompt:
        "Use Exa Search to find the W3C WCAG 2.2 recommendation. Exclude misleading mirrors or explainers if they crowd out the official W3C result, request `contents.highlights`, and report the result URL `https://www.w3.org/TR/WCAG22/` as the id if it is returned.",
      expectedUrl: "https://www.w3.org/TR/WCAG22/",
      expectedAny: ["https://www.w3.org/TR/2023/REC-WCAG22-20231005/", "https://www.w3.org/TR/WCAG22/Overview.html"],
      matchMode: "url",
      trace: exaUrlOracleTrace("search must use Exa's Search endpoint"),
    },
    {
      id: "exa-l3-contents-readback-rfc",
      title: "L3: search then retrieve clean content",
      difficulty: "L3",
      prompt:
        "Use Exa Search to locate the IETF RFC 9110 HTTP Semantics page on rfc-editor.org, then use Exa Contents to retrieve clean content for the URL. Report the result URL `https://www.rfc-editor.org/rfc/rfc9110.html` as the id if it is returned.",
      expectedUrl: "https://www.rfc-editor.org/rfc/rfc9110.html",
      expectedAny: ["https://www.rfc-editor.org/info/rfc9110/", "https://datatracker.ietf.org/doc/html/rfc9110"],
      matchMode: "url",
      trace: [
        { type: "required_call", method: "POST", path: "/search", description: "first locate the page with Exa Search" },
        { type: "required_call", method: "POST", path: "/contents", description: "retrieve content for the located URL" },
      ],
    },
    {
      id: "exa-l3-summary-content",
      title: "L3: request per-result summaries",
      difficulty: "L3",
      prompt:
        "Use Exa Search to find the React documentation page for `useEffect`. Request `contents.summary` with a query focused on cleanup functions, and report the result URL `https://react.dev/reference/react/useEffect` as the id if it is returned.",
      expectedUrl: "https://react.dev/reference/react/useEffect",
      matchMode: "url",
      trace: exaUrlOracleTrace("search must request summary content"),
    },
    {
      id: "exa-l3-text-content-cap",
      title: "L3: retrieve capped text content",
      difficulty: "L3",
      prompt:
        "Use Exa Search to find the Node.js documentation page for `fsPromises`. Then use Exa Contents to retrieve text for the page with a character cap so the response stays small. Report the result URL `https://nodejs.org/api/fs.html` as the id if it is returned.",
      expectedUrl: "https://nodejs.org/api/fs.html",
      expectedAny: ["https://nodejs.org/docs/latest-v26.x/api/fs.html", "https://nodejs.org/dist/latest/docs/api/fs.html", "https://nodejs.org/api/fs.html#promises-api"],
      matchMode: "url",
      trace: [
        { type: "required_call", method: "POST", path: "/search", description: "first locate the page with Exa Search" },
        { type: "required_call", method: "POST", path: "/contents", description: "retrieve capped text content" },
      ],
    },
    {
      id: "exa-l4-structured-output-official-source",
      title: "L4: synthesize structured output from official sources",
      difficulty: "L4",
      prompt:
        "Use Exa Search with `outputSchema` to synthesize the official current Kubernetes documentation page for probes. Prefer official sources with a `systemPrompt`, request highlights, and report the source URL `https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/` as the id if it is returned in results or grounding.",
      expectedUrl: "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/",
      expectedAny: ["https://kubernetes.io/docs/concepts/workloads/pods/probes/"],
      matchMode: "url",
      trace: exaUrlOracleTrace("search must use structured output"),
    },
    {
      id: "exa-l4-deep-comparison",
      title: "L4: deep search comparison",
      difficulty: "L4",
      prompt:
        "Use a deep Exa Search variant to compare official PostgreSQL documentation pages about transaction isolation levels. Prefer postgresql.org sources, request highlights, and report the result URL `https://www.postgresql.org/docs/current/transaction-iso.html` as the id if it is returned.",
      expectedUrl: "https://www.postgresql.org/docs/current/transaction-iso.html",
      expectedAny: ["https://www.postgresql.org/docs/18/transaction-iso.html"],
      matchMode: "url",
      trace: exaUrlOracleTrace("search must use a deep search variant"),
    },
    {
      id: "exa-l4-multi-angle-query",
      title: "L4: multi-angle search",
      difficulty: "L4",
      prompt:
        "Use Exa Search with a deep-capable search type and `additionalQueries` to find the official Cloudflare documentation page for cache rules. Use one query angle for \"cache rules\" and another for \"set cache eligibility\", and report the result URL `https://developers.cloudflare.com/cache/how-to/cache-rules/` as the id if it is returned.",
      expectedUrl: "https://developers.cloudflare.com/cache/how-to/cache-rules/",
      matchMode: "url",
      trace: exaUrlOracleTrace("search must use additional query angles"),
    },
  ],
};

const LINEAR_GRAPHQL_PRESET: Partial<GenerateGraphqlPackOptions> = {
  packName: "linear-generated",
  baseUrl: "https://api.linear.app/graphql",
  siteUrl: "https://linear.app/developers",
  docsUrls: ["https://linear.app/developers/graphql"],
  authMethod: "api-key",
  authType: "api-key",
  authEnv: "LINEAR_API_KEY",
  authHeader: "Authorization",
  surfaces: {
    sdk: {
      package: "@linear/sdk",
      language: "node",
      reference_url: "https://linear.app/developers/sdk",
      auth: { kind: "inherit", token_env_aliases: [] },
    },
    mcp: {
      server: "https://mcp.linear.app/mcp",
      transport: "http",
      docs_url: "https://linear.app/docs/mcp",
      auth: {
        kind: "token",
        token_env: "LINEAR_API_KEY",
        token_env_aliases: [],
        instructions:
          "Linear's MCP server supports direct API keys in the Authorization header. The same LINEAR_API_KEY used for the GraphQL API works for MCP.",
      },
    },
  },
};

function generatorProvenance(args: Parsed, docsUrls: string[] | undefined, specSource: unknown): NonNullable<TargetPack["generator"]> {
  const detected = probeHarness().host;
  const harness = args.generatorHarness || (detected === "codex" || detected === "claude-code" ? detected : "codex");
  const sourceDocs = docsUrls && docsUrls.length
    ? docsUrls
    : typeof specSource === "string" && /^https?:\/\//.test(specSource)
      ? [specSource]
      : [];
  return {
    harness,
    model: args.generatorModel || "host-default",
    effort: (args.generatorEffort || "high") as "low" | "medium" | "high",
    prompt_version: "ax-eval-generator-v1",
    source_docs: sourceDocs,
  };
}

function taskSummary(pack: TargetPack): unknown {
  return pack.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    difficulty: t.difficulty,
    prompt: t.prompt,
    allowed_surfaces: t.allowed_surfaces,
    oracles: t.oracles,
    trace: t.trace ?? [],
  }));
}

function buildGeneratorPrompt(product: string, spec: unknown, seed: TargetPack): string {
  const specSummary = JSON.stringify({
    source: (spec as { source?: unknown }).source,
    title: (spec as { title?: unknown }).title,
    baseUrl: (spec as { baseUrl?: unknown }).baseUrl,
    auth: (spec as { auth?: unknown }).auth,
    constantHeaders: (spec as { constantHeaders?: unknown }).constantHeaders,
    resources: (spec as { resources?: unknown }).resources,
  }, null, 2);
  const seedJson = JSON.stringify({
    ...seed,
    tasks: taskSummary(seed),
  }, null, 2);
  return [
    `You are the ax-eval pack generator for ${product}.`,
    "",
    "Create one product-quality TargetPack JSON object. Return ONLY valid JSON: no markdown, no commentary.",
    "",
    "Hard requirements:",
    "- Preserve the target product, auth env names, base URL, surfaces, docs URLs, and discovery shape unless the seed is clearly wrong.",
    "- Produce exactly 12 tasks unless the seed has fewer than 12 viable operation tasks.",
    "- Include L1, L2, L3, and L4 tasks, with at least one L4 task.",
    "- Prompts must be goal-level: do not hand the agent a curl command or exact endpoint implementation steps.",
    "- Every task must have at least one programmatic oracle.",
    "- For stateless search/read APIs, use roundtrip POST read-back oracles where appropriate, with readMethod/readPathTemplate/readBodyTemplate.",
    "- For URL assertions, prefer matchMode:\"url\" and include expectedAny aliases for canonical-equivalent, versioned, anchor, or redirect URLs that should count as the same correct source.",
    "- Do not include secrets or secret values. Use only env-var names.",
    "- Keep generated_by/generator fields if present; the CLI will normalize provenance after validation.",
    "",
    "Ingested spec summary:",
    specSummary,
    "",
    "Seed pack JSON to improve or preserve:",
    seedJson,
  ].join("\n");
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return extractJsonObject(fenced[1]);
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  throw new Error("generator harness did not return a JSON object");
}

function normalizeHarnessText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.result === "string") return parsed.result;
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.output === "string") return parsed.output;
  } catch {
    // Plain JSON pack or plain text; extractJsonObject handles both.
  }
  return trimmed;
}

function runGeneratorHarness(prompt: string, args: Parsed, provenance: NonNullable<TargetPack["generator"]>): string {
  const fixture = process.env.AX_EVAL_GENERATOR_FIXTURE;
  if (fixture) return readFileSync(fixture, "utf8");

  const harness = provenance.harness;
  if (harness === "codex") {
    const dir = mkdtempSync(resolve(tmpdir(), "ax-generator-"));
    const outPath = resolve(dir, "pack.json");
    const modelArgs = args.generatorModel ? ["-m", args.generatorModel] : [];
    const effortArgs = provenance.effort ? ["-c", `model_reasoning_effort=${provenance.effort}`] : [];
    const res = spawnSync("codex", [
      "exec",
      "--sandbox", "workspace-write",
      "-c", "sandbox_workspace_write.network_access=true",
      "--json",
      ...modelArgs,
      ...effortArgs,
      "--output-last-message", outPath,
      prompt,
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    if (res.error || (res.status ?? 1) !== 0) {
      throw new Error(`generator harness codex failed: ${res.error?.message || res.stderr || `exit ${res.status}`}`);
    }
    return existsSync(outPath) ? readFileSync(outPath, "utf8") : res.stdout;
  }

  if (harness === "claude-code") {
    const modelArgs = args.generatorModel ? ["--model", args.generatorModel] : [];
    const res = spawnSync("claude", ["-p", prompt, "--output-format", "json", ...modelArgs], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    if (res.error || (res.status ?? 1) !== 0) {
      throw new Error(`generator harness claude-code failed: ${res.error?.message || res.stderr || `exit ${res.status}`}`);
    }
    return normalizeHarnessText(res.stdout);
  }

  throw new Error(`generator harness ${harness} cannot be invoked headlessly; pass --generator-harness codex|claude-code`);
}

function authorPackWithLlm(product: string, spec: unknown, seed: TargetPack, args: Parsed, docsUrls: string[] | undefined): TargetPack {
  const provenance = generatorProvenance(args, docsUrls, (spec as { source?: unknown }).source);
  const prompt = buildGeneratorPrompt(product, spec, { ...seed, generated_by: "llm-assisted", generator: provenance });
  const raw = runGeneratorHarness(prompt, args, provenance);
  const parsed = JSON.parse(extractJsonObject(normalizeHarnessText(raw)));
  const pack = TargetPackSchema.parse({
    ...parsed,
    generated_by: "llm-assisted",
    generator: provenance,
  });
  return pack;
}

async function cmdGenerate(args: Parsed): Promise<number> {
  loadDotenv();
  const from = args.from || "results/ingest.json";
  const spec = JSON.parse(readFileSync(from, "utf8"));

  // Product: explicit flag wins, else derive from the spec title (strip a
  // trailing " API"), else fall back to a neutral label.
  const product =
    args.product.trim() ||
    String(spec.title ?? "").replace(/\s+API$/i, "").trim() ||
    "Target";
  const docsUrls = args.docs
    ? args.docs.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const generatePolicy = resolvedGeneratePolicy(args);

  if (looksLikeGraphqlIngest(spec)) {
    const isLinear = product.toLowerCase() === "linear";
    const preset = isLinear ? LINEAR_GRAPHQL_PRESET : undefined;
    const graphqlOpts: GenerateGraphqlPackOptions = {
      ...(preset ?? {}),
      ...generatePolicy,
      runId: args.runId || undefined,
      packName: `${slugify(product)}-generated`,
      product,
      baseUrl: args.baseUrl || preset?.baseUrl || undefined,
      siteUrl: args.site || preset?.siteUrl || "",
      ...(docsUrls ? { docsUrls } : preset?.docsUrls ? { docsUrls: preset.docsUrls } : {}),
    };
    const generated = generateGraphqlPack(spec, {
      ...graphqlOpts,
    });
    const pack: TargetPack = args.deterministic
      ? generated
      : authorPackWithLlm(product, spec, generated, args, docsUrls);
    const yaml = packToYaml(pack);
    const out = args.out && args.out !== "results/last-run.json"
      ? args.out
      : `results/${slugify(product)}.generated.pack.yaml`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, yaml);
    console.log(`Generated ${pack.tasks.length} GraphQL tasks for ${product} (generated_by: ${pack.generated_by}):`);
    for (const t of pack.tasks) console.log(`  [${t.difficulty}] ${t.id} — surfaces:[${t.allowed_surfaces.join(",")}]`);
    console.log(`\nFrozen pack → ${out}`);
    console.log(
      `\nNext: review derived GraphQL oracles before any run —\n  ax-eval review --pack ${out}\n` +
      `Fill any sandbox id(s) it lists, then approve with --approve --by <name>.`,
    );
    return 0;
  }

  const isAsana = product.toLowerCase() === "asana";
  const isExa = product.toLowerCase() === "exa";

  // Generic options derived entirely from the spec + flags. Auth, sandbox_scope
  // and headers are derived inside generatePack from the ingested securityScheme
  // and resource graph — no per-product hardcoding.
  const presetAllowsFull = !Boolean(EXA_PRESET.operationTasks && isExa);
  const presetAwarePolicy = resolvedGeneratePolicy(args, presetAllowsFull);
  const baseOpts: GenerateOptions = {
    ...presetAwarePolicy,
    runId: args.runId || undefined,
    packName: `${slugify(product)}-generated`,
    product,
    siteUrl: args.site || spec.source || undefined,
    // The spec we ingested from is the natural content-quality audit target.
    ...(typeof spec.source === "string" && /^https?:\/\//.test(spec.source)
      ? { openapiUrl: spec.source }
      : {}),
    ...(docsUrls ? { docsUrls } : {}),
  };

  // Asana keeps its hand-curated extras (see ASANA_PRESET). Explicit --site/--docs
  // flags still win over the preset's defaults.
  const preset = isAsana ? ASANA_PRESET : isExa ? EXA_PRESET : undefined;
  const opts: GenerateOptions = preset
    ? {
        ...preset,
        ...baseOpts,
        ...(preset.packName ? { packName: preset.packName } : {}),
        ...(args.limit === 3 && preset.limit !== undefined ? { limit: preset.limit } : {}),
        ...(args.l2Limit === undefined && preset.l2Limit !== undefined ? { l2Limit: preset.l2Limit } : {}),
        ...(args.l3Limit === undefined && preset.l3Limit !== undefined ? { l3Limit: preset.l3Limit } : {}),
        ...(args.l4Limit === undefined && preset.l4Limit !== undefined ? { l4Limit: preset.l4Limit } : {}),
        ...(baseOpts.targetTaskCount === undefined && preset.targetTaskCount !== undefined ? { targetTaskCount: preset.targetTaskCount } : {}),
        ...(args.site ? { siteUrl: args.site } : { siteUrl: preset.siteUrl }),
        ...(docsUrls ? { docsUrls } : { docsUrls: preset.docsUrls }),
      }
    : baseOpts;

  const provenanceDocs = opts.docsUrls ?? docsUrls;
  const seed = generatePack(
    spec,
    args.deterministic ? opts : { ...opts, generatedBy: "llm-assisted", generator: generatorProvenance(args, provenanceDocs, spec.source) },
  );
  const pack = args.deterministic ? seed : authorPackWithLlm(product, spec, seed, args, provenanceDocs);
  const yaml = packToYaml(pack);
  // Default output: committed example packs live under targets/examples/, but
  // locally generated packs still default to targets/<product>/ so a user can
  // iterate on their own target without overwriting the shipped examples.
  const defaultOut = isAsana
    ? "targets/asana/generated.pack.yaml"
    : `results/${slugify(product)}.generated.pack.yaml`;
  const out = args.out && args.out !== "results/last-run.json" ? args.out : defaultOut;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, yaml);
  console.log(`Generated ${pack.tasks.length} tasks for ${product} (generated_by: ${pack.generated_by}):`);
  if (pack.generator) {
    console.log(
      `  generator: ${pack.generator.harness}/${pack.generator.model} effort=${pack.generator.effort} ` +
        `prompt=${pack.generator.prompt_version}`,
    );
  }
  for (const t of pack.tasks) console.log(`  [${t.difficulty}] ${t.id} — surfaces:[${t.allowed_surfaces.join(",")}]`);
  console.log(`\nFrozen pack → ${out}`);
  if (!isAsana) {
    console.log(
      `\nNext: review it before any run —\n  ax-eval review --pack ${out}\n` +
      `Fill the sandbox id(s) it lists, then approve with --approve --by <name>.`,
    );
  }
  return 0;
}

/**
 * Emit a ready-to-run executor prompt per profile (resolving a fresh namespace
 * each). Each prompt is a single two-phase run: Phase 0 cold-start discovery
 * followed by the L1-L4 tasks built on what it discovered — so discovery is
 * NOT a separate agent, it's step 0 of low and high. ns and
 * the discovery/results/trace contract are baked in by the builder, so execution
 * is reproducible. Artifacts land under --run-dir (default results/).
 */
/**
 * The review gate: print the generated set for a human to read, and (with
 * --approve) record a content-addressed approval next to the pack. Nothing runs
 * un-reviewed — exec-plan checks this approval. Re-approval is required whenever
 * the pack's reviewable content changes (the hash won't match).
 */
function cmdReview(args: Parsed): number {
  const pack = loadPack(args.pack);
  console.log(reviewSummary(pack));
  if (!args.approve) {
    const status = checkApproval(pack, args.pack);
    console.log(
      `\n${status.ok ? "✓ Already approved (content matches)." : "Not approved."} ` +
        `To approve after reading: ax-eval review --pack ${args.pack} --approve --by <name>`,
    );
    return 0;
  }
  const by = args.by || "unspecified";
  const approval = writeApproval(args.pack, pack, by);
  console.log(`\n✓ Approved ${pack.tasks.length} tasks by "${by}" (hash ${approval.content_hash}).`);
  return 0;
}

/** The concrete surface id to *override* a result's self-report when tagging.
 *  `all` (and unset) return undefined so each result keeps its own self-reported
 *  surface — the override only applies when the caller named a single surface. */
function concreteSurface(args: Parsed): SurfaceId | undefined {
  return args.surface && args.surface !== "all" && isSurfaceId(args.surface) ? args.surface : undefined;
}

async function cmdExecPlan(args: Parsed): Promise<number> {
  // Load .env so the per-surface auth gate sees the credentials the developer
  // has set (otherwise every surface would read as blocked).
  loadDotenv();
  const pack = loadPack(args.pack);
  // Review gate: refuse to emit runnable prompts for an un-reviewed/changed set.
  if (!args.skipReview) {
    const status = checkApproval(pack, args.pack);
    if (!status.ok) {
      console.error(
        `Refusing to exec-plan: ${status.reason}.\n` +
          `Review it first:  ax-eval review --pack ${args.pack}\n` +
          `Then approve:     ax-eval review --pack ${args.pack} --approve --by <name>\n` +
          `(Or bypass for a trusted/committed pack with --skip-review.)`,
      );
      return 1;
    }
  }
  const invokeHarnesses: InvokeHarnessId[] = [];
  if (args.invoke) {
    const rawHarnesses = args.harness.length ? args.harness : ["claude-code"];
    for (const h of rawHarnesses) {
      if (!isInvokeHarnessId(h)) {
        throw new Error(`--invoke --harness must be one of ${INVOKE_HARNESS_LIST} (got ${h})`);
      }
      invokeHarnesses.push(h);
    }
  }
  const profileNames = args.invoke
    ? (args.profile.length ? args.profile : ["high"])
    : (args.harness.length ? args.harness : ["low", "high"]);
  if (!Number.isInteger(args.attempts) || args.attempts < 1) {
    throw new Error("--attempts must be a positive integer");
  }
  // Resolve the surface selection. `all` fans out over every surface the pack
  // declares; a single id is validated against what the pack exposes. The
  // default (no flag) is api-only, byte-identical to the original behavior.
  const surfaceIds = resolveSurfaceSelection(pack, args.surface ?? "api");
  // Only tag artifacts/ns with the surface when it actually disambiguates —
  // i.e. anything other than the lone default api surface — so single-surface
  // api runs keep their legacy `run-<profile>.json` paths and namespaces.
  const tagSurface = !(surfaceIds.length === 1 && surfaceIds[0] === "api");
  const dir = args.runDir;
  mkdirSync(dir, { recursive: true });
  const resultPaths: string[] = [];
  const resultPathsByHarness = new Map<string, string[]>();
  const resetHints: string[] = [];
  const blockedNotes: string[] = [];
  // Invoked harness runs are PLANNED in the loops below (prompts written, jobs
  // collected) then EXECUTED through a concurrency pool after — so cells run in
  // parallel (default) instead of one blocking spawnSync at a time.
  interface InvokeJob {
    harness: InvokeHarnessId;
    profileName: string;
    surfaceId: SurfaceId;
    attempt: number;
    ns: string;
    paths: ReturnType<typeof defaultInvokePaths>;
    runOpts: InvokeRunOptions;
    label: string;
  }
  const invokeJobs: InvokeJob[] = [];
  for (const surfaceId of surfaceIds) {
    // Auth gate per surface: if the agent can't authenticate this surface
    // headlessly (OAuth-only, or a token the developer hasn't set), don't emit
    // runnable prompts for it. Instead write a `blocked` cube cell (so the
    // competitive report shows an honest blocked state, never a fake 0%) and
    // tell the developer exactly which env vars to add.
    const auth = surfaceAuthStatus(pack, surfaceId);
    if (auth.blocked) {
      const harnesses = args.invoke ? invokeHarnesses : [probeHarness().host];
      for (const harness of harnesses) {
        const record = buildBlockedResult(pack, surfaceId, harness, auth.blocked);
        const suffix = args.invoke ? `-${harness}` : "";
        const recordPath = `${dir}/run-${surfaceId}${suffix}-blocked.normalized.json`;
        writeFileSync(recordPath, JSON.stringify(record, null, 2));
        console.log(
          args.invoke
            ? `surface=${surfaceId} harness=${harness} → BLOCKED (${auth.blocked}) → ${recordPath}`
            : `surface=${surfaceId} → BLOCKED (${auth.blocked}) → ${recordPath}`,
        );
      }
      const add = auth.missing.length ? ` Add to .env: ${auth.missing.join(", ")}.` : "";
      const why = auth.blocked === "requires-oauth"
        ? "OAuth-only surface — register an OAuth app and store a refresh token"
        : "missing this surface's credential";
      blockedNotes.push(
        `  ${surfaceId}: ${auth.blocked}.${add}` +
          (auth.instructions ? `\n    ${auth.instructions}` : ""),
      );
      continue;
    }
    const surface = getSurface(surfaceId);
    const sfx = tagSurface ? `-${surfaceId}` : "";
    // Plan header per surface: what configs are queued for it (execution is
    // pooled/parallel afterward, so this lists rather than sequences them).
    if (args.invoke) {
      const seq = `${profileNames.join(", ")}${invokeHarnesses.length ? ` × ${invokeHarnesses.join(", ")}` : ""}`;
      console.log(`  queued ${surfaceId.toUpperCase()}: ${seq}${args.attempts > 1 ? ` × ${args.attempts} attempts` : ""}`);
    }
    for (const name of profileNames) {
      const profile = getProfile(name);
      for (let attempt = 1; attempt <= args.attempts; attempt++) {
        if (args.invoke) {
          for (const harness of invokeHarnesses) {
            const detection = detectInvokeHarness(harness);
            if (!detection.ok) {
              const record = buildBlockedResult(pack, surfaceId, harness, "missing-harness");
              const recordPath = `${dir}/run-${surfaceId}-${harness}-blocked.normalized.json`;
              writeFileSync(recordPath, JSON.stringify(record, null, 2));
              console.log(
                `surface=${surfaceId} harness=${harness} profile=${name} → BLOCKED (${detection.reason}): ` +
                  `${detection.detail ?? detection.command} → ${recordPath}`,
              );
              continue;
            }
            const base = tagSurface ? `${surfaceId}-${harness}-${name}` : `${harness}-${name}`;
            const attemptLabel = args.attempts === 1 ? base : `${base}-a${attempt}`;
            const ns = resolveNs(pack.run_id, attemptLabel);
            const stem = args.attempts === 1 ? `${harness}-${name}${sfx}` : `${harness}-${name}${sfx}-a${attempt}`;
            const paths = defaultInvokePaths(dir, stem, harness);
            let provisioning: Awaited<ReturnType<typeof provisionHarnessForSurface>>;
            try {
              provisioning = await provisionHarnessForSurface({
                pack,
                harness,
                surface: surfaceId,
                paths,
                cwd: process.cwd(),
              });
            } catch (e) {
              const record = buildBlockedResult(pack, surfaceId, harness, "requires-oauth");
              const recordPath = `${dir}/run-${surfaceId}-${harness}-${name}-blocked.normalized.json`;
              writeFileSync(recordPath, JSON.stringify(record, null, 2));
              console.log(
                `surface=${surfaceId} harness=${harness} profile=${name} → BLOCKED (mcp provisioning failed): ` +
                  `${e instanceof Error ? e.message : String(e)} → ${recordPath}`,
              );
              continue;
            }
            // When the user pins a model/effort, reflect it in the profile the
            // prompt describes so the agent's self-report matches what runs.
            const runProfile = {
              ...profile,
              ...(args.model ? { model: args.model } : {}),
              ...(args.effort ? { effort: args.effort as HarnessProfile["effort"] } : {}),
            };
            const prompt = buildExecutorPrompt({ pack, profile: runProfile, ns, resultsPath: paths.resultsPath, tracePath: paths.tracePath, surface });
            writeFileSync(paths.promptPath, prompt);
            // Collect the job; it runs in the concurrency pool after planning.
            invokeJobs.push({
              harness,
              profileName: name,
              surfaceId,
              attempt,
              ns,
              paths,
              label: `${harness}/${surfaceId.toUpperCase()}/${name}${args.attempts > 1 ? `/a${attempt}` : ""}`,
              runOpts: {
                pack,
                harness,
                profile: name,
                surface: surfaceId,
                ns,
                paths,
                cwd: process.cwd(),
                model: args.model || undefined,
                effort: (args.effort || runProfile.effort) as InvokeRunOptions["effort"],
                timeoutMs: args.invokeTimeout > 0 ? args.invokeTimeout * 1000 : undefined,
                retries: args.invokeRetries,
                env: provisioning.env,
                provisioning: provisioning.meta,
              },
            });
          }
        } else {
          // The label feeds both the namespace and the filenames; the surface tag
          // keeps concurrent surfaces from colliding on the live product's ns.
          const base = tagSurface ? `${surfaceId}-${name}` : name;
          const attemptLabel = args.attempts === 1 ? base : `${base}-a${attempt}`;
          const ns = resolveNs(pack.run_id, attemptLabel);
          const stem = args.attempts === 1 ? `${name}${sfx}` : `${name}${sfx}-a${attempt}`;
          const resultsPath = `${dir}/run-${stem}.json`;
          const tracePath = `${dir}/run-${stem}.trace.json`;
          const prompt = buildExecutorPrompt({ pack, profile, ns, resultsPath, tracePath, surface });
          const out = `${dir}/prompt-${stem}.txt`;
          writeFileSync(out, prompt);
          resultPaths.push(resultsPath);
          console.log(
            `surface=${surfaceId} profile=${name} attempt=${attempt}/${args.attempts} ns=${ns} → ${out} ` +
              `(results→${resultsPath}, trace→${tracePath})`,
          );
          if (attempt < args.attempts) resetHints.push(`  ax-eval reset --pack ${args.pack} --ns ${ns}`);
        }
      }
    }
  }
  // Execute the planned invoke jobs through the concurrency pool (parallel by
  // default; --concurrency 1 forces serial). Distinct namespaces per job mean
  // concurrent runs don't collide in the sandbox. Bookkeeping is collected in
  // deterministic (planned) order regardless of completion order.
  if (invokeJobs.length) {
    const conc = Math.max(1, Math.min(args.concurrency, invokeJobs.length));
    const started = Date.now();
    console.log(
      `\nRunning ${invokeJobs.length} harness invocation(s) at concurrency=${conc}` +
        `${conc === 1 ? " (serial)" : ""}… this may take several minutes.`,
    );
    await runPool(invokeJobs, conc, async (job) => {
      console.log(`  ▶ start  ${job.label}`);
      const invoke = await runInvokeHarness(job.runOpts);
      const note = [
        invoke.timedOut ? "timed out" : null,
        (invoke.attempts ?? 1) > 1 ? `${invoke.attempts} attempts` : null,
      ].filter(Boolean).join(", ");
      console.log(
        `  ${invoke.ok ? "✓ done " : "✗ FAIL "} ${job.label} → ${invoke.ok ? "DONE" : "FAILED"}` +
          `${note ? ` (${note})` : ""} (results→${job.paths.resultsPath})`,
      );
    });
    for (const job of invokeJobs) {
      resultPaths.push(job.paths.resultsPath);
      const grouped = resultPathsByHarness.get(job.harness) ?? [];
      grouped.push(job.paths.resultsPath);
      resultPathsByHarness.set(job.harness, grouped);
      if (job.attempt < args.attempts) resetHints.push(`  ax-eval reset --pack ${args.pack} --ns ${job.ns}`);
    }
    console.log(`Finished ${invokeJobs.length} invocation(s) in ${Math.round((Date.now() - started) / 1000)}s.`);
  }
  if (args.invoke) {
    if (resultPathsByHarness.size) {
      // ONE combined verify-generated over every cell → the cross-harness ×
      // cross-surface matrix report. verify-generated groups results into
      // {harness × surface × profile} cells on its own, and scores each cell's
      // discovery against its OWN sibling transcript (auto-paired by result
      // path). So we deliberately omit BOTH --observe (keyed by profile NAME, it
      // would bleed one cell's transcript across every same-named cell) and
      // --harness (the records carry their harness; the report groups them). One
      // command, one report — not a per-harness split.
      const allInvoked = [...resultPathsByHarness.values()].flat();
      const harnessCount = resultPathsByHarness.size;
      console.log(
        `\nVerify ${harnessCount > 1 ? "the matrix (cross-harness × cross-surface)" : "the invoked runs"} — one report over all cells:`,
      );
      console.log(
        `  ax-eval verify-generated --pack ${args.pack} ` +
          allInvoked.map((p) => `--results ${p}`).join(" ") +
          ` --min-pass-rate 0.8 --html ${dir}/generated-eval.html`,
      );
    }
  } else {
    console.log(
      `\nRun each prompt as a host sub-agent (each does discovery THEN tasks), then:\n` +
        `  ax-eval verify-generated --pack ${args.pack} ` +
        resultPaths.map((p) => `--results ${p}`).join(" ") +
        ` --min-pass-rate 0.8 --html ${dir}/generated-eval.html`,
    );
  }
  if (resetHints.length) {
    console.log(`\nBetween attempts, reset the previous namespace so pass@k is isolated:\n${resetHints.join("\n")}`);
  }
  if (blockedNotes.length) {
    console.log(
      `\n${blockedNotes.length} surface(s) blocked on credentials (emitted as blocked cube cells):\n` +
        `${blockedNotes.join("\n")}\n` +
        `Add the keys above to .env (or 'ax-eval init --pack ${args.pack ?? "<pack>"} --surface all'), ` +
        `then re-run exec-plan to generate their prompts.`,
    );
  }
  return 0;
}

/** Run `worker` over `items` with at most `limit` in flight at once, preserving
 *  result order. A tiny fixed-worker pool — enough for the exec-plan fan-out
 *  without pulling in a dependency. */
async function runPool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}

function mergeProfileRuns(runs: ProfileRun[]): ProfileRun[] {
  const grouped = new Map<string, ProfileRun>();
  for (const run of runs) {
    const key = `${run.harness ?? ""}::${run.surface ?? ""}::${run.profile}`;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        ...run,
        trace: [...(run.trace ?? [])],
        outcomes: [...run.outcomes],
        evidence: run.evidence
          ? {
              results: [...(run.evidence.results ?? [])],
              trace: [...(run.evidence.trace ?? [])],
              transcript: run.evidence.transcript,
            }
          : undefined,
      });
      continue;
    }
    current.outcomes.push(...run.outcomes);
    current.trace = [...(current.trace ?? []), ...(run.trace ?? [])];
    current.ns = [current.ns, run.ns].filter(Boolean).join(", ");
    current.discovery ??= run.discovery;
    current.discoverySource ??= run.discoverySource;
    if (run.evidence) {
      current.evidence ??= { results: [], trace: [] };
      if (run.evidence.results?.length) current.evidence.results = [...(current.evidence.results ?? []), ...run.evidence.results];
      if (run.evidence.trace?.length) current.evidence.trace = [...(current.evidence.trace ?? []), ...run.evidence.trace];
      current.evidence.transcript ??= run.evidence.transcript;
    }
  }
  return [...grouped.values()];
}

function passRate(runs: ProfileRun[]): number {
  const outcomes = runs.flatMap((r) => r.outcomes);
  if (!outcomes.length) return 0;
  return outcomes.filter((o) => o.success).length / outcomes.length;
}

function mergeDiscoveryResults(observed: DiscoveryResult, selfReported: DiscoveryResult | undefined): DiscoveryResult {
  if (!selfReported) return observed;
  const uniq = (values: (string | undefined)[]): string[] => [...new Set(values.filter((v): v is string => !!v))];
  return {
    ns: observed.ns ?? selfReported.ns,
    completed_gid: observed.completed_gid ?? selfReported.completed_gid,
    searches: uniq([...(observed.searches ?? []), ...(selfReported.searches ?? [])]),
    urls_visited: uniq([...(observed.urls_visited ?? []), ...(selfReported.urls_visited ?? [])]),
    endpoint_used: observed.endpoint_used || selfReported.endpoint_used,
    auth_scheme_found: observed.auth_scheme_found || selfReported.auth_scheme_found,
    inspected_local_source: observed.inspected_local_source === true || selfReported.inspected_local_source === true,
    notes: uniq([observed.notes, selfReported.notes]).join("; "),
  };
}

/**
 * Render the local competitive report from normalized records. Reads every
 * `--results <*.normalized.json>` (the cube cells emitted by verify-generated)
 * and renders the surface × product plane: cross-surface (per product) and
 * cross-product (per surface) comparisons. The third axis (which agent/harness
 * ran the tasks) is not computed locally.
 */
async function cmdCompetitive(args: Parsed): Promise<number> {
  if (args.results.length === 0) {
    throw new Error(
      "usage: ax-eval competitive --results <run.normalized.json>... [--html out.html]",
    );
  }
  const records: NormalizedResult[] = [];
  for (const rPath of args.results) {
    const parsed = JSON.parse(readFileSync(rPath, "utf8")) as NormalizedResult;
    if (parsed?.schema !== "ax.normalized-result/v1") {
      throw new Error(`${rPath} is not an ax.normalized-result/v1 record`);
    }
    records.push(parsed);
  }
  const harnesses = [...new Set(records.map((r) => r.harness))];
  const html = renderCompetitiveReport(records, {
    harness: harnesses.length === 1 ? harnesses[0] : undefined,
  });
  const outPath = args.html || `${args.runDir}/competitive.html`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  console.log(`Saved competitive report → ${outPath} (${records.length} cell(s))`);
  return 0;
}

function absoluteIfPresent(path: string | undefined): string | undefined {
  return path ? resolve(path) : undefined;
}

function snapshotRuns(runs: ProfileRun[]): ProfileRun[] {
  return runs.map((run) => ({
    ...run,
    trace: [...(run.trace ?? [])],
    outcomes: [...run.outcomes],
    evidence: run.evidence
      ? {
          results: (run.evidence.results ?? []).map((p) => resolve(p)),
          trace: (run.evidence.trace ?? []).map((p) => resolve(p)),
          transcript: absoluteIfPresent(run.evidence.transcript),
        }
      : undefined,
  }));
}

async function cmdRenderGenerated(args: Parsed): Promise<number> {
  if (!args.snapshot) {
    throw new Error("usage: ax-eval render-generated --snapshot <report.snapshot.json> [--html out.html]");
  }
  const snapshot = loadGeneratedReportSnapshot(args.snapshot);
  const html = renderGeneratedSnapshot(snapshot);
  const outPath = args.html || args.snapshot.replace(/\.snapshot\.json$/i, ".html");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  console.log(`Saved report → ${outPath}`);
  return 0;
}

async function cmdVerifyGenerated(args: Parsed): Promise<number> {
  loadDotenv();
  if (!args.pack) throw new Error("usage: ax-eval verify-generated --pack <yaml> --results <run.json>...");
  if (args.results.length === 0) throw new Error("provide at least one --results <run.json>");
  const pack = loadPack(args.pack);
  console.log(`Verifying ${args.results.length} result file(s) against ${pack.tasks.length} task(s) in pack "${pack.name}"…`);
  const client = new BearerClient({
    baseUrl: pack.base_url,
    token: resolveToken(pack),
    responseEnvelope: pack.response_envelope,
    authScheme: pack.auth?.type ?? "bearer",
    authHeader: pack.auth?.header,
    extraHeaders: pack.headers,
    apiStyle: pack.api_style,
  });
  const byAttempt: ProfileRun[] = [];
  // Runtime warnings captured while assembling the report — surfaced verbatim
  // in the report's Methodology so the reader sees what couldn't be measured.
  const warnings: string[] = [];
  // Resolve evidence paths relative to where the HTML report will land, so the
  // rendered links resolve when the report is opened from disk.
  const reportPath = args.html || args.md || `${args.runDir}/generated-eval.html`;
  const reportDir = dirname(reportPath);
  const rel = (p: string): string => {
    const r = relative(reportDir, p);
    return r && !r.startsWith("..") ? r : p;
  };
  // Surface-specific identifiers let the transcript parser recognize CLI/SDK/MCP
  // usage (not just curl). Sourced from the pack's surface config.
  const parseOpts = {
    baseUrl: pack.base_url,
    cliBin: pack.surfaces?.cli?.bin,
    sdkPackage: pack.surfaces?.sdk?.package,
    mcpServer: pack.surfaces?.mcp?.server,
  };
  for (const rPath of args.results) {
    const executor = loadResults(rPath);
    // Surface tag: a concrete --surface flag wins (explicit), else the executor's
    // self-report, else "api" (the default + back-compat surface). `--surface all`
    // is not an override — each result keeps its own self-reported surface.
    const surface: SurfaceId =
      concreteSurface(args) ?? (isSurfaceId(executor.surface) ? executor.surface : "api");
    const taskCount = tasksForSurface(pack, surface).length;
    const passCount = Object.values(executor.results).filter((r) => r?.gid).length;
    console.log(`  Checking round-trip oracles for profile "${executor.profile}" (${passCount}/${taskCount} tasks reported a gid on ${surface})…`);
    const outcomes = await verifyGeneratedPack(pack, executor, client, surface);
    const tracePath = rPath.replace(/\.json$/, ".trace.json");
    let trace = loadTrace(tracePath);
    if (!existsSync(tracePath)) {
      warnings.push(
        `No trace file at ${rel(tracePath)} — trace checks for ${executor.profile} fall back to whatever the agent self-reported (or none).`,
      );
    }
    // Behavioral discovery: score this profile's Phase-0 discovery funnel. Prefer the
    // OBJECTIVE funnel parsed from the harness transcript over the agent's
    // self-report; fall back to self-report, labeling the provenance.
    //
    // Transcript resolution, in order: (1) the per-result sibling transcript
    // (`run-*.transcript.jsonl`, like the trace sibling), else (2) an explicit
    // `--observe <profile>=<path>` fallback. Sibling-first is intentional:
    // multi-cell reports reuse profile names (low/high) across harness×surface
    // runs, so a profile-keyed observe map would otherwise let one transcript
    // overwrite all sibling cells with the same profile.
    let discovery;
    let discoverySource: ProfileRun["discoverySource"];
    const siblingTranscript = rPath.replace(/\.json$/, ".transcript.jsonl");
    const profileObservedTranscript = args.observe[executor.profile];
    const obsPath = existsSync(siblingTranscript) ? siblingTranscript : profileObservedTranscript;
    if (pack.discovery?.product && obsPath) {
      if (!existsSync(obsPath)) {
        warnings.push(
          `--observe transcript not found at ${rel(obsPath)} for ${executor.profile} — falling back to the agent's self-reported funnel.`,
        );
        if (executor.discovery) {
          const result = { ...executor.discovery, ns: executor.discovery.ns ?? executor.ns };
          discovery = await scoreDiscovery(pack.discovery, result, client, { surface, apiStyle: pack.api_style });
          discoverySource = "self-report";
        }
      } else {
        try {
          const run = parseTranscript(obsPath, parseOpts);
          const selfReported = executor.discovery
            ? { ...executor.discovery, ns: executor.discovery.ns ?? executor.ns }
            : undefined;
          discovery = await scoreDiscovery(
            pack.discovery,
            mergeDiscoveryResults(observedToDiscovery(run, executor.ns, surface), selfReported),
            client,
            { surface, apiStyle: pack.api_style },
          );
          discoverySource = "observed";
          const objTrace = observedToTrace(run);
          if (objTrace.length && trace.length === 0) trace = objTrace;
        } catch (err) {
          warnings.push(
            `Failed to parse transcript ${rel(obsPath)} for ${executor.profile} (${err instanceof Error ? err.message : String(err)}); discovery scoring skipped.`,
          );
        }
      }
    } else if (pack.discovery?.product && executor.discovery) {
      const result = { ...executor.discovery, ns: executor.discovery.ns ?? executor.ns };
      discovery = await scoreDiscovery(pack.discovery, result, client, { surface, apiStyle: pack.api_style });
      discoverySource = "self-report";
    }
    const traceExisted = existsSync(tracePath);
    byAttempt.push({
      profile: executor.profile,
      harness: executor.harness,
      model: executor.model,
      outcomes,
      surface,
      ns: executor.ns,
      trace,
      discovery,
      discoverySource,
      evidence: {
        results: [rel(rPath)],
        trace: traceExisted ? [rel(tracePath)] : [],
        transcript: obsPath ? rel(obsPath) : undefined,
      },
    });
  }
  const byProfile = mergeProfileRuns(byAttempt);
  // The headline gap: measure static readiness on the same target and put
  // it next to behavioral success. Best-effort — never let a static/network
  // hiccup fail the (already-completed) behavioral verification.
  let staticReadiness: StaticReadiness | undefined;
  const site = pack.site_url;
  if (!site && !pack.openapi_url) {
    warnings.push(
      "Static readiness skipped: pack has neither site_url nor openapi_url, so the gap can't be reported.",
    );
  } else {
    const mode = args.offline ? "fixture" : "live";
    staticReadiness = { site: site || "" };
    if (site) {
      console.log("  Auditing static site readiness (v0 + v2)…");
      try {
        const v0 = await auditSite(site, { mode });
        staticReadiness.v0Score = v0.score;
        staticReadiness.v0Checks = v0.checks;
      } catch (err) {
        warnings.push(`Static v0 audit failed: ${err instanceof Error ? err.message : String(err)}.`);
      }
      try {
        staticReadiness.v2Score = (
          await discoverSurfaces(site, { mode, maxPages: args.maxPages, maxDepth: args.maxDepth })
        ).score;
      } catch (err) {
        warnings.push(`Static v2 discover failed: ${err instanceof Error ? err.message : String(err)}.`);
      }
    } else {
      warnings.push("Static v0/v2 skipped: pack has no site_url (content-quality audit still ran via openapi_url).");
    }
    // v3 content-quality (OpenAPI smell) audit — the "once found, is it usable?"
    // axis. Best-effort, like v0/v2: never fail an already-completed run.
    if (pack.openapi_url) {
      console.log("  Auditing OpenAPI spec quality (v3)…");
      try {
        const { text, source } = await fetchSpecText(pack.openapi_url, { offline: args.offline });
        const audit = auditSpecQuality(text, source);
        staticReadiness.contentScore = audit.score;
        staticReadiness.contentQuality = audit;
      } catch (err) {
        warnings.push(`Static v3 content-quality audit failed: ${err instanceof Error ? err.message : String(err)}.`);
      }
    } else {
      warnings.push("Content-quality (v3) audit skipped: pack has no openapi_url.");
    }
  }
  console.log("  Rendering report…");
  const html = renderGeneratedReport(pack, byProfile, staticReadiness, probeHarness(), {
    gate: { minPassRate: args.minPassRate },
    warnings,
  });
  // Primary flag is --html; --md is accepted as an alias that now writes HTML too
  // (so existing `--md …/generated-eval.md` invocations keep working). The default
  // output is a self-contained .html.
  const outPath = args.html || args.md || `${args.runDir}/generated-eval.html`;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  console.log(`Saved report → ${outPath}`);
  const snapshotPath = args.snapshot || `${args.runDir}/generated-eval.snapshot.json`;
  const snapshot: GeneratedReportSnapshot = {
    schema: GENERATED_REPORT_SNAPSHOT_SCHEMA,
    pack,
    runs: snapshotRuns(byProfile),
    staticReadiness,
    harness: probeHarness(),
    warnings,
    minPassRate: args.minPassRate,
  };
  mkdirSync(dirname(snapshotPath), { recursive: true });
  saveGeneratedReportSnapshot(snapshotPath, snapshot);
  console.log(`Saved render snapshot → ${snapshotPath}`);
  if (process.stdout.isTTY) {
    const opener = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
    spawnSync(opener, [outPath], { stdio: "ignore" });
  }
  // Emit the normalized cell { surface, product, harness } next to the report.
  // This is the durable, aggregatable artifact: the local `competitive` command
  // (or any later aggregator) stacks these across harnesses without re-deriving
  // anything from the raw run files.
  const cellSurface: SurfaceId = byProfile.find((r) => r.surface)?.surface ?? "api";
  const runHarnesses = [...new Set(byProfile.map((r) => r.harness).filter((h): h is string => !!h))];
  const recordHarness = args.harness.length === 1
    ? args.harness[0]!
    : runHarnesses.length === 1
      ? runHarnesses[0]!
      : runHarnesses.length > 1
        ? "mixed-local"
        : probeHarness().host;
  const record = buildNormalizedResult(
    pack,
    cellSurface,
    recordHarness,
    byProfile,
    // Content quality is product-level (the spec audit), normalized to 0–1 for
    // the competitive heat cells. null when no openapi_url / audit didn't run.
    staticReadiness?.contentScore !== undefined ? staticReadiness.contentScore / 100 : null,
  );
  const recordPath = outPath.replace(/\.[^.]+$/, "") + ".normalized.json";
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log(`Saved normalized record → ${recordPath}`);
  const contentQuality =
    staticReadiness?.contentScore !== undefined ? staticReadiness.contentScore / 100 : null;
  const cells = buildNormalizedResultCells(pack, byProfile, contentQuality, probeHarness().host);
  if (cells.length > 1) {
    const base = outPath.replace(/\.[^.]+$/, "");
    const cellPaths: string[] = [];
    for (const cell of cells) {
      const path = `${base}.${cell.fileStem}.normalized.json`;
      writeFileSync(path, JSON.stringify(cell.record, null, 2));
      cellPaths.push(path);
    }
    console.log(`Saved normalized cell records → ${cellPaths.join(", ")}`);
  }
  const anyFail = byProfile.some((p) => p.outcomes.some((o) => !o.success));
  const rate = passRate(byProfile);
  for (const p of byProfile) {
    for (const o of p.outcomes) {
      const mark = o.success ? "✓" : "✗";
      const detail = o.error ?? o.oracleResults.map((r) => r.detail).filter(Boolean).join("; ");
      console.log(`  ${mark} [${p.profile}] ${o.taskId}${detail ? ` — ${detail}` : ""}`);
    }
  }
  console.log(`Pass rate: ${Math.round(rate * 100)}% (${byProfile.flatMap((p) => p.outcomes).filter((o) => o.success).length}/${byProfile.flatMap((p) => p.outcomes).length})`);
  if (args.minPassRate !== undefined && rate < args.minPassRate) {
    console.error(`CI gate failed: pass rate ${rate.toFixed(2)} < required ${args.minPassRate.toFixed(2)}`);
    return 1;
  }
  if (args.minPassRate !== undefined) {
    console.log(`CI gate passed: pass rate ${rate.toFixed(2)} >= required ${args.minPassRate.toFixed(2)}`);
    return 0;
  }
  return anyFail ? 1 : 0;
}

function cmdTraceDiff(args: Parsed): number {
  if (!args.trace) throw new Error("usage: ax-eval trace-diff --pack <yaml> --trace <run.trace.json>");
  const pack = loadPack(args.pack);
  const trace = loadTrace(args.trace);
  const diffs = diffTrace(pack, trace);
  console.log(renderTraceDiffs(diffs));
  return diffs.length ? 1 : 0;
}

/**
 * Sandbox teardown for pass@k hygiene — delete the probe resources a run left
 * behind (named `AX probe … {ns}`) so repeated live runs don't contaminate each
 * other. Target-agnostic: resolves the pack's declared sandbox scope, then a
 * per-target resetter lists + deletes. `--ns` scopes to one run; `--dry-run`
 * previews. Targets without a resetter degrade gracefully (no throw).
 */
async function cmdReset(args: Parsed): Promise<number> {
  loadDotenv();
  if (!args.pack) throw new Error("usage: ax-eval reset --pack <yaml> [--ns <token>] [--dry-run]");
  const pack = loadPack(args.pack);
  const client = new BearerClient({
    baseUrl: pack.base_url,
    token: resolveToken(pack),
    responseEnvelope: pack.response_envelope,
    authScheme: pack.auth?.type ?? "bearer",
    authHeader: pack.auth?.header,
    extraHeaders: pack.headers,
    apiStyle: pack.api_style,
  });
  const scope = resolveScope(pack);
  const result = await resetPack(pack, client, scope, { ns: args.ns || undefined, dryRun: args.dryRun });
  console.log(result.message);
  for (const id of result.deleted) console.log(`  ${args.dryRun ? "would delete" : "deleted"} ${id}`);
  for (const e of result.errors) console.error(`  ! ${e}`);
  if (!result.supported) return 0;
  return result.errors.length ? 1 : 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (isHelpToken(command)) {
    console.log(USAGE);
    return 0;
  }
  // Validate the command before parsing flags, so an unknown command shows the
  // usage message rather than a flag-parse error from a stray --typo.
  if (command === undefined || !COMMAND_SET.has(command)) {
    console.error(USAGE);
    return 2;
  }
  if (argv.slice(1).some(isHelpToken)) {
    console.log(commandUsage(command));
    return 0;
  }
  const args = parseArgs(argv.slice(1));
  switch (command) {
    case "run":
      return cmdRun(args);
    case "audit":
      return cmdAudit(args);
    case "discover":
      return cmdDiscover(args);
    case "smells":
      return cmdSmells(args);
    case "report":
      return cmdReport(args);
    case "list-harnesses":
      return cmdList();
    case "probe":
      return cmdProbe(args);
    case "check-env":
      return cmdCheckEnv(args);
    case "init":
      return cmdInit(args);
    case "verify":
      return cmdVerify(args);
    case "ingest":
      return cmdIngest(args);
    case "generate":
      return cmdGenerate(args);
    case "review":
      return cmdReview(args);
    case "exec-plan":
      return cmdExecPlan(args);
    case "verify-generated":
      return cmdVerifyGenerated(args);
    case "render-generated":
      return cmdRenderGenerated(args);
    case "competitive":
      return cmdCompetitive(args);
    case "trace-diff":
      return cmdTraceDiff(args);
    case "reset":
      return cmdReset(args);
    case "mcp-server":
      return cmdMcpServer();
    default:
      console.error(USAGE);
      return 2;
  }
}

async function cmdMcpServer(): Promise<number> {
  const { startMcpServer } = await import("./mcp-server.js");
  await startMcpServer();
  // `connect()` resolves once the stdio transport is wired up — it does NOT
  // block for the server's lifetime. Returning here would let `main()` resolve
  // and trigger `process.exit(0)`, killing the server before it handles a
  // single request. Stay alive until the transport closes (stdin EOF), which
  // the SDK surfaces by exiting the process on its own.
  return new Promise<number>(() => {});
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
