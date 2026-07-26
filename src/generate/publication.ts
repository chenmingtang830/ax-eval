import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { loadPack } from "../config.js";
import type { TraceStep } from "../harness/executor.js";
import type { NormalizedResult } from "./record.js";
import { validatePackAgainstSuite, type Suite } from "./suite.js";
import {
  CANONICAL_SURFACE_SCOPE,
  conceptUniversePath,
  coverageMatrixPath,
  failureTaxonomyPath,
  graderLedgerPath,
  methodologyPath,
  selectionLedgerPath,
  supportMatrixPath,
  traceReviewPath,
} from "./methodology.js";
import {
  daebReadCompiledPackPath,
  daebReadOraclesPath,
  daebReadPacksDir,
  daebReadVendorCardPath,
  type DaebPathInput,
} from "./benchmark-paths.js";
import {
  DAEB_PRODUCTION_CLAUDE_MODEL,
  DAEB_PRODUCTION_CODEX_MODEL,
  DAEB_PRODUCTION_EFFORT,
  DAEB_PRODUCTION_TRIAL_COUNT,
} from "./production-run.js";

const PUBLICATION_HARNESSES = ["codex", "claude-code"] as const;
const PUBLICATION_EFFORT_PROFILES = ["high"] as const;
const REQUIRED_PUBLICATION_EFFORT_PROFILES = ["high"] as const;
const IGNORED_RECURSIVE_DIRS = new Set([
  ".invoke-home",
  ".codex",
  ".cache",
  "Library",
  "_compiled",
]);

export type PublicationQualityGate = {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail";
  detail: string;
};

export type PublicationVendor = {
  slug: string;
  pack: string;
  expected_surfaces: string[];
  missing: string[];
  validation_errors: string[];
  artifacts: {
    vendor_card?: string;
    oracle_extract?: string;
    compiled_pack?: string;
    approval?: string;
    support_matrix?: string;
    snapshot?: string;
    snapshots?: string[];
    report_html?: string;
    report_htmls?: string[];
    normalized_records: string[];
  };
};

export type PublicationManifest = {
  schema: "ax.publication-bundle/v2";
  benchmark: string;
  category: string;
  suite: string;
  suite_version: number;
  generated_at: string;
  publication_readiness: "publication_ready" | "draft";
  expected_matrix: {
    surfaces: string[];
    harnesses: string[];
    effort_profiles: string[];
    required_effort_profiles: string[];
    expected_cells: number;
  };
  quality_gates: PublicationQualityGate[];
  layers: {
    static_ax: {
      description: string;
      methodology_artifacts: string[];
    };
    behavioral: {
      description: string;
      methodology_artifacts: string[];
    };
  };
  vendors: PublicationVendor[];
  competitive_report?: string;
  missing: string[];
  notes: string[];
};

export type BuildPublicationBundleOptions = {
  root: string;
  suite: Suite;
  suitePath: string;
  vendors: string[];
  runDir: string;
  outDir: string;
  effortProfiles?: string[];
  requiredEffortProfiles?: string[];
  benchmarkPaths?: DaebPathInput;
};

export type AxArenaExportFile = {
  id: string;
  path: string;
};

export type AxArenaExportManifest = {
  schema: "ax.axarena-export/v1";
  benchmark: string;
  category: string;
  suite_version: number;
  generated_at: string;
  source_bundle: string;
  source_manifest: string;
  files: AxArenaExportFile[];
};

export type BuildAxArenaExportOptions = {
  root: string;
  bundleDir: string;
  outDir: string;
};

function copyIfExists(src: string, dest: string, missing: string[]): string | undefined {
  if (!existsSync(src)) {
    missing.push(src);
    return undefined;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return dest;
}

function listNormalizedRecords(dir: string): string[] {
  const all = listFilesRecursive(dir, (name) => name.endsWith(".normalized.json"));
  const aggregate = all.filter((path) => relative(dir, path).split(sep).includes("aggregate"));
  return (aggregate.length ? aggregate : all).sort();
}

function listFilesRecursive(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const name of readdirSync(current, { withFileTypes: true })) {
      const full = resolve(current, name.name);
      if (name.isDirectory()) {
        if (IGNORED_RECURSIVE_DIRS.has(name.name)) continue;
        stack.push(full);
      } else if (name.isFile() && predicate(name.name)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function rel(root: string, path: string | undefined): string | undefined {
  return path ? relative(root, path) : undefined;
}

function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function loadNormalizedRecords(paths: string[]): NormalizedResult[] {
  return paths
    .map((path) => readJsonFile(path))
    .filter((record): record is NormalizedResult =>
      Boolean(record && typeof record === "object" && (record as { schema?: unknown }).schema === "ax.normalized-result/v1"),
    );
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function taskResultsFromSnapshot(snapshotPath: string, snapshot: unknown): Array<Record<string, unknown>> {
  if (!snapshot || typeof snapshot !== "object") return [];
  const runs = (snapshot as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const r = run as {
      profile?: unknown;
      harness?: unknown;
      surface?: unknown;
      model?: unknown;
      outcomes?: unknown;
      evidence?: { results?: unknown; trace?: unknown; transcript?: unknown };
    };
    if (!Array.isArray(r.outcomes)) continue;
    for (const outcome of r.outcomes) {
      if (!outcome || typeof outcome !== "object") continue;
      const o = outcome as Record<string, unknown>;
      out.push({
        task_id: o.taskId ?? o.task_id ?? o.id ?? null,
        success: typeof o.success === "boolean" ? o.success : null,
        status: o.status ?? null,
        profile: r.profile ?? null,
        harness: r.harness ?? null,
        surface: r.surface ?? null,
        model: r.model ?? null,
        evidence: {
          snapshot: snapshotPath,
          results: Array.isArray(r.evidence?.results) ? r.evidence?.results : [],
          trace: Array.isArray(r.evidence?.trace) ? r.evidence?.trace : [],
          transcript: typeof r.evidence?.transcript === "string" ? r.evidence?.transcript : null,
        },
      });
    }
  }
  return out;
}

function hasEfficiencyMetrics(record: Record<string, unknown>): boolean {
  const keys = new Set(Object.keys(record));
  const harness = record.harness;
  return (
    keys.has("latency_ms") &&
    keys.has("total_duration_ms") &&
    keys.has("token_usage") &&
    keys.has("cost_usd") &&
    keys.has("tool_call_count") &&
    keys.has("harness_version_raw") &&
    keys.has("harness_version_semver") &&
    keys.has("run_batch_id") &&
    (harness !== "claude-code" || typeof record.cost_usd === "number")
  );
}

function traceCoverageIssue(run: { outcomes?: Array<{ taskId?: string }>; trace?: TraceStep[] }): string | null {
  const outcomes = run.outcomes ?? [];
  const trace = run.trace ?? [];
  const expected = new Set(outcomes.map((outcome) => outcome.taskId).filter((id): id is string => Boolean(id)));
  const calls = trace.filter((step) => step.method || step.path);
  if (expected.size === 0 || calls.length === 0) return null;
  const scoped = new Set(calls.map((step) => step.taskId).filter((id): id is string => Boolean(id && expected.has(id))));
  const opaque = calls.filter((step) => !step.taskId || step.taskId === "all" || step.taskId === "observed").length;
  const minScoped = Math.min(expected.size, Math.max(2, Math.ceil(expected.size / 2)));
  if (scoped.size < minScoped || opaque / Math.max(1, calls.length) > 0.5) {
    return `${scoped.size}/${expected.size} task-scoped trace coverage across ${calls.length} call(s)`;
  }
  return null;
}

function snapshotTraceIssues(path: string): string[] {
  const parsed = readJsonFile(path) as { runs?: Array<{ profile?: string; harness?: string; surface?: string; outcomes?: Array<{ taskId?: string }>; trace?: TraceStep[] }> } | null;
  if (!parsed?.runs) return [];
  return parsed.runs
    .map((run) => {
      const issue = traceCoverageIssue(run);
      return issue ? `${run.harness ?? "unknown"}/${run.surface ?? "api"}/${run.profile ?? "profile"}: ${issue}` : null;
    })
    .filter((issue): issue is string => Boolean(issue));
}

function addGate(gates: PublicationQualityGate[], gate: PublicationQualityGate): void {
  gates.push(gate);
}

export function discoverPublicationVendors(
  root: string,
  _suite: Suite,
  benchmarkPaths: DaebPathInput = root,
): string[] {
  const packsDir = daebReadPacksDir(benchmarkPaths);
  if (!existsSync(packsDir)) return [];
  return readdirSync(packsDir)
    .filter((slug) => existsSync(daebReadCompiledPackPath(benchmarkPaths, slug)))
    .sort();
}

export function buildPublicationBundle(opts: BuildPublicationBundleOptions): PublicationManifest {
  const benchmarkPaths = opts.benchmarkPaths ?? opts.root;
  const suiteFile = `${opts.suite.name.toLowerCase()}.yaml`;
  const outRoot = resolve(opts.root, opts.outDir);
  mkdirSync(outRoot, { recursive: true });
  const topLevelMissing: string[] = [];
  const expectedSurfaces = [...(opts.suite.methodology?.surface_scope ?? CANONICAL_SURFACE_SCOPE)];
  const expectedHarnesses = [...PUBLICATION_HARNESSES];
  const expectedProfiles = opts.effortProfiles?.length ? [...opts.effortProfiles] : [...PUBLICATION_EFFORT_PROFILES];
  const requiredProfiles = opts.requiredEffortProfiles?.length ? [...opts.requiredEffortProfiles] : [...REQUIRED_PUBLICATION_EFFORT_PROFILES];

  const copiedSuite = copyIfExists(
    resolve(opts.root, opts.suitePath),
    resolve(outRoot, "suite", basename(opts.suitePath)),
    topLevelMissing,
  );
  const methodologyArtifacts = [
    copyIfExists(methodologyPath(opts.root, opts.suitePath), resolve(outRoot, "suite", basename(methodologyPath(opts.root, opts.suitePath))), topLevelMissing),
    copyIfExists(conceptUniversePath(opts.root, opts.suitePath), resolve(outRoot, "suite", basename(conceptUniversePath(opts.root, opts.suitePath))), topLevelMissing),
    copyIfExists(coverageMatrixPath(opts.root, opts.suitePath), resolve(outRoot, "suite", basename(coverageMatrixPath(opts.root, opts.suitePath))), topLevelMissing),
    copyIfExists(selectionLedgerPath(opts.root, opts.suitePath), resolve(outRoot, "suite", basename(selectionLedgerPath(opts.root, opts.suitePath))), topLevelMissing),
    copyIfExists(supportMatrixPath(opts.root, opts.suitePath), resolve(outRoot, "suite", basename(supportMatrixPath(opts.root, opts.suitePath))), topLevelMissing),
    copyIfExists(graderLedgerPath(opts.root, opts.suitePath), resolve(outRoot, "suite", basename(graderLedgerPath(opts.root, opts.suitePath))), topLevelMissing),
    copyIfExists(failureTaxonomyPath(opts.root, opts.suitePath), resolve(outRoot, "suite", basename(failureTaxonomyPath(opts.root, opts.suitePath))), topLevelMissing),
    copyIfExists(traceReviewPath(opts.root, opts.suitePath), resolve(outRoot, "suite", basename(traceReviewPath(opts.root, opts.suitePath))), topLevelMissing),
  ].filter((path): path is string => Boolean(path));

  const vendors = opts.vendors.map((slug): PublicationVendor => {
    const missing: string[] = [];
    const sourcePack = daebReadCompiledPackPath(benchmarkPaths, slug);
    const destVendorDir = resolve(outRoot, "vendors", slug);
    const runVendorDir = resolve(opts.root, opts.runDir, slug);

    let validationErrors: string[] = [];
    let expectedVendorSurfaces = [...expectedSurfaces];
    if (existsSync(sourcePack)) {
      const pack = loadPack(sourcePack);
      validationErrors = validatePackAgainstSuite(
        pack.tasks.map((task) => ({ id: task.id, title: task.title, difficulty: task.difficulty })),
        opts.suite,
      );
      for (const task of pack.tasks) {
        if (!task.na && task.oracles.length === 0) {
          validationErrors.push(`Task ${task.id} is executable but has no oracle.`);
        }
      }
      expectedVendorSurfaces = expectedSurfaces.filter((surface) =>
        pack.tasks.some((task) => !task.na && (task.allowed_surfaces ?? []).includes(surface)),
      );
    } else {
      missing.push(sourcePack);
    }

    const normalizedRecords = listNormalizedRecords(runVendorDir)
      .map((record) =>
        copyIfExists(record, resolve(destVendorDir, "normalized", relative(runVendorDir, record)), missing),
      )
      .filter((path): path is string => Boolean(path));
    if (normalizedRecords.length === 0) missing.push(`${runVendorDir}/*.normalized.json`);

    const snapshots = listFilesRecursive(runVendorDir, (name) => name === "generated-eval.snapshot.json")
      .map((snapshot) =>
        copyIfExists(snapshot, resolve(destVendorDir, "reports", relative(runVendorDir, snapshot)), missing),
      )
      .filter((path): path is string => Boolean(path));
    if (snapshots.length === 0) missing.push(`${runVendorDir}/**/generated-eval.snapshot.json`);

    const reportHtmls = listFilesRecursive(runVendorDir, (name) => name === "generated-eval.html")
      .map((report) =>
        copyIfExists(report, resolve(destVendorDir, "reports", relative(runVendorDir, report)), missing),
      )
      .filter((path): path is string => Boolean(path));
    if (reportHtmls.length === 0) missing.push(`${runVendorDir}/**/generated-eval.html`);

    const artifacts = {
      vendor_card: copyIfExists(
        daebReadVendorCardPath(benchmarkPaths, slug),
        resolve(destVendorDir, "vendor.discovered.yaml"),
        missing,
      ),
      oracle_extract: copyIfExists(
        daebReadOraclesPath(benchmarkPaths, slug),
        resolve(destVendorDir, "oracle-extract.yaml"),
        missing,
      ),
      compiled_pack: copyIfExists(sourcePack, resolve(destVendorDir, "compiled-pack.yaml"), missing),
      approval: copyIfExists(
        resolve(dirname(sourcePack), "pack.approval.json"),
        resolve(destVendorDir, "pack.approval.json"),
        missing,
      ),
      support_matrix: copyIfExists(
        supportMatrixPath(opts.root, opts.suitePath),
        resolve(destVendorDir, "suite-support-matrix.yaml"),
        missing,
      ),
      snapshot: snapshots[0],
      snapshots: snapshots.map((path) => relative(outRoot, path)),
      report_html: reportHtmls[0],
      report_htmls: reportHtmls.map((path) => relative(outRoot, path)),
      normalized_records: normalizedRecords.map((path) => relative(outRoot, path)),
    };

    return {
      slug,
      pack: relative(opts.root, sourcePack),
      expected_surfaces: expectedVendorSurfaces,
      missing: missing.map((path) => relative(opts.root, path)),
      validation_errors: validationErrors,
      artifacts: {
        vendor_card: rel(outRoot, artifacts.vendor_card),
        oracle_extract: rel(outRoot, artifacts.oracle_extract),
        compiled_pack: rel(outRoot, artifacts.compiled_pack),
        approval: rel(outRoot, artifacts.approval),
        support_matrix: rel(outRoot, artifacts.support_matrix),
        snapshot: rel(outRoot, artifacts.snapshot),
        snapshots: artifacts.snapshots,
        report_html: rel(outRoot, artifacts.report_html),
        report_htmls: artifacts.report_htmls,
        normalized_records: artifacts.normalized_records,
      },
    };
  });

  const competitiveReport = copyIfExists(
    resolve(opts.root, opts.runDir, "competitive.html"),
    resolve(outRoot, "competitive.html"),
    topLevelMissing,
  );
  const expectedCells = vendors.reduce(
    (sum, vendor) => sum + (vendor.expected_surfaces.length * expectedHarnesses.length),
    0,
  );
  const qualityGates: PublicationQualityGate[] = [];

  const vendorMissing = vendors.flatMap((vendor) => vendor.missing.map((missing) => `${vendor.slug}: ${missing}`));
  const validationErrors = vendors.flatMap((vendor) => vendor.validation_errors.map((error) => `${vendor.slug}: ${error}`));
  addGate(qualityGates, {
    id: "required-artifacts",
    label: "Required publication artifacts are present",
    status: topLevelMissing.length || vendorMissing.length ? "fail" : "pass",
    detail: topLevelMissing.length || vendorMissing.length
      ? `${topLevelMissing.length + vendorMissing.length} required artifact(s) missing.`
      : "Suite artifacts, vendor adapters, approvals, reports, snapshots, and normalized records are present.",
  });
  addGate(qualityGates, {
    id: "pack-validation",
    label: "Compiled packs validate against the frozen suite",
    status: validationErrors.length ? "fail" : "pass",
    detail: validationErrors.length
      ? `${validationErrors.length} validation error(s): ${validationErrors.slice(0, 5).join(" | ")}${validationErrors.length > 5 ? " | ..." : ""}`
      : "All compiled vendor packs match the frozen suite and executable tasks have graders.",
  });

  const missingCells: string[] = [];
  const missingRequiredProfiles: string[] = [];
  const missingOptionalProfiles: string[] = [];
  const recordsByVendor = new Map<string, NormalizedResult[]>();
  for (const vendor of vendors) {
    const records = loadNormalizedRecords(
      vendor.artifacts.normalized_records.map((record) => resolve(outRoot, record)),
    );
    recordsByVendor.set(vendor.slug, records);
    for (const harness of expectedHarnesses) {
      for (const surface of vendor.expected_surfaces) {
        const cellRecords = records.filter((record) => record.harness === harness && record.surface === surface);
        if (!cellRecords.length) {
          missingCells.push(`${vendor.slug}/${surface}/${harness}`);
          continue;
        }
        const profiles = new Set(cellRecords.flatMap((record) => record.profiles ?? []));
        const missingRequired = requiredProfiles.filter((profile) => !profiles.has(profile));
        if (missingRequired.length) {
          missingRequiredProfiles.push(`${vendor.slug}/${surface}/${harness}: missing required ${missingRequired.join(",")}`);
        }
        const missingOptional = expectedProfiles
          .filter((profile) => !requiredProfiles.includes(profile as (typeof REQUIRED_PUBLICATION_EFFORT_PROFILES)[number]))
          .filter((profile) => !profiles.has(profile));
        if (missingOptional.length) {
          missingOptionalProfiles.push(`${vendor.slug}/${surface}/${harness}: missing optional ${missingOptional.join(",")}`);
        }
      }
    }
  }
  addGate(qualityGates, {
    id: "matrix-completeness",
    label: "Expected usability matrix cells are present",
    status: missingCells.length || missingRequiredProfiles.length ? "fail" : "pass",
    detail: missingCells.length || missingRequiredProfiles.length
      ? `${missingCells.length}/${expectedCells} cell(s) missing; ${missingRequiredProfiles.length} cell(s) lack required profile coverage (${requiredProfiles.join("/")}).`
      : `${expectedCells} expected vendor×surface×harness cells are present with required profile coverage (${requiredProfiles.join("/")}).`,
  });
  addGate(qualityGates, {
    id: "optional-profile-coverage",
    label: "Optional research profiles are tracked separately",
    status: missingOptionalProfiles.length ? "warn" : "pass",
    detail: missingOptionalProfiles.length
      ? `${missingOptionalProfiles.length} cell(s) lack optional profile coverage; required profiles remain the publication-critical requirement.`
      : "Optional research-profile evidence is present for every expected cell.",
  });

  const allRecords = [...recordsByVendor.values()].flat();
  const recordsMissingEfficiency = allRecords.filter((record) => !hasEfficiencyMetrics(record as unknown as Record<string, unknown>));
  addGate(qualityGates, {
    id: "efficiency-metrics",
    label: "Efficiency metrics are present in normalized records",
    status: allRecords.length === 0 || recordsMissingEfficiency.length ? "fail" : "pass",
    detail: allRecords.length === 0
      ? "No normalized records are available, so latency/token/tool-call metrics cannot be audited."
      : recordsMissingEfficiency.length
        ? `${recordsMissingEfficiency.length}/${allRecords.length} normalized record(s) lack latency, token/cost, or tool-call metrics.`
        : "Normalized records include latency, token/cost, and tool-call metrics.",
  });

  const canonicalConfigIssues: string[] = [];
  for (const record of allRecords) {
    const expectedModel = record.harness === "codex"
      ? DAEB_PRODUCTION_CODEX_MODEL
      : record.harness === "claude-code" ? DAEB_PRODUCTION_CLAUDE_MODEL : null;
    if (expectedModel && record.model !== expectedModel) {
      canonicalConfigIssues.push(`${record.product}/${record.surface}/${record.harness}: model=${record.model ?? "missing"}`);
    }
    if (!record.profiles.includes(DAEB_PRODUCTION_EFFORT)) {
      canonicalConfigIssues.push(`${record.product}/${record.surface}/${record.harness}: missing ${DAEB_PRODUCTION_EFFORT} profile`);
    }
    if (record.summary_kind !== "aggregate" || record.trial_count !== DAEB_PRODUCTION_TRIAL_COUNT) {
      canonicalConfigIssues.push(`${record.product}/${record.surface}/${record.harness}: requires ${DAEB_PRODUCTION_TRIAL_COUNT}-trial aggregate`);
    }
  }
  const runBatchIds = [...new Set(allRecords.map((record) => record.run_batch_id).filter((value): value is string => Boolean(value)))];
  if (allRecords.some((record) => !record.run_batch_id) || runBatchIds.length !== 1) {
    canonicalConfigIssues.push(`run_batch_id must be present and identical across publication records (found ${runBatchIds.join(",") || "none"})`);
  }
  for (const harness of expectedHarnesses) {
    const harnessRecords = allRecords.filter((record) => record.harness === harness);
    const versions = [...new Set(harnessRecords.map((record) => record.harness_version_semver).filter((value): value is string => Boolean(value)))];
    if (harnessRecords.some((record) => !record.harness_version_semver) || versions.length !== 1) {
      canonicalConfigIssues.push(`${harness}: harness_version_semver must be present and identical (found ${versions.join(",") || "none"})`);
    }
  }
  addGate(qualityGates, {
    id: "canonical-execution-config",
    label: "Production records use the frozen execution configuration",
    status: canonicalConfigIssues.length ? "fail" : "pass",
    detail: canonicalConfigIssues.length
      ? `${canonicalConfigIssues.length} issue(s): ${canonicalConfigIssues.slice(0, 5).join(" | ")}${canonicalConfigIssues.length > 5 ? " | ..." : ""}`
      : `${DAEB_PRODUCTION_CODEX_MODEL} and ${DAEB_PRODUCTION_CLAUDE_MODEL}, ${DAEB_PRODUCTION_EFFORT} effort, ${DAEB_PRODUCTION_TRIAL_COUNT} trials, one run batch, and one version per harness.`,
  });

  const traceIssues = vendors.flatMap((vendor) => {
    const snapshot = vendor.artifacts.snapshot ? resolve(outRoot, vendor.artifacts.snapshot) : "";
    return snapshot ? snapshotTraceIssues(snapshot).map((issue) => `${vendor.slug}: ${issue}`) : [];
  });
  addGate(qualityGates, {
    id: "trace-attribution",
    label: "Trace coverage supports process attribution",
    status: traceIssues.length ? "warn" : "pass",
    detail: traceIssues.length
      ? `${traceIssues.length} run(s) have sparse or coarse task-scoped traces: ${traceIssues.slice(0, 5).join(" | ")}${traceIssues.length > 5 ? " | ..." : ""}`
      : "Recorded traces are sufficiently task-scoped for process diagnostics.",
  });
  addGate(qualityGates, {
    id: "competitive-report",
    label: "Cross-vendor competitive report is present",
    status: competitiveReport ? "pass" : "fail",
    detail: competitiveReport ? "competitive.html is included." : "competitive.html is missing from the run directory.",
  });
  const publicationReady = qualityGates.every((gate) => gate.status !== "fail");

  const manifest: PublicationManifest = {
    schema: "ax.publication-bundle/v2",
    benchmark: opts.suite.name,
    category: opts.suite.category,
    suite: copiedSuite ? relative(outRoot, copiedSuite) : relative(opts.root, opts.suitePath),
    suite_version: opts.suite.version,
    generated_at: new Date().toISOString(),
    publication_readiness: publicationReady ? "publication_ready" : "draft",
    expected_matrix: {
      surfaces: expectedSurfaces,
      harnesses: expectedHarnesses,
      effort_profiles: expectedProfiles,
      required_effort_profiles: requiredProfiles,
      expected_cells: expectedCells,
    },
    quality_gates: qualityGates,
    layers: {
      static_ax: {
        description: "Discoverability & Readiness is the publication/audit layer for discoverability, content quality, and capability exposure.",
        methodology_artifacts: methodologyArtifacts
          .filter((path) => /methodology|concept-universe|coverage-matrix|selection-ledger|failure-taxonomy|trace-review/i.test(path))
          .map((path) => relative(outRoot, path)),
      },
      behavioral: {
        description: `Usability Canonical Suite is the benchmark of record and is scored only from verified outcomes on ${expectedSurfaces.join("/")}.`,
        methodology_artifacts: methodologyArtifacts
          .filter((path) => /support-matrix|grader-ledger|selection-ledger|coverage-matrix|methodology/i.test(path))
          .map((path) => relative(outRoot, path)),
      },
    },
    vendors,
    competitive_report: rel(outRoot, competitiveReport),
    missing: topLevelMissing.map((path) => relative(opts.root, path)),
    notes: [
      "Compiled TargetPacks are executable vendor adapters produced from the canonical suite plus vendor-specific verification extraction.",
      "Discoverability & Readiness artifacts and usability-suite artifacts are published side by side but remain separate scoring layers.",
      "Publication-grade bundles require both Discoverability & Readiness artifacts and usability-suite artifacts; missing methodology files are recorded explicitly.",
      `publication_readiness is draft until required artifacts, required profile matrix coverage (${requiredProfiles.join("/")}), efficiency metrics, and competitive report gates pass.`,
      "Optional profile artifacts remain valuable execution-learning and publication evidence, but missing optional coverage does not block a publication-ready bundle when required profile coverage is complete.",
      "Missing artifacts are recorded so draft bundles can be created before every live run finishes.",
      "Do not publish unredacted transcripts, credentials, connection strings, or .env files in this bundle.",
    ],
  };
  writeFileSync(resolve(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export function buildAxArenaExport(opts: BuildAxArenaExportOptions): AxArenaExportManifest {
  const bundleRoot = resolve(opts.root, opts.bundleDir);
  const outRoot = resolve(opts.root, opts.outDir);
  const manifestPath = resolve(bundleRoot, "manifest.json");
  const manifest = readJsonFile(manifestPath) as PublicationManifest | null;
  if (manifest?.schema !== "ax.publication-bundle/v2") {
    throw new Error(`${manifestPath} is not an ax.publication-bundle/v2 manifest`);
  }

  const leaderboardRecords: Array<{ vendor: string; record: NormalizedResult }> = [];
  const cells: Array<Record<string, unknown>> = [];
  const taskResults: Array<Record<string, unknown>> = [];
  const evidence: Array<Record<string, unknown>> = [];

  for (const vendor of manifest.vendors) {
    for (const recordPath of vendor.artifacts.normalized_records) {
      const absolute = resolve(bundleRoot, recordPath);
      const record = readJsonFile(absolute) as NormalizedResult | null;
      if (record?.schema !== "ax.normalized-result/v1") continue;
      leaderboardRecords.push({ vendor: vendor.slug, record });
      cells.push({
        id: `${vendor.slug}/${record.surface}/${record.harness}`,
        vendor: vendor.slug,
        surface: record.surface,
        harness: record.harness,
        model: record.model,
        profiles: record.profiles,
        task_count: record.tasks_total,
        tasks_passed: record.tasks_passed,
        mean_success_rate: record.mean_pass_rate ?? record.pass_at_1,
        range_success_rate: record.range_pass_rate ?? null,
        trial_count: record.trial_count ?? null,
        trial_values: record.trial_values ?? null,
        pass_all_3: record.pass_all_3 ?? null,
        pass_3_rate: record.task_consistency_at_3 ?? null,
        pass_3_count: record.pass_3_tasks ?? null,
        pass_3_total: record.pass_3_tasks_total ?? null,
        trial_stability_at_3: record.trial_stability_at_3 ?? null,
        latency_ms: record.latency_ms ?? null,
        total_duration_ms: record.total_duration_ms ?? null,
        first_action_latency_ms: record.first_action_latency_ms ?? null,
        tool_call_count: record.tool_call_count ?? null,
        token_usage: record.token_usage ?? null,
        token_cost: record.token_cost ?? null,
        cost_usd: record.cost_usd ?? null,
        tokens_in: record.tokens_in ?? null,
        tokens_out: record.tokens_out ?? null,
        harness_version_raw: record.harness_version_raw ?? null,
        harness_version_semver: record.harness_version_semver ?? null,
        run_batch_id: record.run_batch_id ?? null,
        validity_status: record.validity_status ?? null,
        normalized_record: recordPath,
        source_records: record.source_records ?? [],
      });
      evidence.push({
        kind: "normalized_record",
        vendor: vendor.slug,
        surface: record.surface,
        harness: record.harness,
        path: recordPath,
      });
    }

    for (const snapshotPath of vendor.artifacts.snapshots ?? []) {
      const parsed = readJsonFile(resolve(bundleRoot, snapshotPath));
      const results = taskResultsFromSnapshot(snapshotPath, parsed).map((result) => ({
        vendor: vendor.slug,
        ...result,
      }));
      taskResults.push(...results);
      evidence.push({
        kind: "snapshot",
        vendor: vendor.slug,
        path: snapshotPath,
      });
    }

    for (const reportPath of vendor.artifacts.report_htmls ?? []) {
      evidence.push({
        kind: "report_html",
        vendor: vendor.slug,
        path: reportPath,
      });
    }
  }

  const selectedRecords = new Map<string, { vendor: string; record: NormalizedResult }>();
  for (const entry of leaderboardRecords) {
    if (entry.record.blocked) continue;
    const key = `${entry.vendor}\0${entry.record.harness}\0${entry.record.surface}`;
    const current = selectedRecords.get(key);
    if (!current || (entry.record.summary_kind === "aggregate" && current.record.summary_kind !== "aggregate") ||
      (entry.record.summary_kind === current.record.summary_kind && entry.record.generated_at > current.record.generated_at)) {
      selectedRecords.set(key, entry);
    }
  }
  const makeView = (harness: string, surface: string | null) => {
    const rows = manifest.vendors.flatMap((vendor) => {
      const records = [...selectedRecords.values()]
        .filter((entry) => entry.vendor === vendor.slug && entry.record.harness === harness)
        .filter((entry) => surface === null || entry.record.surface === surface)
        .map((entry) => entry.record);
      if (!records.length) return [];
      const pass3Available = records.every((record) =>
        typeof record.pass_3_tasks === "number" && typeof record.pass_3_tasks_total === "number");
      const pass3Count = pass3Available ? records.reduce((sum, record) => sum + record.pass_3_tasks!, 0) : null;
      const pass3Total = pass3Available ? records.reduce((sum, record) => sum + record.pass_3_tasks_total!, 0) : null;
      const surfaceScores = Object.fromEntries(records.map((record) => [record.surface, {
        mean_pass_at_1: record.mean_pass_rate ?? record.pass_at_1,
        pass_3_rate: record.task_consistency_at_3 ?? null,
        pass_3_count: record.pass_3_tasks ?? null,
        pass_3_total: record.pass_3_tasks_total ?? null,
      }]));
      const score = records.reduce((sum, record) => sum + (record.mean_pass_rate ?? record.pass_at_1), 0) / records.length;
      return [{
        rank: 0,
        vendor: vendor.slug,
        mean_pass_at_1: score,
        pass_3_rate: pass3Count !== null && pass3Total ? pass3Count / pass3Total : null,
        pass_3_count: pass3Count,
        pass_3_total: pass3Total,
        surface_count: records.length,
        surfaces: surfaceScores,
      }];
    }).sort((a, b) =>
      b.mean_pass_at_1 - a.mean_pass_at_1 ||
      (b.pass_3_rate ?? -1) - (a.pass_3_rate ?? -1) ||
      (b.pass_3_count ?? -1) - (a.pass_3_count ?? -1) ||
      a.vendor.localeCompare(b.vendor));
    return { rows: rows.map((row, index) => ({ ...row, rank: index + 1 })) };
  };
  const leaderboard = manifest.expected_matrix.harnesses.map((harness) => {
    const records = [...selectedRecords.values()].filter((entry) => entry.record.harness === harness).map((entry) => entry.record);
    const models = [...new Set(records.map((record) => record.model).filter((value): value is string => Boolean(value)))];
    const versions = [...new Set(records.map((record) => record.harness_version_semver).filter((value): value is string => Boolean(value)))];
    return {
      harness,
      model: models.length === 1 ? models[0] : null,
      effort: DAEB_PRODUCTION_EFFORT,
      harness_version_semver: versions.length === 1 ? versions[0] : null,
      views: {
        overall: makeView(harness, null),
        api: makeView(harness, "api"),
        cli: makeView(harness, "cli"),
      },
    };
  });

  const tasks = taskResults.reduce((acc, result) => {
    const taskId = result.task_id;
    if (typeof taskId !== "string") return acc;
    const bucket = acc.get(taskId) ?? {
      task_id: taskId,
      results: [],
    };
    (bucket.results as Array<Record<string, unknown>>).push(result);
    acc.set(taskId, bucket);
    return acc;
  }, new Map<string, Record<string, unknown>>());

  const failures = taskResults
    .filter((result) => result.success === false)
    .map((result) => ({
      ...result,
      failure_type: "unclassified",
      classification_status: "needs_review",
    }));

  const methodology = {
    static_ax: manifest.layers.static_ax,
    behavioral: manifest.layers.behavioral,
    suite: manifest.suite,
    expected_matrix: manifest.expected_matrix,
    quality_gates: manifest.quality_gates,
  };

  if (manifest.competitive_report) {
    evidence.push({
      kind: "competitive_report",
      path: manifest.competitive_report,
    });
  }

  const files: AxArenaExportFile[] = [
    { id: "leaderboard", path: "leaderboard.json" },
    { id: "cells", path: "cells.json" },
    { id: "tasks", path: "tasks.json" },
    { id: "trials", path: "trials.json" },
    { id: "failures", path: "failures.json" },
    { id: "evidence-index", path: "evidence-index.json" },
    { id: "methodology-index", path: "methodology-index.json" },
  ];

  writeJson(resolve(outRoot, "leaderboard.json"), {
    schema: "ax.axarena-leaderboard/v2",
    benchmark: manifest.benchmark,
    generated_at: new Date().toISOString(),
    scoring: {
      primary: "mean pass@1 within surface, then equal-weight macro-average across participating surfaces",
      tie_breakers: ["pass_3_rate", "pass_3_count", "vendor"],
      agents_are_independent: true,
      na_policy: "exclude structural N/A cells and publish the denominator",
    },
    agents: leaderboard,
  });
  writeJson(resolve(outRoot, "cells.json"), {
    schema: "ax.axarena-cells/v1",
    benchmark: manifest.benchmark,
    generated_at: new Date().toISOString(),
    cells,
  });
  writeJson(resolve(outRoot, "tasks.json"), {
    schema: "ax.axarena-tasks/v1",
    benchmark: manifest.benchmark,
    generated_at: new Date().toISOString(),
    tasks: [...tasks.values()].sort((a, b) => String(a.task_id).localeCompare(String(b.task_id))),
  });
  writeJson(resolve(outRoot, "trials.json"), {
    schema: "ax.axarena-trials/v1",
    benchmark: manifest.benchmark,
    generated_at: new Date().toISOString(),
    task_results: taskResults,
  });
  writeJson(resolve(outRoot, "failures.json"), {
    schema: "ax.axarena-failures/v1",
    benchmark: manifest.benchmark,
    generated_at: new Date().toISOString(),
    failures,
  });
  writeJson(resolve(outRoot, "evidence-index.json"), {
    schema: "ax.axarena-evidence-index/v1",
    benchmark: manifest.benchmark,
    generated_at: new Date().toISOString(),
    evidence,
  });
  writeJson(resolve(outRoot, "methodology-index.json"), {
    schema: "ax.axarena-methodology-index/v1",
    benchmark: manifest.benchmark,
    generated_at: new Date().toISOString(),
    methodology,
  });

  const exportManifest: AxArenaExportManifest = {
    schema: "ax.axarena-export/v1",
    benchmark: manifest.benchmark,
    category: manifest.category,
    suite_version: manifest.suite_version,
    generated_at: new Date().toISOString(),
    source_bundle: relative(outRoot, bundleRoot),
    source_manifest: relative(outRoot, manifestPath),
    files,
  };
  writeJson(resolve(outRoot, "manifest.json"), exportManifest);
  return exportManifest;
}
