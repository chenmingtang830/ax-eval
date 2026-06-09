#!/usr/bin/env node
/**
 * `ax-eval` command-line entrypoint.
 *
 *   ax-eval run [--pack p] [--harness h]... [--out o] [--offline]  behavioral matrix + static gap
 *   ax-eval audit [--pack p | --site url] [--offline]              static (agent-readiness) audit only
 *   ax-eval smells --openapi <url> [--html out] [--out json] [--offline]  content-quality (OpenAPI smell) audit
 *   ax-eval report <results.json>                                  render a saved result file
 *   ax-eval list-harnesses                                         show registered harnesses
 *   ax-eval probe [--out json]                                     detect host harness + suggest profile
 *   ax-eval init --pack <yaml>                                     print a .env stub for a pack
 *   ax-eval check-env --pack <yaml>                                  show env required by the pack
 *   ax-eval verify --pack <yaml> --results <run.json>...             generated-run verify + CI gate
 *       [--min-pass-rate 0.8] [--html path]
 *   ax-eval ingest --openapi <url> [--out json] [--offline]          parse a spec → IngestedSpec
 *   ax-eval ingest --graphql <endpoint|file> [--out json] [--offline] introspect a GraphQL schema → rich IngestedGraphql
 *   ax-eval generate --from <ingest.json> [--product P] [--site url]   IngestedSpec → frozen pack
 *                    [--docs url,url] [--limit N] [--l2-limit N]       (product/auth/scope auto-derived from the spec)
 *                    [--l4-limit N] [--base-url url] [--out yaml]
 *                    REST: L1 create · L2 chain · L3 goal · L4 lifecycle; GraphQL: L1 create + read-back oracles
 *   ax-eval verify-generated --pack <yaml> --results <run.json>...   round-trip oracles → HTML report
 *       [--html path] writes the self-contained HTML report (--md is an alias that also writes HTML).
 *   ax-eval trace-diff --pack <yaml> --trace <run.trace.json>         structural trace diff
 *   ax-eval reset --pack <yaml> [--ns <token>] [--dry-run]           delete probe resources (pass@k hygiene)
 */
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { generateGraphqlPack, looksLikeGraphqlIngest } from "./generate/graphql-pack.js";
import { loadResults, loadTrace, verifyGeneratedPack } from "./generate/verify.js";
import {
  renderCompetitiveReport,
  renderGeneratedReport,
  type ProfileRun,
  type StaticReadiness,
} from "./generate/report.js";
import { buildNormalizedResult, buildBlockedResult, type NormalizedResult } from "./generate/record.js";
import { isSurfaceId, type SurfaceId } from "./surface/types.js";
import type { TargetPack } from "./schemas.js";
import { getSurface, resolveSurfaceSelection } from "./surface/index.js";
import { checkApproval, reviewSummary, writeApproval } from "./generate/review.js";
import { scoreDiscovery } from "./generate/discovery.js";
import { buildExecutorPrompt, resolveNs } from "./harness/executor.js";
import { observedToDiscovery, observedToTrace, parseTranscript } from "./harness/transcript.js";
import { diffTrace, renderTraceDiffs } from "./harness/trace-diff.js";
import { getProfile } from "./harness/profile.js";
import { probeHarness } from "./harness/probe.js";
import { BearerClient } from "./http/client.js";
import { describeRequiredEnv, hasRequiredEnv, resolveScope, resolveToken, surfaceAuthStatus, type SurfaceAuthStatus } from "./target/config.js";
import { resetPack } from "./target/reset.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACK = resolve(HERE, "..", "targets", "asana", "pack.yaml");

interface Parsed {
  pack: string;
  harness: string[];
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
  from: string;
  baseUrl: string;
  limit: number;
  l2Limit: number | undefined;
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
    from: "",
    baseUrl: "",
    limit: 3,
    l2Limit: undefined,
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
    dryRun: false,
    ns: "",
    attempts: 3,
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
    else if (a === "--from") p.from = value(++i, "--from");
    else if (a === "--base-url") p.baseUrl = value(++i, "--base-url");
    else if (a === "--limit") p.limit = Number(value(++i, "--limit"));
    else if (a === "--l2-limit") p.l2Limit = Number(value(++i, "--l2-limit"));
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

  // Static (agent-readiness) audit next to the behavioral matrix — the "gap".
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
 * `ax-eval verify --pack <yaml> --results <run.json>...` —
 *
 * Generated-pack verifier and CI gate. Replays each recorded run against the
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

  if (looksLikeGraphqlIngest(spec)) {
    const pack = generateGraphqlPack(spec, {
      limit: args.limit,
      runId: args.runId || undefined,
      packName: `${slugify(product)}-generated`,
      product,
      baseUrl: args.baseUrl || undefined,
      siteUrl: args.site || "",
      ...(docsUrls ? { docsUrls } : {}),
    });
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

  // Generic options derived entirely from the spec + flags. Auth, sandbox_scope
  // and headers are derived inside generatePack from the ingested securityScheme
  // and resource graph — no per-product hardcoding.
  const baseOpts: GenerateOptions = {
    limit: args.limit,
    ...(args.l2Limit !== undefined ? { l2Limit: args.l2Limit } : {}),
    ...(args.l4Limit !== undefined ? { l4Limit: args.l4Limit } : {}),
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
  const opts: GenerateOptions = isAsana
    ? {
        ...ASANA_PRESET,
        ...baseOpts,
        ...(args.site ? { siteUrl: args.site } : { siteUrl: ASANA_PRESET.siteUrl }),
        ...(docsUrls ? { docsUrls } : { docsUrls: ASANA_PRESET.docsUrls }),
      }
    : baseOpts;

  const pack = generatePack(spec, opts);
  const yaml = packToYaml(pack);
  // Default output: Asana keeps its committed target path; everything else lands
  // in results/<slug>.generated.pack.yaml unless --out is given.
  const defaultOut = isAsana
    ? "targets/asana/generated.pack.yaml"
    : `results/${slugify(product)}.generated.pack.yaml`;
  const out = args.out && args.out !== "results/last-run.json" ? args.out : defaultOut;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, yaml);
  console.log(`Generated ${pack.tasks.length} tasks for ${product} (generated_by: ${pack.generated_by}):`);
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
 * (behavioral AEO) followed by the L1-L4 tasks built on what it discovered — so
 * discovery is NOT a separate agent, it's step 0 of floor and ceiling. ns and
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

function cmdExecPlan(args: Parsed): number {
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
  const profileNames = args.harness.length ? args.harness : ["floor", "ceiling"];
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
  const resetHints: string[] = [];
  const blockedNotes: string[] = [];
  for (const surfaceId of surfaceIds) {
    // Auth gate per surface: if the agent can't authenticate this surface
    // headlessly (OAuth-only, or a token the developer hasn't set), don't emit
    // runnable prompts for it. Instead write a `blocked` cube cell (so the
    // competitive report shows an honest blocked state, never a fake 0%) and
    // tell the developer exactly which env vars to add.
    const auth = surfaceAuthStatus(pack, surfaceId);
    if (auth.blocked) {
      const harness = probeHarness().host;
      const record = buildBlockedResult(pack, surfaceId, harness, auth.blocked);
      const recordPath = `${dir}/run-${surfaceId}-blocked.normalized.json`;
      writeFileSync(recordPath, JSON.stringify(record, null, 2));
      const add = auth.missing.length ? ` Add to .env: ${auth.missing.join(", ")}.` : "";
      const why = auth.blocked === "requires-oauth"
        ? "OAuth-only surface — register an OAuth app and store a refresh token"
        : "missing this surface's credential";
      console.log(`surface=${surfaceId} → BLOCKED (${auth.blocked}): ${why}.${add} → ${recordPath}`);
      blockedNotes.push(
        `  ${surfaceId}: ${auth.blocked}.${add}` +
          (auth.instructions ? `\n    ${auth.instructions}` : ""),
      );
      continue;
    }
    const surface = getSurface(surfaceId);
    const sfx = tagSurface ? `-${surfaceId}` : "";
    for (const name of profileNames) {
      const profile = getProfile(name);
      for (let attempt = 1; attempt <= args.attempts; attempt++) {
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
  console.log(
    `\nRun each prompt as a host sub-agent (each does discovery THEN tasks), then:\n` +
      `  ax-eval verify --pack ${args.pack} ` +
      resultPaths.map((p) => `--results ${p}`).join(" ") +
      ` --min-pass-rate 0.8 --html ${dir}/generated-eval.html`,
  );
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

function mergeProfileRuns(runs: ProfileRun[]): ProfileRun[] {
  const grouped = new Map<string, ProfileRun>();
  for (const run of runs) {
    const current = grouped.get(run.profile);
    if (!current) {
      grouped.set(run.profile, {
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

async function cmdVerifyGenerated(args: Parsed): Promise<number> {
  loadDotenv();
  if (!args.pack) throw new Error("usage: ax-eval verify-generated --pack <yaml> --results <run.json>...");
  if (args.results.length === 0) throw new Error("provide at least one --results <run.json>");
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
    const outcomes = await verifyGeneratedPack(pack, executor, client);
    const tracePath = rPath.replace(/\.json$/, ".trace.json");
    let trace = loadTrace(tracePath);
    if (!existsSync(tracePath)) {
      warnings.push(
        `No trace file at ${rel(tracePath)} — trace checks for ${executor.profile} fall back to whatever the agent self-reported (or none).`,
      );
    }
    // Behavioral AEO: score this profile's Phase-0 discovery funnel. Prefer the
    // OBJECTIVE funnel parsed from the harness transcript (--observe) over the
    // agent's self-report; fall back to self-report, labeling the provenance.
    let discovery;
    let discoverySource: ProfileRun["discoverySource"];
    const obsPath = args.observe[executor.profile];
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
          discovery = await scoreDiscovery(
            pack.discovery,
            observedToDiscovery(run, executor.ns, surface),
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
  // The headline gap: measure static agent-readiness on the same target and put
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
      try {
        staticReadiness.v0Score = (await auditSite(site, { mode })).score;
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
  // Emit the normalized cell { surface, product, harness } next to the report.
  // This is the durable, aggregatable artifact: the local `competitive` command
  // (or any later aggregator) stacks these across harnesses without re-deriving
  // anything from the raw run files.
  const cellSurface: SurfaceId = byProfile.find((r) => r.surface)?.surface ?? "api";
  const record = buildNormalizedResult(
    pack,
    cellSurface,
    probeHarness().host,
    byProfile,
    // Content quality is product-level (the spec audit), normalized to 0–1 for
    // the competitive heat cells. null when no openapi_url / audit didn't run.
    staticReadiness?.contentScore !== undefined ? staticReadiness.contentScore / 100 : null,
  );
  const recordPath = outPath.replace(/\.[^.]+$/, "") + ".normalized.json";
  writeFileSync(recordPath, JSON.stringify(record, null, 2));
  console.log(`Saved normalized record → ${recordPath}`);
  const anyFail = byProfile.some((p) => p.outcomes.some((o) => !o.success));
  const rate = passRate(byProfile);
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
  // Validate the command before parsing flags, so an unknown command shows the
  // usage message rather than a flag-parse error from a stray --typo.
  const COMMANDS = new Set([
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
    "competitive",
    "trace-diff",
    "reset",
  ]);
  const USAGE =
    "usage: ax-eval <run|audit|discover|smells|report|verify|check-env|init|" +
    "list-harnesses|probe|ingest|generate|review|exec-plan|verify-generated|competitive|trace-diff|reset> [options]";
  if (command === undefined || !COMMANDS.has(command)) {
    console.error(USAGE);
    return 2;
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
    case "competitive":
      return cmdCompetitive(args);
    case "trace-diff":
      return cmdTraceDiff(args);
    case "reset":
      return cmdReset(args);
    default:
      console.error(USAGE);
      return 2;
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
