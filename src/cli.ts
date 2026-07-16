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
 *   ax-eval audit-benchmark --benchmark <slug> --benchmark-version <version>
 *       [--benchmark-root <dir>] [--pack-config <slug>=<yaml>]... [--reset-verified <slug>]...
 *   ax-eval reset --pack <yaml> [--ns <token>] [--dry-run]           delete probe resources (pass@k hygiene)
 *   ax-eval exec-plan --invoke --harness claude-code|codex [--profile high] run prompts locally
 */
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse as yamlParse } from "yaml";
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
import { authorPackWithLlm } from "./generate/authoring.js";
import { loadResults, loadTrace, verifyGeneratedPack } from "./generate/verify.js";
import { buildVerificationClientOptions } from "./generate/verification-client.js";
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
import { invokeEfficiency } from "./generate/invoke-efficiency.js";
import { runGeneratorHarness } from "./generate/authoring.js";
import { resolveVendors, writeVendorCard, loadVendorCard } from "./generate/vendor-resolve.js";
import { writeCapabilityExtract, loadCapabilityExtract } from "./generate/capability-extract.js";
import {
  CAPABILITY_EXTRACTION_TIMEOUT_MS,
  extractCapabilitiesBatch,
  parseCapabilitySpecMappings,
} from "./generate/capability-extract-batch.js";
import { parseSelectedMappings } from "./generate/selected-mapping.js";
import { extractSurfaces, writeSurfaceExtract, loadSurfaceExtract } from "./generate/surface-extract.js";
import {
  loadRegistryAuthoringSeedPath,
  MAX_REGISTRY_SOURCE_BYTES,
  mapRegistryAuthoringSeedText,
  writeRegistryAuthoringSeed,
} from "./ingest/registry-seed.js";
import { extractTasks, writeTaskExtract, loadTaskExtract } from "./generate/task-extract.js";
import { composePack, writeComposedPack } from "./generate/compose-pack.js";
import { loadSuite, validatePackAgainstSuite } from "./generate/suite.js";
import { buildLowPassExecutionPlan } from "./generate/low-pass-plan.js";
import { parsePackComposeConfig } from "./generate/pack-compose-config.js";
import { auditBenchmarkAuthoring } from "./generate/benchmark-authoring-audit.js";
import { buildBenchmarkLayout } from "./generate/benchmark-paths.js";
import { defaultSuiteMethodology } from "./generate/suite-methodology.js";
import {
  buildCoverageMatrix,
  deriveConceptUniverse,
  selectCoverageConcepts,
  writeConceptUniverse,
  writeCoverageMatrix,
  writeCoverageSelection,
} from "./generate/coverage.js";
import { synthesizeSuite, writeSynthesizedSuite } from "./generate/suite-synthesize.js";
import { isSurfaceId, SURFACE_IDS, type SurfaceId } from "./surface/types.js";
import { type TargetPack } from "./schemas.js";
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
  type InvokeRunResult,
  type InvokeRunOptions,
} from "./harness/invoke.js";
import { provisionHarnessForSurface } from "./harness/mcp-provision.js";
import { observedToDiscovery, observedToTrace, parseTranscript } from "./harness/transcript.js";
import { diffTrace, renderTraceDiffs } from "./harness/trace-diff.js";
import { getProfile, type HarnessProfile } from "./harness/profile.js";
import { probeHarness } from "./harness/probe.js";
import { BearerClient } from "./http/client.js";
import { describeRequiredEnv, hasRequiredEnv, resolveScope, surfaceAuthStatus, type SurfaceAuthStatus } from "./target/config.js";
import { resetPack } from "./target/reset.js";
import {
  buildEnvChecklist,
  automationGeneratedAt,
  defaultAutomationRunDir,
  discoverAutomationTarget,
  hasMissingRequiredConfig,
  selectSmokeTasks,
  slugifyAutomationName,
  writeAutomationManifest,
  writeShareSummary,
  type AutomationManifest,
} from "./automation.js";
import { resolveGraphqlGeneratePreset, resolveOpenApiGeneratePreset } from "./presets/index.js";

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
  "automate-report",
  "resolve-vendor",
  "map-registry-seed",
  "extract-capabilities",
  "extract-surfaces",
  "synthesize-suite",
  "extract-tasks",
  "compose-pack",
  "plan-low-pass",
  "audit-benchmark",
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
    case "automate-report":
      return [
        "usage: ax-eval automate-report --company <name>",
        "       [--site url] [--docs url,url] [--openapi url] [--graphql endpoint|file]",
        `       [--surface api|cli|sdk|mcp|all] [--harness ${INVOKE_HARNESS_LIST}]`,
        "       [--effort low|medium|high] [--run-dir dir] [--smoke-only] [--approve-by name]",
        "       --approve-by only fills the suggested manual review command; it does not auto-approve generated packs.",
      ].join("\n");
    case "resolve-vendor":
      return "usage: ax-eval resolve-vendor --vendors <name,...> --category <category> [generator flags]";
    case "map-registry-seed":
      return [
        "usage: ax-eval map-registry-seed --from <registry.json|yaml> --vendor <slug>",
        "  Maps a local third-party registry document into a sanitized, review-required",
        "  seed at targets/seeds/<slug>/registry.yaml. Makes no network calls.",
      ].join("\n");
    case "extract-capabilities":
      return [
        "usage: ax-eval extract-capabilities --vendors <slug,...> [generator flags]",
        "       [--capability-spec <slug>=<source>]... [--spec-max-operations N] [--offline]",
        "  Explicit spec sources are fetched exactly (no unrelated fixture fallback).",
        "  Offline spec seeds must be local files; raise --spec-max-operations if a summary truncates.",
        "  Multi-vendor extraction runs at bounded concurrency (maximum 3) with a 12-minute per-vendor generator timeout.",
      ].join("\n");
    case "extract-surfaces":
      return [
        "usage: ax-eval extract-surfaces --vendors <slug,...> [generator flags]",
        "       [--surface-seed <slug>=<targets/seeds/.../registry.yaml>]...",
        "  Registry seeds are explicit review-required hypotheses; official-doc extraction remains authoritative.",
      ].join("\n");
    case "synthesize-suite":
      return "usage: ax-eval synthesize-suite --suite-name <name> --category <category> --vendors <slug,...> [--target-tasks N] [generator flags]";
    case "extract-tasks":
      return "usage: ax-eval extract-tasks --suite <suite.yaml> --vendors <slug,...> [generator flags]";
    case "compose-pack":
      return "usage: ax-eval compose-pack --suite <suite.yaml> --config <config.yaml> --vendors <slug,...>";
    case "plan-low-pass":
      return [
        "usage: ax-eval plan-low-pass --pack <pack.yaml> --suite <suite.yaml>",
        `                             [--surface api|cli|sdk|mcp|all] [--harness ${INVOKE_HARNESS_LIST}]...`,
        "  Validates the compiled pack against the canonical suite and prints a",
        "  low-profile, one-trial task execution plan. Does not invoke or reset.",
      ].join("\n");
    case "audit-benchmark":
      return [
        "usage: ax-eval audit-benchmark --benchmark <slug> --benchmark-version <version>",
        "                               [--benchmark-root <dir>] [--pack-config <slug>=<yaml>]...",
        "                               [--reset-verified <slug>]...",
        "  Reads benchmark authoring artifacts and prints a sectioned JSON audit.",
        "  Never writes, repairs, approves, invokes, verifies, or resets artifacts.",
      ].join("\n");
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
  packProvided: boolean;
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
  /** Startup cap in seconds for reaching the first structured action. */
  firstActionTimeout: number;
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
  smokeOnly: boolean;
  ns: string;
  attempts: number;
  minPassRate: number | undefined;
  trace: string;
  /** Raw `--surface` value: a concrete id (api/cli/sdk/mcp) or `all`. exec-plan
   *  fans out across the resolved selection; verify uses the concrete id (if any)
   *  to override the per-result self-report when tagging. */
  surface?: string;
  company: string;
  approveBy: string;
  vendors: string;
  category: string;
  suite: string;
  suiteName: string;
  config: string;
  targetTasks: number;
  suiteVersion: number;
  benchmarkRoot: string;
  benchmark: string;
  benchmarkVersion: string;
  packConfigs: string[];
  resetVerified: string[];
  capabilitySpecs: string[];
  specMaxOperations: number;
  surfaceSeeds: string[];
  _: string[];
}

function parseArgs(argv: string[]): Parsed {
  const p: Parsed = {
    pack: DEFAULT_PACK,
    packProvided: false,
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
    firstActionTimeout: 120,
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
    smokeOnly: false,
    ns: "",
    attempts: 1,
    minPassRate: undefined,
    trace: "",
    company: "",
    approveBy: "",
    vendors: "",
    category: "",
    suite: "",
    suiteName: "",
    config: "",
    targetTasks: 12,
    suiteVersion: 1,
    benchmarkRoot: "",
    benchmark: "",
    benchmarkVersion: "",
    packConfigs: [],
    resetVerified: [],
    capabilitySpecs: [],
    specMaxOperations: 150,
    surfaceSeeds: [],
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
    if (a === "--pack") {
      p.pack = value(++i, "--pack");
      p.packProvided = true;
    }
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
    else if (a === "--first-action-timeout") {
      const n = Number(value(++i, "--first-action-timeout"));
      if (!Number.isInteger(n) || n < 0) throw new Error(`--first-action-timeout must be a non-negative integer (seconds; got ${n})`);
      p.firstActionTimeout = n;
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
    else if (a === "--smoke-only") p.smokeOnly = true;
    else if (a === "--company") p.company = value(++i, "--company");
    else if (a === "--vendors" || a === "--vendor") p.vendors = value(++i, a);
    else if (a === "--category") p.category = value(++i, "--category");
    else if (a === "--suite") p.suite = value(++i, "--suite");
    else if (a === "--suite-name") p.suiteName = value(++i, "--suite-name");
    else if (a === "--config") p.config = value(++i, "--config");
    else if (a === "--target-tasks") {
      const n = Number(value(++i, "--target-tasks"));
      if (!Number.isInteger(n) || n < 1) throw new Error(`--target-tasks must be a positive integer (got ${n})`);
      p.targetTasks = n;
    }
    else if (a === "--suite-version") {
      const n = Number(value(++i, "--suite-version"));
      if (!Number.isInteger(n) || n < 1) throw new Error(`--suite-version must be a positive integer (got ${n})`);
      p.suiteVersion = n;
    }
    else if (a === "--benchmark-root") p.benchmarkRoot = value(++i, "--benchmark-root");
    else if (a === "--benchmark") p.benchmark = value(++i, "--benchmark");
    else if (a === "--benchmark-version") p.benchmarkVersion = value(++i, "--benchmark-version");
    else if (a === "--pack-config") p.packConfigs.push(value(++i, "--pack-config"));
    else if (a === "--reset-verified") p.resetVerified.push(value(++i, "--reset-verified"));
    else if (a === "--capability-spec") p.capabilitySpecs.push(value(++i, "--capability-spec"));
    else if (a === "--surface-seed") p.surfaceSeeds.push(value(++i, "--surface-seed"));
    else if (a === "--spec-max-operations") {
      const n = Number(value(++i, "--spec-max-operations"));
      if (!Number.isInteger(n) || n < 1) throw new Error(`--spec-max-operations must be a positive integer (got ${n})`);
      p.specMaxOperations = n;
    }
    else if (a === "--approve-by") p.approveBy = value(++i, "--approve-by");
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
  const generatorHarnessTimeoutRaw = process.env.AX_EVAL_GENERATOR_TIMEOUT_MS?.trim();
  const generatorTimeoutMs =
    generatorHarnessTimeoutRaw && Number.isFinite(Number(generatorHarnessTimeoutRaw)) && Number(generatorHarnessTimeoutRaw) > 0
      ? Number(generatorHarnessTimeoutRaw)
      : 120_000;

  if (looksLikeGraphqlIngest(spec)) {
    const preset = resolveGraphqlGeneratePreset(product);
    const presetOptions = preset?.options;
    const graphqlOpts: GenerateGraphqlPackOptions = {
      ...(presetOptions ?? {}),
      ...generatePolicy,
      runId: args.runId || undefined,
      packName: `${slugify(product)}-generated`,
      product,
      baseUrl: args.baseUrl || presetOptions?.baseUrl || undefined,
      siteUrl: args.site || presetOptions?.siteUrl || "",
      ...(docsUrls ? { docsUrls } : presetOptions?.docsUrls ? { docsUrls: presetOptions.docsUrls } : {}),
    };
    const generated = generateGraphqlPack(spec, {
      ...graphqlOpts,
    });
    const provenance = generatorProvenance(args, graphqlOpts.docsUrls ?? docsUrls, (spec as { source?: unknown }).source);
    const pack: TargetPack = args.deterministic
      ? generated
      : authorPackWithLlm({
          product,
          spec,
          seed: generated,
          provenance,
          harness: {
            harness: provenance.harness,
            model: args.generatorModel || undefined,
            effort: provenance.effort,
            timeoutMs: generatorTimeoutMs,
          },
          authoringHints: preset?.authoringHints,
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

  // Generic options derived entirely from the spec + flags. Auth, sandbox_scope
  // and headers are derived inside generatePack from the ingested securityScheme
  // and resource graph — no per-product hardcoding.
  const preset = resolveOpenApiGeneratePreset(product);
  const presetOptions = preset?.options;
  const presetAllowsFull = preset?.allowFullPreset ?? true;
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

  const opts: GenerateOptions = presetOptions
    ? {
        ...presetOptions,
        ...baseOpts,
        ...(presetOptions.packName ? { packName: presetOptions.packName } : {}),
        ...(args.limit === 3 && presetOptions.limit !== undefined ? { limit: presetOptions.limit } : {}),
        ...(args.l2Limit === undefined && presetOptions.l2Limit !== undefined ? { l2Limit: presetOptions.l2Limit } : {}),
        ...(args.l3Limit === undefined && presetOptions.l3Limit !== undefined ? { l3Limit: presetOptions.l3Limit } : {}),
        ...(args.l4Limit === undefined && presetOptions.l4Limit !== undefined ? { l4Limit: presetOptions.l4Limit } : {}),
        ...(baseOpts.targetTaskCount === undefined && presetOptions.targetTaskCount !== undefined ? { targetTaskCount: presetOptions.targetTaskCount } : {}),
        ...(args.site ? { siteUrl: args.site } : { siteUrl: presetOptions.siteUrl }),
        ...(docsUrls ? { docsUrls } : { docsUrls: presetOptions.docsUrls }),
      }
    : baseOpts;

  const provenanceDocs = opts.docsUrls ?? docsUrls;
  const provenance = generatorProvenance(args, provenanceDocs, spec.source);
  const seed = generatePack(
    spec,
    args.deterministic ? opts : { ...opts, generatedBy: "llm-assisted", generator: provenance },
  );
  const pack = args.deterministic
    ? seed
    : authorPackWithLlm({
        product,
        spec,
        seed,
        provenance,
        harness: {
          harness: provenance.harness,
          model: args.generatorModel || undefined,
          effort: provenance.effort,
          timeoutMs: generatorTimeoutMs,
        },
        authoringHints: preset?.authoringHints,
      });
  const yaml = packToYaml(pack);
  // Default output: committed example packs live under targets/examples/, but
  // locally generated packs still default to targets/<product>/ so a user can
  // iterate on their own target without overwriting the shipped examples.
  const defaultOut = preset?.defaultOut ?? `results/${slugify(product)}.generated.pack.yaml`;
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
  if (!preset?.skipReviewReminder) {
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
                firstActionTimeoutMs: args.firstActionTimeout > 0 ? args.firstActionTimeout * 1000 : undefined,
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
  const client = new BearerClient(buildVerificationClientOptions(pack));
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
    const tracePath = rPath.replace(/\.json$/, ".trace.json");
    let trace = loadTrace(tracePath);
    const outcomes = await verifyGeneratedPack(pack, executor, client, surface, trace);
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
    const invokeMetaPath = rPath.replace(/\.json$/, ".invoke.json");
    let efficiency: ProfileRun["efficiency"];
    if (existsSync(invokeMetaPath)) {
      try {
        const meta = JSON.parse(readFileSync(invokeMetaPath, "utf8")) as Partial<InvokeRunResult>;
        efficiency = invokeEfficiency(meta);
      } catch (error) {
        warnings.push(`Failed to parse invoke metadata ${rel(invokeMetaPath)} (${error instanceof Error ? error.message : String(error)}).`);
      }
    }
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
      efficiency,
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
 * per-target resetter lists + deletes. Destructive resets require `--ns`;
 * `--dry-run` may omit it to inventory every probe resource. Targets without a
 * resetter degrade gracefully (no throw).
 */
async function cmdReset(args: Parsed): Promise<number> {
  loadDotenv();
  if (!args.pack) throw new Error("usage: ax-eval reset --pack <yaml> [--ns <token>] [--dry-run]");
  const pack = loadPack(args.pack);
  const client = new BearerClient(buildVerificationClientOptions(pack));
  const scope = resolveScope(pack);
  const result = await resetPack(pack, client, scope, { ns: args.ns || undefined, dryRun: args.dryRun });
  console.log(result.message);
  for (const id of result.deleted) console.log(`  ${args.dryRun ? "would delete" : "deleted"} ${id}`);
  for (const e of result.errors) console.error(`  ! ${e}`);
  if (!result.supported) return 0;
  return result.errors.length ? 1 : 0;
}

function selectedVendors(args: Parsed): string[] {
  const vendors = args.vendors.split(",").map((value) => value.trim()).filter(Boolean);
  if (vendors.length === 0) throw new Error("--vendors <name-or-slug,...> is required");
  if (new Set(vendors).size !== vendors.length) throw new Error("--vendors contains duplicate entries");
  return vendors;
}

function authoringGenerator(
  args: Parsed,
  timeoutMs?: number,
): { generate: (prompt: string) => Promise<string>; harness: string } {
  const detected = probeHarness().host;
  const harness = args.generatorHarness || (detected === "codex" || detected === "claude-code" ? detected : "codex");
  return {
    harness,
    generate: async (prompt: string) => runGeneratorHarness(prompt, {
      harness,
      model: args.generatorModel || undefined,
      effort: args.generatorEffort as "low" | "medium" | "high",
      timeoutMs,
    }),
  };
}

function requiredVendorCard(root: string, slug: string) {
  const vendor = loadVendorCard(root, slug);
  if (!vendor) throw new Error(`missing vendor card for ${slug}; run resolve-vendor first`);
  return vendor;
}

async function cmdResolveVendor(args: Parsed): Promise<number> {
  if (!args.category) throw new Error("--category is required");
  const names = selectedVendors(args);
  const root = process.cwd();
  const generator = authoringGenerator(args);
  const results = await resolveVendors(names, args.category, {
    generate: generator.generate,
    harness: generator.harness,
    model: args.generatorModel || undefined,
  });
  for (const result of results) console.log(`${result.vendor} → ${writeVendorCard(root, result)}`);
  return 0;
}

async function cmdMapRegistrySeed(args: Parsed): Promise<number> {
  if (!args.from) throw new Error("map-registry-seed requires --from <registry.json|yaml>");
  const slugs = selectedVendors(args);
  if (slugs.length !== 1) throw new Error("map-registry-seed requires exactly one --vendor <slug>");
  if (statSync(args.from).size > MAX_REGISTRY_SOURCE_BYTES) {
    throw new Error(`registry surface document exceeds ${MAX_REGISTRY_SOURCE_BYTES} bytes`);
  }
  const seed = mapRegistryAuthoringSeedText(readFileSync(args.from, "utf8"));
  const path = writeRegistryAuthoringSeed(process.cwd(), slugs[0]!, seed);
  console.log(`Registry seed → ${path}`);
  console.log(`Review it, then run extract-surfaces --vendors ${slugs[0]} --surface-seed ${slugs[0]}=${path}`);
  return 0;
}

async function cmdExtractCapabilities(args: Parsed): Promise<number> {
  const root = process.cwd();
  const slugs = selectedVendors(args);
  const specSources = parseCapabilitySpecMappings(args.capabilitySpecs, slugs);
  const vendors = slugs.map((slug) => requiredVendorCard(root, slug));
  const generator = authoringGenerator(args, CAPABILITY_EXTRACTION_TIMEOUT_MS);
  const concurrency = Math.min(args.concurrency, 3);
  console.log(
    `Extracting capabilities for ${vendors.length} vendor(s) at concurrency=${concurrency} ` +
    `(${specSources.size} spec-seeded, ${vendors.length - specSources.size} grounded)`,
  );
  const settled = await extractCapabilitiesBatch(vendors, {
    specSources,
    maxSpecOperations: args.specMaxOperations,
    concurrency,
    offline: args.offline,
    generate: generator.generate,
    extractor: generator.harness,
  });
  let failures = 0;
  for (let index = 0; index < settled.length; index++) {
    const outcome = settled[index]!;
    const vendor = vendors[index]!;
    if (outcome.status === "rejected") {
      failures += 1;
      console.error(`${vendor.vendor} → FAILED: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
      continue;
    }
    const path = writeCapabilityExtract(root, outcome.value.extract);
    console.log(`${vendor.vendor} → ${path}${outcome.value.specSource ? ` (spec ${outcome.value.specSource})` : ""}`);
  }
  return failures ? 1 : 0;
}

async function cmdExtractSurfaces(args: Parsed): Promise<number> {
  const root = process.cwd();
  const slugs = selectedVendors(args);
  const seedPaths = parseSelectedMappings(args.surfaceSeeds, slugs, "--surface-seed");
  const generator = authoringGenerator(args);
  for (const slug of slugs) {
    const vendor = requiredVendorCard(root, slug);
    const seedPath = seedPaths.get(slug);
    const registrySeed = seedPath ? loadRegistryAuthoringSeedPath(seedPath) : undefined;
    if (seedPath && !registrySeed) throw new Error(`surface seed for ${slug} does not exist`);
    const result = await extractSurfaces(vendor, { generate: generator.generate, registrySeed: registrySeed ?? undefined });
    console.log(`${vendor.vendor} → ${writeSurfaceExtract(root, result)}`);
  }
  return 0;
}

async function cmdSynthesizeSuite(args: Parsed): Promise<number> {
  if (!args.suiteName) throw new Error("--suite-name is required");
  if (!args.category) throw new Error("--category is required");
  const root = process.cwd();
  const extracts = selectedVendors(args).map((slug) => {
    const extract = loadCapabilityExtract(root, slug);
    if (!extract) throw new Error(`missing capability extract for ${slug}; run extract-capabilities first`);
    return extract;
  });
  if (extracts.length < 2) throw new Error("synthesize-suite requires at least two vendor capability extracts");
  const generator = authoringGenerator(args);
  const methodology = defaultSuiteMethodology(args.category, args.targetTasks);
  const universe = await deriveConceptUniverse(args.category, extracts, methodology, { generate: generator.generate });
  const selection = selectCoverageConcepts(universe, methodology);
  const matrix = buildCoverageMatrix(universe);
  writeConceptUniverse(root, args.suiteName, universe);
  writeCoverageSelection(root, args.suiteName, selection);
  writeCoverageMatrix(root, args.suiteName, matrix);
  const suite = await synthesizeSuite(
    args.suiteName,
    args.suiteVersion,
    args.category,
    universe,
    selection,
    methodology,
    { generate: generator.generate },
  );
  console.log(`Suite → ${writeSynthesizedSuite(root, suite)}`);
  return 0;
}

async function cmdExtractTasks(args: Parsed): Promise<number> {
  if (!args.suite) throw new Error("--suite <suite.yaml> is required");
  const root = process.cwd();
  const suite = loadSuite(args.suite);
  const generator = authoringGenerator(args);
  for (const slug of selectedVendors(args)) {
    const vendor = requiredVendorCard(root, slug);
    const capabilities = loadCapabilityExtract(root, slug);
    const surfaces = loadSurfaceExtract(root, slug);
    if (!capabilities) throw new Error(`missing capability extract for ${slug}`);
    if (!surfaces) throw new Error(`missing surface extract for ${slug}`);
    const result = await extractTasks(vendor, suite, capabilities, surfaces, {
      generate: generator.generate,
      extractor: generator.harness,
    });
    console.log(`${vendor.vendor} → ${writeTaskExtract(root, result)}`);
  }
  return 0;
}

async function cmdComposePack(args: Parsed): Promise<number> {
  if (!args.suite) throw new Error("--suite <suite.yaml> is required");
  if (!args.config) throw new Error("--config <config.yaml> is required");
  const [slug, ...extra] = selectedVendors(args);
  if (extra.length > 0) throw new Error("compose-pack accepts exactly one vendor because configuration is vendor-specific");
  const root = process.cwd();
  const suite = loadSuite(args.suite);
  const vendor = requiredVendorCard(root, slug!);
  const surfaces = loadSurfaceExtract(root, slug!);
  const tasks = loadTaskExtract(root, slug!, suite.name);
  if (!surfaces) throw new Error(`missing surface extract for ${slug}`);
  if (!tasks) throw new Error(`missing task extract for ${slug} and suite ${suite.name}`);
  const config = parsePackComposeConfig(yamlParse(readFileSync(args.config, "utf8")));
  const pack = composePack(vendor, suite, surfaces, tasks, config, {
    generatedBy: `suite-compose@${tasks.extractor}`,
  });
  const path = writeComposedPack(root, pack, suite.name);
  console.log(`Pack → ${path}`);
  console.log(`Next: ax-eval review --pack ${path}; execution remains blocked until manually approved.`);
  return 0;
}

function cmdPlanLowPass(args: Parsed): number {
  if (!args.packProvided) throw new Error("--pack <pack.yaml> is required");
  if (!args.suite) throw new Error("--suite <suite.yaml> is required");
  if (args.invoke) throw new Error("plan-low-pass does not support --invoke; it only prints a plan");
  if (args.profile.length > 0 || args.effort) {
    throw new Error("plan-low-pass uses the fixed low profile; --profile and --effort are not supported");
  }
  const pack = loadPack(args.pack);
  const suite = loadSuite(args.suite);
  const validationErrors = validatePackAgainstSuite(
    pack.tasks.map((task) => ({ id: task.id, title: task.title, difficulty: task.difficulty })),
    suite,
  );
  if (validationErrors.length > 0) {
    throw new Error(`pack does not match canonical suite: ${validationErrors.join("; ")}`);
  }
  const surfaces: SurfaceId[] = args.surface === "all"
    ? [...(suite.methodology?.surface_scope ?? SURFACE_IDS)]
    : args.surface
      ? [args.surface as SurfaceId]
      : [...(suite.methodology?.surface_scope ?? SURFACE_IDS)];
  const plan = buildLowPassExecutionPlan({
    suiteName: suite.name,
    standardSetVersion: pack.standard_set_version,
    vendor: pack.name.replace(/-generated$/, ""),
    pack,
    surfaces,
    harnesses: args.harness.length > 0 ? args.harness : ["codex", "claude-code"],
  });
  console.log(JSON.stringify(plan, null, 2));
  return 0;
}

function loadBenchmarkPackConfigs(assignments: readonly string[]): ReadonlyMap<string, unknown> {
  const paths = new Map<string, string>();
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    if (separator <= 0 || separator === assignment.length - 1) {
      throw new Error("--pack-config expects <slug>=<yaml>");
    }
    const slug = assignment.slice(0, separator);
    const path = assignment.slice(separator + 1);
    if (paths.has(slug)) throw new Error(`duplicate --pack-config for ${slug}`);
    paths.set(slug, path);
  }
  return new Map([...paths].map(([slug, path]) => [slug, yamlParse(readFileSync(path, "utf8"))]));
}

function cmdAuditBenchmark(args: Parsed): number {
  if (!args.benchmark) throw new Error("--benchmark <slug> is required");
  if (!args.benchmarkVersion) throw new Error("--benchmark-version <version> is required");
  const layout = buildBenchmarkLayout(
    args.benchmarkRoot || process.cwd(),
    args.benchmark,
    args.benchmarkVersion,
  );
  const report = auditBenchmarkAuthoring(layout, {
    resetVerified: new Set(args.resetVerified),
    packConfigs: loadBenchmarkPackConfigs(args.packConfigs),
  });
  console.log(JSON.stringify(report, null, 2));
  return report.summary.errors > 0 ? 1 : 0;
}

function cloneArgs(args: Parsed, overrides: Partial<Parsed>): Parsed {
  return {
    ...args,
    ...overrides,
    harness: [...(overrides.harness ?? args.harness)],
    profile: [...(overrides.profile ?? args.profile)],
    results: [...(overrides.results ?? args.results)],
    packConfigs: [...(overrides.packConfigs ?? args.packConfigs)],
    resetVerified: [...(overrides.resetVerified ?? args.resetVerified)],
    observe: { ...(overrides.observe ?? args.observe) },
    _: [...(overrides._ ?? args._)],
  };
}

function jsonRunResults(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^run-.*\.json$/.test(f) && !/(\.trace|\.normalized)\.json$/.test(f))
    .map((f) => resolve(dir, f))
    .sort();
}

async function verifyAutomationResults(args: Parsed, dir: string, packPath: string, html: string): Promise<number> {
  const forced = process.env.AX_EVAL_AUTOMATION_VERIFY_FIXTURE;
  if (forced === "pass") {
    mkdirSync(dirname(html), { recursive: true });
    writeFileSync(html, "<!doctype html><title>AX eval automation fixture pass</title>");
    console.log(`Verification fixture passed → ${html}`);
    return 0;
  }
  if (forced === "fail") {
    console.error("Verification fixture failed.");
    return 1;
  }
  const results = jsonRunResults(dir);
  if (!results.length) {
    console.error(`No run result files found in ${dir}; cannot verify.`);
    return 1;
  }
  return cmdVerifyGenerated(cloneArgs(args, {
    pack: packPath,
    results,
    html,
    runDir: dir,
    minPassRate: 0.8,
    surface: undefined,
  }));
}

function fullProfiles(effort: string): string[] {
  if (effort === "low") return ["low"];
  if (effort === "medium") return ["low", "medium"];
  return ["low", "high"];
}

function approvalByLabel(name: string): string {
  return name.trim() ? JSON.stringify(name) : "<name>";
}

function reviewCommand(packPath: string, approvedBy: string): string {
  return `ax-eval review --pack ${packPath} --approve --by ${approvalByLabel(approvedBy)}`;
}

function inspectReviewCommand(packPath: string): string {
  return `ax-eval review --pack ${packPath}`;
}

function resumeAutomationCommand(
  company: string,
  discovery: AutomationManifest["discovery"],
  runDir: string,
  approvedBy: string,
): string {
  const sourceFlag = `--${discovery.graphql_url ? "graphql" : "openapi"} ${discovery.graphql_url ?? discovery.openapi_url}`;
  const reviewer = approvedBy.trim() ? ` --approve-by "${approvedBy}"` : "";
  return `ax-eval automate-report --company "${company}" ${sourceFlag} --run-dir ${runDir}${reviewer}`;
}

async function cmdAutomateReport(args: Parsed): Promise<number> {
  loadDotenv();
  if (!args.company.trim()) {
    throw new Error("usage: ax-eval automate-report --company <name>");
  }
  const company = args.company.trim();
  const slug = slugifyAutomationName(company);
  const runDir = args.runDir && args.runDir !== "results" ? args.runDir : defaultAutomationRunDir(company);
  const harnesses = args.harness.length ? args.harness : ["codex"];
  for (const h of harnesses) {
    if (!isInvokeHarnessId(h)) {
      throw new Error(`--harness for automate-report must be one of ${INVOKE_HARNESS_LIST} (got ${h})`);
    }
  }
  mkdirSync(runDir, { recursive: true });
  if (args.approveBy) {
    console.log(`Note: --approve-by only seeds the suggested manual review command. Generated packs still require explicit review approval.`);
  }

  const manifestPath = resolve(runDir, "automation-manifest.json");
  const sharePath = resolve(runDir, "share-summary.md");
  const artifacts: Record<string, string> = {
    manifest: manifestPath,
    share_summary: sharePath,
  };
  const nextSteps: string[] = [];

  console.log(`Automating report for ${company} → ${runDir}`);
  const discovery = await discoverAutomationTarget({
    company,
    site: args.site || undefined,
    docs: args.docs ? args.docs.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    openapi: args.openapi || undefined,
    graphql: args.graphql || undefined,
    harness: harnesses[0]!,
    offline: args.offline,
  }, { timeoutMs: 8000 });

  const manifest: AutomationManifest = {
    schema: "ax.automation-manifest/v1",
    company,
    slug,
    run_dir: runDir,
    generated_at: automationGeneratedAt(),
    discovery,
    artifacts,
    next_steps: nextSteps,
  };
  writeAutomationManifest(manifestPath, manifest);

  if (!discovery.openapi_url && !discovery.graphql_url) {
    nextSteps.push("Provide an official --openapi URL or --graphql endpoint/file, or pass --site/--docs so automation can validate candidates.");
    writeAutomationManifest(manifestPath, manifest);
    writeShareSummary(sharePath, manifest);
    console.error(
      `Could not find a trustworthy official OpenAPI or GraphQL spec for ${company}. ` +
        "No third-party search API was used. Re-run with --openapi <url> or --graphql <endpoint|file>.",
    );
    return 1;
  }

  const ingestPath = resolve(runDir, discovery.graphql_url ? "ingest-graphql.json" : "ingest.json");
  const packPath = resolve(runDir, `${slug}.generated.full.pack.yaml`);
  const smokePackPath = resolve(runDir, `${slug}.generated.smoke.pack.yaml`);
  artifacts.ingest = ingestPath;
  artifacts.pack = packPath;
  artifacts.smoke_pack = smokePackPath;

  if (discovery.graphql_url) {
    const g = await ingestGraphqlDetailed(discovery.graphql_url, { offline: args.offline });
    writeFileSync(ingestPath, JSON.stringify(g, null, 2));
    console.log(`Ingested GraphQL schema → ${ingestPath}`);
  } else {
    const spec = await ingestFromUrl(discovery.openapi_url!, { offline: args.offline });
    writeFileSync(ingestPath, JSON.stringify(spec, null, 2));
    console.log(`Ingested OpenAPI spec → ${ingestPath}`);
  }

  const generateArgs = cloneArgs(args, {
    from: ingestPath,
    out: packPath,
    product: company,
    site: discovery.site_url ?? args.site,
    docs: discovery.docs_urls.join(","),
    baseUrl: discovery.graphql_url ?? args.baseUrl,
    runDir,
  });
  let generateCode: number;
  try {
    generateCode = await cmdGenerate(generateArgs);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    manifest.discovery.warnings.push(`LLM-assisted generation failed; falling back to deterministic generation (${detail}).`);
    console.error(`LLM-assisted generate failed; falling back to deterministic generation: ${detail}`);
    generateCode = await cmdGenerate(cloneArgs(generateArgs, { deterministic: true }));
  }
  if (generateCode !== 0) return generateCode;

  const pack = loadPack(packPath);
  const reviewPath = resolve(runDir, "review.txt");
  const checklistPath = resolve(runDir, "configuration-checklist.md");
  artifacts.review = reviewPath;
  artifacts.configuration_checklist = checklistPath;
  writeFileSync(reviewPath, reviewSummary(pack));
  const checklist = buildEnvChecklist(pack, args.surface ?? "api");
  writeFileSync(checklistPath, checklist);
  console.log(`Review summary → ${reviewPath}`);
  console.log(`Configuration checklist → ${checklistPath}`);

  const smokeSelection = selectSmokeTasks(pack);
  const smokePack: TargetPack = {
    ...pack,
    name: `${pack.name}-smoke`,
    tasks: smokeSelection.tasks,
  };
  writeFileSync(smokePackPath, packToYaml(smokePack));
  console.log(
    `Smoke pack → ${smokePackPath} (${smokePack.tasks.length}/${pack.tasks.length} tasks selected: ${smokePack.tasks.map((t) => t.id).join(", ")})`,
  );

  const approval = checkApproval(pack, packPath);
  if (!approval.ok) {
    nextSteps.push(`Review the generated pack: ${inspectReviewCommand(packPath)}`);
    nextSteps.push(`Approve it after review: ${reviewCommand(packPath, args.approveBy)}`);
    nextSteps.push(`Resume: ${resumeAutomationCommand(company, discovery, runDir, args.approveBy)}`);
    writeAutomationManifest(manifestPath, manifest);
    writeShareSummary(sharePath, manifest);
    console.error(`Stopping before live execution: ${approval.reason}.`);
    return 1;
  }

  const smokeApproval = checkApproval(smokePack, smokePackPath);
  if (!smokeApproval.ok) {
    nextSteps.push(`Review the derived smoke pack: ${inspectReviewCommand(smokePackPath)}`);
    nextSteps.push(`Approve it after review: ${reviewCommand(smokePackPath, args.approveBy)}`);
    nextSteps.push(`Resume: ${resumeAutomationCommand(company, discovery, runDir, args.approveBy)}`);
    writeAutomationManifest(manifestPath, manifest);
    writeShareSummary(sharePath, manifest);
    console.error(`Stopping before smoke execution: ${smokeApproval.reason}.`);
    return 1;
  }

  if (hasMissingRequiredConfig(pack, args.surface ?? "api")) {
    nextSteps.push(`Fill the missing values in ${checklistPath}.`);
    nextSteps.push(`Verify configuration: ax-eval check-env --pack ${packPath} --surface ${args.surface ?? "api"}`);
    nextSteps.push(`Resume: ${resumeAutomationCommand(company, discovery, runDir, args.approveBy)}`);
    writeAutomationManifest(manifestPath, manifest);
    writeShareSummary(sharePath, manifest);
    console.error(`Stopping before live execution: missing required auth or sandbox configuration.\n${checklist}`);
    return 1;
  }

  const smokeDir = resolve(runDir, "smoke");
  artifacts.smoke_dir = smokeDir;
  console.log("Running smoke gate: API surface, low effort, one attempt.");
  const smokeExec = await cmdExecPlan(cloneArgs(args, {
    pack: smokePackPath,
    invoke: true,
    harness: [harnesses[0]!],
    profile: ["low"],
    effort: "low",
    surface: "api",
    runDir: smokeDir,
    attempts: 1,
  }));
  if (smokeExec !== 0) return smokeExec;
  const smokeHtml = resolve(smokeDir, "generated-eval.html");
  artifacts.smoke_report = smokeHtml;
  const smokeVerify = await verifyAutomationResults(args, smokeDir, smokePackPath, smokeHtml);
  if (smokeVerify !== 0) {
    nextSteps.push(`Inspect smoke artifacts in ${smokeDir}; full matrix was not run because the smoke gate failed.`);
    writeAutomationManifest(manifestPath, manifest);
    writeShareSummary(sharePath, manifest, smokeHtml);
    return smokeVerify;
  }

  if (args.smokeOnly) {
    nextSteps.push(`Smoke passed. Re-run without --smoke-only to produce the full requested report.`);
    writeAutomationManifest(manifestPath, manifest);
    writeShareSummary(sharePath, manifest, smokeHtml);
    console.log(`Smoke-only automation complete → ${smokeHtml}`);
    return 0;
  }

  const fullDir = resolve(runDir, "full");
  const fullSurface = args.surface ?? "api";
  const fullEffort = args.effort || "high";
  const profiles = fullProfiles(fullEffort);
  artifacts.full_dir = fullDir;
  console.log(
    `Smoke passed. Running full report: surface=${fullSurface}, profiles=${profiles.join(",")}, harness=${harnesses.join(",")}.`,
  );
  const fullExec = await cmdExecPlan(cloneArgs(args, {
    pack: packPath,
    invoke: true,
    harness: harnesses as InvokeHarnessId[],
    profile: profiles,
    effort: fullEffort,
    surface: fullSurface,
    runDir: fullDir,
    attempts: 1,
  }));
  if (fullExec !== 0) return fullExec;
  const fullHtml = resolve(fullDir, "generated-eval.html");
  artifacts.final_report = fullHtml;
  const fullVerify = await verifyAutomationResults(args, fullDir, packPath, fullHtml);
  nextSteps.push(fullVerify === 0 ? `Share ${fullHtml} or ${sharePath}.` : `Inspect failed full-run artifacts in ${fullDir}.`);
  writeAutomationManifest(manifestPath, manifest);
  writeShareSummary(sharePath, manifest, fullHtml);
  return fullVerify;
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
    case "automate-report":
      return cmdAutomateReport(args);
    case "resolve-vendor":
      return cmdResolveVendor(args);
    case "map-registry-seed":
      return cmdMapRegistrySeed(args);
    case "extract-capabilities":
      return cmdExtractCapabilities(args);
    case "extract-surfaces":
      return cmdExtractSurfaces(args);
    case "synthesize-suite":
      return cmdSynthesizeSuite(args);
    case "extract-tasks":
      return cmdExtractTasks(args);
    case "compose-pack":
      return cmdComposePack(args);
    case "plan-low-pass":
      return cmdPlanLowPass(args);
    case "audit-benchmark":
      return cmdAuditBenchmark(args);
    default:
      console.error(USAGE);
      return 2;
  }
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
