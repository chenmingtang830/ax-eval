import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import {
  extractCapabilities,
  extractSurfaces,
  fetchRegistrySurface,
  fetchSpecSummary,
  loadDotenv,
  loadPack,
  loadSuite,
  probeHarness,
  registryOpenApiUrl,
  registryToSurfaceExtract,
  registryToVendorCard,
  resolveVendors,
  type OracleSpec,
  type ResolveResult,
  type TargetPack,
} from "ax-eval";
import { extractOraclesAll } from "./oracle-extract.js";
import {
  assertCanonicalAxArenaDatabaseSuiteWritePath,
  createAxArenaDatabasePathContext,
  axArenaDatabaseReadVendorsDir,
  type AxArenaDatabasePathContext,
} from "./benchmark-paths.js";
import {
  loadCapabilityExtract,
  loadOracleExtract,
  loadSupportMatrix,
  loadSurfaceExtract,
  loadVendorCard,
  writeCapabilityExtract,
  writeOracleExtract,
  writeSurfaceExtract,
  writeVendorCard,
} from "./artifact-persistence.js";
import type { CoverageMatrix, SupportMatrix } from "./artifact-contracts.js";
import { composePack, writeComposedPack } from "./compose-pack.js";
import { adviseVendorExtract, writeExtractAdvisory } from "./extract-advisory.js";
import {
  applyExtractAudit,
  auditAllExtracts,
  formatExtractAuditReport,
} from "./extract-audit.js";
import {
  applySuiteAudit,
  auditSuite,
  formatSuiteAuditReport,
} from "./suite-audit.js";
import {
  inferSuiteVersionFromStem,
  renderSuiteYaml,
  renderSynthesisDoc,
  synthesizeSuite,
  writeSuiteBundle,
} from "./synthesize-suite.js";
import { coreVendorSlugs } from "./vendor-selection.js";
import { DATABASE_CAPABILITY_COVERAGE_REQUIREMENTS } from "./database-policy.js";
import {
  buildV2SupportMatrix,
  buildV2WitnessPlan,
  validateV2WitnessPlan,
} from "./database-v2-witness.js";
import { runV2Witness } from "./database-v2-runner.js";
import {
  DEFAULT_V21_SELECTION_POLICY,
  readCalibrationJsonl,
  selectV21Tasks,
  validateV21FreezeSelection,
  V21SelectionResultSchema,
  V21TaskSchema,
  freezeV21Suite,
} from "./discriminative-suite.js";
import { validateV21InvocationPlan } from "../runtime/v21-execution.js";
import { buildV21ControllerPlan, controllerPlanHash } from "../runtime/v21-controller.js";
import { planV21CalibrationInvocations } from "../runtime/v21-calibration.js";
import { V21_ROUTE_MANIFEST } from "../runtime/v21-routes.js";

export const AUTHORING_COMMANDS = [
  "resolve-vendor",
  "import-registry",
  "extract-tasks",
  "compose-pack",
  "extract-surfaces",
  "extract-capabilities",
  "audit-extracts",
  "audit-suite",
  "synthesize-suite",
  "calibrate-suite",
  "freeze-suite",
  "plan-v21",
  "plan-v21-calibration",
  "prepare-v21-packs",
  "prepare-v2",
  "prepare-v2-production",
  "run-v2-witness",
] as const;

export type AuthoringCommand = (typeof AUTHORING_COMMANDS)[number];

const AUTHORING_COMMAND_SET = new Set<string>(AUTHORING_COMMANDS);

export function isAuthoringCommand(value: string | undefined): value is AuthoringCommand {
  return value !== undefined && AUTHORING_COMMAND_SET.has(value);
}

interface AuthoringArgs {
  benchmarkRoot: string;
  vendor: string;
  vendors: string;
  category: string;
  domain: string;
  slug: string;
  specs: string;
  suite: string;
  out: string;
  generatorHarness: string;
  generatorModel: string;
  generatorEffort: string;
  deterministic: boolean;
  cliOnly: boolean;
  runRoot: string;
  tasks: string[];
  gapCheckAssist: boolean;
  taskCount?: number;
  candidateCount?: number;
  targetCount?: number;
  difficultyProfile: string;
  anchors: string;
  results: string;
  freezeGates: string;
  apply: boolean;
  advisory: boolean;
  production: boolean;
  /** Accepted for compatibility with the historical help text. */
  harnesses: string[];
  /** Accepted for compatibility; generator effort uses --generator-effort. */
  effort: string;
  rest: string[];
}

function parseAuthoringArgs(argv: readonly string[]): AuthoringArgs {
  const parsed: AuthoringArgs = {
    benchmarkRoot: "",
    vendor: "",
    vendors: "",
    category: "",
    domain: "",
    slug: "",
    specs: "",
    suite: "",
    out: "results/last-run.json",
    generatorHarness: "",
    generatorModel: "",
    generatorEffort: "",
    deterministic: false,
    cliOnly: true,
    runRoot: "",
    tasks: [],
    gapCheckAssist: false,
    difficultyProfile: "",
    anchors: "",
    results: "",
    freezeGates: "",
    apply: false,
    advisory: false,
    production: false,
    harnesses: [],
    effort: "",
    rest: [],
  };
  const value = (index: number, flag: string): string => {
    const candidate = argv[index];
    if (candidate === undefined || candidate.startsWith("--")) {
      throw new Error(`flag ${flag} requires a value`);
    }
    return candidate;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--benchmark-root") parsed.benchmarkRoot = value(++index, flag);
    else if (flag === "--vendor") parsed.vendor = value(++index, flag);
    else if (flag === "--vendors") parsed.vendors = value(++index, flag);
    else if (flag === "--category") parsed.category = value(++index, flag);
    else if (flag === "--domain") parsed.domain = value(++index, flag);
    else if (flag === "--slug") parsed.slug = value(++index, flag);
    else if (flag === "--specs") parsed.specs = value(++index, flag);
    else if (flag === "--suite" || flag === "--candidate-suite") parsed.suite = value(++index, flag);
    else if (flag === "--out") parsed.out = value(++index, flag);
    else if (flag === "--generator-model") parsed.generatorModel = value(++index, flag);
    else if (flag === "--generator-harness") {
      const candidate = value(++index, flag);
      if (!["codex", "claude-code", "host-agent"].includes(candidate)) {
        throw new Error(`--generator-harness must be one of codex|claude-code|host-agent (got ${candidate})`);
      }
      parsed.generatorHarness = candidate;
    } else if (flag === "--generator-effort") {
      const candidate = value(++index, flag);
      if (!["low", "medium", "high"].includes(candidate)) {
        throw new Error(`--generator-effort must be one of low|medium|high (got ${candidate})`);
      }
      parsed.generatorEffort = candidate;
    } else if (flag === "--harness") {
      parsed.harnesses.push(value(++index, flag));
    } else if (flag === "--effort") {
      const candidate = value(++index, flag);
      if (!["low", "medium", "high"].includes(candidate)) {
        throw new Error(`--effort must be one of low|medium|high (got ${candidate})`);
      }
      parsed.effort = candidate;
    } else if (flag === "--task-count") {
      parsed.taskCount = Number(value(++index, flag));
    } else if (flag === "--deterministic") parsed.deterministic = true;
    else if (flag === "--candidate-count") parsed.candidateCount = Number(value(++index, flag));
    else if (flag === "--target-count") parsed.targetCount = Number(value(++index, flag));
    else if (flag === "--difficulty-profile") parsed.difficultyProfile = value(++index, flag);
    else if (flag === "--anchors") parsed.anchors = value(++index, flag);
    else if (flag === "--results") parsed.results = value(++index, flag);
    else if (flag === "--freeze-gates") parsed.freezeGates = value(++index, flag);
    else if (flag === "--cli-only") parsed.cliOnly = true;
    else if (flag === "--surface") {
      const surface = value(++index, flag);
      if (surface !== "cli") throw new Error("V2.1 authoring currently admits only --surface cli");
      parsed.cliOnly = true;
    }
    else if (flag === "--all-surfaces") parsed.cliOnly = false;
    else if (flag === "--run-root") parsed.runRoot = value(++index, flag);
    else if (flag === "--task") parsed.tasks.push(value(++index, flag));
    else if (flag === "--gap-check-assist") parsed.gapCheckAssist = true;
    else if (flag === "--apply") parsed.apply = true;
    else if (flag === "--advisory") parsed.advisory = true;
    else if (flag === "--production") parsed.production = true;
    else if (flag?.startsWith("--")) throw new Error(`unknown flag ${flag}`);
    else if (flag !== undefined) parsed.rest.push(flag);
  }
  return parsed;
}

function envGeneratorHarness(): "claude-code" | "codex" | undefined {
  const value = process.env.AX_EVAL_GENERATOR_HARNESS;
  if (value === "claude-code" || value === "codex") return value;
  if (value) console.warn(`Ignoring AX_EVAL_GENERATOR_HARNESS=${value}; expected claude-code or codex.`);
  return undefined;
}

function generatorHarness(args: AuthoringArgs): "claude-code" | "codex" {
  if (args.generatorHarness === "claude-code" || args.generatorHarness === "codex") return args.generatorHarness;
  if (args.generatorHarness) console.warn(`Ignoring --generator-harness ${args.generatorHarness}; generation uses claude-code or codex.`);
  return envGeneratorHarness() ?? (probeHarness().host === "codex" ? "codex" : "claude-code");
}

function generatorEffort(args: AuthoringArgs): "low" | "medium" | "high" {
  const value = args.generatorEffort || process.env.AX_EVAL_GENERATOR_EFFORT || "medium";
  if (value === "low" || value === "medium" || value === "high") return value;
  console.warn(`Ignoring AX_EVAL_GENERATOR_EFFORT=${value}; expected low, medium, or high.`);
  return "medium";
}

function generatorModel(args: AuthoringArgs, harness: "claude-code" | "codex"): string | undefined {
  return args.generatorModel
    || process.env.AX_EVAL_GENERATOR_MODEL
    || (harness === "codex"
      ? process.env.AX_EVAL_GENERATOR_CODEX_MODEL || "gpt-5.4"
      : process.env.AX_EVAL_GENERATOR_CLAUDE_MODEL || "sonnet");
}

function axArenaDatabasePaths(args: AuthoringArgs, root: string = process.cwd()): AxArenaDatabasePathContext {
  return createAxArenaDatabasePathContext(root, { explicitRoot: args.benchmarkRoot || undefined });
}

function resolveVendorSelection(args: AuthoringArgs, paths: AxArenaDatabasePathContext): ResolveResult[] | null {
  const slugs = args.vendors
    ? args.vendors.split(",").map((value) => value.trim()).filter(Boolean)
    : args.vendor ? [args.vendor] : null;
  if (!slugs) return null;
  return slugs.map((slug) => {
    const card = loadVendorCard(paths, slug);
    if (!card) throw new Error(`No vendor card found for slug "${slug}". Run resolve-vendor first.`);
    return card;
  });
}

function allVendorCards(paths: AxArenaDatabasePathContext, category?: string): ResolveResult[] {
  const vendorDir = axArenaDatabaseReadVendorsDir(paths);
  if (!existsSync(vendorDir)) throw new Error(`No vendor cards directory at ${vendorDir}. Run resolve-vendor first.`);
  return readdirSync(vendorDir)
    .filter((file) => file.endsWith(".discovered.yaml"))
    .map((file) => loadVendorCard(paths, file.replace(".discovered.yaml", "")))
    .filter((vendor): vendor is ResolveResult => vendor !== null)
    .filter((vendor) => !category || vendor.category === category);
}

async function runPool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index]!);
    }
  });
  await Promise.all(workers);
}

async function cmdResolveVendor(args: AuthoringArgs): Promise<number> {
  loadDotenv();
  if (!args.category) throw new Error("--category is required (e.g. --category database)");
  const harness = generatorHarness(args);
  const vendors = args.vendors
    ? args.vendors.split(",").map((value) => value.trim()).filter(Boolean)
    : args.vendor ? [args.vendor] : [];
  if (!vendors.length) throw new Error("--vendor <name> or --vendors <a,b,c> is required");
  console.log(`Resolving ${vendors.length} vendor(s) via ${harness}…`);
  const results = await resolveVendors(vendors, args.category, {
    harness,
    model: generatorModel(args, harness),
    effort: generatorEffort(args),
  });
  const paths = axArenaDatabasePaths(args);
  for (const result of results) {
    const path = writeVendorCard(paths, result);
    console.log(`\n  ${result.vendor} → ${path}`);
    console.log(`    site_url: ${result.site_url ?? "(none)"}`);
    console.log(`    docs_url: ${result.docs_url ?? "(none)"}`);
  }
  return 0;
}

async function cmdImportRegistry(args: AuthoringArgs): Promise<number> {
  loadDotenv();
  if (!args.category) throw new Error("--category is required (e.g. --category database)");
  type Target = { domain: string; vendorName?: string; slug?: string };
  const targets: Target[] = [];
  if (args.domain) targets.push({ domain: args.domain, vendorName: args.vendor || undefined, slug: args.slug || undefined });
  for (const raw of args.vendors.split(",").map((value) => value.trim()).filter(Boolean)) {
    const separator = raw.indexOf("=");
    if (separator === -1) targets.push({ domain: raw });
    else targets.push({ slug: raw.slice(0, separator).trim(), domain: raw.slice(separator + 1).trim() });
  }
  if (!targets.length) throw new Error("provide --domain <example.com> or --vendors <slug=domain,...>");

  const paths = axArenaDatabasePaths(args);
  const missing: string[] = [];
  const ingestHints: string[] = [];
  for (const target of targets) {
    const surface = await fetchRegistrySurface(target.domain);
    if (!surface) {
      missing.push(target.domain);
      console.log(`\n  ${target.domain} → NOT in registry (fall back to resolve-vendor/extract-surfaces)`);
      continue;
    }
    const mapOptions = { category: args.category, vendorName: target.vendorName, slug: target.slug };
    const card = registryToVendorCard(surface, mapOptions);
    const extract = registryToSurfaceExtract(surface, mapOptions);
    const cardPath = writeVendorCard(paths, card);
    const surfacePath = writeSurfaceExtract(paths, extract);
    const found = [extract.cli && `cli(${extract.cli.bin})`, extract.mcp && "mcp"].filter(Boolean).join(", ") || "api-only";
    console.log(`\n  ${card.vendor} (${target.domain}) → ${card.slug}`);
    console.log(`    vendor card    → ${cardPath}`);
    console.log(`    surface extract → ${surfacePath} (${found})`);
    console.log(`    docs_url: ${card.docs_url ?? "(none)"}`);
    const openapi = registryOpenApiUrl(surface);
    if (openapi) {
      console.log(`    openapi spec: ${openapi}`);
      ingestHints.push(`  ax-eval ingest ${openapi} --out results/${card.slug}-ingest.json   # then: generate --from …`);
    } else console.log("    openapi spec: (none in registry — extract-capabilities will ground from docs)");
  }
  console.log(
    `\nRegistry surface/auth structure is reliable, but CLI bin/install and auth prose are best-effort` +
    ` (the registry sometimes names the wrong package or pastes an unrelated auth blurb). Run` +
    ` extract-surfaces to verify + correct them against live docs before executing the CLI surface:` +
    `\n  ax-arena benchmark extract-surfaces --vendors ${targets.map((target) => target.slug ?? target.domain).join(",")}`,
  );
  console.log("\nThen: extract-capabilities for the imported vendor(s), then synthesize-suite → compose-pack.");
  if (ingestHints.length) console.log(`\nRegistry-known OpenAPI specs you can ingest directly:\n${ingestHints.join("\n")}`);
  if (missing.length) {
    console.log(
      `\n${missing.length} domain(s) not in registry: ${missing.join(", ")}.\n` +
      `  Resolve them the grounded way:  ax-arena benchmark resolve-vendor --vendors "<names>" --category ${args.category}`,
    );
  }
  return 0;
}

function summarizeExtractCheck(check: {
  read_method?: string;
  read_path_template?: string;
  sql_dialect?: string;
  sql_query?: string;
  mongo_query?: OracleSpec["mongoQuery"];
  assert_field: string;
  expected: unknown;
}): string {
  const target = check.sql_query
    ? `SQL(${check.sql_dialect ?? "unknown"})`
    : check.mongo_query
      ? `Mongo(${check.mongo_query.operation} ${check.mongo_query.collection})`
      : `${check.read_method ?? "GET"} ${check.read_path_template ?? "(missing path)"}`;
  return `${target} → ${check.assert_field}=${JSON.stringify(check.expected)}`;
}

async function cmdExtractTasks(args: AuthoringArgs): Promise<number> {
  loadDotenv();
  if (!args.suite) throw new Error("--suite <path> is required");
  const harness = generatorHarness(args);
  const suite = loadSuite(args.suite);
  const category = args.category || suite.category;
  if (!category) throw new Error("--category is required (e.g. --category database)");
  const paths = axArenaDatabasePaths(args);
  const vendors = resolveVendorSelection(args, paths) ?? allVendorCards(paths, category);
  if (!vendors.length) throw new Error(`No vendor cards found for category "${category}".`);
  console.log(`Extracting oracles for ${vendors.length} vendor(s) via ${harness}…`);
  const outcomes = await extractOraclesAll(vendors, suite, {
    harness,
    model: generatorModel(args, harness),
    effort: generatorEffort(args),
    supportMatrix: loadSupportMatrix(process.cwd(), args.suite) ?? undefined,
  });
  let failures = 0;
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      failures += 1;
      console.error(`\n  ${outcome.vendor} → FAILED: ${outcome.error}`);
      continue;
    }
    const result = outcome.result;
    const path = writeOracleExtract(paths, result);
    const naCount = result.tasks.filter((task) => task.na).length;
    console.log(`\n  ${result.vendor} → ${path}`);
    console.log(`    base_url: ${result.vendor_config.base_url}`);
    console.log(`    tasks: ${result.tasks.length} total, ${naCount} N/A`);
    for (const task of result.tasks) {
      const status = task.na
        ? `N/A (${task.na_reason ?? "no reason"})`
        : task.checks.map((check) => summarizeExtractCheck(check)).join(" | ");
      console.log(`    ${task.task_id}: ${status}`);
    }
  }
  if (failures) console.error(`\n${failures}/${outcomes.length} vendor(s) failed. Re-run extract-tasks --vendor <slug> for each.`);
  return failures ? 1 : 0;
}

async function cmdComposePack(args: AuthoringArgs): Promise<number> {
  if (!args.suite) throw new Error("--suite <path> is required");
  const paths = axArenaDatabasePaths(args);
  const suite = loadSuite(args.suite);
  const vendors = resolveVendorSelection(args, paths) ?? allVendorCards(paths);
  for (const vendor of vendors) {
    const extract = loadOracleExtract(paths, vendor.slug, suite.name);
    if (!extract) {
      console.error(`Skipping ${vendor.vendor}: no oracle extract found. Run extract-tasks first.`);
      continue;
    }
    const surfaces = loadSurfaceExtract(paths, vendor.slug) ?? undefined;
    const pack = composePack(suite, vendor, extract, {
      surfaces,
      supportMatrix: loadSupportMatrix(process.cwd(), args.suite) ?? undefined,
    });
    const path = writeComposedPack(paths, vendor.slug, suite.name, pack);
    const compiled = ["api", "sdk", "cli", "mcp"].filter((surface) =>
      pack.tasks.some((task) => task.allowed_surfaces.includes(surface)));
    const note = compiled.length ? ` [compiled surfaces: ${compiled.join(", ")}]` : "";
    console.log(`${vendor.vendor} → ${path} (${pack.tasks.length} tasks)${note}`);
  }
  return 0;
}

async function cmdExtractSurfaces(args: AuthoringArgs): Promise<number> {
  loadDotenv();
  const paths = axArenaDatabasePaths(args);
  const vendors = resolveVendorSelection(args, paths) ?? allVendorCards(paths);
  if (!vendors.length) throw new Error("No vendors to extract surfaces for.");
  const harness = generatorHarness(args);
  const seeded = vendors.filter((vendor) => loadSurfaceExtract(paths, vendor.slug)).length;
  console.log(
    `Extracting surfaces for ${vendors.length} vendor(s) via ${harness}…` +
    (seeded ? ` (${seeded} seeded from a prior/registry surface extract — verifying + correcting)` : ""),
  );
  const settled = await Promise.allSettled(vendors.map((vendor) => extractSurfaces(vendor, {
    harness,
    model: generatorModel(args, harness),
    effort: generatorEffort(args),
    prior: loadSurfaceExtract(paths, vendor.slug) ?? undefined,
  })));
  let failures = 0;
  settled.forEach((result, index) => {
    const vendor = vendors[index]!;
    if (result.status === "rejected") {
      failures += 1;
      console.error(`\n  ${vendor.vendor} → FAILED: ${result.reason instanceof Error ? result.reason.message : result.reason}`);
      return;
    }
    const path = writeSurfaceExtract(paths, result.value);
    const found = [result.value.cli && "cli", result.value.sdk && "sdk", result.value.mcp && "mcp"].filter(Boolean).join(", ") || "none";
    console.log(`\n  ${vendor.vendor} → ${path} (${found})`);
  });
  if (failures) console.error(`\n${failures}/${vendors.length} vendor(s) failed.`);
  return failures ? 1 : 0;
}

async function cmdExtractCapabilities(args: AuthoringArgs): Promise<number> {
  loadDotenv();
  const paths = axArenaDatabasePaths(args);
  const vendors = resolveVendorSelection(args, paths) ?? allVendorCards(paths);
  if (!vendors.length) throw new Error("No vendors to extract capabilities for.");
  const harness = generatorHarness(args);
  const overrides = new Map<string, string>();
  for (const raw of args.specs.split(",").map((value) => value.trim()).filter(Boolean)) {
    const separator = raw.indexOf("=");
    if (separator !== -1) overrides.set(raw.slice(0, separator).trim(), raw.slice(separator + 1).trim());
  }
  const specUrl = (vendor: ResolveResult): string | undefined => overrides.get(vendor.slug) ?? vendor.openapi_url ?? undefined;
  const seeded = vendors.filter((vendor) => specUrl(vendor)).length;
  console.log(
    `Extracting capabilities for ${vendors.length} vendor(s) via ${harness}` +
    ` (${seeded} openapi-seeded+grounded, ${vendors.length - seeded} grounded-only)…`,
  );
  let failures = 0;
  await runPool(vendors, 3, async (vendor) => {
    const url = specUrl(vendor);
    try {
      let specSummary: string | undefined;
      if (url) {
        try {
          const summary = await fetchSpecSummary(url);
          specSummary = summary.text;
          console.log(`  ${vendor.vendor}: seeding from spec ${url} (${summary.operationCount} ops)`);
        } catch (error) {
          console.warn(`  ${vendor.vendor}: spec fetch failed (${error instanceof Error ? error.message : String(error)}); falling back to grounded.`);
        }
      }
      const result = await extractCapabilities(vendor, {
        harness,
        model: generatorModel(args, harness),
        effort: generatorEffort(args),
        specSummary,
        specUrl: specSummary ? url : undefined,
        coverageRequirements: vendor.category === "database"
          ? DATABASE_CAPABILITY_COVERAGE_REQUIREMENTS
          : undefined,
      });
      const path = writeCapabilityExtract(paths, result);
      console.log(`\n  ${vendor.vendor} → ${path} (${result.capabilities.length} capabilities)`);
    } catch (error) {
      failures += 1;
      console.error(`\n  ${vendor.vendor} → FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  if (failures) console.error(`\n${failures}/${vendors.length} vendor(s) failed.`);
  return failures ? 1 : 0;
}

async function cmdAuditExtracts(args: AuthoringArgs): Promise<number> {
  const paths = axArenaDatabasePaths(args);
  const slugs = [
    ...(args.vendor ? [args.vendor] : []),
    ...args.vendors.split(",").map((value) => value.trim()).filter(Boolean),
  ];
  const report = auditAllExtracts(paths, slugs.length ? slugs : undefined);
  console.log(formatExtractAuditReport(report));
  if (args.apply) {
    console.log("\nApplying autofixes…");
    for (const vendor of report.vendors) {
      const result = applyExtractAudit(paths, vendor);
      const wrote = [result.inventoryPath, result.surfacesPath].filter(Boolean);
      if (wrote.length) console.log(`  ${vendor.slug} → ${wrote.join(", ")}`);
    }
  } else console.log("\nReport-only. Re-run with --apply to write autofixes.");
  if (args.advisory) {
    const advisorySlugs = slugs.length ? slugs : report.vendors.map((vendor) => vendor.slug);
    console.log(`\nRunning ${advisorySlugs.length} WebFetch-grounded advisory audit(s)…`);
    let failures = 0;
    for (const slug of advisorySlugs) {
      try {
        const harness = generatorHarness(args);
        const advisory = await adviseVendorExtract(paths, slug, {
          harness,
          model: generatorModel(args, harness),
          effort: generatorEffort(args),
        });
        const path = writeExtractAdvisory(paths, advisory);
        console.log(`  ${slug} → ${path} (${advisory.findings.length} advisory finding(s))`);
      } catch (error) {
        failures += 1;
        console.warn(`  ${slug} → advisory failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures) console.warn(`${failures} advisory audit(s) failed; deterministic audit result is unchanged.`);
  }
  return report.summary.errors ? 1 : 0;
}

function cmdAuditSuite(args: AuthoringArgs): number {
  if (!args.suite) throw new Error("--suite <suite.yaml> is required");
  const root = process.cwd();
  const paths = axArenaDatabasePaths(args, root);
  const report = auditSuite(root, args.suite, paths);
  console.log(formatSuiteAuditReport(report));
  if (args.apply) {
    const path = assertCanonicalAxArenaDatabaseSuiteWritePath(paths, args.suite);
    console.log("\nApplying autofixes…");
    const written = applySuiteAudit(paths, path, report);
    for (const output of written) console.log(`  wrote ${output}`);
    if (report.findings.some((finding) =>
      finding.code === "underfilled_task_bank" || finding.code === "mapping_would_cover" || finding.code === "seed_eligible_ok")) {
      console.log("\nNext: re-run synthesize-suite --deterministic to refresh selection from fixed mappings.");
    }
  } else console.log("\nReport-only. Re-run with --apply to write metadata autofixes + audit notes.");
  return report.summary.errors ? 1 : 0;
}

const V2_CLI_DOC_SOURCES: Record<string, string[]> = {
  cockroachdb: [
    "https://www.cockroachlabs.com/docs/stable/cockroach-sql-binary",
    "https://www.cockroachlabs.com/docs/stable/security-reference/authorization",
    "https://www.cockroachlabs.com/docs/stable/sql-statements",
    "https://www.cockroachlabs.com/docs/stable/vector",
    "https://www.cockroachlabs.com/docs/v26.2/full-text-search",
  ],
  insforge: [
    "https://insforge.dev/blog/introducing-insforge-cli",
    "https://www.npmjs.com/package/@insforge/cli",
    "https://insforge-468ccf39.mintlify.app/core-concepts/database/migrations",
    "https://docs.insforge.dev/core-concepts/database/pgvector",
  ],
  neon: [
    "https://neon.com/docs/connect/query-with-psql-editor",
    "https://neon.com/docs/manage/databases",
    "https://neon.com/docs/guides/row-level-security",
    "https://neon.com/docs/ai/ai-concepts",
    "https://neon.com/guides",
  ],
  nile: [
    "https://www.thenile.dev/docs/cli/interacting_db",
    "https://www.thenile.dev/docs/getting-started/languages/sql",
    "https://www.thenile.dev/docs/extensions/vector",
    "https://www.thenile.dev/docs/extensions/pg_bigm",
    "https://www.thenile.dev/docs/ai-embeddings/rag",
  ],
  turso: [
    "https://docs.turso.tech/tursodb/quickstart",
    "https://docs.turso.tech/cli/db/shell",
    "https://docs.turso.tech/sql-reference/statements/create-table",
    "https://docs.turso.tech/sql-reference/functions/fts",
    "https://docs.turso.tech/sql-reference/experimental-features",
    "https://docs.turso.tech/guides/vector-search",
  ],
};

function cliRefreshContract(vendor: string): string {
  const command = vendor === "cockroachdb"
    ? "cockroach sql"
    : vendor === "insforge"
      ? "psql with INSFORGE_CONNECTION_STRING"
      : vendor === "nile"
        ? "nile db psql or the declared psql connection"
        : vendor === "turso"
          ? "turso db shell or tursodb"
          : "psql with the declared database connection";
  return [
    "DAEB-2 CLI refresh contract:",
    "Use only the declared CLI/data-plane surface for this task; management REST/API calls are out of scope.",
    `Use ${command} and the current official CLI documentation. Keep output non-interactive and never print credentials.`,
    ...(vendor === "cockroachdb" ? ["CockroachDB mapping: every task-scoped container is the exact quoted table name in the default public schema of COCKROACH_CONNECTION_STRING's current database. Do not create or connect to a separate database; the independent oracle reads that table directly. Never use a local 127.0.0.1 cluster, --insecure, or implicit cockroach CLI defaults: all task SQL must pass --url \"$COCKROACH_CONNECTION_STRING\"."] : []),
    "The task is not admitted by a successful command alone: setup, mutation, independent read-back, and hash-bound witness evidence are required. Do not delete, reset, or clean up task-scoped resources yourself: preserve the required final state for the evaluator's independent read-back; the dedicated reset provider runs afterward.",
  ].join(" ");
}

function cliCommand(vendor: string): string {
  return vendor === "cockroachdb"
    ? "cockroach sql"
    : vendor === "insforge"
      ? "psql with INSFORGE_CONNECTION_STRING"
      : vendor === "nile"
        ? "nile db psql or the declared psql connection"
        : vendor === "turso"
          ? "turso db shell or tursodb"
          : "psql with the declared database connection";
}

function refreshCliTaskPrompt(vendor: string, prompt: string): string {
  let refreshed = prompt.replace(
    /When issuing SQL through a SQL-compatible API, CLI, or SDK path,/g,
    "When issuing SQL through the declared SQL command-line path,",
  );
  if (vendor === "insforge") {
    // v1 carried hosted REST fallback prose inside the shared task intent. It
    // is useful history for the API lane, but must not leak into a CLI-only
    // pack where it can steer an agent back to HTTP endpoints.
    refreshed = refreshed
      .replace(/\n*Insforge-specific database adapter note:.*?(?=\n\nDAEB-2 CLI refresh contract:)/gs, "")
      .replace(/\n*Insforge query-records completion contract:.*?(?=\n\nDAEB-2 CLI refresh contract:)/gs, "");
  }
  return refreshed.trim();
}

function productionCliTaskPrompt(vendor: string, prompt: string): string {
  const refreshed = prompt.replace(
    "The task is not admitted by a successful command alone: setup, mutation, independent read-back, cleanup, and hash-bound witness evidence are required.",
    "The task is not admitted by a successful command alone: setup, mutation, independent read-back, and hash-bound witness evidence are required. Do not delete, reset, or clean up task-scoped resources yourself: preserve the required final state for the evaluator's independent read-back; the dedicated reset provider runs afterward.",
  );
  return vendor === "cockroachdb"
    ? `${refreshed}\n\nCockroachDB mapping: every task-scoped container is the exact quoted table name in the default public schema of COCKROACH_CONNECTION_STRING's current database. Do not create or connect to a separate database; the independent oracle reads that table directly. Never use a local 127.0.0.1 cluster, --insecure, or implicit cockroach CLI defaults: all task SQL must pass --url \"$COCKROACH_CONNECTION_STRING\".`
    : refreshed;
}

function taskSpecificCliRefreshContract(vendor: string, taskId: string): string {
  const notes: string[] = [];
  if (vendor === "turso" && taskId === "db-T05-vector-search") {
    notes.push("Turso vector refresh: store embeddings with vector32('[...]') and query with vector_distance_cos against a vector32 value; do not rely on implicit TEXT coercion.");
  }
  if (vendor === "turso" && taskId === "db-T07-full-text-search") {
    notes.push("Turso FTS refresh: create a documented `USING fts` index and query with fts_match/fts_score; SQLite MATCH/FTS5 syntax is out of scope.");
  }
  return notes.join(" ");
}

function refreshCliDraftOracles(vendor: string, taskId: string, oracles: TargetPack["tasks"][number]["oracles"]): TargetPack["tasks"][number]["oracles"] {
  if (vendor !== "turso") return oracles;
  return oracles.map((oracle) => {
    if (!oracle.readBodyTemplate || taskId !== "db-T05-vector-search" && taskId !== "db-T07-full-text-search") {
      return oracle;
    }
    const body = oracle.readBodyTemplate as {
      requests?: Array<{ stmt?: { sql?: string }; [key: string]: unknown }>;
    };
    if (!Array.isArray(body.requests)) return oracle;
    const requests = body.requests.map((request) => ({
      ...request,
      stmt: request.stmt
        ? {
            ...request.stmt,
            sql: taskId === "db-T05-vector-search" && typeof request.stmt.sql === "string"
              ? request.stmt.sql.replace("vector_distance_cos(embedding, '[1,0,0]')", "vector_distance_cos(embedding, vector32('[1,0,0]'))")
              : typeof request.stmt.sql === "string"
                ? request.stmt.sql
                .replace("content MATCH 'orchard_{ns}'", "fts_match(content, 'orchard_{ns}')")
                : request.stmt.sql,
          }
        : request.stmt,
    }));
    return { ...oracle, readBodyTemplate: { ...body, requests } };
  });
}

function buildV2DraftCliPack(
  vendor: string,
  source: TargetPack,
  plan: ReturnType<typeof buildV2WitnessPlan>,
  generatedAt: string,
): TargetPack {
  const docs = V2_CLI_DOC_SOURCES[vendor] ?? source.docs_urls;
  const candidateTaskIds = new Set(
    plan.entries
      .filter((entry) => entry.vendor === vendor && entry.surface === "cli")
      .map((entry) => entry.task_id),
  );
  const tasks = source.tasks
    .filter((task) => candidateTaskIds.has(task.id))
    .map((task) => ({
      ...task,
      allowed_surfaces: ["cli"],
      oracles: refreshCliDraftOracles(vendor, task.id, task.oracles),
      prompt: `${refreshCliTaskPrompt(vendor, task.prompt)}\n\n${cliRefreshContract(vendor)} ${taskSpecificCliRefreshContract(vendor, task.id)}`.trim(),
    }));
  const cliSurface = source.surfaces?.cli;
  const sourceDiscovery = source.discovery ?? {
    product: vendor,
    goal: "",
    official_domains: [],
    canonical_endpoint: "",
    deprecated_markers: [],
    auth_scheme: "",
  };
  const refreshedCliSurface = cliSurface
    ? { ...cliSurface, docs_url: docs[0] ?? cliSurface.docs_url }
    : undefined;
  return {
    ...source,
    version: "2",
    standard_set_version: "daeb-2-cli-v2",
    run_id: `daeb2-cli-${vendor}-${generatedAt.replace(/[^0-9]/g, "").slice(0, 14)}`,
    generated_by: "official-doc-refresh",
    // Postgres-backed CLI cells authenticate with the declared SQL connection,
    // not a management API credential. Turso keeps its bearer token because
    // its independent verifier is SQL-over-HTTP rather than a local wire CLI.
    auth: vendor === "turso" ? source.auth : { type: "none", env: "", env_aliases: [], verify_env_aliases: [] },
    auth_method: vendor === "turso" ? source.auth_method : "sql-connection",
    generator: {
      ...source.generator,
      harness: source.generator?.harness ?? "deterministic",
      model: "deterministic",
      effort: "high",
      prompt_version: "compose-pack-cli-doc-refresh-v1",
      source_docs: docs,
    },
    surfaces: refreshedCliSurface ? { cli: refreshedCliSurface } : undefined,
    base_url: vendor === "turso" ? source.base_url : "",
    openapi_url: "",
    docs_urls: docs,
    sandbox_scope: source.sandbox_scope,
    static: {
      site_url: source.static?.site_url ?? source.site_url,
      docs_urls: docs,
      checks: source.static?.checks ?? [],
    },
    discovery: {
      ...sourceDiscovery,
      goal: `${sourceDiscovery.goal.trim().replace(/API\s*\/\s*CLI/gi, "CLI")} DAEB-2 is CLI-only: use the declared CLI and do not call the management API.`,
      canonical_endpoint: cliCommand(vendor),
      auth_scheme: vendor === "turso" ? sourceDiscovery.auth_scheme : "SQL connection string via the declared CLI",
    },
    tasks,
  };
}

function cmdPrepareV2(args: AuthoringArgs): number {
  const root = process.cwd();
  const benchmarkRoot = existsSync(resolve(root, "axarena-database", "v1"))
    ? resolve(root, "axarena-database")
    : resolve(root, "ax-arena", "benchmark", "axarena-database");
  const sourceRoot = resolve(benchmarkRoot, "v1");
  const outputRoot = resolve(benchmarkRoot, "v2");
  const packRoot = resolve(sourceRoot, "packs");
  if (!existsSync(packRoot)) throw new Error(`v1 pack directory is missing: ${packRoot}`);
  const snapshots = readdirSync(packRoot)
    .filter((vendor) => existsSync(resolve(packRoot, vendor, "pack.yaml")))
    .sort()
    .map((vendor) => ({
      vendor,
      pack: loadPack(resolve(packRoot, vendor, "pack.yaml")),
    }));
  if (!snapshots.length) throw new Error("no v1 packs found");
  const generatedAt = new Date().toISOString();
  const plan = buildV2WitnessPlan(snapshots, generatedAt, { mode: args.cliOnly ? "cli-only" : "all" });
  const errors = validateV2WitnessPlan(plan);
  if (errors.length) throw new Error(`v2 witness plan is invalid:\n${errors.join("\n")}`);
  const support = buildV2SupportMatrix(plan);
  const pilotCells = plan.entries
    .filter((entry) => entry.disposition === "needs_witness")
    .map((entry) => ({ vendor: entry.vendor, task_id: entry.task_id, surface: entry.surface, stage: "deterministic-witness" }));
  const blocked = plan.entries.filter((entry) => entry.disposition === "blocked").length;
  console.log(`DAEB v2 ${plan.mode} witness plan: ${plan.entries.length} declared tuples, ${pilotCells.length} witness candidates, ${blocked} blocked`);
  if (!args.apply) {
    console.log("Report-only. Re-run with --apply to write ax-arena/benchmark/axarena-database/v2.");
    return 0;
  }
  if (existsSync(outputRoot) && readdirSync(outputRoot).length > 0) {
    throw new Error(`refusing to overwrite non-empty v2 directory: ${outputRoot}`);
  }
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(resolve(outputRoot, "witness-plan.yaml"), yamlStringify(plan), { mode: 0o600 });
  writeFileSync(resolve(outputRoot, "support-matrix.yaml"), yamlStringify(support), { mode: 0o600 });
  writeFileSync(resolve(outputRoot, "witness-run-matrix.yaml"), yamlStringify({
    schema: "ax.daeb-v2-witness-run-matrix/v1",
    benchmark: "DAEB-2",
    source_version: "daeb-1-v1",
    generated_at: generatedAt,
    mode: plan.mode,
    task_source_status: plan.task_source_status,
    excluded_vendors: plan.excluded_vendors,
    stage: "deterministic-witness",
    harnesses: [],
    trials: 1,
    cells: pilotCells,
    notes: [
      "This is not a model evaluation matrix. Each cell must pass a deterministic witness before pack composition.",
      "Blocked tuples are intentionally absent. Empty vendor/surface combinations are never expanded.",
      "Draft CLI packs are refreshed from v1 task intent with the official-doc/target-capability CLI contract; they are not reviewed or publication-ready.",
    ],
  }), { mode: 0o600 });
  const draftPackRoot = resolve(outputRoot, "packs");
  mkdirSync(draftPackRoot, { recursive: true, mode: 0o700 });
  for (const { vendor, pack } of snapshots.filter(({ vendor }) => !plan.excluded_vendors.includes(vendor))) {
    const draft = buildV2DraftCliPack(vendor, pack, plan, generatedAt);
    const vendorRoot = resolve(draftPackRoot, vendor);
    mkdirSync(vendorRoot, { recursive: true, mode: 0o700 });
    writeFileSync(resolve(vendorRoot, "pack.yaml"), yamlStringify(draft), { mode: 0o600 });
  }
  console.log(`Wrote v2 witness artifacts to ${outputRoot}`);
  return 0;
}

const V2_COMMON_SQL_TASK_IDS = [
  "db-T02-evolve-schema",
  "db-T03-inspect-schema",
  "db-T04-query-records",
  "db-T06-write-records",
] as const;

/**
 * Derive the complete CLI-only production source set from the witnessed v2
 * packs.  The common-SQL population is a reporting view, not a reduced pack:
 * every canonical task remains present in every pack, with structural N/A
 * recorded explicitly.
 */
function cmdPrepareV2Production(args: AuthoringArgs): number {
  const root = process.cwd();
  const benchmarkRoot = existsSync(resolve(root, "axarena-database", "v2"))
    ? resolve(root, "axarena-database")
    : resolve(root, "ax-arena", "benchmark", "axarena-database");
  const v2Root = resolve(benchmarkRoot, "v2");
  const outputRoot = resolve(v2Root, "production");
  const sourcePackRoot = resolve(v2Root, "packs");
  if (!existsSync(sourcePackRoot)) throw new Error(`v2 pack directory is missing: ${sourcePackRoot}`);
  const vendors = ["cockroachdb", "insforge", "neon", "nile", "turso"];
  const sourcePacks = vendors.map((vendor) => {
    const path = resolve(sourcePackRoot, vendor, "pack.yaml");
    if (!existsSync(path)) throw new Error(`v2 source pack is missing: ${path}`);
    return { vendor, path, pack: loadPack(path) };
  });
  const v1SuitePath = resolve(benchmarkRoot, "v1", "suite.yaml");
  const v1Suite = yamlParse(readFileSync(v1SuitePath, "utf8")) as Record<string, unknown>;
  const canonicalTasks = v1Suite.tasks as Array<Record<string, unknown>> | undefined;
  if (!canonicalTasks || canonicalTasks.length !== 7) throw new Error("v1 suite must provide the complete seven-task canonical set");
  const canonicalIds = canonicalTasks.map((task) => String(task.id));
  if (new Set(canonicalIds).size !== canonicalIds.length) throw new Error("v1 suite canonical task ids must be unique");
  if (!args.apply) {
    const executable = sourcePacks.reduce((count, entry) => count + entry.pack.tasks.filter((task) => !task.na && task.allowed_surfaces.includes("cli")).length, 0);
    console.log(`DAEB v2 complete production source: ${vendors.length} vendors × ${canonicalIds.length} canonical tasks; ${executable} admitted CLI tuples.`);
    console.log("Report-only. Re-run with --apply to write v2/production.");
    return 0;
  }
  if (existsSync(outputRoot) && !args.production) {
    throw new Error(`refusing to overwrite an existing v2 production directory: ${outputRoot}. Re-run with --apply --production only to refresh this generated production source.`);
  }
  const selectedTasks = canonicalTasks.map((task) => ({
    ...task,
    allowed_surfaces: ["cli"],
    na_examples: ["This vendor/task tuple is structurally N/A on the admitted CLI surface; it stays visible but is excluded from the denominator."],
  }));
  const methodology = { ...(v1Suite.methodology as Record<string, unknown>), surface_scope: ["cli"], target_task_count: 7 };
  const suite = {
    ...v1Suite,
    name: "DAEB-2-CLI-Production",
    version: 2,
    description: "Complete CLI-only production candidate suite. Every vendor pack retains all seven canonical task identities; structurally unsupported tuples are explicit N/A entries.",
    methodology,
    tasks: selectedTasks,
    scoring: {
      per_task: "pass | fail | na",
      overall: {
        formula: "common_sql_score = sum(passes) / 20",
        notes: ["The published cross-vendor comparative score uses exactly five vendors × four common SQL tasks.", "All 31 admitted CLI tuples, including vendor-feature tasks, are separately published with their own evidence and never silently omitted.", "Structural N/A entries remain in each full pack and are excluded from all denominators."],
      },
    },
  };
  mkdirSync(resolve(outputRoot, "packs"), { recursive: true, mode: 0o700 });
  writeFileSync(resolve(outputRoot, "suite.yaml"), yamlStringify(suite), { mode: 0o600 });
  for (const { vendor, pack } of sourcePacks) {
    const admittedById = new Map(pack.tasks.map((task) => [task.id, task]));
    const tasks = canonicalTasks.map((canonicalTask) => {
      const id = String(canonicalTask.id);
      const admitted = admittedById.get(id);
      if (admitted) {
        return {
          ...admitted,
          allowed_surfaces: ["cli"],
          prompt: `${productionCliTaskPrompt(vendor, admitted.prompt).trim()}\n\nDAEB-2 complete production source contract: this task is an independently reported CLI tuple. Do not substitute a management API or a local database process.`.trim(),
        };
      }
      return {
        id,
        title: String(canonicalTask.title),
        difficulty: canonicalTask.difficulty as "L1" | "L2" | "L3" | "L4",
        prompt: `Structural N/A for ${vendor}: this canonical task is not admitted on the documented CLI target. It is retained for transparent coverage accounting and must not be attempted.`,
        allowed_surfaces: [],
        na: true,
        oracles: [{ type: "na", description: `Structural N/A on ${vendor}'s admitted CLI target; see v2/support-matrix.yaml and v2/cli-doc-audit.yaml.` }],
        depends_on: [],
        trace: [],
      };
    });
    const finalPack: TargetPack = {
      ...pack,
      version: "2-production",
      standard_set_version: "daeb-2-cli-production-v1",
      // PostgreSQL-family identifiers (including the required denied-role
      // name) cap at 63 bytes, so their reproducible namespaces must remain
      // compact wherever T01 access control is admitted.
      run_id: vendor === "cockroachdb" ? "d2p-crdb" : vendor === "neon" ? "d2p-neon" : vendor === "insforge" ? "d2p-ins" : `daeb2-production-${vendor}`,
      generated_by: "v2-production-full-pack-derivation",
      tasks,
    };
    const vendorRoot = resolve(outputRoot, "packs", vendor);
    mkdirSync(vendorRoot, { recursive: true, mode: 0o700 });
    writeFileSync(resolve(vendorRoot, "pack.yaml"), yamlStringify(finalPack), { mode: 0o600 });
  }
  writeFileSync(resolve(outputRoot, "track-manifest.yaml"), yamlStringify({
    schema: "ax.daeb-v2-production-source/v1",
    suite: "DAEB-2-CLI-Production",
    vendors,
    canonical_task_ids: canonicalIds,
    admitted_tuple_count: sourcePacks.reduce((count, entry) => count + entry.pack.tasks.filter((task) => !task.na && task.allowed_surfaces.includes("cli")).length, 0),
    structural_na_tuple_count: vendors.length * canonicalIds.length - sourcePacks.reduce((count, entry) => count + entry.pack.tasks.filter((task) => !task.na && task.allowed_surfaces.includes("cli")).length, 0),
    common_sql_task_ids: [...V2_COMMON_SQL_TASK_IDS],
    common_sql_tuple_count: 20,
    source: "../rc0-semantic-audit.yaml",
    publication_policy: "Every admitted tuple requires independent documentation, oracle, cleanup, hosted three-trial evidence, and final approval. Cross-vendor scoring is limited to the 20 common-SQL tuples; other admitted tuples are published per vendor without being summed into that score.",
  }), { mode: 0o600 });
  console.log(`Wrote v2 complete production source suite and ${vendors.length} full packs to ${outputRoot}`);
  return 0;
}

function cmdRunV2Witness(args: AuthoringArgs): number {
  const root = process.cwd();
  const benchmarkRoot = existsSync(resolve(root, "axarena-database", "v2"))
    ? resolve(root, "axarena-database")
    : resolve(root, "ax-arena", "benchmark", "axarena-database");
  const repositoryRoot = resolve(benchmarkRoot, "..", "..", "..");
  const runRoot = args.runRoot
    ? resolve(repositoryRoot, args.runRoot)
    : resolve(repositoryRoot, "results", "runs", `axarena-database-v2-witness-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const vendors = args.vendors
    ? args.vendors.split(",").map((value) => value.trim()).filter(Boolean)
    : args.vendor ? [args.vendor] : undefined;
  const manifest = runV2Witness({
    benchmarkRoot,
    runRoot,
    vendors,
    tasks: args.tasks.length ? args.tasks : undefined,
    apply: args.apply,
    production: args.production,
  });
  const counts = manifest.cells.reduce<Record<string, number>>((acc, cell) => {
    acc[cell.status] = (acc[cell.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`DAEB v2 witness run: ${manifest.cells.length} selected cell(s) — ${JSON.stringify(counts)}`);
  console.log(`Run manifest: ${resolve(runRoot, "run-manifest.json")}`);
  return manifest.cells.some((cell) => cell.status !== "passed") ? 1 : 0;
}

async function cmdSynthesizeSuite(args: AuthoringArgs): Promise<number> {
  loadDotenv();
  if (!args.category) throw new Error("--category is required (e.g. --category database)");
  if (!args.out || args.out === "results/last-run.json") throw new Error("--out <suite.yaml> is required");
  const root = process.cwd();
  const paths = axArenaDatabasePaths(args, root);
  const outPath = assertCanonicalAxArenaDatabaseSuiteWritePath(paths, args.out);
  let vendors = resolveVendorSelection(args, paths) ?? allVendorCards(paths, args.category);
  if (!args.vendor && !args.vendors && args.category === "database") {
    const core = coreVendorSlugs(paths);
    if (core) {
      const allowed = new Set(core);
      vendors = vendors.filter((vendor) => allowed.has(vendor.slug));
    }
  }
  if (!vendors.length) throw new Error(`No vendor cards found for category "${args.category}".`);
  const extracts = vendors
    .map((vendor) => loadCapabilityExtract(paths, vendor.slug))
    .filter((extract): extract is NonNullable<typeof extract> => {
      if (!extract) console.error("Skipping a vendor: no capability-inventory.yaml found. Run extract-capabilities first.");
      return extract !== null;
    });
  if (extracts.length < 2) throw new Error("Need at least 2 vendors' capability inventories to synthesize a suite.");
  const harness = generatorHarness(args);
  console.log(
    `Synthesizing suite from ${extracts.length} vendor(s)' capability extracts` +
    (args.deterministic
      ? " (seed-only / --deterministic)…"
      : args.gapCheckAssist
        ? " (seed + LLM refine + gap-check assist)…"
        : " (deterministic seed + LLM concept-refine assist, seed fallback)…"),
  );
  const synthesized = await synthesizeSuite(args.category, extracts, {
    harness,
    model: generatorModel(args, harness),
    effort: generatorEffort(args),
    deterministic: args.deterministic,
    gapCheckAssist: args.gapCheckAssist,
    targetTaskCount: args.candidateCount ?? args.taskCount,
    difficultyProfile: args.difficultyProfile === "discriminative" ? "discriminative" : undefined,
    anchorSuite: args.anchors || undefined,
  });
  let result = args.difficultyProfile === "discriminative" && args.cliOnly
    ? {
      ...synthesized,
      methodology: { ...synthesized.methodology, surface_scope: ["cli"] as ("api" | "cli" | "sdk")[] },
      tasks: synthesized.tasks.map((task) => ({ ...task, allowed_surfaces: ["cli"] as ("api" | "cli" | "sdk")[] })),
    }
    : synthesized;
  if (args.difficultyProfile === "discriminative" && args.cliOnly) {
    const supportMatrix = applyV21SupabaseCliExtension(root, result.supportMatrix, result.tasks);
    const taskFitVendorsById = new Map(
      result.tasks.map((task) => [
        task.id,
        [...new Set(supportMatrix.entries
          .filter((entry) => entry.task_id === task.id && entry.surface === "cli" && entry.status === "supported")
          .map((entry) => entry.vendor))],
      ]),
    );
    result = {
      ...result,
      coverageMatrix: applyV21SupabaseCoverageOverlay(root, result.coverageMatrix),
      supportMatrix,
      tasks: result.tasks.map((task) => ({
        ...task,
        task_fit_vendors: taskFitVendorsById.get(task.id) ?? task.task_fit_vendors ?? [],
      })),
    };
  }
  const stem = basename(outPath).replace(/\.yaml$/, "");
  const name = /^suite$/i.test(stem) ? "AXArena-Database v1" : stem.toUpperCase();
  const version = /^suite$/i.test(stem) ? 1 : inferSuiteVersionFromStem(stem);
  const yaml = renderSuiteYaml(name, version, args.category, result);
  const synthesis = renderSynthesisDoc(name, args.category, result);
  const { suitePath, synthesisPath, artifactPaths } = writeSuiteBundle(paths, outPath, yaml, synthesis, result);
  console.log(`\n${result.tasks.length} tasks selected.`);
  for (const task of result.tasks) {
    console.log(`  [${task.difficulty}] ${task.id} — ${new Set(task.coverage.map((entry) => entry.vendor)).size} vendor(s)`);
  }
  console.log(`\nSuite → ${suitePath}`);
  console.log(`Synthesis audit trail → ${synthesisPath}`);
  console.log(`Methodology artifacts → ${artifactPaths.join(", ")}`);
  console.log("\nReview both before freezing — this is a draft, not yet approved.");
  return 0;
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Merge the separately reviewed Supabase CLI extension into a V2.1
 * candidate. The extension is kept as a source artifact; the old V2 support
 * matrix is never rewritten in place. */
function applyV21SupabaseCliExtension(
  root: string,
  supportMatrix: SupportMatrix,
  tasks: Array<{ id: string; skill?: string }>,
): SupportMatrix {
  const benchmarkRoot = existsSync(resolve(root, "axarena-database", "v2"))
    ? resolve(root, "axarena-database")
    : resolve(root, "ax-arena", "benchmark", "axarena-database");
  const extensionPath = resolve(benchmarkRoot, "v2/production/extensions/supabase-cli/support-matrix.yaml");
  if (!existsSync(extensionPath)) return { ...supportMatrix, entries: supportMatrix.entries.filter((entry) => entry.surface === "cli") };
  const extension = yamlParse(readFileSync(extensionPath, "utf8")) as {
    entries?: Array<{ task_id?: string; surface?: string; status?: string; reason?: string }>;
  };
  const sourceToSkill = new Map(Object.entries(V21_WITNESSED_SKILL_SOURCE_IDS).map(([skill, sourceId]) => [sourceId, skill]));
  const candidateBySkill = new Map(tasks.filter((task) => task.skill).map((task) => [task.skill!, task.id]));
  const overrides = new Map(
    (extension.entries ?? [])
      .filter((entry) => entry.surface === "cli" && entry.task_id && sourceToSkill.has(entry.task_id))
      .map((entry) => [candidateBySkill.get(sourceToSkill.get(entry.task_id as string)!), entry] as const)
      .filter(([taskId]) => Boolean(taskId)),
  );
  if (!overrides.size) return { ...supportMatrix, entries: supportMatrix.entries.filter((entry) => entry.surface === "cli") };
  const entries = supportMatrix.entries.map((entry) => {
    if (entry.vendor.toLowerCase() !== "supabase" || entry.surface !== "cli") return entry;
    const override = overrides.get(entry.task_id);
    if (!override) return entry;
    return {
      ...entry,
      status: override.status === "supported" ? "supported" as const : override.status === "inconclusive" ? "inconclusive" as const : "unsupported" as const,
      reason: override.reason ?? "Supabase CLI extension witness overlay",
    };
  });
  return { ...supportMatrix, entries: entries.filter((entry) => entry.surface === "cli") };
}

function applyV21SupabaseCoverageOverlay(
  root: string,
  coverageMatrix: CoverageMatrix,
): CoverageMatrix {
  const benchmarkRoot = existsSync(resolve(root, "axarena-database", "v2"))
    ? resolve(root, "axarena-database")
    : resolve(root, "ax-arena", "benchmark", "axarena-database");
  const extensionPath = resolve(benchmarkRoot, "v2/production/extensions/supabase-cli/support-matrix.yaml");
  if (!existsSync(extensionPath)) return coverageMatrix;
  const extension = yamlParse(readFileSync(extensionPath, "utf8")) as {
    entries?: Array<{ task_id?: string; surface?: string; status?: string }>;
  };
  const sourceToSkill = new Map(Object.entries(V21_WITNESSED_SKILL_SOURCE_IDS).map(([skill, sourceId]) => [sourceId, skill]));
  const supportedSkills = new Set(
    (extension.entries ?? [])
      .filter((entry) => entry.surface === "cli" && entry.status === "supported" && entry.task_id)
      .map((entry) => sourceToSkill.get(entry.task_id as string))
      .filter((skill): skill is string => Boolean(skill)),
  );
  return {
    ...coverageMatrix,
    concepts: coverageMatrix.concepts.map((concept) => {
      if (!supportedSkills.has(concept.concept_name)) return concept;
      return {
        ...concept,
        decisions: concept.decisions.map((decision) => {
          if (decision.vendor.toLowerCase() !== "supabase") return decision;
          return {
            ...decision,
            status: "supported" as const,
            source: "inventory" as const,
            task_fit: {
              requirement_path: decision.task_fit?.requirement_path,
              matched_requirements: decision.task_fit?.matched_requirements ?? [],
              status: "sufficient" as const,
              supported_surfaces: ["cli" as const],
              missing_requirements: [],
              reason: "Supabase CLI extension has an independent SQL witness for this concept.",
            },
            surfaces_documented: [...new Set([...(decision.surfaces_documented ?? []), "cli" as const])],
            reason: undefined,
          };
        }),
      };
    }),
  };
}

function cmdCalibrateSuite(args: AuthoringArgs): number {
  if (!args.suite || !args.results || !args.out || args.out === "results/last-run.json") {
    throw new Error("calibrate-suite requires --suite <candidate.yaml> --results <calibration.jsonl> --out <selection.json>");
  }
  if (args.targetCount !== undefined && args.targetCount !== 10) throw new Error("V2.1 calibration target-count is fixed at 10");
  const parsed = yamlParse(readFileSync(args.suite, "utf8"));
  if (!Array.isArray(parsed?.tasks)) throw new Error("candidate suite has no tasks array");
  const candidates = parsed.tasks.map((task: unknown) => V21TaskSchema.parse(task));
  const observations = readCalibrationJsonl(args.results);
  const result = {
    ...selectV21Tasks(candidates, observations, DEFAULT_V21_SELECTION_POLICY),
    source_hashes: {
      candidate_suite: fileSha256(args.suite),
      calibration_results: fileSha256(args.results),
    },
  };
  writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(`V2.1 calibration selected ${result.selected.length} tasks; selection hash ${result.selection_hash}`);
  console.log(`Selection ledger → ${resolve(args.out)}`);
  return 0;
}

function cmdFreezeSuite(args: AuthoringArgs): number {
  if (!args.suite || !args.out) throw new Error("freeze-suite requires --suite <selection.json> --out <v2.1-suite.yaml>");
  const result = V21SelectionResultSchema.parse(JSON.parse(readFileSync(args.suite, "utf8")));
  validateV21FreezeSelection(result);
  let suppliedGates: Record<string, string> = {};
  if (args.freezeGates) {
    const parsed = JSON.parse(readFileSync(args.freezeGates, "utf8")) as unknown;
    const candidate = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? ((parsed as { source_hashes?: unknown }).source_hashes ?? parsed)
      : null;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("--freeze-gates must be a JSON object of source hashes");
    suppliedGates = Object.fromEntries(Object.entries(candidate).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }
  const frozen = freezeV21Suite(result, { ...suppliedGates, selection: fileSha256(args.suite) });
  writeFileSync(args.out, frozen.yaml, { mode: 0o600 });
  writeFileSync(`${args.out}.freeze.json`, `${JSON.stringify(frozen.manifest, null, 2)}\n`, { mode: 0o600 });
  console.log(`V2.1 suite frozen: ${resolve(args.out)}`);
  console.log(`Freeze manifest: ${resolve(`${args.out}.freeze.json`)}`);
  return 0;
}

function cmdPlanV21(args: AuthoringArgs): number {
  if (!args.suite || !args.vendors || !args.out || args.out === "results/last-run.json") {
    throw new Error("plan-v21 requires --suite <frozen-v2.1-suite.yaml> --vendors <six slugs> --out <plan.json>");
  }
  const vendors = args.vendors.split(",").map((value) => value.trim()).filter(Boolean);
  if (vendors.length !== 6 || new Set(vendors).size !== 6) throw new Error("V2.1 plan requires six unique vendors");
  const expectedVendors = ["cockroachdb", "insforge", "neon", "nile", "supabase", "turso"];
  if ([...vendors].sort().join(",") !== expectedVendors.sort().join(",")) {
    throw new Error(`V2.1 plan requires the frozen six-vendor roster: ${expectedVendors.join(",")}`);
  }
  const freezePath = `${args.suite}.freeze.json`;
  if (!existsSync(freezePath)) throw new Error(`V2.1 plan requires the freeze manifest next to the suite: ${freezePath}`);
  const freeze = JSON.parse(readFileSync(freezePath, "utf8")) as { production_eligible?: unknown; selected_task_ids?: unknown };
  if (freeze.production_eligible !== true) {
    throw new Error("V2.1 plan is blocked: freeze manifest is not production_eligible (docs/support/oracle/witness/calibration/review gates are incomplete)");
  }
  const parsed = yamlParse(readFileSync(args.suite, "utf8"));
  if (!Array.isArray(parsed?.tasks)) throw new Error("frozen V2.1 suite has no tasks array");
  const suiteTaskIds = parsed.tasks.map((task: unknown) => V21TaskSchema.parse(task).id);
  const frozenTaskIds = Array.isArray(freeze.selected_task_ids)
    && freeze.selected_task_ids.every((value): value is string => typeof value === "string")
    ? freeze.selected_task_ids
    : [];
  if (!frozenTaskIds.length || [...frozenTaskIds].sort().join(",") !== [...suiteTaskIds].sort().join(",")) {
    throw new Error("V2.1 freeze manifest selected_task_ids do not match the frozen suite task ids");
  }
  const tasks = parsed.tasks.map((task: unknown) => V21TaskSchema.parse(task));
  const controllerPlan = buildV21ControllerPlan({
    suitePath: args.suite,
    suiteHash: fileSha256(args.suite),
    vendors,
    tasks,
    runRoot: dirname(resolve(args.out)),
    trials: 3,
  });
  const plans = controllerPlan.invocations;
  validateV21InvocationPlan(plans, 432);
  const output = {
    schema: "ax.daeb-v2-1-plan/v1",
    suite: resolve(args.suite),
    suite_hash: fileSha256(args.suite),
    vendors,
    route_manifest: V21_ROUTE_MANIFEST,
    planned_invocations: plans,
    controller_plan_hash: controllerPlanHash(controllerPlan),
    immutable: true,
  };
  writeFileSync(args.out, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  console.log(`V2.1 plan contains ${plans.length} invocation cells → ${resolve(args.out)}`);
  return 0;
}

function cmdPlanV21Calibration(args: AuthoringArgs): number {
  if (!args.suite || !args.vendors || !args.out || args.out === "results/last-run.json") {
    throw new Error("plan-v21-calibration requires --suite <candidate-v2.1.yaml> --vendors <six slugs> --out <plan.json>");
  }
  const vendors = args.vendors.split(",").map((value) => value.trim()).filter(Boolean);
  const parsed = yamlParse(readFileSync(args.suite, "utf8"));
  if (!Array.isArray(parsed?.tasks)) throw new Error("candidate V2.1 suite has no tasks array");
  const tasks = parsed.tasks.map((task: unknown) => V21TaskSchema.parse(task));
  const plan = planV21CalibrationInvocations(vendors, tasks);
  writeFileSync(args.out, `${JSON.stringify({ ...plan, suite: resolve(args.suite), suite_hash: fileSha256(args.suite) }, null, 2)}\n`, { mode: 0o600 });
  console.log(`V2.1 calibration plan contains ${plan.planned_invocations} Pi trial-1 cells → ${resolve(args.out)}`);
  return 0;
}

const V21_VENDOR_PACK_SOURCES: Record<string, string> = {
  cockroachdb: "v2/production/packs/cockroachdb/pack.yaml",
  insforge: "v2/production/packs/insforge/pack.yaml",
  neon: "v2/production/packs/neon/pack.yaml",
  nile: "v2/production/packs/nile/pack.yaml",
  turso: "v2/production/packs/turso/pack.yaml",
  supabase: "v2/production/extensions/supabase-cli/pack.yaml",
};

/** Candidate concepts that already have a reviewed, independently witnessed
 * V2 CLI task.  The ids are deliberately remapped by skill: V2.1 candidates
 * use a new task numbering, while the source pack ids remain immutable. */
const V21_WITNESSED_SKILL_SOURCE_IDS: Record<string, string> = {
  "access-control": "db-T01-access-control",
  "evolve-schema": "db-T02-evolve-schema",
  "inspect-schema": "db-T03-inspect-schema",
  "query-records": "db-T04-query-records",
  "vector-search": "db-T05-vector-search",
  "write-records": "db-T06-write-records",
  "full-text-search": "db-T07-full-text-search",
};
const TASK_ID_FOR_V21_SESSION_WITNESS = "db-T17-cli-session-discovery";
const TASK_ID_FOR_V21_CONSTRAINT_WITNESS = "db-T18-constraint-preservation";

/** V2.1-only deterministic task variant. It is derived from the frozen V2
 * source pack's SQL/CLI contract, but has its own task id, prompt, oracle, and
 * witness. The V2 source pack itself remains immutable. */
function buildV21CliSessionDiscoveryTask(
  source: TargetPack,
  candidateId: string,
  rawTask: Record<string, unknown>,
): TargetPack["tasks"][number] | undefined {
  const sourceTask = source.tasks.find((task) => task.id === "db-T04-query-records");
  if (!sourceTask || source.sql_conn?.dialect !== "postgres") return undefined;
  const table = `"axarena_session_probe_{ns}"`;
  return {
    ...sourceTask,
    id: candidateId,
    title: typeof rawTask.title === "string" ? rawTask.title : "Discover and verify an authenticated CLI session",
    prompt: [
      "From a fresh family session, discover the vendor's documented command-line entrypoint and authentication path.",
      "Using the provisioned sandbox credentials, create a task-scoped relation named `axarena_session_probe_{ns}`",
      "with exactly one marker `session_{ns}` and the authenticated principal observed by the CLI session.",
      "Start a second fresh CLI process and read the marker back. Report the discovered surface, auth method,",
      "relation name, and marker. Never print credentials, call a management API, or clean up the relation.",
      "The evaluator will independently read the relation after the task.",
    ].join("\n\n"),
    oracles: [
      {
        type: "roundtrip",
        expected: 1,
        description: "authenticated CLI session created exactly one marker row",
        assertField: "0.count",
        sqlDialect: "postgres",
        sqlQuery: `SELECT COUNT(*)::int AS count FROM ${table} WHERE marker = 'session_{ns}'`,
      },
      {
        type: "roundtrip",
        expected: 1,
        description: "marker row records a non-empty authenticated principal",
        assertField: "0.count",
        sqlDialect: "postgres",
        sqlQuery: `SELECT COUNT(*)::int AS count FROM ${table} WHERE marker = 'session_{ns}' AND principal <> ''`,
      },
    ],
    difficulty: rawTask.difficulty as "L1" | "L2" | "L3" | "L4",
    allowed_surfaces: ["cli"],
    na: false,
    depends_on: [],
    trace: [],
    execution_family: rawTask.execution_family as TargetPack["tasks"][number]["execution_family"],
    challenge_tags: rawTask.challenge_tags as TargetPack["tasks"][number]["challenge_tags"],
    discovery_reset: rawTask.discovery_reset as TargetPack["tasks"][number]["discovery_reset"],
    controller_fixture_ref: rawTask.controller_fixture_ref as string | undefined,
    supported_vendors: rawTask.supported_vendors as string[] | undefined,
    anchor: rawTask.anchor as boolean | undefined,
  };
}

function buildV21CliPrincipalContinuityTask(
  source: TargetPack,
  candidateId: string,
  rawTask: Record<string, unknown>,
): TargetPack["tasks"][number] | undefined {
  const sourceTask = source.tasks.find((task) => task.id === "db-T04-query-records");
  if (!sourceTask || source.sql_conn?.dialect !== "postgres") return undefined;
  const table = `"axarena_principal_probe_{ns}"`;
  return {
    ...sourceTask,
    id: candidateId,
    title: typeof rawTask.title === "string" ? rawTask.title : "Verify authenticated principal continuity across CLI sessions",
    prompt: typeof rawTask.intent === "string" ? rawTask.intent : sourceTask.prompt,
    oracles: [
      {
        type: "roundtrip",
        expected: 1,
        description: "principal continuity created exactly one marker row",
        assertField: "0.count",
        sqlDialect: "postgres",
        sqlQuery: `SELECT COUNT(*)::int AS count FROM ${table} WHERE marker = 'principal_{ns}'`,
      },
      {
        type: "roundtrip",
        expected: 1,
        description: "principal continuity records a non-empty authenticated principal",
        assertField: "0.count",
        sqlDialect: "postgres",
        sqlQuery: `SELECT COUNT(*)::int AS count FROM ${table} WHERE marker = 'principal_{ns}' AND principal <> ''`,
      },
    ],
    difficulty: rawTask.difficulty as "L1" | "L2" | "L3" | "L4",
    allowed_surfaces: ["cli"],
    na: false,
    depends_on: [],
    trace: [],
    execution_family: rawTask.execution_family as TargetPack["tasks"][number]["execution_family"],
    challenge_tags: rawTask.challenge_tags as TargetPack["tasks"][number]["challenge_tags"],
    discovery_reset: rawTask.discovery_reset as TargetPack["tasks"][number]["discovery_reset"],
    controller_fixture_ref: rawTask.controller_fixture_ref as string | undefined,
    supported_vendors: rawTask.supported_vendors as string[] | undefined,
    anchor: rawTask.anchor as boolean | undefined,
  };
}

function buildV21DerivedSqlTask(
  source: TargetPack,
  candidateId: string,
  rawTask: Record<string, unknown>,
): TargetPack["tasks"][number] | undefined {
  const sourceTask = source.tasks.find((task) => task.id === "db-T04-query-records");
  if (!sourceTask) return undefined;
  const dialect = source.sql_conn?.dialect ?? "postgres";
  const isConstraint = candidateId === TASK_ID_FOR_V21_CONSTRAINT_WITNESS;
  const isAggregate = candidateId === "db-T20-aggregate-query";
  const isNegative = candidateId === "db-T22-negative-query-verification";
  const table = isConstraint
    ? `axarena_constraint_probe_{ns}`
    : isAggregate ? `axarena_aggregate_probe_{ns}`
      : isNegative ? `axarena_negative_query_probe_{ns}`
      : `axarena_txn_probe_{ns}`;
  const count = dialect === "postgres" ? "COUNT(*)::int" : "COUNT(*)";
  const oracle = (sqlQuery: string, expected: number, description: string) => ({
    type: "roundtrip" as const,
    expected,
    description,
    assertField: "0.value",
    ...(dialect === "postgres" ? { sqlDialect: "postgres" as const } : {}),
    sqlQuery,
  });
  const oracles = dialect === "postgres"
    ? isConstraint
      ? [
          oracle(`SELECT ${count} AS value FROM "${table}" WHERE marker = 'constraint_{ns}'`, 1, "duplicate marker did not create a second row"),
          oracle(`SELECT ${count} AS value FROM information_schema.table_constraints WHERE table_schema='public' AND table_name='${table}' AND constraint_type IN ('PRIMARY KEY','UNIQUE')`, 2, "primary and unique constraints remain declared"),
        ]
      : isAggregate
        ? [
            oracle(`SELECT ${count} AS value FROM "${table}"`, 3, "aggregate relation contains three rows"),
            oracle(`SELECT ${count} AS value FROM "${table}" WHERE status = 'active'`, 2, "filtered aggregate counts two active rows"),
          ]
        : isNegative
          ? [
              oracle(`SELECT ${count} AS value FROM "${table}"`, 2, "negative-query relation preserves both original rows"),
              oracle(`SELECT ${count} AS value FROM "${table}" WHERE marker = 'absent_{ns}'`, 0, "negative predicate returns zero rows"),
            ]
        : [
          oracle(`SELECT ${count} AS value FROM "${table}" WHERE marker = 'rollback_{ns}'`, 0, "rolled-back marker is absent"),
          oracle(`SELECT ${count} AS value FROM "${table}" WHERE marker = 'committed_{ns}'`, 1, "committed marker is present"),
        ]
    : isConstraint
      ? [
          { type: "roundtrip" as const, expected: "1", description: "duplicate marker did not create a second row", readMethod: "POST" as const, readPathTemplate: "/v2/pipeline", readBodyTemplate: { requests: [{ type: "execute", stmt: { sql: `SELECT COUNT(*) FROM "${table}" WHERE marker = 'constraint_{ns}'` } }] }, assertField: "results.0.response.result.rows.0.0.value" },
          { type: "roundtrip" as const, expected: "2", description: "primary and unique indexes remain declared", readMethod: "POST" as const, readPathTemplate: "/v2/pipeline", readBodyTemplate: { requests: [{ type: "execute", stmt: { sql: `SELECT COUNT(*) FROM pragma_index_list('${table}') WHERE \"unique\" = 1` } }] }, assertField: "results.0.response.result.rows.0.0.value" },
        ]
      : isAggregate
        ? [
            { type: "roundtrip" as const, expected: "3", description: "aggregate relation contains three rows", readMethod: "POST" as const, readPathTemplate: "/v2/pipeline", readBodyTemplate: { requests: [{ type: "execute", stmt: { sql: `SELECT COUNT(*) FROM "${table}"` } }] }, assertField: "results.0.response.result.rows.0.0.value" },
            { type: "roundtrip" as const, expected: "2", description: "filtered aggregate counts two active rows", readMethod: "POST" as const, readPathTemplate: "/v2/pipeline", readBodyTemplate: { requests: [{ type: "execute", stmt: { sql: `SELECT COUNT(*) FROM "${table}" WHERE status = 'active'` } }] }, assertField: "results.0.response.result.rows.0.0.value" },
          ]
        : isNegative
          ? [
              { type: "roundtrip" as const, expected: "2", description: "negative-query relation preserves both original rows", readMethod: "POST" as const, readPathTemplate: "/v2/pipeline", readBodyTemplate: { requests: [{ type: "execute", stmt: { sql: `SELECT COUNT(*) FROM "${table}"` } }] }, assertField: "results.0.response.result.rows.0.0.value" },
              { type: "roundtrip" as const, expected: "0", description: "negative predicate returns zero rows", readMethod: "POST" as const, readPathTemplate: "/v2/pipeline", readBodyTemplate: { requests: [{ type: "execute", stmt: { sql: `SELECT COUNT(*) FROM "${table}" WHERE marker = 'absent_{ns}'` } }] }, assertField: "results.0.response.result.rows.0.0.value" },
            ]
        : [
          { type: "roundtrip" as const, expected: "0", description: "rolled-back marker is absent", readMethod: "POST" as const, readPathTemplate: "/v2/pipeline", readBodyTemplate: { requests: [{ type: "execute", stmt: { sql: `SELECT COUNT(*) FROM "${table}" WHERE marker = 'rollback_{ns}'` } }] }, assertField: "results.0.response.result.rows.0.0.value" },
          { type: "roundtrip" as const, expected: "1", description: "committed marker is present", readMethod: "POST" as const, readPathTemplate: "/v2/pipeline", readBodyTemplate: { requests: [{ type: "execute", stmt: { sql: `SELECT COUNT(*) FROM "${table}" WHERE marker = 'committed_{ns}'` } }] }, assertField: "results.0.response.result.rows.0.0.value" },
        ];
  return {
    ...sourceTask,
    id: candidateId,
    title: typeof rawTask.title === "string" ? rawTask.title : candidateId,
    prompt: typeof rawTask.intent === "string" ? rawTask.intent : sourceTask.prompt,
    oracles,
    difficulty: rawTask.difficulty as "L1" | "L2" | "L3" | "L4",
    allowed_surfaces: ["cli"],
    na: false,
    depends_on: [],
    trace: [],
    execution_family: rawTask.execution_family as TargetPack["tasks"][number]["execution_family"],
    challenge_tags: rawTask.challenge_tags as TargetPack["tasks"][number]["challenge_tags"],
    discovery_reset: rawTask.discovery_reset as TargetPack["tasks"][number]["discovery_reset"],
    controller_fixture_ref: rawTask.controller_fixture_ref as string | undefined,
    supported_vendors: rawTask.supported_vendors as string[] | undefined,
    anchor: rawTask.anchor as boolean | undefined,
  };
}

function buildV21FullTextSearchTask(
  source: TargetPack,
  candidateId: string,
  rawTask: Record<string, unknown>,
): TargetPack["tasks"][number] | undefined {
  const sourceTask = source.tasks.find((task) => task.id === "db-T04-query-records");
  if (!sourceTask) return undefined;
  const table = "axarena_search_{ns}";
  const oracles = source.sql_conn?.dialect === "postgres"
    ? [
        { type: "roundtrip" as const, expected: 3, description: "search container contains exactly three records", assertField: "0.value", sqlDialect: "postgres" as const, sqlQuery: `SELECT COUNT(*)::int AS value FROM \"${table}\"` },
        { type: "roundtrip" as const, expected: 1, description: "full-text query finds the orchard marker", assertField: "0.value", sqlDialect: "postgres" as const, sqlQuery: `SELECT COUNT(*)::int AS value FROM \"${table}\" WHERE to_tsvector('simple',content) @@ plainto_tsquery('simple','orchard_{ns}')` },
      ]
    : [
        { type: "roundtrip" as const, expected: "3", description: "search container contains exactly three records", readMethod: "POST" as const, readPathTemplate: "/v2/pipeline", readBodyTemplate: { requests: [{ type: "execute", stmt: { sql: `SELECT COUNT(*) FROM \"${table}\"` } }] }, assertField: "results.0.response.result.rows.0.0.value" },
        { type: "roundtrip" as const, expected: "1", description: "full-text query finds the orchard marker", readMethod: "POST" as const, readPathTemplate: "/v2/pipeline", readBodyTemplate: { requests: [{ type: "execute", stmt: { sql: `SELECT COUNT(*) FROM \"${table}\" WHERE content MATCH 'orchard_{ns}'` } }] }, assertField: "results.0.response.result.rows.0.0.value" },
      ];
  return {
    ...sourceTask,
    id: candidateId,
    title: typeof rawTask.title === "string" ? rawTask.title : "Create and query a full-text dataset",
    prompt: typeof rawTask.intent === "string" ? rawTask.intent : sourceTask.prompt,
    oracles,
    difficulty: rawTask.difficulty as "L1" | "L2" | "L3" | "L4",
    allowed_surfaces: ["cli"],
    na: false,
    depends_on: [],
    trace: [],
    execution_family: rawTask.execution_family as TargetPack["tasks"][number]["execution_family"],
    challenge_tags: rawTask.challenge_tags as TargetPack["tasks"][number]["challenge_tags"],
    discovery_reset: rawTask.discovery_reset as TargetPack["tasks"][number]["discovery_reset"],
    controller_fixture_ref: rawTask.controller_fixture_ref as string | undefined,
    supported_vendors: rawTask.supported_vendors as string[] | undefined,
    anchor: rawTask.anchor as boolean | undefined,
  };
}

function cmdPrepareV21Packs(args: AuthoringArgs): number {
  const root = process.cwd();
  const benchmarkRoot = existsSync(resolve(root, "axarena-database", "v2"))
    ? resolve(root, "axarena-database")
    : resolve(root, "ax-arena", "benchmark", "axarena-database");
  const requestedSuite = args.suite || "v2-1/candidate-suite-v2-1.yaml";
  const suitePath = resolve(
    root,
    existsSync(resolve(root, requestedSuite)) ? requestedSuite : resolve(benchmarkRoot, requestedSuite),
  );
  if (!existsSync(suitePath)) throw new Error(`V2.1 candidate suite is missing: ${suitePath}`);
  const suite = yamlParse(readFileSync(suitePath, "utf8")) as { tasks?: Array<Record<string, unknown>> };
  if (!Array.isArray(suite.tasks) || !suite.tasks.length) throw new Error("V2.1 candidate suite has no tasks");
  const supportPath = resolve(dirname(suitePath), "candidate-suite-v2-1.support-matrix.yaml");
  if (!existsSync(supportPath)) throw new Error(`V2.1 support matrix is missing: ${supportPath}`);
  const support = yamlParse(readFileSync(supportPath, "utf8")) as {
    entries?: Array<{ vendor?: string; task_id?: string; surface?: string; status?: string; reason?: string }>;
  };
  const supportEntries = support.entries ?? [];
  const sourcePacks = new Map<string, TargetPack>();
  const sourcePaths = new Map<string, string>();
  const missingSources: string[] = [];
  for (const [vendor, relativePath] of Object.entries(V21_VENDOR_PACK_SOURCES)) {
    const sourcePath = resolve(benchmarkRoot, relativePath.replace(/^v2\//, "v2/"));
    sourcePaths.set(vendor, sourcePath);
    if (!existsSync(sourcePath)) {
      missingSources.push(`${vendor}: ${sourcePath}`);
      continue;
    }
    sourcePacks.set(vendor, loadPack(sourcePath));
  }
  if (missingSources.length) throw new Error(`V2.1 source packs are missing:\n${missingSources.join("\n")}`);

  const readiness: Array<Record<string, unknown>> = [];
  const draftTasks = new Map<string, TargetPack["tasks"]>();
  const repositoryRoot = resolve(benchmarkRoot, "..", "..", "..");
  const sessionWitnessRoot = resolve(repositoryRoot, process.env.DAEB_V21_SESSION_WITNESS_ROOT ?? "results/daeb-v2-1-cli-session-witness-20260815");
  const derivedWitnessRoot = resolve(repositoryRoot, process.env.DAEB_V21_DERIVED_WITNESS_ROOT ?? "results/daeb-v2-1-derived-witness-20260815");
  let sessionWitnessManifest: { cells?: Array<{ vendor?: string; task_id?: string; status?: string }> } = {};
  let derivedWitnessManifest: { cells?: Array<{ vendor?: string; task_id?: string; status?: string }> } = {};
  const sessionWitnessManifestPath = resolve(sessionWitnessRoot, "run-manifest.json");
  if (existsSync(sessionWitnessManifestPath)) {
    try { sessionWitnessManifest = JSON.parse(readFileSync(sessionWitnessManifestPath, "utf8")) as typeof sessionWitnessManifest; }
    catch { sessionWitnessManifest = {}; }
  }
  const derivedWitnessManifestPath = resolve(derivedWitnessRoot, "run-manifest.json");
  if (existsSync(derivedWitnessManifestPath)) {
    try { derivedWitnessManifest = JSON.parse(readFileSync(derivedWitnessManifestPath, "utf8")) as typeof derivedWitnessManifest; }
    catch { derivedWitnessManifest = {}; }
  }
  for (const vendor of Object.keys(V21_VENDOR_PACK_SOURCES)) {
    const source = sourcePacks.get(vendor)!;
    const tasks: TargetPack["tasks"] = [];
    for (const rawTask of suite.tasks) {
      const candidateId = String(rawTask.id ?? "");
      const skill = typeof rawTask.skill === "string" ? rawTask.skill : undefined;
      const sourceId = skill ? V21_WITNESSED_SKILL_SOURCE_IDS[skill] : undefined;
      const sourceTask = sourceId ? source.tasks.find((task) => task.id === sourceId) : undefined;
      const supportEntry = supportEntries.find((entry) =>
        entry.vendor?.toLowerCase() === vendor && entry.task_id === candidateId && entry.surface === "cli"
      );
      const taskFitVendorCount = Array.isArray(rawTask.task_fit_vendors)
        ? rawTask.task_fit_vendors.length
        : undefined;
      const belowAdmissionCoverage = supportEntry?.status === "supported"
        && taskFitVendorCount !== undefined
        && taskFitVendorCount < 5;
      const supported = supportEntry?.status === "supported" && !belowAdmissionCoverage;
      const variantTask = supported && skill === "cli-session-discovery"
        ? buildV21CliSessionDiscoveryTask(source, candidateId, rawTask)
        : supported && skill === "cli-principal-continuity"
          ? buildV21CliPrincipalContinuityTask(source, candidateId, rawTask)
          : supported && (skill === "constraint-preservation" || skill === "transactional-record-recovery" || skill === "negative-query-verification")
      ? buildV21DerivedSqlTask(source, candidateId, rawTask)
          : supported && skill === "aggregate-query"
            ? buildV21DerivedSqlTask(source, candidateId, rawTask)
          : supported && skill === "full-text-search" && (sourceTask?.na ?? false)
            ? buildV21FullTextSearchTask(source, candidateId, rawTask)
          : undefined;
      const variantWitnessed = skill === "cli-session-discovery"
        ? sessionWitnessManifest.cells?.some((cell) => cell.vendor === vendor && cell.task_id === TASK_ID_FOR_V21_SESSION_WITNESS && cell.status === "passed")
        : (skill === "cli-principal-continuity" || skill === "constraint-preservation" || skill === "transactional-record-recovery" || skill === "aggregate-query" || skill === "negative-query-verification")
          ? derivedWitnessManifest.cells?.some((cell) => cell.vendor === vendor && cell.task_id === candidateId && cell.status === "passed")
          : skill === "full-text-search" && (sourceTask?.na ?? false)
            ? derivedWitnessManifest.cells?.some((cell) => cell.vendor === vendor && cell.task_id === candidateId && cell.status === "passed")
          : false;
      const witnessed = Boolean(
        variantTask ? variantWitnessed : sourceTask && !sourceTask.na && sourceTask.allowed_surfaces.includes("cli"),
      );
      const status = belowAdmissionCoverage
        ? "structural-na-or-not-admitted"
        : supported && witnessed
        ? "ready-from-v2-witness"
        : supported
          ? "blocked-missing-independent-oracle-witness"
          : "structural-na-or-not-admitted";
      readiness.push({
        vendor,
        task_id: candidateId,
        skill: skill ?? null,
        support_status: supportEntry?.status ?? "missing",
        source_task_id: sourceId ?? (skill === "cli-session-discovery"
          ? "v2-1-deterministic-cli-session-witness"
          : variantTask ? "v2-1-derived-sql-witness" : null),
        source_pack: sourcePaths.get(vendor),
        witnessed,
        status,
        reason: belowAdmissionCoverage
          ? `Candidate task-fit coverage is ${taskFitVendorCount}/6, below the registered five-of-six admission gate; retained as research-only structural N/A.`
          : supported && !witnessed
          ? "The candidate claims CLI support, but no reviewed V2 source task with an independent oracle/witness exists. This tuple must not be converted into a fake N/A."
          : supportEntry?.reason ?? undefined,
      });
      if (supported && witnessed && (sourceTask || variantTask)) {
        const taskToCopy = variantTask ?? sourceTask!;
        tasks.push({
          ...taskToCopy,
          id: candidateId,
          title: typeof rawTask.title === "string" ? rawTask.title : taskToCopy.title,
          difficulty: rawTask.difficulty as "L1" | "L2" | "L3" | "L4",
          allowed_surfaces: ["cli"],
          execution_family: rawTask.execution_family as TargetPack["tasks"][number]["execution_family"],
          challenge_tags: rawTask.challenge_tags as TargetPack["tasks"][number]["challenge_tags"],
          discovery_reset: rawTask.discovery_reset as TargetPack["tasks"][number]["discovery_reset"],
          controller_fixture_ref: rawTask.controller_fixture_ref as string | undefined,
          supported_vendors: rawTask.supported_vendors as string[] | undefined,
          anchor: rawTask.anchor as boolean | undefined,
        });
      } else if (!supported) {
        tasks.push({
          id: candidateId,
          title: typeof rawTask.title === "string" ? rawTask.title : candidateId,
          prompt: `Structural N/A or not admitted for ${vendor}: this candidate task is not supported on the documented CLI surface and must not be attempted.`,
          difficulty: rawTask.difficulty as "L1" | "L2" | "L3" | "L4",
          allowed_surfaces: [],
          na: true,
          oracles: [{ type: "na", description: `Structural N/A or non-admitted CLI tuple for ${vendor}; see the V2.1 support matrix.` }],
          depends_on: [],
          trace: [],
          execution_family: rawTask.execution_family as TargetPack["tasks"][number]["execution_family"],
          challenge_tags: rawTask.challenge_tags as TargetPack["tasks"][number]["challenge_tags"],
          discovery_reset: rawTask.discovery_reset as TargetPack["tasks"][number]["discovery_reset"],
          controller_fixture_ref: rawTask.controller_fixture_ref as string | undefined,
          supported_vendors: rawTask.supported_vendors as string[] | undefined,
          anchor: rawTask.anchor as boolean | undefined,
        });
      }
    }
    draftTasks.set(vendor, tasks);
  }

  const blocked = readiness.filter((entry) => entry.status === "blocked-missing-independent-oracle-witness");
  const ready = readiness.filter((entry) => entry.status === "ready-from-v2-witness");
  const na = readiness.filter((entry) => entry.status === "structural-na-or-not-admitted");
  const report = {
    schema: "ax.daeb-v2-1-pack-readiness/v1",
    benchmark: "DAEB-2-CLI-V2.1-Harness-Neutral",
    candidate_suite: suitePath,
    candidate_suite_hash: fileSha256(suitePath),
    generated_at: new Date().toISOString(),
    status: blocked.length ? "blocked" : "ready-for-pack-review",
    counts: { total: readiness.length, ready: ready.length, blocked: blocked.length, structural_na_or_not_admitted: na.length },
    entries: readiness,
    policy: [
      "Only V2 source tasks with an existing independent oracle and deterministic witness are copied.",
      "The V2.1 cli-session-discovery variant is admitted only when its separate deterministic five-vendor witness manifest is present.",
      "A supported candidate without such evidence is recorded as blocked, never rewritten as structural N/A.",
      "These are draft derivations; pack approval remains a separate review gate.",
    ],
  };
  const outputRoot = resolve(dirname(suitePath), "packs");
  const readinessPath = resolve(dirname(suitePath), "pack-readiness.yaml");
  if (!args.apply) {
    writeFileSync(readinessPath, yamlStringify(report), { mode: 0o600 });
    console.log(`V2.1 pack readiness: ${ready.length} ready, ${blocked.length} blocked, ${na.length} structural N/A/non-admitted (${readiness.length} vendor-task tuples).`);
    console.log(`Readiness report (not an approval) → ${readinessPath}`);
    return 0;
  }
  mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  writeFileSync(readinessPath, yamlStringify(report), { mode: 0o600 });
  for (const [vendor, tasks] of draftTasks) {
    const source = sourcePacks.get(vendor)!;
    const draft: TargetPack = {
      ...source,
      version: "2.1-draft",
      standard_set_version: "daeb-2-cli-v2-1-draft",
      run_id: `daeb21-draft-${vendor}`,
      generated_by: "v2-1-pack-readiness-derivation",
      tasks,
    };
    const vendorRoot = resolve(outputRoot, vendor);
    mkdirSync(vendorRoot, { recursive: true, mode: 0o700 });
    writeFileSync(resolve(vendorRoot, "pack.yaml"), yamlStringify(draft), { mode: 0o600 });
  }
  console.log(`Wrote V2.1 draft packs and readiness report to ${resolve(dirname(suitePath))}`);
  if (blocked.length) console.log(`WARNING: ${blocked.length} supported vendor-task tuple(s) still lack an independent oracle/witness; V2.1 remains blocked.`);
  return blocked.length ? 1 : 0;
}

export async function runAuthoringCommand(command: AuthoringCommand, argv: readonly string[]): Promise<number> {
  const args = parseAuthoringArgs(argv);
  switch (command) {
    case "resolve-vendor": return cmdResolveVendor(args);
    case "import-registry": return cmdImportRegistry(args);
    case "extract-tasks": return cmdExtractTasks(args);
    case "compose-pack": return cmdComposePack(args);
    case "extract-surfaces": return cmdExtractSurfaces(args);
    case "extract-capabilities": return cmdExtractCapabilities(args);
    case "audit-extracts": return cmdAuditExtracts(args);
    case "audit-suite": return cmdAuditSuite(args);
    case "synthesize-suite": return cmdSynthesizeSuite(args);
    case "calibrate-suite": return cmdCalibrateSuite(args);
    case "freeze-suite": return cmdFreezeSuite(args);
    case "plan-v21": return cmdPlanV21(args);
    case "plan-v21-calibration": return cmdPlanV21Calibration(args);
    case "prepare-v21-packs": return cmdPrepareV21Packs(args);
    case "prepare-v2": return cmdPrepareV2(args);
    case "prepare-v2-production": return cmdPrepareV2Production(args);
    case "run-v2-witness": return cmdRunV2Witness(args);
  }
}

export function authoringCommandUsage(command: AuthoringCommand): string {
  const prefix = `usage: ax-arena benchmark ${command}`;
  switch (command) {
    case "resolve-vendor": return [
      `${prefix} --vendor <name> --category <category>`,
      "       [--vendors <a,b,c>] [--generator-harness claude-code|codex]",
      "       [--generator-effort low|medium|high] [--benchmark-root <dir>]",
      "  LLM-searches for vendor docs URLs and writes discovered vendor cards.",
    ].join("\n");
    case "import-registry": return [
      `${prefix} --category <category> --domain <example.com> [--vendor <Name>] [--slug <slug>]`,
      "       [--vendors <slug=domain,...>] [--benchmark-root <dir>]",
      "  Seeds vendor cards and CLI/MCP/auth surfaces from integrations.sh.",
      "  Registry misses fall back to resolve-vendor and extract-surfaces.",
    ].join("\n");
    case "extract-tasks": return [
      `${prefix} --suite <path> [--category <category>] [--vendor <slug> | --vendors <a,b,c>]`,
      "       [--generator-harness claude-code|codex] [--generator-effort low|medium|high]",
      "       [--benchmark-root <dir>]",
      "  Extracts only vendor auth and outcome read-back checks for each suite task;",
      "  task prompts and scoring intent remain canonical.",
    ].join("\n");
    case "compose-pack": return [
      `${prefix} --suite <path> [--vendor <slug> | --vendors <a,b,c>] [--benchmark-root <dir>]`,
      "  Deterministically assembles frozen TargetPacks from the suite, vendor card,",
      "  oracle extract, support matrix, and optional surface extract. No LLM call.",
    ].join("\n");
    case "extract-surfaces": return [
      `${prefix} [--vendor <slug> | --vendors <a,b,c>]`,
      "       [--generator-harness claude-code|codex] [--generator-effort low|medium|high]",
      "       [--benchmark-root <dir>]",
      "  Discovers CLI/SDK/MCP installation and auth metadata. REST API remains the",
      "  implicit default, and outcome read-back checks do not change by surface.",
    ].join("\n");
    case "extract-capabilities": return [
      `${prefix} [--vendor <slug> | --vendors <a,b,c>] [--specs <slug=openapi-url,...>]`,
      "       [--generator-harness claude-code|codex] [--generator-effort low|medium|high]",
      "       [--benchmark-root <dir>]",
      "  Builds cited benchmark-grade capability inventories. OpenAPI operations",
      "  seed candidates when available; grounded docs review closes data-plane gaps.",
    ].join("\n");
    case "audit-extracts": return [
      `${prefix} [--vendor <slug> | --vendors <a,b,c>] [--apply] [--advisory]`,
      "       [--benchmark-root <dir>]",
      "  Deterministically checks evidence strength, documented surfaces, and headless",
      "  auth. --apply writes safe fixes; --advisory never changes blocking results.",
    ].join("\n");
    case "audit-suite": return [
      `${prefix} --suite <suite.yaml> [--apply] [--benchmark-root <dir>]`,
      "  Checks task-bank depth, naming, difficulty, coverage mappings, task fit,",
      "  roster claims, trace review, and compiled-pack consistency.",
    ].join("\n");
    case "synthesize-suite": return [
      `${prefix} --category <category> [--vendors <a,b,c>] --out <suite.yaml>`,
      "       [--candidate-count 16] [--difficulty-profile discriminative] [--surface cli]",
      "       [--anchors <v2-suite.yaml>] [--generator-harness claude-code|codex]",
      "       [--deterministic] [--gap-check-assist] [--benchmark-root <dir>]",
      "  Derives the concept universe, coverage, canonical tasks, support matrix, and",
      "  methodology artifacts from cited inventories. --deterministic is offline.",
    ].join("\n");
    case "calibrate-suite": return [
      `${prefix} --candidate-suite <candidate-suite.yaml> --results <calibration.jsonl> --target-count 10 --out <selection.json>`,
      "  Applies the frozen V2.1 calibration bands, family quotas, anchor retention,",
      "  five-of-six vendor support gate, and invalid-infrastructure gate.",
    ].join("\n");
    case "freeze-suite": return [
      `${prefix} --suite <selection.json> --out <v2.1-suite.yaml> [--freeze-gates <hashes.json>]`,
      "  Validates the selection ledger and writes an immutable suite + freeze manifest.",
      "  --freeze-gates supplies docs/support/oracle/witness/calibration/review hashes;",
      "  missing gates keep production_eligible=false.",
    ].join("\n");
    case "plan-v21": return [
      `${prefix} --suite <frozen-v2.1-suite.yaml> --vendors <six-slugs> --out <plan.json>`,
      "  Writes the immutable 432-cell family-session plan and route manifest.",
    ].join("\n");
    case "plan-v21-calibration": return [
      `${prefix} --suite <candidate-v2.1.yaml> --vendors <six-slugs> --out <calibration-plan.json>`,
      "  Writes the 288-cell Pi trial-1 plan for Gemini/DeepSeek plus the GLM holdout.",
      "  Structural N/A candidate/vendor tuples remain explicit; this command does not invoke models.",
    ].join("\n");
    case "prepare-v21-packs": return [
      `${prefix} [--suite <candidate-suite-v2-1.yaml>] [--apply]`,
      "  Derives draft six-vendor packs only from existing V2 independent oracle/witness tasks.",
      "  Missing verifier/witness coverage is recorded as blocked; it is never rewritten as N/A.",
    ].join("\n");
    case "prepare-v2": return [
      `${prefix} [--cli-only|--all-surfaces] [--apply]`,
      "  Derives a DAEB v2 deterministic-witness plan from immutable v1 packs.",
      "  CLI-only is the default canonical SQL/CLI benchmark: it excludes Supabase, APIs,",
      "  and CLI tuples rejected by the documented target capability audit.",
      "  Remaining tuples stay inconclusive until an executable witness supplies evidence.",
      "  --all-surfaces is historical",
      "  diagnostic mode only. No LLM or network call.",
    ].join("\n");
    case "prepare-v2-production": return [
      `${prefix} [--apply] [--production]`,
      "  Derives the production seven-task CLI packs from the witnessed v2 packs, retaining explicit structural N/A entries.",
      "  The common-SQL comparison denominator is five vendors × four tasks; vendor-native tasks remain separately reported in each full pack.",
      "  --production permits a deliberate refresh of the already-generated v2/production source after an authoring repair.",
    ].join("\n");
    case "run-v2-witness": return [
      `${prefix} --apply [--production] [--vendors <a,b,c>] [--task <task-id>] [--run-root <dir>]`,
      "  Executes deterministic CLI setup/mutation/read-back/cleanup witnesses against",
      "  the v2 sandbox. Missing credentials are recorded as blocked; no model harness",
      "  is invoked. --production rejects local/insecure Cockroach targets before writes.",
      "  The command updates only passed v2 entries and requires --apply.",
    ].join("\n");
  }
}
