import { existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import {
  extractCapabilities,
  extractOraclesAll,
  extractSurfaces,
  fetchRegistrySurface,
  fetchSpecSummary,
  loadDotenv,
  loadSuite,
  probeHarness,
  registryOpenApiUrl,
  registryToSurfaceExtract,
  registryToVendorCard,
  resolveVendors,
  type OracleSpec,
  type ResolveResult,
} from "ax-eval";
import {
  assertCanonicalDaebWritePath,
  createDaebPathContext,
  daebReadVendorsDir,
  type DaebPathContext,
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
  writeSuiteArtifacts,
  writeSuiteFiles,
} from "./synthesize-suite.js";
import { coreVendorSlugs } from "./vendor-selection.js";
import { DATABASE_CAPABILITY_COVERAGE_REQUIREMENTS } from "./database-policy.js";

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
  gapCheckAssist: boolean;
  taskCount?: number;
  apply: boolean;
  advisory: boolean;
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
    gapCheckAssist: false,
    apply: false,
    advisory: false,
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
    else if (flag === "--suite") parsed.suite = value(++index, flag);
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
    else if (flag === "--gap-check-assist") parsed.gapCheckAssist = true;
    else if (flag === "--apply") parsed.apply = true;
    else if (flag === "--advisory") parsed.advisory = true;
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

function daebPaths(args: AuthoringArgs, root: string = process.cwd()): DaebPathContext {
  return createDaebPathContext(root, { explicitRoot: args.benchmarkRoot || undefined });
}

function resolveVendorSelection(args: AuthoringArgs, paths: DaebPathContext): ResolveResult[] | null {
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

function allVendorCards(paths: DaebPathContext, category?: string): ResolveResult[] {
  const vendorDir = daebReadVendorsDir(paths);
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
  const paths = daebPaths(args);
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

  const paths = daebPaths(args);
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
  const paths = daebPaths(args);
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
  const paths = daebPaths(args);
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
  const paths = daebPaths(args);
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
  const paths = daebPaths(args);
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
  const paths = daebPaths(args);
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
  const paths = daebPaths(args, root);
  const report = auditSuite(root, args.suite, paths);
  console.log(formatSuiteAuditReport(report));
  if (args.apply) {
    const path = assertCanonicalDaebWritePath(paths, args.suite);
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

async function cmdSynthesizeSuite(args: AuthoringArgs): Promise<number> {
  loadDotenv();
  if (!args.category) throw new Error("--category is required (e.g. --category database)");
  if (!args.out || args.out === "results/last-run.json") throw new Error("--out <suite.yaml> is required");
  const root = process.cwd();
  const paths = daebPaths(args, root);
  const outPath = assertCanonicalDaebWritePath(paths, args.out);
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
  const result = await synthesizeSuite(args.category, extracts, {
    harness,
    model: generatorModel(args, harness),
    effort: generatorEffort(args),
    deterministic: args.deterministic,
    gapCheckAssist: args.gapCheckAssist,
    targetTaskCount: args.taskCount,
  });
  const stem = basename(outPath).replace(/\.yaml$/, "");
  const name = /^suite$/i.test(stem) ? "DAEB-1" : stem.toUpperCase();
  const version = /^suite$/i.test(stem) ? 1 : inferSuiteVersionFromStem(stem);
  const yaml = renderSuiteYaml(name, version, args.category, result);
  const synthesis = renderSynthesisDoc(name, args.category, result);
  const { suitePath, synthesisPath } = writeSuiteFiles(root, outPath, yaml, synthesis);
  const artifactPaths = writeSuiteArtifacts(root, outPath, result);
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
      "       [--task-count N] [--generator-harness claude-code|codex]",
      "       [--deterministic] [--gap-check-assist] [--benchmark-root <dir>]",
      "  Derives the concept universe, coverage, canonical tasks, support matrix, and",
      "  methodology artifacts from cited inventories. --deterministic is offline.",
    ].join("\n");
  }
}
