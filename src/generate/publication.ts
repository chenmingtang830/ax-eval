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

const PUBLICATION_HARNESSES = ["codex", "claude-code"] as const;
const PUBLICATION_EFFORT_PROFILES = ["low", "high"] as const;
const REQUIRED_PUBLICATION_EFFORT_PROFILES = ["low"] as const;
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
  addGate(qualityGates, {
    id: "high-profile-coverage",
    label: "Optional high-effort evidence is tracked separately",
    status: missingOptionalProfiles.length ? "warn" : "pass",
    detail: missingOptionalProfiles.length
      ? `${missingOptionalProfiles.length} cell(s) lack optional high-effort coverage; low remains the publication-critical requirement.`
      : "Optional high-effort evidence is present for every expected cell.",
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
      "publication_readiness is draft until required artifacts, low-effort matrix coverage, efficiency metrics, and competitive report gates pass.",
      "High-effort artifacts remain valuable execution-learning and publication evidence, but missing high coverage does not block a publication-ready bundle when the low-effort matrix is complete.",
      "Missing artifacts are recorded so draft bundles can be created before every live run finishes.",
      "Do not publish unredacted transcripts, credentials, connection strings, or .env files in this bundle.",
    ],
  };
  writeFileSync(resolve(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
