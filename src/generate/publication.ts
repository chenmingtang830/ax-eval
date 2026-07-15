import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { loadPack } from "../config.js";
import type { TraceStep } from "../harness/executor.js";
import type { NormalizedResult } from "./record.js";
import { loadSuite, validatePackAgainstSuite, type Suite } from "./suite.js";
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

const PUBLICATION_HARNESSES = ["codex", "claude-code"] as const;
const PUBLICATION_EFFORT_PROFILES = ["medium"] as const;
const REQUIRED_PUBLICATION_EFFORT_PROFILES = ["medium"] as const;
const REQUIRED_PUBLICATION_TRIAL_COUNT = 3;
const IGNORED_RECURSIVE_DIRS = new Set([
  ".invoke-home",
  ".codex",
  ".cache",
  "Library",
  "_compiled",
]);

function publicBenchmarkIdentity(manifest: Pick<PublicationManifest, "benchmark" | "category">): {
  id: string;
  displayName: string;
} {
  if (manifest.category.toLowerCase() === "database") {
    return { id: "axarena-database", displayName: "AXArena Database" };
  }
  const category = manifest.category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    id: category ? `axarena-${category}` : manifest.benchmark.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
    displayName: manifest.benchmark,
  };
}

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
    required_trial_count: number;
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
  requiredTrialCount?: number;
};

export type AxArenaExportFile = {
  id: string;
  path: string;
};

export type AxArenaExportManifest = {
  schema: "ax.axarena-export/v2";
  benchmark: string;
  category: string;
  suite_version: number;
  generated_at: string;
  source_bundle: string;
  source_manifest: string;
  files: AxArenaExportFile[];
};

export type AxArenaCell = {
  id: string;
  vendor: string;
  surface: string;
  harness: string;
  model: string | null;
  profiles: string[];
  task_count: number;
  tasks_passed: number;
  mean_success_rate: number;
  range_success_rate: { min: number; max: number } | null;
  trial_count: number | null;
  trial_values: number[] | null;
  pass_hat_3: number | null;
  task_consistency_at_3: number | null;
  pass_all_3: number | null;
  trial_stability_at_3: "all_pass" | "all_fail" | "inconsistent" | null;
  discovery_score: number | null;
  content_quality: number | null;
  blocked: string | null;
  latency_ms: number | null;
  first_action_latency_ms: number | null;
  tool_call_count: number | null;
  token_usage: Record<string, number> | null;
  token_cost: number | null;
  validity_status: string | null;
  normalized_record: string;
  source_records: string[];
};

export type AxArenaTaskResult = {
  vendor: string;
  task_id: string | null;
  success: boolean | null;
  na: boolean;
  status: unknown;
  trial: number | null;
  profile: string | null;
  harness: string | null;
  surface: string | null;
  model: string | null;
  evidence: {
    snapshot: string;
    results: unknown[];
    trace: unknown[];
    transcript: string | null;
  };
};

export type AxArenaLeaderboardRow = {
  rank: number | null;
  status: "ranked" | "incomplete" | "not_comparable";
  vendor: string;
  expected_surfaces: string[];
  cell_count: number;
  intersection_score: number | null;
  intersection_consistency_at_3: number | null;
  applicability_coverage: number;
  applicable_success_rate: number | null;
  surface_success_rates: Record<string, number | null>;
  discovery_score: number | null;
  incomplete_reasons: string[];
  cells: string[];
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

function trialFromSnapshotPath(snapshotPath: string): number | null {
  const match = snapshotPath.match(/(?:^|[\\/])trial-(\d+)(?:[\\/]|$)/i);
  return match ? Number(match[1]) : null;
}

function taskResultsFromSnapshot(snapshotPath: string, snapshot: unknown): Omit<AxArenaTaskResult, "vendor">[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const runs = (snapshot as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) return [];
  const out: Omit<AxArenaTaskResult, "vendor">[] = [];
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
        task_id: typeof (o.taskId ?? o.task_id ?? o.id) === "string"
          ? String(o.taskId ?? o.task_id ?? o.id)
          : null,
        success: typeof o.success === "boolean" ? o.success : null,
        na: o.na === true,
        status: o.status ?? null,
        trial: trialFromSnapshotPath(snapshotPath),
        profile: typeof r.profile === "string" ? r.profile : null,
        harness: typeof r.harness === "string" ? r.harness : null,
        surface: typeof r.surface === "string" ? r.surface : null,
        model: typeof r.model === "string" ? r.model : null,
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
  return (
    (keys.has("latency_ms") || keys.has("duration_ms") || keys.has("time_to_last_token")) &&
    (keys.has("token_usage") || keys.has("tokens") || keys.has("token_cost") || keys.has("cost_per_task")) &&
    (keys.has("tool_calls") || keys.has("tool_call_count"))
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

export function discoverPublicationVendors(root: string, suite: Suite): string[] {
  const packsDir = resolve(root, "targets", "packs");
  const suiteFile = `${suite.name.toLowerCase()}.yaml`;
  if (!existsSync(packsDir)) return [];
  return readdirSync(packsDir)
    .filter((slug) => existsSync(resolve(packsDir, slug, suiteFile)))
    .sort();
}

export function buildPublicationBundle(opts: BuildPublicationBundleOptions): PublicationManifest {
  const suiteFile = `${opts.suite.name.toLowerCase()}.yaml`;
  const outRoot = resolve(opts.root, opts.outDir);
  mkdirSync(outRoot, { recursive: true });
  const topLevelMissing: string[] = [];
  const expectedSurfaces = [...(opts.suite.methodology?.surface_scope ?? CANONICAL_SURFACE_SCOPE)];
  const expectedHarnesses = [...PUBLICATION_HARNESSES];
  const expectedProfiles = opts.effortProfiles?.length ? [...opts.effortProfiles] : [...PUBLICATION_EFFORT_PROFILES];
  const requiredProfiles = opts.requiredEffortProfiles?.length ? [...opts.requiredEffortProfiles] : [...REQUIRED_PUBLICATION_EFFORT_PROFILES];
  const requiredTrialCount = opts.requiredTrialCount ?? REQUIRED_PUBLICATION_TRIAL_COUNT;

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
    const sourcePack = resolve(opts.root, "targets", "packs", slug, suiteFile);
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
        resolve(opts.root, "targets", "vendors", `${slug}.discovered.yaml`),
        resolve(destVendorDir, "vendor.discovered.yaml"),
        missing,
      ),
      oracle_extract: copyIfExists(
        resolve(opts.root, "targets", "extracts", slug, suiteFile),
        resolve(destVendorDir, "oracle-extract.yaml"),
        missing,
      ),
      compiled_pack: copyIfExists(sourcePack, resolve(destVendorDir, "compiled-pack.yaml"), missing),
      approval: copyIfExists(
        sourcePack.replace(/\.ya?ml$/i, ".approval.json"),
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
  const unrankableCells: string[] = [];
  for (const vendor of vendors) {
    const records = recordsByVendor.get(vendor.slug) ?? [];
    for (const harness of expectedHarnesses) {
      for (const surface of vendor.expected_surfaces) {
        const record = records.find((candidate) => candidate.harness === harness && candidate.surface === surface);
        if (!record) continue;
        const reasons = [
          record.blocked ? `blocked:${record.blocked}` : "",
          record.summary_kind !== "aggregate" ? "not-aggregate" : "",
          record.trial_count !== requiredTrialCount ? `trials:${record.trial_count ?? 0}/${requiredTrialCount}` : "",
        ].filter(Boolean);
        if (reasons.length) unrankableCells.push(`${vendor.slug}/${surface}/${harness} (${reasons.join(",")})`);
      }
    }
  }
  addGate(qualityGates, {
    id: "rankability",
    label: "Required cells contain complete production trials",
    status: unrankableCells.length ? "fail" : "pass",
    detail: unrankableCells.length
      ? `${unrankableCells.length} cell(s) cannot enter the public ranking: ${unrankableCells.slice(0, 5).join(" | ")}${unrankableCells.length > 5 ? " | ..." : ""}`
      : `Every required cell is an unblocked ${requiredTrialCount}-trial aggregate.`,
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
      required_trial_count: requiredTrialCount,
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
      `publication_readiness is draft until required artifacts, required profile matrix coverage (${requiredProfiles.join("/")}), ${requiredTrialCount}-trial rankability, efficiency metrics, and competitive report gates pass.`,
      "Optional profile artifacts remain valuable execution-learning and publication evidence, but missing optional coverage does not block a publication-ready bundle when required profile coverage is complete.",
      "Missing artifacts are recorded so draft bundles can be created before every live run finishes.",
      "Do not publish unredacted transcripts, credentials, connection strings, or .env files in this bundle.",
    ],
  };
  writeFileSync(resolve(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function taskSurfaceKey(taskId: string, surface: string): string {
  return `${taskId}::${surface}`;
}

function resultKey(result: AxArenaTaskResult): string | null {
  if (!result.task_id || !result.surface || !result.harness || !result.trial) return null;
  return `${result.vendor}::${result.task_id}::${result.surface}::${result.harness}::${result.trial}`;
}

function loadVendorSupport(
  bundleRoot: string,
  manifest: PublicationManifest,
  suite: Suite,
): Map<string, Set<string>> {
  const support = new Map<string, Set<string>>();
  for (const vendor of manifest.vendors) {
    const pairs = new Set<string>();
    const packPath = vendor.artifacts.compiled_pack
      ? resolve(bundleRoot, vendor.artifacts.compiled_pack)
      : "";
    if (packPath && existsSync(packPath)) {
      const pack = loadPack(packPath);
      const byTask = new Map(pack.tasks.map((task) => [task.id, task]));
      for (const task of suite.tasks) {
        const compiled = byTask.get(task.id);
        if (!compiled || compiled.na) continue;
        for (const surface of manifest.expected_matrix.surfaces) {
          const allowed = compiled.allowed_surfaces ?? [];
          if (allowed.length === 0 || allowed.includes(surface)) {
            pairs.add(taskSurfaceKey(task.id, surface));
          }
        }
      }
    }
    support.set(vendor.slug, pairs);
  }
  return support;
}

function buildLeaderboard(
  manifest: PublicationManifest,
  suite: Suite,
  support: Map<string, Set<string>>,
  cells: AxArenaCell[],
  taskResults: AxArenaTaskResult[],
): {
  rows: AxArenaLeaderboardRow[];
  intersectionPairs: string[];
  surfacesWithoutIntersection: string[];
} {
  const coreTaskIds = new Set(suite.tasks.map((task) => task.id));
  const universe = suite.tasks.flatMap((task) =>
    manifest.expected_matrix.surfaces.map((surface) => taskSurfaceKey(task.id, surface)));
  const intersectionPairs = universe.filter((pair) =>
    manifest.vendors.every((vendor) => support.get(vendor.slug)?.has(pair)));
  const surfacesWithoutIntersection = manifest.expected_matrix.surfaces.filter((surface) =>
    !intersectionPairs.some((pair) => pair.endsWith(`::${surface}`)));
  const requiredProfiles = new Set(manifest.expected_matrix.required_effort_profiles);
  const requiredTrials = manifest.expected_matrix.required_trial_count || REQUIRED_PUBLICATION_TRIAL_COUNT;
  const eligibleResults = taskResults.filter((result) =>
    result.task_id && coreTaskIds.has(result.task_id) &&
    !result.na && result.success !== null &&
    result.trial !== null && result.trial >= 1 && result.trial <= requiredTrials &&
    (!result.profile || requiredProfiles.size === 0 || requiredProfiles.has(result.profile)));
  const resultsByKey = new Map<string, AxArenaTaskResult[]>();
  for (const result of eligibleResults) {
    const key = resultKey(result);
    if (!key) continue;
    const list = resultsByKey.get(key) ?? [];
    list.push(result);
    resultsByKey.set(key, list);
  }

  const rows = manifest.vendors.map((vendor): AxArenaLeaderboardRow => {
    const vendorSupport = support.get(vendor.slug) ?? new Set<string>();
    const vendorCells = cells.filter((cell) => cell.vendor === vendor.slug);
    const incompleteReasons: string[] = [];
    for (const surface of vendor.expected_surfaces) {
      for (const harness of manifest.expected_matrix.harnesses) {
        const cell = vendorCells.find((candidate) => candidate.surface === surface && candidate.harness === harness);
        if (!cell) incompleteReasons.push(`missing cell ${surface}/${harness}`);
        else if (cell.blocked) incompleteReasons.push(`blocked cell ${surface}/${harness}: ${cell.blocked}`);
        else if (cell.trial_count !== requiredTrials) {
          incompleteReasons.push(`incomplete trials ${surface}/${harness}: ${cell.trial_count ?? 0}/${requiredTrials}`);
        }
      }
    }

    const expectedResultKeys: string[] = [];
    for (const pair of vendorSupport) {
      const [taskId, surface] = pair.split("::") as [string, string];
      for (const harness of manifest.expected_matrix.harnesses) {
        for (let trial = 1; trial <= requiredTrials; trial++) {
          expectedResultKeys.push(`${vendor.slug}::${taskId}::${surface}::${harness}::${trial}`);
        }
      }
    }
    for (const key of expectedResultKeys) {
      const results = resultsByKey.get(key) ?? [];
      if (results.length === 0) incompleteReasons.push(`missing trial outcome ${key.split("::").slice(1).join("/")}`);
      else if (results.length > 1) incompleteReasons.push(`duplicate trial outcome ${key.split("::").slice(1).join("/")}`);
    }

    const vendorResults = eligibleResults.filter((result) => result.vendor === vendor.slug);
    const supportedResults = vendorResults.filter((result) =>
      result.task_id && result.surface && vendorSupport.has(taskSurfaceKey(result.task_id, result.surface)));
    const intersectionResults = vendorResults.filter((result) =>
      result.task_id && result.surface && intersectionPairs.includes(taskSurfaceKey(result.task_id, result.surface)));
    const surfaceSuccessRates = Object.fromEntries(manifest.expected_matrix.surfaces.map((surface) => {
      const surfaceValues = supportedResults
        .filter((result) => result.surface === surface)
        .map((result) => result.success === true ? 1 : 0);
      return [surface, mean(surfaceValues)];
    }));
    const consistencyUnits: number[] = [];
    for (const pair of intersectionPairs) {
      const [taskId, surface] = pair.split("::") as [string, string];
      for (const harness of manifest.expected_matrix.harnesses) {
        const trials = Array.from({ length: requiredTrials }, (_, index) =>
          resultsByKey.get(`${vendor.slug}::${taskId}::${surface}::${harness}::${index + 1}`)?.[0]);
        if (trials.every(Boolean)) consistencyUnits.push(trials.every((result) => result?.success === true) ? 1 : 0);
      }
    }
    const isComparable = intersectionPairs.length > 0;
    const isComplete = isComparable && incompleteReasons.length === 0;
    return {
      rank: null,
      status: !isComparable ? "not_comparable" : isComplete ? "ranked" : "incomplete",
      vendor: vendor.slug,
      expected_surfaces: vendor.expected_surfaces,
      cell_count: vendorCells.length,
      intersection_score: isComplete ? mean(intersectionResults.map((result) => result.success === true ? 1 : 0)) : null,
      intersection_consistency_at_3: isComplete ? mean(consistencyUnits) : null,
      applicability_coverage: universe.length ? vendorSupport.size / universe.length : 0,
      applicable_success_rate: mean(supportedResults.map((result) => result.success === true ? 1 : 0)),
      surface_success_rates: surfaceSuccessRates,
      discovery_score: mean(vendorCells.flatMap((cell) => cell.discovery_score === null ? [] : [cell.discovery_score])),
      incomplete_reasons: [...new Set(incompleteReasons)].sort(),
      cells: vendorCells.map((cell) => cell.id).sort(),
    };
  });

  const ranked = rows.filter((row) => row.status === "ranked").sort((a, b) =>
    (b.intersection_score ?? -1) - (a.intersection_score ?? -1) ||
    (b.intersection_consistency_at_3 ?? -1) - (a.intersection_consistency_at_3 ?? -1) ||
    a.vendor.localeCompare(b.vendor));
  let previous: AxArenaLeaderboardRow | undefined;
  for (const [index, row] of ranked.entries()) {
    const tied = previous &&
      row.intersection_score === previous.intersection_score &&
      row.intersection_consistency_at_3 === previous.intersection_consistency_at_3;
    row.rank = tied ? previous!.rank : index + 1;
    previous = row;
  }
  const unranked = rows.filter((row) => row.status !== "ranked").sort((a, b) => a.vendor.localeCompare(b.vendor));
  return { rows: [...ranked, ...unranked], intersectionPairs, surfacesWithoutIntersection };
}

export function buildAxArenaExport(opts: BuildAxArenaExportOptions): AxArenaExportManifest {
  const bundleRoot = resolve(opts.root, opts.bundleDir);
  const outRoot = resolve(opts.root, opts.outDir);
  const manifestPath = resolve(bundleRoot, "manifest.json");
  const manifest = readJsonFile(manifestPath) as PublicationManifest | null;
  if (manifest?.schema !== "ax.publication-bundle/v2") {
    throw new Error(`${manifestPath} is not an ax.publication-bundle/v2 manifest`);
  }
  const suitePath = resolve(bundleRoot, manifest.suite);
  if (!existsSync(suitePath)) throw new Error(`Publication suite is missing at ${suitePath}`);
  const suite = loadSuite(suitePath);
  const requiredTrialCount = manifest.expected_matrix.required_trial_count || REQUIRED_PUBLICATION_TRIAL_COUNT;

  const cells: AxArenaCell[] = [];
  const taskResults: AxArenaTaskResult[] = [];
  const evidence: Array<Record<string, unknown>> = [];
  for (const vendor of manifest.vendors) {
    for (const recordPath of vendor.artifacts.normalized_records) {
      const record = readJsonFile(resolve(bundleRoot, recordPath)) as NormalizedResult | null;
      if (record?.schema !== "ax.normalized-result/v1") continue;
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
        pass_hat_3: record.pass_hat_3 ?? null,
        task_consistency_at_3: record.task_consistency_at_3 ?? null,
        pass_all_3: record.pass_all_3 ?? null,
        trial_stability_at_3: (record as NormalizedResult & {
          trial_stability_at_3?: "all_pass" | "all_fail" | "inconsistent" | null;
        }).trial_stability_at_3 ?? null,
        discovery_score: record.discovery_score,
        content_quality: record.content_quality,
        blocked: record.blocked ?? null,
        latency_ms: record.latency_ms ?? null,
        first_action_latency_ms: record.first_action_latency_ms ?? null,
        tool_call_count: record.tool_call_count ?? null,
        token_usage: record.token_usage ?? null,
        token_cost: record.token_cost ?? null,
        validity_status: record.validity_status ?? null,
        normalized_record: recordPath,
        source_records: record.source_records ?? [],
      });
      evidence.push({ kind: "normalized_record", vendor: vendor.slug, surface: record.surface, harness: record.harness, path: recordPath });
    }
    for (const snapshotPath of vendor.artifacts.snapshots ?? []) {
      const parsed = readJsonFile(resolve(bundleRoot, snapshotPath));
      taskResults.push(...taskResultsFromSnapshot(snapshotPath, parsed).map((result) => ({ vendor: vendor.slug, ...result })));
      evidence.push({ kind: "snapshot", vendor: vendor.slug, path: snapshotPath });
    }
    for (const reportPath of vendor.artifacts.report_htmls ?? []) {
      evidence.push({ kind: "report_html", vendor: vendor.slug, path: reportPath });
    }
  }

  const support = loadVendorSupport(bundleRoot, manifest, suite);
  const ranking = buildLeaderboard(manifest, suite, support, cells, taskResults);
  const coreTaskIds = new Set(suite.tasks.map((task) => task.id));
  const observedTaskIds = new Set(taskResults.flatMap((result) => result.task_id ? [result.task_id] : []));
  const tasks = [
    ...suite.tasks.map((task) => ({
      task_id: task.id,
      title: task.title,
      difficulty: task.difficulty,
      skill: task.skill,
      kind: "core" as const,
      allowed_surfaces: task.allowed_surfaces,
      applicability: Object.fromEntries(manifest.vendors.map((vendor) => [
        vendor.slug,
        manifest.expected_matrix.surfaces.filter((surface) => support.get(vendor.slug)?.has(taskSurfaceKey(task.id, surface))),
      ])),
      results: taskResults.filter((result) => result.task_id === task.id),
    })),
    ...[...observedTaskIds].filter((taskId) => !coreTaskIds.has(taskId)).sort().map((taskId) => ({
      task_id: taskId,
      title: taskId,
      difficulty: null,
      skill: null,
      kind: "research" as const,
      allowed_surfaces: [],
      applicability: {},
      results: taskResults.filter((result) => result.task_id === taskId),
    })),
  ];
  const failures = taskResults.filter((result) => result.success === false && !result.na).map((result) => ({
    ...result,
    failure_type: "unclassified",
    classification_status: "needs_review",
  }));
  if (manifest.competitive_report) evidence.push({ kind: "competitive_report", path: manifest.competitive_report });

  const exportGates: PublicationQualityGate[] = [...manifest.quality_gates];
  const incomplete = ranking.rows.filter((row) => row.status === "incomplete");
  exportGates.push({
    id: "website-rankability",
    label: "Website ranking has complete trial-level evidence",
    status: ranking.intersectionPairs.length === 0 || incomplete.length ? "fail" : "pass",
    detail: ranking.intersectionPairs.length === 0
      ? "No core task×surface pair is comparable across the full vendor cohort."
      : incomplete.length
        ? `${incomplete.length} vendor(s) lack complete cells or trial outcomes: ${incomplete.map((row) => row.vendor).join(", ")}.`
        : `${ranking.intersectionPairs.length} shared task×surface pair(s) have complete trial-level evidence.`,
  });
  const effectiveReadiness = manifest.publication_readiness === "publication_ready" &&
    exportGates.every((gate) => gate.status !== "fail")
    ? "publication_ready"
    : "draft";
  const generatedAt = new Date().toISOString();
  const publicBenchmark = publicBenchmarkIdentity(manifest);
  const files: AxArenaExportFile[] = [
    { id: "publication", path: "publication.json" },
    { id: "leaderboard", path: "leaderboard.json" },
    { id: "cells", path: "cells.json" },
    { id: "tasks", path: "tasks.json" },
    { id: "trials", path: "trials.json" },
    { id: "failures", path: "failures.json" },
    { id: "evidence-index", path: "evidence-index.json" },
    { id: "methodology-index", path: "methodology-index.json" },
  ];

  writeJson(resolve(outRoot, "publication.json"), {
    schema: "ax.axarena-publication/v1",
    benchmark: publicBenchmark.id,
    display_name: publicBenchmark.displayName,
    category: manifest.category,
    suite_version: manifest.suite_version,
    generated_at: generatedAt,
    source_readiness: manifest.publication_readiness,
    publication_readiness: effectiveReadiness,
    cohort: manifest.vendors.map((vendor) => vendor.slug),
    scope: {
      core_task_count: suite.tasks.length,
      research_task_count: tasks.filter((task) => task.kind === "research").length,
      surfaces: manifest.expected_matrix.surfaces,
      harnesses: manifest.expected_matrix.harnesses,
      effort_profiles: manifest.expected_matrix.required_effort_profiles,
      trial_count: requiredTrialCount,
    },
    quality_gates: exportGates,
  });
  writeJson(resolve(outRoot, "leaderboard.json"), {
    schema: "ax.axarena-leaderboard/v2",
    benchmark: publicBenchmark.id,
    generated_at: generatedAt,
    ranking_method: {
      primary: "verified success across shared core task×surface×harness×trial outcomes",
      tie_breaker: "share of shared core task×surface×harness units passing every required trial",
      required_trial_count: requiredTrialCount,
      intersection_pairs: ranking.intersectionPairs,
      surfaces_without_intersection: ranking.surfacesWithoutIntersection,
      discovery_affects_rank: false,
    },
    rows: ranking.rows,
  });
  writeJson(resolve(outRoot, "cells.json"), { schema: "ax.axarena-cells/v2", benchmark: publicBenchmark.id, generated_at: generatedAt, cells });
  writeJson(resolve(outRoot, "tasks.json"), { schema: "ax.axarena-tasks/v2", benchmark: publicBenchmark.id, generated_at: generatedAt, tasks });
  writeJson(resolve(outRoot, "trials.json"), { schema: "ax.axarena-trials/v2", benchmark: publicBenchmark.id, generated_at: generatedAt, task_results: taskResults });
  writeJson(resolve(outRoot, "failures.json"), { schema: "ax.axarena-failures/v1", benchmark: publicBenchmark.id, generated_at: generatedAt, failures });
  writeJson(resolve(outRoot, "evidence-index.json"), { schema: "ax.axarena-evidence-index/v1", benchmark: publicBenchmark.id, generated_at: generatedAt, evidence });
  writeJson(resolve(outRoot, "methodology-index.json"), {
    schema: "ax.axarena-methodology-index/v2",
    benchmark: publicBenchmark.id,
    generated_at: generatedAt,
    methodology: {
      static_ax: manifest.layers.static_ax,
      behavioral: manifest.layers.behavioral,
      suite: manifest.suite,
      expected_matrix: manifest.expected_matrix,
      quality_gates: exportGates,
      ranking_method: "shared core task×surface intersection; discovery is reported separately",
    },
  });

  const exportManifest: AxArenaExportManifest = {
    schema: "ax.axarena-export/v2",
    benchmark: publicBenchmark.id,
    category: manifest.category,
    suite_version: manifest.suite_version,
    generated_at: generatedAt,
    source_bundle: relative(outRoot, bundleRoot),
    source_manifest: relative(outRoot, manifestPath),
    files,
  };
  writeJson(resolve(outRoot, "manifest.json"), exportManifest);
  return exportManifest;
}
